/**
 * Model pricing lookup for LLM cost accounting.
 *
 * Providers do NOT return cost in their API response metadata — only token
 * counts. Cost is computed by multiplying tokens × rate. We keep a small static
 * table as a fallback and optionally refresh against LiteLLM's community-maintained
 * pricing JSON on a daily cadence, so rate changes are picked up without a deploy.
 *
 * This is the seam that turns gatekeeper's USD budgets from a NOMINAL flat
 * `cost_usd` per call into REAL per-token spend for proxied model calls. Unknown
 * models return `null` cost (rather than throwing) so the audit trail keeps
 * recording token counts even before pricing is in the table.
 *
 * Ported from runestone-assistants `shared/pricing.ts`; kept self-contained here
 * because gatekeeper is a separate published package and cannot import from it.
 */

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { config } from '../config.js';

export interface ModelPricing {
  /** Model identifier as it appears in API requests (e.g. 'claude-opus-4-8'). */
  model: string;
  /** Cost per 1M input tokens, USD. */
  inputUsdPer1M: number;
  /** Cost per 1M output tokens, USD. */
  outputUsdPer1M: number;
  /** Cost per 1M cache read tokens, USD (Anthropic only; defaults to input rate). */
  cacheReadUsdPer1M?: number;
  /** Cost per 1M cache creation tokens, USD (Anthropic only; 5-min TTL tier). */
  cacheCreationUsdPer1M?: number;
}

/**
 * Static price table — the fallback when live pricing hasn't been fetched.
 * Rates reflect public pricing as of 2026-06. A missing entry means "unknown
 * cost" — priceCall returns nulls but still lets the caller record token counts.
 */
export const STATIC_PRICING: Record<string, ModelPricing> = {
  // Anthropic Claude 4.x family
  'claude-opus-4-8': {
    model: 'claude-opus-4-8',
    inputUsdPer1M: 5,
    outputUsdPer1M: 25,
    cacheReadUsdPer1M: 0.5,
    cacheCreationUsdPer1M: 6.25,
  },
  'claude-opus-4-7': {
    model: 'claude-opus-4-7',
    inputUsdPer1M: 15,
    outputUsdPer1M: 75,
    cacheReadUsdPer1M: 1.5,
    cacheCreationUsdPer1M: 18.75,
  },
  'claude-opus-4-6': {
    model: 'claude-opus-4-6',
    inputUsdPer1M: 15,
    outputUsdPer1M: 75,
    cacheReadUsdPer1M: 1.5,
    cacheCreationUsdPer1M: 18.75,
  },
  'claude-sonnet-4-6': {
    model: 'claude-sonnet-4-6',
    inputUsdPer1M: 3,
    outputUsdPer1M: 15,
    cacheReadUsdPer1M: 0.3,
    cacheCreationUsdPer1M: 3.75,
  },
  'claude-haiku-4-5': {
    model: 'claude-haiku-4-5',
    inputUsdPer1M: 1,
    outputUsdPer1M: 5,
    cacheReadUsdPer1M: 0.1,
    cacheCreationUsdPer1M: 1.25,
  },
  // OpenAI GPT-4 family
  'gpt-4o': { model: 'gpt-4o', inputUsdPer1M: 2.5, outputUsdPer1M: 10 },
  'gpt-4o-mini': { model: 'gpt-4o-mini', inputUsdPer1M: 0.15, outputUsdPer1M: 0.6 },
  'gpt-4.1': { model: 'gpt-4.1', inputUsdPer1M: 3, outputUsdPer1M: 12 },
};

/**
 * Active price table. Mutable at runtime: when `refreshLivePricing()` succeeds,
 * entries from the LiteLLM JSON are merged on top of the static defaults so rate
 * changes are picked up within a day without a code deploy.
 */
export const PRICING: Record<string, ModelPricing> = { ...STATIC_PRICING };

export interface CallUsage {
  inputTokens: number;
  outputTokens: number;
  /** Anthropic only. Tokens read from the prompt cache. */
  cacheReadTokens?: number;
  /** Anthropic only. Tokens written to the prompt cache. */
  cacheCreationTokens?: number;
}

export interface PricedCall {
  model: string;
  /** Total USD cost; null if model is not in the pricing table. */
  costUsd: number | null;
  /** Per-component cost breakdown; all null if model unknown. */
  breakdown: {
    inputUsd: number | null;
    outputUsd: number | null;
    cacheReadUsd: number | null;
    cacheCreationUsd: number | null;
  };
}

/**
 * Normalize variants of the same model name (e.g. "claude-opus-4-8[1m]",
 * "claude-opus-4-8-20260528", "anthropic/claude-opus-4-8") to the base
 * identifier used in the PRICING table.
 */
export function normalizeModel(raw: string): string {
  let m = raw.trim().toLowerCase();
  // Strip provider prefix (anthropic/, openai:, azure/...)
  m = m.replace(/^(anthropic|openai|azure)[/:]/, '');
  // Strip date suffix like -20260101
  m = m.replace(/-\d{8}$/, '');
  // Strip feature-flag suffix like [1m]
  m = m.replace(/\[.*?\]$/, '');
  return m;
}

/**
 * Compute the USD cost of a single LLM call. Returns null cost for unknown
 * models; token counts should still be recorded so pricing can be backfilled.
 */
export function priceCall(modelRaw: string, usage: CallUsage): PricedCall {
  const model = normalizeModel(modelRaw);
  const rates = PRICING[model];

  if (!rates) {
    return {
      model,
      costUsd: null,
      breakdown: { inputUsd: null, outputUsd: null, cacheReadUsd: null, cacheCreationUsd: null },
    };
  }

  const inputUsd = (usage.inputTokens / 1_000_000) * rates.inputUsdPer1M;
  const outputUsd = (usage.outputTokens / 1_000_000) * rates.outputUsdPer1M;

  const cacheReadRate = rates.cacheReadUsdPer1M ?? rates.inputUsdPer1M;
  const cacheReadUsd = usage.cacheReadTokens
    ? (usage.cacheReadTokens / 1_000_000) * cacheReadRate
    : 0;

  const cacheCreationRate = rates.cacheCreationUsdPer1M ?? rates.inputUsdPer1M;
  const cacheCreationUsd = usage.cacheCreationTokens
    ? (usage.cacheCreationTokens / 1_000_000) * cacheCreationRate
    : 0;

  return {
    model,
    costUsd: inputUsd + outputUsd + cacheReadUsd + cacheCreationUsd,
    breakdown: {
      inputUsd,
      outputUsd,
      cacheReadUsd: usage.cacheReadTokens ? cacheReadUsd : null,
      cacheCreationUsd: usage.cacheCreationTokens ? cacheCreationUsd : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Live pricing refresh
// ---------------------------------------------------------------------------

/**
 * LiteLLM's community-maintained pricing JSON. Updated within days of provider
 * rate changes. Shape: `{ [modelName]: { input_cost_per_token, ... } }`. Costs
 * are per-token (not per-1M), so we scale by 1e6 when importing.
 */
const LITELLM_PRICING_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window_backup.json';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Disk cache lives under the gatekeeper data dir, alongside audit/approvals. */
function defaultCachePath(): string {
  return join(config.dataDir, 'llm-pricing.json');
}

interface LiteLLMRow {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
}

type LiteLLMTable = Record<string, LiteLLMRow>;

interface CachedPricing {
  fetchedAt: string;
  source: string;
  pricing: Record<string, ModelPricing>;
}

/** Convert LiteLLM's per-token rates to our per-1M representation. */
function mapLiteLLMRow(model: string, row: LiteLLMRow): ModelPricing | null {
  if (row.input_cost_per_token == null || row.output_cost_per_token == null) return null;
  const entry: ModelPricing = {
    model,
    inputUsdPer1M: row.input_cost_per_token * 1_000_000,
    outputUsdPer1M: row.output_cost_per_token * 1_000_000,
  };
  if (row.cache_read_input_token_cost != null) {
    entry.cacheReadUsdPer1M = row.cache_read_input_token_cost * 1_000_000;
  }
  if (row.cache_creation_input_token_cost != null) {
    entry.cacheCreationUsdPer1M = row.cache_creation_input_token_cost * 1_000_000;
  }
  return entry;
}

/** Write JSON to a path atomically (temp file + rename) so readers never see a partial file. */
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf-8');
  await rename(tmp, path);
}

/**
 * Fetch LiteLLM's pricing table and merge recognizable rows onto the active
 * PRICING map. Safe to call on startup and on a daily interval. Falls back
 * silently to the static table on network errors.
 */
export async function refreshLivePricing(
  options: { cachePath?: string; fetchImpl?: typeof fetch; ttlMs?: number } = {}
): Promise<{ updated: number; source: 'cache' | 'network' | 'static' }> {
  const cachePath = options.cachePath ?? defaultCachePath();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const ttlMs = options.ttlMs ?? CACHE_TTL_MS;

  // Try the disk cache first to avoid a network round-trip every startup.
  try {
    const raw = await readFile(cachePath, 'utf-8');
    const cached = JSON.parse(raw) as CachedPricing;
    const age = Date.now() - new Date(cached.fetchedAt).getTime();
    if (age < ttlMs) {
      mergeIntoActivePricing(cached.pricing);
      return { updated: Object.keys(cached.pricing).length, source: 'cache' };
    }
  } catch {
    /* no cache or stale — fall through to network */
  }

  try {
    const res = await fetchImpl(LITELLM_PRICING_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const table = (await res.json()) as LiteLLMTable;

    const mapped: Record<string, ModelPricing> = {};
    for (const [rawModel, row] of Object.entries(table)) {
      const model = normalizeModel(rawModel);
      const entry = mapLiteLLMRow(model, row);
      if (entry) mapped[model] = entry;
    }

    mergeIntoActivePricing(mapped);

    // Persist cache (best effort).
    try {
      await writeJsonAtomic(cachePath, {
        fetchedAt: new Date().toISOString(),
        source: LITELLM_PRICING_URL,
        pricing: mapped,
      } satisfies CachedPricing);
    } catch {
      /* cache write is best-effort */
    }

    return { updated: Object.keys(mapped).length, source: 'network' };
  } catch {
    return { updated: 0, source: 'static' };
  }
}

function mergeIntoActivePricing(incoming: Record<string, ModelPricing>): void {
  for (const [model, entry] of Object.entries(incoming)) {
    PRICING[model] = entry;
  }
}
