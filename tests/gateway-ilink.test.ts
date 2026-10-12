import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage as HttpMessage } from "node:http";
import { createServer as createTcpServer, type Socket } from "node:net";
import { channel } from "node:diagnostics_channel";
import { once } from "node:events";
import { Agent } from "undici";
import { IlinkClient, IlinkError, inboundMessages, parseIlinkJson, trustedWechatBase } from "../src/gateway/ilink.ts";
import { bindWechat } from "../src/gateway/bind.ts";

async function body(request: HttpMessage): Promise<any> {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString(); return raw ? JSON.parse(raw) : undefined;
}
test("ilink current POST QR protocol, verification, authenticated payload and uint64 IDs over HTTP", async t => {
  const calls: { path: string; method: string; body: any; headers: HttpMessage["headers"] }[] = [];
  const server = createServer(async (request, response) => {
    calls.push({ path: request.url!, method: request.method!, body: await body(request), headers: request.headers });
    response.setHeader("content-type", "application/json");
    if (request.url!.includes("get_bot_qrcode")) response.end(JSON.stringify({ qrcode: "qr", qrcode_img_content: "https://weixin.qq.com/qr-test" }));
    else if (request.url!.includes("get_qrcode_status")) response.end(JSON.stringify(request.url!.includes("verify_code=1234")
      ? { status: "confirmed", bot_token: "test-token", ilink_bot_id: "test-bot", ilink_user_id: "test-owner", baseurl: "https://ilinkai.weixin.qq.com" }
      : { status: "need_verifycode" }));
    else if (request.url!.includes("getupdates")) response.end('{"ret":0,"get_updates_buf":"next","msgs":[{"message_id":18446744073709551615,"from_user_id":"test-owner","message_type":1,"context_token":"ctx","item_list":[{"type":1,"text_item":{"text":"hello"}}]}]}');
    else response.end('{"ret":0}');
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => server.close());
  const address = server.address() as { port: number };
  const transport: typeof fetch = (input, init) => {
    const url = new URL(String(input)); return fetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, init);
  };
  const credentials = await bindWechat(new IlinkClient(undefined, undefined, transport), {
    refreshLimit: 0, timeoutMs: 3000, displayQr: () => {}, verificationCode: async () => "1234",
  });
  assert.equal(credentials.userId, "test-owner");
  assert.equal(calls[0].method, "POST"); assert.deepEqual(calls[0].body, { local_token_list: [] });
  assert.equal(calls[0].headers.authorization, undefined);
  assert.equal(calls[0].headers.authorizationtype, "ilink_bot_token");
  assert.equal(calls[1].headers.authorizationtype, undefined);
  const client = new IlinkClient(credentials, undefined, transport);
  const updates = await client.updates("old", new AbortController().signal);
  const messages = inboundMessages(updates.msgs!, "test-owner", "test-bot");
  assert.equal(messages[0].upstream_id, "18446744073709551615");
  await client.send({ client_id: "stable", to_user_id: "test-owner", text: "reply", context_token: "ctx" }, new AbortController().signal);
  assert.equal(calls[3].headers.authorization, "Bearer test-token");
  assert.equal(calls[3].headers['ilink-app-clientversion'], '132105');
  assert.equal(calls[3].body.base_info.channel_version, '2.4.9');
  assert.equal(calls[3].body.get_updates_buf, "old");
  assert.equal(calls[3].body.base_info.bot_agent, "DotWechatBridge/0.1.0");
  assert.equal(calls[4].body.msg.client_id, "stable");
  assert.equal(calls[4].body.msg.message_type, 2);
  await assert.rejects(client.send({ client_id: "x", to_user_id: "stranger", text: "reply", context_token: "ctx" }, new AbortController().signal), IlinkError);
});

test('server polling timeout is adopted; client timeout retains cursor and either error field can expire credentials', async t => {
  let calls=0;
  const server=createServer((_request,response)=>{
    calls++;
    if(calls===1) response.end('{"ret":0,"longpolling_timeout_ms":30,"get_updates_buf":"next","msgs":[]}');
    if(calls===3) response.end('{"ret":-2,"errcode":-14}');
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close();});
  const port=(server.address() as {port:number}).port;
  const transport:typeof fetch=(_input,init)=>fetch(`http://127.0.0.1:${port}`,init);
  const client=new IlinkClient({baseUrl:'https://ilinkai.weixin.qq.com',userId:'owner',botId:'bot',botToken:'test'},undefined,transport);
  const signal=new AbortController().signal;
  const first=await client.updates('',signal);assert.equal(first.get_updates_buf,'next');
  const timedOut=await client.updates('next',signal);
  assert.deepEqual(timedOut,{msgs:[],get_updates_buf:'next'});
  await assert.rejects(client.updates('next',signal),error=>error instanceof IlinkError && error.code==='credential_expired');
});

test('proactive HTTP send omits an absent context, keeps the owner restriction and reports upstream rejection safely', async t => {
  const sent: any[] = [];
  let rejected = false;
  const server = createServer(async (request, response) => {
    sent.push(await body(request));
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(rejected
      ? { ret: 42, errmsg: 'context required test-bot-token token=private-value https://private.test/?token=secret' }
      : { ret: 0 }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as { port: number }).port;
  const transport: typeof fetch = (_input, init) => fetch(`http://127.0.0.1:${port}/ilink/bot/sendmessage`, init);
  const client = new IlinkClient({ baseUrl: 'https://ilinkai.weixin.qq.com', userId: 'owner', botId: 'bot', botToken: 'test-bot-token' }, undefined, transport);
  const payload = { client_id: 'send-stable', to_user_id: 'owner', text: '主动消息' };
  await client.send(payload, new AbortController().signal);
  assert.equal(Object.hasOwn(sent[0].msg, 'context_token'), false);
  assert.equal(sent[0].msg.to_user_id, 'owner'); assert.equal(sent[0].msg.client_id, 'send-stable');
  assert.equal(sent[0].msg.item_list[0].text_item.text, '主动消息');
  await assert.rejects(client.send({ ...payload, to_user_id: 'stranger' }, new AbortController().signal),
    (error: unknown) => error instanceof IlinkError && error.outcome === 'failed');
  assert.equal(sent.length, 1);
  rejected = true;
  await assert.rejects(client.send({ ...payload, context_token: '' }, new AbortController().signal),
    (error: unknown) => error instanceof IlinkError && error.code === 'ilink_error_42' && error.outcome === 'failed'
      && error.detail.includes('context required') && !error.detail.includes('test-bot-token')
      && !error.detail.includes('private-value') && !error.detail.includes('secret'));
  assert.equal(sent.length, 2);
  assert.equal(Object.hasOwn(sent[1].msg, 'context_token'), false);
});

test("lossless parser preserves strings and IDs; allowlist excludes groups and echoes", () => {
  const parsed = parseIlinkJson<any>('{"text":"\\\"message_id\\\":18446744073709551615","message_id":18446744073709551615,"seq":9007199254740993}');
  assert.equal(parsed.message_id, "18446744073709551615"); assert.equal(parsed.seq, "9007199254740993");
  assert.equal(parsed.text, '"message_id":18446744073709551615');
  const base = { message_id: "1", from_user_id: "owner", context_token: "ctx", message_type: 1, item_list: [{ type: 3, voice_item: { text: "transcript" } }] };
  const result = inboundMessages([base, { ...base, group_id: "group" }, { ...base, message_type: 2 }, { ...base, from_user_id: "other" }], "owner", "bot");
  assert.equal(result.length, 1); assert.equal(result[0].text, "transcript"); assert.equal(result[0].kind, "voice");
  for (const url of ["http://ilinkai.weixin.qq.com", "https://weixin.qq.com.evil.test", "https://127.0.0.1", "https://ilinkai.weixin.qq.com/path", "https://user:pass@ilinkai.weixin.qq.com"]) {
    assert.throws(() => trustedWechatBase(url));
  }
  assert.equal(trustedWechatBase("ilinkai.weixin.qq.com"), "https://ilinkai.weixin.qq.com");
});

test("TLS connection timeout before request write is retryable", async t => {
  const sockets = new Set<Socket>();
  let handshakeBytes = 0, requestsWritten = 0;
  const server = createTcpServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", bytes => { handshakeBytes += bytes.length; });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const agent = new Agent({ connect: { timeout: 100 } });
  const sendHeaders = channel("undici:client:sendHeaders");
  const countRequest = (message: unknown) => {
    if ((message as { socket: Socket }).socket.remotePort === port) requestsWritten++;
  };
  sendHeaders.subscribe(countRequest);
  t.after(async () => {
    sendHeaders.unsubscribe(countRequest);
    await agent.destroy();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const transport: typeof fetch = (_input, init) => fetch(`https://127.0.0.1:${port}/`,
    { ...init, dispatcher: agent } as RequestInit & { dispatcher: Agent });
  const client = new IlinkClient({ baseUrl: "https://ilinkai.weixin.qq.com", userId: "owner", botId: "bot", botToken: "test" }, undefined, transport);
  await assert.rejects(client.send({ client_id: "stable", to_user_id: "owner", text: "hello" }, new AbortController().signal),
    (error: unknown) => error instanceof IlinkError && error.code === "ilink_connect_timeout"
      && error.outcome === "retryable" && error.detail === "微信连接超时（UND_ERR_CONNECT_TIMEOUT）");
  assert.ok(handshakeBytes > 0);
  assert.equal(requestsWritten, 0);
});

test("reply transport loss remains unknown; explicit credential expiry is failed", async t => {
  let stage = "transport";
  const server = createServer((_request, response) => {
    if (stage === "expired") response.end('{"ret":-14}');
    else if (stage === "reason") response.end('{"ret":42,"errmsg":"denied test ctx https://private.test/?token=secret"}');
    else if (stage === "transport") response.destroy();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as { port: number }).port;
  const transport: typeof fetch = (_input, init) => fetch(`http://127.0.0.1:${port}/`, stage === "timeout" ? { ...init, signal: AbortSignal.timeout(30) } : init);
  const client = new IlinkClient({ baseUrl: "https://ilinkai.weixin.qq.com", userId: "owner", botId: "bot", botToken: "test" }, undefined, transport);
  const payload = { client_id: "stable", to_user_id: "owner", text: "hello", context_token: "ctx" };
  await assert.rejects(client.send(payload, new AbortController().signal), (error: unknown) => error instanceof IlinkError && error.outcome === "unknown");
  stage = "expired";
  await assert.rejects(client.send(payload, new AbortController().signal), (error: unknown) => error instanceof IlinkError && error.code === "credential_expired" && error.outcome === "failed");
  stage = "reason";
  await assert.rejects(client.send(payload, new AbortController().signal), (error: unknown) => error instanceof IlinkError && error.detail.includes("42") && !error.detail.includes("secret") && !error.detail.includes("ctx") && !error.detail.includes(" test "));
  stage = "timeout";
  await assert.rejects(client.send(payload, new AbortController().signal), (error: unknown) => error instanceof IlinkError && error.code === "send_timeout" && error.detail === "发送超时" && error.outcome === "unknown");
});
