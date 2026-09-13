import type { ToolDefinition } from './tool-registry/types';
import type { AdvisorComposition, AdvisorComponent, AdvisorRecipe } from './advisor-recipe-types';
import { checkoutFulfillmentRecipe } from './advisor-checkout-recipe';
import { magicLinkBrowserRecipe } from './advisor-magic-link-recipe';
import { checkAdvisorCommands } from './advisor-command-contract';
import { renderAdvisorAction } from './advisor-actions';
export { quoteAdvisorShell } from './advisor-actions';

export const ADVISOR_COMPOSITION_PROMPT = `Return one JSON object with prose, components, recipes, actions.
prose: useful concise explanation in the requested format, including general answers outside recipes.
components: [{decision,status,explanation}], one entry per requested decision; status is provided, needs_input or unavailable. This is your coverage receipt, not proof of universal completeness.
recipes: at most two selections. {kind:"checkout_fulfillment",table:"payment_requests"} renders a proposed new serverOnly schema and a fixed Stripe handler binding server-recorded session, amount, currency, livemode and account. It does not create Checkout or perform external fulfillment. {kind:"magic_link_browser"} renders the fixed emailed landing/browser POST/cookie/navigation flow. Select the appropriate recipe when those executable flows are requested; do not rewrite their security code in prose. Recipe table names are proposals, never inferred existing tables. Checkout expectations must be stored by trusted server creation, never browser/event/model defaults. Missing amount blocks Checkout creation only.
actions: [{tool,arguments}], exact caller-advertised tool name and JSON object. Do not assemble shell commands. Omit project_id: the renderer binds the authorized project; never substitute a different project. Missing required inputs belong in components, not invented placeholders. CLI auth_verify_magic_link consumes a token and is an alternative to the browser recipe, never a preceding step. Never include credentials or magic-link tokens.
Keep general explanations useful; an unavailable recipe/action must not erase independent decisions. No tool round follows this response.`;

// Non-strict schema permits the advertised tools' heterogeneous JSON arguments;
// local parsing, tool identity and project binding remain authoritative.
export const ADVISOR_COMPOSITION_FORMAT = {
  type: 'json_schema', name: 'advisor_composition', strict: false,
  schema: { type: 'object', required: ['prose', 'components', 'recipes', 'actions'], additionalProperties: false,
    properties: {
      prose: { type: 'string' },
      components: { type: 'array', maxItems: 16, items: { type: 'object', required: ['decision', 'status', 'explanation'], additionalProperties: false,
        properties: { decision: { type: 'string' }, status: { enum: ['provided', 'needs_input', 'unavailable'] }, explanation: { type: 'string' } } } },
      recipes: { type: 'array', maxItems: 2, items: { anyOf: [
        { type: 'object', required: ['kind', 'table'], additionalProperties: false, properties: { kind: { const: 'checkout_fulfillment' }, table: { type: 'string' } } },
        { type: 'object', required: ['kind'], additionalProperties: false, properties: { kind: { const: 'magic_link_browser' } } },
      ] } },
      actions: { type: 'array', maxItems: 12, items: { type: 'object', required: ['tool', 'arguments'], additionalProperties: false,
        properties: { tool: { type: 'string' }, arguments: { type: 'object', additionalProperties: true } } } },
    } },
} as const;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function string(value: unknown, cap: number): value is string { return typeof value === 'string' && value.length <= cap; }
export function parseAdvisorComposition(text: string): AdvisorComposition | null {
  if (new TextEncoder().encode(text).byteLength > 100_000) return null;
  let input: Record<string, unknown> | null;
  try { input = object(JSON.parse(text)); } catch { return null; }
  if (!input || !string(input.prose, 20_000) || !Array.isArray(input.components) || input.components.length > 16 ||
      !Array.isArray(input.recipes) || input.recipes.length > 2 || !Array.isArray(input.actions) || input.actions.length > 12) return null;
  const components: AdvisorComponent[] = [];
  for (const value of input.components) {
    const c = object(value);
    if (!c || !string(c.decision, 200) || !string(c.explanation, 4000) ||
      (c.status !== 'provided' && c.status !== 'needs_input' && c.status !== 'unavailable')) return null;
    components.push({ decision: c.decision, status: c.status, explanation: c.explanation });
  }
  const recipes: AdvisorRecipe[] = [];
  for (const value of input.recipes) {
    const r = object(value);
    if (r?.kind === 'magic_link_browser' && Object.keys(r).length === 1) recipes.push({ kind: r.kind });
    else if (r?.kind === 'checkout_fulfillment' && string(r.table, 48) && /^[a-z][a-z0-9_]*$/.test(r.table) && Object.keys(r).length === 2) recipes.push({ kind: r.kind, table: r.table });
    else return null;
  }
  if (new Set(recipes.map(r => r.kind)).size !== recipes.length) return null;
  const actions = [];
  for (const value of input.actions) {
    const a = object(value), args = object(a?.arguments);
    if (!a || !string(a.tool, 100) || !args || JSON.stringify(args).length > 40_000) return null;
    actions.push({ tool: a.tool, arguments: args });
  }
  return { prose: input.prose, components, recipes, actions };
}

/** Advice only: renders supplied JSON, never invokes a tool or a shell. */
export function renderAdvisorComposition(composition: AdvisorComposition, options: {
  tools: readonly Pick<ToolDefinition, 'name' | 'inputSchema'>[];
  projectId: string | null;
  caller: string;
}): { text: string; omissions: string[] } {
  const parts: string[] = [];
  const omissions: string[] = [];
  const addProse = (text: string) => {
    const check = checkAdvisorCommands(text, options.tools, true);
    if (!check.ok) omissions.push('Executable CLI commands must be supplied as structured actions; this fragment was withheld.');
    else parts.push(text);
  };
  addProse(composition.prose);
  for (const component of composition.components) {
    addProse(`- ${component.decision}: ${component.explanation}${component.status === 'provided' ? '' : ` (${component.status.replaceAll('_', ' ')})`}`);
  }
  for (const recipe of composition.recipes) {
    const rendered = recipe.kind === 'checkout_fulfillment' ? checkoutFulfillmentRecipe(recipe.table) : magicLinkBrowserRecipe();
    parts.push(rendered.explanation);
    for (const file of rendered.files) parts.push(`\`${file.path}\`\n\n\`\`\`ts\n${file.source}\`\`\``);
  }
  for (const action of composition.actions) {
    const rendered = renderAdvisorAction(action, { ...options, browserVerification: composition.recipes.some(recipe => recipe.kind === 'magic_link_browser') });
    if ('reason' in rendered) omissions.push(`${action.tool}: ${rendered.reason}`);
    else parts.push(rendered.text);
  }
  if (omissions.length) parts.push('Commands needing input:\n' + omissions.map(item => `- ${item}`).join('\n'));
  return { text: parts.filter(Boolean).join('\n\n'), omissions };
}

/** Only a successfully read project row binds commands; a requested ID alone is not authority. */
export function advisorAuthorizedProjectId(context: string | null): string | null {
  if (!context) return null;
  try {
    const snapshot = object(JSON.parse(context.slice(context.lastIndexOf('\n') + 1)));
    const project = object(object(snapshot?.facts)?.project);
    const id = object(object(project?.fields)?.id);
    return project?.status === 'available' && id?.status === 'known' && typeof id.value === 'string' &&
      id.value === snapshot?.project_id ? id.value : null;
  } catch { return null; }
}
