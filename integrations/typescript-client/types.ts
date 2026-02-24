/**
 * Runestone Gatekeeper TypeScript Client - Type Definitions
 */

export interface GatekeeperConfig {
  /** Base URL of the Gatekeeper server */
  baseUrl: string;
  /** Name of the agent making requests (used in audit logs) */
  agentName?: string;
  /** Role used for policy enforcement (required unless GATEKEEPER_ROLE is set) */
  agentRole?: string;
  /** Optional run ID for correlation */
  runId?: string;
}

export interface Actor {
  type: 'agent' | 'user';
  name: string;
  role: string;
  runId?: string;
}

export interface RequestContext {
  conversationId?: string;
  traceId?: string;
}

export type Decision = 'allow' | 'approve' | 'deny';

export type Origin = 'user_direct' | 'model_inferred' | 'external_content' | 'background_job';

export interface ContextRef {
  type: 'message' | 'url' | 'document' | 'memory_entity';
  id: string;
  taint?: string[];
}

export interface ExecutionReceipt {
  startedAt: string;
  completedAt: string;
  durationMs: number;
  resourcesUsed?: Record<string, unknown>;
}

export interface ApprovalRequestDetails {
  approvalId: string;
  expiresAt: string;
  reasonCode: string;
  humanExplanation: string;
  remediation?: string;
  approveUrl?: string;
  denyUrl?: string;
}

export interface DenialDetails {
  reasonCode: string;
  humanExplanation: string;
  remediation?: string;
}

export interface GatekeeperResult<T = unknown> {
  decision: Decision;
  requestId: string;
  reasonCode?: string;
  humanExplanation?: string;
  remediation?: string;
  policyVersion?: string;
  idempotencyKey?: string;
  /** Present when decision is 'allow' */
  result?: T;
  success?: boolean;
  executionReceipt?: ExecutionReceipt;
  /** Present when decision is 'approve' */
  approvalId?: string;
  expiresAt?: string;
  approvalRequest?: ApprovalRequestDetails;
  /** Present when decision is 'deny' */
  error?: string;
  denial?: DenialDetails;
}

// Tool-specific argument types

export interface ShellExecArgs {
  command: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface ShellExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  killed: boolean;
  truncated: boolean;
  command?: string;
}

export interface FilesWriteArgs {
  path: string;
  content: string;
  encoding?: 'utf8' | 'base64';
}

export interface FilesWriteResult {
  path: string;
  bytesWritten: number;
}

export interface HttpRequestArgs {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
  headers?: Record<string, string>;
  body?: string;
}

export interface HttpRequestResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
}

// ── Memory / Knowledge Graph types ──────────────────────────────────
// These mirror the Drizzle schema in src/db/schema/memory.ts.
// Field names use snake_case to match PostgreSQL column names returned
// by the API (raw SQL results). This is the single source of truth
// for consumers of the gatekeeper API.

/** A knowledge graph entity (person, project, concept, etc.) */
export interface MemoryEntity {
  id: string;
  type: string;
  name: string;
  description?: string | null;
  attributes?: Record<string, unknown>;
  confidence?: number;
  provenance?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

/** An episode (event, decision, observation) in the knowledge graph */
export interface MemoryEpisode {
  id: string;
  type: string;
  summary: string;
  details?: Record<string, unknown>;
  importance?: number;
  provenance?: string | null;
  occurred_at?: string | null;
  created_at?: string | null;
  /** Entity IDs linked to this episode (present in some API responses) */
  entityIds?: string[];
}

/** A piece of evidence supporting an entity or episode */
export interface MemoryEvidence {
  id: string;
  type: string;
  reference: string;
  snippet?: string | null;
  captured_at?: string | null;
  taint?: string[];
  relevance?: number;
  /** Entity this evidence is linked to (from evidence_links join) */
  entity_id?: string | null;
  /** Episode this evidence is linked to (from evidence_links join) */
  episode_id?: string | null;
}

/** Result from memory.upsert */
export interface MemoryUpsertResult {
  action: 'created' | 'updated';
  entity: MemoryEntity;
}

/** Result from memory.episode */
export interface MemoryEpisodeResult {
  episode: MemoryEpisode;
  linkedEntities: number;
}

/** Result from memory.evidence */
export interface MemoryEvidenceResult {
  evidence: MemoryEvidence;
  linkedEntities: number;
  linkedEpisodes: number;
}

/** Result from memory.query (varies by query type) */
export interface MemoryQueryResult {
  type: 'entity' | 'entities' | 'evidence' | 'cypher' | 'neighborhood' | 'episodes' | 'search';
  data: MemoryEntity | MemoryEntity[] | MemoryEpisode[] | MemoryEvidence[] | unknown[];
}

/** Result from memory.link */
export interface MemoryLinkResult {
  relation: string;
  sourceId: string;
  targetId: string;
  bidirectional: boolean;
}
