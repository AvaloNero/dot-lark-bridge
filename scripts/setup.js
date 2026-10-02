import { setupPlan, registerFeishu, pairFeishu } from '../src/setup.js';
import { loadCredentials } from '../src/credentials.js';

const help = `Operator setup (default: plan; no network or file writes)
  node scripts/setup.js plan
  node scripts/setup.js status --credentials <private-file>
After explicit main-thread approval only:
  node scripts/setup.js register --credentials <new-private-file> --tenant-key <approved-key> --confirm-create-app
  node scripts/setup.js pair --credentials <registered-file> --binding <new-private-file> --confirm-bind
Pair needs the verified scanning user's open_id, or --owner-open-id <verified-id> if absent.
The confirmation flags acknowledge prior approval; they do not grant permission.
Never paste credentials or the verification URL into chat or commit them.\n`;
function args(argv) {
  const command = argv.shift() || 'plan', values = {};
  const allowed = { plan: [], status: ['credentials'], register: ['credentials', 'tenant-key', 'confirm-create-app'],
    pair: ['credentials', 'binding', 'owner-open-id', 'confirm-bind'] };
  if (!Object.hasOwn(allowed, command)) throw new Error('Unknown setup command');
  while (argv.length) {
    const key = argv.shift();
    if (!key.startsWith('--') || !allowed[command].includes(key.slice(2)) || Object.hasOwn(values, key)) throw new Error('Invalid setup argument');
    if (key.startsWith('--confirm-')) values[key] = true;
    else {
      const value = argv.shift(); if (!value || value.startsWith('--')) throw new Error('Missing setup argument');
      values[key] = value;
    }
  }
  return { command, values };
}
const report = value => process.stdout.write(JSON.stringify(value) + '\n');
const controller = new AbortController();
const cancel = () => controller.abort();
process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
try {
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) process.stdout.write(help);
  else {
    const { command, values } = args(argv);
    if (command === 'plan') report(setupPlan());
    else if (command === 'status') {
      if (!values['--credentials']) throw new Error('Private credentials file required');
      const credentials = loadCredentials(values['--credentials']);
      report({ mode: 'LOCAL_READ_ONLY', credentials_readable: true, registered: true,
        owner_candidate_available: Boolean(credentials.ownerOpenId), owner_binding_complete: credentials.status === 'paired',
        live_permissions_checked: false, current_dot_connected: false });
    } else if (command === 'register') await registerFeishu({ credentialsFile: values['--credentials'],
      tenantKey: values['--tenant-key'], confirmed: values['--confirm-create-app'], signal: controller.signal, report });
    else if (command === 'pair') {
      if (!values['--confirm-bind']) throw new Error('Owner pairing requires --confirm-bind');
      await pairFeishu({ credentials: loadCredentials(values['--credentials']), bindingFile: values['--binding'],
        ownerOpenId: values['--owner-open-id'], confirmed: true, signal: controller.signal, report });
    }
  }
} catch (error) {
  // SDK descriptions, environment values and filesystem errors are never logged.
  const reason = ['abort', 'access_denied', 'expired_token'].includes(error.code) ? error.code : 'setup_failed';
  process.stderr.write(JSON.stringify({ phase: reason, credentials_printed: false,
    next_step: 'Review --help, approved tenant/owner, private destination, and official app console locally' }) + '\n');
  process.exitCode = 1;
} finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
