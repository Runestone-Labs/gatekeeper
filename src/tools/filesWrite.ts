import { writeFileSync, mkdirSync, existsSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { ToolResult, ToolPolicy } from '../types.js';
import { FilesWriteArgs } from './schemas.js';
import { isPathWithin, resolvePath } from '../utils.js';

/**
 * Write content to a file.
 * SECURITY: Path and extension validation happens in policy evaluation.
 */
export async function executeFilesWrite(
  args: FilesWriteArgs,
  policy: ToolPolicy
): Promise<ToolResult> {
  try {
    const resolvedPath = resolvePath(args.path);

    if (policy.allowed_paths && policy.allowed_paths.length > 0) {
      const allowed = policy.allowed_paths.some((prefix) =>
        isPathWithin(resolvedPath, resolvePath(prefix))
      );
      if (!allowed) {
        return {
          success: false,
          error: `Denied: path "${args.path}" not in allowed paths`,
        };
      }
    }

    const parentDir = dirname(resolvedPath);
    const existingParent = findExistingParent(parentDir);

    if (existingParent && policy.allowed_paths && policy.allowed_paths.length > 0) {
      const realParent = realpathSync(existingParent);
      const realAllowedRoots = policy.allowed_paths
        .map((prefix) => {
          try {
            return realpathSync(resolvePath(prefix));
          } catch {
            return null;
          }
        })
        .filter((value): value is string => Boolean(value));

      if (
        realAllowedRoots.length > 0 &&
        !realAllowedRoots.some((root) => isPathWithin(realParent, root))
      ) {
        return {
          success: false,
          error: `Denied: path "${args.path}" resolves outside allowed roots`,
        };
      }
    }

    // Ensure parent directory exists
    mkdirSync(parentDir, { recursive: true });

    // Write file
    writeFileSync(resolvedPath, args.content, { encoding: args.encoding ?? 'utf8' });

    return {
      success: true,
      output: {
        path: resolvedPath,
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

function findExistingParent(targetPath: string): string | null {
  let current = targetPath;

  while (true) {
    if (existsSync(current)) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}
