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
  assert.deepEqual(Object.keys(session).sort(), ['completion', 'discard', 'saveApproved', 'status']);
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
