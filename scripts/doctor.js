import { localStatus, probeFeishu, probeFeishuConnection } from '../src/doctor.js';
import { readConfig } from '../src/config.js';

try {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--live', '--confirm-remote-read', '--live-wss', '--confirm-wss-diagnostic'].includes(arg)) || new Set(args).size !== args.length ||
      args.includes('--live') !== args.includes('--confirm-remote-read') ||
      args.includes('--live-wss') !== args.includes('--confirm-wss-diagnostic') ||
      (args.includes('--live') && args.includes('--live-wss'))) throw new Error('Invalid doctor arguments');
  const status = args.includes('--live-wss') ? await probeFeishuConnection(readConfig(), { confirmed: true }) : args.includes('--live') ? await probeFeishu(readConfig(), { confirmed: true }) : localStatus();
  process.stdout.write(JSON.stringify(status, null, 2) + '\n');
  if (status.websocket_connected === false || status.configuration_valid === false || status.probe_failed || status.credentials_accepted === false || status.bot_identity_verified === false) process.exitCode = 1;
} catch {
  process.stderr.write('Status check refused. Local mode: no flags. Remote read: --live --confirm-remote-read. Separately approved WSS diagnostic: --live-wss --confirm-wss-diagnostic.\n');
  process.exitCode = 1;
}
