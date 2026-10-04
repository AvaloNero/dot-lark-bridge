import { loadCredentials } from '../src/credentials.js';
import { importVerifiedIdentity, readPrivateJson } from '../src/identity-binding.js';
const [input, evidence, output, confirmation] = process.argv.slice(2);
if (process.argv.length !== 6 || confirmation !== '--confirm-verified-owner-binding') {
  process.stdout.write('Plan only: review an official Feishu source for exact application, tenant and owner identifiers, obtain matching owner confirmation, then import private evidence and unbound credentials to a new private registered file. No credential files read.\n');
} else {
  try {
    const result = importVerifiedIdentity({ credentials: loadCredentials(input), evidence: readPrivateJson(evidence), outputFile: output, approved: true });
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch { process.stderr.write('Verified identity import refused; no identifiers or secrets printed.\n'); process.exitCode = 1; }
}
