import { sql, type Kysely, type SqlBool } from 'kysely';

/** Releases the host has received, and the migration functions each one has run. */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('releases')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('state', 'text', (c) => c.notNull().check(sql`state in ('staged', 'current', 'previous', 'deleted')`))
    .addColumn('file', 'text', (c) => c.notNull())
    .addColumn('checksum', 'text', (c) => c.notNull())
    .addColumn('signed_by', 'text', (c) => c.notNull())
    .addColumn('inlay_range', 'text', (c) => c.notNull())
    .addColumn('secrets', 'text', (c) => c.notNull())
    .addColumn('schema', 'text', (c) => c.notNull())
    .addColumn('pushed_by', 'text')
    .addColumn('pushed_at', 'text', (c) => c.notNull())
    .addColumn('activated_at', 'text')
    .addColumn('deactivated_at', 'text')
    .execute();
  await db.schema
    .createIndex('releases_one_current')
    .on('releases')
    .column('state')
    .unique()
    .where(sql<SqlBool>`state = 'current'`)
    .execute();
  await db.schema
    .createTable('release_migrations')
    .addColumn('release_id', 'text', (c) => c.notNull().references('releases.id'))
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('ran_at', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('release_migrations_pk', ['release_id', 'name'])
    .execute();
}
