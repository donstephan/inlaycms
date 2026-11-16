import type { Kysely } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('media')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('filename', 'text', (c) => c.notNull())
    .addColumn('mime', 'text', (c) => c.notNull())
    .addColumn('size', 'integer', (c) => c.notNull())
    .addColumn('width', 'integer')
    .addColumn('height', 'integer')
    .addColumn('default_alt', 'text')
    .addColumn('created_by_id', 'text')
    .addColumn('created_by_name', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute();
  await db.schema.createIndex('media_created_at').on('media').column('created_at').execute();

  await db.schema
    .createTable('media_deletions')
    .addColumn('id', 'integer', (c) => c.primaryKey().autoIncrement())
    .addColumn('media_id', 'text', (c) => c.notNull())
    .addColumn('filename', 'text', (c) => c.notNull())
    .addColumn('deleted_at', 'text', (c) => c.notNull())
    .addColumn('deleted_by_id', 'text')
    .addColumn('deleted_by_name', 'text', (c) => c.notNull())
    .execute();
  await db.schema.createIndex('media_deletions_media_id').on('media_deletions').column('media_id').execute();
}
