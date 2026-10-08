import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Vault } from '../src/signatures.js';
import { config } from './helpers.js';
import { createOwnerMessageLedger } from '../src/owner-message-ledger.js';
import { privateMkdtempSync, cleanupPrivateFixture, beforeFixtureCleanup } from '../../dot-qq-bridge/packages/dot-bridge-platform/test-fixtures.js';

const key = 'owner_single_message:v1', context = 'owner-single-message:v1';
const now = Date.parse('2026-10-08T00:00:00.000Z');
const message = { id: 'MESSAGE_ID_CANARY_89301', sourceEventId: 'SOURCE_ID_CANARY_98214', eventId: `evt_${'a'.repeat(64)}`,
  timestamp: new Date(now).toISOString(), expires: now + 300000 };
const initial = () => ({ version: 1, subscription: { id: `sub_${'b'.repeat(64)}`, principal: 'tunnel-owner:dot-bridge',
  url: 'https://receiver.example/URL_CANARY_12894', secret: `whsec_${Buffer.alloc(32, 21).toString('base64')}`,
  validUntil: now + 3600000, verified: true }, phase: 'waiting', message: null, updatedAt: now });
const advance = (value, phase) => ({ ...structuredClone(value), phase, message: phase === 'waiting' ? null : structuredClone(message), updatedAt: value.updatedAt + 1 });
const safeError = error => error.constructor === Error && error.message === 'Owner-message checkpoint unavailable or rejected' && !Object.hasOwn(error, 'cause');
function fixture(t) {
  const directory = privateMkdtempSync(path.join(os.tmpdir(), 'owner-ledger-fixture-')); cleanupPrivateFixture(t, directory);
  const settings = config({ dbPath: path.join(directory, 'checkpoint.sqlite'), principal: 'tunnel-owner:dot-bridge' });
  let store = new Store(settings);
  beforeFixtureCleanup(t, () => { store?.close(); store = undefined; });
  return { settings, get store() { return store; }, close() { store.close(); store = undefined; },
    reopen() { store = new Store(settings); return store; } };
}

test('encrypted checkpoint survives close/reopen without body, callback or message identifiers in storage', t => {
  const f = fixture(t); let ledger = createOwnerMessageLedger(f.store); assert.equal(ledger.load(), null);
  const waiting = initial(); ledger.save(waiting); const attempted = advance(waiting, 'event_attempted'); ledger.save(attempted);
  const delivered = advance(attempted, 'event_delivered'); ledger.save(delivered);
  const body = 'BODY_CANARY_NOT_PERMITTED_19384';
  assert.throws(() => ledger.save({ ...delivered, body }), safeError);
  for (const file of [f.settings.dbPath, f.settings.dbPath + '-wal', f.settings.dbPath + '-shm']) {
    if (!fs.existsSync(file)) continue;
    const bytes = fs.readFileSync(file);
    for (const canary of [waiting.subscription.url, waiting.subscription.secret, waiting.subscription.id, ...Object.values(message).filter(v => typeof v === 'string' && v !== message.timestamp), body]) {
      assert.equal(bytes.includes(Buffer.from(canary)), false);
    }
  }
  f.close(); ledger = createOwnerMessageLedger(f.reopen()); assert.deepEqual(ledger.load(), delivered);
  const claimed = advance(delivered, 'reply_attempted'); ledger.save(claimed); ledger.save(advance(claimed, 'sent'));
  assert.equal(ledger.load().phase, 'sent');
});

test('waiting lease may renew after expiry with the identical subscription and secret only', t => {
  const f = fixture(t), ledger = createOwnerMessageLedger(f.store), waiting = initial();
  waiting.subscription.validUntil = now - 1; ledger.save(waiting);
  const renewed = structuredClone(waiting); renewed.subscription.validUntil = now + 60000; renewed.updatedAt++;
  ledger.save(renewed); assert.deepEqual(ledger.load(), renewed);
  for (const mutate of [s => s.id = `sub_${'c'.repeat(64)}`, s => s.url += '/other', s => s.principal = 'stranger',
    s => s.secret = `whsec_${Buffer.alloc(32, 22).toString('base64')}`, s => s.validUntil--]) {
    const next = structuredClone(renewed); mutate(next.subscription); assert.throws(() => ledger.save(next), safeError);
  }
  const attempted = advance(renewed, 'event_attempted'); ledger.save(attempted);
  const extended = structuredClone(attempted); extended.subscription.validUntil++;
  assert.throws(() => ledger.save(extended), safeError); assert.deepEqual(ledger.load(), attempted);
});

test('phase, immutable message and terminal checkpoints cannot reset one-message budgets', t => {
  const f = fixture(t), ledger = createOwnerMessageLedger(f.store), waiting = initial();
  assert.throws(() => ledger.save(advance(waiting, 'event_delivered')), safeError); ledger.save(waiting);
  const attempted = advance(waiting, 'event_attempted'); ledger.save(attempted);
  assert.throws(() => ledger.save({ ...waiting, updatedAt: attempted.updatedAt + 1 }), safeError);
  assert.throws(() => ledger.save(advance(attempted, 'sent')), safeError);
  for (const name of ['id', 'sourceEventId', 'eventId', 'timestamp', 'expires']) {
    const changed = structuredClone(attempted); changed.updatedAt++;
    changed.message[name] = name === 'expires' ? message.expires + 1 : name === 'timestamp' ? new Date(now + 1).toISOString() : name === 'eventId' ? `evt_${'d'.repeat(64)}` : `${message[name]}_other`;
    assert.throws(() => ledger.save(changed), safeError);
  }
  const uncertain = advance(attempted, 'uncertain'); ledger.save(uncertain); ledger.save(uncertain);
  for (const phase of ['waiting', 'event_attempted', 'event_delivered', 'reply_attempted', 'sent', 'cancelled']) {
    assert.throws(() => ledger.save(advance(uncertain, phase)), safeError);
  }
  assert.deepEqual(ledger.load(), uncertain);
});

test('strict schema rejects extra fields, invalid routes, identifiers, timestamps and getters', t => {
  const f = fixture(t), ledger = createOwnerMessageLedger(f.store), waiting = initial();
  const mutations = [x => x.extra = 'BODY_CANARY', x => x.version = 2, x => x.phase = ['waiting'], x => x.updatedAt = NaN, x => x.updatedAt = 1.5,
    x => x.subscription.body = 'BODY_CANARY', x => x.subscription.verified = false, x => x.subscription.id = 'bad',
    x => x.subscription.url = 'http://receiver.example/cb', x => x.subscription.url = 'https://127.0.0.1/cb',
    x => x.subscription.secret = 'secret', x => x.subscription.validUntil = Infinity,
    x => Object.defineProperty(x, 'phase', { get() { assert.fail('Getter must not execute'); }, enumerable: true }),
    x => x[Symbol('hidden')] = 'BODY_CANARY'];
  for (const mutate of mutations) { const value = structuredClone(waiting); mutate(value); assert.throws(() => ledger.save(value), safeError); }
  assert.equal(ledger.load(), null); ledger.save(waiting);
  for (const mutate of [m => m.text = 'BODY_CANARY', m => m.id = 'x\nprivate', m => m.sourceEventId = 'x'.repeat(257),
    m => m.eventId = 'bad', m => m.timestamp = 'invalid', m => m.expires = now, m => m.expires = 1.5]) {
    const value = advance(waiting, 'event_attempted'); mutate(value.message); assert.throws(() => ledger.save(value), safeError);
  }
  assert.deepEqual(ledger.load(), waiting);
});

test('tampered ciphertext, wrong vault keys and invalid decrypted schema fail with fixed errors', t => {
  const f = fixture(t), ledger = createOwnerMessageLedger(f.store), waiting = initial(); ledger.save(waiting);
  const encrypted = f.store.get('SELECT value FROM metadata WHERE key=?', key).value, vault = f.store.vault;
  f.store.vault = new Vault(Buffer.alloc(32, 99).toString('base64'));
  assert.throws(() => ledger.load(), safeError); assert.throws(() => ledger.save(waiting), safeError); f.store.vault = vault;
  const tampered = Buffer.from(encrypted, 'base64'); tampered[tampered.length - 1] ^= 1;
  for (const value of [tampered.toString('base64'), 'PRIVATE_SQLITE_CANARY', vault.seal({ ...waiting, body: 'BODY_CANARY' }, context), vault.seal(waiting, 'wrong-context')]) {
    f.store.run('UPDATE metadata SET value=? WHERE key=?', value, key);
    assert.throws(() => ledger.load(), safeError); assert.throws(() => ledger.save(waiting), safeError);
  }
});

test('Store binding prevents another owner or application from reopening the checkpoint database', t => {
  const f = fixture(t), waiting = initial(); createOwnerMessageLedger(f.store).save(waiting); f.close();
  for (const delta of [{ ownerOpenId: 'other-owner' }, { larkAppId: 'other-app' }, { tenantKey: 'other-tenant' },
    { ownerChatId: 'other-chat' }, { principal: 'other-principal' }, { storageKey: Buffer.alloc(32, 77).toString('base64') }]) {
    assert.throws(() => new Store({ ...f.settings, ...delta }));
  }
  assert.deepEqual(createOwnerMessageLedger(f.reopen()).load(), waiting);
});

test('write failure rolls back the actual SQLite transaction and never reports success', t => {
  const f = fixture(t), ledger = createOwnerMessageLedger(f.store), waiting = initial(); ledger.save(waiting);
  const previousCiphertext = f.store.get('SELECT value FROM metadata WHERE key=?', key).value;
  const run = f.store.run;
  f.store.run = function (...args) { const value = run.apply(this, args); throw new Error(`PRIVATE_SQLITE_CANARY_${value.changes}`); };
  assert.throws(() => ledger.save(advance(waiting, 'event_attempted')), safeError); f.store.run = run;
  assert.equal(f.store.get('SELECT value FROM metadata WHERE key=?', key).value, previousCiphertext);
  assert.deepEqual(ledger.load(), waiting); ledger.save(advance(waiting, 'event_attempted')); assert.equal(ledger.load().phase, 'event_attempted');
  f.close(); assert.throws(() => ledger.load(), safeError); assert.throws(() => ledger.save(waiting), safeError);
});

test('cancelling an empty waiting checkpoint preserves a terminal empty tombstone', t => {
  const f = fixture(t), ledger = createOwnerMessageLedger(f.store), waiting = initial(); ledger.save(waiting);
  const cancelled = { ...waiting, phase: 'cancelled', updatedAt: now + 1 }; ledger.save(cancelled);
  assert.equal(ledger.load().message, null); assert.throws(() => ledger.save({ ...waiting, updatedAt: now + 2 }), safeError);
  const older = { ...cancelled, updatedAt: now }; assert.throws(() => ledger.save(older), safeError);
});
