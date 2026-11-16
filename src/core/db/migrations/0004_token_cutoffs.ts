import type { Kysely } from 'kysely';

/** When a user's OAuth access tokens stopped counting: tokens issued at or before `before` are refused. */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('token_cutoffs')
    .addColumn('user_id', 'text', (c) => c.primaryKey())
    .addColumn('before', 'integer', (c) => c.notNull())
    .execute();
}
