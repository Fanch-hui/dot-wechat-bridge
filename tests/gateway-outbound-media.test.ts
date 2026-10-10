import { test } from "node:test";
import assert from "node:assert/strict";
import { createDecipheriv, createHash } from "node:crypto";
import { IlinkClient, IlinkError } from "../src/gateway/ilink.ts";
import { trustedUploadUrl } from "../src/gateway/outbound-media.ts";

const credentials = { baseUrl: "https://ilinkai.weixin.qq.com", userId: "owner", botId: "bot", botToken: "test-token" };
const payload = (kind: "image" | "file") => ({ client_id: "stable-id", to_user_id: "owner", text: "",
  context_token: "test-context", media: { kind, name: "测试 文档.pdf", source: { type: "url" as const, url: "https://example.test/media" } } });
const json = (body: unknown) => new Response(JSON.stringify(body));

test("image and file outbound use actual AES ciphertext, raw checksum and Tencent key encoding", async () => {
  for (const kind of ["image", "file"] as const) {
    for (const size of [0, 1, 15, 16, 31, 32]) {
      const bytes = Buffer.alloc(size, 42), sequence: string[] = [];
      let upload: any, item: any;
      const request: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("getuploadurl")) {
          sequence.push("prepare"); upload = JSON.parse(String(init!.body));
          assert.equal(new Headers(init!.headers).get("authorization"), "Bearer test-token");
          assert.equal(upload.media_type, kind === "image" ? 1 : 3);
          assert.equal(upload.rawsize, size); assert.equal(upload.rawfilemd5, createHash("md5").update(bytes).digest("hex"));
          assert.equal(upload.filesize, Math.ceil((size + 1) / 16) * 16);
          assert.equal(upload.no_need_thumb, true);
          return json({ upload_param: "upload+parameter/value=" });
        }
        if (url.pathname.endsWith("upload")) {
          sequence.push("cdn");
          assert.equal(url.hostname, "novac2c.cdn.weixin.qq.com");
          assert.equal(url.searchParams.get("filekey"), upload.filekey);
          assert.equal(url.searchParams.get("encrypted_query_param"), "upload+parameter/value=");
          assert.equal(new Headers(init!.headers).get("authorization"), null);
          assert.equal(init!.redirect, "error");
          const encrypted = Buffer.from(init!.body as Uint8Array);
          assert.equal(encrypted.length, upload.filesize);
          const decipher = createDecipheriv("aes-128-ecb", Buffer.from(upload.aeskey, "hex"), null);
          assert.deepEqual(Buffer.concat([decipher.update(encrypted), decipher.final()]), bytes);
          return new Response("", { headers: { "x-encrypted-param": "download-reference" } });
        }
        sequence.push("send");
        const body = JSON.parse(String(init!.body));
        assert.equal(body.msg.client_id, "stable-id"); assert.equal(body.msg.to_user_id, "owner");
        assert.equal(body.msg.item_list.length, 1); item = body.msg.item_list[0];
        return json({ ret: 0 });
      };
      await new IlinkClient(credentials, undefined, request).send(payload(kind), new AbortController().signal,
        { mediaBytes: bytes, beforeSend: async () => { sequence.push("start"); } });
      assert.deepEqual(sequence, ["prepare", "cdn", "start", "send"]);
      const media = kind === "image" ? item.image_item.media : item.file_item.media;
      assert.equal(media.encrypt_type, 1); assert.equal(media.encrypt_query_param, "download-reference");
      assert.equal(Buffer.from(media.aes_key, "base64").toString("utf8"), upload.aeskey);
      assert.equal(item.type, kind === "image" ? 2 : 4);
      if (kind === "image") assert.equal(item.image_item.mid_size, upload.filesize);
      else { assert.equal(item.file_item.len, String(size)); assert.equal(item.file_item.file_name, "测试 文档.pdf"); }
    }
  }
});

test("upload full URL has precedence and untrusted, insecure or redirected targets cannot reach sendmessage", async () => {
  assert.equal(trustedUploadUrl({ upload_full_url: " https://novac2c.cdn.weixin.qq.com/c2c/upload?full=1 ", upload_param: "ignored" }, "fk"),
    "https://novac2c.cdn.weixin.qq.com/c2c/upload?full=1");
  for (const upload_full_url of ["http://novac2c.cdn.weixin.qq.com/upload", "https://cdn.weixin.qq.com.evil.test/upload",
    "https://user:pass@cdn.weixin.qq.com/upload", "https://cdn.weixin.qq.com:443/upload", "https://127.0.0.1/upload"]) {
    assert.throws(() => trustedUploadUrl({ upload_full_url }, "fk"));
  }
  let started = false, sends = 0;
  const request: typeof fetch = async input => {
    if (String(input).endsWith("getuploadurl")) return json({ upload_full_url: "https://private.test/upload" });
    sends++; return json({ ret: 0 });
  };
  await assert.rejects(new IlinkClient(credentials, undefined, request).send(payload("file"), new AbortController().signal,
    { mediaBytes: Buffer.from("file"), beforeSend: async () => { started = true; } }),
  error => error instanceof IlinkError && error.code === "media_upload_url_untrusted" && error.outcome === "failed");
  assert.equal(started, false); assert.equal(sends, 0);
});

test("pre-send CDN failures stay determinate, bounded retries reuse ciphertext, actual send transport loss stays unknown", async () => {
  for (const scenario of ["403", "500", "missing", "recover", "send-loss"]) {
    let uploads = 0, sends = 0, starts = 0;
    let ciphertext: Buffer | undefined;
    const request: typeof fetch = async (input, init) => {
      if (String(input).endsWith("getuploadurl")) return json({ upload_param: "parameter" });
      if (String(input).includes("/c2c/upload?")) {
        uploads++;
        const current = Buffer.from(init!.body as Uint8Array);
        if (ciphertext) assert.deepEqual(current, ciphertext); else ciphertext = current;
        if (scenario === "403") return new Response("forbidden", { status: 403 });
        if (scenario === "500" || (scenario === "recover" && uploads === 1)) return new Response("failure", { status: 500 });
        if (scenario === "missing") return new Response("");
        return new Response("", { headers: { "x-encrypted-param": "download" } });
      }
      sends++;
      if (scenario === "send-loss") throw new TypeError("transport failed");
      return json({ ret: 0 });
    };
    const sending = new IlinkClient(credentials, undefined, request).send(payload("file"), new AbortController().signal,
      { mediaBytes: Buffer.from("actual bytes"), beforeSend: async () => { starts++; } });
    if (scenario === "recover") { await sending; assert.equal(uploads, 2); assert.equal(sends, 1); }
    else {
      await assert.rejects(sending, error => error instanceof IlinkError && error.outcome ===
        (scenario === "403" ? "failed" : scenario === "send-loss" ? "unknown" : "retryable"));
      assert.equal(uploads, scenario === "403" || scenario === "send-loss" ? 1 : 3);
      assert.equal(sends, scenario === "send-loss" ? 1 : 0);
    }
    assert.equal(starts, scenario === "recover" || scenario === "send-loss" ? 1 : 0);
  }
});
