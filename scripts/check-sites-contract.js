// Opt-in, entirely synthetic cross-repository contract check. No live network.
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { config, larkPayload } from '../test/helpers.js';
import { createSitesClient } from '../src/sites-client.js';
import { createSitesRuntime } from '../src/sites-runtime.js';
import { SitesLedger } from '../src/sites-ledger.js';
if (!process.env.SITES_CONTRACT_SOURCE) throw new Error('Specify the reviewed local Sites source checkout');
const source = path.resolve(process.env.SITES_CONTRACT_SOURCE);
const load = relative => import(pathToFileURL(path.join(source, relative)).href);
const { createD1 } = await load('tests/d1.mjs');
const { bridgeRoute } = await load('bridge/routes.mjs');
const { hash, run, queueReply, first } = await load('bridge/core.mjs');
const { subscribe } = await load('bridge/events.mjs');
const db = createD1(), connectorToken = 'fixture-lark-connector-not-real';
const env = { DB: db, CALLBACK_ALLOWED_HOSTS: 'callbacks.example.com', EVENT_SECRET_KEY: Buffer.alloc(32, 4).toString('base64') };
await run(db, 'INSERT INTO bindings(id,owner,channel,token_hash,enabled) VALUES(?,?,?,?,?)', 'binding_fixture', 'owner_fixture', 'lark', await hash(connectorToken), 1);
const originalFetch = globalThis.fetch; let callbacks = 0, sends = 0;
globalThis.fetch = async (url, options) => {
  assert.equal(new URL(url).hostname, 'callbacks.example.com');
  const value = JSON.parse(options.body);
  if (value.challenge) return new Response(JSON.stringify({ challenge: value.challenge }), { status: 200 });
  callbacks++; return new Response('{}', { status: 202 });
};
const settings = config({ bridgeMode: 'sites', authMode: 'deny', principal: 'binding_fixture', sitesOrigin: 'https://synthetic-site.example.com', sitesBindingId: 'binding_fixture',
  sitesPlatformToken: 'fixture-platform-token-not-real', sitesConnectorToken: connectorToken });
const send = async (url, options) => {
  options.beforeConnect?.();
  const response = await bridgeRoute(new Request(url, { method: 'POST', headers: options.headers, body: options.body }), env);
  return { status: response.status, body: Buffer.from(await response.text()) };
};
const client = createSitesClient(settings, { send }), ledger = new SitesLedger(settings);
const runtime = createSitesRuntime(settings, { client, ledger,
  connectionFactory() { return { async start() {}, close() {}, status: () => 'connected' }; },
  sender: async (message, text, { authorize }) => { authorize(); assert.equal(message.chat_id, settings.ownerChatId); assert.equal(text, 'Synthetic Sites reply'); sends++; return 'fixture_reply'; } });
try {
  await subscribe(db, 'owner_fixture', { name: 'lark.message.created', arguments: { conversation: 'owner' }, delivery: {
    mode: 'webhook', url: 'https://callbacks.example.com/lark', secret: `whsec_${Buffer.alloc(32, 3).toString('base64')}` } }, env, Date.now(), globalThis.fetch);
  await runtime.tick();
  const incoming = larkPayload(Date.now()); await runtime.dispatcher.invoke(incoming, { needCheck: false });
  assert.equal(callbacks, 1);
  await assert.rejects(queueReply(db, 'different_owner', 'lark', incoming.event.message.message_id, 'Not permitted', Date.now()));
  await queueReply(db, 'owner_fixture', 'lark', incoming.event.message.message_id, 'Synthetic Sites reply', Date.now());
  await runtime.tick(); await runtime.tick();
  assert.equal(sends, 1); assert.equal((await first(db, 'SELECT status FROM outbox')).status, 'sent');
  process.stdout.write(JSON.stringify({ mode: 'SYNTHETIC_CROSS_REPOSITORY_CONTRACT', channel: 'lark', callbacks, same_message_replies: sends, foreign_owner_rejected: true, live_sites_verified: false, current_dot_connected: false }) + '\n');
} finally { await runtime.close(); globalThis.fetch = originalFetch; }
