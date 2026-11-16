import type { Kysely } from 'kysely';
import { sql } from 'kysely';

/** The site password: a single row holding whether the lock is on and the scrypt hash of the password. */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('site_lock')
    .addColumn('id', 'integer', (c) => c.primaryKey().check(sql`id = 1`))
    .addColumn('enabled', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('password_hash', 'text')
    .execute();
}
