import { getDb, isDbAvailable } from '../../db/client.js';
import { evidence, evidenceLinks } from '../../db/schema/index.js';
import type { MemoryEvidenceArgs } from './schemas.js';
import type { ToolResult } from '../../types.js';

/**
 * Attach evidence/provenance to entities or episodes.
 */
export async function executeMemoryEvidence(args: MemoryEvidenceArgs): Promise<ToolResult> {
  if (!isDbAvailable()) {
    return { success: false, error: 'Database not available' };
  }

  const db = getDb();

  try {
    // Evidence + links commit atomically: a failed link (e.g. bad entityId FK)
    // must not leave an orphaned evidence row behind.
    const record = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(evidence)
        .values({
          type: args.type,
          reference: args.reference,
          snippet: args.snippet,
          taint: args.taint ?? [],
        })
        .returning();

      const created = inserted[0];
      const relevance = args.relevance ?? 1.0;

      const links = [
        ...(args.entityIds || []).map((entityId) => ({
          evidenceId: created.id,
          entityId,
          episodeId: null,
          relevance,
        })),
        ...(args.episodeIds || []).map((episodeId) => ({
          evidenceId: created.id,
          entityId: null,
          episodeId,
          relevance,
        })),
      ];

      if (links.length > 0) {
        await tx.insert(evidenceLinks).values(links);
      }

      return created;
    });

    return {
      success: true,
      output: {
        evidence: record,
        linkedEntities: args.entityIds?.length || 0,
        linkedEpisodes: args.episodeIds?.length || 0,
      },
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Evidence creation failed',
    };
  }
}
