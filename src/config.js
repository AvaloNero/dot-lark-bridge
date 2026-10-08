import { assertCallbackMode } from './callback-mode.js';
import { validateLiveConfig } from './live-validation.js';
import { randomBytes } from 'node:crypto';
import { assertTunnelServiceConfig, readPrivateKey } from './tunnel-service-auth.js';
import path from 'node:path';
import { readBridgeMode } from './bridge-mode.js';
import { loadCredentials } from './credentials.js';

function number(env, key, fallback, min, max) {
  const value = env[key] ? Number(env[key]) : fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${key}`);
  return value;
}
export function readConfig(env = process.env) {
  const operation = env.TUNNEL_SERVICE_OPERATION || 'readiness';
  const callbackTransportMode=env.CALLBACK_TRANSPORT_MODE||'standard';
  assertCallbackMode({callbackTransportMode,authMode:env.AUTH_MODE,tunnelServiceOperation:operation,bridgeMode:env.BRIDGE_MODE,principal:env.TUNNEL_SERVICE_OWNER_ID});
  if (env.AUTH_MODE === 'tunnel-service') {
    if (!['readiness', 'live'].includes(operation)) throw new Error('Invalid TUNNEL_SERVICE_OPERATION');
    if (env.BRIDGE_MODE !== 'tunnel' || !['127.0.0.1','::1'].includes(env.HOST || '127.0.0.1') || env.TUNNEL_SERVICE_OWNER_ID !== 'tunnel-owner:dot-bridge' || !path.isAbsolute(env.TUNNEL_SERVICE_KEY_FILE || '')) throw new Error('Invalid tunnel mode, listener, owner or key reference');
    if (env.TUNNEL_SERVICE_READINESS_ONLY && (env.TUNNEL_SERVICE_READINESS_ONLY !== 'true' || operation !== 'readiness')) throw new Error('Conflicting legacy readiness flag');
    const forbidden = ['PUBLIC_ORIGIN', 'MCP_OWNER_SUBJECT', 'DEV_BEARER_TOKEN', 'OAUTH_ISSUER', 'OAUTH_JWKS_URL', 'OAUTH_AUDIENCE', 'OAUTH_REQUIRED_SCOPE',
      'SITES_ORIGIN', 'SITES_BINDING_ID', 'SITES_SERVICE_CREDENTIAL', 'SITES_CONNECTOR_CREDENTIAL', 'MCP_ALLOWED_ORIGINS', 'LARK_APP_ID', 'LARK_APP_SECRET', 'LARK_OWNER_OPEN_ID', 'LARK_TENANT_KEY', 'LARK_OWNER_CHAT_ID', 'STORAGE_KEY'];
    if (operation === 'readiness') forbidden.push('LARK_CREDENTIALS_FILE', 'MCP_CALLBACK_ALLOWED_HOSTS', 'STORAGE_KEY_FILE');
    if (forbidden.some(key => env[key])) throw new Error('Tunnel service cannot mix external auth or inline provider secrets; readiness forbids provider credentials and callbacks');
    if (operation === 'live' && (env.LARK_TRANSPORT !== 'long-connection' || !/^cli_[0-9a-fA-F]{16}$/.test(env.LARK_EXPECTED_APP_ID || '') || !env.LARK_CREDENTIALS_FILE || !env.STORAGE_KEY_FILE || !env.DATABASE_PATH || !env.BRIDGE_LOCK_DIRECTORY)) throw new Error('Live tunnel requires explicit file references and callback policy');
  }
  if (env.AUTH_MODE === 'tunnel-service' && operation === 'live') {
    const refs = [env.LARK_CREDENTIALS_FILE, env.STORAGE_KEY_FILE, env.TUNNEL_SERVICE_KEY_FILE];
    if (refs.some(file => !path.isAbsolute(file)) || new Set(refs.map(file => path.resolve(file))).size !== refs.length) throw new Error('Distinct absolute live credential file references required');
  }
  const credentials = env.LARK_CREDENTIALS_FILE ? loadCredentials(env.LARK_CREDENTIALS_FILE, { paired: true }) : {};
  if (env.AUTH_MODE === 'tunnel-service' && operation === 'live' && credentials.appId !== env.LARK_EXPECTED_APP_ID) throw new Error('Approved Feishu application does not match paired file');
  const fields = { LARK_APP_ID: 'appId', LARK_APP_SECRET: 'appSecret', LARK_OWNER_OPEN_ID: 'ownerOpenId',
    LARK_TENANT_KEY: 'tenantKey', LARK_OWNER_CHAT_ID: 'ownerChatId' };
  for (const [key, field] of Object.entries(fields)) {
    if (env[key] && credentials[field] && env[key] !== credentials[field]) throw new Error(`Credential file conflicts with ${key}`);
  }
  const value = key => env[key] || credentials[fields[key]] || '';
  const bridgeMode = readBridgeMode(env);
  const mode = env.AUTH_MODE || 'deny';
  if (!['deny', 'dev', 'oauth', 'tunnel-service'].includes(mode)) throw new Error('Invalid AUTH_MODE');
  const config = {
    callbackTransportMode,
    credentialsFile: env.LARK_CREDENTIALS_FILE || '', expectedAppId: env.LARK_EXPECTED_APP_ID || '',
    bridgeMode, bridgeLockDirectory: env.BRIDGE_LOCK_DIRECTORY || '',
    sitesOrigin: env.SITES_ORIGIN || '', sitesBindingId: env.SITES_BINDING_ID || '',
    sitesPlatformToken: env.SITES_SERVICE_CREDENTIAL || '', sitesConnectorToken: env.SITES_CONNECTOR_CREDENTIAL || '',
    host: env.HOST || '127.0.0.1', port: number(env, 'PORT', 3000, 1, 65535),
    dbPath: path.resolve(env.DATABASE_PATH || 'data/bridge.sqlite'), storageKeyFile: env.STORAGE_KEY_FILE || '', storageKey: env.AUTH_MODE === 'tunnel-service' && operation === 'live' ? Buffer.from(readPrivateKey(env.STORAGE_KEY_FILE), 'base64url').toString('base64') : (env.STORAGE_KEY || ''),
    authMode: mode, devToken: env.DEV_BEARER_TOKEN || '', tunnelServiceOperation: mode === 'tunnel-service' ? operation : undefined, pairedCredentialsLoaded: credentials.status === 'paired', tunnelServiceReadinessOnly: mode === 'tunnel-service' && operation === 'readiness', tunnelServiceKeyFile: env.TUNNEL_SERVICE_KEY_FILE || '', principal: mode === 'tunnel-service' ? (env.TUNNEL_SERVICE_OWNER_ID || '') : bridgeMode === 'sites' ? (env.SITES_BINDING_ID || '') : (env.MCP_OWNER_SUBJECT || ''),
    larkAppId: value('LARK_APP_ID'), larkAppSecret: value('LARK_APP_SECRET'),
    ownerOpenId: value('LARK_OWNER_OPEN_ID'), tenantKey: value('LARK_TENANT_KEY'), ownerChatId: value('LARK_OWNER_CHAT_ID'),
    larkTransport: env.LARK_TRANSPORT || 'disabled',
    publicOrigin: env.PUBLIC_ORIGIN || '', oauthIssuer: env.OAUTH_ISSUER || '', oauthJwksUrl: env.OAUTH_JWKS_URL || '',
    oauthAudience: env.OAUTH_AUDIENCE || '', oauthScope: env.OAUTH_REQUIRED_SCOPE || 'lark:bridge',
    callbackHosts: (env.MCP_CALLBACK_ALLOWED_HOSTS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean),
    allowedOrigins: (env.MCP_ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean),
    replyTtlMs: number(env, 'REPLY_TTL_SECONDS', 900, 10, 3600) * 1000,
    subscriptionTtlMs: number(env, 'SUBSCRIPTION_TTL_SECONDS', 86400, 60, 604800) * 1000,
    queueLimit: number(env, 'QUEUE_LIMIT', 100, 1, 10000), inboundPerMinute: number(env, 'INBOUND_PER_MINUTE', 10, 1, 20),
    repliesPerMinute: number(env, 'REPLIES_PER_MINUTE', 10, 1, 20), maxAttempts: number(env, 'MAX_DELIVERY_ATTEMPTS', 5, 1, 10),
    retryBaseMs: 1000, workerIntervalMs: 500, leaseMs: 60000,
    textRetentionMs: number(env, 'TEXT_RETENTION_SECONDS', 604800, 60, 604800) * 1000
  };
  if (config.textRetentionMs < config.replyTtlMs) throw new Error('TEXT_RETENTION_SECONDS must not be shorter than REPLY_TTL_SECONDS');
  if (!['disabled', 'long-connection'].includes(config.larkTransport)) throw new Error('Invalid LARK_TRANSPORT');
  if (mode === 'tunnel-service') {
    if (env.TUNNEL_SERVICE_READINESS_ONLY && env.TUNNEL_SERVICE_READINESS_ONLY !== 'true') throw new Error('Only readiness tunnel service is supported');
    assertTunnelServiceConfig(config);
  }
  if (mode === 'dev' && (!['127.0.0.1', '::1'].includes(config.host) || config.publicOrigin || config.devToken.length < 32 || !config.principal || config.larkTransport !== 'disabled')) {
    throw new Error('Dev auth requires loopback, disabled live transport, no PUBLIC_ORIGIN, a synthetic token of at least 32 characters, and a principal');
  }
  if (mode === 'oauth') {
    for (const [key, raw] of Object.entries({ PUBLIC_ORIGIN: config.publicOrigin, OAUTH_ISSUER: config.oauthIssuer, OAUTH_JWKS_URL: config.oauthJwksUrl, OAUTH_AUDIENCE: config.oauthAudience })) {
      let url;
      try { url = new URL(raw); } catch { throw new Error(`Invalid ${key}`); }
      if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error(`Invalid ${key}`);
    }
    if (new URL(config.publicOrigin).origin !== config.publicOrigin || config.oauthAudience !== `${config.publicOrigin}/mcp` || !config.principal) {
      throw new Error('OAuth requires one owner subject and OAUTH_AUDIENCE equal to PUBLIC_ORIGIN/mcp');
    }
  }
  for (const [key, value] of Object.entries({ LARK_APP_ID: config.larkAppId, LARK_OWNER_OPEN_ID: config.ownerOpenId,
    LARK_TENANT_KEY: config.tenantKey, LARK_OWNER_CHAT_ID: config.ownerChatId })) {
    if (value && !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new Error(`Invalid ${key}`);
  }
  if (config.larkTransport === 'long-connection' && ((bridgeMode === 'tunnel' ? !['oauth', 'tunnel-service'].includes(mode) : bridgeMode === 'sites' ? mode !== 'deny' : true) || !config.larkAppId || !config.larkAppSecret ||
    !config.ownerOpenId || !config.tenantKey || !config.ownerChatId ||
      (bridgeMode === 'tunnel' ? (mode !== 'tunnel-service' && !config.callbackHosts.length) : !config.sitesOrigin || !config.sitesBindingId || !config.sitesPlatformToken || !config.sitesConnectorToken))) {
    throw new Error('Live Feishu transport requires explicit mode, complete owner binding and that mode authorization');
  }
  if (config.larkTransport === 'long-connection' && !/^cli_[0-9a-fA-F]{16}$/.test(config.larkAppId)) throw new Error('Invalid live Feishu AppID');
  if (!/^[a-zA-Z0-9:_-]{1,128}$/.test(config.oauthScope)) throw new Error('Invalid OAUTH_REQUIRED_SCOPE');
  validateLiveConfig(config);
  return Object.freeze(config);
}

// Readiness has no durable messages or subscriptions and must never open a prior store.
export function readTunnelReadinessConfig(env = process.env) {
  if (env.TUNNEL_SERVICE_OPERATION && env.TUNNEL_SERVICE_OPERATION !== 'readiness') throw new Error('Readiness entry cannot enable live mode');
  if (env.DATABASE_PATH || env.STORAGE_KEY || env.STORAGE_KEY_FILE) throw new Error('Tunnel readiness requires an ephemeral empty store');
  const config = readConfig(env);
  if (config.authMode !== 'tunnel-service') throw new Error('Tunnel service mode required');
  return Object.freeze({ ...config, dbPath: ':memory:', storageKey: randomBytes(32).toString('base64') });
}
