import * as lark from '@larksuiteoapi/node-sdk';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { BridgeError } from './common.js';
import { INBOUND_EVENT, incomingMessage } from './lark.js';
import { publicAddress } from './network.js';

// SDK logs may include payloads or websocket URLs. Never forward their arguments.
export function safeSdkLogger(report = () => {}) {
  return { trace() {}, debug() {}, info() {}, warn() { report('lark_sdk_warning'); }, error() { report('lark_sdk_error'); } };
}

export function createLarkDispatcher(config, store, clock = Date.now, { sdk = lark, report = () => {}, isStopping = () => false } = {}) {
  const dispatcher = new sdk.EventDispatcher({ logger: safeSdkLogger(report), loggerLevel: sdk.LoggerLevel.warn })
    .register({ [INBOUND_EVENT]: async data => {
      if (isStopping()) throw new BridgeError('Bridge is stopping', { status: 503 });
      let message;
      try { message = incomingMessage(data, config, clock()); }
      catch (error) {
        // Unwanted/invalid source messages are acknowledged and discarded, never
        // delivered or echoed. Configuration/storage/backpressure errors propagate
        // to WSClient so it returns an error ACK, allowing platform redelivery.
        if (error instanceof BridgeError && [400, 403].includes(error.status)) { report('inbound_rejected'); return { outcome: 'rejected' }; }
        throw error;
      }
      if (!message) return { outcome: 'ignored' };
      if (store.get('SELECT id FROM messages WHERE outbound_id=?', message.id)) return { outcome: 'ignored' };
      const outcome = store.ingest(message, `lark:${data.event_id}`, clock());
      return { outcome };
    } });
  const invoke = dispatcher.invoke.bind(dispatcher);
  dispatcher.invoke = async (envelope, params) => {
    if (!config.ownerOpenId || !config.tenantKey || !config.ownerChatId || !config.larkAppId || !config.principal || config.authMode === 'deny') {
      throw new BridgeError('Owner binding is not configured', { status: 503 });
    }
    // Check the original V2 header before the SDK merges event fields into it.
    // needCheck:false is WSClient's contract, not an authentication substitute.
    // This object is never wired to any public HTTP adapter.
    if (params?.needCheck !== false || envelope?.schema !== '2.0' || !envelope.header || !envelope.event ||
        ['app_id', 'tenant_key', 'event_id', 'event_type', 'create_time', 'schema'].some(key => Object.hasOwn(envelope.event, key))) {
      report('inbound_rejected'); return { outcome: 'rejected' };
    }
    if (envelope.header.event_type !== INBOUND_EVENT) return { outcome: 'ignored' };
    if (envelope.header.app_id !== config.larkAppId || envelope.header.tenant_key !== config.tenantKey) {
      report('inbound_rejected'); return { outcome: 'rejected' };
    }
    return invoke(envelope, params);
  };
  return dispatcher;
}

export function createFeishuAgent(lookup = dnsLookup) {
  return new https.Agent({ keepAlive: false, rejectUnauthorized: true,
    lookup(hostname, options, callback) {
      (async () => {
        if (!hostname.endsWith('.feishu.cn')) throw new Error('Unexpected websocket hostname');
        const answers = await lookup(hostname, { all: true, verbatim: true });
        if (!answers.length || answers.length > 32 || answers.some(answer => !publicAddress(answer.address))) throw new Error('Non-public websocket address');
        if (options.all) callback(null, answers);
        else callback(null, answers[0].address, answers[0].family);
      })().catch(error => callback(error));
    }
  });
}

export function createLarkRuntime(config, store, clock = Date.now, { sdk = lark, report = () => {}, send, isStopping } = {}) {
  const dispatcher = createLarkDispatcher(config, store, clock, { sdk, report, isStopping });
  let client, agent, stopping = false;
  return {
    status() { return client?.getConnectionStatus().state ?? 'disabled'; },
    async start() {
      if (config.larkTransport !== 'long-connection') return;
      if (config.authMode !== 'oauth') throw new Error('Live Feishu transport requires OAuth');
      // Do not let the SDK follow redirects during authenticated WS discovery.
      // The returned WSS endpoint and TLS handshake are handled by official SDK.
      const httpInstance = { async request(options) {
        if (options.url !== 'https://open.feishu.cn/callback/ws/endpoint' || options.method.toLowerCase() !== 'post') {
          throw new Error('Unexpected SDK endpoint');
        }
        const response = await send(options.url, { hosts: ['open.feishu.cn'], headers: { ...options.headers, 'Content-Type': 'application/json' },
          body: Buffer.from(JSON.stringify(options.data)), beforeConnect() { if (stopping) throw new Error('Runtime stopped'); } });
        if (response.status !== 200) throw new Error('SDK endpoint discovery rejected');
        const result = JSON.parse(response.body.toString('utf8'));
        if (result.code === 0) {
          const target = new URL(result.data?.URL);
          // Official Feishu discovery may select a service hostname. Permit only
          // the official suffix, WSS, normal port, and no embedded credentials.
          if (target.protocol !== 'wss:' || target.username || target.password || target.hash ||
            (target.port && target.port !== '443') || !target.hostname.endsWith('.feishu.cn')) throw new Error('Unexpected SDK websocket origin');
        }
        return result;
      } };
      if (stopping) return;
      agent = createFeishuAgent();
      client = new sdk.WSClient({ appId: config.larkAppId, appSecret: config.larkAppSecret, domain: sdk.Domain.Feishu, agent,
        httpInstance, logger: safeSdkLogger(report), loggerLevel: sdk.LoggerLevel.warn,
        autoReconnect: true, handshakeTimeoutMs: 10000, onReady() { report('lark_connected'); }, onReconnected() { report('lark_reconnected'); },
        onError() { report('lark_connection_failed'); } });
      await client.start({ eventDispatcher: dispatcher });
    },
    close() { stopping = true; client?.close({ force: true }); agent?.destroy(); }
  };
}
