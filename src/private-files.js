import fs from 'node:fs';
import path from 'node:path';
import { windowsReadPrivateFile, windowsWritePrivateFile, windowsPrivateDestination } from '../../dot-qq-bridge/packages/dot-bridge-platform/index.js';

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
  if (process.platform === 'win32') {
    let bytes;
    try { bytes = windowsReadPrivateFile(file, { maxBytes: MAX_BYTES }); return JSON.parse(bytes.toString('utf8')); }
    catch { throw unavailable(); }
    finally { bytes?.fill(0); }
  }
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
  if (process.platform === 'win32') {
    let bytes;
    try { bytes = serialized(value); windowsWritePrivateFile(file, bytes); }
    catch { throw unsaved(); }
    finally { bytes?.fill(0); }
    return;
  }
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
  if (process.platform === 'win32') {
    try { return windowsPrivateDestination(file); }
    catch { throw new Error('Choose a new destination in an existing owned private directory; no overwrite allowed'); }
  }
  const opened = [];
  try {
    const { absolute, entry } = openParent(file, opened); missingEntry(entry); return absolute;
  } catch { throw new Error('Choose a new destination in an existing owned private directory; no overwrite allowed'); }
  finally { closeAll(opened); }
}
