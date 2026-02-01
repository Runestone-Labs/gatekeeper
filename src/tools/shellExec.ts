import { exec, ExecException } from 'node:child_process';
import { ToolResult, ToolPolicy } from '../types.js';
import { ShellExecArgs } from './schemas.js';
import { truncate } from '../utils.js';

// Default limits
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024; // 1MB

/**
 * Execute a shell command.
 * SECURITY: Enforces timeout and output size limits.
 */
export async function executeShellExec(
  args: ShellExecArgs,
  policy: ToolPolicy
): Promise<ToolResult> {
  const timeoutMs = Math.min(
    args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    policy.max_timeout_ms ?? DEFAULT_TIMEOUT_MS
  );

  const maxBuffer = policy.max_output_bytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  return new Promise((resolve) => {
    const options = {
      cwd: args.cwd,
      timeout: timeoutMs,
      maxBuffer: maxBuffer,
      encoding: 'utf-8' as const,
    };

    exec(args.command, options, (error, stdout, stderr) => {
      // Truncate output if it's too large (in case maxBuffer wasn't enough)
      const truncatedStdout = truncate(stdout || '', maxBuffer);
      const truncatedStderr = truncate(stderr || '', maxBuffer);

      if (error) {
        const execError = error as ExecException;

        // Check for specific error types
        if (execError.killed) {
          resolve({
            success: false,
            error: `Command killed (timeout: ${timeoutMs}ms exceeded)`,
            output: {
              exitCode: execError.code ?? -1,
              stdout: truncatedStdout,
              stderr: truncatedStderr,
              killed: true,
            },
          });
          return;
        }

        if ((error as { code?: string }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          resolve({
            success: false,
            error: `Output exceeded max buffer (${maxBuffer} bytes)`,
            output: {
              exitCode: -1,
              stdout: truncatedStdout,
              stderr: truncatedStderr,
              truncated: true,
            },
          });
          return;
        }

        // General execution error
        resolve({
          success: false,
          error: execError.message,
          output: {
            exitCode: execError.code ?? -1,
            stdout: truncatedStdout,
            stderr: truncatedStderr,
          },
        });
        return;
      }

      // Success
      resolve({
        success: true,
        output: {
          exitCode: 0,
          stdout: truncatedStdout,
          stderr: truncatedStderr,
        },
      });
    });
  });
}
