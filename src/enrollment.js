import { identity } from './credentials.js';
import { assertPrivateDestination } from './private-files.js';
import { createRegistrationSession } from './registration-session.js';

// Enrollment persists only to an explicitly approved private path. It neither
// starts a diagnostic nor claims that owner pairing/OAuth/subscription exist.
export async function enrollExistingApp({ appId, tenantKey, credentialsFile, approvedScan = false,
  approvedStorage = false, allowUnbound = false, sdk, report = () => {}, signal } = {}) {
  if (!approvedScan || !approvedStorage || !/^cli_[0-9a-fA-F]{16}$/.test(appId ?? '') || !(identity(tenantKey) || (allowUnbound && tenantKey === undefined))) throw new Error('Specific enrollment approvals required');
  assertPrivateDestination(credentialsFile);
  if (signal?.aborted) throw new Error('Enrollment cancelled');
  const session = createRegistrationSession({ approved: true, existingAppId: appId, sdk, report });
  const cancel = () => session.discard(); signal?.addEventListener('abort', cancel, { once: true });
  try {
    await session.completion;
    if (signal?.aborted || !session.status().credentials_held_in_memory) return { enrollment_completed: false, credentials_saved: false, current_dot_connected: false };
    if (allowUnbound && tenantKey === undefined) session.saveUnboundApproved({ credentialsFile, approved: true });
    else session.saveApproved({ credentialsFile, tenantKey, approved: true });
    const result = { enrollment_completed: true, credentials_saved: true, pairing_required: true, tenant_binding_required: tenantKey === undefined,
      service_started: false, current_dot_connected: false, storage_protection: 'private_file_permissions_not_encryption' };
    report(result); return result;
  } finally { signal?.removeEventListener('abort', cancel); session.discard(); }
}
