import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fixture, message, sessionArgs } from "./helpers.ts";
import type { Client } from "./helpers.ts";

async function upload(c: Client, id: string, name: string, mime: string, data: Buffer, kind: "image" | "file" = "file") {
  const response = await c.attachment({ upstream_id: id, item_index: 0, kind, name, mime_type: mime }, data);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.sha256, createHash("sha256").update(data).digest("hex"));
  return response.body;
}

test("original PDF, Word, Excel, PPT and text bytes survive upload, ingestion and MCP reads", async t => {
  const c = await fixture(t); await c.start();
  const formats = [
    ["report.pdf", "application/pdf"],
    ["报告.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["book.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["slides.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    ["text.txt", "text/plain"],
  ];
  const attachments = [];
  for (const [index, [name, mime]] of formats.entries()) {
    const data = Buffer.concat([Buffer.from(name), Buffer.from([0, 255, 128, index])]);
    const attachment = await upload(c, String(index), name, mime, data);
    const again = await upload(c, String(index), name, mime, data); assert.deepEqual(again, attachment);
    attachments.push({ attachment, data });
  }
  await c.ingest(attachments.map(({ attachment }, index) => message(String(index), "file", { kind: "media", attachments: [attachment] })), "next");
  const session = await c.session();
  const read = await c.ok("wechat_read_messages", sessionArgs(session));
  assert.equal(read.messages.length, 5);
  assert.equal(JSON.stringify(read).includes("context_cipher"), false);
  for (const [index, { attachment, data }] of attachments.entries()) {
    assert.deepEqual(read.messages[index].attachments, [attachment]);
    const result = await c.tool("wechat_read_attachment", { attachment_id: attachment.id });
    const resource = result.content.find((item: any) => item.type === "resource").resource;
    assert.equal(resource.mimeType, attachment.mime_type);
    assert.deepEqual(Buffer.from(resource.blob, "base64"), data);
    assert.equal(resource.text, undefined);
    const resourceRead = await c.rpc("resources/read", { uri: attachment.uri });
    assert.deepEqual(Buffer.from(resourceRead.body.result.contents[0].blob, "base64"), data);
  }
  const history = await c.ok("wechat_read_history");
  assert.deepEqual(history.messages.map((row: any) => row.attachments[0].id), attachments.map(item => item.attachment.id));
  assert.equal((await c.rows("SELECT count(*) AS n FROM attachments"))[0].n, 5);
});

test("pictures return native image content with the original bytes", async t => {
  const c = await fixture(t); await c.start();
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1kAAAAASUVORK5CYII=", "base64");
  const attachment = await upload(c, "image", "image.png", "image/png", png, "image");
  await c.ingest([message("image", "[微信图片]", { kind: "media", attachments: [attachment] })], "next");
  const result = await c.tool("wechat_read_attachment", { attachment_id: attachment.id });
  const image = result.content.find((item: any) => item.type === "image");
  assert.equal(image.mimeType, "image/png");
  assert.deepEqual(Buffer.from(image.data, "base64"), png);
});

test("uncommitted attachments and other identities cannot read private file bytes", async t => {
  const c = await fixture(t); await c.start();
  const attachment = await upload(c, "private", "private.txt", "text/plain", Buffer.from("test attachment"));
  const args = { attachment_id: attachment.id };
  assert.equal((await c.tool("wechat_read_attachment", args)).structuredContent.error, "attachment_not_found");
  const mismatched = await c.ingest([message("wrong-id", "file", { attachments: [attachment] })], "next");
  assert.equal(mismatched.status, 404);
  await c.ingest([message("private", "file", { attachments: [attachment] })], "next");
  assert.equal((await c.rpc("tools/call", { name: "wechat_read_attachment", arguments: args }, "other-user")).status, 403);
  assert.equal((await c.rpc("resources/read", { uri: attachment.uri }, null)).status, 401);
  assert.equal((await c.rpc("resources/read", { uri: attachment.uri }, "other-user")).status, 403);
  const noLease = await c.attachment({ upstream_id: "x", item_index: 0,
    kind: "file", name: "x.txt", mime_type: "text/plain" }, Buffer.alloc(0), { ...c.gateway, lease_token: "wrong" });
  assert.equal(noLease.status, 409);
});

test("upload conflicts and invalid files do not replace a stored original", async t => {
  const c = await fixture(t); await c.start();
  const original = await upload(c, "stable", "report.pdf", "application/pdf", Buffer.from("original"));
  const changed = await c.attachment({ upstream_id: "stable", item_index: 0, kind: "file",
    name: "report.pdf", mime_type: "application/pdf" }, Buffer.from("changed"));
  assert.equal(changed.status, 409); assert.equal(changed.body.error, "attachment_upload_conflict");
  const invalid = { upstream_id: "invalid", item_index: 0, kind: "file" as const, name: "report.pdf", mime_type: "invalid" };
  assert.equal((await c.attachment(invalid, Buffer.alloc(0))).status, 400);
  assert.equal((await c.attachment({ ...invalid, name: "../file", mime_type: "application/pdf" }, Buffer.alloc(0))).status, 400);
  await c.ingest([message("stable", "file", { attachments: [original] })], "next");
  const result = await c.tool("wechat_read_attachment", { attachment_id: original.id });
  assert.equal(Buffer.from(result.content[1].resource.blob, "base64").toString(), "original");
});

test("failed media remains visible and ordinary text retains its existing shape", async t => {
  const c = await fixture(t); await c.start();
  const failed = { item_index: 0, kind: "file" as const, name: "report.pdf", status: "failed" as const,
    error_code: "media_download_timeout", error_message: "微信附件下载超时" };
  await c.ingest([message("file", "[微信文件：report.pdf]", { kind: "media", attachments: [failed] }), message("text")], "next");
  const session = await c.session(), read = await c.ok("wechat_read_messages", sessionArgs(session));
  assert.deepEqual(read.messages[0].attachments, [failed]);
  assert.equal(read.messages[1].attachments, undefined); assert.equal(read.messages[1].attachments_json, undefined);
});
