import { ageQuery, isDbAvailable } from '../../db/client.js';
import type { MemoryUnlinkArgs } from './schemas.js';
import type { ToolResult } from '../../types.js';

/**
 * Remove a relationship (edge) between two entities in the AGE graph.
 *
 * If relation is specified, only deletes edges of that type.
 * If relation is omitted, deletes ALL edges between source and target.
 */
export async function executeMemoryUnlink(args: MemoryUnlinkArgs): Promise<ToolResult> {
  if (!isDbAvailable()) {
    return { success: false, error: 'Database not available' };
  }

  try {
    const { sourceId, targetId, relation } = args;

    // AGE doesn't return count from DELETE, so we count first then delete
    let countCypher: string;
    let deleteCypher: string;

    if (relation) {
      // Delete specific relation type
      const sanitizedRelation = relation.toUpperCase().replace(/[^A-Z0-9_]/g, '_');

      countCypher = `
        MATCH (s:Entity {id: '${sourceId}'})-[r:${sanitizedRelation}]->(t:Entity {id: '${targetId}'})
        RETURN count(r) as cnt
      `;
      deleteCypher = `
        MATCH (s:Entity {id: '${sourceId}'})-[r:${sanitizedRelation}]->(t:Entity {id: '${targetId}'})
        DELETE r
      `;
    } else {
      // Delete ALL edges between source and target (both directions)
      countCypher = `
        MATCH (s:Entity {id: '${sourceId}'})-[r]-(t:Entity {id: '${targetId}'})
        RETURN count(r) as cnt
      `;
      deleteCypher = `
        MATCH (s:Entity {id: '${sourceId}'})-[r]-(t:Entity {id: '${targetId}'})
        DELETE r
      `;
    }

    // Count edges first
    const countResult = await ageQuery<number>(countCypher);
    const deletedCount = typeof countResult[0] === 'number' ? countResult[0] : 0;

    // Delete edges
    await ageQuery(deleteCypher);

    return {
      success: true,
      output: {
        sourceId,
        targetId,
        relation: relation || 'all',
        deleted: deletedCount,
      },
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Unlink failed',
    };
  }
}
