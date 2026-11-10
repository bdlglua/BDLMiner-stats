import { DatabaseSync, backup } from 'node:sqlite';
import { chmodSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

process.umask(0o077);
const source = process.env.STATS_DATA || '/var/lib/bdlminer-stats';
const destination = process.env.STATS_BACKUPS || '/var/backups/bdlminer-stats/public';
mkdirSync(destination, { recursive: true, mode: 0o700 });
const now = new Date(), day = now.toISOString().slice(0, 10);
const temporary = join(destination, 'public-' + day + '.tmp');
const db = new DatabaseSync(join(source, 'public.sqlite'), { readOnly: true });
try {
  // SQLite's online backup API includes committed WAL pages. Copying the
  // database file with cp while the service runs would not be a valid backup.
  await backup(db, temporary);
  chmodSync(temporary, 0o600);
  renameSync(temporary, join(destination, 'public-' + day + '.sqlite'));
} finally { db.close(); rmSync(temporary, { force: true }); }
for (const name of readdirSync(destination)) {
  const match = /^public-(\d{4}-\d{2}-\d{2})\.sqlite$/.exec(name);
  if (match && new Date(match[1]).getTime() < now.getTime() - 7 * 86400000)
    rmSync(join(destination, name));
}
console.log('Public statistics backed up.');
