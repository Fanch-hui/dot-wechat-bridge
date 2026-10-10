import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:https";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadPublicMedia } from "../src/gateway/media-source.ts";
import { OutboundMediaError } from "../src/gateway/outbound-media.ts";

test("media URLs and mixed public/private DNS are rejected before a connection", async () => {
  const signal = new AbortController().signal;
  for (const input of ["http://example.test/file", "https://user:pass@example.test/file", "https://example.test/file#fragment"]) {
    await assert.rejects(downloadPublicMedia(input, signal), error => error instanceof OutboundMediaError && error.outcome === "failed");
  }
  await assert.rejects(downloadPublicMedia("https://example.test/file", signal, {
    resolve: async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }],
  }), error => error instanceof OutboundMediaError && error.code === "media_source_address_blocked");
  await assert.rejects(downloadPublicMedia("https://example.test/file", signal, { resolve: async () => new Promise(() => {}), timeoutMs: 20 }),
    error => error instanceof OutboundMediaError && error.outcome === "retryable");
});

test("pinned HTTPS media reads exact bytes, verifies TLS hostname, bounds streaming and never follows redirects", async t => {
  const directory = await mkdtemp(join(tmpdir(), "dot-wechat-source-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = join(directory, "key.pem"), cert = join(directory, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
    "-days", "1", "-subj", "/CN=media.test", "-addext", "subjectAltName=DNS:media.test"], { stdio: "ignore" });
  const ca = await readFile(cert);
  let mode = "normal", requests = 0, lookups = 0;
  const server = createServer({ key: await readFile(key), cert: ca }, (request, response) => {
    requests++;
    assert.equal(request.headers.host, `media.test:${(server.address() as { port: number }).port}`);
    assert.equal(request.headers.authorization, undefined);
    if (mode === "redirect") { response.writeHead(302, { location: "https://127.0.0.1/private" }); response.end(); }
    else if (mode === "large") { response.write("x".repeat(60)); response.end("y".repeat(60)); }
    else if (mode === "slow") { response.write("first"); }
    else response.end(Buffer.from([0, 1, 2, 255, 4]));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as { port: number }).port;
  const options = { ca, maxBytes: 100, addressAllowed: () => true,
    resolve: async () => { lookups++; return [{ address: "127.0.0.1", family: 4 }]; } };
  const signal = new AbortController().signal;
  assert.deepEqual(await downloadPublicMedia(`https://media.test:${port}/file`, signal, options), Buffer.from([0, 1, 2, 255, 4]));
  assert.equal(lookups, 1);
  mode = "redirect";
  await assert.rejects(downloadPublicMedia(`https://media.test:${port}/file`, signal, options),
    error => error instanceof OutboundMediaError && error.code === "media_source_http_302");
  assert.equal(requests, 2);
  mode = "large";
  await assert.rejects(downloadPublicMedia(`https://media.test:${port}/file`, signal, options),
    error => error instanceof OutboundMediaError && error.code === "media_too_large");
  const before = requests;
  await assert.rejects(downloadPublicMedia(`https://wrong.test:${port}/file`, signal, options),
    error => error instanceof OutboundMediaError && error.outcome === "retryable");
  assert.equal(requests, before);
  mode = "slow";
  const cancelled = new AbortController();
  const waiting = downloadPublicMedia(`https://media.test:${port}/file`, cancelled.signal, options);
  setTimeout(() => cancelled.abort(), 30);
  await assert.rejects(waiting, error => error instanceof OutboundMediaError && error.outcome === "retryable");
});
