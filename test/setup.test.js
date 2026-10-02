import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as lark from '@larksuiteoapi/node-sdk';
import { registerFeishu, setupPlan, REGISTRATION_ADDONS, createPairingSession, pairFeishu } from '../src/setup.js';
import { loadCredentials } from '../src/credentials.js';
import { writePrivateJson } from '../src/private-files.js';
import { readConfig } from '../src/config.js';
import { localStatus, probeFeishu } from '../src/doctor.js';
import { createLarkConnection, createLarkRuntime } from '../src/lark-runtime.js';
import { larkPayload, config } from './helpers.js';

// Synthetic publicly visible values, not real Feishu credentials.
const registered = { version: 1, status: 'registered', appId: 'cli_0123456789abcdef',
  appSecret: 'fixture-app-secret-no-real-account', tenantKey: 'fixture_tenant', ownerOpenId: 'fixture_lark_owner' };
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dot-lark-setup-test-')); fs.chmodSync(directory, 0o700);
  t.after(() => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    // Delete only known direct fixture files; no recursive delete or computed shell command.
    for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name));
    fs.rmdirSync(directory);
  });
  return name => path.join(directory, name);
}
function payload(now, text = 'fixture challenge') {
  const p = larkPayload(now, { content: JSON.stringify({ text }) }); p.header.app_id = registered.appId; return p;
}

test('setup defaults to a reviewable offline plan, and the live CLI cannot start without explicit flags', () => {
  assert.equal(setupPlan().network, false); assert.equal(setupPlan().credentials_created, false);
  const plan = spawnSync(process.execPath, ['scripts/setup.js'], { encoding: 'utf8' });
  assert.equal(plan.status, 0); assert.equal(JSON.parse(plan.stdout).mode, 'PLAN_ONLY');
  for (const args of [['register'], ['pair'], ['register', '--unexpected-option']]) {
    const result = spawnSync(process.execPath, ['scripts/setup.js', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.equal(JSON.parse(result.stderr).credentials_printed, false);
  }
});

test('registration requires explicit approval acknowledgement, tenant and a new private destination before contacting SDK', async t => {
  const file = temporary(t), credentialsFile = file('registered.json');
  let calls = 0; const sdk = { registerApp() { calls++; throw new Error('Must not call'); } };
  await assert.rejects(registerFeishu({ credentialsFile, tenantKey: registered.tenantKey, sdk }));
  await assert.rejects(registerFeishu({ credentialsFile, confirmed: true, sdk }));
  fs.writeFileSync(credentialsFile, 'existing fixture');
  await assert.rejects(registerFeishu({ credentialsFile, confirmed: true, tenantKey: registered.tenantKey, sdk }));
  assert.equal(calls, 0); assert.equal(fs.readFileSync(credentialsFile, 'utf8'), 'existing fixture');
});

test('registerApp uses the minimal official tenant grants and writes credentials privately without logging them', async t => {
  const file = temporary(t), reports = [];
  const sdk = { async registerApp(options) {
    assert.equal(options.createOnly, true); assert.equal(options.domain, 'accounts.feishu.cn');
    assert.equal(options.appId, undefined); assert.deepEqual(options.addons, REGISTRATION_ADDONS);
    assert.equal(options.addons.scopes.user, undefined); assert.equal(options.addons.preset, false);
    options.onQRCodeReady({ url: 'https://accounts.feishu.cn/fixture-verify?request=fixture', expireIn: 600 });
    options.onStatusChange({ status: 'polling', description: registered.appSecret });
    return { client_id: registered.appId, client_secret: registered.appSecret,
      user_info: { open_id: registered.ownerOpenId, tenant_brand: 'feishu' } };
  } };
  const output = await registerFeishu({ credentialsFile: file('registered.json'), tenantKey: registered.tenantKey,
    confirmed: true, sdk, report: value => reports.push(value) });
  assert.equal(output.owner_binding_complete, false); assert.equal(output.current_dot_connected, false);
  const saved = loadCredentials(file('registered.json')); assert.equal(saved.appSecret, registered.appSecret);
  assert.equal(saved.status, 'registered'); assert.equal(saved.ownerOpenId, registered.ownerOpenId);
  assert.equal(JSON.stringify(reports).includes(registered.appSecret), false);
  assert.equal(JSON.stringify(reports).includes(registered.ownerOpenId), false);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file('registered.json')).mode & 0o077, 0);
});

test('international brand, hostile verification URL, expired flow and cancellation cannot save credentials', async t => {
  const file = temporary(t); let index = 0;
  for (const behavior of ['brand', 'domain-switch', 'url', 'abort', 'denied', 'expired', 'timeout']) {
    const controller = new AbortController();
    const sdk = { async registerApp(options) {
      if (behavior === 'url') options.onQRCodeReady({ url: 'https://attacker.example/verify', expireIn: 600 });
      if (behavior === 'domain-switch') options.onStatusChange({ status: 'domain_switched' });
      if (behavior === 'abort') controller.abort();
      if (behavior === 'denied') { const error = new Error(registered.appSecret); error.code = 'access_denied'; throw error; }
      if (behavior === 'expired') { const error = new Error(registered.appSecret); error.code = 'expired_token'; throw error; }
      if (behavior === 'timeout') return new Promise(() => {});
      return { client_id: registered.appId, client_secret: registered.appSecret, user_info: { tenant_brand: behavior === 'brand' ? 'lark' : 'feishu' } };
    } };
    const destination = file(`failed-${index++}.json`);
    await assert.rejects(registerFeishu({ credentialsFile: destination, confirmed: true, tenantKey: registered.tenantKey,
      sdk, signal: controller.signal, timeoutMs: 30 }));
    assert.equal(fs.existsSync(destination), false);
  }
});

test('pairing fails closed without a verified owner or if the approved owner conflicts with the scan', () => {
  assert.throws(() => createPairingSession({ ...registered, ownerOpenId: undefined }));
  assert.throws(() => createPairingSession(registered, { ownerOpenId: 'another-owner' }));
  assert.throws(() => createPairingSession({ ...registered, status: 'paired', ownerChatId: 'fixture-chat' }));
});

test('official pairing dispatcher accepts only known owner, tenant, original header, p2p text and fresh exact challenge', async () => {
  let now = Date.now();
  const session = createPairingSession(registered, { clock: () => now, nonce: 'public-fixture-nonce' });
  let completed = false; session.completion.then(() => { completed = true; });
  const changes = [p => { p.header.app_id = 'other-app'; }, p => { p.header.tenant_key = 'other-tenant'; },
    p => { p.event.sender.sender_id.open_id = 'stranger'; }, p => { delete p.event.sender.tenant_key; },
    p => { p.event.sender.sender_type = 'app'; }, p => { p.event.message.chat_type = 'group'; },
    p => { p.event.message.message_type = 'image'; }, p => { p.event.message.root_id = 'old'; },
    p => { p.event.message.mentions = [{ id: 'other' }]; }, p => { p.event.message.chat_id = ''; },
    p => { p.event.message.content = JSON.stringify({ text: session.challenge + ' extra' }); },
    p => { p.event.message.create_time = String(now - 31000); p.header.create_time = String(now - 31000); },
    p => { p.event.app_id = registered.appId; }, p => { delete p.header; }];
  for (const change of changes) {
    const p = payload(now, session.challenge); change(p);
    const result = await session.dispatcher.invoke(p, { needCheck: false });
    assert.notEqual(result.outcome, 'paired'); assert.equal(completed, false);
  }
  assert.equal((await session.dispatcher.invoke(payload(now, session.challenge), { needCheck: true })).outcome, 'rejected');
  const result = await session.dispatcher.invoke(payload(now, session.challenge), { needCheck: false });
  assert.equal(result.outcome, 'paired');
  const binding = await session.completion; assert.equal(binding.status, 'paired');
  assert.equal(binding.ownerChatId, 'fixture_private_chat'); assert.equal(binding.ownerOpenId, registered.ownerOpenId);
  const replay = payload(now, session.challenge); replay.event.message.chat_id = 'another-chat';
  assert.equal((await session.dispatcher.invoke(replay, { needCheck: false })).outcome, 'ignored');
});

test('pairing challenge expires and cancelled sessions cannot claim a chat', async () => {
  let now = Date.now();
  const session = createPairingSession(registered, { clock: () => now, timeoutMs: 1000 }); now += 1000;
  assert.equal((await session.dispatcher.invoke(payload(now, session.challenge), { needCheck: false })).outcome, 'ignored');
  const cancelled = createPairingSession(registered, { clock: () => now }); cancelled.cancel();
  assert.equal((await cancelled.dispatcher.invoke(payload(now, cancelled.challenge), { needCheck: false })).outcome, 'ignored');
});

test('pair wizard writes a complete private binding, stops its WSS transport, and does not start MCP or reply', async t => {
  const file = temporary(t), reports = []; let challenge, closed = false;
  const connectionFactory = (_settings, dispatcher) => ({ async start() {
    assert.equal((await dispatcher.invoke(payload(Date.now(), challenge), { needCheck: false })).outcome, 'paired');
  }, close() { closed = true; } });
  const result = await pairFeishu({ credentials: registered, bindingFile: file('paired.json'), confirmed: true,
    connectionFactory, report(value) { reports.push(value); if (value.private_text_to_send) challenge = value.private_text_to_send; } });
  assert.equal(result.bridge_started, false); assert.equal(result.current_dot_connected, false); assert.equal(closed, true);
  assert.equal(loadCredentials(file('paired.json'), { paired: true }).ownerChatId, 'fixture_private_chat');
  assert.equal(JSON.stringify(reports).includes(registered.appSecret), false);
});

test('pair timeout closes transport and does not save a partial or auto-claimed binding', async t => {
  const file = temporary(t); let started = false, closed = false;
  await assert.rejects(pairFeishu({ credentials: registered, bindingFile: file('paired.json'), confirmed: true, timeoutMs: 25,
    connectionFactory: () => ({ async start() { started = true; }, close() { closed = true; } }) }));
  assert.equal(started, true); assert.equal(closed, true); assert.equal(fs.existsSync(file('paired.json')), false);
});

test('service loads only complete paired files, never silently replaces conflicting identity, and stays denied by default', t => {
  const file = temporary(t);
  writePrivateJson(file('registered.json'), registered);
  assert.throws(() => readConfig({ LARK_CREDENTIALS_FILE: file('registered.json') }));
  const paired = { ...registered, status: 'paired', ownerChatId: 'fixture_private_chat' }; writePrivateJson(file('paired.json'), paired);
  const settings = readConfig({ LARK_CREDENTIALS_FILE: file('paired.json') });
  assert.equal(settings.authMode, 'deny'); assert.equal(settings.larkTransport, 'disabled'); assert.equal(settings.ownerChatId, paired.ownerChatId);
  assert.throws(() => readConfig({ LARK_CREDENTIALS_FILE: file('paired.json'), LARK_OWNER_OPEN_ID: 'stranger' }));
  assert.throws(() => writePrivateJson(file('paired.json'), paired));
  writePrivateJson(file('extra.json'), { ...paired, user_access_token: 'fixture-forbidden-extra-field' });
  assert.throws(() => loadCredentials(file('extra.json')));
  const output = localStatus({ LARK_CREDENTIALS_FILE: file('paired.json') });
  assert.equal(output.owner_binding_complete, true); assert.equal(output.local_configuration_ready, false);
  for (const secret of [paired.appSecret, paired.ownerOpenId, paired.tenantKey, paired.ownerChatId]) assert.equal(JSON.stringify(output).includes(secret), false);
});

test('read-only app probe is gated and redacted; a successful bot query does not assert owner, scope or dot readiness', async () => {
  const settings = { larkAppId: registered.appId, larkAppSecret: registered.appSecret }; const calls = [];
  const send = async (url, options) => {
    calls.push({ url, options });
    return { status: 200, body: Buffer.from(JSON.stringify(calls.length === 1 ?
      { code: 0, tenant_access_token: 'fixture-temporary-app-token' } : { code: 0, bot: { open_id: 'fixture-bot' } })) };
  };
  await assert.rejects(probeFeishu(settings, { send })); assert.equal(calls.length, 0);
  const result = await probeFeishu(settings, { confirmed: true, send });
  assert.equal(calls.length, 2); assert.equal(calls[1].options.method, 'GET');
  assert.equal(result.bot_identity_verified, true); assert.equal(result.owner_or_scopes_verified, false); assert.equal(result.current_dot_connected, false);
  assert.equal(JSON.stringify(result).includes('fixture-temporary-app-token'), false);
});

test('shared authenticated connection restricts discovery and WSS origins; normal live MCP still requires OAuth', async () => {
  let clientOptions, endpoint = 'wss://msg-frontier.feishu.cn/fixture?ticket=fixture', closed = false;
  const sdk = { ...lark, WSClient: class {
    constructor(options) { clientOptions = options; }
    async start({ eventDispatcher }) { assert.ok(eventDispatcher); await clientOptions.httpInstance.request({ method: 'POST',
      url: 'https://open.feishu.cn/callback/ws/endpoint', data: { AppID: registered.appId, AppSecret: registered.appSecret } }); }
    getConnectionStatus() { return { state: 'connected' }; } close() { closed = true; }
  } };
  const make = () => createLarkConnection({ larkAppId: registered.appId, larkAppSecret: registered.appSecret }, {}, { sdk,
    send: async (url, options) => { options.beforeConnect(); assert.equal(url, 'https://open.feishu.cn/callback/ws/endpoint');
      return { status: 200, body: Buffer.from(JSON.stringify({ code: 0, data: { URL: endpoint } })) }; } });
  const connection = make(); await connection.start(); assert.equal(connection.status(), 'connected');
  await assert.rejects(clientOptions.httpInstance.request({ method: 'POST', url: 'https://attacker.example', data: {} }));
  connection.close(); assert.equal(closed, true); await assert.rejects(connection.start());
  for (const url of ['ws://msg-frontier.feishu.cn/x', 'wss://attacker.example/x', 'wss://user:password@msg-frontier.feishu.cn/x']) {
    endpoint = url; const invalid = make(); try { await assert.rejects(invalid.start()); } finally { invalid.close(); }
  }
  const live = createLarkRuntime(config({ larkAppId: registered.appId, larkTransport: 'long-connection' }), {}, Date.now, { sdk });
  try { await assert.rejects(live.start(), /requires OAuth/); } finally { live.close(); }
});

test('stopping during official endpoint discovery cannot return a usable websocket endpoint', async () => {
  let options, resolveResponse, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const sdk = { ...lark, WSClient: class {
    constructor(value) { options = value; }
    async start() { await options.httpInstance.request({ method: 'POST', url: 'https://open.feishu.cn/callback/ws/endpoint', data: {} }); }
    close() {}
  } };
  const connection = createLarkConnection({ larkAppId: registered.appId, larkAppSecret: registered.appSecret }, {}, { sdk,
    send: async (_url, request) => { request.beforeConnect(); entered(); return new Promise(resolve => { resolveResponse = resolve; }); } });
  const started = connection.start(); await waiting; connection.close();
  resolveResponse({ status: 200, body: Buffer.from(JSON.stringify({ code: 0, data: { URL: 'wss://msg-frontier.feishu.cn/x' } })) });
  await assert.rejects(started, /stopped during discovery/);
});
