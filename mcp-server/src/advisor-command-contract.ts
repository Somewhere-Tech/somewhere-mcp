import type { ToolDefinition } from './tool-registry/types';

type CommandFailure = 'command_syntax' | 'command_json' | 'command_tool' | 'command_required_args' | 'command_unstructured';
type CommandCheck = { ok: true; unvalidated: boolean } | { ok: false; reason: CommandFailure };

/** Parse literal POSIX shell words, never evaluate them. Dynamic shell programs
 * are deliberately unresolved rather than treated as malformed literal JSON. */
function literalCommand(source: string): { words: string[]; consumed: number; dynamic?: true } | null {
  const words: string[] = [];
  const unresolved = (at: number) => ({ words, consumed: source.indexOf('\n', at) < 0 ? source.length : source.indexOf('\n', at) + 1, dynamic: true as const });
  let word = '', active = false, quote: "'" | '"' | null = null;
  for (let i = 0; i <= source.length; i++) {
    const char = source[i];
    if (char === undefined) {
      if (quote) return null;
      if (active) words.push(word);
      return { words, consumed: i };
    }
    if (quote === "'") {
      if (char === "'") quote = null;
      else word += char;
      continue;
    }
    if (char === '\\') {
      const next = source[++i];
      if (next === undefined) return null;
      if (next === '\n') continue;
      if (quote === '"' && !['$', '`', '"', '\\'].includes(next)) word += '\\';
      word += next; active = true; continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === '$' || char === '`') return unresolved(i);
      else word += char;
      continue;
    }
    if (char === '\n' || (char === '#' && !active)) {
      if (active) words.push(word);
      const end = source.indexOf('\n', i);
      return { words, consumed: end < 0 ? source.length : end + 1 };
    }
    if (/\s/.test(char)) {
      if (active) { words.push(word); word = ''; active = false; }
    } else if (char === "'" || char === '"') {
      quote = char; active = true;
    } else if (/[`$;&|<>()]/.test(char)) {
      return unresolved(i);
    } else { word += char; active = true; }
  }
  return null;
}

/** Only executable examples are checked. Tool-name prose and inline generic
 * syntax are discussion. A template inside a command fence must still contain
 * literal, parseable JSON. Dynamic shell arguments are reported as unvalidated;
 * string placeholder values inside valid JSON are not guessed or evaluated.
 * This validates registry identity and required top-level keys, not SQL or a
 * replacement JSON Schema implementation. Diagnostics never include payloads. */
export function checkAdvisorCommands(answer: string, advertised: readonly Pick<ToolDefinition, 'name' | 'inputSchema'>[], structuredOnly = false): CommandCheck {
  let unvalidated = false;
  const tools = new Map(advertised.map(tool => [tool.name, tool.inputSchema]));
  const blocks: string[] = [];
  const prose = answer.replace(/(^|\n)[ \t]*(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)(?:\n[ \t]*\2[ \t]*(?=\n|$)|$)/g,
    (_all, before: string, _fence: string, language: string, body: string) => {
      if (['', 'sh', 'bash', 'shell', 'zsh', 'console', 'terminal', 'text', 'plaintext'].includes(language.trim().toLowerCase())) blocks.push(body);
      return before;
    });
  const plain = prose.replace(/(`+)([^`]*?)\1/g, (_all, _ticks: string, body: string) => {
    const snippet = body.trim();
    if (/^somewhere\s+call(?:\s+[a-zA-Z_][\w-]*)?$/.test(snippet)
        || /^somewhere call <tool> ['"]<json>['"]$/.test(snippet)) return '';
    const parsed = literalCommand(snippet);
    if (/^somewhere\s+call\b/.test(snippet) || (parsed?.words[0] === 'somewhere' && parsed.words[1] === 'call')) blocks.push(snippet);
    return '';
  });
  blocks.push(plain);
  for (const block of blocks) {
    if (structuredOnly) {
      // Markdown list/quote markers present an example; they are not shell words.
      const lines = /^[ \t]*(?:>[ \t]*)*(?:(?:[-+*]|[0-9]+[.)])[ \t]+)?(?:\$[ \t]+)?/gm;
      let line: RegExpExecArray | null;
      while ((line = lines.exec(block))) {
        const parsed = literalCommand(block.slice(line.index + line[0].length));
        if (parsed?.words[0] === 'somewhere' && parsed.words[1] === 'call') return { ok: false, reason: 'command_unstructured' };
        if (line[0].length === 0) lines.lastIndex += 1;
      }
    }
    const command = /^[ \t]*(?:\$[ \t]+)?somewhere[ \t]+call\b/gm;
    let match: RegExpExecArray | null;
    while ((match = command.exec(block))) {
      const start = match.index + match[0].lastIndexOf('somewhere');
      const parsed = literalCommand(block.slice(start));
      if (structuredOnly) return { ok: false, reason: 'command_unstructured' };
      if (!parsed) return { ok: false, reason: 'command_syntax' };
      if (parsed.dynamic) {
        const dynamicTool = parsed.words.slice(2).find(word => word !== '--json');
        if (dynamicTool && !tools.has(dynamicTool)) return { ok: false, reason: 'command_tool' };
        unvalidated = true; command.lastIndex = start + parsed.consumed; continue;
      }
      // CLI registerCall defines call [tool] [json], --list and --json;
      // omitted JSON means {}. Help is discovery, not a tool invocation.
      const tail = parsed.words.slice(2);
      if (tail.includes('--help') || tail.includes('-h')) { command.lastIndex = start + parsed.consumed; continue; }
      const argsWords = tail.filter(word => word !== '--json' && word !== '--list');
      if (tail.includes('--list')) {
        if (argsWords.length) return { ok: false, reason: 'command_syntax' };
        command.lastIndex = start + parsed.consumed; continue;
      }
      if (argsWords.length < 1 || argsWords.length > 2) return { ok: false, reason: 'command_syntax' };
      const schema = tools.get(argsWords[0] ?? '');
      if (!schema) return { ok: false, reason: 'command_tool' };
      let args: unknown;
      try { args = JSON.parse(argsWords[1] ?? '{}'); }
      catch { return { ok: false, reason: 'command_json' }; }
      if (!args || typeof args !== 'object' || Array.isArray(args)) return { ok: false, reason: 'command_json' };
      if (schema.required.some(key => !Object.prototype.hasOwnProperty.call(args, key))) return { ok: false, reason: 'command_required_args' };
      command.lastIndex = start + parsed.consumed;
    }
  }
  return { ok: true, unvalidated };
}
