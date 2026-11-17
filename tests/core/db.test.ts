import { sql, type Kysely } from 'kysely';
import { Migrator } from 'kysely/migration';
import * as m0001 from '../../src/core/db/migrations/0001_content.js';
import * as m0002 from '../../src/core/db/migrations/0002_media.js';
import * as m0003 from '../../src/core/db/migrations/0003_redirects.js';
import * as m0004 from '../../src/core/db/migrations/0004_token_cutoffs.js';
import * as m0005 from '../../src/core/db/migrations/0005_site_lock.js';
import * as m0006 from '../../src/core/db/migrations/0006_releases.js';
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
    expect(await pendingSystemMigrations(db)).toEqual(['0002_media', '0003_redirects', '0004_token_cutoffs', '0005_site_lock', '0006_releases', '0007_published_at']);
    await migrateSystem(db);
    expect(await pendingSystemMigrations(db)).toEqual([]);
  });

  it('adds first_published_at and fills it from the publish history', async () => {
    const upTo0006 = {
      '0001_content': m0001,
      '0002_media': m0002,
      '0003_redirects': m0003,
      '0004_token_cutoffs': m0004,
      '0005_site_lock': m0005,
      '0006_releases': m0006,
    };
    await new Migrator({ db, provider: { getMigrations: async () => upTo0006 } }).migrateToLatest();
    const t1 = '2026-01-01T00:00:00.000Z';
    const t2 = '2026-01-02T00:00:00.000Z';
    const t3 = '2026-01-03T00:00:00.000Z';
    const t4 = '2026-01-04T00:00:00.000Z';
    for (const [id, published] of [['a', 1], ['b', 2], ['c', null]] as const) {
      await sql`INSERT INTO documents (id, kind, type, group_id, locale, head_rev, published_rev, head_slug, published_slug, head_path, published_path, deleted_at, created_at)
        VALUES (${id}, 'entry', 'posts', ${id}, 'en', NULL, NULL, NULL, NULL, NULL, NULL, NULL, ${t1})`.execute(db);
      const rev = await sql<{ id: number }>`INSERT INTO revisions (document_id, data, author_name, source, created_at)
        VALUES (${id}, '{}', 'T', 'admin', ${id === 'b' ? t4 : t1}) RETURNING id`.execute(db);
      if (published !== null) await sql`UPDATE documents SET head_rev = ${rev.rows[0]!.id}, published_rev = ${rev.rows[0]!.id} WHERE id = ${id}`.execute(db);
    }
    const event = (at: string, action: string) =>
      sql`INSERT INTO publish_events (at, user_name, source, items) VALUES (${at}, 'T', 'admin', ${JSON.stringify([{ documentId: 'a', revisionId: null, action }])})`.execute(db);
    await event(t1, 'publish');
    await event(t2, 'unpublish');
    await event(t3, 'publish');
    await migrateSystem(db);
    const rows = await db.selectFrom('documents').select(['id', 'first_published_at']).orderBy('id').execute();
    expect(rows).toEqual([
      { id: 'a', first_published_at: t1 },
      { id: 'b', first_published_at: t4 },
      { id: 'c', first_published_at: null },
    ]);
  });
});
