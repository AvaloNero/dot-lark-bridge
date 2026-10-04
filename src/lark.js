import { BridgeError, hash, object, plainText, string } from './common.js';

export const FEISHU_ORIGIN = 'https://open.feishu.cn';
export const INBOUND_EVENT = 'im.message.receive_v1';

function millis(value) {
  if (typeof value !== 'string' || !/^\d{13}$/.test(value)) throw new BridgeError('Invalid Feishu millisecond timestamp');
  const at = Number(value);
  if (!Number.isSafeInteger(at)) throw new BridgeError('Invalid Feishu timestamp');
  return at;
}

// Called only by the official SDK long-connection dispatcher; never from HTTP.
// The SDK merges the V2 event header and event into this callback data.
export function incomingMessage(data, config, now) {
  if (!config.ownerOpenId || !config.tenantKey || !config.ownerChatId || !config.larkAppId || !config.principal || config.authMode === 'deny') {
    throw new BridgeError('Owner binding is not configured', { status: 503 });
  }
  return ownerPrivateText(data, config, now);
}

// Shared by normal ingestion and the operator-only pairing dispatcher. Pairing
// has no MCP server or tools and must already know the approved app/tenant/owner.
export function ownerPrivateText(data, config, now) {
  if (!config.ownerOpenId || !config.tenantKey || !config.ownerChatId || !config.larkAppId) {
    throw new BridgeError('Feishu identity is incomplete', { status: 503 });
  }
  if (!data || data.event_type !== INBOUND_EVENT || data.app_id !== config.larkAppId ||
      data.tenant_key !== config.tenantKey || data.sender?.tenant_key !== config.tenantKey ||
      data.sender?.sender_id?.open_id !== config.ownerOpenId || data.sender?.sender_type !== 'user') {
    throw new BridgeError('Feishu source or identity is not allowlisted', { status: 403 });
  }
  const message = data.message;
  if (!message || message.chat_type !== 'p2p' || message.chat_id !== config.ownerChatId) {
    throw new BridgeError('Feishu conversation is not allowlisted', { status: 403 });
  }
  if (message.message_type !== 'text' || message.root_id || message.parent_id ||
      (message.mentions !== undefined && (!Array.isArray(message.mentions) || message.mentions.length))) return null;
  string(message.message_id, 256); string(data.event_id, 256);
  let content;
  try { content = JSON.parse(string(message.content, 10000)); } catch { throw new BridgeError('Invalid Feishu text content'); }
  object(content, ['text'], ['text']); plainText(content.text);
  const occurred = millis(message.create_time), eventAt = millis(data.create_time);
  if (occurred > now + 30000 || eventAt > now + 30000 || occurred + config.replyTtlMs <= now ||
      Math.abs(eventAt - occurred) > 60000) throw new BridgeError('Feishu message is too old or in the future');
  return { id: message.message_id, sourceEventId: data.event_id, owner: config.ownerOpenId, tenantKey: config.tenantKey,
    chatId: config.ownerChatId, text: content.text, timestamp: new Date(occurred).toISOString(), expires: occurred + config.replyTtlMs };
}

// A stable platform deduplication key is defense in depth. Unknown acknowledgements
// still become terminal 'uncertain'; the worker never automatically re-sends them.
export function replyUuid(appId, messageId) {
  const digest = hash(`${appId}:${messageId}:reply:1`).slice(0, 32);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20)}`;
}
export function createLarkSender(config, send, clock = Date.now) {
  let token, expires = 0, pending;
  async function getToken(authorize) {
    if (token && expires > clock() + 60000) return token;
    if (!pending) pending = (async () => {
      try {
        const response = await send(`${FEISHU_ORIGIN}/open-apis/auth/v3/tenant_access_token/internal`, {
          purpose: 'provider', hosts: ['open.feishu.cn'], headers: { 'Content-Type': 'application/json' }, beforeConnect: authorize,
          body: Buffer.from(JSON.stringify({ app_id: config.larkAppId, app_secret: config.larkAppSecret })) });
        const data = JSON.parse(response.body.toString('utf8'));
        if (response.status !== 200 || data.code !== 0 || typeof data.tenant_access_token !== 'string' || !data.tenant_access_token ||
            !Number.isSafeInteger(data.expire) || data.expire <= 60 || data.expire > 86400) {
          throw new BridgeError('Feishu application token request rejected', { retryable: response.status === 429 || response.status >= 500 });
        }
        token = data.tenant_access_token; expires = clock() + data.expire * 1000;
        return token;
      } catch (error) {
        if (error instanceof BridgeError) throw error;
        throw new BridgeError('Feishu application token request failed', { retryable: true });
      }
    })().finally(() => { pending = undefined; });
    return pending;
  }
  return async function sendReply(message, text, { authorize = () => {} } = {}) {
    if (message.owner !== config.ownerOpenId || message.tenant_key !== config.tenantKey || message.chat_id !== config.ownerChatId) {
      throw new BridgeError('Reply route is no longer authorized', { code: -32012 });
    }
    plainText(text); authorize();
    const accessToken = await getToken(authorize);
    if (message.expires <= clock()) throw new BridgeError('Bridge reply deadline expired', { code: -32012 });
    authorize();
    let response;
    try {
      response = await send(`${FEISHU_ORIGIN}/open-apis/im/v1/messages/${encodeURIComponent(message.id)}/reply`, {
        purpose: 'provider', hosts: ['open.feishu.cn'], headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: Buffer.from(JSON.stringify({ msg_type: 'text', content: JSON.stringify({ text }), reply_in_thread: false,
          uuid: replyUuid(config.larkAppId, message.id) })), beforeConnect: authorize });
    } catch (error) {
      if (error instanceof BridgeError && error.code === -32012) throw error;
      throw new BridgeError('Feishu reply acknowledgement unknown', { uncertain: true });
    }
    if (response.status === 401) { token = undefined; expires = 0; throw new BridgeError('Feishu authentication rejected', { retryable: true }); }
    if (response.status === 429) throw new BridgeError('Feishu rate limited', { retryable: true });
    if (response.status >= 500) throw new BridgeError('Feishu reply acknowledgement unknown', { uncertain: true });
    if (response.status < 200 || response.status >= 300) throw new BridgeError('Feishu reply rejected');
    let data;
    try { data = JSON.parse(response.body.toString('utf8')); } catch { throw new BridgeError('Feishu reply acknowledgement unknown', { uncertain: true }); }
    if (!Number.isInteger(data?.code)) throw new BridgeError('Feishu reply acknowledgement unknown', { uncertain: true });
    if (data.code !== 0) {
      // An explicit platform rejection is terminal in this minimal prototype.
      throw new BridgeError('Feishu reply rejected');
    }
    if (typeof data.data?.message_id !== 'string' || !data.data.message_id || data.data.chat_id !== message.chat_id) {
      throw new BridgeError('Feishu reply acknowledgement unknown', { uncertain: true });
    }
    return data.data.message_id;
  };
}
