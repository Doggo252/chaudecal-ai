// Token estimation. Every provider tokenizes a little differently and none of the
// subscription CLIs expose a tokenizer, so the app uses one conservative estimate
// everywhere. It slightly overestimates, which is the safe direction for budgets.

const CHARS_PER_TOKEN = 3.6

export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

export function tokensToChars(tokens: number): number {
  return Math.floor(tokens * CHARS_PER_TOKEN)
}

export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 10_000) return `${Math.round(tokens / 1000)}k`
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`
  return String(tokens)
}

/** Cut text to a token budget, keeping the end (the most recent part). */
export function keepTail(text: string, budgetTokens: number): string {
  const max = tokensToChars(budgetTokens)
  if (text.length <= max) return text
  return text.slice(text.length - max)
}

/** Cut text to a token budget, keeping the start. */
export function keepHead(text: string, budgetTokens: number): string {
  const max = tokensToChars(budgetTokens)
  if (text.length <= max) return text
  return text.slice(0, max)
}
