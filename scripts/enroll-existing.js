import * as sdk from '@larksuiteoapi/node-sdk';
import { makeRegistrationPost } from '../src/registration-transport.js';
import { enrollExistingApp } from '../src/enrollment.js';
const [appId, tenantKey, credentialsFile, scanApproval, storageApproval] = process.argv.slice(2);
if (process.argv.length !== 7 || scanApproval !== '--confirm-existing-app-scan' || storageApproval !== '--confirm-private-storage') {
  process.stderr.write('Requires approved app, tenant, private file path, scan and storage approvals. No network started.\n'); process.exit(1);
}
const report = value => process.stdout.write(JSON.stringify(value) + '\n');
sdk.defaultHttpInstance.post = makeRegistrationPost({ report });
const controller = new AbortController();
process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort());
try {
  const result = await enrollExistingApp({ appId, tenantKey: tenantKey === '--tenant-pending' ? undefined : tenantKey, allowUnbound: tenantKey === '--tenant-pending', credentialsFile, approvedScan: true, approvedStorage: true, sdk, report, signal: controller.signal });
  if (!result.enrollment_completed) process.exitCode = 1;
} catch {
  process.stderr.write('Enrollment refused or failed. No secret values printed; verify approved tenant and new private destination before retrying.\n'); process.exitCode = 1;
}
