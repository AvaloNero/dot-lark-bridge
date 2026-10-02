import { readConfig } from './config.js';
import { createApp } from './server.js';

let app;
try {
  const config = readConfig();
  app = createApp(config, { report: event => process.stderr.write(JSON.stringify({ event }) + '\n') });
  // Install shutdown handlers before a potentially slow initial WS connection.
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await app.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  await app.listen();
  if (!stopping) process.stdout.write(JSON.stringify({ status: 'listening', host: config.host, port: config.port,
    mode: config.authMode, lark_transport: app.larkRuntime.status() }) + '\n');
} catch {
  // Startup exceptions can originate in the SDK or secret store; never print them.
  process.stderr.write('Bridge startup failed. Check the configuration and operator runbook.\n');
  if (app) await app.close();
  process.exitCode = 1;
}
