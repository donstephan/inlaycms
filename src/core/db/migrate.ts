import type { Kysely } from 'kysely';
import { Migrator } from 'kysely/migration';
import type { Database } from './schema.js';
import * as m0001 from './migrations/0001_content.js';
import * as m0002 from './migrations/0002_media.js';
import * as m0003 from './migrations/0003_redirects.js';
import * as m0004 from './migrations/0004_token_cutoffs.js';
import * as m0005 from './migrations/0005_site_lock.js';
import * as m0006 from './migrations/0006_releases.js';
import * as m0007 from './migrations/0007_published_at.js';
import * as m0008 from './migrations/0008_integrations.js';

const systemMigrations = {
  '0001_content': m0001,
  '0002_media': m0002,
  '0003_redirects': m0003,
  '0004_token_cutoffs': m0004,
  '0005_site_lock': m0005,
  '0006_releases': m0006,
  '0007_published_at': m0007,
  '0008_integrations': m0008,
};

function systemMigrator(db: Kysely<Database>): Migrator {
  return new Migrator({
    db,
    provider: { getMigrations: async () => systemMigrations },
  });
}

export async function migrateSystem(db: Kysely<Database>): Promise<void> {
  const { error } = await systemMigrator(db).migrateToLatest();
  if (error) throw error instanceof Error ? error : new Error(String(error));
}

export async function pendingSystemMigrations(db: Kysely<Database>): Promise<string[]> {
  const migrations = await systemMigrator(db).getMigrations();
  return migrations.filter((m) => m.executedAt === undefined).map((m) => m.name);
}

/**
 * Migration names recorded in the database that this code doesn't know, or `null` when it isn't an Inlay
 * database (it has no migration or documents table).
 */
export async function unknownSystemMigrations(db: Kysely<any>): Promise<string[] | null> {
  const tables = new Set((await db.introspection.getTables({ withInternalKyselyTables: true })).map((t) => t.name));
  if (!tables.has('kysely_migration') || !tables.has('documents')) return null;
  const known = Object.keys(systemMigrations);
  const rows: Array<{ name: string }> = await db.selectFrom('kysely_migration').select('name').execute();
  return rows.map((r) => r.name).filter((name) => !known.includes(name));
}
