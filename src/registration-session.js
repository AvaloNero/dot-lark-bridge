import * as lark from '@larksuiteoapi/node-sdk';
import { REGISTRATION_ADDONS } from './setup.js';
import { identity, validateCredentials } from './credentials.js';
import { writePrivateJson } from './private-files.js';

// Separate from the persistent setup wizard. This process creates no credential
// files automatically, starts no bridge, and never returns credential values.
export function createRegistrationSession({ approved = false, sdk = lark, report = () => {}, clock = Date.now,
  timeoutMs = 10 * 60000 } = {}) {
  if (!approved) throw new Error('Showing an official registration code requires owner approval');
  const controller = new AbortController();
  let held, phase = 'starting', expiresAt, timer;
  const status = () => ({ phase, credentials_held_in_memory: Boolean(held), credentials_saved: false,
    bridge_started: false, current_dot_connected: false,
    ...(expiresAt ? { expires_at: new Date(expiresAt).toISOString(), remaining_seconds: Math.max(0, Math.floor((expiresAt - clock()) / 1000)) } : {}) });
  const completion = (async () => {
    timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const value = await sdk.registerApp({ domain: 'accounts.feishu.cn', source: 'dot-lark-bridge', createOnly: true,
        addons: REGISTRATION_ADDONS, signal: controller.signal,
        onQRCodeReady(info) {
          const url = new URL(info.url);
          const expiry = Number(info.expireIn);
          if (url.protocol !== 'https:' || !['accounts.feishu.cn', 'open.feishu.cn'].includes(url.hostname) || url.username || url.password || url.hash ||
              (url.port && url.port !== '443') || !Number.isInteger(expiry) || expiry <= 0 || expiry > 3600 ||
              [...url.searchParams.keys()].some(key => /^(?:app_secret|client_secret|access_token|refresh_token|device_code)$/i.test(key))) {
            report({ phase: 'verification_link_refused', origin: url.origin,
              parameter_names: [...url.searchParams.keys()], expiry_type: typeof info.expireIn });
            controller.abort(); throw new Error('Unexpected official verification link');
          }
          // The startup bound must not truncate a valid code's advertised life.
          // Official SDK polling owns expiry; this is only a fallback deadline.
          clearTimeout(timer); timer = setTimeout(() => controller.abort(), expiry * 1000 + 15000);
          phase = 'awaiting_owner_scan'; expiresAt = clock() + expiry * 1000;
          report({ ...status(), verification_url: url.href, expires_in_seconds: expiry });
        },
        onStatusChange(info) {
          if (info.status === 'domain_switched') { phase = 'unsupported_tenant_brand'; controller.abort(); }
          // Poll responses and descriptions are deliberately never logged.
        }
      });
      if (controller.signal.aborted) throw new Error('Registration cancelled');
      if (!/^cli_[0-9a-fA-F]{16}$/.test(value?.client_id) || typeof value.client_secret !== 'string' ||
          value.client_secret.length < 16 || (value.user_info?.tenant_brand && value.user_info.tenant_brand !== 'feishu')) {
        throw new Error('Unexpected application credentials');
      }
      held = value; phase = 'confirmed_awaiting_storage_approval';
      report(status()); return status();
    } catch (error) {
      held = undefined;
      if (phase !== 'unsupported_tenant_brand') phase = ['access_denied', 'expired_token', 'abort'].includes(error?.code) ? error.code :
        controller.signal.aborted ? 'abort' : 'registration_failed';
      report(status()); return status();
    } finally { clearTimeout(timer); }
  })();
  return { status, completion, discard() { held = undefined; phase = 'discarded'; controller.abort(); },
    // Dormant until a separate explicit approval names the private path and
    // purpose. Does not pair, configure, start a bridge or request new scopes.
    saveApproved({ credentialsFile, tenantKey, approved: storageApproved = false } = {}) {
      if (!storageApproved || !held || !identity(tenantKey)) throw new Error('Separate private-storage approval required');
      const credentials = validateCredentials({ version: 1, status: 'registered', appId: held.client_id,
        appSecret: held.client_secret, tenantKey, ...(held.user_info?.open_id ? { ownerOpenId: held.user_info.open_id } : {}),
        registeredAt: new Date(clock()).toISOString() });
      writePrivateJson(credentialsFile, credentials);
      held = undefined; phase = 'saved_after_explicit_storage_approval';
      return { ...status(), credentials_saved: true };
    } };
}
