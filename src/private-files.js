import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function noSymlinks(file) {
  let current = path.resolve(file);
  while (true) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Private file path may not contain symlinks');
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}
export function readPrivateJson(file) {
  noSymlinks(file);
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 16384 || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('Private file permissions or size invalid');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('Private file is invalid'); }
}
export function writePrivateJson(file, value) {
  const absolute = assertPrivateDestination(file);
  const fd = fs.openSync(absolute, 'wx', 0o600);
  try {
    if (process.platform === 'win32') {
      const identity = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
      const sid = identity.match(/S-1-5-(?:\d+-)*\d+/)?.[0];
      if (!sid) throw new Error('Private file owner unavailable');
      execFileSync('icacls.exe', [absolute, '/inheritance:r', '/grant:r', `*${sid}:(F)`, '*S-1-5-18:(F)'],
        { stdio: 'pipe', windowsHide: true });
    }
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd);
  } catch {
    fs.closeSync(fd); fs.unlinkSync(absolute);
    throw new Error('Private file could not be saved; no credentials were printed');
  }
  fs.closeSync(fd);
}
export function assertPrivateDestination(file) {
  const absolute = path.resolve(file); noSymlinks(absolute);
  if (fs.existsSync(absolute)) throw new Error('Private destination already exists; no overwrite allowed');
  const parent = path.dirname(absolute);
  if (!fs.statSync(parent).isDirectory() || (process.platform !== 'win32' && (fs.statSync(parent).mode & 0o077))) throw new Error('Choose an existing private directory');
  return absolute;
}
