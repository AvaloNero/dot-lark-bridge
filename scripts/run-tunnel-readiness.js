import { readTunnelReadinessConfig } from '../src/config.js';
import { createApp } from '../src/server.js';
let app;
try {
  const config = readTunnelReadinessConfig();
  if (config.authMode !== 'tunnel-service') throw new Error('Tunnel service mode required');
  app = createApp(config, { worker: false });
  const stop = () => app.close().catch(() => { process.exitCode = 1; });
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  await app.listen();
  process.stdout.write('Tunnel MCP readiness listener started; provider forwarding disabled.\n');
} catch {
  process.stderr.write('Tunnel readiness listener refused or failed; no secret values printed.\n');
  if (app) await app.close().catch(() => {});
  process.exitCode = 1;
}
