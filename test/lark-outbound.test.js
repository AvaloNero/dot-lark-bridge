import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, larkPayload } from './helpers.js';
import { replyUuid } from '../src/lark.js';
import { createLarkRuntime } from '../src/lark-runtime.js';
import * as lark from '@larksuiteoapi/node-sdk';

const isReply = url => url.includes('/open-apis/im/v1/messages/');
async function prepare(f) { await f.subscribe(); await f.receiveLark(); await f.app.bridge.tick(); await f.reply(); }

for (const [label, response] of [
  ['500', { status: 500, body: Buffer.from('{}') }],
  ['malformed JSON', { status: 200, body: Buffer.from('{') }],
  ['missing acknowledgement code', { status: 200, body: Buffer.from('null') }],
  ['missing message ID', { status: 200, body: Buffer.from('{"code":0,"data":{"chat_id":"fixture_private_chat"}}') }],
  ['wrong chat', { status: 200, body: Buffer.from('{"code":0,"data":{"chat_id":"other-chat","message_id":"out"}}') }]
]) test(`unknown Feishu reply result (${label}) is terminal even after repeated identical tool calls`, async t => {
  let attempts = 0;
  const f = await harness({ sendOverride: async url => { if (isReply(url)) { attempts++; return response; } } });
  t.after(f.close); await prepare(f); await f.app.bridge.tick();
  assert.equal(f.app.bridge.store.replyStatus('fixture-message-1').status, 'uncertain');
  f.advance(10000); await f.reply(); await f.app.bridge.tick(); assert.equal(attempts, 1);
});

for (const status of [401, 429]) test(`explicit HTTP ${status} rejection retries a stable original message route and UUID`, async t => {
  let attempts = 0;
  const f = await harness({ sendOverride: async url => {
    if (isReply(url) && ++attempts === 1) return { status, body: Buffer.from('{}') };
  } });
  t.after(f.close); await prepare(f); await f.app.bridge.tick();
  assert.equal(f.app.bridge.store.replyStatus('fixture-message-1').status, 'pending');
  f.advance(1100); await f.app.bridge.tick();
  assert.equal(f.app.bridge.store.replyStatus('fixture-message-1').status, 'sent');
  const replies = f.requests.filter(r => isReply(r.url)); assert.equal(replies.length, 2);
  assert.equal(replies[0].url, replies[1].url); assert.deepEqual(replies[0].options.body, replies[1].options.body);
  assert.equal(JSON.parse(replies[0].options.body).uuid, replyUuid(f.config.larkAppId, 'fixture-message-1'));
});

test('explicit API rejection and redirects are terminal and cannot choose an alternate recipient', async t => {
  for (const response of [{ status: 200, body: Buffer.from('{"code":230001,"msg":"sensitive upstream detail"}') },
    { status: 302, headers: { location: 'https://attacker.example' }, body: Buffer.from('{}') }]) {
    const f = await harness({ sendOverride: async url => isReply(url) ? response : undefined }); t.after(f.close);
    await prepare(f); await f.app.bridge.tick(); f.advance(1100); await f.app.bridge.tick();
    assert.equal(f.app.bridge.store.replyStatus('fixture-message-1').status, 'dead');
    assert.equal(f.requests.filter(r => isReply(r.url)).length, 1);
    assert.equal(f.app.bridge.store.replyStatus('fixture-message-1').error.includes('sensitive'), false);
  }
});

test('expiry during token refresh prevents the reply HTTP request', async t => {
  const f = await harness({ sendOverride: async url => {
    if (url.endsWith('/tenant_access_token/internal')) f.advance(f.config.replyTtlMs + 1);
  } }); t.after(f.close); await prepare(f); await f.app.bridge.tick();
  assert.equal(f.sends.length, 0); assert.equal(f.app.bridge.store.replyStatus('fixture-message-1').status, 'cancelled');
});

test('application token acquisition uses app credentials only and is cached outside durable storage', async t => {
  const f = await harness(); t.after(f.close); await prepare(f); await f.app.bridge.tick();
  const next = larkPayload(f.now(), { message_id: 'fixture-message-2' }); next.header.event_id = 'fixture-event-2';
  await f.receiveLark(next); await f.app.bridge.tick(); await f.reply('fixture-message-2'); await f.app.bridge.tick();
  const tokens = f.requests.filter(r => r.url.endsWith('/tenant_access_token/internal'));
  assert.equal(tokens.length, 1);
  assert.deepEqual(JSON.parse(tokens[0].options.body), { app_id: f.config.larkAppId, app_secret: f.config.larkAppSecret });
  assert.equal(f.sends.length, 2); assert.notEqual(f.sends[0].body.uuid, f.sends[1].body.uuid);
  assert.equal(f.app.bridge.store.all('SELECT value FROM metadata').some(row => row.value.includes('fixture-lark-token')), false);
});

test('runtime uses only official discovery, guards returned WSS origins, and closes SDK reconnection', async t => {
  const f = await harness(); t.after(f.close);
  let options, closed = false, activeDispatcher;
  const sdk = { ...lark, WSClient: class {
    constructor(settings) { options = settings; }
    start({ eventDispatcher }) { activeDispatcher = eventDispatcher; }
    getConnectionStatus() { return { state: 'connected' }; }
    close({ force }) { closed = force; }
  } };
  let result = { code: 0, data: { URL: 'wss://msg-frontier.feishu.cn/ws?fixture=1' } };
  const runtime = createLarkRuntime({ ...f.config, authMode: 'oauth', larkTransport: 'long-connection' }, f.app.bridge.store,
    f.now, { sdk, send: async (url, request) => {
      assert.equal(url, 'https://open.feishu.cn/callback/ws/endpoint');
      assert.deepEqual(request.hosts, ['open.feishu.cn']);
      return { status: 200, body: Buffer.from(JSON.stringify(result)) };
    } }); t.after(() => runtime.close());
  await runtime.start(); assert.equal(runtime.status(), 'connected'); assert.ok(activeDispatcher); assert.equal(options.domain, lark.Domain.Feishu);
  const request = { method: 'post', url: 'https://open.feishu.cn/callback/ws/endpoint', data: { AppID: f.config.larkAppId, AppSecret: f.config.larkAppSecret } };
  await options.httpInstance.request(request);
  for (const url of ['ws://msg-frontier.feishu.cn/x', 'wss://attacker.example/x', 'wss://msg-frontier.feishu.cn:8443/x',
    'wss://user:secret@msg-frontier.feishu.cn/x', 'wss://msg-frontier.feishu.cn.evil/x']) {
    result = { code: 0, data: { URL: url } }; await assert.rejects(options.httpInstance.request(request));
  }
  await assert.rejects(options.httpInstance.request({ ...request, url: 'https://attacker.example' }));
  runtime.close(); assert.equal(closed, true);
});
