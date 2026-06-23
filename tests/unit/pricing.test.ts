import { describe, it, expect, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm, readFile } from 'node:fs/promises';
import {
  normalizeModel,
  priceCall,
  refreshLivePricing,
  PRICING,
  STATIC_PRICING,
} from '../../src/pricing/index.js';

describe('pricing — normalizeModel', () => {
  it('strips provider prefix, date suffix, and feature-flag suffix', () => {
    expect(normalizeModel('claude-opus-4-8')).toBe('claude-opus-4-8');
    expect(normalizeModel('anthropic/claude-opus-4-8')).toBe('claude-opus-4-8');
    expect(normalizeModel('claude-opus-4-8-20260528')).toBe('claude-opus-4-8');
    expect(normalizeModel('claude-opus-4-8[1m]')).toBe('claude-opus-4-8');
    expect(normalizeModel('  Claude-Opus-4-8  ')).toBe('claude-opus-4-8');
    expect(normalizeModel('openai:gpt-4o')).toBe('gpt-4o');
  });
});

describe('pricing — priceCall', () => {
  it('computes cost for a known model including cache tiers', () => {
    // claude-opus-4-8: in 5, out 25, cacheRead 0.5, cacheCreate 6.25 (USD per 1M)
    const priced = priceCall('claude-opus-4-8', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
    });
    expect(priced.model).toBe('claude-opus-4-8');
    // 5 + 25 + 0.5 + 6.25 = 36.75
    expect(priced.costUsd).toBeCloseTo(36.75, 6);
    expect(priced.breakdown.inputUsd).toBeCloseTo(5, 6);
    expect(priced.breakdown.outputUsd).toBeCloseTo(25, 6);
    expect(priced.breakdown.cacheReadUsd).toBeCloseTo(0.5, 6);
    expect(priced.breakdown.cacheCreationUsd).toBeCloseTo(6.25, 6);
  });

  it('normalizes a dated/flagged model id before lookup', () => {
    const priced = priceCall('claude-opus-4-8[1m]', {
      inputTokens: 200_000,
      outputTokens: 50_000,
    });
    // 0.2 * 5 + 0.05 * 25 = 1.0 + 1.25 = 2.25
    expect(priced.costUsd).toBeCloseTo(2.25, 6);
    expect(priced.breakdown.cacheReadUsd).toBeNull(); // no cache tokens supplied
  });

  it('returns null cost for an unknown model but still echoes the normalized id', () => {
    const priced = priceCall('some-future-model-9', { inputTokens: 100, outputTokens: 100 });
    expect(priced.model).toBe('some-future-model-9');
    expect(priced.costUsd).toBeNull();
    expect(priced.breakdown.inputUsd).toBeNull();
  });
});

describe('pricing — refreshLivePricing', () => {
  it('merges LiteLLM rows (per-token → per-1M) onto the active table and caches', async () => {
    const cachePath = join(tmpdir(), `gk-pricing-${process.pid}-${Date.now()}.json`);
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          'anthropic/claude-future-1': {
            input_cost_per_token: 0.000004, // → 4 / 1M
            output_cost_per_token: 0.00002, // → 20 / 1M
            cache_read_input_token_cost: 0.0000004, // → 0.4 / 1M
          },
          'row-without-costs': { foo: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    ) as unknown as typeof fetch;

    try {
      const result = await refreshLivePricing({ cachePath, fetchImpl, ttlMs: 0 });
      expect(result.source).toBe('network');
      expect(result.updated).toBe(1); // the row without input/output costs is skipped

      const priced = priceCall('claude-future-1', {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      });
      expect(priced.costUsd).toBeCloseTo(24, 6); // 4 + 20

      // Cache file was written with the mapped (per-1M) rates.
      const cached = JSON.parse(await readFile(cachePath, 'utf-8'));
      expect(cached.pricing['claude-future-1'].inputUsdPer1M).toBeCloseTo(4, 6);
    } finally {
      await rm(cachePath, { force: true });
      delete PRICING['claude-future-1'];
    }
  });

  it('falls back to the static table on network error (no throw)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const result = await refreshLivePricing({
      cachePath: join(tmpdir(), `gk-pricing-missing-${process.pid}.json`),
      fetchImpl,
      ttlMs: 0,
    });
    expect(result.source).toBe('static');
    expect(result.updated).toBe(0);
    // Static entries remain intact.
    expect(PRICING['claude-opus-4-8']).toEqual(STATIC_PRICING['claude-opus-4-8']);
  });
});
