import test from 'node:test';
import assert from 'node:assert/strict';
import { readBridgeMode, bridgeModePlan, createSelectedRuntime } from '../src/bridge-mode.js';

test('production bridge mode is explicit, exclusive and has no permissive aliases or defaults', () => {
  assert.equal(readBridgeMode({}), null); assert.throws(() => readBridgeMode({}, { required: true }));
  for (const BRIDGE_MODE of ['tunnel', 'sites']) assert.equal(readBridgeMode({ BRIDGE_MODE }, { required: true }), BRIDGE_MODE);
  for (const BRIDGE_MODE of ['auto', 'both', 'TUNNEL', 'sites,tunnel', ' tunnel ']) assert.throws(() => readBridgeMode({ BRIDGE_MODE }));
  assert.equal(bridgeModePlan('tunnel').sites_queue_worker, false); assert.equal(bridgeModePlan('sites').local_mcp_server, false);
});

test('single factory selection never starts two modes or falls back when selected mode fails', () => {
  const calls = [];
  const factories = { tunnel() { calls.push('tunnel'); return {}; }, sites() { calls.push('sites'); throw new Error('sites not configured'); } };
  createSelectedRuntime('tunnel', factories); assert.deepEqual(calls, ['tunnel']);
  assert.throws(() => createSelectedRuntime('sites', factories)); assert.deepEqual(calls, ['tunnel', 'sites']);
  assert.throws(() => createSelectedRuntime('sites', { tunnel: factories.tunnel })); assert.deepEqual(calls, ['tunnel', 'sites']);
});


test('new locks record process identity without reclaiming an existing lock', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { acquireModeLock } = await import('../src/bridge-mode.js');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-lock-'));
  try {
    const release = acquireModeLock(directory, 'lark', 'fixture', 'tunnel');
    const file = path.join(directory, fs.readdirSync(directory)[0]);
    const original = fs.readFileSync(file, 'utf8');
    const lock = JSON.parse(original);
    assert.equal(lock.pid, process.pid);
    if (process.platform === 'linux') {
      assert.match(lock.pid_namespace, /^pid:\[\d+\]$/);
      assert.match(lock.process_start_ticks, /^\d+$/);
      assert.match(lock.boot_id, /^[a-f0-9-]{36}$/);
    }
    assert.throws(() => acquireModeLock(directory, 'lark', 'fixture', 'sites'));
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    release(); assert.deepEqual(fs.readdirSync(directory), []);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
