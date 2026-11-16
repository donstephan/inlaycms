import { sql, type Kysely, type SqlBool } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('documents')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('kind', 'text', (c) =>
      c.notNull().check(sql`kind in ('singleton', 'entry', 'global')`),
    )
    .addColumn('type', 'text', (c) => c.notNull())
    .addColumn('group_id', 'text', (c) => c.notNull())
    .addColumn('locale', 'text', (c) => c.notNull())
    .addColumn('head_rev', 'integer')
    .addColumn('published_rev', 'integer')
    .addColumn('head_slug', 'text')
    .addColumn('published_slug', 'text')
    .addColumn('head_path', 'text')
    .addColumn('published_path', 'text')
    .addColumn('deleted_at', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('key', 'text')
    .addColumn('edition', 'integer')
    .addUniqueConstraint('documents_group_locale_unique', ['group_id', 'locale'])
    .execute();

  await db.schema
    .createIndex('documents_single_per_locale')
    .unique()
    .on('documents')
    .columns(['type', 'locale'])
    .where(sql<SqlBool>`kind in ('singleton', 'global')`)
    .execute();

  await db.schema
    .createIndex('documents_key_locale')
    .unique()
    .on('documents')
    .columns(['type', 'key', 'locale'])
    .where(sql<SqlBool>`key is not null`)
    .execute();

  await db.schema.createIndex('documents_type_locale').on('documents').columns(['type', 'locale']).execute();

  await db.schema
    .createTable('revisions')
    .addColumn('id', 'integer', (c) => c.primaryKey().autoIncrement())
    .addColumn('document_id', 'text', (c) => c.notNull().references('documents.id'))
    .addColumn('data', 'text', (c) => c.notNull())
    .addColumn('author_id', 'text')
    .addColumn('author_name', 'text', (c) => c.notNull())
    .addColumn('source', 'text', (c) => c.notNull())
    .addColumn('message', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('release_id', 'text')
    .execute();

  await db.schema.createIndex('revisions_document').on('revisions').columns(['document_id', 'id']).execute();

  await db.schema
    .createTable('publish_events')
    .addColumn('id', 'integer', (c) => c.primaryKey().autoIncrement())
    .addColumn('at', 'text', (c) => c.notNull())
    .addColumn('user_id', 'text')
    .addColumn('user_name', 'text', (c) => c.notNull())
    .addColumn('source', 'text', (c) => c.notNull())
    .addColumn('message', 'text')
    .addColumn('items', 'text', (c) => c.notNull())
    .execute();

  await db.schema
    .createTable('refs')
    .addColumn('from_document_id', 'text', (c) => c.notNull().references('documents.id'))
    .addColumn('from_revision_id', 'integer', (c) => c.notNull().references('revisions.id'))
    .addColumn('to_kind', 'text', (c) => c.notNull().check(sql`to_kind in ('document', 'media')`))
    .addColumn('to_id', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('refs_pk', ['from_document_id', 'from_revision_id', 'to_kind', 'to_id'])
    .execute();

  await db.schema.createIndex('refs_to').on('refs').columns(['to_kind', 'to_id']).execute();
}
