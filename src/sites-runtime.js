import { BridgeError } from './common.js';
import { createVerifiedLarkDispatcher, createLarkConnection } from './lark-runtime.js';
import { ownerPrivateText, createLarkSender } from './lark.js';
import { makePublicRequester } from './network.js';
import { createSitesClient } from './sites-client.js';
import { SitesLedger } from './sites-ledger.js';

// Outbound-only: no HTTP/MCP listener. Sites is the MCP owner-auth boundary;
// both its user subscription and the existing Feishu owner binding are required.
export function createSitesRuntime(config, { clock = Date.now, send = makePublicRequester(), report = () => {}, sdk,
  client, ledger,
  connectionFactory = createLarkConnection, sender = createLarkSender(config, send, clock) } = {}) {
  if (config.bridgeMode !== 'sites' || config.authMode !== 'deny') throw new Error('Sites worker cannot host local OAuth/MCP');
  client ??= createSitesClient(config, { send, clock });
  ledger ??= new SitesLedger(config);
  let connection, interval, running = false, stopping = false, started = false, lastTick = Promise.resolve(), nextRenewAt = 0, lastPruneAt = 0;
  const active = () => !stopping && client.active();
  const authorize = subscriptionId => {
    if (!active() || client.active().id !== subscriptionId) throw new BridgeError('Sites subscription unavailable', { code: -32012 });
  };
  const inbound = new Set();
  const handleInbound = async data => {
    let message;
    try { message = ownerPrivateText(data, config, clock()); }
    catch (error) { if (error instanceof BridgeError && [400, 403].includes(error.status)) { report('inbound_rejected'); return { outcome: 'rejected' }; } throw error; }
    if (!message) return { outcome: 'ignored' };
    const lease = active(); if (!lease) throw new BridgeError('No active Sites subscription', { status: 503 });
    const record = ledger.prepare(message, lease.id, clock()); authorize(record.subscription_id);
    if (!record.accepted) { await client.ingest(record); authorize(record.subscription_id); ledger.accepted(record.id); }
    return { outcome: record.accepted ? 'duplicate' : 'queued' };
  };
  const dispatcher = createVerifiedLarkDispatcher(config, data => {
    if (stopping) throw new BridgeError('Sites worker stopping', { status: 503 });
    const task = handleInbound(data); inbound.add(task);
    task.then(() => inbound.delete(task), () => inbound.delete(task));
    return task;
  }, { sdk, report });
  function stopConnection() { connection?.close(); connection = undefined; }
  async function runTick() {
    if (running || stopping) return;
    running = true;
    try {
      if (clock() - lastPruneAt > 3600000) { ledger.prune(clock()); lastPruneAt = clock(); }
      if (clock() >= nextRenewAt) {
        nextRenewAt = clock() + 30000;
        try { await client.renew(); report('sites_lease_active'); }
        catch { client.revoke(); stopConnection(); report('sites_lease_unavailable'); return; }
      }
      if (!active()) { stopConnection(); return; }
      if (!connection) { connection = connectionFactory(config, dispatcher, { sdk, send, report }); await connection.start(); }
      const job = ledger.retainedClaim(clock()) ?? await client.claim(); if (!job) return;
      ledger.retainClaim(job);
      let state = ledger.reserveReply(job, clock());
      if (state === 'processing') {
        // Recheck current remote subscription immediately before provider send.
        try {
          await client.renew(); authorize(job.subscription_id);
          const message = ledger.message(job.message_id);
          await sender(message, job.text, { authorize: () => { authorize(job.subscription_id); if (message.expires <= clock() || Date.parse(job.claim_expires_at) <= clock()) throw new BridgeError('Reply expired', { code: -32012 }); } });
          state = 'sent';
        } catch (error) { state = error?.uncertain ? 'uncertain' : 'dead'; }
      }
      ledger.finishReply(job.message_id, state);
      await client.ack(job, state); ledger.releaseClaim(job);
    } catch { report('sites_worker_failed'); }
    finally { running = false; }
  }
  function tick() { if (running || stopping) return lastTick; lastTick = runTick(); return lastTick; }
  return {
    larkRuntime: { status: () => connection?.status() ?? 'disabled' },
    readiness: () => ({ bridge_configuration_ready: true, mcp_subscription_active: Boolean(active()),
      gateway_connected: connection?.status() === 'connected', ready_for_delivery: Boolean(active()) && connection?.status() === 'connected', end_to_end_verified: false }),
    dispatcher, tick,
    async listen() {
      if (started || stopping) throw new Error('Sites worker cannot start twice'); started = true;
      await tick(); if (stopping) return;
      interval = setInterval(() => { tick(); }, config.workerIntervalMs); return null;
    },
    async close() {
      if (stopping) return; stopping = true; clearInterval(interval); client.revoke(); stopConnection();
      await lastTick; await Promise.allSettled([...inbound]); ledger.close();
    }
  };
}
