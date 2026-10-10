import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, message, sessionArgs, type Client } from './helpers.ts';

const send = (key: string, text = '主动消息') => ({ idempotency_key: key, text, wait_ms: 0 });
const errorOf = (result: any) => result.structuredContent.error;
const incomingState = async (c: Client) => ({
  messages: await c.rows('SELECT * FROM messages ORDER BY sequence'),
  conversation: await c.rows('SELECT * FROM conversation'),
});

test('proactive send requires owner authorization and a binding, but no incoming message or session', async t => {
  const c = await fixture(t);
  await c.ok('wechat_bridge_status');
  assert.equal(errorOf(await c.tool('wechat_send_message', send('unbound'))), 'wechat_not_bound');
  assert.equal((await c.rows("SELECT * FROM jobs WHERE kind='reply'")).length, 0);
  await c.start();
  const args = { name: 'wechat_send_message', arguments: send('first') };
  assert.equal((await c.rpc('tools/call', args, null)).status, 401);
  assert.equal((await c.rpc('tools/call', args, null, true, { Authorization: 'Bearer test-service-token' })).status, 401);
  assert.equal((await c.rpc('tools/call', args, 'other-user')).status, 403);
  assert.equal(errorOf(await c.tool('wechat_send_message', { ...send('foreign'), to_user_id: 'stranger' })), 'invalid_arguments');
  const before = await incomingState(c);
  const queued = await c.ok('wechat_send_message', send('first'));
  assert.equal(queued.status, 'ready');
  const [job] = await c.jobs();
  assert.equal(job.id, queued.reply_id); assert.equal(job.kind, 'reply');
  if (job.kind === 'reply') {
    assert.equal(job.payload.to_user_id, 'self-wechat');
    assert.equal(job.payload.text, '主动消息');
    assert.equal(job.payload.context_token, '');
  }
  assert.deepEqual(await c.rows('SELECT kind,purpose,session_id,message_ids FROM jobs'),
    [{ kind: 'reply', purpose: 'send', session_id: null, message_ids: '[]' }]);
  await c.complete(job);
  const delivered = await c.ok('wechat_send_message', send('first'));
  assert.equal(delivered.reply_id, queued.reply_id); assert.equal(delivered.status, 'delivered');
  assert.equal((await c.jobs()).length, 0);
  assert.deepEqual(await incomingState(c), before);
  const history = await c.ok('wechat_read_history');
  assert.equal(history.replies[0].purpose, 'send');
  assert.deepEqual(history.replies[0].message_ids, []);
});

test('proactive send uses the latest owner context and preserves pending messages and an active lease', async t => {
  const c = await fixture(t); await c.start();
  await c.ingest([message('older', 'old', { occurred_at: Date.now() + 1000 }),
    message('latest', 'new', { occurred_at: Date.now() - 1000 }),
    message('stranger', '', { sender: 'stranger', context_token: 'foreign-context' }),
    message('group', '', { group_id: 'group', context_token: 'group-context' })], 'c1');
  await c.session();
  const before = await incomingState(c);
  const queued = await c.ok('wechat_send_message', send('active'));
  const [job] = await c.jobs(); assert.equal(job.id, queued.reply_id);
  if (job.kind === 'reply') assert.equal(job.payload.context_token, 'context latest');
  assert.deepEqual(await incomingState(c), before);
  await c.complete(job);
  assert.deepEqual(await incomingState(c), before);
  const history = await c.ok('wechat_read_history');
  assert.equal(history.replies[0].reply_id, queued.reply_id);
  assert.equal(history.replies[0].purpose, 'send');
  assert.deepEqual(history.replies[0].message_ids, [2]);
});

test('ended and expired sessions do not prevent sending and retain their exact persisted state', async t => {
  const c = await fixture(t); await c.start(); await c.ingest([message('1')], 'c1');
  const auth = sessionArgs(await c.session());
  await c.ok('wechat_send_reply', { ...auth, message_ids: [1], ...send('normal') });
  await c.complete((await c.jobs())[0]);
  assert.equal((await c.ok('wechat_end_session', auth)).ended, true);
  const ended = await incomingState(c);
  await c.ok('wechat_send_message', send('ended'));
  await c.complete((await c.jobs())[0]);
  assert.deepEqual(await incomingState(c), ended);
  await c.ingest([message('2')], 'c2', 'c1'); await c.session('replacement-dot');
  await c.run('UPDATE conversation SET lease_until=0');
  const expired = await incomingState(c);
  await c.ok('wechat_send_message', send('expired'));
  const [job] = await c.jobs();
  if (job.kind === 'reply') assert.equal(job.payload.context_token, 'context 2');
  await c.complete(job);
  assert.deepEqual(await incomingState(c), expired);
});

test('concurrent retries create one proactive job and context changes never resend its idempotency key', async t => {
  const c = await fixture(t); await c.start(); await c.ingest([message('1')], 'c1');
  const args = send('same-key');
  const retries = await Promise.all([c.ok('wechat_send_message', args), c.ok('wechat_send_message', args)]);
  assert.equal(retries[0].reply_id, retries[1].reply_id);
  assert.equal((await c.rows("SELECT * FROM jobs WHERE kind='reply'")).length, 1);
  await c.complete((await c.jobs())[0]);
  await c.ingest([message('2')], 'c2', 'c1');
  const repeated = await c.ok('wechat_send_message', args);
  assert.equal(repeated.reply_id, retries[0].reply_id); assert.equal(repeated.status, 'delivered');
  assert.equal((await c.jobs()).length, 0);
  assert.equal(errorOf(await c.tool('wechat_send_message', { ...args, text: '不同正文' })), 'idempotency_conflict');
  const contenders = await Promise.all(['one', 'two'].map(text => c.tool('wechat_send_message', send('contested', text))));
  assert.equal(contenders.filter(result => !result.isError).length, 1);
  assert.equal(errorOf(contenders.find(result => result.isError)), 'idempotency_conflict');
  const [job] = await c.jobs();
  if (job.kind === 'reply') assert.equal(job.payload.context_token, 'context 2');
  assert.equal((await c.rows("SELECT * FROM jobs WHERE kind='reply'")).length, 2);
});

test('proactive messages and session replies share a single ordered queue', async t => {
  const c = await fixture(t); await c.start(); await c.ingest([message('1')], 'c1');
  const auth = sessionArgs(await c.session());
  const first = await c.ok('wechat_send_message', send('before-reply', '提醒'));
  const reply = await c.ok('wechat_send_reply', { ...auth, message_ids: [1], ...send('reply', '回应') });
  const last = await c.ok('wechat_send_message', send('after-reply', '补充提醒'));
  for (const id of [first.reply_id, reply.reply_id, last.reply_id]) {
    const jobs = await c.jobs(); assert.deepEqual(jobs.map(job => job.id), [id]);
    assert.equal((await c.jobs()).length, 0); await c.complete(jobs[0]);
  }
  assert.deepEqual(await c.rows('SELECT status,reply_id FROM messages'), [{ status: 'replied', reply_id: reply.reply_id }]);
  assert.equal((await c.jobs()).length, 0);
});

test('failed and unknown proactive sends retain incoming state and reuse explicit queue recovery', async t => {
  const c = await fixture(t); await c.start(); await c.ingest([message('1')], 'c1'); await c.session();
  const before = await incomingState(c);
  const failed = await c.ok('wechat_send_message', send('failed'));
  const unknown = await c.ok('wechat_send_message', send('unknown'));
  const after = await c.ok('wechat_send_message', send('after-recovery'));
  let [job] = await c.jobs(); assert.equal(job.id, failed.reply_id);
  await c.complete(job, { outcome: 'failed', error_code: 'ilink_error_42', error_message: '微信请求失败（42）：拒绝发送' });
  const failure = await c.ok('wechat_send_message', send('failed'));
  assert.equal(failure.status, 'failed'); assert.equal(failure.status_text, '发送失败');
  assert.match(failure.error_message, /拒绝发送/);
  assert.equal((await c.jobs()).length, 0);
  await c.ok('wechat_resolve_reply', { reply_id: failed.reply_id, action: 'retry' });
  [job] = await c.jobs(); assert.equal(job.id, failed.reply_id); await c.complete(job);
  [job] = await c.jobs(); assert.equal(job.id, unknown.reply_id);
  await c.complete(job, { outcome: 'unknown', error_code: 'send_timeout', error_message: '发送超时' });
  const timeout = await c.ok('wechat_send_message', send('unknown'));
  assert.equal(timeout.status, 'unknown'); assert.equal(timeout.status_text, '发送超时');
  assert.equal((await c.jobs()).length, 0);
  assert.equal(errorOf(await c.tool('wechat_resolve_reply', { reply_id: unknown.reply_id, action: 'retry' })),
    'duplicate_risk_confirmation_required');
  await c.ok('wechat_resolve_reply', { reply_id: unknown.reply_id, action: 'skip' });
  [job] = await c.jobs(); assert.equal(job.id, after.reply_id); await c.complete(job);
  assert.deepEqual(await incomingState(c), before);
});
