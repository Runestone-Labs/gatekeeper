import { getDb, isDbAvailable } from '../../db/client.js';
import { episodes, episodeEntities } from '../../db/schema.js';
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
    // Create episode
    const inserted = await db
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

    const episode = inserted[0];

    // Link episode to entities
    if (args.entityIds && args.entityIds.length > 0) {
      const links = args.entityIds.map((entityId) => ({
        episodeId: episode.id,
        entityId,
        role: args.entityRoles?.[entityId] || null,
      }));

      await db.insert(episodeEntities).values(links);
    }

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
