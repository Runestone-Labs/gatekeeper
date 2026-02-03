/**
 * Runestone Gatekeeper TypeScript Client
 *
 * A minimal, framework-agnostic client for interacting with Gatekeeper.
 * Can be used directly or wrapped by agent-specific integrations.
 *
 * @example
 * ```typescript
 * import { GatekeeperClient } from '@runestone/gatekeeper-client';
 *
 * const gk = new GatekeeperClient('http://localhost:3847');
 * const result = await gk.shellExec({ command: 'ls -la' });
 *
 * if (result.decision === 'allow') {
 *   console.log(result.result.stdout);
 * } else if (result.decision === 'approve') {
 *   console.log('Approval required:', result.approvalId);
 * } else {
 *   console.error('Denied:', result.reason);
 * }
 * ```
 */

import type {
  GatekeeperConfig,
  GatekeeperResult,
  Actor,
  RequestContext,
  ShellExecArgs,
  ShellExecResult,
  FilesWriteArgs,
  FilesWriteResult,
  HttpRequestArgs,
  HttpRequestResult,
} from './types.js';

export class GatekeeperClient {
  private readonly baseUrl: string;
  private readonly agentName: string;
  private readonly runId?: string;

  constructor(config: GatekeeperConfig | string) {
    if (typeof config === 'string') {
      this.baseUrl = config;
      this.agentName = 'typescript-agent';
    } else {
      this.baseUrl = config.baseUrl;
      this.agentName = config.agentName || 'typescript-agent';
      this.runId = config.runId;
    }
  }

  /**
   * Call a Gatekeeper tool with the given arguments.
   * This is the low-level method - prefer the convenience methods below.
   */
  async callTool<T = unknown>(
    tool: string,
    args: Record<string, unknown>,
    options?: {
      actor?: Partial<Actor>;
      context?: RequestContext;
    }
  ): Promise<GatekeeperResult<T>> {
    const requestId = crypto.randomUUID();

    const actor: Actor = {
      type: 'agent',
      name: this.agentName,
      ...options?.actor,
    };

    if (this.runId && !actor.runId) {
      actor.runId = this.runId;
    }

    const body = {
      requestId,
      actor,
      args,
      ...(options?.context && { context: options.context }),
    };

    const response = await fetch(`${this.baseUrl}/tool/${tool}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok && response.status !== 403 && response.status !== 202) {
      throw new Error(`Gatekeeper request failed: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<GatekeeperResult<T>>;
  }

  /**
   * Execute a shell command through Gatekeeper.
   */
  async shellExec(
    args: ShellExecArgs,
    options?: { actor?: Partial<Actor>; context?: RequestContext }
  ): Promise<GatekeeperResult<ShellExecResult>> {
    return this.callTool<ShellExecResult>('shell.exec', args, options);
  }

  /**
   * Write a file through Gatekeeper.
   */
  async filesWrite(
    args: FilesWriteArgs,
    options?: { actor?: Partial<Actor>; context?: RequestContext }
  ): Promise<GatekeeperResult<FilesWriteResult>> {
    return this.callTool<FilesWriteResult>('files.write', args, options);
  }

  /**
   * Make an HTTP request through Gatekeeper.
   */
  async httpRequest(
    args: HttpRequestArgs,
    options?: { actor?: Partial<Actor>; context?: RequestContext }
  ): Promise<GatekeeperResult<HttpRequestResult>> {
    return this.callTool<HttpRequestResult>('http.request', args, options);
  }

  /**
   * Check if Gatekeeper is healthy.
   */
  async health(): Promise<{
    version: string;
    policyHash: string;
    uptime: number;
    pendingApprovals: number;
    demoMode: boolean;
  }> {
    const response = await fetch(`${this.baseUrl}/health`);
    if (!response.ok) {
      throw new Error(`Health check failed: ${response.status}`);
    }
    return response.json();
  }
}
