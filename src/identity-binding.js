import { validateCredentials, identity } from './credentials.js';
import { readPrivateJson, writePrivateJson, assertPrivateDestination } from './private-files.js';
// Manual verified-source import: this validates an operator attestation, not a
// cryptographic identity proof. The operator must inspect the official source
// and obtain the user's exact owner/tenant confirmation before the commit step.
export function verifyIdentityEvidence(credentials, evidence, { approved = false, clock = Date.now } = {}) {
  validateCredentials(credentials);
  if (!approved || credentials.status !== 'unbound') throw new Error('Approved unbound identity verification required');
  const keys = ['version', 'source', 'sourceUrl', 'verifiedAt', 'appId', 'tenantKey', 'ownerOpenId', 'confirmedAppId', 'confirmedTenantKey', 'confirmedOwnerOpenId'];
  if (!evidence || Object.keys(evidence).some(k => !keys.includes(k)) || keys.some(k => !Object.hasOwn(evidence, k)) || evidence.version !== 1 ||
      evidence.source !== 'operator-reviewed-official-source' || evidence.appId !== credentials.appId ||
      evidence.confirmedAppId !== evidence.appId || evidence.confirmedTenantKey !== evidence.tenantKey || evidence.confirmedOwnerOpenId !== evidence.ownerOpenId ||
      !identity(evidence.tenantKey) || !identity(evidence.ownerOpenId) || (credentials.ownerOpenId && credentials.ownerOpenId !== evidence.ownerOpenId)) throw new Error('Identity evidence or exact owner confirmation invalid');
  let url; try { url = new URL(evidence.sourceUrl); } catch { throw new Error('Official identity source required'); }
  if (url.protocol !== 'https:' || !['open.feishu.cn', 'accounts.feishu.cn'].includes(url.hostname) || url.username || url.password || url.port || url.search || url.hash) throw new Error('Official identity source required');
  const at = Date.parse(evidence.verifiedAt);
  if (!Number.isFinite(at) || at > clock() + 30000 || clock() - at > 86400000) throw new Error('Fresh verified identity evidence required');
  return validateCredentials({ ...credentials, status: 'registered', tenantKey: evidence.tenantKey, ownerOpenId: evidence.ownerOpenId });
}
export function importVerifiedIdentity({ credentials, evidence, outputFile, approved = false, clock = Date.now, save = writePrivateJson }) {
  const registered = verifyIdentityEvidence(credentials, evidence, { approved, clock });
  assertPrivateDestination(outputFile);
  save(outputFile, registered);
  return { identity_imported: true, pairing_required: true, bridge_started: false };
}
export { readPrivateJson };
