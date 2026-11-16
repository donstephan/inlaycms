import BetterSqlite3 from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import type { Database } from './schema.js';

export function openDatabase(path: string, opts: { readonly?: boolean; busyTimeoutMs?: number } = {}): Kysely<Database> {
  const sqlite = opts.readonly
    ? new BetterSqlite3(path, { readonly: true, fileMustExist: true })
    : new BetterSqlite3(path);
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma(`busy_timeout = ${opts.busyTimeoutMs ?? 5000}`);
  if (path !== ':memory:' && !opts.readonly) sqlite.pragma('journal_mode = WAL');
  return new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
}
