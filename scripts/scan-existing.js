// Dedicated subprocess. Never import this in a running bridge; it deliberately
// replaces only this process's SDK registration POST implementation.
import readline from 'node:readline';
import * as sdk from '@larksuiteoapi/node-sdk';
import { makeRegistrationPost } from '../src/registration-transport.js';
import { createRegistrationSession } from '../src/registration-session.js';
const [appId, approval, probeApproval] = process.argv.slice(2);
if (!/^cli_[0-9a-fA-F]{16}$/.test(appId ?? '') || approval !== '--confirm-existing-app-scan' ||
    !['--confirm-memory-only-wss-probe', '--confirm-memory-only-wss-probe-60s'].includes(probeApproval) || process.argv.length !== 5) {
  process.stderr.write('Requires existing App ID and separate scan/probe approvals. No network started.\n'); process.exit(1);
}
const initialProbeTimeoutMs = probeApproval.endsWith('-60s') ? 60000 : 15000;
const report = value => process.stdout.write(JSON.stringify(value) + '\n');
let latestRequest, latestResponse;
sdk.defaultHttpInstance.post = makeRegistrationPost({ report: value => {
  if (value.phase === 'registration_http_started') latestRequest = value; else latestResponse = value;
  // Pending responses are routine; surface only the first begin and failures.
  if (value.action === 'begin' || (value.phase === 'registration_http' && ![200, 400].includes(value.status))) report(value);
} });
const session = createRegistrationSession({ existingAppId: appId, approved: true, report });
const progressTimer = setInterval(() => {
  const status = session.status();
  report({ phase: 'scan_progress', at: new Date().toISOString(), session: status,
    ...(latestRequest ? { last_http_request: latestRequest } : {}), ...(latestResponse ? { last_http_response: latestResponse } : {}) });
}, 30000);
let finishHold;
const hold = new Promise(resolve => { finishHold = resolve; });
const stop = () => { session.discard(); finishHold(); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
// Operator-only stdin control. Every new probe command requires separate scope
// approval; no secret input/output, storage, arbitrary code or URL is accepted.
const input = readline.createInterface({ input: process.stdin, terminal: false });
input.on('line', line => {
  if (line === 'status') { report(session.status()); return; }
  if (line === 'discard') { stop(); return; }
  const duration = line === 'probe15 --confirm-wss-diagnostic' ? 15000 : line === 'probe60 --confirm-wss-diagnostic' ? 60000 : null;
  if (!duration) { report({ phase: 'operator_command_refused' }); return; }
  session.probeApproved({ approved: true, timeoutMs: duration, report }).then(report).catch(() => report({ phase: 'operator_probe_refused' }));
});
try {
  await session.completion;
  if (session.status().credentials_held_in_memory) {
    report(await session.probeApproved({ approved: true, timeoutMs: initialProbeTimeoutMs, report }));
    report({ phase: 'memory_only_hold', expires_at: new Date(Date.now() + 600000).toISOString(), credentials_saved: false, current_dot_connected: false });
    const timer = setTimeout(stop, 600000); await hold; clearTimeout(timer);
  }
} catch { report({ phase: 'scan_or_probe_failed', credentials_saved: false }); }
finally { clearInterval(progressTimer); input.close(); stop(); report({ phase: 'credentials_discarded', credentials_saved: false }); }
