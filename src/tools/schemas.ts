import { z } from 'zod';

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
 * Tool request body schema.
 */
export const ToolRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    actor: z
      .object({
        type: z.enum(['agent', 'user']),
        name: z.string().min(1),
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
  })
  .strict();

export type ToolRequestBody = z.infer<typeof ToolRequestSchema>;

/**
 * Get the schema for a specific tool.
 */
export function getToolSchema(toolName: string): z.ZodType | null {
  switch (toolName) {
    case 'shell.exec':
      return ShellExecArgsSchema;
    case 'files.write':
      return FilesWriteArgsSchema;
    case 'http.request':
      return HttpRequestArgsSchema;
    default:
      return null;
  }
}
