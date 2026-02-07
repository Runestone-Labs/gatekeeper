import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
  real,
  primaryKey,
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
] as const;

export type EntityType = (typeof entityTypes)[number];

/**
 * Entities: People, places, things, concepts
 * Dual-stored: SQL table for queries + AGE graph for traversals
 */
export const entities = pgTable('entities', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: varchar('type', { length: 50 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  attributes: jsonb('attributes').default({}),
  confidence: real('confidence').default(1.0),
  provenance: varchar('provenance', { length: 255 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

/**
 * Episodes: Events, decisions, observations
 */
export const episodes = pgTable('episodes', {
  id: uuid('id').primaryKey().defaultRandom(),
  type: varchar('type', { length: 50 }).notNull(),
  summary: text('summary').notNull(),
  details: jsonb('details').default({}),
  importance: real('importance').default(0.5),
  provenance: varchar('provenance', { length: 255 }),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

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
