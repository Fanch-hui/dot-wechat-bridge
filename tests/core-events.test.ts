import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Webhook } from 'standardwebhooks';
import { fixture, eventually, message, sessionArgs, sleep, type Client } from './helpers.ts';
import type { GatewayJob, WebhookJob } from '../src/shared/contracts.ts';

const secret = 'whsec_' + Buffer.alloc(32, 4).toString('base64');
const replacement = 'whsec_' + Buffer.alloc(32, 5).toString('base64');
const params = (signingSecret = secret, ttlMs = 60_000) => ({ name: 'wechat.message.available', arguments: { conversation: 'personal' },
  delivery: { mode: 'webhook', url: 'https://callback.example/events', secret: signingSecret }, ttlMs });
function verify(job: GatewayJob, signingSecret = secret) {
  assert.equal(job.kind, 'webhook');
  const webhook = job as WebhookJob;
  assert.ok(!webhook.payload.body.includes('context_token'));
  return new Webhook(signingSecret).verify(webhook.payload.body, webhook.payload.headers) as any;
}
async function subscribe(c: Client, signingSecret = secret, ttlMs = 60_000, challengeMatches = true) {
  const pending = c.rpc('events/subscribe', params(signingSecret, ttlMs));
  const jobs = await eventually(() => c.jobs(), jobs => jobs.length > 0);
  const payload = verify(jobs[0], signingSecret); assert.equal(payload.type, 'verification');
  await c.complete(jobs[0], { challenge: challengeMatches ? payload.challenge : 'wrong' });
  const result = await pending;
  return result;
}
async function wake(c: Client) {
  assert.equal((await c.service('tick')).status, 200);
  return c.jobs();
}

test('MCP subscribe verifies signed actual bytes; encryption, TTL refresh, rotation dual signatures and unsubscribe', async t => {
  const c = await fixture(t); await c.start();
  const subscribed = await subscribe(c); assert.equal(subscribed.status, 200);
  const id = subscribed.body.result.id;
  const saved = (await c.rows('SELECT * FROM subscriptions'))[0];
  assert.equal(saved.state, 'active'); assert.ok(!saved.secret_cipher.includes(secret));
  assert.ok(!saved.url_cipher.includes('callback.example'));
  const firstExpires = saved.expires_at;
  const refresh = await c.rpc('events/subscribe', params(secret, 120_000));
  assert.equal(refresh.body.result.id, id); assert.equal((await c.jobs()).length, 0);
  assert.ok((await c.rows('SELECT * FROM subscriptions'))[0].expires_at > firstExpires);
  const rotated = await subscribe(c, replacement); assert.equal(rotated.body.result.id, id);
  await c.ingest([message('1')], 'c1');
  const jobs = await wake(c); assert.equal(jobs.length, 1);
  const event = verify(jobs[0], replacement); assert.equal(verify(jobs[0], secret).eventId, event.eventId);
  assert.equal(event.name, 'wechat.message.available'); assert.equal(event.data.pending_count, 1);
  const changedBody = jobs[0] as WebhookJob;
  assert.throws(() => new Webhook(secret).verify(changedBody.payload.body + ' ', changedBody.payload.headers));
  assert.equal((await c.rpc('events/unsubscribe', params(replacement))).status, 200);
  assert.equal((await c.rows('SELECT state FROM subscriptions'))[0].state, 'revoked');
  await c.complete(jobs[0]);
  await c.run('UPDATE conversation SET wake_deadline=0'); assert.equal((await wake(c)).length, 0);
});

test('verification rejects incorrect challenge and expires subscriptions without a replay promise', async t => {
  const c = await fixture(t); await c.start();
  const rejected = await subscribe(c, secret, 1000, false);
  assert.equal(rejected.body.error.code, -32015); assert.equal(rejected.body.error.data.reason, 'challenge_failed');
  const replay = await c.rpc('events/subscribe', { ...params(), cursor: 'older-event' });
  assert.equal(replay.body.error.message, 'event_replay_not_supported');
  const active = await subscribe(c, secret, 1000); assert.equal(active.status, 200);
  await sleep(1050); await c.ingest([message('1')], 'c1');
  assert.equal((await wake(c)).length, 0);
  assert.equal((await c.rows('SELECT state FROM subscriptions'))[0].state, 'expired');
});

test('wake retries stop at configured cap; one claim prevents further wakes across rounds and recover restarts', async t => {
  const c = await fixture(t, { MAX_WAKE_ATTEMPTS: '2', WAKE_TIMEOUT_MS: '1000' }); await c.start();
  await subscribe(c); await c.ingest([message('1')], 'c1');
  const first = (await wake(c))[0], firstEvent = verify(first); await c.complete(first);
  assert.equal((await wake(c)).length, 0);
  await sleep(1050);
  const second = (await wake(c))[0], secondEvent = verify(second); await c.complete(second);
  assert.equal(firstEvent.data.session_id, secondEvent.data.session_id); assert.equal(secondEvent.data.attempt, 2);
  await sleep(1050); assert.equal((await wake(c)).length, 0);
  assert.equal((await c.ok('wechat_bridge_status')).session.state, 'wake_failed');
  const recovered = await c.ok('wechat_recover_session'); assert.equal(recovered.session.state, 'waking');
  const pendingWake = (await wake(c))[0]; assert.ok(pendingWake);
  const session = await c.session(); await c.complete(pendingWake);
  await c.ingest([message('2')], 'c2', 'c1');
  assert.equal((await wake(c)).length, 0);
  assert.equal((await c.ok('wechat_read_messages', sessionArgs(session))).messages.length, 2);
});

test('410 revokes; 413 drops a delivery; retryable webhook failures obey bounded retries', async t => {
  const c = await fixture(t, { MAX_DELIVERY_ATTEMPTS: '2' }); await c.start(); await subscribe(c);
  await c.ingest([message('1')], 'c1');
  let job = (await wake(c))[0]; await c.complete(job, { outcome: 'retryable', http_status: 503, error_code: 'callback_unavailable' });
  assert.equal((await c.jobs()).length, 0); await sleep(1050);
  job = (await c.jobs())[0]; assert.ok(job); await c.complete(job, { outcome: 'retryable', http_status: 503 });
  assert.equal((await c.rows('SELECT state,attempts FROM jobs WHERE id=?', [job.id]))[0].state, 'failed');
  assert.equal((await c.rows('SELECT attempts FROM jobs WHERE id=?', [job.id]))[0].attempts, 2);
  await c.run('UPDATE conversation SET wake_deadline=0');
  job = (await wake(c))[0]; await c.complete(job, { outcome: 'retryable', http_status: 413 });
  assert.equal((await c.rows('SELECT state FROM jobs WHERE id=?', [job.id]))[0].state, 'failed');
  assert.equal((await c.rows('SELECT state FROM subscriptions'))[0].state, 'active');
  await c.run('UPDATE conversation SET wake_deadline=0');
  job = (await wake(c))[0]; await c.complete(job, { outcome: 'retryable', http_status: 410 });
  assert.equal((await c.rows('SELECT state FROM subscriptions'))[0].state, 'revoked');
  assert.equal((await c.rows('SELECT state FROM jobs WHERE id=?', [job.id]))[0].state, 'failed');
});

test('concurrent ticks emit one wake; lost relay claim retries webhook while lost reply claim stays unknown', async t => {
  const c = await fixture(t, { JOB_LEASE_MS: '1000' }); await c.start(); await subscribe(c);
  await c.ingest([message('1')], 'c1');
  await Promise.all([c.service('tick'), c.service('tick')]);
  assert.equal((await c.rows("SELECT * FROM jobs WHERE purpose='wake'")).length, 1);
  const first = (await c.jobs())[0]; await sleep(1050);
  const second = (await c.jobs())[0]; assert.equal(second.id, first.id); assert.notEqual(second.claim_token, first.claim_token);
  const stale = await c.service('complete', { job_id: first.id, claim_token: first.claim_token, outcome: 'delivered' });
  assert.equal(stale.body.error, 'job_claim_invalid'); await c.complete(second);
  const session = await c.session();
  await c.ok('wechat_send_reply', { ...sessionArgs(session), message_ids: [1], text: 'reply', idempotency_key: 'lease-loss', wait_ms: 0 });
  const reply = (await c.jobs())[0]; await sleep(1050); assert.equal((await c.jobs()).length, 0);
  const issue = (await c.ok('wechat_bridge_status')).delivery_issues[0];
  assert.equal(issue.reply_id, reply.id); assert.equal(issue.status, 'unknown'); assert.match(issue.error_message, /中断/);
});

test('subscription validation and a callback verification timeout return actionable errors', async t => {
  const c = await fixture(t, { VERIFY_WAIT_MS: '1000' }); await c.start();
  const unsupported = await c.rpc('events/subscribe', { ...params(), arguments: { conversation: 'group' } });
  assert.equal(unsupported.body.error.message, 'invalid_event_filter');
  const invalidUrl = await c.rpc('events/subscribe', { ...params(), delivery: { ...params().delivery, url: 'http://callback.example' } });
  assert.equal(invalidUrl.body.error.message, 'invalid_callback_url');
  const invalidSecret = await c.rpc('events/subscribe', params('whsec_dG9vLXNob3J0'));
  assert.equal(invalidSecret.body.error.message, 'invalid_signing_secret');
  const timeout = await c.rpc('events/subscribe', params());
  assert.equal(timeout.body.error.code, -32015); assert.equal(timeout.body.error.data.reason, 'timeout');
  assert.equal((await c.jobs()).length, 0);
  assert.equal((await c.rows("SELECT state FROM jobs WHERE purpose='verification'"))[0].state, 'cancelled');
});
