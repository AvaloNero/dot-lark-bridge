import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, subscriptionParams } from './helpers.js';

function gate() {
  let open;
  return { promise: new Promise(resolve => { open = resolve; }), open: () => open() };
}
async function unsubscribe(f) {
  const params = subscriptionParams(); delete params.delivery.secret; delete params.cursor;
  assert.equal((await f.postMcp('events/unsubscribe', params)).status, 200);
}
async function prepare(f) { await f.subscribe(); await f.receiveLark(); await f.app.bridge.tick(); await f.reply(); }

test('unsubscribe while refreshing Feishu token prevents the reply request', async t => {
  const entered = gate(), release = gate();
  const f = await harness({ sendOverride: async url => {
    if (url.endsWith('/open-apis/auth/v3/tenant_access_token/internal')) { entered.open(); await release.promise; }
  } });
  t.after(async () => { release.open(); await f.close(); });
  await prepare(f); const work = f.app.bridge.tick(); await entered.promise;
  await unsubscribe(f); release.open(); await work;
  assert.equal(f.sends.length, 0);
  assert.equal(f.app.bridge.store.replyStatus('fixture-message-1').status, 'cancelled');
});
test('unsubscribe while waiting for callback DNS prevents connection and completion overwrite', async t => {
  const entered = gate(), release = gate();
  const f = await harness({ sendOverride: async (url, options) => {
    if (url.includes('receiver') && JSON.parse(options.body).eventId) {
      entered.open(); await release.promise; options.beforeConnect();
    }
  } });
  t.after(async () => { release.open(); await f.close(); });
  await f.subscribe(); await f.receiveLark(); const work = f.app.bridge.tick(); await entered.promise;
  await unsubscribe(f); release.open(); await work;
  assert.equal(f.deliveries.length, 0);
  assert.equal(f.app.bridge.store.get("SELECT state FROM jobs WHERE kind='event'").state, 'cancelled');
});
test('Feishu success already in flight is recorded after unsubscribe without any subsequent send', async t => {
  const entered = gate(), release = gate();
  const f = await harness({ sendOverride: async url => {
    if (url.includes('/open-apis/im/v1/messages/')) {
      entered.open(); await release.promise;
      return { status: 200, body: Buffer.from('{"code":0,"data":{"message_id":"ack-already-in-flight","chat_id":"fixture_private_chat"}}') };
    }
  } });
  t.after(async () => { release.open(); await f.close(); });
  await prepare(f); const work = f.app.bridge.tick(); await entered.promise;
  await unsubscribe(f); release.open(); await work; await f.app.bridge.tick();
  assert.equal(f.app.bridge.store.replyStatus('fixture-message-1').status, 'sent');
  assert.equal(f.app.bridge.store.message('fixture-message-1').outbound_id, 'ack-already-in-flight');
  assert.equal(f.requests.filter(r => r.url.includes('/open-apis/im/v1/messages/')).length, 1);
});
test('graceful shutdown waits for the active timer worker even after skipped intervals', async t => {
  const entered = gate(), release = gate(); let closing;
  const f = await harness({ worker: true, overrides: { workerIntervalMs: 5 }, sendOverride: async (url, options) => {
    if (url.includes('receiver') && JSON.parse(options.body).eventId) {
      entered.open(); await release.promise;
      return { status: 202, body: Buffer.from('{}') };
    }
  } });
  t.after(async () => { release.open(); await (closing ?? f.close()); });
  await f.subscribe(); await f.receiveLark(); await entered.promise;
  await new Promise(resolve => setTimeout(resolve, 20));
  let closed = false; closing = f.close().then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(closed, false);
  release.open(); await closing; assert.equal(closed, true);
});
test('unsubscribe during callback verification prevents a late subscription from becoming active', async t => {
  const entered = gate(), release = gate();
  const f = await harness({ sendOverride: async (url, options) => {
    if (url.includes('receiver') && JSON.parse(options.body).type === 'verification') { entered.open(); await release.promise; }
  } });
  t.after(async () => { release.open(); await f.close(); });
  const subscribing = f.subscribe(); await entered.promise;
  await unsubscribe(f); release.open();
  assert.equal((await subscribing).body.error.code, -32012);
  assert.equal(f.app.bridge.store.activeSubscription(f.now()), undefined);
});
test('resubscribe to the same callback never re-authorizes messages from a revoked or expired generation', async t => {
  for (const expired of [false, true]) {
    const f = await harness(); t.after(f.close); await prepare(f);
    if (expired) f.advance(f.config.subscriptionTtlMs + 1);
    else await unsubscribe(f);
    assert.equal((await f.subscribe()).status, 200);
    assert.equal((await f.reply()).body.error.code, -32012);
    await f.app.bridge.tick(); assert.equal(f.sends.length, 0);
  }
});
