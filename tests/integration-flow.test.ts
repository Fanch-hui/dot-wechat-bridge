import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Webhook } from 'standardwebhooks';
import { fixture, eventually, sessionArgs, sleep } from './helpers.ts';
import { GatewayRuntime } from '../src/gateway/runtime.ts';
import { IlinkClient, ILINK_BASE, type Updates, type WechatMessage } from '../src/gateway/ilink.ts';
import { deliverWebhook } from '../src/gateway/callback.ts';
import { Journal, type Credentials } from '../src/gateway/storage.ts';
import type { GatewayConfig } from '../src/gateway/config.ts';

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}
async function listen(t: TestContext, server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  return (server.address() as { port: number }).port;
}
function incoming(id: string, text: string): WechatMessage {
  return { message_id: id, from_user_id: 'self-wechat', to_user_id: 'synthetic-bot',
    create_time_ms: Date.now(), context_token: `synthetic-context-${id}`, message_type: 1,
    item_list: [{ type: 1, text_item: { text } }] };
}

// Tencent and Dot are synthetic peers; workerd, D1, Node, HTTP and signed TLS delivery are real.
test('one simulated Dot wake handles two WeChat rounds across Worker, gateway and signed TLS callback', async t => {
  const controller = new AbortController();
  let running: Promise<void> | undefined;
  t.after(async () => { controller.abort(); await running; });
  const c = await fixture(t);
  const directory = await mkdtemp(join(tmpdir(), 'dot-wechat-flow-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const failures: unknown[] = [];
  const proxy = createServer(async (request, response) => {
    try {
      const headers = Object.fromEntries(Object.entries(request.headers)
        .filter(([key, value]) => key !== 'host' && typeof value === 'string')) as Record<string, string>;
      const result = await c.mf.dispatchFetch(`http://bridge.test${request.url}`, {
        method: request.method, headers, body: await body(request),
      });
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(await result.text());
    } catch (error) { failures.push(error); response.writeHead(500); response.end('{}'); }
  });
  const bridgeUrl = `http://127.0.0.1:${await listen(t, proxy)}`;
  const protocol = '2026-07-28';
  async function rpc(method: string, params: Record<string, unknown> = {}) {
    const result = await fetch(`${bridgeUrl}/mcp`, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'oai-authenticated-user-id': 'owner',
      'MCP-Protocol-Version': protocol, 'Mcp-Method': method,
      ...(typeof params.name === 'string' ? { 'Mcp-Name': params.name } : {}),
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: {
      'io.modelcontextprotocol/protocolVersion': protocol,
      'io.modelcontextprotocol/clientCapabilities': { events: {} },
    } } }) });
    const value = await result.json() as any;
    assert.equal(result.status, 200, JSON.stringify(value));
    assert.equal(value.error, undefined, JSON.stringify(value));
    return value.result;
  }
  async function tool(name: string, args: Record<string, unknown> = {}) {
    const result = await rpc('tools/call', { name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return result.structuredContent as any;
  }
  await tool('wechat_bridge_status');
  assert.equal((await c.service('bind', { sender: 'self-wechat' })).status, 200);

  const queued: Updates[] = [], sent: any[] = [];
  let waiting: import('node:http').ServerResponse | undefined;
  function push(messages: WechatMessage[], cursor: string) {
    const update = { ret: 0, msgs: messages, get_updates_buf: cursor };
    if (waiting) { waiting.end(JSON.stringify(update)); waiting = undefined; }
    else queued.push(update);
  }
  const tencent = createServer(async (request, response) => {
    try {
      const data = JSON.parse(await body(request));
      assert.equal(request.headers.authorization, 'Bearer synthetic-token');
      assert.equal(request.headers.authorizationtype, 'ilink_bot_token');
      if (request.url === '/ilink/bot/sendmessage') {
        sent.push(data.msg);
        response.end('{"ret":0}');
      } else {
        assert.equal(request.url, '/ilink/bot/getupdates');
        assert.equal(typeof data.get_updates_buf, 'string');
        const update = queued.shift();
        if (update) response.end(JSON.stringify(update));
        else { waiting = response; response.once('close', () => { if (waiting === response) waiting = undefined; }); }
      }
    } catch (error) { failures.push(error); response.writeHead(500); response.end('{}'); }
  });
  const tencentUrl = `http://127.0.0.1:${await listen(t, tencent)}`;
  const key = join(directory, 'key.pem'), cert = join(directory, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=callback.test', '-addext', 'subjectAltName=DNS:callback.test'], { stdio: 'ignore' });
  const ca = await readFile(cert);
  const secret = 'whsec_' + Buffer.alloc(32, 9).toString('base64');
  const callbacks: any[] = [];
  const receiver = createTlsServer({ key: await readFile(key), cert: ca }, async (request, response) => {
    try {
      const raw = await body(request);
      const event = new Webhook(secret).verify(raw, request.headers as Record<string, string>) as any;
      assert.equal(request.url, '/events');
      assert.ok(request.headers['x-mcp-subscription-id']);
      assert.ok(!raw.includes('synthetic-context'));
      callbacks.push(event);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(event.type === 'verification' ? { challenge: event.challenge } : {}));
    } catch (error) { failures.push(error); response.writeHead(400); response.end('{}'); }
  });
  const callbackUrl = `https://callback.test:${await listen(t, receiver)}/events`;
  const credentials: Credentials = { botToken: 'synthetic-token', botId: 'synthetic-bot',
    userId: 'self-wechat', baseUrl: ILINK_BASE };
  const config: GatewayConfig = { bridgeUrl, bridgeToken: 'test-service-token', runtimeDir: directory,
    tickMs: 25, qrRefreshLimit: 1, qrTimeoutMs: 1000 };
  const journal = await Journal.load(join(directory, 'journal.json'));
  const transport: typeof fetch = (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, ILINK_BASE);
    return fetch(`${tencentUrl}${url.pathname}`, init);
  };
  const reports: string[] = [];
  running = new GatewayRuntime(config, credentials, journal, {
    ilink: new IlinkClient(credentials, undefined, transport), report: message => reports.push(message),
    webhook: job => deliverWebhook(job, { ca, timeoutMs: 2000,
      resolve: async host => { assert.equal(host, 'callback.test'); return [{ address: '127.0.0.1', family: 4 }]; },
      // Loopback is permitted only for this local receiver; production address policy has separate coverage.
      addressAllowed: address => address === '127.0.0.1',
    }),
  }).run(controller.signal);
  const subscribed = await rpc('events/subscribe', { name: 'wechat.message.available',
    arguments: { conversation: 'personal' }, delivery: { mode: 'webhook', url: callbackUrl, secret }, ttlMs: 60_000 });
  assert.ok(subscribed.id);
  assert.equal(callbacks.length, 1);
  assert.equal(callbacks[0].type, 'verification');
  assert.equal((await c.rows('SELECT state FROM subscriptions'))[0].state, 'active');

  const first = incoming('18446744073709551615', 'round one');
  push([first, first], 'cursor-one');
  const wake = await eventually(async () => callbacks.filter(event => event.type !== 'verification'), events => events.length === 1);
  assert.equal(wake[0].name, 'wechat.message.available');
  assert.equal(wake[0].data.pending_count, 1);
  const session = await tool('wechat_confirm_session', { session_id: wake[0].data.session_id, consumer_id: 'simulated-dot' });
  const auth = sessionArgs(session);
  const roundOne = await tool('wechat_read_messages', auth);
  assert.equal(roundOne.messages.length, 1);
  assert.equal(roundOne.messages[0].upstream_id, first.message_id);
  const acknowledgment = await tool('wechat_send_reply', { ...auth, message_ids: [roundOne.messages[0].sequence],
    text: '我查一下', idempotency_key: 'round-one-acknowledgment', wait_ms: 0 });
  await eventually(() => c.rows('SELECT state FROM jobs WHERE id=?', [acknowledgment.reply_id]), rows => rows[0]?.state === 'delivered');
  assert.equal((await tool('wechat_read_messages', auth)).messages.length, 0);
  assert.equal((await tool('wechat_bridge_status')).session.state, 'active');
  await tool('wechat_heartbeat', auth);
  const replyOne = { ...auth, message_ids: [roundOne.messages[0].sequence], text: 'reply one',
    idempotency_key: 'round-one', wait_ms: 0 };
  const queuedReply = await tool('wechat_send_reply', replyOne);
  assert.equal((await tool('wechat_send_reply', replyOne)).reply_id, queuedReply.reply_id);
  await eventually(() => c.rows("SELECT state FROM jobs WHERE id=?", [queuedReply.reply_id]), rows => rows[0]?.state === 'delivered');

  const second = incoming('18446744073709551614', 'round two');
  push([first, second, second], 'cursor-two');
  const roundTwo = await eventually(() => tool('wechat_read_messages', auth), result => result.messages.length === 1);
  assert.equal(roundTwo.messages[0].text, 'round two');
  assert.ok(roundTwo.messages[0].sequence > roundOne.messages[0].sequence);
  await tool('wechat_heartbeat', auth);
  const replyTwo = { ...auth, message_ids: [roundTwo.messages[0].sequence], text: 'reply two',
    idempotency_key: 'round-two', wait_ms: 0 };
  const secondReply = await tool('wechat_send_reply', replyTwo);
  await eventually(() => c.rows('SELECT state FROM jobs WHERE id=?', [secondReply.reply_id]), rows => rows[0]?.state === 'delivered');
  assert.equal((await tool('wechat_send_reply', replyTwo)).reply_id, secondReply.reply_id);
  await sleep(100);
  assert.equal(callbacks.filter(event => event.type !== 'verification').length, 1);
  assert.equal((await c.rows('SELECT * FROM messages')).length, 2);
  assert.equal((await c.rows("SELECT * FROM jobs WHERE kind='reply'")).length, 3);
  assert.deepEqual(sent.map(message => message.item_list[0].text_item.text), ['我查一下', 'reply one', 'reply two']);
  assert.deepEqual(sent.map(message => message.client_id), [acknowledgment.reply_id, queuedReply.reply_id, secondReply.reply_id]);
  assert.ok(sent.every(message => message.to_user_id === 'self-wechat'));
  assert.equal(sent[0].context_token, first.context_token);
  assert.equal(sent[1].context_token, first.context_token);
  assert.equal(sent[2].context_token, second.context_token);
  assert.equal((await tool('wechat_read_messages', auth)).messages.length, 0);
  assert.equal((await tool('wechat_end_session', auth)).ended, true);
  controller.abort(); await running;
  assert.deepEqual(journal.data.jobs, {});
  assert.equal(journal.data.pending, undefined);
  assert.deepEqual(failures, []);
  assert.deepEqual(reports, []);
});
