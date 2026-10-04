import { privateMkdtempSync, fixtureChmodSync, assertPrivateFixture } from '../../dot-qq-bridge/packages/dot-bridge-platform/test-fixtures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { enrollExistingApp } from '../src/enrollment.js';
import { loadCredentials } from '../src/credentials.js';
const appId = 'cli_0123456789abcdef', secret = 'fixture-app-secret-never-real';
function temporary() { const directory = privateMkdtempSync(path.join(os.tmpdir(), 'lark-enroll-fixture-')); fixtureChmodSync(directory, 0o700); return directory; }

test('persistent enrollment checks both approvals and destination before registration', async () => {
  const directory = temporary(), credentialsFile = path.join(directory, 'registered.json'); let calls = 0;
  const sdk = { async registerApp() { calls++; } };
  try {
    await assert.rejects(enrollExistingApp({ appId, tenantKey: 'fixture-tenant', credentialsFile, approvedScan: true, sdk }));
    fs.writeFileSync(credentialsFile, 'existing', { mode: 0o600 });
    await assert.rejects(enrollExistingApp({ appId, tenantKey: 'fixture-tenant', credentialsFile, approvedScan: true, approvedStorage: true, sdk }));
    assert.equal(calls, 0); assert.equal(fs.readFileSync(credentialsFile, 'utf8'), 'existing');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('enrollment saves exactly approved existing-app credentials privately and never starts service or claims encryption', async () => {
  const directory = temporary(), credentialsFile = path.join(directory, 'registered.json'), reports = [];
  try {
    const result = await enrollExistingApp({ appId, tenantKey: 'fixture-tenant', credentialsFile, approvedScan: true, approvedStorage: true,
      report: value => reports.push(value), sdk: { async registerApp(options) {
        assert.equal(options.appId, appId); assert.equal(options.createOnly, false);
        return { client_id: appId, client_secret: secret, user_info: { open_id: 'fixture-owner' } };
      } } });
    assert.equal(result.enrollment_completed, true); assert.equal(result.service_started, false); assert.equal(result.pairing_required, true);
    assert.equal(result.storage_protection, 'private_file_permissions_not_encryption');
    assertPrivateFixture(assert, credentialsFile, 0o600); assert.equal(loadCredentials(credentialsFile).appSecret, secret);
    assert.throws(() => loadCredentials(credentialsFile, { paired: true }));
    assert.equal(JSON.stringify(reports).includes(secret), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('wrong app or cancelled grant cannot write approved storage', async () => {
  const directory = temporary(), credentialsFile = path.join(directory, 'registered.json');
  try {
    const result = await enrollExistingApp({ appId, tenantKey: 'fixture-tenant', credentialsFile, approvedScan: true, approvedStorage: true,
      sdk: { async registerApp() { return { client_id: 'cli_fedcba9876543210', client_secret: secret }; } } });
    assert.equal(result.credentials_saved, false); assert.equal(fs.existsSync(credentialsFile), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('explicit unbound enrollment saves credentials without inventing tenant and cannot start paired service', async () => {
  const directory = temporary(), credentialsFile = path.join(directory, 'unbound.json');
  try {
    const input = { appId, credentialsFile, approvedScan: true, approvedStorage: true,
      sdk: { async registerApp() { return { client_id: appId, client_secret: secret }; } } };
    await assert.rejects(enrollExistingApp(input)); assert.equal(fs.existsSync(credentialsFile), false);
    const result = await enrollExistingApp({ ...input, allowUnbound: true });
    assert.equal(result.credentials_saved, true); assert.equal(result.tenant_binding_required, true);
    const credentials = loadCredentials(credentialsFile);
    assert.equal(credentials.status, 'unbound'); assert.equal(credentials.tenantKey, undefined);
    assert.throws(() => loadCredentials(credentialsFile, { paired: true }));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
