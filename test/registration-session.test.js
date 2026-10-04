import test from 'node:test';
import assert from 'node:assert/strict';
import { createRegistrationSession } from '../src/registration-session.js';

const fixtureSecret = 'fixture-app-secret-not-a-real-account';
test('show-code flow needs approval and cannot save or expose returned credentials', async () => {
  assert.throws(() => createRegistrationSession());
  const reports = []; let options;
  const session = createRegistrationSession({ approved: true, report: value => reports.push(value), sdk: { async registerApp(value) {
    options = value;
    value.onQRCodeReady({ url: 'https://accounts.feishu.cn/fixture-verify?request=fixture', expireIn: 600 });
    return { client_id: 'cli_0123456789abcdef', client_secret: fixtureSecret, user_info: { open_id: 'fixture-owner', tenant_brand: 'feishu' } };
  } } });
  await session.completion;
  assert.equal(options.createOnly, true); assert.equal(options.addons.preset, false);
  assert.deepEqual(options.addons.scopes.tenant, ['im:message.p2p_msg:readonly', 'im:message:send_as_bot']);
  assert.equal(options.addons.scopes.user, undefined);
  assert.equal(session.status().credentials_held_in_memory, true); assert.equal(session.status().credentials_saved, false);
  for (const secret of [fixtureSecret, 'cli_0123456789abcdef', 'fixture-owner']) assert.equal(JSON.stringify(reports).includes(secret), false);
  assert.throws(() => session.saveApproved({ credentialsFile: 'must-not-write', tenantKey: 'fixture-tenant' }));
  assert.deepEqual(Object.keys(session).sort(), ['completion', 'discard', 'probeApproved', 'saveApproved', 'saveUnboundApproved', 'status']);
  session.discard(); assert.equal(session.status().credentials_held_in_memory, false);
});
test('show-code flow rejects non-official or credential-bearing links and discards late credentials', async () => {
  for (const url of ['https://attacker.example/verify', `https://accounts.feishu.cn/verify?client_secret=${fixtureSecret}`]) {
    const reports = [];
    const session = createRegistrationSession({ approved: true, report: value => reports.push(value), sdk: { async registerApp(options) {
      options.onQRCodeReady({ url, expireIn: 600 });
      return { client_id: 'cli_0123456789abcdef', client_secret: fixtureSecret };
    } } });
    await session.completion; assert.equal(session.status().credentials_held_in_memory, false);
    assert.equal(JSON.stringify(reports).includes(url), false); assert.equal(JSON.stringify(reports).includes(fixtureSecret), false);
  }
});
test('show-code flow is abortable and does not print raw SDK errors', async () => {
  const reports = [];
  const session = createRegistrationSession({ approved: true, report: value => reports.push(value), sdk: { registerApp(options) {
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject({ code: 'abort', description: fixtureSecret })));
  } } });
  session.discard(); await session.completion;
  assert.equal(session.status().credentials_held_in_memory, false); assert.equal(JSON.stringify(reports).includes(fixtureSecret), false);
});

test('existing-app scan pins the approved ID and cannot silently create or return another application', async () => {
  const existingAppId = 'cli_0123456789abcdef';
  assert.throws(() => createRegistrationSession({ approved: true, existingAppId: 'bad' }));
  for (const returnedId of [existingAppId, 'cli_fedcba9876543210']) {
    const reports = [];
    const session = createRegistrationSession({ approved: true, existingAppId, report: value => reports.push(value), sdk: {
      async registerApp(options) {
        assert.equal(options.createOnly, false); assert.equal(options.appId, existingAppId);
        options.onQRCodeReady({ url: `https://accounts.feishu.cn/fixture?clientID=${existingAppId}`, expireIn: 600 });
        return { client_id: returnedId, client_secret: fixtureSecret };
      } } });
    await session.completion;
    assert.equal(session.status().credentials_held_in_memory, returnedId === existingAppId);
    assert.equal(JSON.stringify(reports).includes(fixtureSecret), false); session.discard();
  }
});

test('existing-app scan refuses missing, changed or overridden target before showing a link', async () => {
  const existingAppId = 'cli_0123456789abcdef';
  for (const query of ['', 'clientID=cli_fedcba9876543210', `clientID=${existingAppId}&createOnly=true`, `clientID=${existingAppId}&clientID=cli_fedcba9876543210`, `clientID=${existingAppId}&createOnly=false&createOnly=true`]) {
    const reports = [];
    const session = createRegistrationSession({ approved: true, existingAppId, report: value => reports.push(value), sdk: {
      async registerApp(options) { options.onQRCodeReady({ url: `https://accounts.feishu.cn/fixture?${query}`, expireIn: 600 }); } } });
    await session.completion;
    assert.equal(reports.some(value => value.verification_url), false); assert.equal(session.status().credentials_held_in_memory, false);
  }
});

test('registration startup that ignores AbortSignal remains bounded and cannot later display a code', async () => {
  let options;
  const reports = [];
  const session = createRegistrationSession({ approved: true, timeoutMs: 10, report: value => reports.push(value), sdk: {
    registerApp(value) { options = value; return new Promise(() => {}); } } });
  await session.completion; assert.equal(session.status().phase, 'abort');
  assert.throws(() => options.onQRCodeReady({ url: 'https://accounts.feishu.cn/fixture', expireIn: 600 }));
  assert.equal(reports.some(value => value.verification_url), false);
});

test('pending telemetry contains only counted allowlisted status and time, never descriptions or credentials', async () => {
  const session = createRegistrationSession({ approved: true, clock: () => Date.parse('2026-10-02T16:00:00Z'), sdk: {
    async registerApp(options) {
      options.onStatusChange({ status: 'polling', description: fixtureSecret, device_code: fixtureSecret });
      options.onStatusChange({ status: 'slow_down', interval: 99999, description: fixtureSecret });
      options.onStatusChange({ status: fixtureSecret, description: fixtureSecret });
      return { client_id: 'cli_0123456789abcdef', client_secret: fixtureSecret };
    } } });
  await session.completion;
  const status = session.status();
  assert.equal(status.poll_updates, 2); assert.equal(status.last_poll_status, 'slow_down');
  assert.equal(status.last_poll_at, '2026-10-02T16:00:00.000Z'); assert.equal(JSON.stringify(status).includes(fixtureSecret), false);
  session.discard();
});

test('memory-only probes require approval for selected bound and cannot overlap or outlive discard', async () => {
  let resolveProbe, seen;
  const session = createRegistrationSession({ approved: true, sdk: { async registerApp() { return { client_id: 'cli_0123456789abcdef', client_secret: fixtureSecret }; } },
    probe: async (_config, options) => { seen = options; return new Promise(resolve => { resolveProbe = resolve; }); } });
  await session.completion;
  await assert.rejects(session.probeApproved({ approved: true, timeoutMs: 60001 }));
  const running = session.probeApproved({ approved: true, timeoutMs: 60000 });
  assert.equal(seen.timeoutMs, 60000);
  await assert.rejects(session.probeApproved({ approved: true, timeoutMs: 60000 }));
  session.discard(); assert.equal(seen.signal.aborted, true); resolveProbe({ outcome: 'cancelled' }); await running;
  await assert.rejects(session.probeApproved({ approved: true }));
});

test('registration failure reports only fixed diagnostic categories, never arbitrary SDK error descriptions', async () => {
  for (const code of ['registration_timeout', fixtureSecret]) {
    const session = createRegistrationSession({ approved: true, sdk: { async registerApp() { throw Object.assign(new Error(fixtureSecret), { code }); } } });
    await session.completion;
    assert.equal(session.status().failure_code, code === 'registration_timeout' ? code : undefined);
    assert.equal(JSON.stringify(session.status()).includes(fixtureSecret), false);
  }
});
