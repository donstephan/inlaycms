import type { Kysely } from 'kysely';

/** Integration settings: one row per integration the owner has saved, with its values as a JSON object. */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('integrations')
    .addColumn('name', 'text', (c) => c.primaryKey())
    .addColumn('enabled', 'integer', (c) => c.notNull())
    .addColumn('data', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .addColumn('updated_by', 'text')
    .execute();
}
