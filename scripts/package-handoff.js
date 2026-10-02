import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// Export committed public sources only. Never inspect/copy local credentials,
// environment files, databases, npm cache, .git history or node_modules.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
try {
  if (process.argv.length > 2) throw new Error('No path or revision overrides allowed');
  if (git('status', '--porcelain')) throw new Error('Commit reviewed changes first; working tree must be clean');
  const revision = git('rev-parse', 'HEAD');
  const allowlist = ['src', 'scripts', 'test', 'docs', 'plugin', 'deploy', '.env.example', '.gitignore', '.dockerignore',
    'README.md', 'THIRD_PARTY_NOTICES.md', 'LICENSE', 'package.json', 'package-lock.json', 'Dockerfile'];
  const entries = git('ls-tree', '-r', '--name-only', 'HEAD', '--', ...allowlist).split('\n');
  if (entries.some(entry => /(^|\/)(?:\.env|\.secrets|data|node_modules|handoff)(?:\/|$)/.test(entry))) throw new Error('Non-source entry found');
  const directory = path.join(root, 'handoff');
  if (fs.existsSync(directory) && (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink())) throw new Error('Unsafe handoff destination');
  fs.mkdirSync(directory, { recursive: true });
  const name = `dot-lark-bridge-${revision.slice(0, 12)}`, zip = path.join(directory, `${name}.zip`), manifest = path.join(directory, `${name}.json`);
  if (fs.existsSync(zip) || fs.existsSync(manifest)) throw new Error('Handoff already exists; no overwrite');
  git('archive', '--format=zip', `--output=${zip}`, 'HEAD', '--', ...allowlist);
  const sha256 = createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
  const result = { revision, filename: `${name}.zip`, sha256, bytes: fs.statSync(zip).size, source_files: entries.length,
    node: '>=24.15 <25', sqlite: 'node:sqlite; one process and durable local disk', mcp_protocol: '2026-07-28',
    contains_credentials: false, real_lark_connected: false, current_dot_connected: false, deployed: false };
  fs.writeFileSync(manifest, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch {
  process.stderr.write('Source handoff refused. Commit reviewed sources first and use a new safe handoff destination.\n');
  process.exitCode = 1;
}
