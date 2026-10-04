import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config, larkPayload } from './helpers.js';
import { createSitesClient } from '../src/sites-client.js';
import { createSitesRuntime } from '../src/sites-runtime.js';
import { SitesLedger } from '../src/sites-ledger.js';
import { Store } from '../src/store.js';
import { acquireModeLock } from '../src/bridge-mode.js';
import { BridgeError } from '../src/common.js';

function fixture() {
  let now = Date.parse('2026-10-02T16:00:00Z'), subscription = 'sub_fixture_1', allowed = true, epoch = 0, job;
  const settings = config({ bridgeMode: 'sites', authMode: 'deny', principal: 'binding_fixture', sitesOrigin: 'https://queue.example.com', sitesBindingId: 'binding_fixture',
    sitesPlatformToken: 'fixture-platform-token-never-real', sitesConnectorToken: 'fixture-connector-token-never-real' });
  const requests = [], ingested = [], acks = [];
  const send = async (url, options) => {
    options.beforeConnect?.(); const body = JSON.parse(options.body.toString()); requests.push({ url, body, headers: options.headers });
    assert.equal(body.binding_id, settings.sitesBindingId); assert.equal(body.owner, undefined);
    assert.equal(options.purpose, undefined); assert.equal(options.headers['OAI-Sites-Authorization'], `Bearer ${settings.sitesPlatformToken}`);
    const response = value => ({ status: 200, body: Buffer.from(JSON.stringify(value)) });
    if (!allowed) return { status: 409, body: Buffer.from('{}') };
    if (url.endsWith('/bridge/lease')) return response({ binding_id: settings.sitesBindingId, channel: 'lark', mode: 'sites', subscription_active: true,
      subscription_id: subscription, lease_token: `lease_fixture_${epoch}`, expires_at: new Date(now + 90000).toISOString() });
    assert.equal(body.lease_token, `lease_fixture_${epoch}`);
    if (url.endsWith('/bridge/inbox')) { assert.equal(body.subscription_id, subscription); ingested.push(body); return response({ message_id: body.message_id, status: 'accepted' }); }
    if (url.endsWith('/bridge/outbox/claim')) return response({ job: job ?? null });
    if (url.endsWith('/bridge/outbox/ack')) { acks.push(body); return response({ message_id: body.message_id, status: body.status, error: null }); }
    assert.fail('Unexpected network route');
  };
  return { settings, send, requests, ingested, acks, now: () => now, advance(ms) { now += ms; }, revoke() { allowed = false; },
    resubscribe() { epoch++; subscription = `sub_fixture_${epoch + 1}`; },
    reply(message, text = 'fixture answer') { job = { message_id: message.id, subscription_id: subscription, claim_token: 'claim_fixture', text,
      reply_deadline: new Date(message.expires).toISOString(), claim_expires_at: new Date(now + 60000).toISOString() }; }, clearReply() { job = undefined; } };
}

test('Sites uses fixed outbound-only routes, dual auth and subscription-bound verified owner messages/replies', async () => {
  const f = fixture(), client = createSitesClient(f.settings, { send: f.send, clock: f.now }), ledger = new SitesLedger(f.settings);
  let starts = 0, closes = 0, sends = 0;
  const runtime = createSitesRuntime(f.settings, { clock: f.now, client, ledger, connectionFactory() { return { async start() { starts++; }, status: () => 'connected', close() { closes++; } }; },
    sender: async (message, text, { authorize }) => { authorize(); assert.equal(message.chat_id, f.settings.ownerChatId); assert.equal(text, 'fixture answer'); sends++; return 'fixture-outbound'; } });
  try {
    assert.equal(runtime.server, undefined); await runtime.tick(); assert.equal(starts, 1); assert.equal(runtime.readiness().end_to_end_verified, false);
    const data = larkPayload(f.now()); await runtime.dispatcher.invoke(data, { needCheck: false });
    assert.equal(f.ingested.length, 1); assert.equal(f.ingested[0].subscription_id, 'sub_fixture_1');
    const message = ledger.message(data.event.message.message_id); f.reply(message); await runtime.tick();
    assert.equal(sends, 1); assert.equal(f.acks.at(-1).status, 'sent'); await runtime.tick(); assert.equal(sends, 1);
    const attacker = larkPayload(f.now(), { message_id: 'attacker-message' }); attacker.event.sender.sender_id.open_id = 'attacker';
    await runtime.dispatcher.invoke(attacker, { needCheck: false }); assert.equal(f.ingested.length, 1);
  } finally { await runtime.close(); }
  assert.equal(closes, 1);
});

test('Sites lease revocation blocks ingest and reply, and re-subscription cannot reuse old verified messages', async () => {
  const f = fixture(), client = createSitesClient(f.settings, { send: f.send, clock: f.now }), ledger = new SitesLedger(f.settings);
  const runtime = createSitesRuntime(f.settings, { clock: f.now, client, ledger, connectionFactory() { return { async start() {}, status: () => 'connected', close() {} }; }, sender: () => assert.fail('Must not send') });
  try {
    await runtime.tick(); const data = larkPayload(f.now()); await runtime.dispatcher.invoke(data, { needCheck: false });
    const message = ledger.message(data.event.message.message_id); f.resubscribe(); await client.renew(); f.reply(message); await runtime.tick();
    assert.equal(f.acks.length, 0); await assert.rejects(runtime.dispatcher.invoke(data, { needCheck: false }));
    f.revoke(); f.advance(30000); await runtime.tick(); assert.equal(runtime.readiness().ready_for_delivery, false);
    await assert.rejects(runtime.dispatcher.invoke(larkPayload(f.now(), { message_id: 'new-message' }), { needCheck: false }));
  } finally { await runtime.close(); }
});

test('uncertain provider sends are never repeated, even if remote ack was not consumed', async () => {
  const f = fixture(), client = createSitesClient(f.settings, { send: f.send, clock: f.now }), ledger = new SitesLedger(f.settings); let sends = 0;
  const runtime = createSitesRuntime(f.settings, { clock: f.now, client, ledger, connectionFactory() { return { async start() {}, status: () => 'connected', close() {} }; },
    sender: async () => { sends++; throw new BridgeError('Unknown acknowledgement', { uncertain: true }); } });
  try {
    await runtime.tick(); const data = larkPayload(f.now()); await runtime.dispatcher.invoke(data, { needCheck: false }); f.reply(ledger.message(data.event.message.message_id));
    await runtime.tick(); await runtime.tick(); assert.equal(sends, 1); assert.equal(f.acks.at(-1).status, 'uncertain');
  } finally { await runtime.close(); }
});

test('shared app lock fences tunnel and Sites independent of database and refuses automatic stale takeover', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-mode-lock-')); fs.chmodSync(dir, 0o700);
  try {
    const release = acquireModeLock(dir, 'lark', 'fixture-app', 'tunnel');
    assert.throws(() => acquireModeLock(dir, 'lark', 'fixture-app', 'sites')); release(); release();
    const releaseSites = acquireModeLock(dir, 'lark', 'fixture-app', 'sites'); releaseSites();
    fs.chmodSync(dir, 0o755); assert.throws(() => acquireModeLock(dir, 'lark', 'fixture-app', 'sites'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('persistent DB refuses mode switching even for same owner tuple', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-mode-db-')), dbPath = path.join(dir, 'bridge.sqlite');
  try { const settings = config({ bridgeMode: 'tunnel', dbPath }); const db = new Store(settings); db.close(); assert.throws(() => new Store({ ...settings, bridgeMode: 'sites' }), /mode differs/); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('one-shot claim survives failed acknowledgement and retries only ACK, never provider send', async () => {
  const f = fixture(); let claimCalls = 0, ackCalls = 0, sends = 0;
  const send = async (url, options) => {
    if (url.endsWith('/bridge/outbox/claim')) { claimCalls++; if (claimCalls > 2) return { status: 200, body: Buffer.from('{"job":null}') }; }
    if (url.endsWith('/bridge/outbox/ack') && ++ackCalls === 1) throw new Error('fixture response lost');
    return f.send(url, options);
  };
  const client = createSitesClient(f.settings, { send, clock: f.now }), ledger = new SitesLedger(f.settings);
  const runtime = createSitesRuntime(f.settings, { clock: f.now, client, ledger, connectionFactory() { return { async start() {}, status: () => 'connected', close() {} }; }, sender: async () => { sends++; return 'fixture-outbound'; } });
  try {
    await runtime.tick(); const data = larkPayload(f.now()); await runtime.dispatcher.invoke(data, { needCheck: false }); f.reply(ledger.message(data.event.message.message_id));
    await runtime.tick(); assert.equal(sends, 1); assert.ok(ledger.retainedClaim(f.now()));
    await runtime.tick(); assert.equal(sends, 1); assert.equal(ackCalls, 2); assert.equal(claimCalls, 2); assert.equal(ledger.retainedClaim(f.now()), null);
  } finally { await runtime.close(); }
});

test('shutdown drains already-started ingest before closing ledger or releasing service mode lock', async () => {
  const f = fixture(); let release, entered, ledgerClosed = false;
  const waiting = new Promise(resolve => { entered = resolve; });
  const send = async (url, options) => {
    if (url.endsWith('/bridge/inbox')) { entered(); await new Promise(resolve => { release = resolve; }); }
    return f.send(url, options);
  };
  const client = createSitesClient(f.settings, { send, clock: f.now }), ledger = new SitesLedger(f.settings);
  const originalClose = ledger.close.bind(ledger); ledger.close = () => { ledgerClosed = true; originalClose(); };
  const runtime = createSitesRuntime(f.settings, { clock: f.now, client, ledger, connectionFactory() { return { async start() {}, status: () => 'connected', close() {} }; } });
  await runtime.tick(); const incoming = runtime.dispatcher.invoke(larkPayload(f.now()), { needCheck: false });
  const rejected = assert.rejects(incoming); await waiting;
  let closed = false; const stopping = runtime.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false); assert.equal(ledgerClosed, false);
  release(); await rejected; await stopping; assert.equal(ledgerClosed, true); assert.equal(closed, true);
});

test('expired retained claim becomes uncertain without another provider send', async () => {
  const f = fixture(), client = createSitesClient(f.settings, { send: f.send, clock: f.now }), ledger = new SitesLedger(f.settings);
  const data = larkPayload(f.now());
  await client.renew();
  const message = { id: data.event.message.message_id, sourceEventId: data.header.event_id, owner: f.settings.ownerOpenId,
    tenantKey: f.settings.tenantKey, chatId: f.settings.ownerChatId, text: 'fixture', timestamp: new Date(f.now()).toISOString(), expires: f.now() + 900000 };
  ledger.prepare(message, client.active().id, f.now()); ledger.accepted(message.id);
  const job = { message_id: message.id, subscription_id: client.active().id, claim_token: 'fixture_claim', text: 'fixture reply',
    reply_deadline: new Date(message.expires).toISOString(), claim_expires_at: new Date(f.now() + 1000).toISOString() };
  ledger.retainClaim(job); assert.equal(ledger.reserveReply(job, f.now()), 'processing'); f.advance(1001);
  assert.equal(ledger.retainedClaim(f.now()), null); assert.equal(ledger.message(message.id).reply_state, 'uncertain'); ledger.close();
});

test('restarting after provider send retains encrypted claim and resumes only its ACK', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-sites-restart-')), dbPath = path.join(dir, 'sites.sqlite');
  const f = fixture(); f.settings.dbPath = dbPath; let ledger = new SitesLedger(f.settings);
  const data = larkPayload(f.now()), source = { id: data.event.message.message_id, sourceEventId: data.header.event_id, owner: f.settings.ownerOpenId,
    tenantKey: f.settings.tenantKey, chatId: f.settings.ownerChatId, text: 'fixture private body', timestamp: new Date(f.now()).toISOString(), expires: f.now() + 900000 };
  const job = { message_id: source.id, subscription_id: 'sub_fixture_1', claim_token: 'fixture_claim_private', text: 'fixture private reply',
    reply_deadline: new Date(source.expires).toISOString(), claim_expires_at: new Date(f.now() + 60000).toISOString() };
  ledger.prepare(source, job.subscription_id, f.now()); ledger.accepted(source.id); ledger.retainClaim(job); ledger.reserveReply(job, f.now());
  const encrypted = ledger.get('SELECT payload FROM sites_claims').payload;
  assert.equal(encrypted.includes(job.claim_token), false); assert.equal(encrypted.includes(job.text), false); ledger.close();
  ledger = new SitesLedger(f.settings); assert.equal(ledger.message(source.id).reply_state, 'uncertain');
  let sends = 0; const client = createSitesClient(f.settings, { send: f.send, clock: f.now });
  const runtime = createSitesRuntime(f.settings, { clock: f.now, client, ledger, connectionFactory() { return { async start() {}, status: () => 'connected', close() {} }; }, sender: async () => { sends++; } });
  try { await runtime.tick(); assert.equal(sends, 0); assert.equal(f.acks.at(-1).status, 'uncertain'); assert.equal(ledger.retainedClaim(f.now()), null); }
  finally { await runtime.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
