import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import type { AttachmentUpload, GatewayAuth, GatewayJob, IncomingMessage, JobResult } from '../src/shared/contracts.ts';

const version = '2026-07-28';
let bundle: Promise<string> | undefined;
function workerBundle() {
  return bundle ??= build({ entryPoints: ['src/worker.ts'], bundle: true, write: false, format: 'esm', platform: 'browser',
    target: 'es2022' }).then(result => result.outputFiles[0].text);
}
export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export async function eventually<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeout = 3000): Promise<T> {
  const until = Date.now() + timeout;
  while (true) {
    const result = await read();
    if (accept(result)) return result;
    if (Date.now() > until) throw new Error('Test deadline exceeded');
    await sleep(20);
  }
}
export class Client {
  gateway = { gateway_id: 'test-gateway', lease_token: '' };
  constructor(public mf: Miniflare) {}
  async post(path: string, body: unknown, headers: Record<string, string> = {}) {
    const response = await this.mf.dispatchFetch(`http://bridge.test${path}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const raw = await response.text();
    return { status: response.status, body: raw ? JSON.parse(raw) as any : null };
  }
  async rpc(method: string, params: Record<string, any> = {}, identity: string | null = 'owner', modern = true,
    extraHeaders: Record<string, string> = {}) {
    const metadata = { 'io.modelcontextprotocol/protocolVersion': version, 'io.modelcontextprotocol/clientCapabilities': { events: {} } };
    return this.post('/mcp', { jsonrpc: '2.0', id: 1, method, params: { ...params, ...(modern ? { _meta: metadata } : {}) } },
      { ...(identity ? { 'oai-authenticated-user-id': identity } : {}),
        ...(modern ? { 'MCP-Protocol-Version': version, 'Mcp-Method': method, ...(params.name ? { 'Mcp-Name': params.name } : {}) } : {}),
        ...extraHeaders });
  }
  async tool(name: string, args: Record<string, unknown> = {}) {
    const result = await this.rpc('tools/call', { name, arguments: args });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body.result;
  }
  async ok(name: string, args: Record<string, unknown> = {}) {
    const result = await this.tool(name, args);
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return result.structuredContent as any;
  }
  async service(route: string, body: Record<string, unknown> = {}, authenticated = true) {
    return this.post(`/gateway/${route}`, { ...this.gateway, ...body }, authenticated ? { Authorization: 'Bearer test-service-token' } : {});
  }
  async start() {
    await this.ok('wechat_bridge_status');
    const bind = await this.service('bind', { sender: 'self-wechat' });
    assert.equal(bind.status, 200);
    const lease = await this.service('lease'); assert.equal(lease.status, 200);
    this.gateway.lease_token = lease.body.lease_token;
  }
  async ingest(messages: IncomingMessage[], cursor: string, previous = '') {
    return this.service('ingest', { messages, cursor, previous_cursor: previous });
  }
  async attachment(metadata: AttachmentUpload, data: Uint8Array, auth: GatewayAuth = this.gateway) {
    const response = await this.mf.dispatchFetch('http://bridge.test/gateway/attachment', { method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', Authorization: 'Bearer test-service-token',
        'X-Bridge-Gateway-Id': auth.gateway_id, 'X-Bridge-Lease': auth.lease_token,
        'X-Bridge-Attachment': Buffer.from(JSON.stringify(metadata)).toString('base64') }, body: data });
    return { status: response.status, body: await response.json() as any };
  }
  async session(consumer = 'simulated-dot') {
    const status = await this.ok('wechat_bridge_status');
    return this.ok('wechat_confirm_session', { session_id: status.session.session_id, consumer_id: consumer });
  }
  async jobs() {
    const result = await this.service('jobs'); assert.equal(result.status, 200);
    return result.body.jobs as GatewayJob[];
  }
  async complete(job: GatewayJob, result: Partial<JobResult> = {}) {
    const response = await this.service('complete', { job_id: job.id, claim_token: job.claim_token, outcome: 'delivered', ...result });
    assert.equal(response.status, 200, JSON.stringify(response.body));
  }
  async db() { return this.mf.getD1Database('DB'); }
  async run(sql: string, values: unknown[] = []) { return (await this.db()).prepare(sql).bind(...values).run(); }
  async rows(sql: string, values: unknown[] = []) { return (await this.db()).prepare(sql).bind(...values).all<any>().then(r => r.results); }
}
export function message(id: string, text = `message ${id}`, patch: Partial<IncomingMessage> = {}): IncomingMessage {
  return { upstream_id: id, sender: 'self-wechat', occurred_at: Date.now(), text, kind: 'text', context_token: `context ${id}`,
    message_type: 1, ...patch };
}
export function sessionArgs(session: any) { return { session_id: session.session_id, lease_token: session.lease_token }; }
export async function fixture(t: TestContext, bindings: Record<string, string> = {}, persistent = false, migrationThrough='9999') {
  const directory = persistent ? await mkdtemp(join(tmpdir(), 'dot-wechat-d1-test-')) : undefined;
  const options = { ...(directory ? { d1Persist: directory } : {}), workers: [{ name: 'bridge', modules: true, script: await workerBundle(), compatibilityDate: '2026-07-28',
    d1Databases: { DB: 'test-database' }, r2Buckets: { MEDIA: 'test-media' },
    bindings: { BRIDGE_TOKEN: 'test-service-token', DATA_KEY_B64: Buffer.alloc(32, 7).toString('base64'),
      READ_WAIT_MS: '0', VERIFY_WAIT_MS: '2000', ...bindings } }] };
  const client = new Client(new Miniflare(options));
  t.after(async () => { await client.mf.dispose(); if (directory) await rm(directory, { recursive: true, force: true }); });
  for (const file of (await readdir('drizzle')).filter(file => file.endsWith('.sql') && file.slice(0,4)<=migrationThrough).sort()) {
    for (const statement of (await readFile(join('drizzle', file), 'utf8')).split('--> statement-breakpoint')) {
      if (statement.trim()) await client.run(statement);
    }
  }
  return Object.assign(client, { restart: async () => { await client.mf.dispose(); client.mf = new Miniflare(options); } });
}
