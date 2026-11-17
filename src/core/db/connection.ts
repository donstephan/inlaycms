import BetterSqlite3 from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import type { Database } from './schema.js';

const handles = new WeakMap<Kysely<Database>, BetterSqlite3.Database>();

export function openDatabase(path: string, opts: { readonly?: boolean; busyTimeoutMs?: number } = {}): Kysely<Database> {
  const sqlite = opts.readonly
    ? new BetterSqlite3(path, { readonly: true, fileMustExist: true })
    : new BetterSqlite3(path);
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma(`busy_timeout = ${opts.busyTimeoutMs ?? 5000}`);
  if (path !== ':memory:' && !opts.readonly) sqlite.pragma('journal_mode = WAL');
  const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
  handles.set(db, sqlite);
  return db;
}

/**
 * SQLite's `data_version` for a connection `openDatabase` made: it changes when another connection (another process,
 * say) commits to the database, and not for the connection's own writes. Read straight from the connection, so it
 * never waits behind a transaction Kysely has open on it. Null for a connection made elsewhere.
 */
export function dataVersion(db: Kysely<Database>): number | null {
  const sqlite = handles.get(db);
  return sqlite === undefined ? null : (sqlite.pragma('data_version', { simple: true }) as number);
}
