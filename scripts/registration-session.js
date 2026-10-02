import readline from 'node:readline';
import * as lark from '@larksuiteoapi/node-sdk';
import { createRegistrationSession } from '../src/registration-session.js';

if (process.argv.slice(2).join(' ') !== '--confirm-show-code') {
  process.stderr.write('Requires explicit approval to show an official code; no credential file is ever saved by this command.\n');
  process.exitCode = 1;
} else {
  // Dedicated process; credentials remain only in this heap after confirmation.
  // A private write must be explicitly approved later with its exact path and
  // purpose; it never happens in response to a scan or the SDK completion.
  lark.defaultHttpInstance.defaults.timeout = 15000;
  lark.defaultHttpInstance.defaults.maxRedirects = 0;
  const report = value => process.stdout.write(JSON.stringify(value) + '\n');
  const session = createRegistrationSession({ approved: true, report });
  const input = readline.createInterface({ input: process.stdin });
  const stop = () => { session.discard(); input.close(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  input.on('line', line => {
    if (line.trim() === 'status') report(session.status());
    else if (line.trim() === 'discard') { stop(); report(session.status()); }
    else {
      try {
        const command = JSON.parse(line);
        if (command.action !== 'save-after-separate-approval' || command.approved !== true) throw new Error('Not approved');
        report(session.saveApproved({ approved: true, credentialsFile: command.path, tenantKey: command.tenant_key }));
      } catch { report({ phase: 'operator_control_refused', credentials_printed: false }); }
    }
  });
  // Keep the controlled session alive if the user scans after this tool turn.
  const keepAlive = setInterval(() => {}, 30000);
  input.on('close', () => { clearInterval(keepAlive); session.discard(); });
  await session.completion;
}
