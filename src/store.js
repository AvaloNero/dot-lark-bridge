import { validateLiveConfig } from './live-validation.js';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BridgeError, canonical, hash } from './common.js';
import { Vault } from './signatures.js';
import { windowsPrivateDatabase, windowsPrivateDirectory } from '../../dot-qq-bridge/packages/dot-bridge-platform/index.js';

export class Store {
  constructor(config) {
    validateLiveConfig(config);
    this.config = config;
    this.vault = new Vault(config.storageKey);
    if (config.dbPath !== ':memory:' && process.platform === 'win32') {
      if (config.authMode !== 'tunnel-service') windowsPrivateDirectory(path.dirname(config.dbPath), { create: true }).close();
      this.privatePath = windowsPrivateDatabase(config.dbPath, { create: true });
    } else if (config.dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(config.dbPath), { recursive: true, mode: 0o700 });
      if (!fs.existsSync(config.dbPath)) fs.closeSync(fs.openSync(config.dbPath, 'wx', 0o600));
    }
    try { this.db = new DatabaseSync(this.privatePath?.path ?? config.dbPath); }
    catch (error) { this.privatePath?.close(); throw error; }
    try {
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY, principal TEXT NOT NULL, callback TEXT NOT NULL, expires INTEGER NOT NULL,
        verified_until INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1, generation TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, source_event_id TEXT NOT NULL UNIQUE, event_id TEXT NOT NULL UNIQUE,
        principal TEXT NOT NULL, owner TEXT NOT NULL, subscription_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL, expires INTEGER NOT NULL, received INTEGER NOT NULL, text TEXT,
        outbound_id TEXT, attempted_at INTEGER, tenant_key TEXT NOT NULL, chat_id TEXT NOT NULL, generation TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS replies (
        message_id TEXT PRIMARY KEY REFERENCES messages(id), digest TEXT NOT NULL, text TEXT,
        created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, message_id TEXT NOT NULL REFERENCES messages(id),
        subscription_id TEXT NOT NULL REFERENCES subscriptions(id), state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, lease_until INTEGER,
        lease_token TEXT, last_error TEXT);
      CREATE INDEX IF NOT EXISTS due_jobs ON jobs(state,next_at);
      CREATE TABLE IF NOT EXISTS replays (id TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS rates (kind TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS rate_window ON rates(kind,at);`);
      const check = this.get('SELECT value FROM metadata WHERE key=?', 'vault');
      if (check) this.vault.open(check.value, 'metadata');
      else this.run('INSERT INTO metadata VALUES (?,?)', 'vault', this.vault.seal({ version: 1 }, 'metadata'));
      const mode = config.bridgeMode ?? 'tunnel';
      const storedMode = this.get('SELECT value FROM metadata WHERE key=?', 'bridge_mode');
      if (storedMode && storedMode.value !== mode) throw new Error('Database bridge mode differs; explicit migration required');
      if (!storedMode && mode === 'sites' && this.get('SELECT count(*) AS n FROM messages').n) throw new Error('Legacy tunnel messages require explicit migration');
      if (!storedMode) this.run('INSERT INTO metadata VALUES (?,?)', 'bridge_mode', mode);
      const binding = canonical({ app: config.larkAppId, owner: config.ownerOpenId, tenant: config.tenantKey, chat: config.ownerChatId, principal: config.principal });
      const existing = this.get('SELECT value FROM metadata WHERE key=?', 'binding');
      if (existing && existing.value !== binding) throw new Error('Stored owner/AppID/principal binding differs; do not reuse this database for a different identity');
      if (!existing && config.larkAppId && config.ownerOpenId && config.tenantKey && config.ownerChatId && config.principal) this.run('INSERT INTO metadata VALUES (?,?)', 'binding', binding);
    } catch (error) { try { this.db.close(); } finally { this.privatePath?.close(); } throw error; }
  }
  get(sql, ...params) { return this.db.prepare(sql).get(...params); }
  all(sql, ...params) { return this.db.prepare(sql).all(...params); }
  run(sql, ...params) { return this.db.prepare(sql).run(...params); }
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  subscription(id) {
    const row = this.get('SELECT * FROM subscriptions WHERE id=?', id);
    return row ? { ...row, ...this.vault.open(row.callback, `subscription:${id}`) } : undefined;
  }
  activeSubscription(now) {
    const row = this.get('SELECT id FROM subscriptions WHERE active=1 AND expires>? AND principal=?', now, this.config.principal);
    return row ? this.subscription(row.id) : undefined;
  }
  subscriptionEpoch(id) {
    return Number(this.get('SELECT value FROM metadata WHERE key=?', `subscription_epoch:${id}`)?.value ?? 0);
  }
  saveSubscription(subscription, now) {
    return this.tx(() => {
      if (subscription.expectedEpoch !== undefined && this.subscriptionEpoch(subscription.id) !== subscription.expectedEpoch) {
        throw new BridgeError('Subscription revoked during verification', { code: -32012 });
      }
      const other = this.get('SELECT id FROM subscriptions WHERE active=1 AND expires>? AND id<>?', now, subscription.id);
      if (other) throw new BridgeError('Only one current-dot subscription is allowed', { code: -32013, data: { limit: 'subscriptions', max: 1 } });
      const callback = this.vault.seal({ url: subscription.url, secret: subscription.secret,
        oldSecret: subscription.oldSecret ?? null, oldSecretUntil: subscription.oldSecretUntil ?? 0 }, `subscription:${subscription.id}`);
      const prior = this.get('SELECT active,expires,generation FROM subscriptions WHERE id=?', subscription.id);
      const generation = prior?.active && prior.expires > now ? prior.generation : randomUUID();
      this.run(`INSERT INTO subscriptions(id,principal,callback,expires,verified_until,active,generation) VALUES (?,?,?,?,?,1,?)
        ON CONFLICT(id) DO UPDATE SET callback=excluded.callback,expires=excluded.expires,verified_until=excluded.verified_until,active=1,generation=excluded.generation`,
        subscription.id, subscription.principal, callback, subscription.expires, subscription.verified_until, generation);
    });
  }
  unsubscribe(id) {
    this.tx(() => {
      this.run(`INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
        `subscription_epoch:${id}`, String(this.subscriptionEpoch(id) + 1));
      this.run('UPDATE subscriptions SET active=0 WHERE id=? AND principal=?', id, this.config.principal);
      this.run("UPDATE jobs SET state='cancelled',last_error='unsubscribed',lease_token=NULL WHERE subscription_id=? AND state IN ('pending','processing')", id);
    });
  }
  rate(kind, limit, now) {
    this.run('DELETE FROM rates WHERE at<=?', now - 60000);
    const count = this.get('SELECT count(*) AS n FROM rates WHERE kind=? AND at>?', kind, now - 60000).n;
    if (count >= limit) throw new BridgeError('Rate limit reached', { status: 429, code: -32013, retryable: true, data: { limit: kind, max: limit } });
    this.run('INSERT INTO rates VALUES (?,?)', kind, now);
  }
  capacity() {
    if (this.get("SELECT count(*) AS n FROM jobs WHERE state IN ('pending','processing')").n >= this.config.queueLimit) {
      throw new BridgeError('Queue capacity reached', { status: 503, code: -32013, retryable: true, data: { limit: 'queue', max: this.config.queueLimit } });
    }
  }
  ingest(message, replayId, now) {
    return this.tx(() => {
      this.run('DELETE FROM replays WHERE expires<?', now);
      if (this.get('SELECT id FROM replays WHERE id=?', replayId) || this.get('SELECT id FROM messages WHERE id=? OR source_event_id=?', message.id, message.sourceEventId)) return 'duplicate';
      const subscription = this.activeSubscription(now);
      if (!subscription) throw new BridgeError('No active current-dot subscription', { status: 503 });
      this.capacity();
      this.rate('inbound', this.config.inboundPerMinute, now);
      const eventId = `evt_${hash(`${this.config.larkAppId}:${message.id}`)}`;
      this.run(`INSERT INTO messages(id,source_event_id,event_id,principal,owner,subscription_id,occurred_at,expires,received,text,tenant_key,chat_id,generation)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, message.id, message.sourceEventId, eventId, this.config.principal,
        message.owner, subscription.id, message.timestamp, message.expires, now, this.vault.seal(message.text, `message:${message.id}`),
        message.tenantKey, message.chatId, subscription.generation);
      this.run('INSERT INTO jobs(id,kind,message_id,subscription_id,next_at) VALUES (?,?,?,?,?)', `event:${eventId}`, 'event', message.id, subscription.id, now);
      this.run('INSERT INTO replays VALUES (?,?)', replayId, now + 600000);
      return 'queued';
    });
  }
  message(id) {
    const row = this.get('SELECT * FROM messages WHERE id=?', id);
    return row ? { ...row, text: row.text ? this.vault.open(row.text, `message:${id}`) : null } : undefined;
  }
  authorizeMessage(id, principal, now) {
    const message = this.message(id), subscription = message && this.subscription(message.subscription_id);
    if (!message || message.principal !== principal || message.owner !== this.config.ownerOpenId || !subscription?.active ||
        subscription.expires <= now || subscription.principal !== principal || message.generation !== subscription.generation ||
        message.tenant_key !== this.config.tenantKey || message.chat_id !== this.config.ownerChatId || !message.attempted_at) {
      throw new BridgeError('Message unavailable to this subscription', { code: -32012 });
    }
    return message;
  }
  queueReply(id, text, principal, now) {
    return this.tx(() => {
      const message = this.authorizeMessage(id, principal, now);
      const previous = this.get('SELECT digest FROM replies WHERE message_id=?', id);
      if (previous) {
        if (previous.digest !== hash(text)) throw new BridgeError('This message already has a different reply');
        return this.replyStatus(id);
      }
      if (message.expires <= now) throw new BridgeError('Bridge reply deadline expired');
      this.capacity();
      this.run('INSERT INTO replies VALUES (?,?,?,?)', id, hash(text), this.vault.seal(text, `reply:${id}`), now);
      this.run('INSERT INTO jobs(id,kind,message_id,subscription_id,next_at) VALUES (?,?,?,?,?)', `reply:${id}`, 'reply', id, message.subscription_id, now);
      return this.replyStatus(id);
    });
  }
  replyStatus(id) {
    const row = this.get("SELECT state,last_error FROM jobs WHERE id=? AND kind='reply'", `reply:${id}`);
    return { message_id: id, status: row?.state ?? 'none', error: row?.last_error ?? null };
  }
  claim(now) {
    return this.tx(() => {
      // A crashed event delivery can be retried by eventId. A crashed Feishu reply is ambiguous.
      this.run("UPDATE jobs SET state='uncertain',last_error='worker_interrupted' WHERE kind='reply' AND state='processing' AND lease_until<=?", now);
      this.run("UPDATE jobs SET state='pending',lease_token=NULL WHERE kind='event' AND state='processing' AND lease_until<=?", now);
      const job = this.get("SELECT * FROM jobs WHERE state='pending' AND next_at<=? ORDER BY next_at,id LIMIT 1", now);
      if (!job) return undefined;
      const token = randomUUID();
      this.run("UPDATE jobs SET state='processing',attempts=attempts+1,lease_until=?,lease_token=? WHERE id=?", now + this.config.leaseMs, token, job.id);
      return { ...job, attempts: job.attempts + 1, lease_token: token };
    });
  }
  finish(job, state, reason = null, next = 0) {
    this.run("UPDATE jobs SET state=?,last_error=?,next_at=?,lease_until=NULL,lease_token=NULL WHERE id=? AND lease_token=? AND state='processing'", state, reason, next, job.id, job.lease_token);
  }
  replyText(id) {
    const row = this.get('SELECT text FROM replies WHERE message_id=?', id);
    return row?.text ? this.vault.open(row.text, `reply:${id}`) : null;
  }
  recordReplyAck(job, outboundId) {
    // Revocation cannot undo an HTTP request already on the wire. Record its
    // positive acknowledgement even if unsubscribe cancelled the local lease.
    this.tx(() => {
      this.run('UPDATE messages SET outbound_id=? WHERE id=?', outboundId, job.message_id);
      this.run("UPDATE jobs SET state='sent',last_error=NULL,lease_until=NULL,lease_token=NULL WHERE id=? AND kind='reply'", job.id);
    });
  }
  prune(now) {
    this.tx(() => {
      const cutoff = now - this.config.textRetentionMs;
      this.run('UPDATE messages SET text=NULL WHERE received<? AND expires<?', cutoff, now);
      this.run('UPDATE replies SET text=NULL WHERE created<?', cutoff);
      // Tombstones intentionally survive text deletion to preserve durable deduplication.
      this.run('DELETE FROM replays WHERE expires<?', now);
      this.run('DELETE FROM rates WHERE at<=?', now - 60000);
    });
  }
  close() { try { this.db.close(); } finally { this.privatePath?.close(); } }
}
