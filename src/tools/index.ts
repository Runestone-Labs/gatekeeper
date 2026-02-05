import { ToolResult, ToolPolicy } from '../types.js';
import { getToolSchema } from './schemas.js';
import { executeShellExec } from './shellExec.js';
import { executeFilesWrite } from './filesWrite.js';
import { executeHttpRequest } from './httpRequest.js';
import {
  executeMemoryQuery,
  executeMemoryUpsert,
  executeMemoryLink,
  executeMemoryEpisode,
} from './memory/index.js';

/**
 * Tool registry and executor.
 */

type ToolExecutor<T> = (args: T, policy: ToolPolicy) => Promise<ToolResult>;

interface Tool<T> {
  name: string;
  execute: ToolExecutor<T>;
}

const tools: Record<string, Tool<unknown>> = {
  'shell.exec': {
    name: 'shell.exec',
    execute: executeShellExec as ToolExecutor<unknown>,
  },
  'files.write': {
    name: 'files.write',
    execute: executeFilesWrite as ToolExecutor<unknown>,
  },
  'http.request': {
    name: 'http.request',
    execute: executeHttpRequest as ToolExecutor<unknown>,
  },
  'memory.query': {
    name: 'memory.query',
    execute: executeMemoryQuery as ToolExecutor<unknown>,
  },
  'memory.upsert': {
    name: 'memory.upsert',
    execute: executeMemoryUpsert as ToolExecutor<unknown>,
  },
  'memory.link': {
    name: 'memory.link',
    execute: executeMemoryLink as ToolExecutor<unknown>,
  },
  'memory.episode': {
    name: 'memory.episode',
    execute: executeMemoryEpisode as ToolExecutor<unknown>,
  },
};

/**
 * Check if a tool exists.
 */
export function toolExists(toolName: string): boolean {
  return toolName in tools;
}

/**
 * Validate tool arguments against the schema.
 * SECURITY: Rejects unknown fields to prevent privilege escalation.
 */
export function validateToolArgs(
  toolName: string,
  args: Record<string, unknown>
): { success: true; args: unknown } | { success: false; error: string } {
  const schema = getToolSchema(toolName);

  if (!schema) {
    return { success: false, error: `Unknown tool: ${toolName}` };
  }

  const result = schema.safeParse(args);

  if (!result.success) {
    const errors = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
    return { success: false, error: `Invalid arguments: ${errors}` };
  }

  return { success: true, args: result.data };
}

/**
 * Execute a tool with validated arguments.
 */
export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  policy: ToolPolicy
): Promise<ToolResult> {
  const tool = tools[toolName];

  if (!tool) {
    return { success: false, error: `Unknown tool: ${toolName}` };
  }

  // Validate args
  const validation = validateToolArgs(toolName, args);
  if (!validation.success) {
    return { success: false, error: validation.error };
  }

  // Execute tool
  return tool.execute(validation.args, policy);
}

/**
 * Get list of available tools.
 */
export function getAvailableTools(): string[] {
  return Object.keys(tools);
}
