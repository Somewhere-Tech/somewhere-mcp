export const ADVISOR_DEFAULT_MODEL = 'gpt-5.6-terra';
export const ADVISOR_RESPONSE_BUDGET_MS = 25_000;
export const ADVISOR_MAX_OUTPUT_TOKENS = 2_000;

// Official model and prompt-caching pages, verified 2026-09-07.
// Dollars per million tokens: ordinary input, cache read, cache write, output.
// https://developers.openai.com/api/docs/models/gpt-5.6-terra
// https://developers.openai.com/api/docs/guides/prompt-caching
// The two prior profiles remain explicit rollback choices, never retries.
const RATES: Readonly<Record<string, readonly [number, number, number, number]>> = {
  'gpt-5.6-terra': [2, 0.20, 2.50, 12],
  'gpt-5.6-sol': [4, 0.40, 5, 20],
  'gpt-5.6-luna': [0.20, 0.02, 0.25, 1.20],
};

export function advisorModel(configured?: string): string {
  return configured?.trim() || ADVISOR_DEFAULT_MODEL;
}

export function advisorModelSupported(model: string): boolean {
  return Object.hasOwn(RATES, model);
}

/** Token estimate, not an invoice. Unknown models must never use Luna rates. */
export function advisorTokenCostCents(model: string, input: number, cached: number, cacheWrite: number, output: number, tier: 'default' | 'flex'): number | null {
  const rates = Object.hasOwn(RATES, model) ? RATES[model] : undefined;
  if (!rates || (tier !== 'default' && tier !== 'flex')) return null;
  if (![input, cached, cacheWrite, output].every((value) => Number.isSafeInteger(value) && value >= 0)) return null;
  if (cached + cacheWrite > input) return null;
  const [inputRate, cachedRate, cacheWriteRate, outputRate] = rates;
  const longContext = input > 272_000;
  return (((input - cached - cacheWrite) * inputRate + cached * cachedRate + cacheWrite * cacheWriteRate) * (longContext ? 2 : 1)
    + output * outputRate * (longContext ? 1.5 : 1)) / 10_000 * (tier === 'flex' ? 0.5 : 1);
}
