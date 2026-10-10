import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, message, sessionArgs } from './helpers.ts';

const errorOf = (result: any) => result.structuredContent.error;
test('D1 ingestion filters non-owner, bot and group messages; cursor CAS and uint64 survive Worker restart', async t => {
  const c = await fixture(t, {}, true); await c.start();
  const batch = [message('18446744073709551615'), message('other', '', { sender: 'other' }),
    message('group', '', { group_id: 'group' }), message('echo', '', { message_type: 2 })];
  assert.equal((await c.ingest(batch, 'cursor-1')).status, 200);
  assert.equal((await c.ingest(batch, 'cursor-1')).status, 200);
  const conflict = await c.ingest([message('must-not-persist')], 'cursor-bad', 'stale');
  assert.equal(conflict.body.error, 'cursor_conflict');
  assert.equal((await c.rows('SELECT * FROM messages')).length, 1);
  const raw = (await c.rows('SELECT * FROM messages'))[0];
  assert.equal(raw.upstream_id, '18446744073709551615'); assert.ok(!raw.context_cipher.includes('context'));
  await c.restart();
  const resumed = await c.service('lease'); assert.equal(resumed.body.cursor, 'cursor-1');
  c.gateway.lease_token = resumed.body.lease_token;
  const session = await c.session();
  const read = await c.ok('wechat_read_messages', sessionArgs(session));
  assert.equal(read.messages[0].upstream_id, batch[0].upstream_id);
  assert.equal(read.messages[0].context_cipher, undefined); assert.equal(read.messages[0].sender, undefined);
});

test('one simulated Dot claim processes consecutive rounds with prefix order and idempotent send', async t => {
  const c = await fixture(t); await c.start(); await c.ingest([message('1'), message('2')], 'c1');
  const session = await c.session(), auth = sessionArgs(session);
  const repeated = await c.session(); assert.equal(repeated.lease_token, session.lease_token);
  assert.equal(errorOf(await c.tool('wechat_confirm_session', { session_id: session.session_id, consumer_id: 'other-dot' })),
    'session_already_claimed_or_expired');
  const first = (await c.ok('wechat_read_messages', auth)).messages;
  const sendArgs = { ...auth, message_ids: [first[0].sequence], text: 'first reply', idempotency_key: 'round1', wait_ms: 0 };
  assert.equal(errorOf(await c.tool('wechat_send_reply', { ...sendArgs, message_ids: [first[1].sequence] })),
    'reply_must_cover_pending_prefix');
  const queued = await c.ok('wechat_send_reply', sendArgs);
  assert.equal((await c.ok('wechat_send_reply', sendArgs)).reply_id, queued.reply_id);
  assert.equal(errorOf(await c.tool('wechat_send_reply', { ...sendArgs, text: 'changed' })), 'idempotency_conflict');
  await c.ok('wechat_send_reply', { ...sendArgs, message_ids: [first[1].sequence], idempotency_key: 'round2', text: 'second reply' });
  const jobs = await c.jobs(); assert.equal(jobs.length, 1);
  assert.equal(jobs[0].kind, 'reply'); if (jobs[0].kind === 'reply') assert.equal(jobs[0].payload.text, 'first reply');
  assert.equal((await c.jobs()).length, 0);
  await c.complete(jobs[0]); const second = await c.jobs(); assert.equal(second.length, 1); await c.complete(second[0]);
  await c.ingest([message('3')], 'c2', 'c1');
  const next = await c.ok('wechat_read_messages', auth); assert.equal(next.messages[0].text, 'message 3');
  await c.ok('wechat_heartbeat', auth);
  const blockedEnd = await c.ok('wechat_end_session', auth); assert.equal(blockedEnd.reason, 'messages_pending');
  await c.ok('wechat_send_reply', { ...sendArgs, message_ids: [next.messages[0].sequence], idempotency_key: 'round3' });
  await c.complete((await c.jobs())[0]);
  assert.equal((await c.ok('wechat_end_session', auth)).ended, true);
  const history = await c.ok('wechat_read_history'); assert.equal(history.replies.length, 3);
  assert.ok(history.replies.every((reply: any) => reply.status === 'delivered'));
  await c.ingest([message('4')], 'c3', 'c2');
  const fresh = (await c.ok('wechat_bridge_status')).session;
  assert.notEqual(fresh.session_id, session.session_id); assert.equal(fresh.state, 'waking');
});

test('concurrent independent replies enqueue separate jobs and claim each once in queue order', async t => {
  const c = await fixture(t); await c.start(); await c.ingest([message('1')], 'c1');
  const session = await c.session(); const ids = (await c.ok('wechat_read_messages', sessionArgs(session))).messages.map((m: any) => m.sequence);
  const args = { ...sessionArgs(session), message_ids: ids, text: 'one reply', wait_ms: 0 };
  const results = await Promise.all(['a', 'b'].map(key => c.tool('wechat_send_reply', { ...args, idempotency_key: key })));
  assert.ok(results.every(result => !result.isError), JSON.stringify(results));
  const saved = await c.rows("SELECT id FROM jobs WHERE kind='reply' ORDER BY sequence");
  assert.equal(saved.length, 2);
  assert.equal(new Set(results.map(result => result.structuredContent.reply_id)).size, 2);
  const first = await c.jobs(); assert.deepEqual(first.map(job => job.id), [saved[0].id]);
  assert.equal((await c.jobs()).length, 0); await c.complete(first[0]);
  const second = await c.jobs(); assert.deepEqual(second.map(job => job.id), [saved[1].id]);
  assert.equal((await c.jobs()).length, 0); await c.complete(second[0]);
  assert.equal((await c.jobs()).length, 0);
});

test('send timeout and failure reasons are visible; unknown result blocks following sends until explicit resolution', async t => {
  const c = await fixture(t); await c.start(); await c.ingest([message('1'), message('2')], 'c1');
  const session = await c.session(), auth = sessionArgs(session);
  const rows = (await c.ok('wechat_read_messages', auth)).messages;
  for (const row of rows) await c.ok('wechat_send_reply', { ...auth, message_ids: [row.sequence], text: 'reply', idempotency_key: `key${row.sequence}`, wait_ms: 0 });
  const job = (await c.jobs())[0];
  await c.complete(job, { outcome: 'unknown', error_code: 'send_timeout', error_message: '微信发送请求超时（30 秒），未收到结果' });
  const status = await c.ok('wechat_bridge_status');
  assert.equal(status.delivery_issues[0].status_text, '发送超时');
  assert.match(status.delivery_issues[0].error_message, /30 秒/);
  assert.equal((await c.jobs()).length, 0);
  assert.equal(errorOf(await c.tool('wechat_resolve_reply', { reply_id: job.id, action: 'retry' })), 'duplicate_risk_confirmation_required');
  await c.ok('wechat_resolve_reply', { reply_id: job.id, action: 'skip' });
  const next = (await c.jobs())[0];
  await c.complete(next, { outcome: 'failed', error_code: 'credential_expired', error_message: '微信登录凭据已失效，需要重新扫码绑定' });
  const issue = (await c.ok('wechat_read_history')).replies.find((r: any) => r.reply_id === next.id);
  assert.equal(issue.status_text, '发送失败'); assert.match(issue.error_message, /重新扫码/);
});

test('expired leases recover persisted pending messages; end and new input never strand an ended session', async t => {
  const c = await fixture(t); await c.start(); await c.ingest([message('1')], 'c1');
  const session = await c.session(), auth = sessionArgs(session);
  assert.equal(errorOf(await c.tool('wechat_recover_session')), 'session_is_active');
  await c.run('UPDATE conversation SET lease_until=0');
  assert.equal(errorOf(await c.tool('wechat_read_messages', auth)), 'session_lease_invalid');
  const recovery = await c.ok('wechat_recover_session'); assert.notEqual(recovery.session.session_id, session.session_id);
  const resumed = await c.session('replacement-dot'); assert.equal((await c.ok('wechat_read_messages', sessionArgs(resumed))).messages.length, 1);
  await c.ok('wechat_send_reply', { ...sessionArgs(resumed), message_ids: [1], text: 'reply', idempotency_key: 'after-recover', wait_ms: 0 });
  await c.complete((await c.jobs())[0]);
  await Promise.all([c.ok('wechat_end_session', sessionArgs(resumed)), c.ingest([message('2')], 'c2', 'c1')]);
  const state = (await c.ok('wechat_bridge_status')).session;
  assert.ok(['active', 'waking'].includes(state.state));
  assert.equal((await c.rows("SELECT * FROM messages WHERE status='pending'")).length, 1);
});

test('concurrent uses of one idempotency key require identical payloads', async t => {
  const c = await fixture(t); await c.start(); await c.ingest([message('1')], 'c1');
  const session = await c.session();
  const args = { ...sessionArgs(session), message_ids: [1], idempotency_key: 'same-key', wait_ms: 0 };
  const repeated = await Promise.all([c.tool('wechat_send_reply', { ...args, text: 'same text' }),
    c.tool('wechat_send_reply', { ...args, text: 'same text' })]);
  assert.ok(repeated.every(result => !result.isError));
  assert.equal(repeated[0].structuredContent.reply_id, repeated[1].structuredContent.reply_id);
  await c.ingest([message('2')], 'c2', 'c1');
  const contenderArgs = { ...args, message_ids: [2], idempotency_key: 'different-text-same-key' };
  const contenders = await Promise.all(['first text', 'different text'].map(text => c.tool('wechat_send_reply', { ...contenderArgs, text })));
  assert.equal(contenders.filter(result => !result.isError).length, 1);
  assert.equal(errorOf(contenders.find(result => result.isError)), 'idempotency_conflict');
});

test('a missing WeChat context reports the actual failure and retains the pending message', async t => {
  const c=await fixture(t);await c.start();await c.ingest([message('no-context','hello',{context_token:''})],'c1');
  const session=await c.session();
  const result=await c.tool('wechat_send_reply',{...sessionArgs(session),message_ids:[1],text:'reply',idempotency_key:'no-context',wait_ms:0});
  assert.equal(result.isError,true);assert.equal(result.structuredContent.status_text,'发送失败');
  assert.match(result.structuredContent.error_message,/缺少微信回复上下文/);
  assert.equal((await c.rows("SELECT * FROM messages WHERE status='pending'")).length,1);
  assert.equal((await c.rows("SELECT * FROM jobs WHERE kind='reply'")).length,0);
});
