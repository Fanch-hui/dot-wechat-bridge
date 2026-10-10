import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import { BridgeClient } from "../src/gateway/bridge.ts";
import { prepareInbound } from "../src/gateway/inbound.ts";
import { downloadMediaFromItem, MediaDownloadError } from "../src/gateway/media.ts";
import type { WechatMessage } from "../src/gateway/ilink.ts";
import type { GatewayConfig } from "../src/gateway/config.ts";
import { fixture, sessionArgs } from "./helpers.ts";

const config: GatewayConfig = { bridgeUrl: "http://bridge.test", bridgeToken: "test-service-token",
  runtimeDir: "/tmp", tickMs: 1000, qrRefreshLimit: 1, qrTimeoutMs: 1000 };
const key = Buffer.alloc(16, 4), pdf = Buffer.from("%PDF-1.4\noriginal test bytes\n%%EOF");
function incoming(id = "file"): WechatMessage {
  return { message_id: id, from_user_id: "self-wechat", message_type: 1, create_time_ms: Date.now(), context_token: "ctx",
    item_list: [{ type: 1, text_item: { text: "请读取原文件" } }, { type: 4, file_item: { file_name: "report.pdf", len: String(pdf.length),
      media: { encrypt_query_param: "test-reference", aes_key: key.toString("base64") } } }] };
}

test("personal media decrypts, stores and returns its original bytes through the real Worker", async t => {
  const c = await fixture(t); await c.start();
  const transport: typeof fetch = async (input, init) => {
    const response = await c.mf.dispatchFetch(String(input), init as any);
    return new Response(await response.text(), { status: response.status, headers: response.headers as any });
  };
  const bridge = new BridgeClient(config, transport), cipher = createCipheriv("aes-128-ecb", key, null);
  const encrypted = Buffer.concat([cipher.update(pdf), cipher.final()]); let downloads = 0;
  const cdn: typeof fetch = async (_input, options) => {
    downloads++; assert.equal(options?.redirect, "error"); assert.equal(options?.headers, undefined);
    return new Response(new Uint8Array(encrypted));
  };
  const messages = await prepareInbound([incoming(), { ...incoming("other"), from_user_id: "other" },
    { ...incoming("group"), group_id: "group" }, { ...incoming("echo"), from_user_id: "bot", message_type: 2 }],
    "self-wechat", "bot", bridge, () => c.gateway, new AbortController().signal,
    (item, options) => downloadMediaFromItem(item, { ...options, request: cdn }));
  assert.equal(messages.length, 1); assert.equal(downloads, 1); assert.equal(messages[0].text, "请读取原文件");
  assert.equal(messages[0].kind, "media"); assert.equal(messages[0].attachments![0].item_index, 1);
  assert.equal(JSON.stringify(messages).includes("test-reference"), false);
  await c.ingest(messages, "next");
  const session = await c.session(), read = await c.ok("wechat_read_messages", sessionArgs(session));
  const file = await c.tool("wechat_read_attachment", { attachment_id: read.messages[0].attachments[0].id });
  assert.deepEqual(Buffer.from(file.content[1].resource.blob, "base64"), pdf);
  assert.equal(file.content[1].resource.text, undefined);
});

test("download failures become concrete attachment errors; failed uploads abort cursor preparation", async () => {
  const failure = new BridgeClient(config, async () => new Response("{}", { status: 503 }));
  const auth = () => ({ gateway_id: "test", lease_token: "test" }), signal = new AbortController().signal;
  const failed = await prepareInbound([incoming()], "self-wechat", "bot", failure, auth, signal,
    async () => { throw new MediaDownloadError("media_download_timeout", "微信附件下载超时"); });
  assert.equal(failed[0].attachments![0].status, "failed");
  assert.equal((failed[0].attachments![0] as any).error_message, "微信附件下载超时");
  await assert.rejects(prepareInbound([incoming()], "self-wechat", "bot", failure, auth, signal,
    async () => ({ kind: "file", name: "report.pdf", mime_type: "application/pdf", size: pdf.length, data: pdf })), /bridge_http_503/);
});
