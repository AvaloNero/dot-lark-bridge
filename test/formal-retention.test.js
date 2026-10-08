import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { hash } from '../src/common.js';
import { config } from './helpers.js';
import { privateMkdtempSync, cleanupPrivateFixture, beforeFixtureCleanup } from '../../dot-qq-bridge/packages/dot-bridge-platform/test-fixtures.js';

const now = Date.parse('2026-10-08T00:00:00.000Z');
function policy(replySeconds, retentionSeconds) {
  const value = readConfig({ REPLY_TTL_SECONDS: String(replySeconds), TEXT_RETENTION_SECONDS: String(retentionSeconds) });
  return { replyTtlMs: value.replyTtlMs, textRetentionMs: value.textRetentionMs };
}
function fixture(t, timing) {
  const directory = privateMkdtempSync(path.join(os.tmpdir(), 'lark-retention-fixture-'));
  cleanupPrivateFixture(t, directory);
  let settings = config({ dbPath: path.join(directory, 'messages.sqlite'), ...timing }), store = new Store(settings);
  beforeFixtureCleanup(t, () => { store?.close(); store = undefined; });
  store.saveSubscription({ id: 'retention-subscription', principal: settings.principal,
    url: 'https://receiver.example/callback', secret: `whsec_${Buffer.alloc(32, 17).toString('base64')}`,
    expires: now + 86400000, verified_until: now + 86400000 }, now);
  return { get store() { return store; }, get settings() { return settings; },
    reopen(nextTiming = {}) { store.close(); store = undefined; settings = { ...settings, ...nextTiming }; store = new Store(settings); return store; } };
}
function addReply(f, id, received, replied) {
  const message = { id, sourceEventId: `source-${id}`, owner: f.settings.ownerOpenId,
    tenantKey: f.settings.tenantKey, chatId: f.settings.ownerChatId, text: `INCOMING_CANARY_${id}`,
    timestamp: new Date(received).toISOString(), expires: received + f.settings.replyTtlMs };
  assert.equal(f.store.ingest(message, `replay-${id}`, received), 'queued');
  f.store.run('UPDATE messages SET attempted_at=? WHERE id=?', received + 1, id);
  f.store.run("UPDATE jobs SET state='delivered' WHERE kind='event' AND message_id=?", id);
  const reply = `REPLY_CANARY_DIFFERENT_${id}`;
  assert.equal(f.store.queueReply(id, reply, f.settings.principal, replied).status, 'pending');
  return { message, reply };
}

test('retention configuration defaults to seven days, accepts bounds, and cannot precede reply expiry', () => {
  assert.equal(readConfig({}).textRetentionMs, 7 * 86400000);
  assert.deepEqual(policy(60, 60), { replyTtlMs: 60000, textRetentionMs: 60000 });
  assert.equal(policy(3600, 604800).textRetentionMs, 604800000);
  assert.equal(policy(3600, 3600).textRetentionMs, 3600000);
  for (const value of ['0', '59', '604801', '-1', '60.5', 'NaN', 'Infinity', 'invalid']) {
    assert.throws(() => readConfig({ TEXT_RETENTION_SECONDS: value, REPLY_TTL_SECONDS: '10' }), /TEXT_RETENTION_SECONDS/);
  }
  assert.throws(() => readConfig({ TEXT_RETENTION_SECONDS: '60' }), /must not be shorter/);
  assert.throws(() => policy(3600, 3599), /must not be shorter/);
});

test('multiple encrypted messages and distinct replies retain their own text ages and immutable expiry', t => {
  const f = fixture(t, policy(60, 60));
  const first = addReply(f, 'first', now, now + 5000);
  const second = addReply(f, 'second', now + 30000, now + 30001);
  for (const file of [f.settings.dbPath, f.settings.dbPath + '-wal']) {
    if (!fs.existsSync(file)) continue;
    const bytes = fs.readFileSync(file);
    for (const value of [first.message.text, first.reply, second.message.text, second.reply]) assert.equal(bytes.includes(Buffer.from(value)), false);
  }
  f.reopen();
  for (const item of [first, second]) {
    assert.equal(f.store.message(item.message.id).expires, item.message.expires);
    assert.equal(f.store.message(item.message.id).text, item.message.text);
    assert.equal(f.store.replyText(item.message.id), item.reply);
  }
  f.store.prune(now + 60000); // Exactly the retention duration is not beyond it.
  assert.equal(f.store.message('first').text, first.message.text);
  f.store.prune(now + 60001);
  assert.equal(f.store.message('first').text, null);
  assert.equal(f.store.replyText('first'), first.reply);
  assert.equal(f.store.message('second').text, second.message.text);
  assert.equal(f.store.replyText('second'), second.reply);
  assert.equal(f.store.replyStatus('second').status, 'pending');
  f.store.prune(now + 65001);
  assert.equal(f.store.replyText('first'), null);
  assert.equal(f.store.replyText('second'), second.reply);
  f.store.prune(now + 90001);
  assert.equal(f.store.message('second').text, null);
  assert.equal(f.store.replyText('second'), second.reply);
  f.store.prune(now + 90002);
  assert.equal(f.store.replyText('second'), null);
  f.reopen();
  for (const item of [first, second]) {
    const stored = f.store.message(item.message.id);
    assert.equal(stored.text, null); assert.equal(stored.expires, item.message.expires);
    assert.equal(stored.source_event_id, item.message.sourceEventId);
    assert.equal(f.store.get('SELECT digest FROM replies WHERE message_id=?', item.message.id).digest, hash(item.reply));
  }
});

test('shorter configuration after reopen never clears a pending reply before its original window ends', t => {
  const f = fixture(t, policy(180, 180));
  const item = addReply(f, 'old-window', now, now + 1);
  f.reopen(policy(60, 60));
  f.store.prune(now + 60002);
  assert.equal(f.store.message(item.message.id).expires, now + 180000);
  assert.equal(f.store.message(item.message.id).text, item.message.text);
  assert.equal(f.store.replyText(item.message.id), item.reply);
  assert.equal(f.store.queueReply(item.message.id, item.reply, f.settings.principal, now + 60002).status, 'pending');
  f.store.prune(now + 179999);
  assert.equal(f.store.replyText(item.message.id), item.reply);
  f.store.prune(now + 180000);
  assert.equal(f.store.message(item.message.id).text, null); assert.equal(f.store.replyText(item.message.id), null);
  assert.equal(f.store.message(item.message.id).expires, item.message.expires);
});

test('logical text pruning preserves message identifiers and reply digests after replay markers expire', t => {
  const f = fixture(t, policy(60, 60)), item = addReply(f, 'deduplicated', now, now + 1);
  f.store.prune(now + 600001);
  assert.equal(f.store.get('SELECT count(*) AS n FROM replays').n, 0);
  assert.equal(f.store.message(item.message.id).text, null); assert.equal(f.store.replyText(item.message.id), null);
  const messages = f.store.get('SELECT count(*) AS n FROM messages').n, jobs = f.store.get('SELECT count(*) AS n FROM jobs').n;
  assert.equal(f.store.ingest(item.message, 'new-replay-id', now + 600001), 'duplicate');
  assert.equal(f.store.ingest({ ...item.message, id: 'another-id' }, 'another-replay-id', now + 600001), 'duplicate');
  assert.equal(f.store.queueReply(item.message.id, item.reply, f.settings.principal, now + 600001).status, 'pending');
  assert.throws(() => f.store.queueReply(item.message.id, 'A different later reply', f.settings.principal, now + 600001), /already has a different reply/);
  assert.equal(f.store.get('SELECT count(*) AS n FROM messages').n, messages);
  assert.equal(f.store.get('SELECT count(*) AS n FROM jobs').n, jobs);
  assert.equal(f.store.get('SELECT digest FROM replies WHERE message_id=?', item.message.id).digest, hash(item.reply));
});
