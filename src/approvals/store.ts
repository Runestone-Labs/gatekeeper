import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { PendingApproval, Actor, RequestContext } from '../types.js';
import { generateId, canonicalize, computeHmac } from '../utils.js';

// In-memory cache of pending approvals
const approvalCache = new Map<string, PendingApproval>();

/**
 * Create a new pending approval.
 * Returns the approval ID and signed URLs.
 */
export function createApproval(params: {
  toolName: string;
  args: Record<string, unknown>;
  actor: Actor;
  context?: RequestContext;
  requestId: string;
}): { approval: PendingApproval; approveUrl: string; denyUrl: string } {
  const id = generateId();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.approvalExpiryMs);

  const canonicalArgs = canonicalize(params.args);

  const approval: PendingApproval = {
    id,
    status: 'pending',
    toolName: params.toolName,
    args: params.args,
    canonicalArgs,
    actor: params.actor,
    context: params.context,
    requestId: params.requestId,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };

  // Store in memory and on disk
  approvalCache.set(id, approval);
  saveApprovalToDisk(approval);

  // Generate signed URLs
  const approveUrl = generateSignedUrl(approval, 'approve');
  const denyUrl = generateSignedUrl(approval, 'deny');

  return { approval, approveUrl, denyUrl };
}

/**
 * Generate a signed URL for an approval action.
 * SECURITY: Signs the full payload to prevent parameter tampering.
 */
function generateSignedUrl(approval: PendingApproval, action: 'approve' | 'deny'): string {
  const payload = [
    approval.toolName,
    approval.canonicalArgs,
    approval.requestId,
    approval.expiresAt,
    action,
  ].join(':');

  const signature = computeHmac(payload, config.secret);

  return `${config.baseUrl}/${action}/${approval.id}?sig=${signature}&exp=${encodeURIComponent(approval.expiresAt)}`;
}

/**
 * Verify a signed URL and return the approval if valid.
 * SECURITY: Single-use enforcement - returns null if already consumed.
 */
export function verifyAndConsumeApproval(
  id: string,
  action: 'approve' | 'deny',
  signature: string,
  expiry: string
): { approval: PendingApproval | null; error?: string } {
  // Load approval
  const approval = loadApproval(id);

  if (!approval) {
    return { approval: null, error: 'Approval not found' };
  }

  // Check expiration
  if (new Date(approval.expiresAt) < new Date()) {
    approval.status = 'expired';
    saveApprovalToDisk(approval);
    return { approval: null, error: 'Approval has expired' };
  }

  // SECURITY: Check status - must be pending (single-use enforcement)
  if (approval.status !== 'pending') {
    return { approval: null, error: `Approval already ${approval.status}` };
  }

  // Verify signature
  const expectedPayload = [
    approval.toolName,
    approval.canonicalArgs,
    approval.requestId,
    approval.expiresAt,
    action,
  ].join(':');

  const expectedSignature = computeHmac(expectedPayload, config.secret);

  if (signature !== expectedSignature) {
    return { approval: null, error: 'Invalid signature' };
  }

  // Check expiry matches
  if (expiry !== approval.expiresAt) {
    return { approval: null, error: 'Expiry mismatch' };
  }

  // SECURITY: Atomically update status to prevent race conditions
  approval.status = action === 'approve' ? 'approved' : 'denied';
  approvalCache.set(id, approval);
  saveApprovalToDisk(approval);

  return { approval };
}

/**
 * Load an approval from cache or disk.
 */
function loadApproval(id: string): PendingApproval | null {
  // Check cache first
  if (approvalCache.has(id)) {
    return approvalCache.get(id)!;
  }

  // Load from disk
  const filePath = getApprovalPath(id);
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const approval = JSON.parse(content) as PendingApproval;
    approvalCache.set(id, approval);
    return approval;
  } catch {
    return null;
  }
}

/**
 * Save an approval to disk.
 */
function saveApprovalToDisk(approval: PendingApproval): void {
  ensureApprovalsDir();
  const filePath = getApprovalPath(approval.id);
  writeFileSync(filePath, JSON.stringify(approval, null, 2), 'utf-8');
}

/**
 * Get the file path for an approval.
 */
function getApprovalPath(id: string): string {
  return join(config.approvalsDir, `${id}.json`);
}

/**
 * Ensure the approvals directory exists.
 */
function ensureApprovalsDir(): void {
  if (!existsSync(config.approvalsDir)) {
    mkdirSync(config.approvalsDir, { recursive: true });
  }
}

/**
 * Count pending approvals (for health check).
 */
export function countPendingApprovals(): number {
  ensureApprovalsDir();

  let count = 0;
  const files = readdirSync(config.approvalsDir);

  for (const file of files) {
    if (!file.endsWith('.json')) continue;

    const id = file.replace('.json', '');
    const approval = loadApproval(id);

    if (approval && approval.status === 'pending') {
      count++;
    }
  }

  return count;
}

/**
 * Clean up expired approvals.
 */
export function cleanupExpiredApprovals(): void {
  ensureApprovalsDir();

  const files = readdirSync(config.approvalsDir);
  const now = new Date();

  for (const file of files) {
    if (!file.endsWith('.json')) continue;

    const id = file.replace('.json', '');
    const approval = loadApproval(id);

    if (approval && new Date(approval.expiresAt) < now) {
      approval.status = 'expired';
      saveApprovalToDisk(approval);
    }
  }
}
