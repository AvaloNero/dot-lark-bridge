import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersistentService } from '../src/service.js';
import { harness } from './helpers.js';

test('persistent service refuses unapproved or nonproduction configurations before construction', () => {
  const appFactory = () => assert.fail('Must not construct');
  assert.throws(() => createPersistentService({ bridgeMode: 'tunnel', authMode: 'oauth', larkTransport: 'long-connection' }, { appFactory }));
  for (const authMode of ['deny', 'dev']) assert.throws(() => createPersistentService({ authMode, larkTransport: 'long-connection' }, { approved: true, modeLock: () => () => {}, appFactory }));
});

test('persistent lifecycle exposes gateway state, subscription gate and bounded logs without claiming dot success', async () => {
  const logs = []; let heartbeat, report, state = 'connecting', subscribed = false, closed = 0, cancelled = 0;
  const service = createPersistentService({ bridgeMode: 'tunnel', authMode: 'oauth', larkTransport: 'long-connection', secret: 'fixture-secret' }, {
    approved: true, modeLock: () => () => {}, emit: value => logs.push(value), schedule(fn) { heartbeat = fn; return 12; }, unschedule() { cancelled++; },
    appFactory(_config, options) { report = options.report; return { async listen() {}, async close() { closed++; },
      larkRuntime: { status: () => state }, readiness: () => ({ bridge_configuration_ready: true, mcp_subscription_active: subscribed,
        gateway_connected: state === 'connected', ready_for_delivery: subscribed && state === 'connected', end_to_end_verified: true, secret: 'fixture-secret' }) }; } });
  await service.start(); report('lark_discovery_started'); state = 'connected'; report('lark_connected'); heartbeat();
  assert.equal(service.snapshot().gateway_connected, true); assert.equal(service.snapshot().ready_for_delivery, false);
  subscribed = true; heartbeat(); assert.equal(service.snapshot().ready_for_delivery, true); assert.equal(service.snapshot().end_to_end_verified, false);
  state = 'reconnecting'; report('lark_reconnecting'); heartbeat(); assert.equal(logs.some(value => value.event === 'gateway_disconnected'), true);
  state = 'connected'; report('lark_reconnected'); report('fixture-secret'); report({ secret: 'fixture-secret' }); heartbeat();
  assert.equal(service.snapshot().reconnects, 1); assert.equal(service.snapshot().reconnecting, 1);
  assert.equal(JSON.stringify(logs).includes('fixture-secret'), false);
  await service.close(); await service.close(); assert.equal(closed, 1); assert.equal(cancelled, 1);
  await assert.rejects(service.start()); assert.equal(service.snapshot().lifecycle, 'stopped');
});

test('real readiness endpoint remains unavailable without a subscription and never claims end-to-end verification', async () => {
  const h = await harness();
  try {
    const response = await fetch(`${h.origin}/readyz`); const body = await response.json();
    assert.equal(response.status, 503); assert.equal(body.ready_for_delivery, false); assert.equal(body.mcp_subscription_active, false); assert.equal(body.end_to_end_verified, false);
  } finally { await h.close(); }
});

test('production startup and heartbeat failures stay sanitized and release resources', async () => {
  const logs = []; let heartbeat, closed = 0;
  const service = createPersistentService({ bridgeMode: 'tunnel', authMode: 'oauth', larkTransport: 'long-connection' }, { approved: true, modeLock: () => () => {},
    emit: record => logs.push(record), schedule(fn) { heartbeat = fn; return 1; }, unschedule() {},
    appFactory() { return { async listen() {}, async close() { closed++; }, larkRuntime: { status: () => 'connected' },
      readiness() { throw new Error('fixture-private-error'); } }; } });
  await assert.rejects(service.start(), error => !String(error).includes('fixture-private-error'));
  assert.equal(closed, 1); assert.equal(JSON.stringify(logs).includes('fixture-private-error'), false);
  heartbeat(); assert.equal(logs.at(-1).event, 'service_heartbeat_failed');
  const construction = createPersistentService({ bridgeMode: 'tunnel', authMode: 'oauth', larkTransport: 'long-connection' }, { approved: true, modeLock: () => () => {}, emit: record => logs.push(record),
    appFactory() { throw new Error('fixture-private-construction-error'); } });
  await assert.rejects(construction.start(), error => !String(error).includes('fixture-private-construction-error'));
  assert.equal(construction.snapshot().lifecycle, 'stopped');
});

test('failed cleanup emits stop_failed without falsely confirming stopped or printing its raw error', async () => {
  const logs = [];
  const service = createPersistentService({ bridgeMode: 'tunnel', authMode: 'oauth', larkTransport: 'long-connection' }, { approved: true, modeLock: () => () => {},
    emit: record => logs.push(record), schedule() { return 1; }, unschedule() {},
    appFactory() { return { async listen() {}, async close() { throw new Error('fixture-private-shutdown-error'); },
      larkRuntime: { status: () => 'idle' }, readiness: () => ({}) }; } });
  await service.start(); await assert.rejects(service.close(), error => !String(error).includes('fixture-private-shutdown-error'));
  assert.equal(service.snapshot().lifecycle, 'stop_failed'); assert.equal(logs.at(-1).event, 'service_stop_failed');
  assert.equal(logs.some(record => record.event === 'service_stopped'), false);
  assert.equal(JSON.stringify(logs).includes('fixture-private-shutdown-error'), false);
});

test('throwing diagnostic sink cannot prevent startup settlement or teardown', async () => {
  let closed = 0, released = 0;
  const service = createPersistentService({ bridgeMode: 'tunnel', authMode: 'oauth', larkTransport: 'long-connection' }, {
    approved: true, modeLock: () => () => { released++; }, emit() { throw new Error('synthetic logging failure'); },
    schedule() { return 1; }, unschedule() {},
    appFactory() { return { async listen() {}, async close() { closed++; },
      larkRuntime: { status: () => 'disabled' }, readiness: () => ({}) }; }
  });
  await service.start(); assert.equal(service.snapshot().lifecycle, 'running');
  await service.close(); assert.equal(service.snapshot().lifecycle, 'stopped');
  assert.equal(closed, 1); assert.equal(released, 1);
});
