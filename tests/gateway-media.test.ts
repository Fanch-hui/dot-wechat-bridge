import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import { downloadMediaFromItem, MediaDownloadError } from "../src/gateway/media.ts";
import type { MessageItem } from "../src/gateway/ilink.ts";

const key = Buffer.from("00112233445566778899aabbccddeeff", "hex");
const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
function encrypted(data: Buffer) {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}
function transport(data: Buffer): typeof fetch { return async () => new Response(new Uint8Array(data)); }
function file(name = "report.pdf", len?: string): MessageItem {
  return { type: 4, file_item: { file_name: name, len, media: { encrypt_query_param: "fixture", aes_key: key.toString("base64") } } };
}
function code(expected: string) {
  return (error: unknown) => error instanceof MediaDownloadError && error.code === expected;
}

test("image decrypts hex key with PKCS7, detects MIME and constructs encoded CDN URL without auth", async () => {
  let calls = 0;
  const request: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(String(url), "https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=a%2Bb%26c");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.headers, undefined);
    return new Response(encrypted(png));
  };
  const result = await downloadMediaFromItem({ type: 2, image_item: { aeskey: key.toString("hex"),
    mid_size: encrypted(png).length, media: { encrypt_query_param: "a+b&c", aes_key: "invalid-fallback" } } }, { request, maxBytes: png.length });
  assert.deepEqual(result, { kind: "image", name: "image.png", mime_type: "image/png", size: png.length, data: png });
  assert.equal(calls, 1);
});

test("images support raw base64 and base64 hex keys and unencrypted CDN images", async () => {
  for (const aes_key of [key.toString("base64"), Buffer.from(key.toString("hex")).toString("base64")]) {
    const result = await downloadMediaFromItem({ type: 2, image_item: { media: { full_url: "https://other.cdn.weixin.qq.com/image", aes_key } } }, { request: transport(encrypted(png)) });
    assert.deepEqual(result?.data, png);
  }
  const result = await downloadMediaFromItem({ type: 2, image_item: { media: { encrypt_query_param: "plain" } } }, { request: transport(png) });
  assert.equal(result?.mime_type, "image/png");
});

test("file decrypts real bytes, preserves size and removes path and control characters from filename", async () => {
  const data = Buffer.from("%PDF-1.7\nfixture");
  const item = file("../../folder\\report\u0000.pdf", String(data.length));
  item.file_item!.media!.aes_key = Buffer.from(key.toString("hex")).toString("base64");
  const result = await downloadMediaFromItem(item, { request: transport(encrypted(data)) });
  assert.deepEqual(result, { kind: "file", name: "report.pdf", mime_type: "application/pdf", size: data.length, data });
  await assert.rejects(downloadMediaFromItem(file("x.pdf", "99"), { request: transport(encrypted(data)) }), code("media_size_mismatch"));
});

test("foreign hosts, insecure addresses, userinfo, ports and URL fragments are rejected before fetching", async () => {
  let calls = 0;
  const request: typeof fetch = async () => { calls++; throw new Error("must not fetch"); };
  for (const full_url of ["https://evil.test/x", "https://cdn.weixin.qq.com.evil.test/x", "https://ilinkai.weixin.qq.com/x",
    "http://novac2c.cdn.weixin.qq.com/x", "https://user:password@novac2c.cdn.weixin.qq.com/x",
    "https://novac2c.cdn.weixin.qq.com:444/x", "https://novac2c.cdn.weixin.qq.com:443/x", "https://novac2c.cdn.weixin.qq.com/x#secret"]) {
    const item = file(); item.file_item!.media!.full_url = full_url;
    await assert.rejects(downloadMediaFromItem(item, { request }), code("media_url_untrusted"));
  }
  assert.equal(calls, 0);
});

test("unsupported items perform no network requests; missing and malformed keys report safe errors", async () => {
  const request: typeof fetch = async () => { throw new Error("must not fetch"); };
  assert.equal(await downloadMediaFromItem({ type: 1, text_item: { text: "hello" } }, { request }), null);
  const item = file(); delete item.file_item!.media!.aes_key;
  await assert.rejects(downloadMediaFromItem(item, { request }), code("media_key_missing"));
  item.file_item!.media!.aes_key = "private-key-invalid";
  await assert.rejects(downloadMediaFromItem(item, { request }), error => {
    assert.equal((error as MediaDownloadError).code, "media_key_invalid");
    assert.doesNotMatch(String(error), /private-key-invalid|fixture/); return true;
  });
});

test("known oversize rejects before fetching; streaming and plaintext limits include encrypted padding correctly", async () => {
  let calls = 0;
  const request: typeof fetch = async () => { calls++; return new Response(encrypted(Buffer.alloc(20))); };
  await assert.rejects(downloadMediaFromItem(file("big.bin", "21"), { request, maxBytes: 20 }), code("media_too_large"));
  assert.equal(calls, 0);
  const result = await downloadMediaFromItem(file("ok.bin", "20"), { request, maxBytes: 20 });
  assert.equal(result?.size, 20);
  await assert.rejects(downloadMediaFromItem(file(), { request: transport(encrypted(Buffer.alloc(21))), maxBytes: 20 }), code("media_too_large"));
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(Buffer.alloc(40)); }, cancel() { cancelled = true; } });
  await assert.rejects(downloadMediaFromItem(file(), { maxBytes: 20, request: async () => new Response(stream) }), code("media_too_large"));
  assert.equal(cancelled, true);
  await assert.rejects(downloadMediaFromItem(file(), { maxBytes: 20, request: async () => new Response("", { headers: { "content-length": "40" } }) }), code("media_too_large"));
});

test("HTTP and transport failures never expose download secrets; corrupt ciphertext is a decryption failure", async () => {
  await assert.rejects(downloadMediaFromItem(file(), { request: async () => new Response("private upstream body", { status: 403 }) }), error => {
    assert.equal((error as MediaDownloadError).detail, "微信附件下载失败（HTTP 403）");
    assert.doesNotMatch(String(error), /private upstream body|fixture/); return true;
  });
  await assert.rejects(downloadMediaFromItem(file(), { request: async () => { throw new Error("https://secret.test/?key=private"); } }), error => {
    assert.equal((error as MediaDownloadError).code, "media_download_failed");
    assert.doesNotMatch(String(error), /secret|private/); return true;
  });
  await assert.rejects(downloadMediaFromItem(file(), { request: transport(Buffer.from("corrupt")) }), code("media_decrypt_failed"));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(downloadMediaFromItem(file(), { signal: controller.signal, request: async () => { throw controller.signal.reason; } }), code("media_download_aborted"));
});
