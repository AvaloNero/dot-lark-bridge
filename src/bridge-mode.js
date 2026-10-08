import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash } from './common.js';
import { windowsModeLock } from '../../dot-qq-bridge/packages/dot-bridge-platform/index.js';
export const BRIDGE_MODES = Object.freeze(['tunnel', 'sites']);

export function readBridgeMode(env = process.env, { required = false } = {}) {
  const value = env.BRIDGE_MODE;
  if (value === undefined || value === '') {
    if (required) throw new Error('Select one explicit BRIDGE_MODE: tunnel or sites');
    return null; // Local inspection is allowed; no production runtime implied.
  }
  if (!BRIDGE_MODES.includes(value)) throw new Error('Invalid BRIDGE_MODE');
  return value;
}

export function bridgeModePlan(mode) {
  if (!BRIDGE_MODES.includes(mode)) throw new Error('Select one explicit bridge mode');
  return { mode, local_mcp_server: mode === 'tunnel', sites_queue_worker: mode === 'sites',
    automatic_fallback: false, concurrent_modes: false, live_mode_verified: false };
}

// Factory selection is deliberately single-shot. A failed mode never invokes
// the other factory. Shared owner/channel fencing is acquired by each runtime.
export function createSelectedRuntime(mode, { tunnel, sites }) {
  bridgeModePlan(mode);
  const factory = mode === 'tunnel' ? tunnel : sites;
  if (typeof factory !== 'function') throw new Error('Selected bridge mode is not configured');
  return factory();
}

// Identity is diagnostic only: absence or mismatch never authorizes lock takeover.
function processIdentity() {
  if (process.platform !== 'linux') return { pid_namespace: null, process_start_ticks: null, boot_id: null };
  const stat = fs.readFileSync('/proc/self/stat', 'utf8');
  const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const namespace = fs.readlinkSync('/proc/self/ns/pid');
  const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  if (!/^\d+$/.test(start) || !/^pid:\[\d+\]$/.test(namespace) || !/^[a-f0-9-]{36}$/.test(boot)) throw new Error('Invalid process identity');
  return { pid_namespace: namespace, process_start_ticks: start, boot_id: boot };
}

// Common authority on one cloud computer, independent of mode and DB path.
// A crashed/stale lock fails closed and requires explicit operator recovery.
export function acquireModeLock(directory, channel, appId, mode) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || !['qq', 'lark'].includes(channel) ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(appId ?? '') || !BRIDGE_MODES.includes(mode)) throw new Error('Invalid shared mode lock');
  if (process.platform === 'win32') {
    try { return windowsModeLock(directory, `${hash(`${channel}:${appId}`)}.lock`, { nonce: randomUUID(), mode, pid: process.pid }); }
    catch { throw new Error('Shared mode lock is unavailable or unsafe'); }
  }
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Mode lock path contains symlink');
    if (path.dirname(current) === current) break;
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.statSync(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077)) throw new Error('Mode lock directory must be private');
  const file = path.join(directory, `${hash(`${channel}:${appId}`)}.lock`), nonce = randomUUID();
  const identity = processIdentity();
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify({ nonce, mode, pid: process.pid, ...identity })); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  let released = false;
  return () => {
    if (released) return;
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Mode lock replaced');
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value.nonce !== nonce) throw new Error('Mode lock ownership changed');
    fs.unlinkSync(file); released = true;
  };
}
