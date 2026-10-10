import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:https";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliverWebhook, publicAddress } from "../src/gateway/callback.ts";
import type { WebhookJob } from "../src/shared/contracts.ts";

test("callback public address policy blocks special networks and mixed DNS", async () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "192.168.1.1", "169.254.169.254", "100.64.0.1", "198.18.0.1", "203.0.113.1", "::1", "::ffff:7f00:1", "fc00::1", "fe80::1", "2001:db8::1", "2002:7f00:1::"]) assert.equal(publicAddress(address), false, address);
  for (const address of ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111"]) assert.equal(publicAddress(address), true, address);
  const job: WebhookJob = { id: "id", claim_token: "claim", kind: "webhook", payload: { url: "https://callback.test/hook", body: "{}", headers: {} } };
  const mixed = await deliverWebhook(job, { resolve: async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }] });
  assert.equal(mixed.error_code, "callback_address_blocked");
  assert.equal((await deliverWebhook({ ...job, payload: { ...job.payload, url: "http://callback.test" } })).outcome, "failed");
  const timeout = await deliverWebhook(job, { resolve: async () => new Promise(() => {}), timeoutMs: 30 });
  assert.equal(timeout.outcome, "retryable");
});

test("callback performs pinned HTTPS with TLS host verification, signed headers and bounded responses", async t => {
  const directory = await mkdtemp(join(tmpdir(), "dot-wechat-tls-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = join(directory, "key.pem"), cert = join(directory, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
    "-days", "1", "-subj", "/CN=callback.test", "-addext", "subjectAltName=DNS:callback.test"], { stdio: "ignore" });
  const ca = await readFile(cert);
  let status = 200, payload = JSON.stringify({ challenge: "expected-challenge" }), received = 0;
  const server = createServer({ key: await readFile(key), cert: ca }, async (request, response) => {
    received++;
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    assert.equal(request.headers.host, `callback.test:${(server.address() as { port: number }).port}`);
    assert.equal(request.headers["webhook-signature"], "v1,test-signature");
    assert.equal(request.headers["x-mcp-subscription-id"], "subscription-original-id");
    assert.equal(Buffer.concat(chunks).toString(), '{"event":"wake"}');
    response.statusCode = status;
    if (status === 302) response.setHeader("location", "https://127.0.0.1/private");
    response.end(payload);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const job: WebhookJob = { id: "event", claim_token: "claim", kind: "webhook", payload: {
    url: `https://callback.test:${port}/hook`, body: '{"event":"wake"}',
    headers: { "webhook-signature": "v1,test-signature", "webhook-id": "stable-id", "x-mcp-subscription-id": "subscription-original-id", Host: "attacker.test" },
  } };
  const options = { ca, resolve: async () => [{ address: "127.0.0.1", family: 4 }], addressAllowed: () => true };
  const verified = await deliverWebhook(job, options);
  assert.equal(verified.outcome, "delivered"); assert.equal(verified.challenge, "expected-challenge");
  for (const code of [410, 413, 302, 503, 429]) {
    status = code;
    const result = await deliverWebhook(job, options);
    assert.equal(result.outcome, code === 503 || code === 429 ? "retryable" : "failed");
    assert.equal(result.http_status, code);
  }
  assert.equal(received, 6);
  status = 200; payload = "x".repeat(20000);
  assert.equal((await deliverWebhook(job, options)).error_code, "callback_response_too_large");
  const mismatch = await deliverWebhook({ ...job, payload: { ...job.payload, url: `https://wrong.test:${port}/hook` } }, options);
  assert.equal(mismatch.outcome, "retryable"); assert.equal(received, 7);
});
