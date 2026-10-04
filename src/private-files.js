import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const MAX_BYTES = 16384;
const unavailable = () => new Error('Private file is unavailable or unsafe');
const unsaved = () => new Error('Private file could not be saved; no credentials were printed');
function closeAll(opened) {
  for (const fd of opened.reverse()) { try { fs.closeSync(fd); } catch { /* Never expose filesystem errors. */ } }
}
function privateParent(fd) {
  const stat = fs.fstatSync(fd);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o700) throw unavailable();
}
function privateFile(fd) {
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600 || stat.size > MAX_BYTES) throw unavailable();
  return stat;
}
function openParent(file, opened) {
  // Keep each directory open while descending. No later operation re-resolves
  // the caller's pathname, even if an ancestor is renamed or replaced.
  if (process.platform !== 'linux' || !fs.constants.O_NOFOLLOW || !fs.constants.O_DIRECTORY) throw unavailable();
  const absolute = path.resolve(file), parts = absolute.split('/').filter(Boolean), name = parts.pop();
  if (!name) throw unavailable();
  const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
  let directory = fs.openSync('/', flags); opened.push(directory);
  for (const part of parts) {
    directory = fs.openSync(`/proc/self/fd/${directory}/${part}`, flags); opened.push(directory);
  }
  privateParent(directory);
  return { absolute, directory, entry: `/proc/self/fd/${directory}/${name}` };
}
function missingEntry(entry) {
  try { fs.lstatSync(entry); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error('Private destination already exists; no overwrite allowed');
}
function cleanupCreated(entry, created) {
  if (!entry || !created) return;
  try {
    const current = fs.lstatSync(entry);
    // A failed write must never remove a replacement file or follow a symlink.
    if (current.isFile() && current.dev === created.dev && current.ino === created.ino && current.nlink === 1) fs.unlinkSync(entry);
  } catch { /* Fail closed without leaking a credential path. */ }
}
function serialized(value) {
  const json = JSON.stringify(value, null, 2);
  if (json === undefined) throw unsaved();
  const bytes = Buffer.from(json + '\n');
  if (bytes.length > MAX_BYTES) { bytes.fill(0); throw unsaved(); }
  return bytes;
}

export function readPrivateJson(file) {
  if (process.platform === 'win32') return readWindowsPrivateJson(file);
  const opened = [], bytes = Buffer.alloc(MAX_BYTES + 1);
  try {
    const { directory, entry } = openParent(file, opened);
    const fd = fs.openSync(entry, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); opened.push(fd);
    privateFile(fd);
    let count = 0, read;
    do {
      read = fs.readSync(fd, bytes, count, bytes.length - count, count); count += read;
    } while (read && count < bytes.length);
    privateParent(directory); privateFile(fd);
    if (count > MAX_BYTES) throw unavailable();
    return JSON.parse(bytes.toString('utf8', 0, count));
  } catch { throw unavailable(); }
  finally { bytes.fill(0); closeAll(opened); }
}
export function writePrivateJson(file, value) {
  if (process.platform === 'win32') return writeWindowsPrivateJson(file, value);
  const opened = []; let bytes, entry, created;
  try {
    bytes = serialized(value);
    const parent = openParent(file, opened); entry = parent.entry;
    const fd = fs.openSync(entry, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    opened.push(fd); created = fs.fstatSync(fd);
    privateParent(parent.directory); privateFile(fd);
    fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);
    privateParent(parent.directory); privateFile(fd);
  } catch { cleanupCreated(entry, created); throw unsaved(); }
  finally { bytes?.fill(0); closeAll(opened); }
}
export function assertPrivateDestination(file) {
  if (process.platform === 'win32') return assertWindowsPrivateDestination(file);
  const opened = [];
  try {
    const { absolute, entry } = openParent(file, opened); missingEntry(entry); return absolute;
  } catch { throw new Error('Choose a new destination in an existing owned private directory; no overwrite allowed'); }
  finally { closeAll(opened); }
}

// Preserve the Windows ACL setup. Descriptor-relative traversal is Linux-only;
// other Unix platforms are rejected rather than falling back to pathname checks.
function noWindowsSymlinks(file) {
  let current = path.resolve(file);
  while (true) {
    try { if (fs.lstatSync(current).isSymbolicLink()) throw unavailable(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}
function assertWindowsPrivateDestination(file) {
  const absolute = path.resolve(file); noWindowsSymlinks(absolute); missingEntry(absolute);
  if (!fs.statSync(path.dirname(absolute)).isDirectory()) throw unavailable();
  return absolute;
}
function readWindowsPrivateJson(file) {
  let fd;
  try {
    noWindowsSymlinks(file); fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw unavailable();
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } catch { throw unavailable(); }
  finally { if (fd !== undefined) closeAll([fd]); }
}
function writeWindowsPrivateJson(file, value) {
  let fd, absolute, created, bytes;
  try {
    bytes = serialized(value); absolute = assertWindowsPrivateDestination(file);
    fd = fs.openSync(absolute, 'wx', 0o600); created = fs.fstatSync(fd);
    const identity = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
    const sid = identity.match(/S-1-5-(?:\d+-)*\d+/)?.[0];
    if (!sid) throw unavailable();
    execFileSync('icacls.exe', [absolute, '/inheritance:r', '/grant:r', `*${sid}:(F)`, '*S-1-5-18:(F)'], { stdio: 'pipe', windowsHide: true });
    fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);
  } catch {
    // Windows may not permit unlinking an open handle.
    if (fd !== undefined) { closeAll([fd]); fd = undefined; }
    cleanupCreated(absolute, created); throw unsaved();
  } finally { bytes?.fill(0); if (fd !== undefined) closeAll([fd]); }
}
