import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeMediaJob } from "../src/gateway/media-job.ts";
import { ParticipantRuntime } from "../src/gateway/participant-runtime.ts";
import { JobDispatcher } from "../src/gateway/job-dispatcher.ts";
import { IlinkClient } from "../src/gateway/ilink.ts";
import { Journal } from "../src/gateway/storage.ts";
import type { BridgePort } from "../src/gateway/multi-contracts.ts";
import type { ReplyJob } from "../src/shared/contracts.ts";

const auth = () => ({ gateway_id: "gateway", lease_token: "lease" });
const snapshot = (bytes: Uint8Array) => ({ key: "immutable-key", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
const job = (): ReplyJob => ({ id: "media-job", kind: "reply", participant_id: "a", claim_token: "claim", payload: {
  client_id: "media-job", to_user_id: "owner", text: "", media: { kind: "file", name: "report.pdf", source: { type: "url", url: "https://example.test/report" } },
} });
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("media preparation heartbeats renew through download/upload and stop before actual send", async () => {
  const bytes = Buffer.from("immutable file"), actions: string[] = [];
  const bridge = {
    post: async (route: string) => { actions.push(route); return {}; }, uploadAttachment: async () => { throw new Error("unused"); },
    cacheMedia: async (_auth: unknown, data: Uint8Array) => { actions.push("cache"); assert.deepEqual(data, bytes); return snapshot(bytes); },
  } as BridgePort;
  const current = job();
  await executeMediaJob(current, bridge, auth, new AbortController().signal, async () => { actions.push("journal"); },
    async (data, _signal, beforeSend) => {
      assert.deepEqual(data, bytes); actions.push("upload"); await wait(35); await beforeSend(); actions.push("send");
      const count = actions.filter(action => action === "job-heartbeat").length;
      await wait(30); assert.equal(actions.filter(action => action === "job-heartbeat").length, count);
    }, { heartbeatMs: 10, download: async () => { await wait(35); return bytes; } });
  assert.ok(actions.filter(action => action === "job-heartbeat").length >= 5);
  assert.ok(actions.indexOf("cache") < actions.indexOf("upload"));
  assert.deepEqual(actions.slice(-3), ["journal", "start-send", "send"]);
  assert.deepEqual(current.payload.media!.cached, snapshot(bytes));
});

test("lost preparation lease cancels work before journal or send; snapshots bypass mutable URLs and validate checksum", async () => {
  const bytes = Buffer.from("cached"), current = job();
  current.payload.media!.cached = snapshot(bytes);
  let beats = 0, started = false, sent = false;
  const bridge = {
    post: async () => { if (++beats > 1) throw new Error("bridge_http_409"); return {}; },
    uploadAttachment: async () => { throw new Error("unused"); }, downloadMedia: async () => bytes,
  } as BridgePort;
  await assert.rejects(executeMediaJob(current, bridge, auth, new AbortController().signal, async () => { started = true; },
    async (_bytes, signal, beforeSend) => { await wait(35); assert.equal(signal.aborted, true); await beforeSend(); sent = true; },
    { heartbeatMs: 10, download: async () => { throw new Error("must not use mutable source"); } }));
  assert.equal(started, false); assert.equal(sent, false);
  bridge.post = async () => ({} as any);
  await executeMediaJob(current, bridge, auth, new AbortController().signal, async () => {}, async (data, _signal, beforeSend) => {
    assert.deepEqual(data, bytes); await beforeSend();
  }, { download: async () => { throw new Error("must not use mutable source"); } });
  current.payload.media!.cached!.sha256 = "0".repeat(64);
  await assert.rejects(executeMediaJob(current, bridge, auth, new AbortController().signal, async () => {}, async () => {}),
    /附件快照校验失败/);
});

test("disabled start-send refuses media after successful CDN upload; sending transport failure remains unknown", async t => {
  const directory = await mkdtemp(join(tmpdir(), "dot-wechat-media-job-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from("file bytes"), current = job(); current.payload.media!.source = { type: "stored", ...snapshot(bytes) };
  let disabled = true, sends = 0, started = 0;
  const bridge = { post: async (route: string) => {
    if (route === "start-send" && disabled) throw new Error("bridge_http_409"); return {};
  }, downloadMedia: async () => bytes, uploadAttachment: async () => { throw new Error("unused"); } } as BridgePort;
  const request: typeof fetch = async input => {
    if (String(input).endsWith("getuploadurl")) return new Response(JSON.stringify({ upload_param: "upload" }));
    if (String(input).includes("/c2c/upload?")) return new Response("", { headers: { "x-encrypted-param": "download" } });
    sends++; throw new TypeError("actual send lost");
  };
  const credentials = { baseUrl: "https://ilinkai.weixin.qq.com", userId: "owner", botId: "bot", botToken: "test" };
  const participant = new ParticipantRuntime("a", credentials, "", await Journal.load(join(directory, "journal.json")),
    new IlinkClient(credentials, undefined, request), bridge, () => ({ ...auth(), participant_id: "a" }), 20);
  const rejected = await participant.send(current, new AbortController().signal, async () => { started++; });
  assert.equal(rejected.outcome, "retryable"); assert.equal(sends, 0); assert.equal(started, 1);
  disabled = false;
  const unknown = await participant.send(current, new AbortController().signal, async () => { started++; });
  assert.equal(unknown.outcome, "unknown"); assert.equal(sends, 1);
});

test("dispatcher persists preparation separately and recovers only started sends as unknown", async t => {
  const directory = await mkdtemp(join(tmpdir(), "dot-wechat-media-recovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "journal.json"), journal = await Journal.load(path);
  journal.data.jobs = {
    preparing: { kind: "reply", claimToken: "p", started: false },
    sending: { kind: "reply", claimToken: "s", started: true },
  };
  await journal.save();
  const controller = new AbortController(), results: any[] = [];
  let claimed = false;
  const bridge = { post: async (route: string, body: any) => {
    if (route === "complete") { results.push(body); if (results.length === 3) controller.abort(); }
    if (route === "jobs" && !claimed) { claimed = true; return { jobs: [job()] }; }
    return route === "jobs" ? { jobs: [] } : {};
  }, uploadAttachment: async () => { throw new Error("unused"); } } as BridgePort;
  const fake = { send: async (current: ReplyJob, _signal: AbortSignal, markStarted: () => Promise<void>) => {
    assert.equal(JSON.parse(await readFile(path, "utf8")).jobs[current.id].started, false);
    await markStarted();
    assert.equal(JSON.parse(await readFile(path, "utf8")).jobs[current.id].started, true);
    return { job_id: current.id, claim_token: current.claim_token, outcome: "delivered" as const };
  } } as unknown as ParticipantRuntime;
  await new JobDispatcher(bridge, journal, auth, 10, () => fake, undefined, () => {}).run(controller.signal);
  assert.deepEqual(results.map(result => [result.job_id, result.outcome]),
    [["preparing", "retryable"], ["sending", "unknown"], ["media-job", "delivered"]]);
  assert.deepEqual(journal.data.jobs, {});
});
