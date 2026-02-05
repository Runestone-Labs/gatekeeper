import { z } from 'zod';
import { entityTypes } from '../../db/schema.js';

/**
 * memory.query - Query entities and relationships
 */
export const MemoryQueryArgsSchema = z.object({
  // Cypher query for graph traversal
  cypher: z.string().optional(),

  // Simple entity lookup
  entityId: z.string().uuid().optional(),
  entityType: z.enum(entityTypes).optional(),
  entityName: z.string().optional(),

  // Search entities by attributes
  attributeQuery: z.record(z.unknown()).optional(),

  // Neighborhood query (graph traversal from entity)
  fromEntity: z.string().uuid().optional(),
  maxHops: z.number().int().min(1).max(5).optional(),
  relationTypes: z.array(z.string()).optional(),

  // Episode queries
  episodeType: z.string().optional(),
  minImportance: z.number().min(0).max(1).optional(),
  since: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export type MemoryQueryArgs = z.infer<typeof MemoryQueryArgsSchema>;

/**
 * memory.upsert - Create or update an entity
 */
export const MemoryUpsertArgsSchema = z.object({
  // If provided, update existing entity
  id: z.string().uuid().optional(),

  type: z.enum(entityTypes),
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  attributes: z.record(z.unknown()).optional(),
  confidence: z.number().min(0).max(1).optional(),
  provenance: z.string().max(255).optional(),
});

export type MemoryUpsertArgs = z.infer<typeof MemoryUpsertArgsSchema>;

/**
 * memory.link - Create a relationship between entities
 */
export const MemoryLinkArgsSchema = z.object({
  sourceId: z.string().uuid(),
  targetId: z.string().uuid(),
  relation: z.string().min(1).max(100), // e.g., 'works_at', 'knows', 'part_of'
  attributes: z.record(z.unknown()).optional(),
  validFrom: z.string().datetime().optional(),
  validUntil: z.string().datetime().optional(),
  bidirectional: z.boolean().optional(), // Create edge in both directions
});

export type MemoryLinkArgs = z.infer<typeof MemoryLinkArgsSchema>;

/**
 * memory.episode - Log an event or decision
 */
export const MemoryEpisodeArgsSchema = z.object({
  type: z.enum(['decision', 'event', 'observation', 'interaction', 'milestone']),
  summary: z.string().min(1).max(1000),
  details: z.record(z.unknown()).optional(),
  importance: z.number().min(0).max(1).optional(),
  occurredAt: z.string().datetime().optional(),
  provenance: z.string().max(255).optional(),

  // Link episode to entities
  entityIds: z.array(z.string().uuid()).optional(),
  entityRoles: z.record(z.string()).optional(), // entityId -> role (e.g., 'subject', 'object')
});

export type MemoryEpisodeArgs = z.infer<typeof MemoryEpisodeArgsSchema>;
