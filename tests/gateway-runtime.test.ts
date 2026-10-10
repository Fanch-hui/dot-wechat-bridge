import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewayRuntime } from "../src/gateway/runtime.ts";
import { IlinkClient } from "../src/gateway/ilink.ts";
import { Journal, atomicPrivateJson, type Credentials } from "../src/gateway/storage.ts";
import type { GatewayConfig } from "../src/gateway/config.ts";

const credentials: Credentials = { botToken: "test", botId: "bot", userId: "owner", baseUrl: "https://ilinkai.weixin.qq.com" };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check: () => boolean, timeout = 4000): Promise<void> {
  const start = Date.now(); while (!check()) { if (Date.now() - start > timeout) throw new Error("Test deadline exceeded"); await sleep(10); }
}
async function fixture(t: import("node:test").TestContext, handler: (route: string, data: any) => unknown | Promise<unknown>) {
  const directory = await mkdtemp(join(tmpdir(), "dot-wechat-gateway-test-"));
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const data = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    assert.equal(request.headers.authorization, "Bearer bridge-test");
    assert.equal(request.headers["oai-sites-authorization"], "Bearer sites-test");
    try {
      const result = await handler(request.url!.split("/").at(-1)!, data);
      response.setHeader("content-type", "application/json"); response.end(JSON.stringify(result));
    } catch { response.statusCode = 503; response.end("{}"); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); server.close(); await rm(directory, { recursive: true, force: true }); });
  const port = (server.address() as { port: number }).port;
  const config: GatewayConfig = { bridgeUrl: `http://127.0.0.1:${port}`, bridgeToken: "bridge-test", sitesAccessToken: "sites-test",
    runtimeDir: directory, tickMs: 50, qrRefreshLimit: 1, qrTimeoutMs: 1000 };
  return { directory, config };
}

test("gateway durable pending ingestion retries unchanged cursor, while ticks and replies run during long poll", async t => {
  let ingestAttempts = 0, accepted = false, tickCount = 0, completed = false, jobClaimed = false;
  const received: any[] = [];
  let durableFile = "";
  const { directory, config } = await fixture(t, async (route, data) => {
    if (route === "lease") return { gateway_id: data.gateway_id, lease_token: "lease", cursor: "old", lease_until: Date.now() + 30000 };
    if (route === "tick") { tickCount++; return { lease_until: Date.now() + 30000 }; }
    if (route === "ingest") {
      received.push(data); ingestAttempts++;
      assert.equal(JSON.parse(await readFile(durableFile, "utf8")).pending.cursor, "new");
      if (ingestAttempts === 1) throw new Error("Site temporarily unavailable");
      accepted = true; return { accepted: true };
    }
    if (route === "jobs") {
      if (!accepted || jobClaimed) return { jobs: [] };
      jobClaimed = true; return { jobs: [{ id: "reply", claim_token: "claim", kind: "reply", payload: { client_id: "stable", to_user_id: "owner", text: "reply", context_token: "ctx" } }] };
    }
    if (route === "complete") {
      assert.equal(data.outcome, "delivered");
      assert.equal(JSON.parse(await readFile(durableFile, "utf8")).jobs.reply.result.outcome, "delivered");
      completed = true; return { accepted: true };
    }
    return { accepted: true };
  });
  const ilinkServer = createServer(async (request, response) => {
    if (request.url === "/ilink/bot/sendmessage") { response.end('{"ret":0}'); return; }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const cursor = JSON.parse(Buffer.concat(chunks).toString()).get_updates_buf;
    if (cursor === "old") response.end(JSON.stringify({ ret: 0, get_updates_buf: "new", msgs: [{ message_id: "1", from_user_id: "owner", message_type: 1, context_token: "ctx", item_list: [{ type: 1, text_item: { text: "hello" } }] }] }));
    // Hold the next poll; outbound work and heartbeats must remain live.
  });
  ilinkServer.listen(0, "127.0.0.1"); await once(ilinkServer, "listening");
  t.after(() => { ilinkServer.closeAllConnections(); ilinkServer.close(); });
  const ilinkPort = (ilinkServer.address() as { port: number }).port;
  const transport: typeof fetch = (input, init) => fetch(`http://127.0.0.1:${ilinkPort}${new URL(String(input)).pathname}`, init);
  durableFile = join(directory, "journal.json"); const journal = await Journal.load(durableFile);
  const controller = new AbortController();
  const running = new GatewayRuntime(config, credentials, journal, { ilink: new IlinkClient(credentials, undefined, transport), report: () => {} }).run(controller.signal);
  await waitFor(() => completed && tickCount >= 4); controller.abort(); await running;
  assert.equal(ingestAttempts, 2); assert.equal(received[0].previous_cursor, "old"); assert.deepEqual(received[0], received[1]);
  assert.equal(journal.data.pending, undefined); assert.deepEqual(journal.data.jobs, {});
  assert.equal((await stat(durableFile)).mode & 0o777, 0o600);
});

test("restart reconciles unknown inflight and durable results without retransmitting; credential expiry leaves events active", async t => {
  const outcomes: Record<string, string> = {}; let expired = false, eventDone = false, healthSeen = false, claimed = false;
  const { directory, config } = await fixture(t, (route, data) => {
    if (route === "lease") return { gateway_id: data.gateway_id, lease_token: "new-lease", cursor: "old", lease_until: Date.now() + 30000 };
    if (route === "tick") return { lease_until: Date.now() + 30000 };
    if (route === "health") { healthSeen = data.status === "credential_expired"; return { accepted: true }; }
    if (route === "complete") { outcomes[data.job_id] = data.outcome; if (data.job_id === "event") eventDone = true; return { accepted: true }; }
    if (route === "jobs") {
      if (!expired || claimed) return { jobs: [] };
      claimed = true; return { jobs: [{ id: "event", claim_token: "event-claim", kind: "webhook", payload: { url: "https://callback.test", body: "{}", headers: {} } }] };
    }
    return { accepted: true };
  });
  const path = join(directory, "journal.json");
  await atomicPrivateJson(path, { gatewayId: "stable-gateway", jobs: {
    lost: { kind: "reply", claimToken: "old-claim" },
    delivered: { kind: "reply", claimToken: "known-claim", result: { job_id: "delivered", claim_token: "known-claim", outcome: "delivered" } },
  } });
  let sends = 0;
  const ilinkServer = createServer((_request, response) => { expired = true; sends++; response.end('{"ret":-14}'); });
  ilinkServer.listen(0, "127.0.0.1"); await once(ilinkServer, "listening");
  t.after(() => { ilinkServer.closeAllConnections(); ilinkServer.close(); });
  const port = (ilinkServer.address() as { port: number }).port;
  const transport: typeof fetch = (_input, init) => fetch(`http://127.0.0.1:${port}/`, init);
  const journal = await Journal.load(path), controller = new AbortController();
  const running = new GatewayRuntime(config, credentials, journal, {
    ilink: new IlinkClient(credentials, undefined, transport), report: () => {},
    webhook: async job => ({ job_id: job.id, claim_token: job.claim_token, outcome: "delivered" }),
  }).run(controller.signal);
  await waitFor(() => eventDone && healthSeen && Object.keys(journal.data.jobs).length === 0);
  controller.abort(); await running;
  assert.equal(outcomes.lost, "unknown"); assert.equal(outcomes.delivered, "delivered");
  assert.equal(outcomes.event, "delivered"); assert.equal(sends, 1); assert.deepEqual(journal.data.jobs, {});
});
