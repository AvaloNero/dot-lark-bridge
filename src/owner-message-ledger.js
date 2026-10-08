import { destinationUrl } from './network.js';
import { webhookKey } from './signatures.js';
import { canonical, equal } from './common.js';

const KEY = 'owner_single_message:v1';
const CONTEXT = 'owner-single-message:v1';
const PRINCIPAL = 'tunnel-owner:dot-bridge';
const phases = Object.freeze({
  waiting: ['waiting', 'event_attempted', 'cancelled'],
  event_attempted: ['event_attempted', 'event_delivered', 'uncertain', 'cancelled'],
  event_delivered: ['event_delivered', 'reply_attempted', 'uncertain', 'cancelled'],
  reply_attempted: ['reply_attempted', 'sent', 'uncertain', 'cancelled'],
  sent: ['sent'], uncertain: ['uncertain'], cancelled: ['cancelled']
});
const failure = () => new Error('Owner-message checkpoint unavailable or rejected');

function fields(value, names) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw failure();
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(descriptors);
  if (keys.length !== names.length || keys.some(key => !names.includes(key) ||
      !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable)) throw failure();
}
function text(value, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max ||
      /[\x00-\x1f\x7f]/.test(value) || /\p{Surrogate}/u.test(value)) throw failure();
  return value;
}
function millis(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 8640000000000000) throw failure();
}
function validate(checkpoint) {
  fields(checkpoint, ['version', 'subscription', 'phase', 'message', 'updatedAt']);
  if (checkpoint.version !== 1 || typeof checkpoint.phase !== 'string' || !Object.hasOwn(phases, checkpoint.phase)) throw failure();
  millis(checkpoint.updatedAt);
  const sub = checkpoint.subscription;
  fields(sub, ['id', 'principal', 'url', 'secret', 'validUntil', 'verified']);
  if (!/^sub_[a-f0-9]{64}$/.test(text(sub.id, 68)) || sub.principal !== PRINCIPAL || sub.verified !== true) throw failure();
  const url = text(sub.url, 2048); destinationUrl(url, [new URL(url).hostname]);
  webhookKey(sub.secret); millis(sub.validUntil);
  const message = checkpoint.message;
  if (message !== null) {
    fields(message, ['id', 'sourceEventId', 'eventId', 'timestamp', 'expires']);
    text(message.id, 256); text(message.sourceEventId, 256);
    if (!/^evt_[a-f0-9]{64}$/.test(text(message.eventId, 68))) throw failure();
    text(message.timestamp, 32);
    const timestamp = Date.parse(message.timestamp); millis(timestamp); millis(message.expires);
    if (new Date(timestamp).toISOString() !== message.timestamp || message.expires <= timestamp) throw failure();
  }
  if (checkpoint.phase === 'waiting' ? message !== null : checkpoint.phase !== 'cancelled' && message === null) throw failure();
  return checkpoint;
}
function transition(previous, next) {
  if (!previous) {
    if (next.phase !== 'waiting') throw failure();
    return;
  }
  const a = previous.subscription, b = next.subscription;
  if (!phases[previous.phase].includes(next.phase) || next.updatedAt < previous.updatedAt ||
      a.id !== b.id || a.principal !== b.principal || a.url !== b.url || !equal(a.secret, b.secret)) throw failure();
  const renewing = previous.phase === 'waiting' && next.phase === 'waiting';
  if (renewing ? b.validUntil < a.validUntil : b.validUntil !== a.validUntil) throw failure();
  if (previous.message !== null && canonical(previous.message) !== canonical(next.message)) throw failure();
  if (previous.message === null && next.message !== null && next.phase !== 'event_attempted') throw failure();
}

// Reuses the Store's encrypted vault, owner binding and synchronous transaction.
// No message bodies or independent storage/credential lifecycle are introduced.
export function createOwnerMessageLedger(store) {
  try {
    if (store?.config?.principal !== PRINCIPAL || !['get', 'run', 'tx'].every(name => typeof store[name] === 'function') ||
        typeof store.vault?.seal !== 'function' || typeof store.vault?.open !== 'function') throw failure();
  } catch { throw failure(); }
  const read = () => {
    const row = store.get('SELECT value FROM metadata WHERE key=?', KEY);
    if (!row) return null;
    if (typeof row.value !== 'string' || row.value.length > 16384 || Buffer.from(row.value, 'base64').toString('base64') !== row.value) throw failure();
    return validate(store.vault.open(row.value, CONTEXT));
  };
  return Object.freeze({
    load() { try { return read(); } catch { throw failure(); } },
    save(checkpoint) {
      try {
        validate(checkpoint);
        store.tx(() => {
          transition(read(), checkpoint);
          const sealed = store.vault.seal(checkpoint, CONTEXT);
          store.run('INSERT INTO metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', KEY, sealed);
        });
      } catch { throw failure(); }
    }
  });
}
