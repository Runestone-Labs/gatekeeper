import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { ApprovalProvider, AuditSink, PolicySource } from './types.js';
import { PendingApproval, AuditEntry, Policy } from '../types.js';
import { config } from '../config.js';
import { canonicalize, computeHash } from '../utils.js';
import {
  cloudApprovalV1Schema,
  cloudDecisionV1Schema,
  cloudEventV1Schema,
  type CloudApprovalV1,
  type CloudDecisionV1,
  type CloudEventV1,
} from '../cloud/schemas.js';
import {
  auditEntryToCloudEvent,
  computeApprovalActionDigest,
  createCloudReviewSummary,
} from '../cloud/privacy.js';

type ApprovalOutcome = 'approved' | 'denied' | 'expired' | 'executed' | 'failed';

function endpoint(path: string): string {
  return `${config.runestoneApiUrl.replace(/\/$/, '')}${path}`;
}

function cloudHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${config.runestoneApiKey}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function cloudFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.cloudRequestTimeoutMs);
  try {
    return await fetch(endpoint(path), {
      ...init,
      headers: cloudHeaders((init.headers ?? {}) as Record<string, string>),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function requireCloudConfig(): void {
  if (!config.runestoneApiUrl || !config.runestoneApiKey || !config.runestoneInstanceId) {
    throw new Error(
      'Runestone Cloud is not connected. Run `gatekeeper connect` or configure ' +
        'RUNESTONE_API_URL, RUNESTONE_INSTANCE_ID, and RUNESTONE_API_KEY.'
    );
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Outbound-only approval delivery and decision polling. */
export class RunestoneCloudApproval implements ApprovalProvider {
  name = 'runestone-cloud';
  private polling = new Set<string>();

  async requestApproval(
    approval: PendingApproval,
    _urls: { approveUrl: string; denyUrl: string }
  ): Promise<boolean> {
    requireCloudConfig();
    const actionDigest = computeApprovalActionDigest(approval);
    const payload: CloudApprovalV1 = cloudApprovalV1Schema.parse({
      schemaVersion: 'cloud-approval.v1',
      approvalId: approval.id,
      instanceId: config.runestoneInstanceId,
      requestId: approval.requestId,
      actor: approval.actor,
      tool: approval.toolName,
      status: 'pending',
      reasonCode: approval.reasonCode,
      riskCategory: approval.riskCategory,
      policyHash: approval.policyHash ?? 'unknown',
      actionDigest,
      summary: createCloudReviewSummary(
        approval.toolName,
        approval.args,
        config.cloudCustomSummaryFields
      ),
      createdAt: approval.createdAt,
      expiresAt: approval.expiresAt,
    });

    const registration = await this.register(payload);
    if (registration === 'conflict') {
      throw new Error('Cloud approval registration failed (409)');
    }
    if (!this.polling.has(approval.id)) {
      this.polling.add(approval.id);
      const work =
        registration === 'registered'
          ? this.pollUntilResolved(approval, actionDigest)
          : this.retryRegistrationAndPoll(payload, approval, actionDigest);
      void work.finally(() => this.polling.delete(approval.id));
    }
    return registration === 'registered';
  }

  private async register(payload: CloudApprovalV1): Promise<'registered' | 'conflict' | 'retry'> {
    try {
      const response = await cloudFetch('/v1/approvals', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      if (response.ok) return 'registered';
      return response.status === 409 ? 'conflict' : 'retry';
    } catch {
      return 'retry';
    }
  }

  private async retryRegistrationAndPoll(
    payload: CloudApprovalV1,
    approval: PendingApproval,
    actionDigest: string
  ): Promise<void> {
    const expiry = new Date(approval.expiresAt).getTime();
    while (Date.now() < expiry) {
      await wait(config.cloudPollIntervalMs);
      const registration = await this.register(payload);
      if (registration === 'registered') {
        await this.pollUntilResolved(approval, actionDigest);
        return;
      }
      if (registration === 'conflict') {
        await this.acknowledge(
          approval.id,
          'failed',
          actionDigest,
          'APPROVAL_REGISTRATION_CONFLICT'
        );
        return;
      }
    }
    await this.acknowledge(approval.id, 'expired', actionDigest, 'APPROVAL_EXPIRED');
  }

  private async pollUntilResolved(approval: PendingApproval, actionDigest: string): Promise<void> {
    const expiry = new Date(approval.expiresAt).getTime();
    while (Date.now() < expiry) {
      try {
        const response = await cloudFetch(
          `/v1/decisions?approvalId=${encodeURIComponent(approval.id)}&wait=${Math.min(25, Math.ceil(config.cloudRequestTimeoutMs / 1000))}`,
          { method: 'GET' }
        );
        if (response.status === 204 || response.status === 404) {
          await wait(config.cloudPollIntervalMs);
          continue;
        }
        if (!response.ok) {
          await wait(config.cloudPollIntervalMs);
          continue;
        }

        const raw = (await response.json()) as unknown;
        const candidate =
          raw && typeof raw === 'object' && 'decision' in raw
            ? (raw as { decision: unknown }).decision
            : raw;
        const parsed = cloudDecisionV1Schema.safeParse(candidate);
        if (!parsed.success) {
          await this.acknowledge(approval.id, 'failed', actionDigest, 'MALFORMED_DECISION');
          return;
        }
        const decision = parsed.data;
        if (!this.matchesLocalApproval(decision, approval, actionDigest)) {
          await this.acknowledge(approval.id, 'failed', actionDigest, 'DECISION_BINDING_MISMATCH');
          return;
        }

        const action = decision.status === 'approved' ? 'approve' : 'deny';
        const local = await fetch(`${config.baseUrl}/approvals/${approval.id}/${action}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.secret}`,
            'Content-Type': 'application/json',
          },
          body: '{}',
        });
        if (local.ok || local.status === 409 || local.status === 410) return;
        await this.acknowledge(approval.id, 'failed', actionDigest, 'LOCAL_APPLICATION_FAILED');
        return;
      } catch {
        // Cloud outage: keep the local hold pending. Ordinary locally allowed
        // actions continue, and this hold expires safely if Cloud stays down.
        await wait(config.cloudPollIntervalMs);
      }
    }
    await this.acknowledge(approval.id, 'expired', actionDigest, 'APPROVAL_EXPIRED');
  }

  private matchesLocalApproval(
    decision: CloudDecisionV1,
    approval: PendingApproval,
    actionDigest: string
  ): boolean {
    const expiresAt = new Date(decision.expiresAt).getTime();
    return (
      decision.approvalId === approval.id &&
      decision.instanceId === config.runestoneInstanceId &&
      decision.actionDigest === actionDigest &&
      decision.expiresAt === approval.expiresAt &&
      Number.isFinite(expiresAt) &&
      Date.now() < expiresAt &&
      new Date(decision.decidedAt).getTime() <= expiresAt
    );
  }

  async notifyResult(
    approval: PendingApproval,
    action: ApprovalOutcome,
    result?: string
  ): Promise<void> {
    if (!config.runestoneApiUrl || !config.runestoneApiKey) return;
    const status =
      action === 'approved'
        ? result?.toLowerCase().includes('fail')
          ? 'failed'
          : 'executed'
        : action;
    await this.acknowledge(
      approval.id,
      status,
      computeApprovalActionDigest(approval),
      status === 'failed' ? 'LOCAL_EXECUTION_FAILED' : undefined
    );
  }

  private async acknowledge(
    approvalId: string,
    status: ApprovalOutcome,
    actionDigest: string,
    reasonCode?: string
  ): Promise<void> {
    try {
      await cloudFetch(`/v1/approvals/${encodeURIComponent(approvalId)}/ack`, {
        method: 'POST',
        body: JSON.stringify({
          status,
          actionDigest,
          ...(reasonCode ? { reasonCode } : {}),
          acknowledgedAt: new Date().toISOString(),
        }),
      });
    } catch {
      // The decision remains bound and consumed locally. The event mirror will
      // still provide execution evidence after connectivity returns.
    }
  }
}

/** Buffered secondary audit copy. It never receives raw args or results. */
export class RunestoneCloudAudit implements AuditSink {
  name = 'runestone-cloud';
  private flushing = false;
  private chainState: { sequence: number; hash: string | null } | null = null;

  async write(entry: AuditEntry): Promise<void> {
    if (!config.runestoneApiUrl || !config.runestoneApiKey || !config.runestoneInstanceId) return;
    const event = cloudEventV1Schema.parse(
      auditEntryToCloudEvent(entry, config.runestoneInstanceId)
    );
    this.ensureCloudChainState();
    const priorState = { ...this.chainState! };
    this.applyCloudReceiptChain(event);
    if (!this.appendToSpool(event)) {
      // Preserve a contiguous Cloud receipt chain. The next event appended
      // after space is available will expose the local-audit sequence gap.
      this.chainState = priorState;
      return;
    }
    void this.flush();
  }

  private appendToSpool(event: CloudEventV1): boolean {
    mkdirSync(dirname(config.cloudSpoolPath), { recursive: true, mode: 0o700 });
    const line = `${JSON.stringify(event)}\n`;
    const currentBytes = existsSync(config.cloudSpoolPath)
      ? statSync(config.cloudSpoolPath).size
      : 0;
    if (currentBytes + Buffer.byteLength(line) > config.cloudSpoolMaxBytes) {
      console.error('Gatekeeper Cloud audit spool is full; local audit remains authoritative');
      return false;
    }
    appendFileSync(config.cloudSpoolPath, line, {
      encoding: 'utf-8',
      mode: 0o600,
    });
    chmodSync(config.cloudSpoolPath, 0o600);
    writeFileSync(
      config.cloudChainStatePath,
      JSON.stringify({ sequence: event.sequence, hash: event.entryHash }),
      { mode: 0o600 }
    );
    chmodSync(config.cloudChainStatePath, 0o600);
    return true;
  }

  private ensureCloudChainState(): void {
    if (!this.chainState) {
      try {
        const stored = JSON.parse(readFileSync(config.cloudChainStatePath, 'utf-8')) as {
          sequence?: unknown;
          hash?: unknown;
        };
        this.chainState = {
          sequence: typeof stored.sequence === 'number' ? stored.sequence : 0,
          hash: typeof stored.hash === 'string' ? stored.hash : null,
        };
      } catch {
        this.chainState = { sequence: 0, hash: null };
      }
    }
  }

  private applyCloudReceiptChain(event: CloudEventV1): void {
    this.ensureCloudChainState();
    const state = this.chainState!;
    event.sequence = state.sequence + 1;
    event.previousEntryHash = state.hash;
    const { entryHash: _entryHash, ...hashable } = event;
    event.entryHash = `sha256:${computeHash(canonicalize(hashable))}`;
    this.chainState = { sequence: event.sequence, hash: event.entryHash };
  }

  async flush(): Promise<void> {
    if (this.flushing || !existsSync(config.cloudSpoolPath)) return;
    this.flushing = true;
    try {
      const selected = readFileSync(config.cloudSpoolPath, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .slice(0, 99)
        .map((line) => cloudEventV1Schema.parse(JSON.parse(line)));
      if (selected.length === 0) return;
      const response = await cloudFetch('/v1/events/batch', {
        method: 'POST',
        body: JSON.stringify({ schemaVersion: 'cloud-events-batch.v1', events: selected }),
      });
      if (!response.ok) return;

      const delivered = new Set(selected.map((event) => event.eventId));
      const remaining = readFileSync(config.cloudSpoolPath, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .filter((line) => {
          try {
            return !delivered.has((JSON.parse(line) as CloudEventV1).eventId);
          } catch {
            return true;
          }
        });
      const temporary = `${config.cloudSpoolPath}.tmp`;
      writeFileSync(temporary, remaining.length ? `${remaining.join('\n')}\n` : '', {
        mode: 0o600,
      });
      renameSync(temporary, config.cloudSpoolPath);
    } catch {
      // Local audit is already durable. Keep the bounded spool for a later retry.
    } finally {
      this.flushing = false;
    }
  }
}

type CachedPolicy = { policy: Policy; policyHash: string; etag?: string; fetchedAt: string };

/** Cloud policy with strict validation and a local last-known-good fallback. */
export class RunestoneCloudPolicy implements PolicySource {
  name = 'runestone-cloud';
  private cached: CachedPolicy | null = null;
  private callback: (() => void) | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;

  async load(): Promise<Policy> {
    requireCloudConfig();
    const local = this.cached ?? this.readLastKnownGood();
    try {
      const response = await cloudFetch('/v1/policies/current', {
        method: 'GET',
        headers: local?.etag ? { 'If-None-Match': local.etag } : {},
      });
      if (response.status === 304 && local) {
        this.cached = local;
        return local.policy;
      }
      if (!response.ok) throw new Error(`Cloud policy fetch failed (${response.status})`);
      const body = (await response.json()) as {
        policy?: unknown;
        policyHash?: unknown;
        etag?: unknown;
      };
      const policy = validateCloudPolicy(body.policy);
      const calculated = `sha256:${computeHash(canonicalize(policy))}`;
      if (body.policyHash !== calculated) throw new Error('Cloud policy hash mismatch');
      const next: CachedPolicy = {
        policy,
        policyHash: calculated,
        etag:
          typeof body.etag === 'string' ? body.etag : (response.headers.get('etag') ?? undefined),
        fetchedAt: new Date().toISOString(),
      };
      this.cached = next;
      this.writeLastKnownGood(next);
      return policy;
    } catch (error) {
      if (local) {
        this.cached = local;
        return local.policy;
      }
      throw new Error(
        `No valid Cloud policy or last-known-good policy is available: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  getHash(): string {
    if (!this.cached) throw new Error('Policy not loaded');
    return this.cached.policyHash;
  }

  onChange(callback: () => void): void {
    this.callback = callback;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(async () => {
      const before = this.cached?.policyHash;
      try {
        await this.load();
        if (before && this.cached?.policyHash !== before) this.callback?.();
      } catch {
        // Keep serving last-known-good.
      }
    }, 60_000);
    this.refreshTimer.unref();
  }

  private readLastKnownGood(): CachedPolicy | null {
    if (!existsSync(config.cloudPolicyCachePath)) return null;
    try {
      const cached = JSON.parse(readFileSync(config.cloudPolicyCachePath, 'utf-8')) as CachedPolicy;
      const policy = validateCloudPolicy(cached.policy);
      const calculated = `sha256:${computeHash(canonicalize(policy))}`;
      if (calculated !== cached.policyHash) return null;
      return { ...cached, policy };
    } catch {
      return null;
    }
  }

  private writeLastKnownGood(cached: CachedPolicy): void {
    mkdirSync(dirname(config.cloudPolicyCachePath), { recursive: true, mode: 0o700 });
    writeFileSync(config.cloudPolicyCachePath, JSON.stringify(cached, null, 2), { mode: 0o600 });
    chmodSync(config.cloudPolicyCachePath, 0o600);
  }
}

export function validateCloudPolicy(input: unknown): Policy {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Policy must be an object');
  }
  const policy = input as Policy;
  if (!policy.tools || typeof policy.tools !== 'object' || Array.isArray(policy.tools)) {
    throw new Error('Policy must contain a tools object');
  }
  for (const [tool, rule] of Object.entries(policy.tools)) {
    if (!rule || !['allow', 'approve', 'deny'].includes(rule.decision)) {
      throw new Error(`Invalid decision for ${tool}`);
    }
    if (rule.cost_usd !== undefined && (!Number.isFinite(rule.cost_usd) || rule.cost_usd < 0)) {
      throw new Error(`Invalid cost_usd for ${tool}`);
    }
  }
  for (const budget of policy.budgets ?? []) {
    if (!budget.name || !budget.match || (!budget.match.actor_name && !budget.match.actor_role)) {
      throw new Error('Every budget requires a name and actor matcher');
    }
    if (!Number.isFinite(budget.max_usd) || budget.max_usd < 0) {
      throw new Error(`Invalid budget ${budget.name}`);
    }
  }
  return JSON.parse(JSON.stringify(policy)) as Policy;
}
