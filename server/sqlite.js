import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';

// The same interface as Durable Object SQLite, backed by a local database.
export function database(filename) {
  const db = new DatabaseSync(filename);
  if (filename !== ':memory:') chmodSync(filename, 0o600);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000');
  return {
    db,
    exec(query, ...bindings) {
      const statement = db.prepare(query);
      const rows = /^\s*(SELECT|PRAGMA|WITH)\b/i.test(query)
        ? statement.all(...bindings) : (statement.run(...bindings), []);
      return { toArray: () => rows.map(row => ({ ...row })) };
    },
    transaction(fn) {
      db.exec('BEGIN IMMEDIATE');
      try { const result = fn(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    close() { db.close(); },
  };
}
