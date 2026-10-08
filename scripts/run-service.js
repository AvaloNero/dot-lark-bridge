import { createFormalServiceSender } from '../src/formal-sender.js';
import { readConfig } from '../src/config.js';
import { createPersistentService } from '../src/service.js';
let service;
try {
  if (process.argv.length !== 3 || process.argv[2] !== '--confirm-persistent-service') throw new Error('Explicit production approval required');
  const config = readConfig();
  const send = createFormalServiceSender(config, { proxyEnv: process.env });
  service = createPersistentService(config, { approved: true, send });
  const stop = () => { service.close().catch(() => { process.exitCode = 1; }); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  process.stdout.write(JSON.stringify({ event: 'service_preflight', ...service.preflight() }) + '\n');
  await service.start();
} catch {
  process.stderr.write('Persistent service refused or failed; verify approved binding, OAuth, private storage and deployment configuration. No secret values printed.\n');
  if (service) { try { await service.close(); } catch { /* Never print shutdown error details. */ } }
  process.exitCode = 1;
}
