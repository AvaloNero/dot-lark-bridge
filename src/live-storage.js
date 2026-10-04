import fs from 'node:fs';
import path from 'node:path';
export function assertLiveStorage(config) {
  for (const directory of [path.dirname(config.dbPath), config.bridgeLockDirectory]) {
    if (!path.isAbsolute(directory)) throw new Error('Private live directory required');
    for (let current = directory; ; current = path.dirname(current)) {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Live storage symlink refused');
      if (path.dirname(current) === current) break;
    }
    const stat = fs.statSync(directory);
    if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o700) throw new Error('Owned 0700 live directory required');
  }
  for (const file of [config.dbPath, config.dbPath + '-wal', config.dbPath + '-shm', config.dbPath + '-journal']) {
    let stat; try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o600) throw new Error('Unsafe live database file');
  }
}
