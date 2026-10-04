import test from 'node:test';
import assert from 'node:assert/strict';
import { probeFeishuConnection } from '../src/doctor.js';
const config = { larkAppId: 'cli_0123456789abcdef', larkAppSecret: 'fixture-secret-not-real' };

test('WSS readiness requires explicit approval and validates bound before any connection', async () => {
  let calls = 0; const connectionFactory = () => { calls++; };
  await assert.rejects(probeFeishuConnection(config, { connectionFactory }));
  for (const timeoutMs of [0, -1, Infinity, 60001]) await assert.rejects(probeFeishuConnection(config, { confirmed: true, timeoutMs, connectionFactory }));
  assert.equal(calls, 0);
});

test('SDK start returning does not prove connected; deadline closes and late events cannot change result', async () => {
  let closed = 0, report;
  const result = await probeFeishuConnection(config, { confirmed: true, timeoutMs: 10,
    connectionFactory(_config, _dispatcher, options) { report = options.report; assert.equal(options.autoReconnect, false);
      return { async start() {}, close() { closed++; } }; } });
  assert.equal(result.outcome, 'timeout'); assert.equal(result.websocket_connected, false); assert.equal(closed, 1);
  report('lark_connected'); assert.equal(result.websocket_connected, false);
});

test('only ready callback proves transport, diagnostic refuses event consumption and closes immediately', async () => {
  let closed = 0;
  const result = await probeFeishuConnection(config, { confirmed: true,
    connectionFactory(_config, dispatcher, options) {
      return { async start() { await assert.rejects(dispatcher.invoke({ secret: 'fixture-private-message' })); options.report('lark_connected'); }, close() { closed++; } }; } });
  assert.equal(result.websocket_connected, true); assert.equal(result.current_dot_connected, false);
  assert.equal(result.messages_stored_or_forwarded, false); assert.equal(closed, 1);
  assert.equal(JSON.stringify(result).includes('fixture'), false);
});

test('WSS failures and cancellation are bounded, redacted and close the client', async () => {
  for (const type of ['throw', 'event', 'cancel', 'hang']) {
    let closed = 0; const controller = new AbortController();
    const result = await probeFeishuConnection(config, { confirmed: true, timeoutMs: 10, signal: controller.signal,
      connectionFactory(_config, _dispatcher, options) { return { start() {
        if (type === 'throw') throw new Error('fixture-secret');
        if (type === 'event') options.report('lark_connection_failed');
        if (type === 'cancel') controller.abort();
        return new Promise(() => {});
      }, close() { closed++; } }; } });
    assert.equal(closed, 1); assert.equal(result.websocket_connected, false);
    assert.equal(result.outcome, type === 'cancel' ? 'cancelled' : type === 'hang' ? 'timeout' : 'failed');
    assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
  }
  const controller = new AbortController(); controller.abort();
  const result = await probeFeishuConnection(config, { confirmed: true, signal: controller.signal, connectionFactory() { assert.fail('Must not start'); } });
  assert.equal(result.outcome, 'cancelled');
});

test('60 second diagnostic applies bounded discovery/handshake budgets and emits only allowlisted stages', async () => {
  const reports = [];
  const result = await probeFeishuConnection(config, { confirmed: true, timeoutMs: 60000, report: event => reports.push(event),
    connectionFactory(_config, _dispatcher, options) {
      assert.equal(options.discoveryTimeoutMs, 30000); assert.equal(options.handshakeTimeoutMs, 10000); assert.equal(options.autoReconnect, false);
      return { async start() {
        for (const stage of ['lark_discovery_started', 'lark_discovery_http_received', 'lark_discovery_endpoint_verified', 'fixture-secret', 'lark_connected']) options.report(stage);
      }, close() {} };
    } });
  assert.equal(result.websocket_connected, true); assert.equal(result.timeout_ms, 60000); assert.equal(result.stages.length, 4);
  assert.equal(JSON.stringify(reports).includes('fixture-secret'), false); assert.equal(result.current_dot_connected, false);
});

test('15 second diagnostic budgets sum below total and discovery failure is distinguishable from timeout', async () => {
  const result = await probeFeishuConnection(config, { confirmed: true, timeoutMs: 15000,
    connectionFactory(_config, _dispatcher, options) {
      assert.ok(options.discoveryTimeoutMs + options.handshakeTimeoutMs < 15000);
      return { start() { options.report('lark_discovery_started'); options.report('lark_discovery_failed'); }, close() {} };
    } });
  assert.equal(result.outcome, 'failed'); assert.equal(result.stages.at(-1).stage, 'lark_discovery_failed');
});
