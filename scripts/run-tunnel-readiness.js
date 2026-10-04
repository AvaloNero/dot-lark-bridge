import { readTunnelReadinessConfig } from '../src/config.js';
import { createApp } from '../src/server.js';
import { supervisedStop } from '../../dot-qq-bridge/packages/dot-bridge-platform/supervised-stop.js';
let app, stopSupervision = () => {};
try {
  const config = readTunnelReadinessConfig();
  if (config.authMode !== 'tunnel-service') throw new Error('Tunnel service mode required');
  app = createApp(config, { worker: false });
  const stop = () => { stopSupervision(); return app.close().catch(() => { process.exitCode = 1; }); };
  stopSupervision = supervisedStop(stop);
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  await app.listen();
  process.stdout.write('Tunnel MCP readiness listener started; provider forwarding disabled.\n');
} catch {
  stopSupervision();
  process.stderr.write('Tunnel readiness listener refused or failed; no secret values printed.\n');
  if (app) await app.close().catch(() => {});
  process.exitCode = 1;
}
