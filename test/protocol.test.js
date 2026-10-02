import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, mcpRequest, subscriptionParams, FIXTURE_SECRET, FIXTURE_TOKEN } from './helpers.js';
import { webhookKey, Vault } from '../src/signatures.js';
import { canonical } from '../src/common.js';
test('secret validation and authenticated at-rest encryption reject malformed/swapped values', () => {
  for (const secret of ['bad', 'whsec_Zg==', `whsec_${Buffer.alloc(65).toString('base64')}`, 'whsec_!!!!']) assert.throws(() => webhookKey(secret));
  assert.equal(webhookKey(FIXTURE_SECRET).length, 32);
  const vault = new Vault(Buffer.alloc(32, 8).toString('base64')), sealed = vault.seal({ text: 'private' }, 'one');
  assert.deepEqual(vault.open(sealed, 'one'), { text: 'private' });
  assert.throws(() => vault.open(sealed, 'two'));
  const bytes = Buffer.from(sealed, 'base64'); bytes[30] ^= 1;
  assert.throws(() => vault.open(bytes.toString('base64'), 'one'));
  assert.throws(() => new Vault('short'));
});
test('MCP 2.0 discovery, metadata, tool annotations, complete results and unsupported methods', async t => {
  const f = await harness(); t.after(f.close);
  const discover = await f.postMcp('server/discover');
  assert.equal(discover.status, 200); assert.equal(discover.body.result.resultType, 'complete');
  assert.deepEqual(discover.body.result.supportedVersions, ['2026-07-28']);
  assert.deepEqual(discover.body.result.capabilities.events, {});
  assert.equal(discover.body.result.cacheScope, 'private');
  const tools = (await f.postMcp('tools/list')).body.result.tools;
  assert.deepEqual(tools.map(tool => tool.name), ['get_lark_message', 'reply_to_lark']);
  assert.equal(tools[1].annotations.readOnlyHint, false); assert.equal(tools[1].annotations.idempotentHint, true);
  assert.equal(tools[1].inputSchema.additionalProperties, false);
  const events = (await f.postMcp('events/list')).body.result.events;
  assert.deepEqual(events[0].delivery, ['webhook']); assert.equal(events[0].name, 'lark.message.created');
  assert.equal((await f.postMcp('initialize')).body.error.code, -32601);
  assert.equal((await f.postMcp('events/poll')).status, 404);
  assert.equal((await fetch(`${f.origin}/mcp`)).status, 405);
});
test('MCP rejects missing metadata, legacy versions and mirrored header mismatches', async t => {
  const f = await harness(); t.after(f.close);
  const noMeta = mcpRequest('server/discover'); delete noMeta.params._meta;
  assert.equal((await f.postMcp('', {}, { request: noMeta })).body.error.code, -32602);
  assert.equal((await f.postMcp('server/discover', {}, { headers: { 'Mcp-Method': 'tools/list' } })).body.error.code, -32020);
  assert.equal((await f.postMcp('server/discover', {}, { headers: { 'MCP-Protocol-Version': '2025-11-25' } })).body.error.code, -32020);
  const legacy = mcpRequest('server/discover'); legacy.params._meta['io.modelcontextprotocol/protocolVersion'] = '2025-11-25';
  const rejected = await f.postMcp('', {}, { request: legacy, headers: { 'MCP-Protocol-Version': '2025-11-25' } });
  assert.equal(rejected.body.error.code, -32022); assert.deepEqual(rejected.body.error.data.supported, ['2026-07-28']);
  assert.equal((await f.postMcp('tools/call', { name: 'get_lark_message', arguments: { message_id: 'id' } }, { headers: { 'Mcp-Name': 'reply_to_lark' } })).body.error.code, -32020);
  const request = mcpRequest('tools/list'); delete request.params._meta['io.modelcontextprotocol/clientCapabilities'];
  assert.equal((await f.postMcp('', {}, { request })).status, 400);
  assert.equal((await f.postMcp('ping', {}, { headers: { Accept: 'application/json' } })).status, 406);
});
test('auth, Origin, JSON batching and payload-size restrictions fail closed', async t => {
  const f = await harness(); t.after(f.close);
  assert.equal((await f.postMcp('events/list', {}, { token: 'wrong-token' })).status, 401);
  assert.equal((await f.postMcp('events/list', {}, { headers: { Authorization: '' } })).status, 401);
  assert.equal((await f.postMcp('events/list', {}, { headers: { Origin: 'https://attacker.example' } })).status, 403);
  const batch = await fetch(`${f.origin}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer synthetic-local-token-for-tests-only-0000000000' }, body: '[]' });
  assert.equal(batch.status, 400);
  for (const [body, headers, expected] of [[Buffer.from('{'), {}, 400], [Buffer.alloc(32769, 'a'), {}, 413],
    [Buffer.from('{}'), { 'Content-Encoding': 'gzip' }, 415]]) {
    const response = await fetch(`${f.origin}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json',
      Authorization: `Bearer ${FIXTURE_TOKEN}`, ...headers }, body });
    assert.equal(response.status, expected);
  }
});
test('subscription verifies challenge, is deterministic/idempotent, respects TTL and stops idempotently', async t => {
  const f = await harness(); t.after(f.close);
  const first = await f.subscribe(), again = await f.subscribe();
  assert.equal(first.status, 200); assert.equal(first.body.result.id, again.body.result.id);
  assert.equal(f.requests.length, 1); assert.equal(first.body.result.cursor, null);
  assert.equal(canonical({ a: 1, b: 2 }), canonical({ b: 2, a: 1 }));
  const short = await f.subscribe(subscriptionParams({ ttlMs: 1000 }));
  assert.equal(Date.parse(short.body.result.refreshBefore) - f.now(), 1000);
  const noExpiry = await f.subscribe(subscriptionParams({ ttlMs: null }));
  assert.notEqual(noExpiry.body.result.refreshBefore, null);
  const other = await f.subscribe(subscriptionParams({ delivery: { ...subscriptionParams().delivery, url: 'https://receiver.example.com/another-dot' } }));
  assert.equal(other.body.error.code, -32013);
  const params = subscriptionParams(); delete params.delivery.secret; delete params.cursor;
  assert.equal((await f.postMcp('events/unsubscribe', params)).status, 200);
  assert.equal((await f.postMcp('events/unsubscribe', params)).status, 200);
  assert.equal(f.app.bridge.store.activeSubscription(f.now()), undefined);
});
test('bad challenges, callback URLs, secrets, arguments and unsupported modes never activate a subscription', async t => {
  const f = await harness({ sendOverride: async () => ({ status: 200, body: Buffer.from('{"challenge":"wrong"}') }) }); t.after(f.close);
  assert.equal((await f.subscribe()).body.error.code, -32015);
  assert.equal(f.app.bridge.store.activeSubscription(f.now()), undefined);
  for (const url of ['http://receiver.example.com/x', 'https://localhost/x', 'https://receiver.example.com:8443/x', 'https://user:pass@receiver.example.com/x', 'https://receiver.example.com/x#fragment']) {
    assert.equal((await f.subscribe(subscriptionParams({ delivery: { ...subscriptionParams().delivery, url } }))).status, 400);
  }
  assert.equal((await f.subscribe(subscriptionParams({ arguments: { conversation: 'anyone' } }))).body.error.code, -32012);
  assert.equal((await f.subscribe(subscriptionParams({ arguments: { conversation: 'owner', owner_openid: 'other' } }))).status, 400);
  assert.equal((await f.subscribe(subscriptionParams({ cursor: 'old' }))).body.error.code, -32014);
  assert.equal((await f.subscribe(subscriptionParams({ ttlMs: -1 }))).status, 400);
  assert.equal((await f.subscribe(subscriptionParams({ delivery: { ...subscriptionParams().delivery, mode: 'push' } }))).body.error.code, -32014);
  assert.equal((await f.subscribe(subscriptionParams({ name: 'unknown.event' }))).body.error.code, -32011);
});
test('callback secret rotation signs with both keys within the bounded window', async t => {
  const f = await harness(); t.after(f.close);
  await f.subscribe();
  const replacement = `whsec_${Buffer.alloc(32, 9).toString('base64')}`;
  f.setSecret(replacement);
  assert.equal((await f.subscribe(subscriptionParams({ delivery: { ...subscriptionParams().delivery, secret: replacement } }))).status, 200);
  await f.receiveLark(); await f.app.bridge.tick();
  const request = f.requests.find(entry => JSON.parse(entry.options.body).eventId);
  assert.equal(request.options.headers['webhook-signature'].split(' ').length, 2);
});
