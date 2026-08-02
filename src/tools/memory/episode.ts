import { getDb, isDbAvailable } from '../../db/client.js';
import { episodes, episodeEntities } from '../../db/schema/index.js';
import type { MemoryEpisodeArgs } from './schemas.js';
import type { ToolResult } from '../../types.js';

/**
 * Log an episode (event, decision, observation) to the memory graph
 */
export async function executeMemoryEpisode(args: MemoryEpisodeArgs): Promise<ToolResult> {
  if (!isDbAvailable()) {
    return { success: false, error: 'Database not available' };
  }

  const db = getDb();

  try {
    // Episode + links commit atomically: a failed link (e.g. bad entityId FK)
    // must not leave an orphaned episode row behind.
    const episode = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(episodes)
        .values({
          type: args.type,
          summary: args.summary,
          details: args.details || {},
          importance: args.importance ?? 0.5,
          occurredAt: args.occurredAt ? new Date(args.occurredAt) : new Date(),
          provenance: args.provenance,
        })
        .returning();

      const created = inserted[0];

      // Link episode to entities
      if (args.entityIds && args.entityIds.length > 0) {
        const links = args.entityIds.map((entityId) => ({
          episodeId: created.id,
          entityId,
          role: args.entityRoles?.[entityId] || null,
        }));

        await tx.insert(episodeEntities).values(links);
      }

      return created;
    });

    return {
      success: true,
      output: {
        episode,
        linkedEntities: args.entityIds?.length || 0,
      },
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Episode creation failed',
    };
  }
}
