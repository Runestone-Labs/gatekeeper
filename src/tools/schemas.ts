import { z } from 'zod';
import { config } from '../config.js';

/**
 * Zod schemas for tool arguments.
 * SECURITY: .strict() rejects unknown fields to prevent privilege escalation.
 */

export const ShellExecArgsSchema = z
  .object({
    command: z.string().min(1, 'Command is required'),
    cwd: z.string().optional(),
    timeoutMs: z.number().int().positive().max(30000).optional(),
  })
  .strict();

export type ShellExecArgs = z.infer<typeof ShellExecArgsSchema>;

export const FilesWriteArgsSchema = z
  .object({
    path: z.string().min(1, 'Path is required'),
    content: z.string(),
    encoding: z.enum(['utf8']).optional().default('utf8'),
  })
  .strict();

export type FilesWriteArgs = z.infer<typeof FilesWriteArgsSchema>;

export const HttpRequestArgsSchema = z
  .object({
    url: z.string().url('Invalid URL'),
    method: z.enum(['GET', 'POST']),
    headers: z.record(z.string()).optional(),
    body: z.string().optional(),
  })
  .strict();

export type HttpRequestArgs = z.infer<typeof HttpRequestArgsSchema>;

/**
 * Context reference schema - what triggered this call.
 */
export const ContextRefSchema = z.object({
  type: z.enum(['message', 'url', 'document', 'memory_entity']),
  id: z.string().min(1),
  taint: z.array(z.string()).optional(),
});

export type ContextRef = z.infer<typeof ContextRefSchema>;

/**
 * Origin types - where did this request come from.
 */
export const OriginSchema = z.enum([
  'user_direct', // User explicitly requested this
  'model_inferred', // Model decided to do this
  'external_content', // Triggered by external content (URL, email, etc.)
  'background_job', // Triggered by scheduled/background task
]);

export type Origin = z.infer<typeof OriginSchema>;

/**
 * Tool request body schema.
 * v1.0: Added role, origin, taint, contextRefs, idempotencyKey, dryRun, capabilityToken
 * Role is required for policy enforcement; other v1 fields are optional.
 */
export const ToolRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    actor: z
      .object({
        type: z.enum(['agent', 'user']),
        name: z.string().min(1),
        role: z.string().min(1), // v1: explicit role (e.g., 'navigator', 'sentinel')
        runId: z.string().optional(),
      })
      .strict(),
    args: z.record(z.unknown()),
    context: z
      .object({
        conversationId: z.string().optional(),
        traceId: z.string().optional(),
      })
      .strict()
      .optional(),

    // v1 envelope fields (all optional for backwards compatibility)
    origin: OriginSchema.optional(),
    taint: z.array(z.string()).optional(), // e.g., ['external', 'email', 'untrusted']
    contextRefs: z.array(ContextRefSchema).optional(),
    idempotencyKey: z.string().optional(), // for safe retries
    dryRun: z.boolean().optional(), // preview without execution
    capabilityToken: z.string().optional(), // pre-authorized capability
    timestamp: z.string().datetime().optional(), // ISO 8601
  })
  .strict();

export type ToolRequestBody = z.infer<typeof ToolRequestSchema>;

// Lazily loaded memory schemas (only when memory module is enabled)
let memorySchemas: Record<string, z.ZodType> | null = null;

async function getMemorySchemas(): Promise<Record<string, z.ZodType>> {
  if (!memorySchemas) {
    const {
      MemoryQueryArgsSchema,
      MemoryUpsertArgsSchema,
      MemoryLinkArgsSchema,
      MemoryEpisodeArgsSchema,
      MemoryUnlinkArgsSchema,
      MemoryEvidenceArgsSchema,
    } = await import('./memory/schemas.js');

    memorySchemas = {
      'memory.query': MemoryQueryArgsSchema,
      'memory.upsert': MemoryUpsertArgsSchema,
      'memory.link': MemoryLinkArgsSchema,
      'memory.episode': MemoryEpisodeArgsSchema,
      'memory.unlink': MemoryUnlinkArgsSchema,
      'memory.evidence': MemoryEvidenceArgsSchema,
    };
  }
  return memorySchemas;
}

// Core schemas (always available)
const coreSchemas: Record<string, z.ZodType> = {
  'shell.exec': ShellExecArgsSchema,
  'files.write': FilesWriteArgsSchema,
  'http.request': HttpRequestArgsSchema,
};

/**
 * Get the schema for a specific tool.
 */
export function getToolSchema(toolName: string): z.ZodType | null {
  return coreSchemas[toolName] ?? null;
}

/**
 * Initialize memory schemas if memory module is enabled.
 * Must be called at startup before handling requests.
 */
export async function initToolSchemas(): Promise<void> {
  if (config.enableMemory) {
    const schemas = await getMemorySchemas();
    Object.assign(coreSchemas, schemas);
  }
}
