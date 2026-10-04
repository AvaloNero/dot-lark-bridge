import { createServiceSender } from '../src/network.js';
import { readConfig } from '../src/config.js';
import { createPersistentService } from '../src/service.js';
import { supervisedStop } from '../../dot-qq-bridge/packages/dot-bridge-platform/supervised-stop.js';
let service, stopSupervision = () => {};
try {
  if (process.argv.length !== 3 || process.argv[2] !== '--confirm-live-owner-bridge') {
    process.stdout.write('Plan only: live startup requires explicit confirmation, paired credential and storage key file references, private database/lock directories, and an approved current-dot callback policy. No files read or connections started.\n');
  } else {
    const config = readConfig();
    if (config.authMode !== 'tunnel-service' || config.tunnelServiceOperation !== 'live') throw new Error('Explicit live tunnel mode required');
    const send = createServiceSender({ proxyEnv: process.env });
    service = createPersistentService(config, { approved: true, send });
    const stop = () => { stopSupervision(); return service.close().catch(() => { process.exitCode = 1; }); };
    stopSupervision = supervisedStop(stop);
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    process.stdout.write(JSON.stringify({ event: 'service_preflight', ...service.preflight() }) + '\n');
    await service.start();
  }
} catch {
  stopSupervision();
  process.stderr.write('Live tunnel startup refused or failed; no secret values printed.\n');
  if (service) await service.close().catch(() => {});
  process.exitCode = 1;
}
