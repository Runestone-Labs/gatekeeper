import { z } from 'zod';

const scalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const cloudReviewSummarySchema = z
  .object({
    kind: z.enum(['shell', 'file', 'http', 'custom']),
    executable: z.string().max(256).optional(),
    arguments: z.array(z.string().max(256)).max(24).optional(),
    cwd: z.string().max(512).optional(),
    path: z.string().max(512).optional(),
    byteCount: z.number().int().nonnegative().optional(),
    contentHash: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
    method: z.string().max(16).optional(),
    origin: z.string().max(512).optional(),
    fields: z.record(scalarSchema).optional(),
  })
  .strict();

export const cloudApprovalV1Schema = z
  .object({
    schemaVersion: z.literal('cloud-approval.v1'),
    approvalId: z.string().uuid(),
    instanceId: z.string().min(1).max(128),
    requestId: z.string().min(1).max(256),
    actor: z
      .object({
        type: z.enum(['agent', 'user']),
        name: z.string().min(1).max(128),
        role: z.string().min(1).max(128),
        runId: z.string().max(256).optional(),
      })
      .strict(),
    tool: z.string().min(1).max(256),
    status: z.literal('pending'),
    reasonCode: z.string().max(128).optional(),
    riskCategory: z.string().max(128).optional(),
    policyHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    actionDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    summary: cloudReviewSummarySchema,
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();

export const cloudDecisionV1Schema = z
  .object({
    schemaVersion: z.literal('cloud-decision.v1'),
    decisionId: z.string().uuid(),
    approvalId: z.string().uuid(),
    instanceId: z.string().min(1).max(128),
    actionDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    status: z.enum(['approved', 'denied']),
    decidedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    approver: z
      .object({
        id: z.string().min(1).max(256),
        displayName: z.string().max(256).optional(),
      })
      .strict(),
  })
  .strict();

export const cloudEventV1Schema = z
  .object({
    schemaVersion: z.literal('cloud-event.v1'),
    eventId: z.string().uuid(),
    instanceId: z.string().min(1).max(128),
    requestId: z.string().min(1).max(256),
    runId: z.string().max(256).optional(),
    actorName: z.string().min(1).max(128),
    actorRole: z.string().min(1).max(128),
    tool: z.string().min(1).max(256),
    decision: z.string().min(1).max(64),
    reasonCode: z.string().max(128).optional(),
    riskCategories: z.array(z.string().max(128)).max(32),
    policyHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    actionDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
    occurredAt: z.string().datetime(),
    durationMs: z.number().int().nonnegative().optional(),
    costUsd: z.number().nonnegative().nullable().optional(),
    tokenCount: z.number().int().nonnegative().optional(),
    approvalId: z.string().uuid().optional(),
    approvalStatus: z.string().max(64).optional(),
    sequence: z.number().int().positive().optional(),
    previousEntryHash: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .nullable()
      .optional(),
    entryHash: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
    localSequence: z.number().int().positive().optional(),
    localPreviousEntryHash: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .nullable()
      .optional(),
    localEntryHash: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();

export type CloudReviewSummary = z.infer<typeof cloudReviewSummarySchema>;
export type CloudApprovalV1 = z.infer<typeof cloudApprovalV1Schema>;
export type CloudDecisionV1 = z.infer<typeof cloudDecisionV1Schema>;
export type CloudEventV1 = z.infer<typeof cloudEventV1Schema>;
