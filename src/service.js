import { safeCallbackTransportStatus } from './network.js';
import { assertTunnelServiceConfig, tunnelLive } from './tunnel-service-auth.js';
import { createApp } from './server.js';
import { createSitesRuntime } from './sites-runtime.js';
import { bridgeModePlan, acquireModeLock, createSelectedRuntime } from './bridge-mode.js';
const EVENTS = new Set(['lark_connected', 'lark_reconnected', 'lark_reconnecting', 'lark_connection_failed',
  'lark_sdk_warning', 'lark_sdk_error', 'inbound_rejected', 'lark_discovery_started', 'lark_discovery_failed',
  'lark_discovery_http_received', 'lark_discovery_http_rejected', 'lark_discovery_invalid',
  'lark_discovery_platform_rejected', 'lark_discovery_endpoint_verified', 'sites_lease_active', 'sites_lease_unavailable', 'sites_worker_failed']);
const STATES = new Set(['disabled', 'connecting', 'reconnecting', 'connected', 'failed', 'idle']);

// Long-running production entry, distinct from scan/diagnostic sessions. No
// timeout auto-discards its credentials. An approved private mount owns storage.
export function createPersistentService(config, { approved = false, appFactory = createApp, sitesFactory = createSitesRuntime, modeLock = acquireModeLock,
  emit = record => process.stdout.write(JSON.stringify(record) + '\n'), clock = Date.now,
  heartbeatMs = 30000, schedule = setInterval, unschedule = clearInterval } = {}) {
  if (!approved) throw new Error('Persistent service requires explicit approval');
  bridgeModePlan(config.bridgeMode);
  if (config.authMode === 'tunnel-service') assertTunnelServiceConfig(config);
  if ((config.bridgeMode === 'tunnel' ? !(['oauth'].includes(config.authMode) || (config.authMode === 'tunnel-service' && config.tunnelServiceOperation === 'live')) : config.authMode !== 'deny') || config.larkTransport !== 'long-connection') throw new Error('Production OAuth and transport required');
  if (!Number.isInteger(heartbeatMs) || heartbeatMs < 1000 || heartbeatMs > 300000) throw new Error('Invalid heartbeat interval');
  let app, timer, releaseModeLock, lifecycle = 'created', startedAt, previousState, closing, startupSettled, settleStartup;
  const counts = { connects: 0, reconnects: 0, reconnecting: 0, failures: 0 };
  const log = (event, fields = {}) => {
    try { emit({ at: new Date(clock()).toISOString(), event, ...fields }); }
    catch { /* Logging must never block startup settlement or resource teardown. */ }
  };
  const snapshot = () => {
    const rawState = app?.larkRuntime.status(), state = STATES.has(rawState) ? rawState : 'unknown';
    const value = app?.readiness() ?? {};
    return { callback_transport: safeCallbackTransportStatus(value.callback_transport), mode: config.bridgeMode, lifecycle, uptime_seconds: startedAt === undefined ? 0 : Math.max(0, Math.floor((clock() - startedAt) / 1000)),
      gateway_state: state, bridge_configuration_ready: value.bridge_configuration_ready === true,
      mcp_subscription_active: value.mcp_subscription_active === true, gateway_connected: value.gateway_connected === true,
      ready_for_delivery: value.ready_for_delivery === true, end_to_end_verified: false, ...counts };
  };
  const observe = () => {
    try {
      const value = snapshot();
      if (previousState === 'connected' && value.gateway_state !== 'connected') log('gateway_disconnected', value);
      previousState = value.gateway_state;
      log('service_heartbeat', value); // process heartbeat, not a verified pong
    } catch { log('service_heartbeat_failed'); }
  };
  function report(event) {
    if (!EVENTS.has(event) || lifecycle === 'stopped') return;
    if (event === 'lark_connected') counts.connects++;
    if (event === 'lark_reconnected') counts.reconnects++;
    if (event === 'lark_reconnecting') counts.reconnecting++;
    if (event === 'lark_connection_failed') counts.failures++;
    log(event, { end_to_end_verified: false });
  }
  return { snapshot,
    async start() {
      if (lifecycle !== 'created') throw new Error('Service cannot start twice');
      startupSettled = new Promise(resolve => { settleStartup = resolve; });
      lifecycle = 'starting'; startedAt = clock(); log('service_starting');
      try {
        releaseModeLock = modeLock(config.bridgeLockDirectory, 'lark', config.larkAppId, config.bridgeMode);
        app = createSelectedRuntime(config.bridgeMode, { tunnel: () => appFactory(config, { report, approvedLive: tunnelLive(config) }), sites: () => sitesFactory(config, { report }) });
        timer = schedule(observe, heartbeatMs); timer?.unref?.();
        await app.listen();
        if (lifecycle === 'starting') { lifecycle = 'running'; log('service_listening', snapshot()); observe(); }
      } catch {
        settleStartup?.();
        try { await this.close(); } catch { /* Preserve sanitized startup failure. */ }
        throw new Error('Production service start failed');
      } finally { settleStartup?.(); }
    },
    async close() {
      if (!closing) closing = (async () => {
        lifecycle = 'stopping'; unschedule(timer); log('service_stopping');
        try {
          await startupSettled;
          await app?.close(); releaseModeLock?.();
        }
        catch {
          lifecycle = 'stop_failed'; log('service_stop_failed', { end_to_end_verified: false });
          throw new Error('Production service shutdown failed');
        }
        lifecycle = 'stopped'; log('service_stopped', { end_to_end_verified: false });
      })();
      return closing;
    }
  };
}
