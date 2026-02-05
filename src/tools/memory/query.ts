import { eq, and, gte, sql } from 'drizzle-orm';
import { getDb, ageQuery, isDbAvailable } from '../../db/client.js';
import { entities, episodes } from '../../db/schema.js';
import type { MemoryQueryArgs } from './schemas.js';
import type { ToolResult } from '../../types.js';

/**
 * Execute memory queries - supports Cypher, entity lookup, and neighborhood traversal
 */
export async function executeMemoryQuery(args: MemoryQueryArgs): Promise<ToolResult> {
  if (!isDbAvailable()) {
    return { success: false, error: 'Database not available' };
  }

  const db = getDb();

  try {
    // Raw Cypher query (advanced users)
    if (args.cypher) {
      const result = await ageQuery(args.cypher);
      return { success: true, output: { type: 'cypher', data: result } };
    }

    // Entity lookup by ID
    if (args.entityId) {
      const entity = await db
        .select()
        .from(entities)
        .where(eq(entities.id, args.entityId))
        .limit(1);

      return {
        success: true,
        output: { type: 'entity', data: entity[0] || null },
      };
    }

    // Entity lookup by name
    if (args.entityName) {
      const matchingEntities = await db
        .select()
        .from(entities)
        .where(eq(entities.name, args.entityName));

      return {
        success: true,
        output: { type: 'entities', data: matchingEntities },
      };
    }

    // Entity search by type
    if (args.entityType) {
      const matchingEntities = await db
        .select()
        .from(entities)
        .where(eq(entities.type, args.entityType))
        .limit(args.limit || 50);

      return {
        success: true,
        output: { type: 'entities', data: matchingEntities },
      };
    }

    // Attribute-based search
    if (args.attributeQuery) {
      // Use JSONB containment operator
      const matchingEntities = await db
        .select()
        .from(entities)
        .where(sql`${entities.attributes} @> ${JSON.stringify(args.attributeQuery)}::jsonb`)
        .limit(args.limit || 50);

      return {
        success: true,
        output: { type: 'entities', data: matchingEntities },
      };
    }

    // Neighborhood query via Cypher
    if (args.fromEntity) {
      const maxHops = args.maxHops || 2;
      const relationFilter = args.relationTypes?.length
        ? `:${args.relationTypes.join('|')}`
        : '';

      const cypher = `
        MATCH (start:Entity {id: '${args.fromEntity}'})-[r${relationFilter}*1..${maxHops}]-(related:Entity)
        RETURN DISTINCT related
      `;

      const result = await ageQuery(cypher);
      return {
        success: true,
        output: { type: 'neighborhood', data: result, fromEntity: args.fromEntity, hops: maxHops },
      };
    }

    // Episode query
    if (args.episodeType || args.minImportance !== undefined || args.since) {
      const conditions = [];

      if (args.episodeType) {
        conditions.push(eq(episodes.type, args.episodeType));
      }
      if (args.minImportance !== undefined) {
        conditions.push(gte(episodes.importance, args.minImportance));
      }
      if (args.since) {
        conditions.push(gte(episodes.occurredAt, new Date(args.since)));
      }

      const matchingEpisodes = await db
        .select()
        .from(episodes)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(sql`${episodes.occurredAt} DESC`)
        .limit(args.limit || 50);

      return {
        success: true,
        output: { type: 'episodes', data: matchingEpisodes },
      };
    }

    return { success: false, error: 'No query parameters provided' };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Query failed',
    };
  }
}
