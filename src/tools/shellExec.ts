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
  const env = buildExecutionEnv(policy);
  const command = buildCommand(args.command, policy);
  const uid =
    typeof policy.run_as_uid === 'number' && Number.isInteger(policy.run_as_uid) && policy.run_as_uid >= 0
      ? policy.run_as_uid
      : undefined;
  const gid =
    typeof policy.run_as_gid === 'number' && Number.isInteger(policy.run_as_gid) && policy.run_as_gid >= 0
      ? policy.run_as_gid
      : undefined;

  return new Promise((resolve) => {
    const options = {
      cwd: args.cwd,
      timeout: timeoutMs,
      maxBuffer: maxBuffer,
      encoding: 'utf-8' as const,
      env,
      uid,
      gid,
    };

    exec(command, options, (error, stdout, stderr) => {
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
              command,
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
              command,
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
            command,
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
          command,
        },
      });
    });
  });
}

function buildCommand(command: string, policy: ToolPolicy): string {
  if (!policy.sandbox_command_prefix || policy.sandbox_command_prefix.length === 0) {
    return command;
  }

  return [...policy.sandbox_command_prefix, command].join(' ');
}

function buildExecutionEnv(policy: ToolPolicy): NodeJS.ProcessEnv | undefined {
  const allowlist = policy.env_allowlist;
  const overrides = policy.env_overrides ?? {};

  if (!allowlist || allowlist.length === 0) {
    return Object.keys(overrides).length > 0 ? { ...process.env, ...overrides } : undefined;
  }

  const env: NodeJS.ProcessEnv = {};
  for (const key of allowlist) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }

  for (const [key, value] of Object.entries(overrides)) {
    env[key] = value;
  }

  return env;
}
