import { ownerScopedProxy } from './callback-mode.js';
import { configuredProviderProxy, createProviderProxyAgent } from './provider-network.js';
import * as lark from '@larksuiteoapi/node-sdk';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { BridgeError } from './common.js';
import { INBOUND_EVENT, incomingMessage } from './lark.js';
import { publicAddress, makePublicRequester, destinationUrl, callbackTransportStatus } from './network.js';

// SDK logs may include payloads or websocket URLs. Never forward their arguments.
export function safeSdkLogger(report = () => {}) {
  return { trace() {}, debug() {}, info() {}, warn() { report('lark_sdk_warning'); }, error() { report('lark_sdk_error'); } };
}

export function createLarkDispatcher(config, store, clock = Date.now, { sdk = lark, report = () => {}, isStopping = () => false, authorize = () => {} } = {}) {
  return createVerifiedLarkDispatcher(config, async data => {
      if (isStopping()) throw new BridgeError('Bridge is stopping', { status: 503 });
      if (!config.ownerOpenId || !config.ownerChatId || !config.principal || config.authMode === 'deny') {
        throw new BridgeError('Owner binding is not configured', { status: 503 });
      }
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
      authorize();
      const outcome = store.ingest(message, `lark:${data.event_id}`, clock());
      return { outcome };
    }, { sdk, report });
}

export function createVerifiedLarkDispatcher(config, handler, { sdk = lark, report = () => {} } = {}) {
  const dispatcher = new sdk.EventDispatcher({ logger: safeSdkLogger(report), loggerLevel: sdk.LoggerLevel.warn })
    .register({ [INBOUND_EVENT]: handler });
  const invoke = dispatcher.invoke.bind(dispatcher);
  dispatcher.invoke = async (envelope, params) => {
    if (!config.tenantKey || !config.larkAppId) {
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

export function validFeishuServiceHost(host) { return typeof host === 'string' && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+feishu\.cn$/.test(host); }

export function createFeishuAgent(lookup = dnsLookup, { proxyEnv = process.env, ca, authorize = () => {} } = {}) {
  if (configuredProviderProxy(proxyEnv)) return createProviderProxyAgent({ env: proxyEnv, ca,
    allowedHost: host => {authorize();return validFeishuServiceHost(host);} });
  class ScopedAgent extends https.Agent {addRequest(req,options){authorize();return super.addRequest(req,options);}}
  return new ScopedAgent({ keepAlive: false, rejectUnauthorized: true,
    lookup(hostname, options, callback) {
      (async () => {
        authorize();if (!validFeishuServiceHost(hostname)) throw new Error('Unexpected websocket hostname');
        const answers = await lookup(hostname, { all: true, verbatim: true });
        if (!answers.length || answers.length > 32 || answers.some(answer => !publicAddress(answer.address))) throw new Error('Non-public websocket address');
        authorize();if (options.all) callback(null, answers);
        else callback(null, answers[0].address, answers[0].family);
      })().catch(error => callback(error));
    }
  });
}

export function createLarkRuntime(config, store, clock = Date.now, { sdk = lark, report = () => {}, send, isStopping = () => false } = {}) {
  const dispatcher = createLarkDispatcher(config, store, clock, { sdk, report, isStopping, authorize: () => {
    if (gated && !allowed()) throw new BridgeError('Callback delivery authorization is inactive', { code: -32012, status: 503 });
  } });
  const gated = config.authMode === 'tunnel-service' && config.tunnelServiceOperation === 'live';
  let connection, pending, closed = false, nextAttempt = 0;
  const allowed = () => {
    const sub = store.activeSubscription(clock());
    if (!callbackTransportStatus(send).ready) return false;
    if (!sub || sub.principal !== config.principal || sub.expires <= clock()) return false;
    try { destinationUrl(sub.url,config.callbackHosts.length?config.callbackHosts:ownerScopedProxy(config)?[new URL(sub.url).hostname]:[]); return true; } catch { return false; }
  };
  const runtime = {
    status: () => connection?.status() ?? 'disabled',
    async start() {
      if (config.larkTransport !== 'long-connection' || closed || isStopping()) return;
      if (config.authMode !== 'oauth' && !gated) throw new Error('Live Feishu transport requires OAuth or explicit live tunnel mode');
      if (gated && !allowed()) return;
      if (connection || pending || clock() < nextAttempt) return pending;
      connection = createLarkConnection(config, dispatcher, { sdk, report, send, authorize: () => {if(gated&&(!allowed()||closed||isStopping()))throw new BridgeError('Live subscription is inactive',{code:-32012});} });
      const selected = connection;
      pending = selected.start().catch(() => {
        selected.close(); if (connection === selected) connection = undefined;
        nextAttempt = clock() + 30000; report('lark_connection_failed');
        if (!gated) throw new Error('Live Feishu connection failed');
      }).finally(() => { pending = undefined; });
      return pending;
    },
    async syncSubscription() {
      if (!gated) return;
      if (!allowed() || closed || isStopping()) { connection?.close(); connection = undefined; return; }
      await runtime.start();
    },
    close() { closed = true; connection?.close(); connection = undefined; }
  };
  return runtime;
}

// Authenticated official transport only; no HTTP ingress. Also used by the
// separately gated operator pairing process, which exposes no MCP endpoint.
export function createLarkConnection(config, dispatcher, { sdk = lark, report = () => {}, send, autoReconnect = true, discoveryTimeoutMs = 30000, handshakeTimeoutMs = 10000, authorize = () => {} } = {}) {
  const request = send ?? makePublicRequester({ timeoutMs: discoveryTimeoutMs, providerTimeoutMs: discoveryTimeoutMs });
  let client, agent, stopping = false;const controller=new AbortController();
  return {
    status() { return client?.getConnectionStatus().state ?? 'disabled'; },
    async start() {
      if (!/^cli_[0-9a-fA-F]{16}$/.test(config.larkAppId) || !config.larkAppSecret) throw new Error('Official Feishu credentials required');
      if (client || stopping) throw new Error('Connection cannot be started twice');
      // Do not let the SDK follow redirects during authenticated WS discovery.
      // The returned WSS endpoint and TLS handshake are handled by official SDK.
      const httpInstance = { async request(options) {
        if (options.url !== 'https://open.feishu.cn/callback/ws/endpoint' || options.method.toLowerCase() !== 'post') {
          throw new Error('Unexpected SDK endpoint');
        }
        report('lark_discovery_started');
        let response;
        try { response = await request(options.url, { purpose: 'provider', hosts: ['open.feishu.cn'], headers: { ...options.headers, 'Content-Type': 'application/json' },
          body: Buffer.from(JSON.stringify(options.data)), signal:controller.signal, beforeConnect() { if (stopping) throw new Error('Runtime stopped');authorize(); } });
        } catch (error) { report('lark_discovery_failed'); throw error; }
        report('lark_discovery_http_received');
        if (stopping) throw new Error('Runtime stopped during discovery');authorize();
        if (response.status !== 200) { report('lark_discovery_http_rejected'); throw new Error('SDK endpoint discovery rejected'); }
        let result;
        try { result = JSON.parse(response.body.toString('utf8')); }
        catch { report('lark_discovery_invalid'); throw new Error('Invalid discovery response'); }
        if (!result || typeof result !== 'object') { report('lark_discovery_invalid'); throw new Error('Invalid discovery response'); }
        if (result.code !== 0) report('lark_discovery_platform_rejected');
        if (result.code === 0) {
          let target;
          try { target = new URL(result.data?.URL); }
          catch { report('lark_discovery_invalid'); throw new Error('Invalid discovery endpoint'); }
          // Official Feishu discovery may select a service hostname. Permit only
          // the official suffix, WSS, normal port, and no embedded credentials.
          if (target.protocol !== 'wss:' || target.username || target.password || target.hash ||
            (target.port && target.port !== '443') || !validFeishuServiceHost(target.hostname)) { report('lark_discovery_invalid'); throw new Error('Unexpected SDK websocket origin'); }
          report('lark_discovery_endpoint_verified');
        }
        return result;
      } };
      if (stopping) return;
      authorize();agent = createFeishuAgent(undefined,{authorize});
      client = new sdk.WSClient({ appId: config.larkAppId, appSecret: config.larkAppSecret, domain: sdk.Domain.Feishu, agent,
        httpInstance, logger: safeSdkLogger(report), loggerLevel: sdk.LoggerLevel.warn,
        autoReconnect, handshakeTimeoutMs, onReady() { report('lark_connected'); }, onReconnected() { report('lark_reconnected'); }, onReconnecting() { report('lark_reconnecting'); },
        onError() { report('lark_connection_failed'); } });
      await client.start({ eventDispatcher: dispatcher });
    },
    close() { stopping = true;controller.abort(); client?.close({ force: true }); agent?.destroy(); }
  };
}
