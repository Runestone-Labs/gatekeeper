import { ageQuery, isDbAvailable } from '../../db/client.js';
import type { MemoryLinkArgs } from './schemas.js';
import type { ToolResult } from '../../types.js';

/**
 * Create a relationship (edge) between two entities in the AGE graph.
 *
 * Architecture: Entities are stored in SQL, relationships in AGE.
 * - This function creates lightweight "stub" nodes in AGE (just the entity ID)
 * - Then creates the relationship edge between them
 * - Full entity details are always fetched from SQL by ID
 *
 * This allows graph traversals while keeping entities in SQL as source of truth.
 */
export async function executeMemoryLink(args: MemoryLinkArgs): Promise<ToolResult> {
  if (!isDbAvailable()) {
    return { success: false, error: 'Database not available' };
  }

  try {
    const { sourceId, targetId, relation, attributes, validFrom, validUntil, bidirectional } = args;

    // Sanitize relation name (AGE requires alphanumeric + underscore)
    const sanitizedRelation = relation.toUpperCase().replace(/[^A-Z0-9_]/g, '_');

    // Build attributes JSON for the edge
    const edgeAttrs: Record<string, unknown> = {
      created_at: new Date().toISOString(),
    };

    if (validFrom) {
      edgeAttrs.valid_from = validFrom;
    }
    if (validUntil) {
      edgeAttrs.valid_until = validUntil;
    }
    if (attributes) {
      Object.assign(edgeAttrs, attributes);
    }

    // Build property list for Cypher (key: 'value' pairs)
    const propPairs = Object.entries(edgeAttrs)
      .map(([key, value]) => {
        const escapedValue = String(value).replace(/'/g, "''");
        return `${key}: '${escapedValue}'`;
      })
      .join(', ');

    // MERGE creates the node if it doesn't exist, or matches if it does
    // This ensures stub nodes exist in AGE for relationship traversals
    // Properties are set inline in the CREATE clause
    const cypher = `
      MERGE (source:Entity {id: '${sourceId}'})
      MERGE (target:Entity {id: '${targetId}'})
      CREATE (source)-[r:${sanitizedRelation} {${propPairs}}]->(target)
      RETURN r
    `;

    const result = await ageQuery(cypher);

    // If bidirectional, create reverse edge too
    if (bidirectional) {
      const reverseCypher = `
        MATCH (source:Entity {id: '${sourceId}'}), (target:Entity {id: '${targetId}'})
        CREATE (target)-[r:${sanitizedRelation} {${propPairs}}]->(source)
        RETURN r
      `;
      await ageQuery(reverseCypher);
    }

    return {
      success: true,
      output: {
        relation: sanitizedRelation,
        sourceId,
        targetId,
        bidirectional: bidirectional || false,
        edge: result[0],
      },
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Link creation failed',
    };
  }
}
