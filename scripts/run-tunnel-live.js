import { readConfig } from '../src/config.js';
import { createPersistentService } from '../src/service.js';
let service;
try {
  if (process.argv.length !== 3 || process.argv[2] !== '--confirm-live-owner-bridge') {
    process.stdout.write('Plan only: live startup requires explicit confirmation, paired credential and storage key file references, private database/lock directories, and an approved current-dot callback policy. No files read or connections started.\n');
  } else {
    const config = readConfig();
    if (config.authMode !== 'tunnel-service' || config.tunnelServiceOperation !== 'live') throw new Error('Explicit live tunnel mode required');
    service = createPersistentService(config, { approved: true });
    const stop = () => service.close().catch(() => { process.exitCode = 1; });
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    await service.start();
  }
} catch {
  process.stderr.write('Live tunnel startup refused or failed; no secret values printed.\n');
  if (service) await service.close().catch(() => {});
  process.exitCode = 1;
}
