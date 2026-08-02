import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
  real,
  primaryKey,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Entity types in the memory graph
 */
export const entityTypes = [
  'person',
  'organization',
  'project',
  'concept',
  'place',
  'event',
  'document',
  'prediction_market',
  'thesis',
] as const;

export type EntityType = (typeof entityTypes)[number];

/**
 * Entities: People, places, things, concepts
 * Dual-stored: SQL table for queries + AGE graph for traversals
 */
export const entities = pgTable(
  'entities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: varchar('type', { length: 50 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    attributes: jsonb('attributes').default({}),
    confidence: real('confidence').default(1.0),
    provenance: varchar('provenance', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    // NOTE: drizzle-kit 0.21 can't express expression indexes or generated
    // columns, so two more live only in hand-authored migration SQL (the
    // 0001_add_search_vector precedent): the search_vector tsvector column +
    // entities_search_idx (0001) and entities_type_lower_name_idx on
    // (type, lower(btrim(name))) (0004, non-unique until Phase-3 dedup).
    typeIdx: index('entities_type_idx').on(table.type),
  })
);

/**
 * Episodes: Events, decisions, observations
 */
export const episodes = pgTable(
  'episodes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: varchar('type', { length: 50 }).notNull(),
    summary: text('summary').notNull(),
    details: jsonb('details').default({}),
    importance: real('importance').default(0.5),
    provenance: varchar('provenance', { length: 255 }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => ({
    // The occurred_at indexes are created DESC in the migration SQL (window
    // scans are newest-first); drizzle-kit 0.21 snapshots ignore column order
    // so the schema/migration diff stays clean. Also hand-authored in 0004:
    // episodes_details_gin_idx (GIN on details) and the search_vector
    // generated column + episodes_search_idx (dormant until Phase-4 retrieval).
    occurredAtIdx: index('episodes_occurred_at_idx').on(table.occurredAt),
    typeOccurredAtIdx: index('episodes_type_occurred_at_idx').on(table.type, table.occurredAt),
    provenanceIdx: index('episodes_provenance_idx').on(table.provenance),
  })
);

/**
 * Episode-Entity links
 */
export const episodeEntities = pgTable(
  'episode_entities',
  {
    episodeId: uuid('episode_id')
      .notNull()
      .references(() => episodes.id, { onDelete: 'cascade' }),
    entityId: uuid('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    role: varchar('role', { length: 100 }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.episodeId, table.entityId] }),
  })
);

/**
 * Evidence: Supporting sources
 */
export const evidence = pgTable('evidence', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: varchar('type', { length: 50 }).notNull(),
  reference: varchar('reference', { length: 512 }).notNull(),
  snippet: text('snippet'),
  capturedAt: timestamp('captured_at', { withTimezone: true }).defaultNow(),
  // Note: taint array stored as JSONB since drizzle doesn't have great array support
  taint: jsonb('taint').default([]),
});

/**
 * Evidence links to entities/episodes
 */
export const evidenceLinks = pgTable('evidence_links', {
  evidenceId: uuid('evidence_id')
    .notNull()
    .references(() => evidence.id, { onDelete: 'cascade' }),
  entityId: uuid('entity_id').references(() => entities.id, { onDelete: 'cascade' }),
  episodeId: uuid('episode_id').references(() => episodes.id, { onDelete: 'cascade' }),
  relevance: real('relevance').default(1.0),
});

export type Entity = typeof entities.$inferSelect;
export type NewEntity = typeof entities.$inferInsert;
export type Episode = typeof episodes.$inferSelect;
export type NewEpisode = typeof episodes.$inferInsert;
export type Evidence = typeof evidence.$inferSelect;
export type NewEvidence = typeof evidence.$inferInsert;
