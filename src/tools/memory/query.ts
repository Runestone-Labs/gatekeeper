import { eq, and, gte, sql } from 'drizzle-orm';
import { getDb, ageQuery, rawQuery, isDbAvailable } from '../../db/client.js';
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
    // Evidence lookup
    if (args.evidenceForEntity || args.evidenceForEpisode) {
      const limit = args.limit || 50;

      if (args.evidenceForEntity) {
        const rows = await rawQuery(
          `SELECT e.*, l.entity_id, l.episode_id, l.relevance
           FROM evidence_links l
           JOIN evidence e ON e.id = l.evidence_id
           WHERE l.entity_id = $1
           ORDER BY l.relevance DESC, e.captured_at DESC
           LIMIT $2`,
          [args.evidenceForEntity, limit]
        );

        return {
          success: true,
          output: { type: 'evidence', target: { entityId: args.evidenceForEntity }, data: rows },
        };
      }

      if (args.evidenceForEpisode) {
        const rows = await rawQuery(
          `SELECT e.*, l.entity_id, l.episode_id, l.relevance
           FROM evidence_links l
           JOIN evidence e ON e.id = l.evidence_id
           WHERE l.episode_id = $1
           ORDER BY l.relevance DESC, e.captured_at DESC
           LIMIT $2`,
          [args.evidenceForEpisode, limit]
        );

        return {
          success: true,
          output: { type: 'evidence', target: { episodeId: args.evidenceForEpisode }, data: rows },
        };
      }
    }

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

    // Full-text search on name and description
    if (args.searchText) {
      // Convert search text to tsquery with prefix matching
      // Split on spaces, add :* to each term for prefix matching
      const terms = args.searchText
        .trim()
        .split(/\s+/)
        .filter((t) => t.length > 0)
        .map((t) => t.replace(/[^a-zA-Z0-9]/g, '')) // Remove special chars
        .filter((t) => t.length > 0)
        .map((t) => `${t}:*`)
        .join(' & ');

      if (!terms) {
        return { success: false, error: 'Invalid search text' };
      }

      const matchingEntities = await db
        .select({
          id: entities.id,
          type: entities.type,
          name: entities.name,
          description: entities.description,
          attributes: entities.attributes,
          confidence: entities.confidence,
          provenance: entities.provenance,
          createdAt: entities.createdAt,
          updatedAt: entities.updatedAt,
        })
        .from(entities)
        .where(sql`search_vector @@ to_tsquery('english', ${terms})`)
        .limit(args.limit || 50);

      return {
        success: true,
        output: { type: 'search', query: args.searchText, data: matchingEntities },
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
