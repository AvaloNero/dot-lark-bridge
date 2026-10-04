import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertPrivateDestination, readPrivateJson, writePrivateJson } from '../src/private-files.js';

const linux = { skip: process.platform !== 'linux' };
const fixture = { kind: 'public-synthetic-fixture', value: 'not-a-real-credential' };
function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dot-lark-private-test-')); fs.chmodSync(directory, 0o700);
  t.after(() => {
    t.mock.restoreAll();
    // Remove only this test's known tree. Never follow a fixture symlink.
    function remove(entry) {
      const stat = fs.lstatSync(entry);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fs.unlinkSync(entry);
      else { for (const name of fs.readdirSync(entry)) remove(path.join(entry, name)); fs.rmdirSync(entry); }
    }
    assert.ok(path.basename(directory).startsWith('dot-lark-private-test-')); remove(directory);
  });
  return { directory, file: name => path.join(directory, name) };
}

test('private JSON uses strict modes, exact data and exclusive no-overwrite creation', linux, t => {
  const { file } = temporary(t), target = file('fixture.json');
  assert.equal(assertPrivateDestination(target), target); writePrivateJson(target, fixture);
  assert.deepEqual(readPrivateJson(target), fixture); assert.equal(fs.statSync(target).mode & 0o7777, 0o600);
  assert.throws(() => assertPrivateDestination(target)); assert.throws(() => writePrivateJson(target, { replaced: true }));
  assert.deepEqual(readPrivateJson(target), fixture);
});

test('symlinked files, dangling entries and intermediate directory symlinks are rejected', linux, t => {
  const { file } = temporary(t); writePrivateJson(file('real.json'), fixture);
  fs.symlinkSync(file('real.json'), file('link.json')); fs.symlinkSync(file('missing.json'), file('dangling.json'));
  fs.mkdirSync(file('real-dir'), { mode: 0o700 }); fs.symlinkSync(file('real-dir'), file('linked-dir'));
  for (const target of [file('link.json'), file('dangling.json'), file('linked-dir/nested.json')]) {
    assert.throws(() => readPrivateJson(target)); assert.throws(() => writePrivateJson(target, fixture));
    assert.throws(() => assertPrivateDestination(target));
  }
  assert.equal(fs.existsSync(file('missing.json')), false); assert.equal(fs.existsSync(file('real-dir/nested.json')), false);
  assert.deepEqual(readPrivateJson(file('real.json')), fixture);
});

test('reads require regular singly linked owner-only 0600 files and owner-only 0700 parents', linux, t => {
  const { directory, file } = temporary(t), target = file('fixture.json'); writePrivateJson(target, fixture);
  for (const mode of [0o400, 0o640, 0o644, 0o1600]) { fs.chmodSync(target, mode); assert.throws(() => readPrivateJson(target)); }
  fs.chmodSync(target, 0o600); fs.linkSync(target, file('hardlink.json')); assert.throws(() => readPrivateJson(target));
  fs.unlinkSync(file('hardlink.json')); fs.mkdirSync(file('not-file'), { mode: 0o600 }); assert.throws(() => readPrivateJson(file('not-file')));
  for (const mode of [0o500, 0o750, 0o755, 0o1700]) {
    fs.chmodSync(directory, mode);
    assert.throws(() => readPrivateJson(target)); assert.throws(() => writePrivateJson(file('new.json'), fixture));
    assert.throws(() => assertPrivateDestination(file('new.json')));
  }
  fs.chmodSync(directory, 0o700); assert.deepEqual(readPrivateJson(target), fixture);
});

test('descriptor metadata ownership checks reject a foreign file or parent before reading contents', linux, t => {
  const { file } = temporary(t), target = file('fixture.json'); writePrivateJson(target, fixture);
  const originalStat = fs.fstatSync;
  for (const kind of ['file', 'directory']) {
    const mocked = t.mock.method(fs, 'fstatSync', function(fd, ...args) {
      const stat = originalStat.call(this, fd, ...args);
      if ((kind === 'file' && stat.isFile()) || (kind === 'directory' && stat.isDirectory())) stat.uid = process.getuid() + 1;
      return stat;
    });
    assert.throws(() => readPrivateJson(target)); assert.throws(() => writePrivateJson(file('new.json'), fixture));
    mocked.mock.restore(); assert.equal(fs.existsSync(file('new.json')), false);
  }
});

test('invalid or oversized JSON fails with redacted errors and oversized writes leave no file', linux, t => {
  const { file } = temporary(t), target = file('fixture.json');
  for (const text of ['not json: synthetic-private-content', ' '.repeat(16385)]) {
    fs.writeFileSync(target, text, { mode: 0o600 });
    assert.throws(() => readPrivateJson(target), error => error.message === 'Private file is unavailable or unsafe');
  }
  assert.throws(() => writePrivateJson(file('oversized.json'), { text: 'x'.repeat(16385) }));
  assert.equal(fs.existsSync(file('oversized.json')), false);
  assert.throws(() => writePrivateJson(file('undefined.json'), undefined)); assert.equal(fs.existsSync(file('undefined.json')), false);
});

test('reading an already opened file never follows a pathname replacement', linux, t => {
  const { file } = temporary(t), target = file('fixture.json'); writePrivateJson(target, fixture);
  const originalOpen = fs.openSync;
  t.mock.method(fs, 'openSync', function(entry, flags, ...args) {
    const fd = originalOpen.call(this, entry, flags, ...args);
    if (String(entry).startsWith('/proc/self/fd/') && String(entry).endsWith('/fixture.json')) {
      fs.renameSync(target, file('original.json'));
      fs.writeFileSync(target, JSON.stringify({ replacement: true }), { mode: 0o600 });
    }
    return fd;
  });
  assert.deepEqual(readPrivateJson(target), fixture);
});

test('writes and failure cleanup stay anchored to an opened parent after its path is replaced', linux, t => {
  const { file } = temporary(t); fs.mkdirSync(file('parent'), { mode: 0o700 }); fs.mkdirSync(file('other'), { mode: 0o700 });
  const originalOpen = fs.openSync;
  t.mock.method(fs, 'openSync', function(entry, flags, ...args) {
    if (String(entry).endsWith('/fixture.json')) {
      assert.equal(String(entry).startsWith('/proc/self/fd/'), true);
      fs.renameSync(file('parent'), file('moved')); fs.symlinkSync(file('other'), file('parent'));
    }
    return originalOpen.call(this, entry, flags, ...args);
  });
  t.mock.method(fs, 'fsyncSync', () => { throw new Error('fixture failure'); });
  assert.throws(() => writePrivateJson(file('parent/fixture.json'), fixture));
  assert.equal(fs.existsSync(file('moved/fixture.json')), false); assert.equal(fs.existsSync(file('other/fixture.json')), false);
});

test('a successful write cannot be redirected by replacing its checked parent pathname', linux, t => {
  const { file } = temporary(t); fs.mkdirSync(file('parent'), { mode: 0o700 }); fs.mkdirSync(file('other'), { mode: 0o700 });
  const originalOpen = fs.openSync; let replaced = false;
  t.mock.method(fs, 'openSync', function(entry, flags, ...args) {
    if (!replaced && String(entry).endsWith('/fixture.json')) {
      replaced = true; fs.renameSync(file('parent'), file('moved')); fs.symlinkSync(file('other'), file('parent'));
    }
    return originalOpen.call(this, entry, flags, ...args);
  });
  writePrivateJson(file('parent/fixture.json'), fixture);
  assert.equal(replaced, true); assert.equal(fs.existsSync(file('other/fixture.json')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file('moved/fixture.json'), 'utf8')), fixture);
});

test('failed write removes only its own created inode and preserves a replacement destination', linux, t => {
  const { file } = temporary(t), target = file('fixture.json');
  t.mock.method(fs, 'fsyncSync', () => {
    fs.renameSync(target, file('created.json')); fs.writeFileSync(target, 'replacement fixture', { mode: 0o600 });
    throw new Error('synthetic failure containing sensitive-looking data');
  });
  assert.throws(() => writePrivateJson(target, fixture), error => error.message === 'Private file could not be saved; no credentials were printed');
  assert.equal(fs.readFileSync(target, 'utf8'), 'replacement fixture');
});

test('all opened descriptors close on successful and failed reads and writes', linux, t => {
  const { file } = temporary(t), target = file('fixture.json'), opened = new Set();
  const originalOpen = fs.openSync, originalClose = fs.closeSync;
  t.mock.method(fs, 'openSync', function(...args) { const fd = originalOpen.apply(this, args); opened.add(fd); return fd; });
  t.mock.method(fs, 'closeSync', function(fd) { const result = originalClose.call(this, fd); opened.delete(fd); return result; });
  writePrivateJson(target, fixture); assert.equal(opened.size, 0);
  readPrivateJson(target); assert.equal(opened.size, 0);
  assert.throws(() => writePrivateJson(target, fixture)); assert.equal(opened.size, 0);
  fs.chmodSync(target, 0o644); assert.throws(() => readPrivateJson(target)); assert.equal(opened.size, 0);
});
