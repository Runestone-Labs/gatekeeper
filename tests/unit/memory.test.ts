import { describe, it, expect } from 'vitest';
import {
  MemoryQueryArgsSchema,
  MemoryUpsertArgsSchema,
  MemoryLinkArgsSchema,
  MemoryEpisodeArgsSchema,
} from '../../src/tools/memory/schemas.js';

describe('Memory Tool Schemas', () => {
  describe('MemoryQueryArgsSchema', () => {
    it('should accept cypher query', () => {
      const result = MemoryQueryArgsSchema.safeParse({
        cypher: 'MATCH (n) RETURN n LIMIT 10',
      });
      expect(result.success).toBe(true);
    });

    it('should accept entity lookup by ID', () => {
      const result = MemoryQueryArgsSchema.safeParse({
        entityId: '550e8400-e29b-41d4-a716-446655440000',
      });
      expect(result.success).toBe(true);
    });

    it('should accept entity lookup by name', () => {
      const result = MemoryQueryArgsSchema.safeParse({
        entityName: 'Gatekeeper',
      });
      expect(result.success).toBe(true);
    });

    it('should accept entity lookup by type', () => {
      const result = MemoryQueryArgsSchema.safeParse({
        entityType: 'project',
      });
      expect(result.success).toBe(true);
    });

    it('should reject invalid entity type', () => {
      const result = MemoryQueryArgsSchema.safeParse({
        entityType: 'invalid_type',
      });
      expect(result.success).toBe(false);
    });

    it('should accept neighborhood query', () => {
      const result = MemoryQueryArgsSchema.safeParse({
        fromEntity: '550e8400-e29b-41d4-a716-446655440000',
        maxHops: 3,
        relationTypes: ['WORKS_AT', 'KNOWS'],
      });
      expect(result.success).toBe(true);
    });

    it('should reject maxHops > 5', () => {
      const result = MemoryQueryArgsSchema.safeParse({
        fromEntity: '550e8400-e29b-41d4-a716-446655440000',
        maxHops: 10,
      });
      expect(result.success).toBe(false);
    });

    it('should accept episode query', () => {
      const result = MemoryQueryArgsSchema.safeParse({
        episodeType: 'decision',
        minImportance: 0.5,
        since: '2024-01-01T00:00:00Z',
        limit: 50,
      });
      expect(result.success).toBe(true);
    });

    it('should accept attribute query', () => {
      const result = MemoryQueryArgsSchema.safeParse({
        attributeQuery: { status: 'active', priority: 'high' },
      });
      expect(result.success).toBe(true);
    });
  });

  describe('MemoryUpsertArgsSchema', () => {
    it('should accept new entity', () => {
      const result = MemoryUpsertArgsSchema.safeParse({
        type: 'project',
        name: 'Gatekeeper',
        description: 'Policy enforcement for AI agents',
        attributes: { status: 'active' },
        confidence: 0.9,
        provenance: 'user_input',
      });
      expect(result.success).toBe(true);
    });

    it('should accept entity update with ID', () => {
      const result = MemoryUpsertArgsSchema.safeParse({
        id: '550e8400-e29b-41d4-a716-446655440000',
        type: 'project',
        name: 'Gatekeeper Updated',
      });
      expect(result.success).toBe(true);
    });

    it('should require type and name', () => {
      const result = MemoryUpsertArgsSchema.safeParse({
        description: 'Missing required fields',
      });
      expect(result.success).toBe(false);
    });

    it('should validate entity type', () => {
      const result = MemoryUpsertArgsSchema.safeParse({
        type: 'invalid_type',
        name: 'Test',
      });
      expect(result.success).toBe(false);
    });

    it('should enforce name length limit', () => {
      const result = MemoryUpsertArgsSchema.safeParse({
        type: 'person',
        name: 'a'.repeat(256),
      });
      expect(result.success).toBe(false);
    });

    it('should validate confidence range', () => {
      const result1 = MemoryUpsertArgsSchema.safeParse({
        type: 'person',
        name: 'Test',
        confidence: 1.5,
      });
      expect(result1.success).toBe(false);

      const result2 = MemoryUpsertArgsSchema.safeParse({
        type: 'person',
        name: 'Test',
        confidence: -0.1,
      });
      expect(result2.success).toBe(false);
    });
  });

  describe('MemoryLinkArgsSchema', () => {
    it('should accept valid link', () => {
      const result = MemoryLinkArgsSchema.safeParse({
        sourceId: '550e8400-e29b-41d4-a716-446655440000',
        targetId: '550e8400-e29b-41d4-a716-446655440001',
        relation: 'works_at',
      });
      expect(result.success).toBe(true);
    });

    it('should accept link with all options', () => {
      const result = MemoryLinkArgsSchema.safeParse({
        sourceId: '550e8400-e29b-41d4-a716-446655440000',
        targetId: '550e8400-e29b-41d4-a716-446655440001',
        relation: 'works_at',
        attributes: { role: 'engineer' },
        validFrom: '2024-01-01T00:00:00Z',
        validUntil: '2024-12-31T23:59:59Z',
        bidirectional: true,
      });
      expect(result.success).toBe(true);
    });

    it('should require sourceId, targetId, and relation', () => {
      const result = MemoryLinkArgsSchema.safeParse({
        sourceId: '550e8400-e29b-41d4-a716-446655440000',
        relation: 'works_at',
      });
      expect(result.success).toBe(false);
    });

    it('should validate UUID format', () => {
      const result = MemoryLinkArgsSchema.safeParse({
        sourceId: 'not-a-uuid',
        targetId: '550e8400-e29b-41d4-a716-446655440001',
        relation: 'works_at',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('MemoryEpisodeArgsSchema', () => {
    it('should accept valid episode', () => {
      const result = MemoryEpisodeArgsSchema.safeParse({
        type: 'decision',
        summary: 'Approved budget for Q2 marketing campaign',
      });
      expect(result.success).toBe(true);
    });

    it('should accept episode with all options', () => {
      const result = MemoryEpisodeArgsSchema.safeParse({
        type: 'event',
        summary: 'Project kickoff meeting',
        details: { attendees: 5, duration: '2h' },
        importance: 0.8,
        occurredAt: '2024-01-15T10:00:00Z',
        provenance: 'calendar_integration',
        entityIds: [
          '550e8400-e29b-41d4-a716-446655440000',
          '550e8400-e29b-41d4-a716-446655440001',
        ],
        entityRoles: {
          '550e8400-e29b-41d4-a716-446655440000': 'organizer',
          '550e8400-e29b-41d4-a716-446655440001': 'participant',
        },
      });
      expect(result.success).toBe(true);
    });

    it('should require type and summary', () => {
      const result = MemoryEpisodeArgsSchema.safeParse({
        importance: 0.5,
      });
      expect(result.success).toBe(false);
    });

    it('should validate episode type', () => {
      const result = MemoryEpisodeArgsSchema.safeParse({
        type: 'invalid_type',
        summary: 'Test',
      });
      expect(result.success).toBe(false);
    });

    it('should validate importance range', () => {
      const result = MemoryEpisodeArgsSchema.safeParse({
        type: 'observation',
        summary: 'Test',
        importance: 1.5,
      });
      expect(result.success).toBe(false);
    });

    it('should validate summary length', () => {
      const result = MemoryEpisodeArgsSchema.safeParse({
        type: 'observation',
        summary: 'a'.repeat(1001),
      });
      expect(result.success).toBe(false);
    });
  });
});

describe('Memory Tools - No Database', () => {
  it('should handle missing database gracefully', async () => {
    const { executeMemoryQuery } = await import('../../src/tools/memory/query.js');
    const result = await executeMemoryQuery({ entityName: 'Test' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not available');
  });

  it('should handle missing database for upsert', async () => {
    const { executeMemoryUpsert } = await import('../../src/tools/memory/upsert.js');
    const result = await executeMemoryUpsert({
      type: 'project',
      name: 'Test',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not available');
  });

  it('should handle missing database for link', async () => {
    const { executeMemoryLink } = await import('../../src/tools/memory/link.js');
    const result = await executeMemoryLink({
      sourceId: '550e8400-e29b-41d4-a716-446655440000',
      targetId: '550e8400-e29b-41d4-a716-446655440001',
      relation: 'test',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not available');
  });

  it('should handle missing database for episode', async () => {
    const { executeMemoryEpisode } = await import('../../src/tools/memory/episode.js');
    const result = await executeMemoryEpisode({
      type: 'decision',
      summary: 'Test decision',
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not available');
  });
});
