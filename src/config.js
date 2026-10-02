import path from 'node:path';

function number(env, key, fallback, min, max) {
  const value = env[key] ? Number(env[key]) : fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${key}`);
  return value;
}
export function readConfig(env = process.env) {
  const mode = env.AUTH_MODE || 'deny';
  if (!['deny', 'dev', 'oauth'].includes(mode)) throw new Error('Invalid AUTH_MODE');
  const config = {
    host: env.HOST || '127.0.0.1', port: number(env, 'PORT', 3000, 1, 65535),
    dbPath: path.resolve(env.DATABASE_PATH || 'data/bridge.sqlite'), storageKey: env.STORAGE_KEY || '',
    authMode: mode, devToken: env.DEV_BEARER_TOKEN || '', principal: env.MCP_OWNER_SUBJECT || '',
    larkAppId: env.LARK_APP_ID || '', larkAppSecret: env.LARK_APP_SECRET || '',
    ownerOpenId: env.LARK_OWNER_OPEN_ID || '', tenantKey: env.LARK_TENANT_KEY || '', ownerChatId: env.LARK_OWNER_CHAT_ID || '',
    larkTransport: env.LARK_TRANSPORT || 'disabled',
    publicOrigin: env.PUBLIC_ORIGIN || '', oauthIssuer: env.OAUTH_ISSUER || '', oauthJwksUrl: env.OAUTH_JWKS_URL || '',
    oauthAudience: env.OAUTH_AUDIENCE || '', oauthScope: env.OAUTH_REQUIRED_SCOPE || 'lark:bridge',
    callbackHosts: (env.MCP_CALLBACK_ALLOWED_HOSTS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean),
    allowedOrigins: (env.MCP_ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean),
    replyTtlMs: number(env, 'REPLY_TTL_SECONDS', 900, 10, 3600) * 1000,
    subscriptionTtlMs: number(env, 'SUBSCRIPTION_TTL_SECONDS', 86400, 60, 604800) * 1000,
    queueLimit: number(env, 'QUEUE_LIMIT', 100, 1, 10000), inboundPerMinute: number(env, 'INBOUND_PER_MINUTE', 10, 1, 20),
    repliesPerMinute: number(env, 'REPLIES_PER_MINUTE', 10, 1, 20), maxAttempts: number(env, 'MAX_DELIVERY_ATTEMPTS', 5, 1, 10),
    retryBaseMs: 1000, workerIntervalMs: 500, leaseMs: 60000, textRetentionMs: 7 * 86400000
  };
  if (!['disabled', 'long-connection'].includes(config.larkTransport)) throw new Error('Invalid LARK_TRANSPORT');
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
  if (config.larkTransport === 'long-connection' && (mode !== 'oauth' || !config.larkAppId || !config.larkAppSecret ||
    !config.ownerOpenId || !config.tenantKey || !config.ownerChatId || !config.callbackHosts.length)) {
    throw new Error('Live Feishu transport requires OAuth, complete explicit owner/tenant/chat/app binding, and callback policy');
  }
  if (config.larkTransport === 'long-connection' && !/^cli_[0-9a-fA-F]{16}$/.test(config.larkAppId)) throw new Error('Invalid live Feishu AppID');
  if (!/^[a-zA-Z0-9:_-]{1,128}$/.test(config.oauthScope)) throw new Error('Invalid OAUTH_REQUIRED_SCOPE');
  return Object.freeze(config);
}
