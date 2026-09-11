export const LONG_CONTEXT_THRESHOLD = 272_000;

export const PRICE_BOOK = {
  'gpt-6-astra': { input: 10, cached: 1, output: 50 },
  'gpt-5.6-sol': { input: 4, cached: 0.4, output: 20 },
  'gpt-5.6-terra': { input: 2, cached: 0.2, output: 12 },
  'gpt-5.6-luna': { input: 0.2, cached: 0.02, output: 1.2 }
};

export function estimateCost(usage, model) {
  const rate = PRICE_BOOK[model];
  if (!rate) return { input: null, cached: null, output: null, total: null, priceVersion: null };
  const longContext = usage.inputTokens > LONG_CONTEXT_THRESHOLD;
  const multiplier = longContext ? { input: 2, output: 1.5 } : { input: 1, output: 1 };
  const input = Math.max(0, usage.inputTokens - usage.cachedInputTokens) * rate.input * multiplier.input / 1_000_000;
  const cached = usage.cachedInputTokens * rate.cached * multiplier.input / 1_000_000;
  const output = usage.outputTokens * rate.output * multiplier.output / 1_000_000;
  return { input, cached, output, total: input + cached + output, priceVersion: '2026-09-standard' };
}
