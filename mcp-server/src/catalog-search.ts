interface CatalogSearchTool {
  name: string;
  group: string;
  description?: string;
}

interface CatalogSearchCategory {
  key: string;
  summary: string;
  aliases: string[];
  searchAliases?: string[];
}

interface CatalogSearchEntry {
  name: string;
  group: string;
  title: string;
}

export interface CatalogToolAvailability {
  in_default_surface: boolean;
  load: string | null;
}

interface CatalogSearchArgs {
  query: string;
  tools: CatalogSearchTool[];
  categories: CatalogSearchCategory[];
  availableToolNames: Set<string>;
  aliases: Readonly<Record<string, string>>;
  titles?: Record<string, string>;
}

interface CatalogSearchResult {
  matches: CatalogSearchEntry[];
  unavailable: { requested: string; canonical: string } | null;
}

const SEARCH_STOP_WORDS = new Set([
  'a', 'an', 'and', 'for', 'in', 'not', 'of', 'on', 'or', 'real', 'the', 'to',
  'tool', 'tools', 'with',
]);

/** Describe how a catalog match becomes visible in tools/list. */
export function catalogToolAvailability(
  entry: CatalogSearchEntry,
  defaultToolNames: Set<string>,
): CatalogToolAvailability {
  const inDefaultSurface = defaultToolNames.has(entry.name);
  return {
    in_default_surface: inDefaultSurface,
    load: inDefaultSurface ? null : entry.group,
  };
}

/**
 * Search the caller-visible catalog without manufacturing relevance.
 * Exact canonical names and living aliases short-circuit fuzzy scoring.
 */
export function searchCatalogEntries({
  query,
  tools,
  categories,
  availableToolNames,
  aliases,
  titles = {},
}: CatalogSearchArgs): CatalogSearchResult {
  const q = String(query).toLowerCase().trim();
  const canonical = aliases[q] ?? q;
  const exact = tools.find((tool) => tool.name.toLowerCase() === canonical);
  const entryFor = (tool: CatalogSearchTool): CatalogSearchEntry => {
    return {
      name: tool.name,
      group: tool.group,
      title: titles[tool.name] ?? tool.name,
    };
  };

  if (exact) {
    if (!availableToolNames.has(exact.name)) {
      return { matches: [], unavailable: { requested: q, canonical: exact.name } };
    }
    return { matches: [entryFor(exact)], unavailable: null };
  }

  const tokens = q
    .split(/[^a-z0-9]+/)
    .filter((token) => token && !SEARCH_STOP_WORDS.has(token));
  if (tokens.length === 0) return { matches: [], unavailable: null };

  const matches = tools
    .filter((tool) => availableToolNames.has(tool.name))
    .map((tool) => {
      const name = tool.name.toLowerCase();
      const category = categories.find((candidate) => candidate.key === tool.group);
      const description = (tool.description ?? '').toLowerCase();
      const categoryAliases = [
        ...(category?.aliases ?? []),
        ...(category?.searchAliases ?? []),
      ];
      const aliasHaystack = categoryAliases.join(' ').toLowerCase();
      let score = 0;
      for (const token of tokens) {
        if (name === token) score += 50;
        else if (name.includes(token)) score += 20;
        if (category?.key === token || categoryAliases.includes(token)) score += 12;
        if ((category?.summary ?? '').toLowerCase().includes(token)) score += 4;
        if (aliasHaystack.includes(token)) score += 4;
        if (description.includes(token)) score += 3;
      }
      return { ...entryFor(tool), score };
    })
    .filter((entry) => entry.score >= 12)
    .sort((a, b) => b.score - a.score)
    .slice(0, 25)
    .map(({ name, group, title }) => ({ name, group, title }));

  return { matches, unavailable: null };
}
