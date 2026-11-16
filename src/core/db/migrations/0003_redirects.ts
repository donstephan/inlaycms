import { sql, type Kysely } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('redirects')
    .addColumn('id', 'integer', (c) => c.primaryKey().autoIncrement())
    .addColumn('from_path', 'text', (c) => c.notNull().unique())
    .addColumn('to_path', 'text')
    .addColumn('to_group_id', 'text')
    .addColumn('status', 'integer', (c) => c.notNull().check(sql`status in (301, 302)`))
    .addColumn('source', 'text', (c) => c.notNull().check(sql`source in ('manual', 'auto', 'import')`))
    .addColumn('note', 'text')
    .addColumn('created_by_id', 'text')
    .addColumn('created_by_name', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addCheckConstraint('redirects_one_target', sql`(to_path is null) <> (to_group_id is null)`)
    .execute();
  await db.schema.createIndex('redirects_to_path').on('redirects').column('to_path').execute();
  await db.schema.createIndex('redirects_to_group_id').on('redirects').column('to_group_id').execute();
}
