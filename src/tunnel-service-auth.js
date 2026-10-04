import fs from 'node:fs';
import path from 'node:path';
import { windowsReadPrivateFile } from '../../dot-qq-bridge/packages/dot-bridge-platform/index.js';
import { createHash, timingSafeEqual } from 'node:crypto';

const loopback = host => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(host);
export const tunnelLive = config => config.authMode === 'tunnel-service' && config.tunnelServiceOperation === 'live';
export const tunnelReadiness = config => config.authMode === 'tunnel-service' && !tunnelLive(config);
export function assertTunnelServiceConfig(config) {
  const operation = config.tunnelServiceOperation || 'readiness';
  if (!['readiness', 'live'].includes(operation) || config.bridgeMode !== 'tunnel' || !['127.0.0.1', '::1'].includes(config.host) ||
      config.publicOrigin || config.oauthIssuer || config.oauthJwksUrl || config.oauthAudience || config.devToken ||
      config.sitesOrigin || config.sitesBindingId || config.sitesPlatformToken || config.sitesConnectorToken || config.allowedOrigins?.length ||
      config.principal !== 'tunnel-owner:dot-bridge' || !path.isAbsolute(config.tunnelServiceKeyFile || '')) {
    throw new Error('Tunnel service requires loopback tunnel mode, fixed local owner and independent file credential');
  }
  if (operation === 'readiness' && (config.larkAppId || config.larkAppSecret || config.callbackHosts?.length || config.larkTransport !== 'disabled' || config.ownerOpenId || config.tenantKey || config.ownerChatId)) throw new Error('Readiness forbids provider binding');
  if (operation === 'live' && (config.larkTransport !== 'long-connection' || !config.pairedCredentialsLoaded || !config.larkAppId || !config.larkAppSecret ||
    !config.ownerOpenId || !config.tenantKey || !config.ownerChatId || !config.storageKeyFile ||
    !path.isAbsolute(config.dbPath || '') || config.dbPath === ':memory:' || !path.isAbsolute(config.bridgeLockDirectory || ''))) throw new Error('Live tunnel requires verified pairing and private persistent file references');
}
export function readPrivateKey(file) {
  if (process.platform === 'win32') {
    let bytes;
    try {
      bytes = windowsReadPrivateFile(file, { maxBytes: 44 });
      const key = bytes.toString('utf8').replace(/\n$/, '');
      if (!/^[a-zA-Z0-9_-]{43}$/.test(key) || Buffer.from(key, 'base64url').toString('base64url') !== key) throw new Error();
      return key;
    } catch { throw new Error('Tunnel service credential file is unavailable or unsafe'); }
    finally { bytes?.fill(0); }
  }
  const opened = [];
  try {
    if (process.platform !== 'linux' || !path.isAbsolute(file) || path.normalize(file) !== file || !fs.constants.O_NOFOLLOW) throw new Error();
    const parts = file.split('/').filter(Boolean), name = parts.pop();
    let directory = fs.openSync('/', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); opened.push(directory);
    for (const part of parts) {
      directory = fs.openSync(`/proc/self/fd/${directory}/${part}`, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); opened.push(directory);
    }
    const parent = fs.fstatSync(directory);
    if (parent.uid !== process.getuid() || (parent.mode & 0o7777) !== 0o700) throw new Error();
    const fd = fs.openSync(`/proc/self/fd/${directory}/${name}`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); opened.push(fd);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600 || stat.size < 43 || stat.size > 44) throw new Error();
    const bytes = fs.readFileSync(fd);
    try {
      const key = bytes.toString('utf8').replace(/\n$/, '');
      if (!/^[a-zA-Z0-9_-]{43}$/.test(key) || Buffer.from(key, 'base64url').toString('base64url') !== key) throw new Error();
      return key;
    } finally { bytes.fill(0); }
  } catch { throw new Error('Tunnel service credential file is unavailable or unsafe'); }
  finally { for (const fd of opened.reverse()) { try { fs.closeSync(fd); } catch { /* no secret-bearing errors */ } } }
}
export function readServiceKeyDigest(file) { return createHash('sha256').update(readPrivateKey(file)).digest(); }
function unsafeHeader(name) {
  return /^(authorization|proxy-authorization|cookie|forwarded)$/.test(name) ||
    /^(x-forwarded-|x-auth|x-user|x-owner|x-principal|x-remote-|x-openai-|x-oai-|x-mcp-owner|x-dot-(?:bridge-)?(?:owner|user|principal|identity)|remote-user$|oai-|openai-)/.test(name);
}
export function createTunnelServiceAuthenticator(config, unauthorized, clock) {
  assertTunnelServiceConfig(config);
  const digest = readServiceKeyDigest(config.tunnelServiceKeyFile);
  return async req => {
    const entries = req.rawHeaders;
    if (!loopback(req.socket?.remoteAddress) || !Array.isArray(entries) || entries.length % 2) throw unauthorized();
    let count = 0;
    for (let i = 0; i < entries.length; i += 2) {
      const name = entries[i].toLowerCase();
      if (name === 'x-dot-bridge-service-key') count++;
      else if (unsafeHeader(name)) throw unauthorized();
    }
    for (const name of Object.keys(req.headers ?? {})) if (unsafeHeader(name.toLowerCase())) throw unauthorized();
    const key = req.headers['x-dot-bridge-service-key'];
    if (count !== 1 || typeof key !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(key) ||
        !timingSafeEqual(createHash('sha256').update(key).digest(), digest)) throw unauthorized();
    return { id: config.principal, validUntil: clock() + config.subscriptionTtlMs };
  };
}
