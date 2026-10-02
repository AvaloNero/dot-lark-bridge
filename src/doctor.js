import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readConfig } from './config.js';
import { makePublicRequester } from './network.js';
import { FEISHU_ORIGIN } from './lark.js';

export function localStatus(env = process.env) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const status = { mode: 'LOCAL_READ_ONLY', node_supported: major === 24 && minor >= 15, sqlite_available: Boolean(DatabaseSync),
    configuration_valid: false, private_binding_file_selected: Boolean(env.LARK_CREDENTIALS_FILE),
    live_credentials_verified: false, current_dot_connected: false };
  let config;
  try { config = readConfig(env); status.configuration_valid = true; }
  catch { status.next_step = 'Fix configuration locally; no values were printed'; return status; }
  const key = Buffer.from(config.storageKey, 'base64');
  status.storage_key_valid = key.length === 32 && key.toString('base64') === config.storageKey;
  status.owner_binding_complete = Boolean(config.larkAppId && config.larkAppSecret && config.tenantKey && config.ownerOpenId && config.ownerChatId);
  status.oauth_selected = config.authMode === 'oauth'; status.live_transport_selected = config.larkTransport === 'long-connection';
  status.callback_policy_selected = config.callbackHosts.length > 0;
  status.database_exists = config.dbPath !== ':memory:' && fs.existsSync(config.dbPath);
  status.database_directory_exists = fs.existsSync(path.dirname(config.dbPath));
  if (status.database_exists) {
    let db;
    try {
      db = new DatabaseSync(config.dbPath, { readOnly: true });
      status.active_subscriptions = db.prepare('SELECT count(*) AS n FROM subscriptions WHERE active=1 AND expires>?').get(Date.now()).n;
      status.jobs = db.prepare('SELECT kind,state,count(*) AS count FROM jobs GROUP BY kind,state ORDER BY kind,state').all();
      status.database_readable = true;
    } catch { status.database_readable = false; }
    finally { db?.close(); }
  }
  status.local_configuration_ready = status.node_supported && status.storage_key_valid && status.owner_binding_complete &&
    status.oauth_selected && status.live_transport_selected && status.callback_policy_selected;
  return status;
}

// Explicitly approved read-only probe: app token then bot identity. No message,
// scope change, registration, OAuth grant or model action; never print raw data.
export async function probeFeishu(config, { confirmed = false, send = makePublicRequester() } = {}) {
  if (!confirmed) throw new Error('Remote read requires prior approval and --confirm-remote-read');
  if (!config.larkAppId || !config.larkAppSecret) throw new Error('Private app credentials required');
  try {
    const response = await send(`${FEISHU_ORIGIN}/open-apis/auth/v3/tenant_access_token/internal`, {
      hosts: ['open.feishu.cn'], headers: { 'Content-Type': 'application/json' },
      body: Buffer.from(JSON.stringify({ app_id: config.larkAppId, app_secret: config.larkAppSecret })) });
    const token = JSON.parse(response.body.toString('utf8'));
    if (response.status !== 200 || token?.code !== 0 || typeof token.tenant_access_token !== 'string' || !token.tenant_access_token) {
      return { mode: 'APPROVED_REMOTE_READ', credentials_accepted: false, bot_identity_verified: false, current_dot_connected: false };
    }
    const identity = await send(`${FEISHU_ORIGIN}/open-apis/bot/v3/info`, { method: 'GET', hosts: ['open.feishu.cn'],
      headers: { Authorization: `Bearer ${token.tenant_access_token}` } });
    const data = JSON.parse(identity.body.toString('utf8'));
    return { mode: 'APPROVED_REMOTE_READ', credentials_accepted: true,
      bot_identity_verified: identity.status === 200 && data?.code === 0 && typeof data.bot?.open_id === 'string' && Boolean(data.bot.open_id),
      owner_or_scopes_verified: false, current_dot_connected: false };
  } catch { return { mode: 'APPROVED_REMOTE_READ', probe_failed: true, current_dot_connected: false }; }
}
