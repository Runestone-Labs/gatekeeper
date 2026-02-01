import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ToolResult, ToolPolicy } from '../types.js';
import { FilesWriteArgs } from './schemas.js';

/**
 * Write content to a file.
 * SECURITY: Path and extension validation happens in policy evaluation.
 */
export async function executeFilesWrite(
  args: FilesWriteArgs,
  _policy: ToolPolicy
): Promise<ToolResult> {
  try {
    // Ensure parent directory exists
    const dir = dirname(args.path);
    mkdirSync(dir, { recursive: true });

    // Write file
    writeFileSync(args.path, args.content, { encoding: args.encoding ?? 'utf8' });

    return {
      success: true,
      output: {
        path: args.path,
        bytesWritten: Buffer.byteLength(args.content, 'utf-8'),
      },
    };
  } catch (err) {
    const error = err as Error;
    return {
      success: false,
      error: `Failed to write file: ${error.message}`,
    };
  }
}
