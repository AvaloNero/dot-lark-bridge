import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import * as sdk from '@larksuiteoapi/node-sdk';
import { makeRegistrationPost } from '../src/registration-transport.js';
import { createProviderProxyAgent } from '../src/provider-network.js';
import { createRegistrationSession } from '../src/registration-session.js';
const ENDPOINT = 'https://accounts.feishu.cn/oauth/v1/app/registration';
const BEGIN = 'action=begin&archetype=PersonalAgent&auth_method=client_secret&request_user_info=open_id';
let directory, target, proxy, env, ca, behavior = 'normal', connects = 0;
const sockets = new Set();
before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'lark-registration-fixture-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=accounts.feishu.cn', '-addext', 'subjectAltName=DNS:accounts.feishu.cn', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')], { stdio: 'ignore' });
  ca = readFileSync(join(directory, 'cert.pem'));
  target = https.createServer({ key: readFileSync(join(directory, 'key.pem')), cert: ca }, (req, res) => {
    assert.equal(req.url, '/oauth/v1/app/registration'); assert.equal(req.method, 'POST'); assert.equal(req.headers.host, 'accounts.feishu.cn');
    assert.equal(req.headers['proxy-authorization'], undefined);
    let body = ''; req.on('data', data => { body += data; }); req.on('end', () => {
      if (behavior === 'redirect') { res.writeHead(302, { location: 'https://attacker.invalid' }); res.end(); }
      else if (behavior === 'denied') { res.writeHead(403); res.end('must-not-log'); }
      else if (behavior === 'large') res.end('a'.repeat(65537));
      else if (behavior === 'bad-json') res.end('must-not-log');
      else if (behavior === 'hang') return;
      else if (new URLSearchParams(body).get('action') === 'begin') res.end(JSON.stringify({ device_code: 'fixture-device', verification_uri_complete: 'https://accounts.feishu.cn/fixture?user_code=fixture', expires_in: 600, interval: 1 }));
      else res.end(JSON.stringify({ client_id: 'cli_0123456789abcdef', client_secret: 'fixture-secret-not-real-0000' }));
    });
  });
  target.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  proxy = http.createServer(); proxy.on('connect', (req, client, head) => {
    connects++; assert.equal(req.url, 'accounts.feishu.cn:443');
    const upstream = net.connect(target.address().port, '127.0.0.1', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client); });
    for (const socket of [client, upstream]) { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); }
    client.on('close', () => upstream.destroy()); upstream.on('close', () => client.destroy());
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve)); env = { HTTPS_PROXY: `http://127.0.0.1:${proxy.address().port}` };
});
after(async () => { for (const socket of sockets) socket.destroy(); await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => target.close(resolve))]); rmSync(directory, { recursive: true, force: true }); });
const post = options => makeRegistrationPost({ env, timeoutMs: 1000, agentFactory: options => createProviderProxyAgent({ ...options, ca }), ...options });

test('real pinned SDK existing-app scan uses restricted CONNECT with original TLS host, keeps returned credential in memory only', async () => {
  behavior = 'normal'; const savedPost = sdk.defaultHttpInstance.post, reports = [];
  sdk.defaultHttpInstance.post = post(); let probeCalls = 0;
  try {
    const session = createRegistrationSession({ approved: true, existingAppId: 'cli_0123456789abcdef', sdk, report: value => reports.push(value), probe: async (config, options) => {
      probeCalls++; assert.equal(config.larkAppSecret, 'fixture-secret-not-real-0000'); assert.equal(options.timeoutMs, 15000); return { websocket_connected: true, current_dot_connected: false };
    } });
    await session.completion; assert.equal(session.status().credentials_held_in_memory, true);
    await assert.rejects(session.probeApproved()); assert.equal(probeCalls, 0);
    await session.probeApproved({ approved: true }); assert.equal(probeCalls, 1);
    assert.equal(reports.some(value => value.verification_url?.includes('clientID=cli_0123456789abcdef')), true);
    assert.equal(JSON.stringify(reports).includes('fixture-secret'), false); assert.equal(JSON.stringify(reports).includes('fixture-device'), false);
    session.discard(); await assert.rejects(session.probeApproved({ approved: true }));
  } finally { sdk.defaultHttpInstance.post = savedPost; }
});

test('registration denies other destinations, altered methods and duplicate parameters before networking', async () => {
  const count = connects;
  for (const url of ['https://accounts.larksuite.com/oauth/v1/app/registration', 'https://accounts.feishu.cn/other', ENDPOINT + '?x=1', ENDPOINT.replace('https:', 'http:')]) await assert.rejects(post()(url, BEGIN));
  for (const body of ['action=poll', BEGIN + '&action=poll', BEGIN + '&extra=value', BEGIN.replace('PersonalAgent', 'anything')]) await assert.rejects(post()(ENDPOINT, body));
  assert.equal(connects, count);
});

test('registration refuses redirects, access refusal, excess bytes, invalid JSON, timeout, TLS mismatch and absent proxy without fallback', async () => {
  for (behavior of ['redirect', 'denied', 'large', 'bad-json', 'hang']) await assert.rejects(post({ timeoutMs: 100 })(ENDPOINT, BEGIN), error => !String(error).includes('must-not-log'));
  behavior = 'normal'; await assert.rejects(makeRegistrationPost({ env })(ENDPOINT, BEGIN));
  const count = connects; await assert.rejects(post({ env: {} })(ENDPOINT, BEGIN)); await assert.rejects(post({ env: { ...env, NO_PROXY: 'accounts.feishu.cn' } })(ENDPOINT, BEGIN)); assert.equal(connects, count);
});

test('HTTP progress counts requests and emits only status/time, not registration request or response bodies', async () => {
  behavior = 'normal'; const events = [], send = post({ report: event => events.push(event) });
  await send(ENDPOINT, BEGIN); await send(ENDPOINT, 'action=poll&device_code=fixture-private-device-code');
  assert.deepEqual(events.map(event => event.request_number), [1, 1, 2, 2]);
  assert.deepEqual(events.filter(event => event.phase === 'registration_http').map(event => event.status), [200, 200]);
  assert.equal(JSON.stringify(events).includes('fixture-private-device-code'), false); assert.equal(JSON.stringify(events).includes('fixture-secret'), false);
  assert.equal(events.every(event => Number.isFinite(Date.parse(event.at))), true);
});
