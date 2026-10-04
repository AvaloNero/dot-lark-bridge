import * as lark from '@larksuiteoapi/node-sdk';
import { REGISTRATION_ADDONS } from './setup.js';
import { identity, validateCredentials } from './credentials.js';
import { writePrivateJson } from './private-files.js';
import { probeFeishuConnection } from './doctor.js';

// Separate from the persistent setup wizard. This process creates no credential
// files automatically, starts no bridge, and never returns credential values.
export function createRegistrationSession({ approved = false, sdk = lark, report = () => {}, clock = Date.now,
  timeoutMs = 10 * 60000, existingAppId, probe = probeFeishuConnection } = {}) {
  if (!approved) throw new Error('Showing an official registration code requires owner approval');
  if (existingAppId !== undefined && (typeof existingAppId !== 'string' || !/^cli_[0-9a-fA-F]{16}$/.test(existingAppId))) throw new Error('Verified existing App ID required');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10 * 60000) throw new Error('Invalid registration deadline');
  const controller = new AbortController();
  let probeRunning = false;
  let held, phase = 'starting', expiresAt, timer, pollUpdates = 0, lastPollStatus, lastPollAt, failureCode;
  const status = () => ({ phase, credentials_held_in_memory: Boolean(held), credentials_saved: false,
    bridge_started: false, current_dot_connected: false, poll_updates: pollUpdates,
    ...(failureCode ? { failure_code: failureCode } : {}),
    ...(lastPollStatus ? { last_poll_status: lastPollStatus, last_poll_at: lastPollAt } : {}),
    ...(expiresAt ? { expires_at: new Date(expiresAt).toISOString(), remaining_seconds: Math.max(0, Math.floor((expiresAt - clock()) / 1000)) } : {}) });
  const interrupted = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('Registration cancelled')), { once: true }));
  // Also handle abort if an injected/failed SDK throws before Promise.race installs its handlers.
  interrupted.catch(() => {});
  const completion = (async () => {
    timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const value = await Promise.race([sdk.registerApp({ domain: 'accounts.feishu.cn', source: 'dot-lark-bridge',
        createOnly: existingAppId === undefined, ...(existingAppId ? { appId: existingAppId } : {}),
        addons: REGISTRATION_ADDONS, signal: controller.signal,
        onQRCodeReady(info) {
          const url = new URL(info.url);
          const expiry = Number(info.expireIn);
          if (controller.signal.aborted) throw new Error('Registration cancelled');
          if ((existingAppId && (url.searchParams.getAll('clientID').length !== 1 || url.searchParams.get('clientID') !== existingAppId || url.searchParams.getAll('createOnly').includes('true'))) ||
              url.protocol !== 'https:' || !['accounts.feishu.cn', 'open.feishu.cn'].includes(url.hostname) || url.username || url.password || url.hash ||
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
          if (['polling', 'slow_down'].includes(info.status) && !controller.signal.aborted) {
            pollUpdates++; lastPollStatus = info.status === 'polling' ? 'authorization_pending' : 'slow_down';
            lastPollAt = new Date(clock()).toISOString();
          }
          // Never log responses, descriptions, device codes or returned identities.
        }
      }), interrupted]);
      if (controller.signal.aborted) throw new Error('Registration cancelled');
      if ((existingAppId && value?.client_id !== existingAppId) || !/^cli_[0-9a-fA-F]{16}$/.test(value?.client_id) || typeof value.client_secret !== 'string' ||
          value.client_secret.length < 16 || (value.user_info?.tenant_brand && value.user_info.tenant_brand !== 'feishu')) {
        throw new Error('Unexpected application credentials');
      }
      held = value; phase = 'confirmed_awaiting_storage_approval';
      report(status()); return status();
    } catch (error) {
      held = undefined;
      const safeCodes = new Set(['registration_timeout', 'registration_connection_refused', 'registration_proxy_refused',
        'registration_proxy_required', 'registration_http_refused', 'registration_response_failed',
        'registration_response_invalid', 'registration_response_limit', 'registration_target_refused', 'registration_parameters_refused']);
      if (safeCodes.has(error?.code)) failureCode = error.code;
      if (phase !== 'unsupported_tenant_brand') phase = ['access_denied', 'expired_token', 'abort'].includes(error?.code) ? error.code :
        controller.signal.aborted ? 'abort' : 'registration_failed';
      report(status()); return status();
    } finally { clearTimeout(timer); }
  })();
  return { status, completion, discard() { held = undefined; phase = 'discarded'; controller.abort(); },
    async probeApproved({ approved: probeApproved = false, timeoutMs: probeTimeoutMs = 15000, report: probeReport = () => {} } = {}) {
      if (!probeApproved || !held || controller.signal.aborted || probeRunning ||
          !Number.isInteger(probeTimeoutMs) || probeTimeoutMs < 1 || probeTimeoutMs > 60000) throw new Error('Separate WSS probe approval required');
      probeRunning = true;
      try { return await probe({ larkAppId: held.client_id, larkAppSecret: held.client_secret },
        { confirmed: true, timeoutMs: probeTimeoutMs, signal: controller.signal, report: probeReport }); }
      finally { probeRunning = false; }
    },
    saveUnboundApproved({ credentialsFile, approved: storageApproved = false } = {}) {
      if (!storageApproved || !held) throw new Error('Separate private-storage approval required');
      const credentials = validateCredentials({ version: 1, status: 'unbound', appId: held.client_id,
        appSecret: held.client_secret, ...(held.user_info?.open_id ? { ownerOpenId: held.user_info.open_id } : {}),
        registeredAt: new Date(clock()).toISOString() });
      writePrivateJson(credentialsFile, credentials); held = undefined; phase = 'saved_unbound_after_explicit_storage_approval';
      return { ...status(), credentials_saved: true, owner_binding_complete: false };
    },
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
