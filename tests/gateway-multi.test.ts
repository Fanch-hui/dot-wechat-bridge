import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewaySupervisor } from "../src/gateway/supervisor.ts";
import { BridgeClient } from "../src/gateway/bridge.ts";
import { IlinkClient } from "../src/gateway/ilink.ts";
import { Journal, atomicPrivateJson, type Credentials } from "../src/gateway/storage.ts";
import { delay, type GatewayControl } from "../src/gateway/multi-contracts.ts";
import type { GatewayConfig } from "../src/gateway/config.ts";

const credentials = (id: string): Credentials => ({ botToken: `test-${id}`, botId: `bot-${id}`, userId: id,
  baseUrl: "https://ilinkai.weixin.qq.com" });
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
async function waitFor(check: () => boolean, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() >= end) throw new Error("Test deadline exceeded"); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function setup(t: TestContext, control: GatewayControl,
  handler: (route: string, body: any) => unknown | Promise<unknown> = () => undefined,
  transport: typeof fetch = async () => response({})) {
  const directory = await mkdtemp(join(tmpdir(), "dot-wechat-multi-test-"));
  const config: GatewayConfig = { bridgeUrl: "http://localhost", bridgeToken: "test-bridge", runtimeDir: directory,
    tickMs: 20, qrRefreshLimit: 0, qrTimeoutMs: 300000 };
  const calls: { route: string; body: any }[] = [];
  const request: typeof fetch = async (input, init) => {
    const route = new URL(String(input)).pathname.split("/").at(-1)!;
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ route, body });
    const custom = await handler(route, body);
    if (custom instanceof Response) return custom;
    if (custom !== undefined) return response(custom);
    if (route === "lease") {
      assert.equal(body.protocol_version, 2);
      return response({ gateway_id: body.gateway_id, lease_token: "test-lease", cursor: "", lease_until: Date.now() + 30000 });
    }
    if (route === "control") return response(control);
    if (route === "tick") return response({ lease_until: Date.now() + 30000 });
    if (route === "jobs") return response({ jobs: [] });
    if (route === "binding") {
      const binding = control.bindings.find(item => item.id === body.id)!;
      binding.state = body.state;
      if (body.state === "confirmed") {
        const member = control.participants.find(item => item.id === binding.participant_id)!;
        member.sender = body.sender; member.bot_id = body.bot_id; member.status = "ok"; member.binding_id = binding.id;
      }
    }
    return response({ accepted: true });
  };
  const journal = await Journal.load(join(directory, "gateway-journal.json"));
  let controller = new AbortController();
  let running: Promise<void> | undefined;
  const start = () => {
    if (controller.signal.aborted) controller = new AbortController();
    return running = new GatewaySupervisor(config, journal, { bridge: new BridgeClient(config, request),
    ilink: account => new IlinkClient(account, undefined, transport), report: () => {},
    webhook: async job => ({ job_id: job.id, claim_token: job.claim_token, outcome: "delivered" }),
    }).run(controller.signal);
  };
  const stop = async () => { controller.abort(); await running; };
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  return { directory, control, calls, journal, start, stop, config, abort: () => controller.abort() };
}
const member = (id: string) => ({ id, display_name: id, enabled: 1, sender: id, bot_id: `bot-${id}`, cursor: "old", status: "ok" });
const binding = (id: string, participant_id: string) => ({ id, participant_id, state: "queued", expires_at: Date.now() + 300000 });
async function saveMember(directory: string, id: string) {
  await atomicPrivateJson(join(directory, "participants", id, "wechat-credentials.json"), credentials(id));
}

test("two accounts keep identical upstream IDs separate; one expired account leaves other messages, replies and events active", async t => {
  const polled = new Set<string>(), sent: string[] = [];
  let claimed = false;
  const transport: typeof fetch = async (input, init) => {
    const account = new Headers(init?.headers).get("authorization")!.replace("Bearer test-", "");
    if (String(input).endsWith("sendmessage")) {
      const body = JSON.parse(String(init?.body)); sent.push(body.msg.to_user_id); return response({ ret: 0 });
    }
    if (polled.has(account)) { await delay(30000, init!.signal as AbortSignal); return response({ ret: 0 }); }
    polled.add(account);
    if (account === "a") return response({ ret: -14 });
    return response({ ret: 0, get_updates_buf: "new", msgs: [{ message_id: "1", from_user_id: account,
      message_type: 1, item_list: [{ type: 1, text_item: { text: `hello-${account}` } }] }] });
  };
  const fixture = await setup(t, { participants: [member("a"), member("b"), member("c")], bindings: [] }, (route, body) => {
    if (route === "jobs" && polled.has("b") && !claimed) {
      claimed = true;
      return { jobs: ["b", "c"].map(id => ({ id: `reply-${id}`, kind: "reply", participant_id: id, claim_token: "claim",
        payload: { to_user_id: id, client_id: `reply-${id}`, text: "reply" } })).concat([
          { id: "event", kind: "webhook", claim_token: "event", payload: {} } as any,
        ]) };
    }
    if (route === "ingest") {
      const person = fixture.control.participants.find(item => item.id === body.participant_id)!;
      person.cursor = body.cursor;
    }
  }, transport);
  for (const id of ["a", "b", "c"]) await saveMember(fixture.directory, id);
  fixture.start();
  await waitFor(() => fixture.calls.filter(call => call.route === "complete").length === 3 &&
    fixture.calls.some(call => call.route === "health" && call.body.participant_id === "a" && call.body.status === "credential_expired"));
  await fixture.stop();
  const incoming = fixture.calls.filter(call => call.route === "ingest");
  assert.deepEqual(incoming.map(call => [call.body.participant_id, call.body.messages[0].upstream_id]).sort(), [["b", "1"], ["c", "1"]]);
  assert.deepEqual(sent.sort(), ["b", "c"]);
  assert.ok(fixture.calls.filter(call => call.route === "complete").every(call => call.body.outcome === "delivered"));
});

test("disabled member retains pending batch; recovery restores it before another upstream poll", async t => {
  let polls = 0, allowIngest = false, accepted = false;
  const transport: typeof fetch = async (_input, init) => {
    polls++;
    if (polls > 1) { await delay(30000, init!.signal as AbortSignal); return response({ ret: 0 }); }
    return response({ ret: 0, get_updates_buf: "next", msgs: [{ message_id: "1", from_user_id: "a", message_type: 1,
      item_list: [{ type: 1, text_item: { text: "pending" } }] }] });
  };
  const fixture = await setup(t, { participants: [member("a")], bindings: [] }, (route, body) => {
    if (route === "ingest") {
      if (!allowIngest) return response({}, 503);
      accepted = true; fixture.control.participants[0].cursor = body.cursor;
    }
  }, transport);
  await saveMember(fixture.directory, "a"); fixture.start();
  await waitFor(() => fixture.calls.some(call => call.route === "ingest"));
  fixture.control.participants[0].enabled = 0;
  await new Promise(resolve => setTimeout(resolve, 60));
  const path = join(fixture.directory, "participants", "a", "gateway-journal.json");
  assert.equal(JSON.parse(await readFile(path, "utf8")).pending.cursor, "next");
  assert.equal(polls, 1);
  allowIngest = true; fixture.control.participants[0].enabled = 1;
  await waitFor(() => accepted && polls === 2); await fixture.stop();
  const attempts = fixture.calls.filter(call => call.route === "ingest");
  assert.deepEqual(attempts[0].body, attempts[1].body);
  assert.equal(JSON.parse(await readFile(path, "utf8")).pending, undefined);
});

test("unbound service publishes QR immediately, handles webpage verification and persists credentials before confirmation retries", async t => {
  let confirmationAttempts = 0, waiting = false;
  const control: GatewayControl = { participants: [{ ...member("a"), sender: null, bot_id: null }], bindings: [binding("qr-a", "a")] };
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("get_bot_qrcode")) return response({ qrcode: "qr-a", qrcode_img_content: "https://example.test/new-qr" });
    if (url.pathname.endsWith("get_qrcode_status")) {
      if (url.searchParams.get("verify_code") !== "123") return response({ status: "need_verifycode" });
      return response({ status: "confirmed", bot_token: "test-a", ilink_bot_id: "bot-a", ilink_user_id: "a", baseurl: "https://ilinkai.weixin.qq.com" });
    }
    await delay(30000, init!.signal as AbortSignal); return response({ ret: 0 });
  };
  const fixture = await setup(t, control, async (route, body) => {
    if (route === "binding" && body.state === "waiting") { waiting = true; assert.equal(body.qr_content, "https://example.test/new-qr"); }
    if (route === "binding" && body.state === "need_verifycode") control.bindings[0].verification_code = "123";
    if (route === "binding" && body.state === "confirmed") {
      const local = JSON.parse(await readFile(join(fixture.directory, "participants", "a", "binding-credentials.json"), "utf8"));
      assert.equal(local.bindingId, "qr-a");
      if (++confirmationAttempts === 1) return response({}, 503);
    }
  }, transport);
  fixture.start();
  await waitFor(() => confirmationAttempts === 2 && control.bindings[0].state === "confirmed");
  await fixture.stop();
  assert.equal(waiting, true);
  assert.ok(fixture.calls.some(call => call.route === "tick"));
  assert.ok(fixture.calls.some(call => call.route === "binding" && call.body.state === "need_verifycode"));
  assert.equal(control.participants[0].sender, "a");
});

test("cancelled QR cannot activate late confirmation or overwrite another identity", async t => {
  let polling = false;
  let confirmed!: () => void;
  const late = new Promise<void>(resolve => { confirmed = resolve; });
  const control: GatewayControl = { participants: [member("a")], bindings: [binding("late", "a")] };
  const transport: typeof fetch = async (input, init) => {
    if (String(input).includes("get_bot_qrcode")) return response({ qrcode: "late", qrcode_img_content: "https://example.test/late" });
    if (String(input).includes("get_qrcode_status")) {
      polling = true; await late;
      return response({ status: "confirmed", bot_token: "wrong", ilink_bot_id: "bot-other", ilink_user_id: "other", baseurl: "https://ilinkai.weixin.qq.com" });
    }
    await delay(30000, init!.signal as AbortSignal); return response({ ret: 0 });
  };
  const fixture = await setup(t, control, undefined, transport);
  await saveMember(fixture.directory, "a"); fixture.start(); await waitFor(() => polling);
  control.bindings[0].state = "cancelled"; confirmed();
  await new Promise(resolve => setTimeout(resolve, 60)); await fixture.stop();
  assert.ok(!fixture.calls.some(call => call.route === "binding" && call.body.state === "confirmed"));
  assert.deepEqual(JSON.parse(await readFile(join(fixture.directory, "participants", "a", "wechat-credentials.json"), "utf8")), credentials("a"));
});

test("restart confirms saved binding receipt without requesting another QR", async t => {
  let qrCalls = 0;
  const control: GatewayControl = { participants: [{ ...member("a"), sender: null, bot_id: null }], bindings: [binding("saved", "a")] };
  const transport: typeof fetch = async (input, init) => {
    if (String(input).includes("qrcode")) { qrCalls++; return response({}); }
    await delay(30000, init!.signal as AbortSignal); return response({ ret: 0 });
  };
  const fixture = await setup(t, control, undefined, transport);
  await atomicPrivateJson(join(fixture.directory, "participants", "a", "binding-credentials.json"), { ...credentials("a"), bindingId: "saved" });
  fixture.start(); await waitFor(() => control.bindings[0].state === "confirmed"); await fixture.stop();
  assert.equal(qrCalls, 0);
  assert.equal(control.participants[0].sender, "a");
});

test("QR expiration and identity mismatch report terminal states without replacing credentials", async t => {
  const control: GatewayControl = { participants: [member("a"), { ...member("b"), sender: null, bot_id: null }],
    bindings: [binding("mismatch", "a"), binding("expired", "b")] };
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("get_bot_qrcode")) return response({ qrcode: "request", qrcode_img_content: "https://example.test/qr" });
    if (url.pathname.endsWith("get_qrcode_status")) {
      return response({ status: "expired" });
    }
    await delay(30000, init!.signal as AbortSignal); return response({ ret: 0 });
  };
  const fixture = await setup(t, control, undefined, transport);
  await saveMember(fixture.directory, "a");
  await atomicPrivateJson(join(fixture.directory, "participants", "a", "binding-credentials.json"), { ...credentials("other"), bindingId: "mismatch" });
  fixture.start(); await waitFor(() => control.bindings.every(item => ["failed", "expired"].includes(item.state)));
  await fixture.stop();
  assert.equal(control.bindings[0].state, "failed");
  assert.equal(control.bindings[1].state, "expired");
  const failed = fixture.calls.find(call => call.route === "binding" && call.body.id === "mismatch")!;
  assert.equal(failed.body.error_code, "binding_identity_mismatch");
  assert.equal(control.participants[0].sender, "a");
  assert.equal(fixture.calls.filter(call => call.route === "binding" && call.body.id === "expired" && call.body.state === "expired").length, 1);
});

test("legacy pending ingestion and global send claims recover durably without retransmitting", async t => {
  let sends = 0;
  const transport: typeof fetch = async (input, init) => {
    if (String(input).endsWith("sendmessage")) { sends++; return response({ ret: 0 }); }
    await delay(30000, init!.signal as AbortSignal); return response({ ret: 0 });
  };
  const fixture = await setup(t, { participants: [member("personal")], bindings: [] }, undefined, transport);
  await atomicPrivateJson(join(fixture.directory, "wechat-credentials.json"), credentials("personal"));
  fixture.journal.data.pending = { previous_cursor: "old", cursor: "next", messages: [{ upstream_id: "1", sender: "personal",
    occurred_at: 1, text: "preserved", kind: "text", context_token: "test-context", message_type: 1 }] };
  fixture.journal.data.jobs = {
    legacy: { kind: "reply", claimToken: "legacy" },
    queued: { kind: "reply", claimToken: "queued", participantId: "personal", started: false },
    known: { kind: "reply", claimToken: "known", result: { job_id: "known", claim_token: "known", outcome: "delivered" } },
  };
  await fixture.journal.save(); fixture.start();
  await waitFor(() => fixture.calls.filter(call => call.route === "complete").length === 3 && fixture.calls.some(call => call.route === "ingest"));
  await fixture.stop();
  assert.equal(sends, 0);
  assert.deepEqual(Object.fromEntries(fixture.calls.filter(call => call.route === "complete").map(call => [call.body.job_id, call.body.outcome])),
    { legacy: "unknown", queued: "retryable", known: "delivered" });
  assert.equal(fixture.journal.data.pending, undefined);
  assert.deepEqual(fixture.journal.data.jobs, {});
  const ingest = fixture.calls.find(call => call.route === "ingest")!.body;
  assert.equal(ingest.participant_id, "personal"); assert.equal(ingest.cursor, "next");
});

test("reply order belongs to each member; a slow sender does not block another member", async t => {
  const sent: string[] = [];
  let claimed = false;
  const transport: typeof fetch = async (input, init) => {
    if (String(input).endsWith("sendmessage")) {
      const message = JSON.parse(String(init!.body)).msg;
      if (message.client_id === "a1") await delay(200, init!.signal as AbortSignal);
      sent.push(message.client_id); return response({ ret: 0 });
    }
    await delay(30000, init!.signal as AbortSignal); return response({ ret: 0 });
  };
  const fixture = await setup(t, { participants: [member("a"), member("b")], bindings: [] }, route => {
    if (route !== "jobs" || claimed) return;
    claimed = true;
    return { jobs: ["a1", "a2", "b1"].map(id => ({ id, kind: "reply", participant_id: id[0], claim_token: id,
      payload: { client_id: id, to_user_id: id[0], text: id } })) };
  }, transport);
  await saveMember(fixture.directory, "a"); await saveMember(fixture.directory, "b");
  fixture.start(); await waitFor(() => sent.length === 3); await fixture.stop();
  assert.deepEqual(sent, ["b1", "a1", "a2"]);
});

test("backend cancellation or expiration after confirmation check never promotes staged credentials or reports health", async t => {
  for (const terminal of ["cancelled", "expired"]) {
    let scanned = false, rejected = false;
    const control: GatewayControl = { participants: [{ ...member("a"), enabled: 0 }], bindings: [binding(terminal, "a")] };
    const transport: typeof fetch = async input => {
      if (String(input).includes("get_bot_qrcode")) return response({ qrcode: "race", qrcode_img_content: "https://example.test/race" });
      scanned = true;
      return response({ status: "confirmed", bot_token: "renewed-a", ilink_bot_id: "bot-a", ilink_user_id: "a", baseurl: "https://ilinkai.weixin.qq.com" });
    };
    const fixture = await setup(t, control, async (route, body) => {
      if (route === "control" && scanned && control.bindings[0].state !== terminal) {
        const snapshot = structuredClone(control);
        control.bindings[0].state = terminal;
        return snapshot;
      }
      if (route === "binding" && body.state === "confirmed") {
        rejected = true;
        assert.equal(control.bindings[0].state, terminal);
        const staged = JSON.parse(await readFile(join(fixture.directory, "participants", "a", "binding-credentials.json"), "utf8"));
        assert.equal(staged.botToken, "renewed-a");
        return { accepted: false };
      }
    }, transport);
    await saveMember(fixture.directory, "a"); fixture.start(); await waitFor(() => rejected);
    await new Promise(resolve => setTimeout(resolve, 50)); await fixture.stop();
    assert.deepEqual(JSON.parse(await readFile(join(fixture.directory, "participants", "a", "wechat-credentials.json"), "utf8")), credentials("a"));
    assert.ok(!fixture.calls.some(call => call.route === "health" && call.body.participant_id === "a"));
  }
});

test("restart after accepted confirmation promotes staging only when server binding identity matches", async t => {
  let qrCalls = 0, confirmationAccepted = false;
  const polled: string[] = [];
  const control: GatewayControl = { participants: [{ ...member("a"), enabled: 0 }], bindings: [binding("restart", "a")] };
  const transport: typeof fetch = async (input, init) => {
    if (String(input).includes("get_bot_qrcode")) { qrCalls++; return response({ qrcode: "restart", qrcode_img_content: "https://example.test/restart" }); }
    if (String(input).includes("get_qrcode_status")) return response({ status: "confirmed", bot_token: "renewed-a",
      ilink_bot_id: "bot-a", ilink_user_id: "a", baseurl: "https://ilinkai.weixin.qq.com" });
    polled.push(new Headers(init!.headers).get("authorization")!);
    await delay(30000, init!.signal as AbortSignal); return response({ ret: 0 });
  };
  const fixture = await setup(t, control, (route, body) => {
    if (route === "binding" && body.state === "confirmed") {
      control.bindings[0].state = "confirmed"; control.participants[0].binding_id = "restart";
      confirmationAccepted = true; fixture.abort();
      return { accepted: true };
    }
  }, transport);
  await saveMember(fixture.directory, "a"); fixture.start(); await waitFor(() => confirmationAccepted); await fixture.stop();
  const path = join(fixture.directory, "participants", "a", "wechat-credentials.json");
  assert.equal(JSON.parse(await readFile(path, "utf8")).botToken, "test-a");
  control.participants[0].enabled = 1; fixture.start();
  await waitFor(() => polled.includes("Bearer renewed-a")); await fixture.stop();
  assert.equal(qrCalls, 1);
  assert.equal(JSON.parse(await readFile(path, "utf8")).bindingId, "restart");
});
