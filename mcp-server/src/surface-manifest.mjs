/**
 * MCP endpoint projections. Tool membership lives only on each canonical
 * ToolSpec; these endpoints filter that registry without owning another list.
 */
export const SURFACE_MANIFESTS = Object.freeze({
  chatgpt: Object.freeze({ endpoint: '/mcp/chatgpt' }),
  connector: Object.freeze({ endpoint: '/mcp/connector' }),
  full: Object.freeze({ endpoint: '/mcp' }),
});

export const SURFACE_NAMES = Object.freeze(Object.keys(SURFACE_MANIFESTS));

export function advertisedToolNames(surface, toolSpecs) {
  if (!SURFACE_MANIFESTS[surface]) throw new Error(`Unknown MCP surface: ${surface}`);
  return new Set(toolSpecs
    // A deprecated alias (spec.aliasOf) or hidden spec (spec.hidden) stays
    // CALLABLE but is not advertised — that is how a surface consolidates or
    // hides a feature without breaking existing callers.
    .filter((spec) => spec.visibility !== 'admin' && !spec.aliasOf && !spec.hidden && spec.surfaces.includes(surface))
    .map((spec) => spec.definition.name));
}

export function executableToolNames(surface, toolSpecs) {
  const names = advertisedToolNames(surface, toolSpecs);
  for (const spec of toolSpecs) {
    if ((spec.aliasOf || spec.hidden) && spec.visibility !== 'admin' && spec.surfaces.includes(surface)) {
      names.add(spec.definition.name);
    }
  }
  return names;
}

/** The deprecated aliases projected onto a surface: callable, unadvertised. */
export function aliasToolNames(surface, toolSpecs) {
  if (!SURFACE_MANIFESTS[surface]) throw new Error(`Unknown MCP surface: ${surface}`);
  return new Set(toolSpecs
    .filter((spec) => spec.aliasOf && spec.visibility !== 'admin' && spec.surfaces.includes(surface))
    .map((spec) => spec.definition.name));
}

export function surfaceAllowsTool(surface, toolName, toolSpecs) {
  return executableToolNames(surface, toolSpecs).has(toolName);
}

export function toolReferences(text, registeredToolNames) {
  if (!text) return [];
  const found = [];
  for (const name of registeredToolNames) {
    if (toolReferencePattern(name).test(text)) {
      found.push(name);
    }
  }
  return found;
}

function toolReferencePattern(name, global = false) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Tool names can also be ordinary English words (`api`, `feedback`) or read
  // like them (`db_dump` in "a database export (db_dump ...)"). Only
  // code/reference shapes count: a backticked name, a call expression, or a
  // tool-name field. Plain prose and paths such as /api/hello are data.
  //
  // The call-expression arm requires the "(" to follow the name IMMEDIATELY.
  // It used to allow `\s*` between them, which made every parenthetical in
  // ordinary prose a "call": "Send feedback (see the docs topic)" was rewritten
  // to "Send feedback (not available on the ... surface) (see the docs topic)".
  // A real invocation is written `feedback({ ... })` / `db_dump()` with no gap,
  // so dropping `\s*` keeps every genuine call annotated and stops annotating
  // prose. Both directions are fixtured in check-surface-tool-references.mjs.
  const source = [
    `\`${escaped}\``,
    `["']?tool["']?\\s*[:=]\\s*["'\`]${escaped}["'\`]`,
    `(?:^|[^a-z0-9_])${escaped}(?=\\()`,
  ].join('|');
  return new RegExp(source, global ? 'gi' : 'i');
}

/**
 * Make global reference copy truthful on a curated surface without maintaining
 * a second documentation corpus. Every out-of-surface tool reference is
 * marked unavailable in place; the surrounding guidance is never discarded.
 */
export function constrainTextToSurface(text, surface, registeredToolNames, allowedToolNames) {
  if (!SURFACE_MANIFESTS[surface]) throw new Error(`Unknown MCP surface: ${surface}`);
  const knownNames = new Set(registeredToolNames);
  const allowed = new Set(allowedToolNames);
  let constrained = text;
  for (const name of toolReferences(text, knownNames).filter((toolName) => !allowed.has(toolName))) {
    const annotation = `(not available on the ${surface} surface; use \`catalog\` for an executable path)`;
    constrained = constrained.replace(toolReferencePattern(name, true), (match, offset, source) => {
      const suffix = source.slice(offset + match.length);
      return /^\s+\(not available on the [^)]+ surface;/.test(suffix)
        ? match
        : `${match} ${annotation}`;
    });
  }
  return constrained;
}
