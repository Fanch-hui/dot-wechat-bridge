import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.ts';

test('real Worker supports MCP 2 discovery, event catalog, headers and v1 initialization', async t => {
  const c = await fixture(t);
  const discovery = await c.rpc('server/discover');
  assert.equal(discovery.status, 200); assert.equal(discovery.body.result.resultType, 'complete');
  assert.deepEqual(discovery.body.result.capabilities, { tools: {}, events: {}, resources: {} });
  assert.equal((await c.rpc('events/list')).body.result.events[0].name, 'wechat.message.available');
  const tools = (await c.rpc('tools/list')).body.result.tools;
  assert.equal(tools.length, 13);
  const media = tools.find((tool: any) => tool.name === 'wechat_send_media');
  assert.deepEqual(media.inputSchema.required, ['kind', 'name', 'idempotency_key']);
  assert.equal(media.annotations.idempotentHint, true);
  assert.equal(media.annotations.readOnlyHint, false);
  const proactive = tools.find((tool: any) => tool.name === 'wechat_send_message');
  assert.deepEqual(proactive.inputSchema.required, ['text', 'idempotency_key']);
  assert.deepEqual(Object.keys(proactive.inputSchema.properties).sort(), ['idempotency_key', 'participant_id', 'text', 'wait_ms']);
  assert.equal(proactive.inputSchema.additionalProperties, false);
  assert.deepEqual(proactive.inputSchema.properties.wait_ms, { type: 'integer', minimum: 0, maximum: 25000 });
  const mismatch = await c.rpc('tools/list', {}, 'owner', true, { 'Mcp-Method': 'ping' });
  assert.equal(mismatch.body.error.code, -32020);
  const wrongName = await c.rpc('tools/call', { name: 'wechat_bridge_status', arguments: {} }, 'owner', true, { 'Mcp-Name': 'wrong' });
  assert.equal(wrongName.body.error.code, -32020);
  const missingMeta = await c.post('/mcp', { jsonrpc: '2.0', id: 1, method: 'server/discover' });
  assert.equal(missingMeta.body.error.code, -32022);
  const legacy = await c.rpc('initialize', { protocolVersion: '2025-06-18' }, null, false);
  assert.equal(legacy.body.result.protocolVersion, '2025-06-18');
  assert.equal(legacy.body.result.resultType, undefined);
  assert.equal((await c.post('/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
});

test('owner-only MCP never accepts the service credential as user identity', async t => {
  const c = await fixture(t);
  const args = { name: 'wechat_bridge_status', arguments: {} };
  assert.equal((await c.rpc('tools/call', args, null)).status, 401);
  assert.equal((await c.rpc('tools/call', args, null, true, { Authorization: 'Bearer test-service-token' })).status, 401);
  await c.ok('wechat_bridge_status');
  assert.equal((await c.rpc('tools/call', args, 'other-user')).status, 403);
  assert.equal((await c.service('lease', {}, false)).status, 401);
  const invalid = await c.tool('wechat_bridge_status', { unexpected: true });
  assert.equal(invalid.isError, true); assert.equal(invalid.structuredContent.error, 'invalid_arguments');
  const tooLarge = await c.post('/gateway/lease', { gateway_id: 'x'.repeat(1_049_000) }, { Authorization: 'Bearer test-service-token' });
  assert.equal(tooLarge.status, 413);
});
