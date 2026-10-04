import { Store } from './store.js';
import { canonical, hash } from './common.js';

// Local route/idempotency evidence; Sites owns actual dot subscriptions/jobs.
// Never synthesize a local MCP subscription to make Sites delivery look ready.
export class SitesLedger extends Store {
  constructor(config) {
    super(config);
    this.db.exec(`CREATE TABLE IF NOT EXISTS sites_messages (
      id TEXT PRIMARY KEY, source_event_id TEXT UNIQUE NOT NULL, event_id TEXT UNIQUE NOT NULL,
      subscription_id TEXT NOT NULL, digest TEXT NOT NULL, payload TEXT, expires INTEGER NOT NULL,
      accepted INTEGER NOT NULL DEFAULT 0, reply_digest TEXT, reply_state TEXT);
      CREATE TABLE IF NOT EXISTS sites_claims (message_id TEXT PRIMARY KEY, claim_digest TEXT NOT NULL, payload TEXT, expires INTEGER NOT NULL);
      UPDATE sites_messages SET reply_state='uncertain' WHERE reply_state='processing';`);
  }
  prepare(message, subscriptionId, now) {
    return this.tx(() => {
      const digest = hash(canonical(message)), old = this.get('SELECT * FROM sites_messages WHERE id=? OR source_event_id=?', message.id, message.sourceEventId);
      if (old) {
        if (old.id !== message.id || old.digest !== digest || old.subscription_id !== subscriptionId) throw new Error('Sites message identity or subscription changed');
        return this.message(message.id);
      }
      if (this.get('SELECT count(*) AS n FROM sites_messages WHERE expires>?', now).n >= this.config.queueLimit) throw new Error('Sites local capacity reached');
      this.rate('sites_inbound', this.config.inboundPerMinute, now);
      const eventId = `evt_${hash(`${this.config.larkAppId}:${message.id}`)}`;
      this.run('INSERT INTO sites_messages(id,source_event_id,event_id,subscription_id,digest,payload,expires) VALUES (?,?,?,?,?,?,?)',
        message.id, message.sourceEventId, eventId, subscriptionId, digest, this.vault.seal(message, `sites-message:${message.id}`), message.expires);
      return this.message(message.id);
    });
  }
  message(id) {
    const row = this.get('SELECT * FROM sites_messages WHERE id=?', id);
    if (!row) return undefined;
    if (!row.payload) return undefined;
    const source = this.vault.open(row.payload, `sites-message:${id}`);
    return { ...source, event_id: row.event_id, occurred_at: source.timestamp, subscription_id: row.subscription_id,
      accepted: Boolean(row.accepted), reply_state: row.reply_state, tenant_key: source.tenantKey, chat_id: source.chatId };
  }
  accepted(id) { this.run('UPDATE sites_messages SET accepted=1 WHERE id=?', id); }
  reserveReply(job, now) {
    return this.tx(() => {
      const row = this.get('SELECT * FROM sites_messages WHERE id=?', job.message_id), digest = hash(job.text);
      if (!row || !row.accepted || row.subscription_id !== job.subscription_id || Date.parse(job.reply_deadline) !== row.expires) throw new Error('Sites reply not bound to a verified source');
      if (row.reply_digest && row.reply_digest !== digest) throw new Error('Sites reply conflicts with prior response');
      if (row.reply_state) return row.reply_state === 'processing' ? 'uncertain' : row.reply_state;
      if (row.expires <= now) return 'dead';
      this.rate('sites_reply', this.config.repliesPerMinute, now);
      this.run("UPDATE sites_messages SET reply_digest=?,reply_state='processing' WHERE id=?", digest, job.message_id);
      return 'processing';
    });
  }
  prune(now) {
    this.tx(() => {
      this.run('UPDATE sites_messages SET payload=NULL WHERE expires<?', now - this.config.textRetentionMs);
      this.run('DELETE FROM sites_claims WHERE expires<?', now - this.config.textRetentionMs);
    });
  }
  retainClaim(job) {
    const digest = hash(canonical(job)), existing = this.get('SELECT claim_digest FROM sites_claims WHERE message_id=?', job.message_id);
    if (existing && existing.claim_digest !== digest) throw new Error('Sites claim changed');
    if (!existing) this.run('INSERT INTO sites_claims(message_id,claim_digest,payload,expires) VALUES (?,?,?,?)',
      job.message_id, digest, this.vault.seal(job, `sites-claim:${job.message_id}`), Date.parse(job.claim_expires_at));
  }
  retainedClaim(now) {
    this.tx(() => {
      this.run("UPDATE sites_messages SET reply_state='uncertain' WHERE id IN (SELECT message_id FROM sites_claims WHERE expires<=?) AND (reply_state IS NULL OR reply_state='processing')", now);
      this.run('DELETE FROM sites_claims WHERE expires<=?', now);
    });
    const row = this.get('SELECT * FROM sites_claims ORDER BY expires,message_id LIMIT 1');
    return row ? this.vault.open(row.payload, `sites-claim:${row.message_id}`) : null;
  }
  releaseClaim(job) { this.run('DELETE FROM sites_claims WHERE message_id=? AND claim_digest=?', job.message_id, hash(canonical(job))); }
  finishReply(id, state) {
    if (!['sent', 'uncertain', 'dead'].includes(state)) throw new Error('Invalid Sites terminal reply state');
    this.run('UPDATE sites_messages SET reply_state=? WHERE id=?', state, id);
  }
}
