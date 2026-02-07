import { eq } from 'drizzle-orm';
import { getDb, isDbAvailable } from '../../db/client.js';
import { entities } from '../../db/schema/index.js';
import type { MemoryUpsertArgs } from './schemas.js';
import type { ToolResult } from '../../types.js';

/**
 * Create or update an entity in the memory system.
 *
 * Architecture: SQL-only storage for entities.
 * - Entities are stored in PostgreSQL via Drizzle ORM (source of truth)
 * - Relationships between entities are stored in AGE graph via memory.link
 *
 * This separation eliminates dual-write consistency issues.
 */
export async function executeMemoryUpsert(args: MemoryUpsertArgs): Promise<ToolResult> {
  if (!isDbAvailable()) {
    return { success: false, error: 'Database not available' };
  }

  const db = getDb();

  try {
    if (args.id) {
      // Update existing entity
      const updated = await db
        .update(entities)
        .set({
          type: args.type,
          name: args.name,
          description: args.description,
          attributes: args.attributes || {},
          confidence: args.confidence,
          provenance: args.provenance,
          updatedAt: new Date(),
        })
        .where(eq(entities.id, args.id))
        .returning();

      if (updated.length === 0) {
        return { success: false, error: `Entity not found: ${args.id}` };
      }

      return {
        success: true,
        output: {
          action: 'updated',
          entity: updated[0],
        },
      };
    }

    // Create new entity
    const inserted = await db
      .insert(entities)
      .values({
        type: args.type,
        name: args.name,
        description: args.description,
        attributes: args.attributes || {},
        confidence: args.confidence ?? 1.0,
        provenance: args.provenance,
      })
      .returning();

    return {
      success: true,
      output: {
        action: 'created',
        entity: inserted[0],
      },
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Upsert failed',
    };
  }
}
