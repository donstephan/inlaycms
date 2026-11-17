import { sql, type Kysely } from 'kysely';

/** The first time each document was published, filled from the publish history. */
export async function up(db: Kysely<any>): Promise<void> {
  await db.schema.alterTable('documents').addColumn('first_published_at', 'text').execute();
  await sql`
    UPDATE documents SET first_published_at = (
      SELECT min(e.at) FROM publish_events e, json_each(e.items) i
      WHERE json_extract(i.value, '$.documentId') = documents.id
        AND json_extract(i.value, '$.action') = 'publish'
    ) WHERE first_published_at IS NULL
  `.execute(db);
  await sql`
    UPDATE documents SET first_published_at = (SELECT created_at FROM revisions WHERE id = documents.published_rev)
    WHERE first_published_at IS NULL AND published_rev IS NOT NULL
  `.execute(db);
}
