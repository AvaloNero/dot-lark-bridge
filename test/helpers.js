import { readConfig } from '../src/config.js';
import { createApp } from '../src/server.js';
import { verifyWebhook } from '../src/signatures.js';
import { EVENT_NAME } from '../src/bridge.js';
import { createLarkDispatcher } from '../src/lark-runtime.js';

// Public synthetic fixtures. None are usable account credentials.
export const FIXTURE_TOKEN = 'synthetic-local-token-for-tests-only-0000000000';
export const FIXTURE_SECRET = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;
export function config(overrides = {}) {
  return { ...readConfig({ AUTH_MODE: 'dev', DEV_BEARER_TOKEN: FIXTURE_TOKEN, MCP_OWNER_SUBJECT: 'fixture-owner',
    LARK_APP_ID: 'fixture-app', LARK_APP_SECRET: 'fixture-lark-app-secret', LARK_OWNER_OPEN_ID: 'fixture_lark_owner',
    LARK_TENANT_KEY: 'fixture_tenant', LARK_OWNER_CHAT_ID: 'fixture_private_chat',
    STORAGE_KEY: Buffer.alloc(32, 8).toString('base64'), MCP_CALLBACK_ALLOWED_HOSTS: 'receiver.example.com' }),
    dbPath: ':memory:', ...overrides };
}
export function mcpRequest(method, params = {}, id = 1) {
  return { jsonrpc: '2.0', id, method, params: { ...params, _meta: {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {},
    'io.modelcontextprotocol/clientInfo': { name: 'offline-fixture', version: '1.0.0' } } } };
}
export function mcpHeaders(request) {
  return { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${FIXTURE_TOKEN}`, 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': request.method,
    ...(request.method === 'tools/call' ? { 'Mcp-Name': request.params.name } : {}) };
}
export function subscriptionParams(overrides = {}) {
  return { name: EVENT_NAME, arguments: { conversation: 'owner' }, cursor: null,
    delivery: { mode: 'webhook', url: 'https://receiver.example.com/current-dot', secret: FIXTURE_SECRET }, ...overrides };
}
export function larkPayload(now, overrides = {}) {
  return { schema: '2.0', header: { event_id: 'fixture-event-1', event_type: 'im.message.receive_v1',
    create_time: String(now), app_id: 'fixture-app', tenant_key: 'fixture_tenant' },
    event: { sender: { sender_id: { open_id: 'fixture_lark_owner' }, sender_type: 'user', tenant_key: 'fixture_tenant' },
      message: { message_id: 'fixture-message-1', chat_id: 'fixture_private_chat', chat_type: 'p2p', message_type: 'text',
        create_time: String(now), content: JSON.stringify({ text: '2 + 2 是多少？' }), ...overrides } } };
}
export async function harness({ overrides = {}, sendOverride, dbPath, worker = false } = {}) {
  let now = Date.parse('2026-10-02T12:00:00Z');
  const settings = config({ ...overrides, ...(dbPath ? { dbPath } : {}) });
  const deliveries = [], sends = [], requests = [], reports = [];
  let signingSecret = FIXTURE_SECRET;
  async function send(url, options) {
    options.beforeConnect?.();
    requests.push({ url, options });
    if (sendOverride) {
      const overridden = await sendOverride(url, options, { now, deliveries, sends });
      if (overridden !== undefined) return overridden;
    }
    const body = JSON.parse(options.body.toString('utf8'));
    if (url.startsWith('https://receiver.example.com/')) {
      if (!verifyWebhook(signingSecret, Object.fromEntries(Object.entries(options.headers).map(([k, v]) => [k.toLowerCase(), v])), options.body, now)) throw new Error('Fixture receiver rejected signature');
      if (body.type === 'verification') return { status: 200, body: Buffer.from(JSON.stringify({ challenge: body.challenge })) };
      deliveries.push(body); return { status: 202, body: Buffer.from('{}') };
    }
    if (url === 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal') {
      return { status: 200, body: Buffer.from(JSON.stringify({ code: 0, tenant_access_token: 'fixture-lark-token', expire: 7200 })) };
    }
    if (url.startsWith('https://open.feishu.cn/open-apis/im/v1/messages/') && url.endsWith('/reply')) {
      sends.push({ url, body, headers: options.headers });
      return { status: 200, body: Buffer.from(JSON.stringify({ code: 0, data: { message_id: 'fixture-outbound-1', chat_id: 'fixture_private_chat' } })) };
    }
    throw new Error('Unexpected fixture outbound request');
  }
  const app = createApp(settings, { clock: () => now, send, worker, report: event => reports.push(event) });
  // Exercise the real pinned SDK's normalization without connecting a websocket.
  const dispatcher = createLarkDispatcher(settings, app.bridge.store, () => now, { report: event => reports.push(event) });
  const address = await app.listen(0), origin = `http://127.0.0.1:${address.port}`;
  async function postMcp(method, params = {}, { headers = {}, request, token } = {}) {
    const rpc = request ?? mcpRequest(method, params);
    const response = await fetch(`${origin}/mcp`, { method: 'POST', headers: { ...mcpHeaders(rpc), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(rpc) });
    return { status: response.status, body: response.status === 202 ? null : await response.json(), headers: response.headers };
  }
  async function receiveLark(payload = larkPayload(now)) {
    try { return { status: 200, body: await dispatcher.invoke(payload, { needCheck: false }) }; }
    catch (error) { return { status: error.status ?? 500, body: { error: error.message } }; }
  }
  return { app, config: settings, origin, postMcp, receiveLark, dispatcher, deliveries, sends, requests, reports,
    now: () => now, advance: ms => { now += ms; }, setSecret: value => { signingSecret = value; },
    subscribe: params => postMcp('events/subscribe', params ?? subscriptionParams()),
    reply: (message_id = 'fixture-message-1', text = '4') => postMcp('tools/call', { name: 'reply_to_lark', arguments: { message_id, text } }),
    close: () => app.close() };
}
