import { privateMkdtempSync, fixtureChmodSync } from '../../dot-qq-bridge/packages/dot-bridge-platform/test-fixtures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getEventListeners } from 'node:events';
import { pairFeishu } from '../src/setup.js';

// Public synthetic fixtures only. These tests never construct a live transport.
const credentials = { version: 1, status: 'registered', appId: 'cli_0123456789abcdef',
  appSecret: 'fixture-app-secret-no-real-account', tenantKey: 'fixture_tenant', ownerOpenId: 'fixture_lark_owner' };
function message(text, time = Date.now(), changes = {}) {
  return { schema: '2.0', header: { event_id: 'fixture-event', event_type: 'im.message.receive_v1',
    create_time: String(time), app_id: credentials.appId, tenant_key: credentials.tenantKey },
    event: { sender: { sender_id: { open_id: credentials.ownerOpenId }, sender_type: 'user', tenant_key: credentials.tenantKey },
      message: { message_id: 'fixture-message', chat_id: 'fixture-chat', chat_type: 'p2p', message_type: 'text',
        create_time: String(time), content: JSON.stringify({ text }), ...changes } } };
}
function harness(t, options = {}) {
  const directory = privateMkdtempSync(path.join(os.tmpdir(), 'dot-lark-readiness-test-')); fixtureChmodSync(directory, 0o700);
  t.after(() => fs.rmdirSync(directory));
  const reports = [], saved = [], controller = new AbortController();
  let transportReport, dispatcher, starts = 0, closes = 0;
  const result = pairFeishu({ credentials, bindingFile: path.join(directory, 'fixture.json'), confirmed: true,
    signal: controller.signal, report: event => reports.push(event), save: (...args) => saved.push(args),
    connectionFactory(_config, target, settings) {
      dispatcher = target; transportReport = settings.report;
      return { start() { starts++; return options.start?.(); }, close() { closes++; } };
    }, ...options });
  return { result, reports, saved, controller, emit: event => transportReport(event),
    receive: (text, time, changes) => dispatcher.invoke(message(text, time, changes), { needCheck: false }),
    challenge: () => reports.find(event => event.phase === 'pairing_challenge')?.private_text_to_send,
    starts: () => starts, closes: () => closes };
}
function timers(t) { t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1800000000000 }); }

test('resolved start does not expose a challenge; full challenge lifetime begins only at WSS readiness', async t => {
  timers(t); const flow = harness(t, { timeoutMs: 1000 });
  await Promise.resolve(); assert.equal(flow.starts(), 1); assert.equal(flow.challenge(), undefined);
  assert.equal((await flow.receive('pair premature')).outcome, 'ignored');
  t.mock.timers.tick(5000); await Promise.resolve(); assert.equal(flow.challenge(), undefined);
  flow.emit('lark_reconnected'); assert.equal(flow.challenge(), undefined);
  flow.emit('lark_connected'); const challenge = flow.challenge(); assert.match(challenge, /^pair /);
  const displayed = flow.reports.find(event => event.phase === 'pairing_challenge'); assert.equal(displayed.expires_in_seconds, 1);
  t.mock.timers.tick(999);
  assert.equal((await flow.receive(challenge)).outcome, 'paired');
  const result = await flow.result;
  assert.equal(result.owner_binding_complete, true); assert.equal(flow.saved.length, 1); assert.equal(flow.closes(), 1);
  assert.equal(getEventListeners(flow.controller.signal, 'abort').length, 0);
});

test('default connection readiness deadline is 60 seconds and late callbacks cannot pair', async t => {
  timers(t); const flow = harness(t); const rejected = assert.rejects(flow.result, /connection timed out/);
  await Promise.resolve(); t.mock.timers.tick(59999); await Promise.resolve(); assert.equal(flow.closes(), 0);
  t.mock.timers.tick(1); await rejected;
  assert.equal(flow.closes(), 1); assert.equal(flow.saved.length, 0); assert.equal(flow.challenge(), undefined);
  flow.emit('lark_connected'); assert.equal(flow.challenge(), undefined);
  assert.equal((await flow.receive('pair late')).outcome, 'ignored');
  assert.equal(getEventListeners(flow.controller.signal, 'abort').length, 0);
});

test('hung start is still bounded by readiness timeout and closes its transport', async t => {
  timers(t); const flow = harness(t, { connectionTimeoutMs: 20, start: () => new Promise(() => {}) });
  const rejected = assert.rejects(flow.result, /connection timed out/);
  await Promise.resolve(); t.mock.timers.tick(20); await rejected;
  assert.equal(flow.closes(), 1); assert.equal(flow.saved.length, 0);
});

test('cancellation before readiness closes transport, removes listener, and never displays a challenge', async t => {
  const flow = harness(t); const rejected = assert.rejects(flow.result, { code: 'abort' });
  await Promise.resolve(); flow.controller.abort(); await rejected;
  flow.emit('lark_connected');
  assert.equal(flow.challenge(), undefined); assert.equal(flow.closes(), 1); assert.equal(flow.saved.length, 0);
  assert.equal(getEventListeners(flow.controller.signal, 'abort').length, 0);
});

test('challenge expiry and cancellation after readiness never persist a binding', async t => {
  timers(t);
  for (const cancel of [false, true]) {
    const flow = harness(t, { timeoutMs: 100 }); const rejected = assert.rejects(flow.result, cancel ? /cancelled/ : /expired/);
    await Promise.resolve(); flow.emit('lark_connected'); const challenge = flow.challenge();
    if (cancel) flow.controller.abort(); else t.mock.timers.tick(100);
    await rejected; assert.equal((await flow.receive(challenge)).outcome, 'ignored');
    assert.equal(flow.saved.length, 0); assert.equal(flow.closes(), 1);
  }
});

test('repeated ready events do not restart challenge, and other messages never pair', async t => {
  timers(t); const flow = harness(t, { timeoutMs: 100 }); const rejected = assert.rejects(flow.result, /expired/);
  await Promise.resolve(); flow.emit('lark_connected'); const challenge = flow.challenge();
  assert.equal((await flow.receive('ordinary private message')).outcome, 'ignored');
  assert.notEqual((await flow.receive(challenge, Date.now(), { chat_type: 'group' })).outcome, 'paired');
  t.mock.timers.tick(99); flow.emit('lark_connected'); flow.emit('lark_reconnected');
  assert.equal(flow.reports.filter(event => event.phase === 'pairing_challenge').length, 1);
  assert.equal(flow.challenge(), challenge);
  t.mock.timers.tick(1); await rejected; assert.equal(flow.saved.length, 0);
  assert.equal(JSON.stringify(flow.reports).includes(credentials.appSecret), false);
  assert.equal(JSON.stringify(flow.reports).includes('ordinary private message'), false);
});

test('startup rejection closes the transport without exposing a challenge', async t => {
  const flow = harness(t, { start: async () => { throw new Error('fixture startup failed'); } });
  await assert.rejects(flow.result, /fixture startup failed/);
  assert.equal(flow.closes(), 1); assert.equal(flow.challenge(), undefined); assert.equal(flow.saved.length, 0);
});

test('rejection from startup after readiness cancels the session and ignores later messages', async t => {
  let rejectStart;
  const flow = harness(t, { start: () => new Promise((_, reject) => { rejectStart = reject; }) });
  const rejected = assert.rejects(flow.result, /fixture startup failed/);
  await Promise.resolve(); flow.emit('lark_connected'); rejectStart(new Error('fixture startup failed')); await rejected;
  assert.equal((await flow.receive(flow.challenge())).outcome, 'ignored');
  assert.equal(flow.saved.length, 0); assert.equal(flow.closes(), 1);
});

test('nonfinite, nonpositive and overflowing timeout values fail before a connection is created', async t => {
  for (const key of ['timeoutMs', 'connectionTimeoutMs']) {
    for (const value of [0, -1, Infinity, NaN, 2147483648, '60']) {
      const flow = harness(t, { [key]: value });
      await assert.rejects(flow.result, /timeouts/); assert.equal(flow.starts(), 0); assert.equal(flow.saved.length, 0);
    }
  }
});
