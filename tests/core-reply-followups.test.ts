import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fixture, message, sessionArgs } from './helpers.ts';
import { Bridge } from '../src/core/bridge.ts';

const errorOf = (result: any) => result.structuredContent.error;
const send = (auth: Record<string, unknown>, key: string, text: string, ids = [1]) => ({
  ...auth, message_ids: ids, idempotency_key: key, text, wait_ms: 0,
});

test('one incoming message accepts independent replies before and after delivery in the same active session', async t => {
  const c = await fixture(t); await c.start(); await c.ingest([message('1')], 'c1');
  const auth = sessionArgs(await c.session());
  const first = await c.ok('wechat_send_reply', send(auth, 'reply-first', '我查一下'));
  const second = await c.ok('wechat_send_reply', send(auth, 'reply-second', '结果一'));
  assert.notEqual(first.reply_id, second.reply_id);
  const jobs = await c.jobs(); assert.deepEqual(jobs.map(job => job.id), [first.reply_id]);
  assert.equal((await c.jobs()).length, 0); await c.complete(jobs[0]);
  const third = await c.ok('wechat_send_reply', send(auth, 'reply-third', '补充结果二'));
  assert.equal((await c.rows('SELECT status FROM messages'))[0].status, 'reply_queued');
  const next = (await c.jobs())[0]; assert.equal(next.id, second.reply_id); await c.complete(next);
  assert.equal((await c.rows('SELECT status FROM messages'))[0].status, 'reply_queued');
  const last = (await c.jobs())[0]; assert.equal(last.id, third.reply_id); await c.complete(last);
  assert.equal((await c.rows('SELECT status FROM messages'))[0].status, 'replied');
  const afterDelivery = await c.ok('wechat_send_reply', send(auth, 'reply-after-delivery', '发送后补充'));
  const afterJob = (await c.jobs())[0]; assert.equal(afterJob.id, afterDelivery.reply_id);
  await c.complete(afterJob);
  assert.equal((await c.rows('SELECT status FROM messages'))[0].status, 'replied');
  const history = await c.ok('wechat_read_history');
  assert.deepEqual(history.replies.map((reply: any) => reply.text), ['我查一下', '结果一', '补充结果二', '发送后补充']);
  assert.ok(history.replies.every((reply: any) => reply.message_ids[0] === 1));
  assert.equal((await c.ok('wechat_bridge_status')).session.state, 'active');
  await c.ok('wechat_heartbeat', auth);
  assert.equal((await c.ok('wechat_end_session', auth)).ended, true);
  await c.ingest([message('2')], 'c2', 'c1');
  const fresh = sessionArgs(await c.session('next-dot'));
  assert.equal((await c.tool('wechat_send_reply', send(fresh, 'foreign-session', 'old message'))).isError, true);
  assert.equal((await c.rows("SELECT count(*) AS n FROM jobs WHERE kind='reply'"))[0].n, 4);
});

test('idempotency requires the same incoming ids and output text', async t => {
  const c = await fixture(t); await c.start(); await c.ingest([message('1'), message('2')], 'c1');
  const auth = sessionArgs(await c.session());
  const args = send(auth, 'first-output-key', '处理中');
  const reply = await c.ok('wechat_send_reply', args);
  assert.equal((await c.ok('wechat_send_reply', args)).reply_id, reply.reply_id);
  for (const patch of [{ text: 'changed' }, { message_ids: [2] }]) {
    assert.equal(errorOf(await c.tool('wechat_send_reply', { ...args, ...patch })), 'idempotency_conflict');
  }
  const next = await c.ok('wechat_send_reply', send(auth, 'next-output-key', '结果'));
  assert.notEqual(next.reply_id, reply.reply_id);
  assert.equal((await c.rows("SELECT count(*) AS n FROM jobs WHERE kind='reply'"))[0].n, 2);
});

test('unknown or failed outputs block the queue until skipped and permit later output for the same incoming message', async t => {
  const c = await fixture(t); await c.start(); await c.ingest([message('1')], 'c1');
  const auth = sessionArgs(await c.session());
  for (const outcome of ['unknown', 'failed'] as const) {
    const queued = await c.ok('wechat_send_reply', send(auth, outcome, `output ${outcome}`));
    const job = (await c.jobs())[0]; assert.equal(job.id, queued.reply_id);
    await c.complete(job, { outcome, error_code: outcome === 'unknown' ? 'send_timeout' : 'wechat_failed' });
    assert.equal((await c.rows('SELECT status FROM messages'))[0].status, 'reply_queued');
    assert.equal((await c.jobs()).length, 0);
    await c.ok('wechat_resolve_reply', { reply_id: job.id, action: 'skip' });
    assert.equal((await c.rows('SELECT status FROM messages'))[0].status, 'skipped');
  }
  const next = await c.ok('wechat_send_reply', send(auth, 'after-skip', '结果'));
  const nextJob = (await c.jobs())[0]; assert.equal(nextJob.id, next.reply_id); await c.complete(nextJob);
  assert.equal((await c.rows('SELECT status FROM messages'))[0].status, 'replied');
  assert.equal((await c.ok('wechat_end_session', auth)).ended, true);
});

test('multiple outputs retain order and idempotency across Worker and D1 restart', async t => {
  const c = await fixture(t, {}, true); await c.start(); await c.ingest([message('1'), message('2')], 'c1');
  const session = await c.session(), auth = sessionArgs(session);
  const first = await c.ok('wechat_send_reply', send(auth, 'restart-first', '处理中'));
  await c.complete((await c.jobs())[0]);
  const second = await c.ok('wechat_send_reply', send(auth, 'restart-second', '结果'));
  await c.restart();
  const lease = await c.service('lease'); c.gateway.lease_token = lease.body.lease_token;
  assert.equal((await c.ok('wechat_send_reply', send(auth, 'restart-first', '处理中'))).reply_id, first.reply_id);
  assert.equal((await c.ok('wechat_send_reply', send(auth, 'restart-second', '结果'))).reply_id, second.reply_id);
  const secondJob = (await c.jobs())[0]; assert.equal(secondJob.id, second.reply_id); await c.complete(secondJob);
  const third = await c.ok('wechat_send_reply', send(auth, 'restart-third', '补充'));
  const thirdJob = (await c.jobs())[0]; assert.equal(thirdJob.id, third.reply_id); await c.complete(thirdJob);
  assert.deepEqual((await c.ok('wechat_read_messages', auth)).messages.map((row: any) => row.sequence), [2]);
  await c.run('UPDATE conversation SET lease_until=0');
  await c.ok('wechat_recover_session');
  const recovered = await c.session('replacement-dot'); assert.notEqual(recovered.session_id, session.session_id);
  assert.equal((await c.tool('wechat_send_reply', send(sessionArgs(recovered), 'stale-message', '旧消息'))).isError, true);
  const next = await c.ok('wechat_send_reply', send(sessionArgs(recovered), 'recovered-output', '下一条结果', [2]));
  const job = (await c.jobs())[0]; assert.equal(job.id, next.reply_id); await c.complete(job);
  const history = await c.ok('wechat_read_history');
  assert.deepEqual(history.replies.map((reply: any) => [reply.text, reply.message_ids]),
    [['处理中', [1]], ['结果', [1]], ['补充', [1]], ['下一条结果', [2]]]);
});

test('acknowledgments for earlier outputs cannot mark a newer queued output as delivered', async t => {
  const c = await fixture(t); await c.start(); await c.ingest([message('1')], 'c1');
  const auth = sessionArgs(await c.session());
  const first = await c.ok('wechat_send_reply', send(auth, 'first-output', '处理中'));
  const firstJob = (await c.jobs())[0]; assert.equal(firstJob.id, first.reply_id);
  const second = await c.ok('wechat_send_reply', send(auth, 'second-output', '结果一'));
  const third = await c.ok('wechat_send_reply', send(auth, 'third-output', '结果二'));
  await c.complete(firstJob);
  assert.equal((await c.rows('SELECT status FROM messages'))[0].status, 'reply_queued');
  const older = (await c.jobs())[0]; assert.equal(older.id, second.reply_id); await c.complete(older);
  assert.equal((await c.rows('SELECT status FROM messages'))[0].status, 'reply_queued');
  await c.complete(firstJob); await c.complete(older);
  assert.equal((await c.rows('SELECT status FROM messages'))[0].status, 'reply_queued');
  const latest = (await c.jobs())[0]; assert.equal(latest.id, third.reply_id); await c.complete(latest);
  assert.equal((await c.rows('SELECT status FROM messages'))[0].status, 'replied');
});


test('a delayed concurrent retry cannot replace a newer delivered output pointer', async t => {
  const c = await fixture(t); await c.start(); await c.ingest([message('1')], 'c1');
  const session = await c.session(), auth = sessionArgs(session);
  const realDb = await c.db() as unknown as D1Database;
  let notifyEntered!: () => void, releaseBatch!: () => void;
  const entered = new Promise<void>(resolve => { notifyEntered = resolve; });
  const released = new Promise<void>(resolve => { releaseBatch = resolve; });
  t.after(() => releaseBatch());
  // Delay scheduling only: both statements and their result execute against the real D1 database.
  const delayedDb = new Proxy(realDb, { get(target, property) {
    if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
      notifyEntered(); await released; return target.batch(statements);
    };
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const bridge = new Bridge({ DB: delayedDb, DATA_KEY_B64: Buffer.alloc(32, 7).toString('base64') });
  const delayed = bridge.messages.reply(session.session_id, session.lease_token, [1], 'delayed-key', 'first', Date.now());
  await entered;
  const first = await c.ok('wechat_send_reply', send(auth, 'delayed-key', 'first'));
  const newer = await c.ok('wechat_send_reply', send(auth, 'newer-output', 'second'));
  const firstJob = (await c.jobs())[0]; assert.equal(firstJob.id, first.reply_id); await c.complete(firstJob);
  const latestJob = (await c.jobs())[0]; assert.equal(latestJob.id, newer.reply_id); await c.complete(latestJob);
  assert.deepEqual(await c.rows('SELECT status,reply_id FROM messages'), [{ status: 'replied', reply_id: newer.reply_id }]);
  releaseBatch();
  assert.equal((await delayed).reply_id, first.reply_id);
  assert.deepEqual(await c.rows('SELECT status,reply_id FROM messages'), [{ status: 'replied', reply_id: newer.reply_id }]);
  assert.equal((await c.rows("SELECT count(*) AS n FROM jobs WHERE kind='reply'"))[0].n, 2);
});


test('D1 upgrade retains queued and delivered output records and restores the latest incoming links', async t => {
  const c = await fixture(t); await c.start(); await c.ingest([message('1'), message('2')], 'c1');
  const auth = sessionArgs(await c.session());
  const first = await c.ok('wechat_send_reply', send(auth, 'upgrade-first', '第一条回应'));
  await c.complete((await c.jobs())[0]);
  const second = await c.ok('wechat_send_reply', send(auth, 'upgrade-second', '第二条回应', [2]));
  await c.complete((await c.jobs())[0]);
  const queued = await c.ok('wechat_send_reply', send(auth, 'upgrade-queued', '第一条补充'));
  await c.run('ALTER TABLE jobs ADD COLUMN is_final integer NOT NULL DEFAULT 1');
  await c.run("UPDATE messages SET reply_id=?, status='replied' WHERE sequence=1", [first.reply_id]);
  await c.run("UPDATE messages SET reply_id=NULL, status='pending' WHERE sequence=2");
  const columns = 'id,sequence,state,payload_cipher,message_ids,session_id,available_at,created_at';
  const saved = await c.rows(`SELECT ${columns} FROM jobs ORDER BY sequence`);
  for (const statement of (await readFile('drizzle/0003_multiple_replies.sql', 'utf8')).split('--> statement-breakpoint')) {
    if (statement.trim()) await c.run(statement);
  }
  assert.deepEqual(await c.rows(`SELECT ${columns} FROM jobs ORDER BY sequence`), saved);
  assert.deepEqual(await c.rows('SELECT sequence,status,reply_id FROM messages ORDER BY sequence'), [
    { sequence: 1, status: 'reply_queued', reply_id: queued.reply_id },
    { sequence: 2, status: 'replied', reply_id: second.reply_id },
  ]);
  const appended = await c.ok('wechat_send_reply', send(auth, 'upgrade-appended', '再次补充'));
  const queuedJob = (await c.jobs())[0]; assert.equal(queuedJob.id, queued.reply_id); await c.complete(queuedJob);
  assert.equal((await c.rows('SELECT status FROM messages WHERE sequence=1'))[0].status, 'reply_queued');
  const appendedJob = (await c.jobs())[0]; assert.equal(appendedJob.id, appended.reply_id); await c.complete(appendedJob);
  assert.deepEqual(await c.rows('SELECT status,reply_id FROM messages WHERE sequence=1'),
    [{ status: 'replied', reply_id: appended.reply_id }]);
  assert.equal((await c.ok('wechat_read_history')).replies.length, 4);
});
