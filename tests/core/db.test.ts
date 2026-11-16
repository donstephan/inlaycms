import { sql, type Kysely } from 'kysely';
import { Migrator } from 'kysely/migration';
import * as m0001 from '../../src/core/db/migrations/0001_content.js';
import { afterEach, beforeEach } from 'vitest';
import { openDatabase } from '../../src/core/db/connection.js';
import { migrateSystem, pendingSystemMigrations } from '../../src/core/db/migrate.js';
import type { Database } from '../../src/core/db/schema.js';

describe('database', () => {
  let db: Kysely<Database>;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('creates all four tables', async () => {
    await migrateSystem(db);
    const rows = await db
      .selectFrom('sqlite_master' as never)
      .select('name' as never)
      .where('type' as never, '=', 'table' as never)
      .execute();
    const names = rows.map((r) => (r as { name: string }).name);
    expect(names).toEqual(expect.arrayContaining(['documents', 'revisions', 'publish_events', 'refs']));
  });

  it('is a no-op the second time', async () => {
    await migrateSystem(db);
    await expect(migrateSystem(db)).resolves.toBeUndefined();
  });

  it('enables foreign keys', async () => {
    const { rows } = await sql<{ foreign_keys: number }>`PRAGMA foreign_keys`.execute(db);
    expect(rows[0]?.foreign_keys).toBe(1);
  });

  it('rejects a revision for a missing document', async () => {
    await migrateSystem(db);
    await expect(
      db
        .insertInto('revisions')
        .values({
          document_id: 'missing',
          data: '{}',
          author_id: null,
          author_name: 'Test',
          source: 'admin',
          message: null,
          created_at: '2026-01-01T00:00:00Z',
        })
        .execute(),
    ).rejects.toThrow();
  });

  it('creates exactly the system tables, with no schema versions', async () => {
    await migrateSystem(db);
    const tables = await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'kysely_%'`.execute(db);
    expect(tables.rows.map((t) => t.name).sort()).toEqual(
      ['documents', 'media', 'media_deletions', 'publish_events', 'redirects', 'refs', 'release_migrations', 'releases', 'revisions', 'site_lock', 'token_cutoffs'],
    );
    const columns = await sql<{ name: string }>`SELECT name FROM pragma_table_info('revisions')`.execute(db);
    expect(columns.rows.map((c) => c.name)).not.toContain('versions');
  });

  it('creates media and media_deletions', async () => {
    await migrateSystem(db);
    const rows = await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('media', 'media_deletions')`.execute(db);
    expect(rows.rows).toHaveLength(2);
  });

  it('creates redirects with one target and a valid status', async () => {
    await migrateSystem(db);
    const row = { from_path: '/a', status: 301, source: 'manual', note: null, created_by_id: null, created_by_name: 'Test', created_at: '2026-01-01T00:00:00Z' } as const;
    const insert = (values: Record<string, unknown>) =>
      db.insertInto('redirects').values({ ...row, ...values } as never).execute();
    await insert({ to_path: '/b', to_group_id: null });
    await expect(insert({ from_path: '/c', to_path: '/b', to_group_id: 'g' })).rejects.toThrow();
    await expect(insert({ from_path: '/c', to_path: null, to_group_id: null })).rejects.toThrow();
    await expect(insert({ from_path: '/c', to_path: '/b', to_group_id: null, status: 303 })).rejects.toThrow();
    await expect(insert({ to_path: '/b', to_group_id: null })).rejects.toThrow();
  });

  it('reports pending system migrations', async () => {
    await new Migrator({ db, provider: { getMigrations: async () => ({ '0001_content': m0001 }) } }).migrateToLatest();
    expect(await pendingSystemMigrations(db)).toEqual(['0002_media', '0003_redirects', '0004_token_cutoffs', '0005_site_lock', '0006_releases']);
    await migrateSystem(db);
    expect(await pendingSystemMigrations(db)).toEqual([]);
  });
});
