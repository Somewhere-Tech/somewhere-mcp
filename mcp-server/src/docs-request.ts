const BULK_DOCS_ALIASES = new Set(['*', 'all', 'dump', 'everything', 'full']);

/**
 * Tool results are a poor transport for the complete documentation corpus:
 * clients may cap them without preserving a continuation cursor. Intercept
 * bulk-looking topic names before fuzzy matching can silently turn `all` into
 * the unrelated `calls` topic, and route the caller to bounded topic reads.
 */
export function bulkDocsGuidance(topic: string, topics: readonly string[]): string | null {
  const normalized = topic.trim().toLowerCase();
  if (!BULK_DOCS_ALIASES.has(normalized)) return null;
  return `Bulk documentation is not returned in one tool result because clients may truncate it. Fetch one topic at a time with docs({ topic }). Available topics: ${topics.join(', ')}. For the complete streaming corpus outside a tool result, read https://somewhere.tech/docs.txt. The initialized-project agent contract is https://somewhere.tech/agent.txt.`;
}
