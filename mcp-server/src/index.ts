import { advisorModel, advisorModelSupported, advisorTokenCostCents, ADVISOR_RESPONSE_BUDGET_MS, ADVISOR_MAX_OUTPUT_TOKENS } from './advisor-model-profile';
import { ADVISOR_SYSTEM_POLICY } from './advisor-system-policy';
import { formatAdvisorProjectFacts, type AdvisorFactRead } from './advisor-project-facts';
/**
 * somewhere.tech MCP Server
 * Translates MCP JSON-RPC protocol → REST calls to api.somewhere.tech/v1/*
 *
 * MCP Streamable HTTP transport: single endpoint accepts JSON-RPC 2.0 POST requests.
 * Claude Code config:
 * {
 *   "mcpServers": {
 *     "somewhere": {
 *       "url": "https://mcp.somewhere.tech/mcp",
 *       "headers": { "Authorization": "Bearer smt_..." }
 *     }
 *   }
 * }
 */

import {
  lostPrecisionMessage,
  scanLostPrecisionIntegers,
} from '../../worker/src/utils/json-exact-integers';
import { DATABASE_QUERY_RESULT_SCHEMA } from '../../shared/database-query-contract';
import { databaseDumpResult } from './database-dump-result';
import { bulkDocsGuidance } from './docs-request';
import {
  CONNECTOR_GETTING_STARTED_HELP, CLAUDE_CONNECTOR_GETTING_STARTED_HELP,
  platformHelp,
  platformHelpTopicExists,
  PLATFORM_HELP_TOPICS,
  stripDocLayerMarkers,
} from './platform-help';
import { ADVISOR_CONTEXT_SECURITY_POLICY, buildAdvisorInput } from './advisor-boundary';
import { formatAdvisorContext, sanitizeAdvisorContext } from './advisor-context';
import { advisorContractAnswer, advisorWebhookContractAnswer } from './advisor-contracts';
import { ADVISOR_COMPOSITION_PROMPT, ADVISOR_COMPOSITION_FORMAT, parseAdvisorComposition, renderAdvisorComposition, advisorAuthorizedProjectId } from './advisor-composition';
import { checkAdvisorCommands } from './advisor-command-contract';
import { advisorFallbackText, advisorIntegrationContext, selectAdvisorKnowledge } from './advisor-knowledge';
import { advisorContextFetcher, type AdvisorDiagnostics } from './advisor-diagnostics';
import { buildSupportTicketRestRequest } from './support-ticket';
import { constrainTextToSurface } from './surface-manifest.mjs';
import { catalogToolAvailability, searchCatalogEntries } from './catalog-search';
import type { ToolSurface } from './surface-manifest.mjs';
import { deliverClientSession } from './client-session-delivery';
import { anonymousClaimPrompt, isAnonymousClaimPromptCandidate } from './anonymous-claim-prompt';
import {
  FileUploadError,
  parseConnectorFileReference,
  parseConnectorFileReferences,
  resolveUploadContentType,
  streamConnectorFileToUpload,
  taskAttachmentPaths,
} from './file-upload';
import type { ConnectorFileReference, StorageRecord } from './types/file-upload';
import {
  injectProjectNotices,
  projectNoticeConnectInstructions,
  type ProjectNoticePayload,
  type ProjectNoticeToolResult,
} from './project-notices';
import {
  callerApiKeyRejectionCode,
  upstreamAuthRejectedResponse,
} from './auth-rejection.mjs';
import { normalizeProjectDeployFiles } from './project-deploy-input';
import {
  clientSupportsElicitation,
  confirmationInputRequired,
  detectEra,
  discoverResult,
  LIST_CACHE_HINTS,
  modernizeResult,
  negotiateLegacyProtocolVersion,
  readConfirmationRetry,
  type ModernContext,
  type ModernTraceContext,
} from './protocol-2026';
import {
  InvalidToolListCursorError,
  paginateToolList,
  shouldPaginateToolList,
} from './tool-list-pagination';
import { connectorApiToolSpecs } from './tool-registry/domains/connector-api';
import { ACCOUNT_TOOL_SPECS } from './tool-registry/domains/account';
import { TASK_READ_TOOL_SPECS } from './tool-registry/domains/task-reads';
import { GROUP_TOOL_SPECS } from './tool-registry/domains/groups';
import {
  publicToolDefinitions,
  type ToolExecutionRuntime,
  type ToolSpec,
  type ToolUpstreamResult,
} from './tool-registry/types';

const CANONICAL_DOCS_TOPICS = Object.keys(PLATFORM_HELP_TOPICS).sort();
const CANONICAL_DOCS_TOPICS_INLINE = CANONICAL_DOCS_TOPICS.join(', ');

interface Env {
  API_BASE_URL: string;
  API_SERVICE: Fetcher;
  NEW_PROJECT_SITE_DOMAIN?: string;
  // run_code is rooted at the dedicated runner worker (somewhere-tech-runner),
  // NOT the API worker — if the API worker were the root, the sandbox's sw.*
  // calls would re-enter it and CF loop protection would return 522. Prefer the
  // service binding; fall back to the public route. The integrator adds the
  // binding to wrangler.toml (service = "somewhere-tech-runner").
  RUNNER_SERVICE?: Fetcher;
  RUNNER_BASE_URL?: string;
  // somewhere.site (the AI website builder) admin debug bridge.
  // This is the SAME value as ADMIN_API_KEY on the fhp-api worker.
  // Set via:  printf '%s' "$KEY" | npx wrangler secret put SOMEWHERE_SITE_ADMIN_KEY
  SOMEWHERE_SITE_ADMIN_KEY?: string;
  // somewhere.tech admin debug bridge — used by debug_project and
  // somewhere_tech_stats tools. Same value as ADMIN_API_KEY on the
  // somewhere-tech-api worker. Sent via the existing API_SERVICE
  // service binding (no public HTTPS round-trip needed).
  // Set via:  printf '%s' "$KEY" | npx wrangler secret put SOMEWHERE_TECH_ADMIN_KEY
  SOMEWHERE_TECH_ADMIN_KEY?: string;
  // Comma-separated list of full smt_ API keys that have admin scope
  // — i.e. can call debug_project/debug_site/somewhere_*_stats. The
  // MCP worker already holds the upstream admin secrets above; without
  // this allowlist, ANY user with a valid smt_ key could hit those
  // tools (security gap). The keys are matched verbatim against the
  // Bearer token. Set via:
  //   printf '%s' "smt_FVa...,smt_other..." | npx wrangler secret put MCP_ADMIN_API_KEYS
  MCP_ADMIN_API_KEYS?: string;
  // OpenAI API key the advisor tool uses to call the configured advisor model with
  // reasoning.effort='low'. Platform infrastructure cost — no project
  // or smt_ key indirection. Set via:
  //   printf '%s' "sk-..." | npx wrangler secret put OPENAI_API_KEY
  // Without this the advisor tool returns a setup-required error.
  OPENAI_API_KEY?: string;
  // Advisor model flip. Defaults to gpt-5.6-terra; changing the secret/var
  // repoints both anonymous and authenticated advisor traffic together.
  ADVISOR_MODEL?: string;
  // Legacy Sonnet fallback. Kept bound so a future switch back is one
  // env-flag flip away.
  ANTHROPIC_API_KEY?: string;
  // KV namespace backing the per-IP + per-verified-bearer rate limit on
  // MCP-native paid tools (advisor). Optional: if unbound the
  // limiter no-ops and bearer verification remains the hard spend gate.
  // tsk_f9c77079.
  ADVISOR_RL_KV?: KVNamespace;
}

const MCP_INITIALIZE_INSTRUCTION_LINES = [
  'somewhere.tech MCP exposes platform primitives; `docs({ topic })` provides the exact auth, database, payments, files, and runtime contracts.',
  'Functions are `export default async function (req, sw)`; `sw.*` are runtime bindings, not HTTP calls.',
  'Inside functions use `sw.db`, `sw.auth`, `sw.fs`, `sw.email`, `sw.ai`, `sw.payments`; do not call platform HTTP endpoints with a developer key.',
  'Database/query row results live in `data`; do not use `.rows` or `.results`.',
  'Client SDK calls use the familiar `{ data, error }` shape.',
  'Deploy raw source (`src/`, `index.html`, `package.json`, `api/`); the platform compiles it.',
  'Never run `npm run build`, `vite build`, or deploy `dist/` / `build/` unless explicitly using a bundled-output escape hatch.',
  '`catalog` is the caller-visible tool index.',
  '`advisor({ question })` can inspect an authorized live project and answer architecture questions.',
  '`docs({ topic: \'migration-supabase\' })` documents Supabase migration; bcrypt password hashes import directly.',
];

function initializeInstructionsForSurface(surface: ToolSurface): string {
  const advertised = advertisedNamesForSurface(surface);
  return MCP_INITIALIZE_INSTRUCTION_LINES
    .filter((line) => advertised.has('advisor') || !line.includes('`advisor'))
    .join('\n');
}

/** MCP tool annotations per the 2025-03 spec. Each entry lets the
 *  client UI render the tool with the right safety colour and
 *  intent so it can AUTO-APPROVE reads and gate only real writes:
 *  - readOnlyHint: pure read; no side effects — safe to auto-run.
 *  - destructiveHint: deletes or irreversibly overwrites data.
 *    Clients surface a confirm step before running.
 *  - idempotentHint: re-running with the same args is safe (no
 *    duplicate effect) — true for reads and for set/update/upsert.
 *  - openWorldHint: tool reaches out to non-platform systems
 *    (AI models, email/SMS, registrars, Stripe, the public web).
 *
 *  COMPLETE COVERAGE (tsk_8b3422b3): every registered tool is
 *  annotated. Generated by classifying each tool by its action verb
 *  (read / create / update / delete / external). The whole surface
 *  is mechanically covered so a client never has to guess-and-gate a
 *  pure read (the founder's project_architecture read was gated like
 *  a destructive write before this). Every ToolSpec carries these
 *  annotations beside its definition, dispatch, and surface metadata;
 *  the registry construction invariant rejects omissions. */
interface McpToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

interface ToolSecurityScheme {
  type: 'oauth2';
  scopes: string[];
}

/** True if the caller's Authorization Bearer key is in the
 *  MCP_ADMIN_API_KEYS allowlist. Used to gate admin tool visibility +
 *  invocation. Returns false if the env var isn't set, so admin tools
 *  are hidden from EVERYONE until an operator explicitly grants
 *  access. */
function isAdminCaller(env: Env, authHeader: string): boolean {
  const allowlist = env.MCP_ADMIN_API_KEYS;
  if (!allowlist) return false;
  if (!authHeader.startsWith('Bearer ')) return false;
  const token = authHeader.slice(7).trim();
  if (!token) return false;
  return allowlist.split(',').map((k) => k.trim()).includes(token);
}

const SOMEWHERE_SITE_API_BASE = 'https://api.somewhere.site';

// --- MCP Tool Definitions ---

interface JSONSchemaProp {
  /** JSON Schema allows a type-array (e.g. ["string","object"]) to indicate
   *  that a field accepts multiple types. */
  type?: string | string[];
  description?: string;
  enum?: string[];
  items?: JSONSchemaProp;
  properties?: Record<string, JSONSchemaProp>;
  additionalProperties?: JSONSchemaProp | boolean;
  required?: string[];
  maxItems?: number;
  /** JSON Schema union — accepts any of the listed subschemas. Used
   *  for fields that accept multiple shapes (e.g. project_deploy's
   *  expected_version: number | "latest"). */
  oneOf?: JSONSchemaProp[];
}
interface MCPToolMeta {
  'openai/fileParams'?: string[];
  [key: string]: unknown;
}
interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, JSONSchemaProp>;
    required: string[];
  };
  outputSchema?: {
    type: 'object';
    properties?: Record<string, JSONSchemaProp>;
    required?: string[];
    additionalProperties?: boolean;
  };
  _meta?: MCPToolMeta;
}

/** Typed success-envelope schema for the small set of high-traffic reads that
 *  return structuredContent. Fields stay optional so the same schema also
 *  accepts the platform's standard {ok:false,error,message} tool errors. */
function readOutputSchema(dataProperties: Record<string, JSONSchemaProp>): NonNullable<MCPTool['outputSchema']> {
  return {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      data: {
        type: 'object',
        properties: dataProperties,
        additionalProperties: true,
      },
      error: { type: 'string' },
      message: { type: 'string' },
    },
    additionalProperties: true,
  };
}

type ToolHandlerOutcome = ToolUpstreamResult | ToolExecutionResult;

interface McpToolExecutionRuntime extends ToolExecutionRuntime {
  fetcher: Fetcher;
  env: Env;
  authHeader: string;
  ctx?: ExecutionContext;
  emitMode: 'standard' | 'chatgpt';
  caller: CallerKind;
  surface: ToolSurface;
  helpSessionId: string | null;
  toolName: string;
}

type CanonicalToolSpec = ToolSpec<McpToolExecutionRuntime, ToolHandlerOutcome>;

function defineCanonicalToolSpecs<const T extends readonly CanonicalToolSpec[]>(specs: T): T {
  return specs;
}

/* ─── ONE capture surface ──────────────────────────────────────────────
 *
 * Founder, 2026-07-23: "let's get the screenshot in one call or print/invite
 * right why have it in two? consolidate and improve functionality."
 *
 * There used to be three tools over two engines — `render_screenshot`,
 * `render_pdf` (a VERBATIM copy of the screenshot handler that branched on
 * `toolName`), and `browser` — and each one could do most of a capture but
 * not all of it. The user was made to choose which half they wanted. That was
 * our failure, not theirs.
 *
 * `browser` is now the one advertised capture surface and this is its one
 * handler. `render_screenshot` / `render_pdf` remain registered and callable
 * as deprecated aliases (aliasOf) so nothing already deployed breaks — they
 * come through here too. There is no copy of this logic anywhere.
 *
 * The ONE axis that replaces "which tool do I call?" is the output format:
 * `capture: { as: "png" | "jpeg" | "webp" | "pdf" }`. Printing is an OUTPUT,
 * not a different operation.
 *
 * There are two RESULT SHAPES, and the split is by construction rather than
 * inference:
 *
 *   artifact — raw bytes (or a stored path). Used when there is no page to
 *              navigate and no signals to collect: an `html` snippet has no
 *              origin, so it cannot have cookies, steps, or a network table.
 *              Also the shape the deprecated aliases keep, byte-for-byte.
 *   report   — the signals-first browser report (console errors, page errors,
 *              failed requests, steps, screenshots). Used for a real page.
 *
 * A capability is never silently unavailable in either shape: the worker's
 * shared capture core (utils/capture.ts) resolves format/quality/full_page/
 * print options identically on both paths.
 */

const CAPTURE_FORMATS = ['png', 'jpeg', 'webp', 'pdf'] as const;
type CaptureAs = (typeof CAPTURE_FORMATS)[number];
const PAPER_FORMATS = ['A4', 'A3', 'Letter', 'Legal', 'Tabloid'] as const;

function isCaptureAs(v: unknown): v is CaptureAs {
  return typeof v === 'string' && (CAPTURE_FORMATS as readonly string[]).includes(v);
}
function isPaperFormat(v: unknown): boolean {
  return typeof v === 'string' && (PAPER_FORMATS as readonly string[]).includes(v);
}

/** The capture options bag, however the caller spelled it. */
interface CaptureBag {
  as?: CaptureAs;
  width?: unknown;
  quality?: unknown;
  full_page?: unknown;
  paper?: unknown;
  landscape?: unknown;
  print_background?: unknown;
}

/**
 * Read the capture bag from any accepted spelling:
 *   browser            → `capture: {...}` (canonical) or `screenshot: {...}` (the
 *                        spelling `browser` shipped with)
 *   render_screenshot  → flat `format` / `quality` / `full_page`
 *   render_pdf         → flat `format` (a PAPER size) / `landscape` /
 *                        `print_background`
 *
 * The old pair of tools used `format` for BOTH the image codec and the paper
 * size, with disjoint value sets — the same key meaning two different things
 * depending on which tool you happened to call. That collision is the concept
 * this consolidation removes: `as` is the output, `paper` is the paper.
 */
function readCaptureBag(toolName: string, args: Record<string, unknown>): CaptureBag {
  if (toolName === 'render_pdf') {
    return {
      as: 'pdf',
      paper: args.format,
      landscape: args.landscape,
      print_background: args.print_background,
    };
  }
  if (toolName === 'render_screenshot') {
    return {
      as: isCaptureAs(args.format) ? args.format : undefined,
      quality: args.quality,
      full_page: args.full_page,
      width: args.width,
    };
  }
  const raw = args.capture ?? args.screenshot;
  const bag = isRecord(raw) ? (raw as Record<string, unknown>) : {};
  const as = isCaptureAs(bag.as) ? bag.as : isCaptureAs(bag.format) ? bag.format : undefined;
  return {
    as,
    width: bag.width,
    quality: bag.quality,
    full_page: bag.full_page,
    paper: bag.paper,
    landscape: bag.landscape,
    print_background: bag.print_background,
  };
}

/** Layout geometry, from `viewport` or the legacy flat width/height. */
function readViewport(args: Record<string, unknown>): unknown {
  if (args.viewport !== undefined) return args.viewport;
  if (args.width !== undefined || args.height !== undefined) {
    return {
      ...(typeof args.width === 'number' ? { width: args.width } : {}),
      ...(typeof args.height === 'number' ? { height: args.height } : {}),
    };
  }
  return undefined;
}

/**
 * Fetch a capture as raw bytes (or a stored path) and shape the MCP result —
 * the artifact path, shared by `browser({ html })` and both deprecated
 * aliases. This is the code that `render_pdf` used to hold a verbatim copy of.
 */
async function fetchCaptureArtifact(
  runtime: McpToolExecutionRuntime,
  endpoint: string,
  body: Record<string, unknown>,
  wantInline: boolean,
): Promise<ToolUpstreamResult> {
  const { fetcher, authHeader } = runtime;
  // With `storage` the worker answers JSON (the path) — pass it straight
  // through. Without it the worker answers raw bytes, which must be
  // base64-encoded for the MCP transport.
  if (body.storage) return callAPI(fetcher, 'POST', endpoint, authHeader, body);

  const resp = await fetcher.fetch(`https://api-internal${endpoint}`, {
    method: 'POST',
    headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const contentType = resp.headers.get('Content-Type') || '';
  if (contentType.includes('application/json')) {
    return { status: resp.status, data: await resp.json() };
  }
  const buf = new Uint8Array(await resp.arrayBuffer());
  let binary = '';
  for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
  const base64 = btoa(binary);
  // Lift the bytes into a real MCP image content block when they fit. A PDF is
  // never inlined (it is not an image) — it comes back as base64 or a path.
  const isImg = contentType.startsWith('image/');
  const inlineable = wantInline && isImg && base64.length <= 750000;
  const tooBigToInline = wantInline && isImg && base64.length > 750000;
  return {
    status: resp.status,
    data: {
      content_type: contentType,
      size_bytes: buf.byteLength,
      base64: inlineable ? '<sent as image content block>' : base64,
      ...(tooBigToInline ? { note: 'image too large to inline; fetch via the returned path' } : {}),
    },
    ...(inlineable ? { _inlineImage: { mimeType: contentType || 'image/png', data: base64 } } : {}),
  };
}

/**
 * THE capture handler. `browser`, `render_screenshot` and `render_pdf` all
 * enter here; the only thing the tool name decides is which spelling of the
 * arguments to read and which result shape the caller already depends on.
 */
async function runCapture(
  runtime: McpToolExecutionRuntime,
  args: Record<string, unknown>,
): Promise<ToolHandlerOutcome> {
  const { fetcher, env, authHeader, ctx, toolName } = runtime;
  const isAlias = toolName === 'render_screenshot' || toolName === 'render_pdf';
  const bag = readCaptureBag(toolName, args);

  /* ── Argument-shape guards (the correcting errors) ─────────────────── */
  if (!isAlias) {
    if (args.viewport !== undefined && typeof args.viewport !== 'string' && !isRecord(args.viewport)) {
      return badArgsToolResult(
        env, authHeader, ctx, toolName, args,
        'browser viewport must be "desktop", "mobile", or { "width": 1600, "height": 1200 }.\nExample:\nbrowser({ "project_id": "my-app", "viewport": { "width": 1600, "height": 1200 } })\nUse capture.width to shrink the OUTPUT image; viewport sets the LAYOUT size.',
      );
    }
    if (typeof args.viewport === 'string' && args.viewport !== 'desktop' && args.viewport !== 'mobile') {
      return badArgsToolResult(
        env, authHeader, ctx, toolName, args,
        'browser viewport must be "desktop", "mobile", or an explicit { width, height }.\nExample:\nbrowser({ "project_id": "my-app", "viewport": "mobile" })\nSupported top-level keys include project_id, url, html, steps, capture, viewport, storage, inline, session_id, auth.',
      );
    }
    if (args.include !== undefined && !Array.isArray(args.include)) {
      return badArgsToolResult(
        env, authHeader, ctx, toolName, args,
        'browser include must be an array containing "network", "dom", and/or "markdown".\nExample:\nbrowser({ "url": "https://example.com", "include": ["network", "dom"] })\nOmit include for the lean default health snapshot.',
      );
    }
    if (args.steps !== undefined && !Array.isArray(args.steps)) {
      return badArgsToolResult(
        env, authHeader, ctx, toolName, args,
        'browser steps must be an array of step objects; a single object is also accepted and wrapped automatically.\nExample:\nbrowser({ "project_id": "my-app", "steps": [{ "action": "goto", "path": "/" }, { "action": "assert_text", "selector": "h1", "contains": "Welcome" }] })\nUse browser({ "help": true }) for the full action reference.',
      );
    }
    if (args.actions !== undefined && !Array.isArray(args.actions)) {
      return badArgsToolResult(
        env, authHeader, ctx, toolName, args,
        'browser actions must be an array using the concise shared contract.\nExample:\nbrowser({ "project_id": "my-app", "actions": [{ "fill": "#email", "value": "a@b.co" }, { "click": "#save" }, { "expect": { "selector": ".saved", "visible": true } }] })',
      );
    }
    if (args.expect_requests !== undefined && !Array.isArray(args.expect_requests)) {
      return badArgsToolResult(
        env, authHeader, ctx, toolName, args,
        'browser expect_requests must be an array of { "path", "status" } objects.\nExample:\nbrowser({ "project_id": "my-app", "expect_requests": [{ "path": "/api/tasks", "status": 401 }] })',
      );
    }
    if (args.capture !== undefined && !isRecord(args.capture)) {
      return badArgsToolResult(
        env, authHeader, ctx, toolName, args,
        'browser capture must be an object such as { "as": "webp", "full_page": true } or { "as": "pdf", "paper": "A4" }.\nExample:\nbrowser({ "url": "https://example.com", "capture": { "as": "png", "full_page": true } })\nas is one of png | jpeg | webp | pdf.',
      );
    }
    if (args.screenshot !== undefined && !isRecord(args.screenshot)) {
      return badArgsToolResult(
        env, authHeader, ctx, toolName, args,
        'browser screenshot must be an object such as { "width": 1280, "format": "png" }; screenshot:true uses defaults and screenshot:false is treated as inline:false.\nExample:\nbrowser({ "url": "https://example.com", "capture": { "width": 1280 } })\nUse viewport:"desktop" | "mobile" | { width, height } for page size, not capture.',
      );
    }
    const rawAs = isRecord(args.capture) ? (args.capture as Record<string, unknown>).as : undefined;
    if (rawAs !== undefined && !isCaptureAs(rawAs)) {
      return badArgsToolResult(
        env, authHeader, ctx, toolName, args,
        `browser capture.as must be one of ${CAPTURE_FORMATS.join(' | ')}.\nExample:\nbrowser({ "project_id": "my-app", "capture": { "as": "pdf", "paper": "A4" }, "storage": "/invoices/inv-1.pdf" })\nA pdf comes out of this same call — there is no separate print tool.`,
      );
    }
    if (bag.paper !== undefined && !isPaperFormat(bag.paper)) {
      return badArgsToolResult(
        env, authHeader, ctx, toolName, args,
        `browser capture.paper must be one of ${PAPER_FORMATS.join(' | ')} (it is the PAPER size, only meaningful with capture.as "pdf").\nExample:\nbrowser({ "html": "<h1>Invoice</h1>", "capture": { "as": "pdf", "paper": "A4" } })`,
      );
    }
    // Discoverability: hand back the full action reference without running.
    if (args.help === true) return captureHelpResult();
  }

  /* ── Result shape (by construction, never inferred) ────────────────── */
  const hasHtml = typeof args.html === 'string' && args.html.length > 0;
  // An `html` snippet has no origin — no navigation, no cookies, no steps, no
  // network signals exist for it. So it is an artifact, always. The deprecated
  // aliases are artifacts too: that is the response shape their callers ship
  // against, and changing it would break them.
  const shape: 'artifact' | 'report' = isAlias || hasHtml ? 'artifact' : 'report';
  const as: CaptureAs = bag.as ?? 'png';

  if (shape === 'artifact') {
    const endpoint = as === 'pdf' ? '/v1/render/pdf' : '/v1/render/screenshot';
    const body: Record<string, unknown> = {};
    if (hasHtml) body.html = args.html;
    if (args.url !== undefined) body.url = args.url;
    if (args.project_id !== undefined) body.project_id = args.project_id;
    if (args.storage !== undefined) body.storage = args.storage;
    if (args.wait_for !== undefined) body.wait_for = args.wait_for;

    // Geometry. `browser` accepts viewport:{width,height}; the aliases pass
    // flat width/height. Both land on the render route's width/height.
    const vp = readViewport(args);
    if (isRecord(vp)) {
      const v = vp as Record<string, unknown>;
      if (typeof v.width === 'number') body.width = v.width;
      if (typeof v.height === 'number') body.height = v.height;
    } else if (vp === 'mobile') {
      body.width = 390;
      body.height = 844;
    } else if (vp === 'desktop') {
      body.width = 1280;
      body.height = 800;
    }
    if (bag.width !== undefined && body.width === undefined && typeof bag.width === 'number') {
      body.width = bag.width;
    }

    if (as === 'pdf') {
      // The render route still spells the paper size `format` — that is the
      // contract sw.render.pdf() ships against and must not move.
      if (bag.paper !== undefined) body.format = bag.paper;
      if (bag.landscape !== undefined) body.landscape = bag.landscape;
      if (bag.print_background !== undefined) body.print_background = bag.print_background;
    } else {
      if (bag.as !== undefined) body.format = bag.as;
      if (bag.quality !== undefined) body.quality = bag.quality;
      // full_page reaches the html/artifact path now. `browser`'s html branch
      // used to forward only width/height/wait_for/project_id/storage and drop
      // format, quality and full_page on the floor.
      if (bag.full_page !== undefined) body.full_page = bag.full_page;
    }

    // Session seeding: only meaningful with a url (a session belongs to an
    // origin). Refuse it loudly on an html snippet rather than dropping it.
    const wantsSession = args.local_storage !== undefined || args.cookies !== undefined || args.headers !== undefined;
    if (wantsSession) {
      if (as === 'pdf') {
        return {
          status: 400,
          data: {
            ok: false,
            error: 'VALIDATION_ERROR',
            message: 'local_storage/cookies/headers need a rendered page session; they are not supported for pdf output. Capture the page as an image, or drive it with steps.',
          },
        };
      }
      if (hasHtml) {
        return {
          status: 400,
          data: {
            ok: false,
            error: 'VALIDATION_ERROR',
            message: 'local_storage/cookies/headers require a url — an html snippet has no origin to attach a session to.',
          },
        };
      }
      for (const k of ['local_storage', 'cookies', 'headers'] as const) {
        if (args[k] !== undefined) body[k] = args[k];
      }
    }

    // Inline by default for images (never a pdf, never when storing a path).
    // For the deprecated screenshot alias, keep its small-JPEG economy defaults
    // exactly as they were so its callers see no change.
    const wantInline = as !== 'pdf' && !args.storage && args.inline !== false;
    if (wantInline && toolName === 'render_screenshot') {
      if (body.format === undefined) body.format = 'jpeg';
      if (body.quality === undefined) body.quality = 70;
      if (body.width === undefined) body.width = 800;
    }
    return fetchCaptureArtifact(runtime, endpoint, body, wantInline);
  }

  /* ── report shape: a real page in a real browser ───────────────────── */
  const parseMaybeJson = (v: unknown): unknown => {
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch { return v; }
  };
  const inline = args.inline !== false;
  const body: Record<string, unknown> = {};
  if (args.project_id !== undefined) body.project_id = args.project_id;
  if (args.url !== undefined) body.url = args.url;
  if (args.continue_on_failure !== undefined) body.continue_on_failure = args.continue_on_failure;
  if (args.include !== undefined) body.include = parseMaybeJson(args.include);
  if (args.extract !== undefined) body.extract = args.extract;
  if (args.session_id !== undefined) body.session_id = args.session_id;
  if (args.steps !== undefined) body.steps = parseMaybeJson(args.steps);
  if (args.actions !== undefined) body.actions = parseMaybeJson(args.actions);
  if (args.expect_requests !== undefined) body.expect_requests = parseMaybeJson(args.expect_requests);
  if (args.visible_only !== undefined) body.visible_only = args.visible_only;
  if (args.auth !== undefined) body.auth = parseMaybeJson(args.auth);
  if (args.wait_for !== undefined) body.wait_for = args.wait_for;
  // Real layout geometry: a preset name OR { width, height }.
  const vp = readViewport(args);
  if (vp !== undefined) body.viewport = parseMaybeJson(vp);
  // The capture bag — png/jpeg/webp/pdf, output width, quality, full_page and
  // the print options, all honoured by the worker's shared capture core.
  const captureBody: Record<string, unknown> = {};
  if (bag.as !== undefined) captureBody.as = bag.as;
  if (bag.width !== undefined) captureBody.width = bag.width;
  if (bag.quality !== undefined) captureBody.quality = bag.quality;
  if (bag.full_page !== undefined) captureBody.full_page = bag.full_page;
  if (bag.paper !== undefined) captureBody.paper = bag.paper;
  if (bag.landscape !== undefined) captureBody.landscape = bag.landscape;
  if (bag.print_background !== undefined) captureBody.print_background = bag.print_background;
  if (Object.keys(captureBody).length) body.capture = captureBody;
  // A caller-chosen project files path for THE capture — previously ignored
  // outside html mode, which forced every page capture into /_browser_tests/.
  if (args.storage !== undefined) body.storage = args.storage;
  // Seed a session you already hold (the alternative to auth:{user_id},
  // which mints one). Origin-scoped + size-capped server side.
  for (const k of ['local_storage', 'cookies', 'headers'] as const) {
    if (args[k] !== undefined) body[k] = parseMaybeJson(args[k]);
  }
  if (args.store === true) body.store = true;
  if (inline) body.inline = true;

  const result = await callAPI(fetcher, 'POST', '/v1/browser/test', authHeader, body);

  // Lift the page screenshot's inline_base64 into a real image content block,
  // bounded to the first screenshot that carries it and a 750KB ceiling. The
  // screenshots' fs_path stays in the JSON output as the durable artifact.
  if (inline && result.data && typeof result.data === 'object') {
    const d = result.data as Record<string, unknown>;
    // The worker wraps the report via successResponse → { ok, data: report },
    // and callAPI does NOT unwrap — so screenshots live at result.data.data.
    const reportObj = d.data && typeof d.data === 'object' ? (d.data as Record<string, unknown>) : d;
    const nestedSrc = reportObj.report && typeof reportObj.report === 'object'
      ? (reportObj.report as Record<string, unknown>).screenshots
      : undefined;
    const shots = Array.isArray(reportObj.screenshots) ? reportObj.screenshots
      : Array.isArray(nestedSrc) ? nestedSrc
      : Array.isArray(d.screenshots) ? d.screenshots
      : undefined;
    if (shots) {
      const shot = shots.find(
        (s): s is Record<string, unknown> =>
          !!s && typeof s === 'object'
          && typeof (s as Record<string, unknown>).inline_base64 === 'string'
          && ((s as Record<string, unknown>).inline_base64 as string).length > 0,
      );
      if (shot) {
        const b64 = shot.inline_base64 as string;
        if (b64.length <= 750000) {
          const mime = typeof shot.mime_type === 'string' ? shot.mime_type
            : typeof shot.mimeType === 'string' ? shot.mimeType : 'image/jpeg';
          (result as { _inlineImage?: { mimeType: string; data: string } })._inlineImage = { mimeType: mime, data: b64 };
          shot.inline_base64 = '<sent as image content block>';
        }
      }
    }
  }
  return result;
}

interface SiteVerifyViewport {
  label: string;
  width: number;
  height: number;
  wire: string | { width: number; height: number };
}

interface SiteVerifyRun {
  viewport: SiteVerifyViewport;
  report: Record<string, unknown>;
}

function normalizeSiteVerifyViewports(raw: unknown):
  | { ok: true; viewports: SiteVerifyViewport[] }
  | { ok: false; message: string } {
  const values = raw === undefined ? ['desktop', 'mobile'] : raw;
  if (!Array.isArray(values) || values.length === 0 || values.length > 4) {
    return { ok: false, message: 'site_verify viewports must be a non-empty array with at most 4 items.' };
  }
  const labels = new Set<string>();
  const viewports: SiteVerifyViewport[] = [];
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    let viewport: SiteVerifyViewport;
    if (value === 'desktop') viewport = { label: 'desktop', width: 1280, height: 800, wire: 'desktop' };
    else if (value === 'mobile') viewport = { label: 'mobile', width: 390, height: 844, wire: 'mobile' };
    else if (isRecord(value)
      && typeof value.label === 'string'
      && /^[a-z0-9][a-z0-9_-]{0,31}$/i.test(value.label)
      && typeof value.width === 'number' && Number.isInteger(value.width) && value.width >= 100 && value.width <= 3840
      && typeof value.height === 'number' && Number.isInteger(value.height) && value.height >= 100 && value.height <= 2160) {
      viewport = {
        label: value.label,
        width: value.width,
        height: value.height,
        wire: { width: value.width, height: value.height },
      };
    } else {
      return {
        ok: false,
        message: `site_verify viewports[${index}] must be "desktop", "mobile", or { "label", "width": 100..3840, "height": 100..2160 }.`,
      };
    }
    if (labels.has(viewport.label)) return { ok: false, message: `site_verify viewports duplicates label "${viewport.label}".` };
    labels.add(viewport.label);
    viewports.push(viewport);
  }
  return { ok: true, viewports };
}

function unwrapBrowserReport(result: ToolUpstreamResult): Record<string, unknown> | null {
  if (!isRecord(result.data)) return null;
  const envelope = result.data as Record<string, unknown>;
  return isRecord(envelope.data) ? envelope.data : envelope;
}

function siteVerifyActionName(action: unknown, fallback: string): string {
  if (!isRecord(action)) return fallback;
  if (typeof action.click === 'string') return `click ${action.click}`;
  if (typeof action.fill === 'string') return `fill ${action.fill}`;
  if (typeof action.select === 'string') return `select ${action.select}`;
  if (typeof action.wait === 'string' || typeof action.wait === 'number') return `wait ${String(action.wait)}`;
  if (isRecord(action.expect) && typeof action.expect.selector === 'string') return `expect ${action.expect.selector}`;
  if (typeof action.eval === 'string') return `eval ${action.eval}`;
  return fallback;
}

function browserReportPassed(report: Record<string, unknown>): boolean {
  const expectations = Array.isArray(report.request_expectations) ? report.request_expectations : [];
  const screenshots = Array.isArray(report.screenshots) ? report.screenshots : [];
  const screenshotHealthy = screenshots.some((shot) => typeof shot === 'string'
    ? shot.length > 0
    : isRecord(shot)
      && typeof shot.error !== 'string'
      && ['path', 'url', 'fs_path', 'scratch_url', 'inline_base64'].some((key) => typeof shot[key] === 'string' && shot[key].length > 0));
  return report.passed !== false
    && (!Array.isArray(report.page_errors) || report.page_errors.length === 0)
    && (!Array.isArray(report.console_errors) || report.console_errors.length === 0)
    && (!Array.isArray(report.failed_requests) || report.failed_requests.length === 0)
    && !expectations.some((item) => isRecord(item) && item.ok === false)
    && screenshotHealthy;
}

function shapeSiteVerifyReport(args: Record<string, unknown>, runs: SiteVerifyRun[]): Record<string, unknown> {
  const actions = Array.isArray(args.actions) ? args.actions : [];
  const steps: Array<Record<string, unknown>> = [];
  const pageErrors: Array<Record<string, unknown>> = [];
  const consoleErrors: Array<Record<string, unknown>> = [];
  const failedRequests: Array<Record<string, unknown>> = [];
  const expectations: Array<Record<string, unknown>> = [];
  const screenshots: Array<Record<string, unknown>> = [];

  for (const { viewport, report } of runs) {
    const reportSteps = Array.isArray(report.steps) ? report.steps : [];
    for (let index = 0; index < reportSteps.length; index++) {
      const step = isRecord(reportSteps[index]) ? reportSteps[index] as Record<string, unknown> : {};
      const sourceIndex = typeof step.step === 'number' ? step.step : index;
      steps.push({
        viewport: viewport.label,
        step: sourceIndex + 1,
        name: siteVerifyActionName(actions[sourceIndex], typeof step.action === 'string' ? step.action : 'page load'),
        passed: step.ok !== false && step.passed !== false,
        ...(typeof step.error === 'string' ? { error: step.error } : {}),
        ...(typeof step.duration_ms === 'number' ? { duration_ms: step.duration_ms } : {}),
        ...(step.value !== undefined ? { value: step.value } : {}),
      });
    }
    for (const detail of Array.isArray(report.page_errors) ? report.page_errors : []) pageErrors.push({ viewport: viewport.label, detail });
    for (const detail of Array.isArray(report.console_errors) ? report.console_errors : []) consoleErrors.push({ viewport: viewport.label, detail });
    for (const detail of Array.isArray(report.failed_requests) ? report.failed_requests : []) failedRequests.push({ viewport: viewport.label, detail });
    for (const detail of Array.isArray(report.request_expectations) ? report.request_expectations : []) expectations.push({ viewport: viewport.label, detail });
    for (const raw of Array.isArray(report.screenshots) ? report.screenshots : []) {
      if (typeof raw === 'string') screenshots.push({ viewport: viewport.label, label: 'page', path: raw });
      else if (isRecord(raw)) screenshots.push({ viewport: viewport.label, label: typeof raw.label === 'string' ? raw.label : 'page', ...raw });
    }
  }

  const failingStep = steps.find((step) => step.passed === false);
  const failedExpectation = expectations.find((entry) => isRecord(entry.detail) && entry.detail.ok === false);
  const failedScreenshot = runs.find(({ report }) => !browserReportPassed({
    passed: true,
    screenshots: report.screenshots,
  }));
  const passed = runs.every((run) => browserReportPassed(run.report));
  let verdict: string;
  if (failingStep) {
    verdict = `FAIL — step ${failingStep.step} (${failingStep.name}) failed at ${failingStep.viewport}${failingStep.error ? `: ${failingStep.error}` : '.'}`;
  } else if (pageErrors.length) verdict = `FAIL — page error at ${pageErrors[0].viewport}: ${String(pageErrors[0].detail)}`;
  else if (consoleErrors.length) verdict = `FAIL — console error at ${consoleErrors[0].viewport}: ${String(consoleErrors[0].detail)}`;
  else if (failedRequests.length) verdict = `FAIL — unexpected request failure at ${failedRequests[0].viewport}: ${JSON.stringify(failedRequests[0].detail)}`;
  else if (failedExpectation && isRecord(failedExpectation.detail)) {
    verdict = `FAIL — expected request ${String(failedExpectation.detail.path)}:${String(failedExpectation.detail.status)} was not observed at ${String(failedExpectation.viewport)}.`;
  } else if (failedScreenshot) {
    verdict = `FAIL — screenshot capture failed at ${failedScreenshot.viewport.label}.`;
  } else {
    verdict = actions.length
      ? `PASS — ${actions.length} step${actions.length === 1 ? '' : 's'} passed at ${runs.map((run) => run.viewport.label).join(' and ')}; page, console, and network healthy.`
      : `PASS — default page check passed at ${runs.map((run) => run.viewport.label).join(' and ')}; page, console, and network healthy.`;
  }

  return {
    passed,
    verdict,
    target: typeof args.url === 'string' ? args.url : args.project_id,
    viewports: runs.map(({ viewport, report }) => ({
      label: viewport.label,
      width: viewport.width,
      height: viewport.height,
      passed: browserReportPassed(report),
      final_url: typeof report.final_url === 'string' ? report.final_url : args.url ?? args.project_id,
      accessibility_layout: typeof report.accessibility_layout === 'string'
        ? report.accessibility_layout
        : 'Accessibility/layout: check unavailable (non-blocking).',
    })),
    steps,
    health: {
      page: { passed: pageErrors.length === 0, errors: pageErrors },
      console: { passed: consoleErrors.length === 0, errors: consoleErrors },
      network: {
        passed: failedRequests.length === 0 && expectations.every((entry) => !isRecord(entry.detail) || entry.detail.ok !== false),
        failed_requests: failedRequests,
        expectations,
      },
    },
    screenshots,
  };
}

async function runSiteVerify(runtime: McpToolExecutionRuntime, args: Record<string, unknown>): Promise<ToolHandlerOutcome> {
  const { fetcher, env, authHeader, ctx, toolName } = runtime;
  if (typeof args.project_id !== 'string' && typeof args.url !== 'string') {
    return badArgsToolResult(env, authHeader, ctx, toolName, args, 'site_verify needs project_id or url.');
  }
  if (args.actions !== undefined && !Array.isArray(args.actions)) {
    return badArgsToolResult(env, authHeader, ctx, toolName, args, 'site_verify actions must be the concise browser action array.');
  }
  if (args.expect_requests !== undefined && !Array.isArray(args.expect_requests)) {
    return badArgsToolResult(env, authHeader, ctx, toolName, args, 'site_verify expect_requests must be an array of { path, status }.');
  }
  if (args.visible_only !== undefined && typeof args.visible_only !== 'boolean') {
    return badArgsToolResult(env, authHeader, ctx, toolName, args, 'site_verify visible_only must be boolean.');
  }
  const hasSessionSeed = args.auth !== undefined || args.local_storage !== undefined
    || args.cookies !== undefined || args.headers !== undefined;
  if (hasSessionSeed && typeof args.project_id !== 'string') {
    return badArgsToolResult(
      env,
      authHeader,
      ctx,
      toolName,
      args,
      'site_verify auth, local_storage, cookies, and headers require project_id so credentials stay locked to that project origin.',
    );
  }
  const normalized = normalizeSiteVerifyViewports(args.viewports);
  if (!normalized.ok) return badArgsToolResult(env, authHeader, ctx, toolName, args, normalized.message);

  const outcomes = await Promise.all(normalized.viewports.map(async (viewport) => ({
    viewport,
    result: await callAPI(fetcher, 'POST', '/v1/browser/test', authHeader, {
      ...(typeof args.project_id === 'string' ? { project_id: args.project_id } : {}),
      ...(typeof args.url === 'string' ? { url: args.url } : {}),
      actions: Array.isArray(args.actions) ? args.actions : [],
      expect_requests: Array.isArray(args.expect_requests) ? args.expect_requests : [],
      visible_only: args.visible_only === true,
      ...(args.auth !== undefined ? { auth: args.auth } : {}),
      ...(args.local_storage !== undefined ? { local_storage: args.local_storage } : {}),
      ...(args.cookies !== undefined ? { cookies: args.cookies } : {}),
      ...(args.headers !== undefined ? { headers: args.headers } : {}),
      viewport: viewport.wire,
      capture_after: true,
      inline: false,
      ...(typeof args.project_id !== 'string' ? { store: true } : {}),
    }),
  })));
  const failed = outcomes.find(({ result }) => result.status < 200 || result.status >= 300 || !unwrapBrowserReport(result));
  if (failed) return failed.result;
  const runs = outcomes.map(({ viewport, result }) => ({ viewport, report: unwrapBrowserReport(result) as Record<string, unknown> }));
  return { status: 200, data: { ok: true, data: shapeSiteVerifyReport(args, runs) } };
}

/** The full action reference, returned by `browser({ help: true })` without
 *  running anything — so the FIRST real call lands. */
function captureHelpResult(): ToolUpstreamResult {
  return {
    status: 200,
    data: {
      summary: 'browser — the ONE capture surface: SEE / INSPECT / DRIVE any web page in a real headless browser, and take a picture OR a PDF of it. Two modes: EYES (perception, no project_id) and VERIFY (project QA, project_id). Omit actions/steps to inspect; add actions to drive. render_screenshot and render_pdf are deprecated aliases of this tool and still work.',
      modes: {
        eyes: 'perception — NO project_id, any public url. Look at / inspect / screenshot ANY page. Screenshot returns inline (auto-downscaled) by default, or store:true → a short-TTL signed scratch_url (never durable storage). Lean payload; add include:["network","dom"] for the full data. No auth, no origin-lock.',
        verify: 'project QA — pass project_id. Drive + assert YOUR deployed app: steps (click/fill/assert), auth:{user_id} (1h audited impersonation), screenshots stored durably to the project filesystem (fs_path). Origin-locked — a url must be on the project origin.',
      },
      targets: {
        project_id: 'VERIFY mode — your project (required for stored screenshots + auth; origin-locked)',
        url: 'EYES mode when alone (any public page); on-origin WITH project_id',
        html: 'render a raw HTML snippet straight to an image',
        store: 'EYES mode only — store:true persists the full-res shot to an ephemeral scratch store and returns a short-TTL screenshots[].scratch_url instead of inline base64 (ignored with a project_id)',
      },
      actions: [
        { action: 'goto', fields: { path: '/login' }, note: 'navigate (relative path or same-origin url)' },
        { action: 'click', fields: { selector: 'button[type=submit]' } },
        { action: 'fill', fields: { selector: '#email', value: 'a@b.co' } },
        { action: 'upload', fields: { selector: '#avatar', file: 'data:image/png;base64,...', name: 'avatar.png (optional)' }, note: 'CLI accepts a local path; hosted calls send base64/data URL bytes' },
        { action: 'press', fields: { key: 'Enter', selector: '#email (optional)' } },
        { action: 'select', fields: { selector: '#plan', value: 'pro' } },
        { action: 'hover', fields: { selector: '.menu' } },
        { action: 'wait_for', fields: { selector: '.dashboard' }, note: 'wait until an element appears' },
        { action: 'wait_for', fields: { selector: '#status', contains: 'Ready', timeout: 30000 }, note: 'BLOCK until the element TEXT contains the string; ERRORS at timeout (ms, default 15000, max 45000) — never a false-green' },
        { action: 'wait_for', fields: { settled: true, frame: 'preview', timeout: 30000, idle_ms: 600 }, note: 'block until the TARGET FRAME DOM stops mutating — THE signal for content streaming into an iframe (network_idle never fires on a long-lived fetch)' },
        { action: 'wait_for', fields: { network_idle: true, idle_ms: 500 }, note: 'block until no in-flight requests; NORMAL pages only — a streaming/long-lived fetch never goes idle, use settled' },
        { action: 'wait_for', fields: { text: 'All loaded' }, note: 'block until the text appears anywhere in the page/frame' },
        { action: 'wait_for', fields: { text_gone: 'Loading…' }, note: 'block until the text disappears' },
        { action: 'wait_for', fields: { url: '/dashboard' }, note: 'block until the page URL contains the substring' },
        { action: 'wait_for', fields: { predicate: 'window.__ready === true' }, note: 'block until the JS expression returns truthy (reuses eval; add frame to scope it)' },
        { action: 'wait', fields: { ms: 20000 }, note: 'fixed pause (max 45000), for a slow stream' },
        { action: 'eval', fields: { script: 'document.body.innerText' }, note: 'run JS, value comes back in steps[].value as JSON' },
        { action: 'snapshot', fields: { frame: 'preview (optional)' }, note: 'structured page-as-text (a11y roles + names) in steps[].value — the cheap default read vs a screenshot' },
        { action: 'screenshot', fields: { label: 'after', full_page: false }, note: 'stored as a file path under /_browser_tests/' },
        { action: 'assert_visible', fields: { selector: '.welcome' } },
        { action: 'assert_text', fields: { selector: '.welcome', contains: 'Hi' } },
        { action: 'assert_url', fields: { contains: '/dashboard' } },
        { action: 'assert_request', fields: { url_contains: '/api/login', status: 200 } },
        { action: 'click_at', fields: { x: 100, y: 200 }, note: 'coordinate fallback ONLY' },
      ],
      action_sequence: [
        { fill: '#email', value: 'a@b.co' },
        { upload: '#avatar', file: 'data:text/plain;base64,aGVsbG8=', name: 'hello.txt' },
        { select: '#plan', value: 'pro' },
        { click: 'button[type=submit]' },
        { wait: '.dashboard' },
        { expect: { selector: '.welcome', text: 'Hi', visible: true, count: 1 } },
        { screenshot: 'after' },
        { eval: 'document.title' },
      ],
      expect_requests: [{ path: '/api/tasks', status: 401 }],
      visible_only: 'true filters dom_outline to visible controls; returned controls retain visible and disabled annotations.',
      frame: 'Add "frame":"name | url-substring | child-index | css-selector" to ANY step to run it inside an iframe (the wait/assert/eval/screenshot/snapshot then observes the FRAME). Unknown frame ERRORS.',
      include: 'No-steps inspect calls are LEAN by default: console_errors / page_errors / failed_requests / rendered_text + a screenshot. Pass include:["network"] for the full per-request network table + redirect chain, include:["dom"] for dom_outline (the clickable-element map) + the testid handle map, and/or include:["markdown"] for the page as clean MARKDOWN.',
      extract: 'READ a page as clean markdown instead of vision-parsing the screenshot: extract:"markdown" (same as include:["markdown"]) returns the page content — headings, links, lists, main body — in the `markdown` field. The plain rendered text is always in `rendered_text`.',
      session_id: 'PERSISTENT SESSION: pass the same session_id across calls to keep ONE live browser page alive between them (navigate in call 1, wait for a stream + screenshot in call 2 — same page, cookies + current URL + in-flight stream preserved). Returns session_id + session_expires_at; a reconnect skips the initial navigation (use a goto step to move). Yours only, capped per developer, idles out ~3 min (~10 min hard cap); an expired session transparently restarts (session_note). Omit for the default fresh-per-call browser.',
      signals: 'Response leads with console_errors / page_errors / failed_requests / request_expectations, THEN steps (each with ok + optional value/error), THEN screenshots, plus rendered_text when you omit actions/steps. An expected path+status is excluded from failed resource signals; a missing expectation or unexpected 4xx/5xx makes passed false.',
      capture: 'The ONE output knob — capture: { as: "png" | "jpeg" | "webp" | "pdf", width, quality, full_page, paper, landscape, print_background }. `as` chooses picture or PRINT (a pdf comes out of this same call — there is no separate print tool). `full_page` captures the whole scrollable page. `width` shrinks the OUTPUT image (never upscales); it is NOT the layout size — that is `viewport`. `quality` applies to jpeg/webp; `paper`/`landscape`/`print_background` apply to pdf. Defaults: a small ~800px jpeg q70 for a page shot; png for an html snippet.',
      viewport: 'Real layout geometry: "desktop" (1280x800, default), "mobile" (390x844), or an explicit { "width": 1600, "height": 1200 } (100..3840 x 100..2160). Use this for responsive checks — capture.width only resizes the resulting image.',
      storage: 'A project files path for THE capture, e.g. "/renders/hero.webp" or "/invoices/inv-1.pdf" (requires project_id). Returns the stored path instead of inline bytes. Works with a url, an html snippet, or a steps run (captured last, after the flow). Step screenshots keep their own /_browser_tests/ run directory — one path cannot name many labelled images.',
      session: 'Two ways to be logged in: auth:{ "user_id": "..." } MINTS a 1h audited impersonation session for one of YOUR app users, or local_storage / cookies / headers seed a session you ALREADY hold before the page loads. The seeded form needs a url + project_id and is hard-scoped to that project\'s own origins (credentials are never sent to a third-party site) with an 8KB cap.',
      continue_on_failure: 'false (default) aborts the run on the first failed step but still returns captured signals; true runs them all.',
    },
  };
}

const DATABASE_TARGET_INPUT_PROPERTIES = {
  target: { type: 'string', enum: ['production', 'preview'] as string[], description: 'Database target. Preview requires preview_session_id (or draft_id).' },
  preview: { type: 'boolean', description: 'Explicit preview target flag. Cannot be combined with a production target.' },
  draft: { type: 'boolean', description: 'Legacy alias for the preview target flag.' },
  production: { type: 'boolean', description: 'Explicit production target flag. Cannot be combined with a preview target.' },
  preview_session_id: { type: 'string', description: 'Open preview session id whose isolated database should be used.' },
  preview_id: { type: 'string', description: 'Optional expected preview candidate release id.' },
  draft_id: { type: 'string', description: 'Legacy alias for preview_session_id.' },
  candidate_release_id: { type: 'string', description: 'Legacy alias for preview_id.' },
} as const;

function databaseTargetBody(args: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const field of Object.keys(DATABASE_TARGET_INPUT_PROPERTIES)) {
    if (args[field] !== undefined) body[field] = args[field];
  }
  return body;
}

const MIGRATED_TOOL_SPECS = defineCanonicalToolSpecs([
  // ── api ─────────────────────────────────────────────
  {
    definition: {
    name: 'api',
    description: `Call platform /v1 endpoints that do not have a dedicated MCP tool yet. Prefer the dedicated tool when one exists; use this for the long tail and day-0 endpoints. Use \`catalog\` to find existing tools and \`docs({ topic })\` for endpoint shape before calling.

Each request is explicit and inspectable: \`calls\` is a flat array of independent \`{ method, path, body? }\` items. A single invocation runs up to 10 calls, each still endpoint-auth and quota gated. Data from one call is not inserted into another; do data-dependent chains across separate tool calls. \`path\` must be a platform \`/v1/...\` path, not a full URL.

Write calls require \`confirm:true\` by default. \`GET\` and \`HEAD\` run without confirm; \`POST /v1/ai/complete\` and \`POST /v1/ai/embed\` are the only read-shaped write routes currently allowlisted. Without confirmation the tool returns the exact calls it would run and asks you to re-call with \`confirm:true\`. Calls run with the caller's own auth and the same permission checks as dedicated tools.`,
    inputSchema: {
      type: 'object',
      properties: {
        calls: {
          type: 'array',
          maxItems: 10,
          description: 'Flat list of independent platform API calls. Max 10. No templating or substitution between calls.',
          items: {
            type: 'object',
            properties: {
              method: { type: 'string', enum: ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE'], description: 'HTTP method.' },
              path: { type: 'string', description: 'Platform API path beginning with /v1/. Full URLs, //, .., encoded path separators, whitespace/control characters, /v1/admin*, and /v1/internal* are rejected before the normalized path is forwarded.' },
              body: { type: 'object', additionalProperties: true, description: 'Optional JSON object body for non-GET/HEAD calls.' },
            },
            required: ['method', 'path'],
          },
        },
        confirm: { type: 'boolean', description: 'Required as true for any POST, PUT, PATCH, or DELETE unless the normalized route is explicitly allowlisted as read-shaped.' },
      },
      required: ['calls'],
    },
  },
    annotations: { title: 'Call a platform API endpoint', readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    group: 'api',
    core: true,
    coreRank: 73,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      {
        const validation = validateApiToolArgs(args);
        if (!validation.ok) {
          return apiToolError('INVALID_ARGUMENTS', validation.error, validation.details);
        }
        if (validation.confirmRequiredCalls.length > 0 && args.confirm !== true) {
          return apiToolError(
            'CONFIRMATION_REQUIRED',
            'One or more api calls require confirmation. Re-run the same api call with confirm:true only after explicit approval.',
            {
              calls_requiring_confirm: validation.confirmRequiredCalls,
              safe_write_allowlist: [...API_TOOL_SAFE_WRITE_ALLOWLIST],
              confirm_by_recalling_with: { confirm: true },
            },
          );
        }

        const results: ApiToolCallResult[] = [];
        for (const call of validation.calls) {
          try {
            const res = await callAPI(fetcher, call.method, call.path, authHeader, call.body);
            results.push({ status: res.status, ok: res.status >= 200 && res.status < 300, data: res.data });
          } catch (err) {
            if (err instanceof UpstreamOAuthRejectedError || err instanceof UpstreamApiKeyRejectedError) throw err;
            results.push({
              status: 0,
              ok: false,
              data: {
                ok: false,
                error: 'API_CALL_FAILED',
                message: err instanceof Error ? err.message : String(err),
              },
            });
          }
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
          isError: results.some((item) => !item.ok),
        };

      }
    },
  },
  // ── help ─────────────────────────────────────────────
  {
    definition: {
    name: 'catalog',
    description: `The caller-visible index of available tools. Three reference surfaces have distinct effects: **catalog** lists which tools exist; **docs({ topic })** returns the static contract for one surface; **advisor({ question })** can answer open-ended questions from an authorized live project's state.

catalog returns the directory / table of contents / manifest for every tool available to this caller on the active surface, grouped by category with a one-line summary per group: \`{ categories: { project: { summary, tools: [...] }, db: { summary, tools: [...] }, ... } }\`. Categories cover projects, deploys, database, files, env vars, end-user auth, email (out + inbox), AI (chat + media), jobs, cron, queue, logs, errors, usage, feedback, domains, search, web scraping, push, rate limiting, telegram, analytics, captcha, payments, realtime, video, calls, render, stock photos, and platform help.

For admin/operator callers the same response also includes every registered plain-English platform census question, symptom, and authority declaration. That is the discovery call before \`somewhere_tech_stats({ metric_id })\` or \`debug_project({ identifier, symptom })\`; no table name or SQL knowledge is required.

**Search:** pass \`search\` to find a tool by keyword or exact name — e.g. \`catalog({ search: "auth_signup" })\`, \`catalog({ search: "upload url" })\`. Returns matching tools + their group + how to load each. Most tools are not in the default surface, so an empty default tool-search is not evidence that a tool is unavailable.

**Lazy-load:** pass \`load\` to get FULL tool definitions for one or more groups instead of the index — \`catalog({ load: "auth" })\`, \`catalog({ load: "db,fs" })\`, or \`load: "all"\`. Pair with a group-scoped connection (\`?groups=db,fs\` on the MCP URL, or the \`Mcp-Tool-Groups\` header) so a session only carries the tools it needs.`,
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: "Optional. Keyword or exact tool-name search across every tool available to this caller on the active surface (e.g. 'auth_signup', 'upload url', 'rollback'). Returns matching tools + their group + how to load each. Use this when you know the capability you want but the default tool-search didn't surface it." },
        load: { type: 'string', description: "Optional. Load full tool definitions for a group ('db', 'auth', …), a comma-separated list ('db,fs'), or 'all'. Omit to get the group index (names + summaries only)." },
        project_id: { type: 'string', description: "Optional project UUID, subdomain, slug, or 'default'. When supplied, the response also lists active runtime-fix notices for that project." },
      },
      required: [],
    },
  },
    annotations: { title: 'Browse tool catalog', readOnlyHint: true, idempotentHint: true },
    group: 'help',
    core: true,
    coreRank: 0,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","connector","chatgpt"],
    protocol: { surfaceDescriptions: { connector: "List or search the tools available on this Somewhere connector. Returns tool names and summaries; load returns their schemas. It does not activate additional tools." }, oauthScopes: ['mcp'] },
    execute: async (runtime, args) => {
      const { env, authHeader, ctx, emitMode, surface } = runtime;
      {
        const includeAdmin = isAdminCaller(env, authHeader);
        const operatorRegistryResponse = includeAdmin
          ? await callSomewhereTechAdmin(env, '/v1/sys/stats?catalog=1')
          : null;
        const operatorRegistryEnvelope = operatorRegistryResponse?.data as { data?: Record<string, unknown> } | undefined;
        const operatorRegistry = operatorRegistryEnvelope?.data ?? null;
        const operatorQuestions = Array.isArray(operatorRegistry?.operator_questions)
          ? operatorRegistry.operator_questions as Array<Record<string, unknown>>
          : [];
        const operatorSymptoms = Array.isArray(operatorRegistry?.symptoms)
          ? operatorRegistry.symptoms as Array<Record<string, unknown>>
          : [];
        const sourceCensuses = Array.isArray(operatorRegistry?.source_censuses)
          ? operatorRegistry.source_censuses as Array<Record<string, unknown>>
          : [];
        const operatorAdapters = Array.isArray(operatorRegistry?.existing_adapters)
          ? operatorRegistry.existing_adapters as Array<Record<string, unknown>>
          : [];
        const surfaceTools = availableNamesForSurface(surface, includeAdmin);
        const defaultSurfaceTools = listedNamesForSurface(surface, [], includeAdmin);
        const docsToolName = 'docs';
        const advisorStep = surfaceTools.has('advisor')
          ? " For open-ended architecture help, call advisor({ question })."
          : '';
        const decorateCatalogTool = (tool: MCPTool) => {
          const constrained = constrainToolDefinitionToSurface(tool, surface);
          return surface === 'chatgpt'
            ? withChatgptToolMetadata(constrained)
            : withToolAnnotations(constrained, surface);
        };
        if (args.search !== undefined && String(args.search).trim() !== '') {
          const q = String(args.search).toLowerCase().trim();
          const searchableRuntimeCapabilities = CATALOG_RUNTIME_CAPABILITIES.map((capability) => ({
            name: capability.name,
            group: capability.group,
            description: capability.description,
          }));
          const searchResult = searchCatalogEntries({
            query: q,
            tools: [
              ...TOOL_SPECS.map((spec) => ({
                name: spec.definition.name,
                group: spec.group,
                description: spec.definition.description,
              })),
              ...searchableRuntimeCapabilities,
            ],
            categories: CATALOG_CATEGORIES,
            availableToolNames: new Set([...surfaceTools, ...CATALOG_RUNTIME_CAPABILITIES.map((capability) => capability.name)]),
            aliases: {},
            titles: {
              ...Object.fromEntries(TOOL_SPECS.map((spec) => [
                spec.definition.name,
                spec.annotations.title || spec.definition.name,
              ])),
              ...Object.fromEntries(CATALOG_RUNTIME_CAPABILITIES.map((capability) => [capability.name, capability.title])),
            },
          });
          const matches = searchResult.matches.map((match) => {
            const capability = runtimeCapability(match.name);
            if (capability) {
              return {
                kind: 'runtime_capability' as const,
                name: capability.name,
                verb: capability.name,
                group: capability.group,
                title: capability.title,
                description: capability.description,
                docs_topic: capability.docs_topic,
                usage: capability.usage,
                callable_from: 'deployed functions and run_code',
                in_default_surface: null,
                load: null,
              };
            }
            return {
              kind: 'mcp_tool' as const,
              tool: match.name,
              group: match.group,
              title: match.title,
              ...catalogToolAvailability(match, defaultSurfaceTools),
            };
          });
          const operatorMatches = [
            ...operatorQuestions.map((entry) => ({ kind: 'operator_metric' as const, ...entry })),
            ...operatorSymptoms.map((entry) => ({ kind: 'operator_symptom' as const, ...entry })),
            ...sourceCensuses.map((entry) => ({ kind: 'source_census' as const, ...entry })),
            ...operatorAdapters.map((entry) => ({ kind: 'existing_adapter' as const, ...entry })),
          ].filter((entry) => JSON.stringify(entry).toLowerCase().includes(q));
          if (matches.length === 0 && operatorMatches.length === 0) {
            queueMissReport(env, authHeader, ctx, {
              miss_type: 'catalog_search',
              tool_attempted: q,
              arg_keys: ['search'],
              project_id: projectIdFromToolArgs(args),
              raw_message: `Catalog search returned no matches for "${q}".`,
              want_ai: false,
            });
          }
          const unavailableHint = searchResult.unavailable
            ? searchResult.unavailable.requested === searchResult.unavailable.canonical
              ? `Tool \`${searchResult.unavailable.canonical}\` exists, but is not available on the ${surface} surface.`
              : `Legacy tool \`${searchResult.unavailable.requested}\` is now called \`${searchResult.unavailable.canonical}\`, which is not available on the ${surface} surface.`
            : null;
          return { content: [{ type: 'text', text: JSON.stringify({
            query: q,
            matches: [...operatorMatches, ...matches],
            hint: unavailableHint ?? (operatorMatches.length
              ? 'Operator questions name the existing tool and stable metric/symptom id to call next; no SQL or table name is required.'
              : matches.length
              ? matches.some((match) => match.kind === 'runtime_capability')
                ? 'Runtime capabilities are called inside function code or run_code; MCP tool results name their availability and load group.'
                : matches.every((match) => match.in_default_surface === true)
                ? `Every result is advertised by default on the ${surface} surface.`
                : `Results outside the default ${surface} surface name the exact tool group to advertise via ?groups= or Mcp-Tool-Groups.`
              : 'No tool matched — try a capability word ("signup", "upload", "rollback") or call catalog() with no args for the full group index.'),
            next_step: `For HOW to build with any of these surfaces, call ${docsToolName}({ topic }) — the tool list shows the verbs; ${docsToolName} is the manual.${advisorStep}`,
          }, null, 2) }] };
        }
        // Lazy-load: `load` returns the full tool definitions for one or
        // more groups (the schemas an agent needs to actually call them),
        // instead of the whole index. tsk_1184d9ef.
        if (args.load !== undefined) {
          const keys = (Array.isArray(args.load) ? args.load.map(String) : parseGroupList(String(args.load)));
          if (keys.includes('all')) {
            const tools = TOOL_DEFINITIONS.filter((tool) => surfaceTools.has(tool.name)).map(decorateCatalogTool);
            return { content: [{ type: 'text', text: JSON.stringify({
              loaded: ['all'],
              count: tools.length,
              tools,
              runtime_capability_count: CATALOG_RUNTIME_CAPABILITIES.length,
              runtime_capabilities: CATALOG_RUNTIME_CAPABILITIES,
              ...(operatorRegistry ?? {}),
            }, null, 2) }] };
          }
          // `other` is a loadable catch-all: every tool matching no named
          // category. So an orphaned tool (like run_code was) is ALWAYS
          // reachable via a group load — never a dead UNKNOWN_GROUP. pfb_e95b908e4520.
          const wantsOther = keys.some((k) => k.trim().toLowerCase() === 'other');
          const resolved = keys.filter((k) => k.trim().toLowerCase() !== 'other').map((k) => ({ k, cat: resolveCatalogGroup(k) }));
          const known = resolved.filter((r) => r.cat).map((r) => r.cat!.key);
          const unknown = resolved.filter((r) => !r.cat).map((r) => r.k);
          if (known.length === 0 && !wantsOther) {
            const valid = CATALOG_CATEGORIES.map((c) => c.key).join(', ');
            return {
              content: [{ type: 'text', text: JSON.stringify({
                ok: false,
                error: 'UNKNOWN_GROUP',
                message: `Unknown tool group(s): ${unknown.join(', ') || '(none)'}. Valid groups: ${valid}, other, all.`,
              }, null, 2) }],
              isError: true,
            };
          }
          const allow = toolNamesForGroups(known);
          if (wantsOther) {
            for (const t of TOOL_DEFINITIONS) {
              if (surfaceTools.has(t.name) && !CATALOG_CATEGORIES.some((c) => toolBelongsToCatalogCategory(t.name, c))) allow.add(t.name);
            }
          }
          const tools = TOOL_DEFINITIONS.filter((t) => surfaceTools.has(t.name) && allow.has(t.name)).map(decorateCatalogTool);
          const runtimeCapabilities = CATALOG_RUNTIME_CAPABILITIES.filter((capability) =>
            known.includes(capability.group),
          );
          // Dedup known group keys while preserving order.
          const loaded = [...new Set([...known, ...(wantsOther ? ['other'] : [])])];
          return { content: [{ type: 'text', text: JSON.stringify({
            loaded,
            unknown,
            count: tools.length,
            tools,
          runtime_capability_count: runtimeCapabilities.length,
          runtime_capabilities: runtimeCapabilities,
          ...(operatorRegistry ?? {}),
          }, null, 2) }] };
        }
        const cat = buildCatalog(surface, surfaceTools);
        // Don't dead-end the agent: catalog lists the verbs, but "how do I
        // BUILD with these" lives in docs. Point there explicitly so
        // discovery flows catalog → docs → build (the pre-redesign
        // habit the founder wants restored, 2026-06-16).
        const catWithNext = {
          ...cat,
          ...(operatorRegistry ?? {}),
          next_step: `Found your tools. For HOW to build with any surface, call ${docsToolName}({ topic }) — the tool list shows the verbs; ${docsToolName} is the manual.${advisorStep}`,
        };
        if (emitMode === 'chatgpt') {
          const n = Object.keys(cat.categories).length;
          return {
            content: [{ type: 'text', text: `✓ Tool catalog · ${n} categories · ${cat.total_tools} tools. For HOW to build with any surface, call ${docsToolName}({ topic }).` }],
            structuredContent: catWithNext,
          };
        }
        return { content: [{ type: 'text', text: JSON.stringify(catWithNext, null, 2) }] };

      }
    },
  },
  {
    definition: {
    name: 'docs',
    description: `The static manual for one platform surface at a time. Returns signatures, examples, common patterns, failure modes, and exact behavior for deploy, sw.db, sw.auth, files, payments, and other primitives. The tool list names verbs; docs defines their contracts.

This is the static manual; for tailored advice on YOUR live project use \`advisor({ question })\` instead, and to find which tool exists at all use \`catalog\`.

Topics: ${CANONICAL_DOCS_TOPICS_INLINE}. Aliases such as fetch/http/outbound and legacy ctx.* names also resolve. Unknown topics return this canonical list. Example: \`{ "topic": "sw.fetch" }\`.`,
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: `One of: ${CANONICAL_DOCS_TOPICS_INLINE}. Aliases such as fetch, http, outbound, and legacy ctx.* names also resolve.`,
        },
        project_id: { type: 'string', description: "Optional project UUID, subdomain, slug, or 'default'. When supplied, the response also lists active runtime-fix notices for that project." },
      },
      required: ['topic'],
    },
  },
    annotations: { title: 'Read platform docs', readOnlyHint: true, idempotentHint: true },
    group: 'help',
    core: true,
    coreRank: 1,
    visibility: 'public',
    paid: false,
    surfaces: ["full","connector","chatgpt"],
    protocol: { surfaceDescriptions: { connector: "Read Somewhere platform documentation for a topic, including raw-source deployment, server functions, authentication, database access, and file storage. Returns the requested API contract and examples." }, oauthScopes: ['mcp'] },
    execute: async (runtime, args) => {
      const { env, authHeader, ctx, caller, surface, helpSessionId } = runtime;
      {
        // Local lookup — no HTTP. Return raw markdown so the agent reads
        // it as prose, not as a JSON-wrapped string. For path-sensitive
        // topics (getting-started / setup / cli / deploy / …) we lead with
        // a caller-tailored banner: CLI-first for shell-having agents,
        // tool-first for shell-less connectors, both for unknown. Shell-less
        // getting-started also gets a tool-only body so the banner cannot be
        // followed by commands the caller has no terminal to run.
        const startedAt = Date.now();
        const topic = (args.topic as string) || '';
        const record = (text: string): void => {
          queueHelpCall(env, ctx, authHeader, {
            kind: 'docs',
            requestText: topic,
            answerText: text,
            surface: `mcp:${surface}`,
            sessionId: helpSessionId,
            projectId: projectIdFromToolArgs(args),
            latencyMs: Date.now() - startedAt,
          });
        };
        const bulkGuidance = bulkDocsGuidance(topic, CANONICAL_DOCS_TOPICS);
        if (!bulkGuidance && !platformHelpTopicExists(topic)) {
          queueMissReport(env, authHeader, ctx, {
            miss_type: 'docs_topic',
            tool_attempted: normalizeDocsTopic(topic),
            arg_keys: ['topic'],
            project_id: projectIdFromToolArgs(args),
            raw_message: `Docs topic "${normalizeDocsTopic(topic)}" was not found.`,
            want_ai: false,
          });
        }
        if (bulkGuidance) {
          const text = constrainCanonicalText(bulkGuidance, surface);
          record(text);
          return { content: [{ type: 'text', text }] };
        }
        const banner = callerHelpBanner(topic, caller);
        const normalizedTopic = topic.trim().toLowerCase().replace(/^(?:sw|ctx)\./, '');
        const advisorHint = caller === 'cli'
          ? '\n\nNeed help applying this contract? Ask `somewhere advisor "your question"`; include the project and exact error when diagnosing a failure.\n'
          : '\n\nNeed help applying this contract? Ask `advisor` with your question and, for project diagnosis, `project_id`.\n';
        const body = caller === 'connector' && normalizedTopic === 'getting-started'
          ? (surface === 'connector' ? CLAUDE_CONNECTOR_GETTING_STARTED_HELP : CONNECTOR_GETTING_STARTED_HELP)
          : platformHelp(topic);
        const text = constrainCanonicalText(banner + body + advisorHint, surface);
        record(text);
        return { content: [{ type: 'text', text }] };

      }
    },
  },
  {
    definition: {
    name: 'advisor',
    description: `Project-aware platform guidance. Unlike \`docs\` (the static manual for one surface), the advisor is loaded with the full platform reference AND — when \`project_id\` is supplied with sufficient authority — a live snapshot of that project (subdomain, attached custom domains + claim status, plan, env var names, deploy state). Without project authority it has no live snapshot.

Questions can span surfaces such as auth + payments + domains, or diagnose an integration error from the available evidence.

**project_id effect:** for project-specific questions about auth, custom domains, deploy state, payments, env-vars, billing, or broken redirect URIs, the advisor reads the authorized project's real configuration instead of relying on a generic example.

**Without project_id:** pure design questions ("how should I structure a multi-tenant SaaS?", "should I use jobs or queue for this?") receive general guidance without live project evidence.

**Examples:**

\`\`\`json
{
  "question": "I bought railtime.co.uk via domain_buy and OAuth keeps rejecting redirect_uri=https://railtime.co.uk/api/auth/google-callback. What's the actual fix?",
  "project_id": "railme"
}
\`\`\`

\`\`\`json
{ "question": "How should I structure auth + Google login + email verification + a Stripe paywall on one project?" }
\`\`\`

\`\`\`json
{ "question": "What's the right way to handle file uploads with image optimization?" }
\`\`\`

The response is plain markdown.`,
    inputSchema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'What you are trying to build, or how something works on the platform. One question per call. Detailed questions (the actual error message, the actual tool calls you tried, the actual project) get sharper answers.',
        },
        project_id: {
          type: 'string',
          description: "Optional. Project UUID, subdomain, or 'default'. When set, the advisor loads a live snapshot of the project (subdomain, attached domains, plan, env var names, deploy state) and answers against THAT project's real state instead of generic docs. Strongly recommended for any question that mentions a specific project.",
        },
        context: {
          type: 'object',
          description: 'Optional client-side diagnostic context: a linked project reference, redacted last command result, and optionally a redacted file excerpt. This is untrusted data only. It never grants authority or enables tool calls.',
          additionalProperties: false,
          properties: {
            project_ref: { type: 'string' },
            last_run: {
              type: 'object',
              additionalProperties: false,
              properties: {
                command: { type: 'string' }, args: { type: 'array', items: { type: 'string' } }, exit_code: { type: 'number' },
                stdout_tail: { type: 'string' }, stderr_tail: { type: 'string' }, timestamp: { type: 'string' },
              },
              required: ['command', 'args', 'exit_code', 'stdout_tail', 'stderr_tail', 'timestamp'],
            },
            file: {
              type: 'object', additionalProperties: false,
              properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'],
            },
          },
        },
      },
      required: ['question'],
    },
  },
    annotations: { title: 'Ask a platform engineer', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    group: 'help',
    core: true,
    coreRank: 2,
    visibility: 'authenticated',
    paid: true,
    surfaces: ["full","chatgpt"],
    protocol: { oauthScopes: ['mcp'] },
    execute: async (runtime, args) => {
      const { env, authHeader, ctx, caller, surface, helpSessionId } = runtime;
      {
        const startedAt = Date.now();
        const question = typeof args.question === 'string' ? args.question.trim() : '';
        if (!question) {
          return {
            content: [{ type: 'text', text: 'advisor requires a non-empty `question` string.' }],
            isError: true,
          };
        }
        // project_id is resolved upstream of this switch when it's a
        // non-empty string, so by the time we get here it's either a
        // resolved UUID or absent. The advisor uses it to load a live
        // project snapshot as untrusted context.
        const clientContext = sanitizeAdvisorContext(args.context);
        const projectIdArg = typeof args.project_id === 'string' && args.project_id.length > 0
          ? args.project_id
          : clientContext?.project_ref ?? null;
        const contextText = formatAdvisorContext(clientContext);
        const answer = await callPlatformAdvisor(env, authHeader, question, projectIdArg, surface, caller, 'authenticated', 'default', contextText);
        const constrainedAnswer = {
          ...answer,
          text: constrainCanonicalText(answer.text, surface),
        };
        if (constrainedAnswer.failure_code) {
          console.error('[advisor] returning typed fallback:', constrainedAnswer.failure_code);
        }
        // Logging must not block the response. Use waitUntil so the
        // upstream service-binding fetch survives past the response
        // return — without it the runtime cancels the in-flight
        // promise and the row never lands.
        const logPromise = logAdvisorQuery(env, authHeader, question, constrainedAnswer, 'authenticated', 'mcp', {
          surface: advisorAuditSurface(`mcp:${surface}`, constrainedAnswer),
          sessionId: helpSessionId,
          projectId: projectIdArg,
          latencyMs: Date.now() - startedAt,
          contextAttached: contextText !== null,
          contextText,
        });
        if (ctx) ctx.waitUntil(logPromise); else void logPromise;
        return { content: [{ type: 'text', text: constrainedAnswer.text }] };

      }
    },
  },
  // ── project ─────────────────────────────────────────────
  {
    definition: {
    name: 'project_list',
    description: `My projects, my apps, my sites, my deployments, account inventory, dashboard overview — show every project I own or collaborate on. Each row includes \`is_owner\` so you can tell which is which.

**Compact + paginated by default** to keep the payload small: returns up to **50** projects with the core fields (id, name, subdomain, status, tags, created_at, last_deployed_at, latest_screenshot_url, favicon_url, is_owner). The render fields are included in this one response; screenshot/favicon URLs are null until their live-release asset exists. When more exist, the response ends with a note telling you the total and how to page. To narrow or expand: pass \`q\` (substring filter on name/subdomain), \`tag\` (organization label filter; pass multiple for AND semantics), \`limit\`/\`offset\` (paging), or \`fields:"full"\` for the complete record per row.

**Example:**

\`\`\`json
// project_list({ q: "saas", limit: 50 }) returns:
[
  { "id": "p_abc123", "name": "My SaaS", "subdomain": "my-saas", "status": "deployed", "last_deployed_at": "2026-04-01T...", "latest_screenshot_url": "https://api.somewhere.tech/v1/deploy-screenshots/p_abc123/v7-desktop.png?exp=...&sig=...", "favicon_url": "https://my-saas.somewhere.site/favicon.ico", "tags": ["marketing"], "is_owner": true },
  { "id": "p_xyz789", "name": "Jen's App", "subdomain": "jen-app", "status": "draft", "last_deployed_at": null, "latest_screenshot_url": null, "favicon_url": null, "tags": [], "is_owner": false }
]
\`\`\`

Shared projects: you can deploy, edit files, run db migrations, send email, and use AI — all billed to the project owner. You cannot delete, transfer, change env var values, or manage billing/spend caps on shared projects.`,
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Optional substring filter matched against project name and subdomain — use it to find a specific project instead of paging the whole list.' },
        tag: {
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description: 'Optional organization-tag filter. Tags normalize to lowercase letters, digits, and hyphens. Pass one tag or an array; arrays use AND semantics.',
        },
        limit: { type: 'number', description: 'Max rows to return (default 50). The list is compact and paginated so an agent gets a small payload; raise it or use `offset` to page when you own many projects.' },
        offset: { type: 'number', description: 'Row offset for paging (default 0). Combine with `limit` to walk a long list; the response note reports the total count.' },
        fields: { type: 'string', enum: ['compact', 'full'], description: 'Response shape. "compact" (default) returns identity, status, tags, render-ready asset URLs, deploy time, and ownership. "full" adds the complete project record — heavier; request it only when you need the extra fields.' },
      },
      required: [],
    },
    outputSchema: readOutputSchema({
      projects: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: ['string', 'null'] },
            subdomain: { type: ['string', 'null'] },
            slug: { type: ['string', 'null'] },
            status: { type: 'string' },
            last_deployed_at: { type: ['string', 'null'] },
            latest_screenshot_url: { type: ['string', 'null'] },
            favicon_url: { type: ['string', 'null'] },
            tags: { type: 'array', items: { type: 'string' } },
            is_owner: { type: 'boolean' },
            has_promoted: { type: 'boolean' },
            cloud_dev_allowed: { type: 'boolean' },
          },
          additionalProperties: true,
        },
      },
      deployed_count: { type: 'number' },
      tier: { type: 'string' },
      closest_matches: { type: 'array', items: { type: 'object', additionalProperties: true } },
    }),
  },
    annotations: { title: 'List your projects', readOnlyHint: true, idempotentHint: true },
    group: 'project',
    core: true,
    coreRank: 5,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","connector","chatgpt"],
    protocol: { surfaceDescriptions: { connector: "List a paginated set of projects owned by or shared with the connected Somewhere account. Returns identifiers, subdomains, and project status; optional filters narrow the list." }, oauthScopes: ['mcp'] },
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        // B3 (tsk_2dbb54c9): compact + paginated by default so an agent gets a
        // small payload. Forward q / limit / offset / fields to GET /v1/projects
        // and read X-Total-Count to tell the agent how to page. Raw fetch (not
        // callAPI) so we can read the response header.
        const params = new URLSearchParams();
        if (typeof args.q === 'string' && (args.q as string).length > 0) params.set('q', args.q as string);
        if (typeof args.tag === 'string' && (args.tag as string).length > 0) {
          params.append('tag', args.tag as string);
        } else if (Array.isArray(args.tag)) {
          for (const tag of args.tag) {
            if (typeof tag === 'string' && tag.length > 0) params.append('tag', tag);
          }
        }
        // Default to a 50-row compact page so a busy account (hundreds of
        // projects) doesn't blow the token budget — the original B3 complaint.
        // NOT a silent cap: when more rows exist we inject a `pagination` object
        // INTO the returned JSON (a trailing note gets dropped by clients that
        // parse the text as JSON) so the agent sees how many of how many it got.
        const limit = args.limit !== undefined && args.limit !== null && Number.isFinite(Number(args.limit))
          ? Number(args.limit) : 50;
        params.set('limit', String(limit));
        if (args.offset !== undefined && args.offset !== null && Number.isFinite(Number(args.offset))) {
          params.set('offset', String(Number(args.offset)));
        }
        params.set('fields', args.fields === 'full' ? 'full' : 'compact');
        const listResp = await fetcher.fetch(`https://api-internal/v1/projects?${params.toString()}`, {
          method: 'GET',
          headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
        });
        const listCt = listResp.headers.get('Content-Type') || '';
        if (!listCt.includes('application/json')) {
          const text = await listResp.text();
          if (listResp.status === 401 && bearerLooksLikeOAuthJwt(authHeader)) {
            throw new UpstreamOAuthRejectedError(text.slice(0, 200));
          }
          result = { status: listResp.status, data: { ok: false, error: 'UPSTREAM_ERROR', message: text.slice(0, 500) } };
          return result;
        }
        const listData = await listResp.json();
        if (listResp.status === 401 && bearerLooksLikeOAuthJwt(authHeader)) {
          const msg = (listData && typeof listData === 'object' && 'message' in listData && typeof (listData as { message?: unknown }).message === 'string')
            ? (listData as { message: string }).message
            : 'Upstream rejected the OAuth token.';
          throw new UpstreamOAuthRejectedError(msg);
        }
        // Find the projects array regardless of envelope shape: the worker body
        // is { ok, data: { projects, … } }; also accept a flat { projects } and a
        // bare array. Used to count + decide the pagination hint.
        const listObj = listData && typeof listData === 'object' ? (listData as Record<string, unknown>) : null;
        const listInner = listObj && listObj.data && typeof listObj.data === 'object' ? (listObj.data as Record<string, unknown>) : null;
        const projectsArr = Array.isArray(listData)
          ? (listData as unknown[])
          : listInner && Array.isArray(listInner.projects) ? (listInner.projects as unknown[])
          : listObj && Array.isArray(listObj.projects) ? (listObj.projects as unknown[])
          : null;
        if (listResp.status < 400 && projectsArr) {
          const totalHdr = listResp.headers.get('X-Total-Count');
          const total = totalHdr !== null && Number.isFinite(Number(totalHdr)) ? Number(totalHdr) : null;
          const more = (total !== null && total > projectsArr.length) || (total === null && projectsArr.length >= limit);
          if (more && listObj) {
            // Inject INTO the JSON so it survives clients that parse the text.
            listObj.pagination = {
              showing: projectsArr.length,
              total: total ?? undefined,
              more: true,
              hint: 'More projects exist — pass offset to page, q to filter by name/subdomain, tag to filter by organization label, or fields:"full" for the complete record.',
            };
          }
          return {
            content: [{ type: 'text', text: JSON.stringify(listData, null, 2) }],
            structuredContent: listObj ?? { ok: true, data: { projects: projectsArr } },
          };
        }
        result = { status: listResp.status, data: listData };
        return result;

      }
    },
  },
  {
    definition: {
    name: 'project_notice_acknowledge',
    description: `Mark a somewhere platform notice read or snooze its reminders for this maintainer. This only changes personal notice delivery; it never resolves the underlying project issue or grants any capability.

Use the project_id and notice_id supplied with the notice. A snooze defaults to 24 hours and accepts 1–720 whole hours.`,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project UUID, subdomain, or slug supplied with the notice.' },
        notice_id: { type: 'string', description: 'Notice identifier supplied in the notice delivery context.' },
        action: { type: 'string', enum: ['read', 'snooze'], description: 'Mark read permanently for this maintainer, or temporarily snooze reminders.' },
        snooze_hours: { type: 'number', description: 'Whole hours from 1 to 720. Used only with action "snooze"; defaults to 24.' },
      },
      required: ['project_id', 'notice_id', 'action'],
    },
  },
    annotations: { title: 'Read or snooze a platform notice', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    group: 'project',
    core: true,
    coreRank: 108,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","connector","chatgpt"],
    protocol: { surfaceAnnotations: { chatgpt: { destructiveHint: true }, connector: { destructiveHint: true } }, surfaceDescriptions: { connector: "Mark a project notice read or snooze its reminders for the connected user. This changes personal notice delivery; it does not resolve the underlying issue or change application code." }, oauthScopes: ['mcp'] },
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      const body: Record<string, unknown> = { action: args.action };
      if (args.snooze_hours !== undefined) body.snooze_hours = args.snooze_hours;
      return callAPI(
        fetcher,
        'POST',
        `/v1/projects/${encodeURIComponent(args.project_id as string)}/notices/${encodeURIComponent(args.notice_id as string)}/acknowledge`,
        authHeader,
        body,
      );
    },
  },
  {
    definition: {
    name: 'project_get',
    description: `Project details, app info, project record, settings, metadata — fetch one project by id, subdomain, or \`"default"\`. Returns the full project record.

**Example:**

\`\`\`json
{ "project_id": "my-saas" }
// or
{ "project_id": "default" }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
      },
      required: ['project_id'],
    },
    outputSchema: readOutputSchema({
      id: { type: 'string' },
      name: { type: ['string', 'null'] },
      description: { type: ['string', 'null'] },
      subdomain: { type: ['string', 'null'] },
      slug: { type: ['string', 'null'] },
      status: { type: 'string' },
      created_at: { type: ['string', 'number', 'null'] },
      is_owner: { type: 'boolean' },
      effective_role: { type: ['string', 'null'] },
      tags: { type: 'array', items: { type: 'string' } },
      has_custom_domain: { type: 'boolean' },
      cloud_dev_allowed: { type: 'boolean' },
      last_modified_via: { type: ['string', 'null'] },
      last_modified_at: { type: ['string', 'null'] },
    }),
  },
    annotations: { title: 'Read project details', readOnlyHint: true, idempotentHint: true },
    group: 'project',
    core: true,
    coreRank: 6,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","connector","chatgpt"],
    protocol: { surfaceDescriptions: { connector: "Read a Somewhere project record by ID, slug, or subdomain, including its current settings and release information." }, oauthScopes: ['mcp'] },
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'GET', `/v1/projects/${encodeURIComponent(args.project_id as string)}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'project_set_tags',
    description: `Set freeform organization tags on a project. Tags are labels for finding/filtering projects only; they have zero runtime, auth, routing, billing, deploy, or group meaning.

Tags normalize to lowercase \`a-z0-9-\`, max 32 characters each, max 10 per project. This replaces the full tag set with the normalized unique list and returns the saved tags.`,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project UUID from project_list/project_get. Owner-only.' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Freeform labels such as "client-a", "marketing", or "archive-ideas". Replaces the project tag set.',
        },
      },
      required: ['project_id', 'tags'],
    },
  },
    annotations: { title: 'Set project organization tags', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    group: 'project',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'PUT', `/v1/projects/${encodeURIComponent(args.project_id as string)}/tags`, authHeader, {
          tags: args.tags,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'project_allowed_origins_get',
    description: `Read a project's cross-origin allowlist (CORS allowed_origins) — the exact browser origins permitted to make credentialed cross-origin requests to the project's API.

Returns \`allowed_origins\` (the configured OTHER origins) plus \`cors_mode\`. A project always trusts its own origins (its \`.somewhere.site\` subdomain and verified custom domains); those are automatic and are NOT listed here. Use this to inspect the allowlist before changing it with \`project_allowed_origins_set\`.`,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side." },
      },
      required: ['project_id'],
    },
  },
    annotations: { title: 'Read project allowed origins (CORS)', readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    group: 'project',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'GET', `/v1/projects/${encodeURIComponent(args.project_id as string)}/allowed-origins`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'project_allowed_origins_set',
    description: `Set a project's cross-origin allowlist (CORS allowed_origins) — the exact browser origins permitted to make credentialed cross-origin requests to the project's API. This is the first-class way to fix a "cross-origin request blocked" / CORS error for a separate frontend origin from the CLI/MCP instead of the dashboard.

Owner-or-platform-admin only, and every change is audited. Replaces the FULL allowlist with the list you pass; send [] to clear it. Each entry must be an exact origin — scheme + host + optional port, no path/query/fragment and no wildcards (e.g. \`https://app.example.com\`, or \`http://localhost:5173\` for local development). Matching is byte-exact: a subdomain or a different port is a different origin and must be listed explicitly. You never need to list the project's own \`.somewhere.site\` origin or its verified custom domains — those are always trusted.

**Example:**

\`\`\`json
{ "project_id": "my-app", "allowed_origins": ["https://app.example.com", "http://localhost:5173"] }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side. Owner-or-platform-admin only." },
        allowed_origins: {
          type: 'array',
          items: { type: 'string' },
          description: 'Full replacement set of exact origins (scheme + host + optional port, no path or wildcards). Pass [] to clear the allowlist.',
        },
      },
      required: ['project_id', 'allowed_origins'],
    },
  },
    annotations: { title: 'Set project allowed origins (CORS)', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    group: 'project',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'PUT', `/v1/projects/${encodeURIComponent(args.project_id as string)}/allowed-origins`, authHeader, {
          allowed_origins: args.allowed_origins,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'project_create',
    description: `Create a new project / app / website / site — initialize a project with a subdomain to start building and hosting it. This is the first step for any new app: a web app, API, backend, landing page, SaaS, or full-stack site. Start here, then deploy source to it. The subdomain must be unique platform-wide and cannot use reserved names (api, admin, www, etc.). Projects and deploys are unlimited on all tiers. Returns the new project_id.

**Example:**

\`\`\`json
{ "name": "Acme Dashboard", "subdomain": "acme-dash", "description": "Internal team dashboard" }
// Returns: { "project_id": "p_xyz789" }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Display name for the project' },
        subdomain: { type: 'string', description: 'Optional subdomain — defaults to slugified name. Must be lowercase letters, digits, and hyphens.' },
        description: { type: 'string', description: 'Optional human-readable description' },
      },
      required: ['name'],
    },
  },
    annotations: { title: 'Create a new project', readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    group: 'project',
    core: true,
    coreRank: 7,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","connector","chatgpt"],
    protocol: { surfaceAnnotations: { connector: { destructiveHint: true } }, surfaceDescriptions: { connector: "Create a Somewhere project with a name and optional subdomain. Returns its identifier for deploying an app. This creates a project in the connected account." }, oauthScopes: ['mcp'] },
    execute: async (runtime, args) => {
      const { fetcher, env, authHeader, ctx, toolName } = runtime;
      let result: ToolUpstreamResult;
      {
        if (typeof args.name !== 'string' || !args.name.trim()) {
          return badArgsToolResult(
            env, authHeader, ctx, toolName, args,
            'project_create requires name.\nExample:\nproject_create({ "name": "Acme Dashboard", "subdomain": "acme-dashboard", "description": "Optional short description" })\nSubdomain is optional; omit it to let the platform generate one.',
          );
        }
        if (args.subdomain !== undefined && typeof args.subdomain === 'string' && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(args.subdomain)) {
          return badArgsToolResult(
            env, authHeader, ctx, toolName, args,
            'subdomain must use lowercase letters, digits, and hyphens, start/end with a letter or digit, and be 63 chars or less.\nExample:\nproject_create({ "name": "Acme Dashboard", "subdomain": "acme-dashboard" })\nOr omit subdomain and the platform will generate one from name.',
          );
        }
        result = await callAPI(fetcher, 'POST', '/v1/projects', authHeader, {
          name: args.name,
          subdomain: args.subdomain,
          description: args.description,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'project_delete',
    description: `Request deletion of a project. **Two-step flow.**

Step 1 — Call \`project_delete\` with just the project_id. The platform returns a 6-digit confirmation code that expires after 10 minutes. No project state changes before the code is confirmed.

Step 2 — Human authorization is required before calling \`project_delete_confirm\` with the same project_id and code. Confirmation immediately takes the project and its hostnames offline, blocks new project effects, retains its database, files, functions, environment variables, and domain bindings for 30 days, and schedules permanent erasure after that retention period. Recovery during the retention period requires support.

**Example:**

\`\`\`json
{ "project_id": "my-saas" }
\`\`\`

The response is a SUCCESS carrying the code and a machine-readable status, e.g. \`{ "ok": true, "status": "needs_confirmation", "confirmation_code": "482917", "code": "482917", "next_call": { "tool": "project_delete_confirm", ... } }\` — minting the code is this step's whole job, so it is never an error (tsk_7575b68a). Read \`confirmation_code\` (\`code\` is the same value, kept for existing callers). The response carries no \`error_code\` and no \`canonical_error\`, so branching on those stays a reliable failure test (tsk_bc73ace6).`,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
      },
      required: ['project_id'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    group: 'project',
    core: true,
    coreRank: 21,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","chatgpt"],
    protocol: { oauthScopes: ['mcp'] },
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        // First call in the two-step flow. Empty body → the API returns
        // CONFIRMATION_REQUIRED with a 6-digit `code` field. Human
        // authorization is required before project_delete_confirm.
        result = await callAPI(fetcher, 'DELETE', `/v1/projects/${encodeURIComponent(args.project_id as string)}`, authHeader, {});
        return result;

      }
    },
  },
  {
    definition: {
    name: 'project_delete_confirm',
    description: `Confirm project deletion using the 6-digit code returned by \`project_delete\`. Human authorization is required. Confirmation immediately takes the project and its hostnames offline, blocks new project effects, retains its database, files, functions, environment variables, and domain bindings for 30 days, and schedules permanent erasure after that retention period. Recovery during the retention period requires support.

**Example:**

\`\`\`json
{ "project_id": "my-saas", "code": "482917" }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        code: { type: 'string', description: '6-digit code returned by project_delete. Expires 10 minutes after it was issued.' },
      },
      required: ['project_id', 'code'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    group: 'project',
    core: true,
    coreRank: 22,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","chatgpt"],
    protocol: { surfaceAnnotations: { chatgpt: { openWorldHint: true } }, oauthScopes: ['mcp'] },
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'DELETE', `/v1/projects/${encodeURIComponent(args.project_id as string)}`, authHeader, { code: args.code });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'project_archive',
    description: 'Archive a project. Hides it from your project list and revokes its subdomain. All data is preserved and can be restored with project_unarchive.',
    inputSchema: { type: 'object', properties: { project_id: { type: 'string', description: 'Project ID' } }, required: ['project_id'] },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    group: 'project',
    core: true,
    coreRank: 78,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","chatgpt"],
    protocol: { surfaceAnnotations: { chatgpt: { destructiveHint: true, openWorldHint: true } }, oauthScopes: ['mcp'] },
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', `/v1/projects/${encodeURIComponent(args.project_id as string)}/archive`, authHeader, {});
        return result;

      }
    },
  },
  {
    definition: {
    name: 'project_unarchive',
    description: 'Restore an archived project back to a preview state, with no public subdomain. All data is preserved.',
    inputSchema: { type: 'object', properties: { project_id: { type: 'string', description: 'Project ID' } }, required: ['project_id'] },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    group: 'project',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', `/v1/projects/${encodeURIComponent(args.project_id as string)}/unarchive`, authHeader, {});
        return result;

      }
    },
  },
  {
    definition: {
    name: 'project_rename',
    description: `Rename a project or update its description.

**Example:**

\`\`\`json
{ "project_id": "p_abc123", "name": "Acme Portal v2", "description": "Updated customer portal" }
\`\`\``,
    inputSchema: { type: 'object', properties: { project_id: { type: 'string', description: 'Project ID' }, name: { type: 'string', description: 'New name' }, description: { type: 'string', description: 'New description (optional)' }, placement: { type: 'string', enum: ['near-user', 'near-data'], description: "Where this project's functions RUN. 'near-user' (the default) runs them closest to each visitor and reaches across the network to the database, so every query costs a round trip. 'near-data' runs them next to the database instead: one hop from the visitor, then near-free queries. Choose 'near-data' for query-heavy pages whose visitors are concentrated, or where a page issues reads it cannot batch; keep 'near-user' for anything latency-sensitive that barely touches the database. Takes effect on the next deploy, so an already-published version never changes underneath you." } }, required: ['project_id'] },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    group: 'project',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'PATCH', `/v1/projects/${encodeURIComponent(args.project_id as string)}`, authHeader, {
          name: args.name, description: args.description, placement: args.placement,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'project_update',
    description: `Update a project's name, description, or function placement.

**Example:**

\`\`\`json
{ "project_id": "p_abc123", "placement": "near-data" }
\`\`\``,
    inputSchema: { type: 'object', properties: { project_id: { type: 'string', description: 'Project ID' }, name: { type: 'string', description: 'New name' }, description: { type: 'string', description: 'New description (optional)' }, placement: { type: 'string', enum: ['near-user', 'near-data'], description: "Where this project's functions RUN. 'near-user' (the default) runs them closest to each visitor and reaches across the network to the database, so every query costs a round trip. 'near-data' runs them next to the database instead: one hop from the visitor, then near-free queries. Choose 'near-data' for query-heavy pages whose visitors are concentrated, or where a page issues reads it cannot batch; keep 'near-user' for anything latency-sensitive that barely touches the database. Takes effect on the next deploy, so an already-published version never changes underneath you." } }, required: ['project_id'] },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    group: 'project',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'PATCH', `/v1/projects/${encodeURIComponent(args.project_id as string)}`, authHeader, {
          name: args.name, description: args.description, placement: args.placement,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'project_deploy',
    description: `Deploy / ship / host / push / release your app — upload raw source (HTML, CSS, JS, server functions) to a project and put it in production at \`https://{subdomain}.somewhere.site\`. The platform compiles your code; you deploy source, not a build.

**If you can run a shell, LEAD WITH the CLI: \`somewhere deploy\` reads files straight from disk (no inline JSON payload) and is the faster path. Install: \`npm i -g @somewhere-tech/cli && somewhere auth login\` (shares MCP auth). This MCP tool is the inline fallback — for agents without shell access, small projects, or when the CLI isn't available.**

**For UPDATES to an existing project, prefer \`project_patch\` with \`find\`/\`replace\` — surgical edits ship in ~200 bytes instead of resending every file. Use \`project_deploy\` for the FIRST deploy of a new project, or when you genuinely want to replace the whole tree.**

**Large or binary files — reference, don't paste.** Instead of inlining a big asset's content (or base64 bytes) into \`files\`, write it to project file storage first with \`fs_write\`, then reference it by storage path via \`file_refs\` (text files) or \`binary_file_refs\` (images, fonts, other binaries). The platform resolves the referenced content server-side at deploy time, so a big tree ships without a giant inline payload. Inline \`files\`/\`functions\` keep working and can be mixed with refs in the same deploy.

Deploys your app. The result lands at \`https://{subdomain}.somewhere.site\` and on any verified custom domain — every deploy reaches production.

⚠️ **Omitted items are NOT all treated the same.** Static **\`files\`** are full-replacement: anything you omit from \`files\` is deleted (pass \`scope:"functions"\` to leave static untouched). **\`functions\`** are **merge-preserved by default**: a function already in production but omitted from this call is KEPT, not deleted — so you can ship a backend-only change without resending the frontend, and \`project_patch\`-only functions survive a later full deploy. Pass \`replace_functions:true\` only when you intend a deploy to delete functions you no longer ship. (Env vars, database, and uploaded \`fs\` files are never affected.) Use \`dry_run:true\` to inspect exactly what will be added / removed / modified before anything is written.

Server-side functions are the core — handler code goes in the **\`functions\`** map (keyed by path, e.g. \`"api/hello.ts"\`) and becomes routable at \`/api/...\` on your production URL. The **\`files\`** map is for STATIC assets only (HTML, CSS, client-side JS, images). **Do not put handler code (\`api/*\`, \`_lib/*\`, root \`[id].ts\` routes) in \`files\`** — a static asset never routes, so \`/api/*\` would just serve your app's HTML. (As a safety net the deploy auto-routes any handler-shaped path it finds in \`files\` into \`functions\` and returns a loud warning, but put it in \`functions\` to begin with.)

**Function signature — the only one that works:**

\`\`\`js
export default async function (req, sw) {
  const r = await sw.db.query('SELECT * FROM users WHERE id = ?', [id]);
  // r.data    = array of rows  (NOT .rows, NOT .results)
  // r.count   = row count
  // r.changes = rows affected on INSERT/UPDATE/DELETE
  return Response.json({ user: r.data[0] ?? null });
}
\`\`\`

\`sw.endpoint({ auth, body, rateLimit, handler })\` is an OPTIONAL wrapper (adds zod validation + rate limit + auth helper); the bare \`export default async function(req, sw)\` form above always works and is what to reach for when in doubt.

Functions run directly on the platform with access to \`sw.db\` (database), \`sw.fs\` (file storage), \`sw.email\` (send email), \`sw.ai\` (AI models), \`sw.env\` (environment variables), \`sw.jobs\` (background jobs), \`sw.queue\`, and \`sw.logs\`. \`sw.db\` uses the function's authenticated project binding, so application code does not send a developer API key or construct a platform HTTP request. First-use activation, placement, transport, scheduling, and engine work can still contribute to latency. \`sw.db.batch([{sql, params}, ...])\` runs multiple statements as one atomic transaction; any failure rolls every statement back. (\`ctx\` is the legacy alias — same object, both names work forever.)

**Conflict check (optional).** \`expected_version\` accepts three shapes:
- omit, or pass \`"latest"\` — no concurrency check; the platform auto-resolves to current+1. Use this when you don't know or don't care about the current version (most agent flows).
- a number — strict optimistic-concurrency CAS. If the production version doesn't match, returns 409 \`VERSION_CONFLICT\` with \`data.current_version\` so you can refetch and retry. Use only on collaborated projects where you genuinely want to detect concurrent deploys.

**Stale-base guard (optional, recommended when editing from an exported/read version).** Pass \`base_version\` from your last deploy/export response. If the project changed elsewhere since then, deploy returns 409 \`STALE_BASE\` with \`data.changed_files\`, \`data.last_change_source\`, and \`data.last_change_at\`. On \`STALE_BASE\`, call \`project_diff_versions\` before forcing; pass \`force:true\` only after reviewing the remote changes.

The success response always includes the new \`version\`. When available, it may also include \`_runtime_key_summary\`, a plain-language note on whether the runtime key for this deploy was narrowed to least-privilege scopes or fell back to blanket access.

**Example:**

\`\`\`json
{
  "project_id": "my-saas",
  "files": {
    "index.html": "<!DOCTYPE html><html><body><h1>Hello</h1></body></html>"
  },
  "functions": {
    "api/hello.ts": "export default async (req, sw) => Response.json({ ok: true })",
    "api/users/signup.ts": "export default async (req, sw) => {\\n  const body = await req.json();\\n  await sw.db.query('INSERT INTO users(email) VALUES (?)', [body.email]);\\n  return Response.json({ ok: true });\\n}"
  }
}
\`\`\`

Handler code goes in \`functions\`; static assets (here, \`index.html\`) go in \`files\`.

The default workflow has one environment: read production source, check, deploy once, then verify the public production URL. \`somewhere preview\` is an optional advanced capability; do not use preview inputs unless the user explicitly says the account is on Pro or Scale with preview enabled.`,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        files: {
          type: ['object', 'array'],
          additionalProperties: { type: 'string' },
          items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
          description: 'Map of STATIC file paths to content, e.g. {"index.html": "<html>..."}. A native object is preferred; an array of {path, content} is also accepted. Static assets only — HTML, CSS, client-side JS, etc. Handler code (api/*, _lib/*, root [id].ts routes) does NOT belong here; it goes in `functions` so it routes. (A handler-shaped path found here is auto-routed into `functions` with a loud warning, but place it in `functions` directly.) Object value preferred; a JSON-stringified object is also accepted. Required for a full deploy; may be omitted with scope:\'functions\' when only functions are supplied.',
        },
        functions: {
          type: ['object', 'array'],
          additionalProperties: { type: 'string' },
          items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
          description: 'Map of function paths to ES-module source code. A native object is preferred; an array of {path, content} is also accepted. Files under api/ become routable at /api/.... Each file can default-export a single handler or export method-named (GET, POST, ...) handlers. The handler receives `(request, sw)`; `sw.env` carries env vars set via env_set, which take effect on the NEXT deploy (existing running functions keep their deployed values). (`ctx` is the legacy alias for `sw` — same object, both names work forever.) Object value preferred; a JSON-stringified object is also accepted.',
        },
        binary_files: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Optional map of binary asset paths to base64 content. Include the complete map when creating an exact preview snapshot.',
        },
        file_refs: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Optional. Map of deploy path → project file-storage path for TEXT files you would otherwise inline, e.g. {"index.html": "/staged/index.html"}. The platform reads the referenced content from file storage server-side at deploy time, so a large tree ships without a giant inline payload. Write the source with `fs_write` first. Mixable with inline `files`. Object value preferred; a JSON-stringified object is also accepted.',
        },
        binary_file_refs: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Optional. Same as `file_refs` but for BINARY assets (images, fonts, other non-text), e.g. {"public/logo.png": "/uploads/logo.png"} — never base64 a binary into `files`. The platform resolves the referenced bytes from file storage at deploy time. Object value preferred; a JSON-stringified object is also accepted.',
        },
        replace_functions: { type: 'boolean', description: 'Optional. When true, the `functions` map is AUTHORITATIVE: any function live in the project but NOT in this payload is DELETED (its route 404s after). Default false = merge-preserve — omitted functions are KEPT, so a full deploy from a partial source tree cannot silently drop a function added via project_patch. Set true when you deliberately want to remove functions you no longer ship.' },
        expected_version: { oneOf: [{ type: 'number' }, { type: 'string', enum: ['latest'] }], description: 'Optional optimistic-concurrency check. Accepts a `number` (strict CAS — returns 409 VERSION_CONFLICT if the production version differs) or the string `"latest"` (or omit entirely — auto-resolves to current version, no check). Default is omitted = auto-resolve. Use the strict numeric form only on collaborated projects where you want to detect concurrent deploys.' },
        base_version: { type: 'number', description: 'Optional stale-base guard. Pass the version from your last deploy/export response. A 409 STALE_BASE means the project changed elsewhere — call project_diff_versions before forcing.' },
        base_release_id: { type: 'string', description: 'Production release source anchor for an exact preview snapshot. Required when expected_preview_id is null. This field is part of the advertised exact-preview schema.' },
        force: { type: 'boolean', description: 'Optional. Bypasses a STALE_BASE refusal after you have reviewed the remote changes. Do not use on the first retry; call project_diff_versions first.' },
        dry_run: { type: 'boolean', description: 'Optional. When true, compute the diff (added / modified / removed file lists, function diff, version conflict) and return it WITHOUT writing anything. Use before a real deploy to catch "I am deploying from the wrong directory" mistakes — surfaces every file that would be deleted so an empty / stale source tree can\'t silently wipe production. Response shape: { dry_run: true, static_files: { added, modified, removed, *_count }, functions: { added, removed, modified } | null, warnings: string[], version_conflict: boolean }.' },
        scope: { type: 'string', enum: ['all', 'functions', 'static'], description: 'Optional partial-deploy guard. "all" (default) deploys static + functions. "functions" deploys ONLY functions and leaves static untouched — use it for a backend-only deploy so it can never wipe the frontend. "static" is the inverse (only static, functions untouched). Omitted functions are still merge-preserved by default regardless of scope.' },
        preview: { type: 'boolean', description: 'Advanced — `somewhere preview` only. Requires a Pro or Scale plan plus explicit platform enablement; otherwise returns CLOUD_DEV_NOT_ENABLED before creating resources. Default false: deploy directly to production. Do not set this unless the user says preview is enabled.' },
        preview_session_id: { type: 'string', description: 'Stable editing-session id for this preview lineage. Required with preview:true.' },
        preview_operation_id: { type: 'string', description: 'Stable idempotency id for this exact preview build/retry.' },
        expected_preview_id: { type: ['string', 'null'], description: 'Exact current preview id, or null for the first preview.' },
        draft: { type: 'boolean', description: 'Deprecated compatibility alias for preview. Existing callers remain supported; new callers should use preview.' },
        draft_id: { type: 'string', description: 'Deprecated compatibility alias for preview_session_id.' },
        draft_operation_id: { type: 'string', description: 'Deprecated compatibility alias for preview_operation_id.' },
        expected_candidate_release_id: { type: ['string', 'null'], description: 'Deprecated compatibility alias for expected_preview_id.' },
      },
      required: ['project_id'],
    },
  },
    annotations: { title: 'Deploy raw source', readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    group: 'project',
    core: true,
    coreRank: 8,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","connector","chatgpt"],
    protocol: { surfaceDescriptions: { connector: "Deploy raw application source to a Somewhere project and publish it at its live URL. The platform compiles the source and applies a declared db/schema.ts. The files argument contains source paths and contents, not compiled output. This can replace existing source and change the live app; project_patch updates selected files while preserving the rest. See https://somewhere.tech/docs.txt for the Somewhere deployment API contract." }, oauthScopes: ['mcp'], surfaceAnnotations: { chatgpt: { destructiveHint: true, openWorldHint: true }, connector: { destructiveHint: true } } },
    execute: async (runtime, args) => {
      const { fetcher, env, authHeader, ctx, toolName } = runtime;
      let result: ToolUpstreamResult;
      {
        const scope = args.scope === 'all'
          || args.scope === 'functions'
          || args.scope === 'static'
          ? args.scope
          : undefined;
        const rawFiles = args.files !== undefined ? parseJsonArg(args.files, 'files') : undefined;
        const filesResult = rawFiles !== undefined ? coerceStringMap(rawFiles, 'files') : { ok: true as const, value: undefined };
        if (!filesResult.ok) {
          return badArgsToolResult(
            env, authHeader, ctx, toolName, args,
            `${filesResult.message}\nExample:\nproject_deploy({ "project_id": "my-app", "files": { "index.html": "<!doctype html><html></html>" } })\nFor server handlers, put source in "functions": { "api/hello.ts": "export default async function (req, sw) { return Response.json({ ok: true }); }" }.`,
          );
        }
        const functions = args.functions
          ? parseJsonArg(args.functions, 'functions')
          : undefined;
        if (functions !== undefined) {
          const functionsResult = coerceStringMap(functions, 'functions');
          if (!functionsResult.ok) {
            return badArgsToolResult(
              env, authHeader, ctx, toolName, args,
              `${functionsResult.message}\nExample:\nproject_deploy({ "project_id": "my-app", "files": { "index.html": "<!doctype html><html></html>" }, "functions": { "api/hello.ts": "export default async function (req, sw) { return Response.json({ ok: true }); }" } })\nEach map value must be source code as a string.`,
            );
          }
          args.functions = functionsResult.value;
        }
        const rawBinaryFiles = args.binary_files !== undefined
          ? parseJsonArg(args.binary_files, 'binary_files')
          : undefined;
        const binaryFilesResult = rawBinaryFiles !== undefined
          ? coerceStringMap(rawBinaryFiles, 'binary_files')
          : { ok: true as const, value: undefined };
        if (!binaryFilesResult.ok) {
          return badArgsToolResult(
            env,
            authHeader,
            ctx,
            toolName,
            args,
            binaryFilesResult.message,
          );
        }
        const normalizedFiles = normalizeProjectDeployFiles(
          filesResult.value,
          args.functions,
          scope === 'all' ? undefined : scope,
        );
        if (!normalizedFiles.ok) {
          return badArgsToolResult(env, authHeader, ctx, toolName, args, normalizedFiles.message);
        }
        const files = normalizedFiles.files;
        const replaceFunctions = args.replace_functions === true || args.replace_functions === 'true';
        const replaceFunctionForward = replaceFunctions ? { replace_functions: true } : {};
        // Pass "latest" through verbatim — the API normalizes it to auto-resolve
        // (deploy.ts). Number("latest") is NaN → JSON-serialized as null → the API
        // rejects it as a non-integer, so the schema-advertised "latest" never
        // worked via the connector (audit 2026-06-16 #6 / tsk_7cda7b01).
        const expectedVersion = args.expected_version === 'latest'
          ? 'latest'
          : args.expected_version !== undefined && args.expected_version !== null
            ? Number(args.expected_version) : undefined;
        const baseVersionResult = coerceBaseVersionArg(args.base_version);
        if (!baseVersionResult.ok) {
          return badArgsToolResult(env, authHeader, ctx, toolName, args, baseVersionResult.message);
        }
        const baseVersion = baseVersionResult.value;
        const force = args.force === true || args.force === 'true';
        const dryRun = args.dry_run === true;
        const preview = args.preview === true || args.preview === 'true'
          || args.draft === true || args.draft === 'true';
        if ((typeof args.preview_session_id === 'string' && typeof args.draft_id === 'string'
              && args.preview_session_id !== args.draft_id)
            || (typeof args.preview_operation_id === 'string' && typeof args.draft_operation_id === 'string'
              && args.preview_operation_id !== args.draft_operation_id)
            || (Object.prototype.hasOwnProperty.call(args, 'expected_preview_id')
              && Object.prototype.hasOwnProperty.call(args, 'expected_candidate_release_id')
              && args.expected_preview_id !== args.expected_candidate_release_id)) {
          return badArgsToolResult(
            env,
            authHeader,
            ctx,
            toolName,
            args,
            'Canonical preview fields and their deprecated aliases must match when both are sent.',
          );
        }
        const previewSessionId = typeof args.preview_session_id === 'string'
          ? args.preview_session_id
          : args.draft_id;
        const previewOperationId = typeof args.preview_operation_id === 'string'
          ? args.preview_operation_id
          : args.draft_operation_id;
        const hasExpectedPreview = Object.prototype.hasOwnProperty.call(args, 'expected_preview_id')
          || Object.prototype.hasOwnProperty.call(args, 'expected_candidate_release_id');
        const expectedPreviewId = Object.prototype.hasOwnProperty.call(args, 'expected_preview_id')
          ? args.expected_preview_id
          : args.expected_candidate_release_id;
        // F5 (tsk_2dbb54c9): content-reference deploy. Instead of pasting big
        // inline payloads, reference files already in project file storage by
        // path; the worker resolves them server-side. file_refs = text files,
        // binary_file_refs = binary assets (images, fonts). Forwarded verbatim
        // (parsed if handed in as a JSON string). Inline files keep working.
        const fileRefs = args.file_refs
          ? parseJsonArg(args.file_refs, 'file_refs')
          : undefined;
        const binaryFileRefs = args.binary_file_refs
          ? parseJsonArg(args.binary_file_refs, 'binary_file_refs')
          : undefined;
        if (preview && (
          dryRun
          || scope !== 'all'
          || filesResult.value === undefined
          || binaryFilesResult.value === undefined
          || args.functions === undefined
          || !replaceFunctions
          || fileRefs !== undefined
          || binaryFileRefs !== undefined
          || typeof previewSessionId !== 'string'
          || !previewSessionId.trim()
          || typeof previewOperationId !== 'string'
          || !previewOperationId.trim()
          || !hasExpectedPreview
          || !(expectedPreviewId === null
            || typeof expectedPreviewId === 'string')
          || (expectedPreviewId === null
            && (typeof args.base_release_id !== 'string'
              || !args.base_release_id.trim()))
        )) {
          return badArgsToolResult(
            env,
            authHeader,
            ctx,
            toolName,
            args,
            'An exact preview starts from one complete snapshot. Pass preview:true, scope:"all", the complete files map, the complete binary_files map (use {} when there are none), the complete functions map (use {} when there are none), replace_functions:true, preview_session_id, preview_operation_id, expected_preview_id, and base_release_id for the first preview. Preview dry_run is unsupported. base_release_id must name the production release the snapshot was exported from. Inline the snapshot; file_refs and binary_file_refs are not accepted. Use project_patch with the exact current preview for later edits.',
          );
        }
        const deployBody: Record<string, unknown> = {
          project_id: args.project_id,
          files,
          ...(args.functions !== undefined ? { functions: args.functions } : {}),
          ...(binaryFilesResult.value !== undefined
            ? { binary_files: binaryFilesResult.value }
            : {}),
          ...(fileRefs !== undefined ? { file_refs: fileRefs } : {}),
          ...(binaryFileRefs !== undefined ? { binary_file_refs: binaryFileRefs } : {}),
          ...replaceFunctionForward,
          ...(expectedVersion !== undefined ? { expected_version: expectedVersion } : {}),
          ...(baseVersion !== undefined ? { base_version: baseVersion } : {}),
          ...(typeof args.base_release_id === 'string' && args.base_release_id.trim()
            ? { base_release_id: args.base_release_id.trim() }
            : {}),
          ...(force ? { force: true } : {}),
          ...(dryRun ? { dry_run: true } : {}),
          ...(scope ? { scope } : {}),
          ...(preview ? { preview: true } : {}),
          ...(typeof previewSessionId === 'string' ? { preview_session_id: previewSessionId } : {}),
          ...(typeof previewOperationId === 'string'
            ? { preview_operation_id: previewOperationId }
            : {}),
          ...(hasExpectedPreview
            ? { expected_preview_id: expectedPreviewId }
            : {}),
          source: 'mcp',
        };
        result = await callAPI(fetcher, 'POST', '/v1/deploy', authHeader, deployBody);
        if (result.status < 400 && result.data && typeof result.data === 'object' && !dryRun) {
          (result.data as Record<string, unknown>).tip =
            "For faster deploys, use the CLI: write files to disk, then run 'somewhere deploy'. Same auth, no JSON payload needed. Install: npm i -g @somewhere-tech/cli";
        }
        // Presence-detection for the runtime key least-privilege scopes the worker
        // does not send yet (tsk_6e5abf9e). No-op until the worker ships
        // runtime_key_scopes/runtime_key_scoped — once it does, this surfaces the
        // narrowing (or lack thereof) without any further MCP-side change.
        if (result.status < 400 && result.data && typeof result.data === 'object' && !dryRun) {
          const deployData = result.data as Record<string, unknown>;
          if (Array.isArray(deployData.runtime_key_scopes)) {
            const scopes = deployData.runtime_key_scopes as string[];
            const scoped = deployData.runtime_key_scoped === true;
            deployData._runtime_key_summary = scoped
              ? `Runtime key narrowed to: ${scopes.join(', ')}`
              : `Runtime key granted BLANKET access (${scopes.join(', ')}) — the platform couldn't enumerate which sw.* surfaces your function uses (common causes: sw/ctx captured into another variable, or no function source at this deploy). Full account access, not least-privilege.`;
          }
        }
        return result;

      }
    },
  },
  {
    definition: {
    name: 'project_patch',
    description: `Edit / change / update / modify / fix / tweak a file in a deployed project — **edit one deployed file in place** with a find/replace or a full-file rewrite. The right tool for visual-editor iteration (Claude Design, Cursor) and any quick code change. Unchanged files are preserved; only what you send is touched. Static changes reach production in ~1 second; function changes in 2–4 seconds.

Prefer this over \`project_deploy\` when editing an existing project — \`project_deploy\` replaces the whole tree and forces you to re-send unchanged files. Use \`project_deploy\` only for the first deploy of a brand-new project.

**Two modes — same tool.**

**1. Find / replace (token-optimal, preferred for small edits):** pass \`path\` + \`find\` + \`replace\`. The platform reads the current file, replaces every occurrence of \`find\` with \`replace\`, and writes it back. ~200 bytes on the wire instead of re-sending the whole file.

\`\`\`json
{ "project_id": "my-saas", "path": "index.html", "find": "<h1>Pricing</h1>", "replace": "<h1>Plans &amp; pricing</h1>" }
\`\`\`

If \`find\` doesn't match the file, you get a 400 \`FIND_NOT_FOUND\` that includes the **closest-matching region of the file** ("did you mean this region?", with offset and a 0–1 similarity score in the \`confidence\` field, under \`data.closest_match\`) plus a head/tail snippet — copy your \`find\` exactly from that region and retry. One round-trip, no need to re-read the whole file.

**2. Full content (rewriting the file):** pass \`path\` + \`content\`. The new bytes replace the file entirely.

\`\`\`json
{ "project_id": "my-saas", "path": "styles.css", "content": "body { background: black }" }
\`\`\`

Path auto-routes: \`api/*\`, \`_lib/*\`, and root \`[id].ts\` paths go to functions; everything else (HTML, CSS, SVG, JSON, etc.) to static. Binary assets (images, fonts) use the matching binary surface — don't try to ship raw bytes through \`content\` or \`find\`/\`replace\`.

**Delete:** \`delete_files\` is an array of paths. Works for static files and functions; missing paths are silently ignored. To rename or replace a file atomically, combine one \`path\` + \`content\` write (or the one-entry \`files\` alias) with \`delete_files\` in the same call: the new file and removals publish as one patch transaction.

**Conflict check (optional, recommended for shared projects):** pass \`base_version\` from your last deploy/export response. If another deployer landed changes since, returns 409 \`STALE_BASE\` with \`data.changed_files\`, \`data.last_change_source\`, and \`data.last_change_at\` instead of overwriting. On \`STALE_BASE\`, call \`project_diff_versions\` before forcing; pass \`force:true\` only after reviewing the remote changes. The older \`expected_version\` strict CAS still works and returns \`VERSION_CONFLICT\` when the production version differs.

**Preview first (optional):** pass \`dry_run: true\` to get a per-file unified diff of what the patch WOULD change (\`data.diffs\`), plus added/modified/removed lists — nothing is written and the version doesn't change. Re-send without \`dry_run\` to apply.

**Safety net — what IS and is NOT checked.** A patch that touches **page-rendering files (HTML/JS/CSS)** is blank-page health-checked after it goes live: if it blanked a previously-rendering page, the patch is automatically rolled back and you get a 400 \`DEPLOY_BLANK_PAGE\` with \`data.rolled_back\`. Pages that were already blank before the patch are never blocked.

A **function-only patch** (\`api/*\`, \`_lib/*\`, root \`[id].ts\`) is NOT blank-page-checked, and it does NOT get "the same protection as a full deploy." After a function patch the response carries a best-effort \`function_health\` field — \`{ checked, status, ok }\` from one GET of a patched route. \`function_health.ok === false\` means the route returned a 5xx (e.g. a missing import → 500): your edit shipped but is broken in production. If \`function_health.checked === false\` the route couldn't be probed (no concrete route, browser unavailable) — it was NOT verified, so confirm it yourself. A clean build is NOT a working function; only \`function_health.ok === true\` (or your own request to the route) confirms it runs.

For a risky edit, use \`dry_run:true\` and \`project_check\`, then patch once and verify the public production URL. \`project_rollback\` restores the previous production version if needed.

Patches reach production immediately at \`https://{subdomain}.somewhere.site\`. The success response includes the new \`version\`, a \`next_step\`, \`function_errors\` (build failures) and, for function patches, \`function_health\` (runtime 5xx). Preview is advanced and must not be selected unless the user explicitly says the account is enabled.`,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        path: { type: 'string', description: 'File path relative to project root (e.g. "api/hello.ts" or "index.html"). Required for both content and find/replace modes.' },
        content: { type: 'string', description: 'Full file content. Pair with `path`. Replaces the file entirely. Use this when you are rewriting most of the file; use `find`/`replace` for small edits.' },
        find: { type: 'string', description: 'Find/replace mode: exact substring to match in the deployed file. Pair with `path` and `replace`. All occurrences are replaced. Mutually exclusive with `content`.' },
        replace: { type: 'string', description: 'Find/replace mode: substring to substitute. Pair with `path` and `find`.' },
        delete_files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Paths to remove. Works for static files and functions. Paths not present are ignored.',
        },
        files: {
          type: ['object', 'array'],
          additionalProperties: { type: 'string' },
          items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
          description: 'Forgiving single-file alias. If you pass exactly one {"path": "content"} entry (or one {path, content} item), MCP converts it to path+content. It may be combined with delete_files for one atomic add-and-remove transaction. Multiple entries are rejected with an example; use project_deploy for a full replacement tree or call project_patch once per file.',
        },
        expected_version: { type: 'number', description: 'Optional optimistic-concurrency check. Set to the `version` from your last deploy/patch response. If another deployer changed the project since, returns 409 VERSION_CONFLICT with `data.current_version` instead of overwriting.' },
        base_version: { type: 'number', description: 'Optional stale-base guard. Pass the version from your last deploy/export response. A 409 STALE_BASE means the project changed elsewhere — call project_diff_versions before forcing.' },
        base_release_id: { type: 'string', description: 'Required for a project with a production release. Pass the `active_release_id` returned by the same project read/export that supplied the source you edited. A missing base fails closed; a stale base returns STALE_RELEASE_BASE without applying the patch.' },
        force: { type: 'boolean', description: 'Optional. Bypasses a STALE_BASE refusal after you have reviewed the remote changes. Do not use on the first retry; call project_diff_versions first.' },
        dry_run: { type: 'boolean', description: 'Preview without writing: returns per-file unified diffs of what the patch WOULD change (`data.diffs`) plus added/modified/removed lists. Nothing is written, the version does not change. Re-send without dry_run to apply.' },
        preview: { type: 'boolean', description: "Advanced — `somewhere preview` only. Requires a Pro or Scale plan plus explicit platform enablement; otherwise returns CLOUD_DEV_NOT_ENABLED before creating resources. Default false: patch production. Do not set this unless the user says preview is enabled." },
        preview_session_id: { type: 'string', description: 'Stable editing-session id for this preview lineage. Required with preview:true.' },
        preview_operation_id: { type: 'string', description: 'Stable idempotency id for this exact preview build/retry.' },
        expected_preview_id: { type: ['string', 'null'], description: 'Exact current preview id, or null for the first preview.' },
        draft_id: { type: 'string', description: 'Deprecated compatibility alias for preview_session_id.' },
        draft_operation_id: { type: 'string', description: 'Deprecated compatibility alias for preview_operation_id.' },
        expected_candidate_release_id: { type: ['string', 'null'], description: 'Deprecated compatibility alias for expected_preview_id.' },
      },
      required: ['project_id'],
    },
  },
    annotations: { title: 'Edit project files', readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    group: 'project',
    core: true,
    coreRank: 9,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","connector","chatgpt"],
    protocol: { surfaceDescriptions: { connector: "Update selected source files in an existing Somewhere project and deploy the changes. Supports full file contents, find/replace edits, and explicit file deletion; other files are preserved. This changes the live application. See https://somewhere.tech/docs.txt for the Somewhere project patch contract." }, oauthScopes: ['mcp'], surfaceAnnotations: { chatgpt: { destructiveHint: true, openWorldHint: true }, connector: { destructiveHint: true } } },
    execute: async (runtime, args) => {
      const { fetcher, env, authHeader, ctx, toolName } = runtime;
      let result: ToolUpstreamResult;
      {
        const parseMaybe = (v: unknown, name: string) =>
          v === undefined || v === null ? undefined
          : parseJsonArg(v, name);
        if (args.files !== undefined && args.path === undefined && args.content === undefined && args.find === undefined) {
          const rawPatchFiles = parseMaybe(args.files, 'files');
          const patchFiles = coerceStringMap(rawPatchFiles, 'files');
          if (!patchFiles.ok) {
            return badArgsToolResult(
              env, authHeader, ctx, toolName, args,
              `${patchFiles.message}\nExample:\nproject_patch({ "project_id": "my-app", "path": "index.html", "content": "<!doctype html><html></html>" })\nproject_patch edits one file per call; use project_deploy for a full replacement tree.`,
            );
          }
          const entries = Object.entries(patchFiles.value);
          if (entries.length === 1) {
            const [path, content] = entries[0];
            args.path = path;
            args.content = content;
          } else {
            return badArgsToolResult(
              env, authHeader, ctx, toolName, args,
              `project_patch received ${entries.length} files, but it edits one file per call.\nAtomic add-and-remove shape:\nproject_patch({ "project_id": "my-app", "path": "new.html", "content": "<!doctype html><html></html>", "delete_files": ["old.html"] })\nFor a full replacement tree, use project_deploy({ project_id, files: { "index.html": "..." } }).`,
            );
          }
        }
        if (args.path === undefined && args.delete_files === undefined) {
          return badArgsToolResult(
            env, authHeader, ctx, toolName, args,
            'project_patch requires either path plus content/find+replace, or delete_files.\nExample:\nproject_patch({ "project_id": "my-app", "path": "index.html", "find": "old", "replace": "new" })\nFull rewrite example: project_patch({ "project_id": "my-app", "path": "styles.css", "content": "body { color: black }" }).',
          );
        }
        if ((args.find === undefined) !== (args.replace === undefined)) {
          return badArgsToolResult(
            env, authHeader, ctx, toolName, args,
            'project_patch find/replace mode requires both find and replace.\nExample:\nproject_patch({ "project_id": "my-app", "path": "index.html", "find": "<h1>Old</h1>", "replace": "<h1>New</h1>" })\nFor full-file writes, use path plus content instead.',
          );
        }
        const rawDeleteFiles = typeof args.delete_files === 'string' && args.delete_files.trim().startsWith('[')
          ? parseJsonArg(args.delete_files, 'delete_files')
          : args.delete_files;
        const deleteFilesResult = rawDeleteFiles !== undefined ? coerceStringArray(rawDeleteFiles, 'delete_files') : { ok: true as const, value: undefined };
        if (!deleteFilesResult.ok) {
          return badArgsToolResult(
            env, authHeader, ctx, toolName, args,
            `${deleteFilesResult.message}\nExample:\nproject_patch({ "project_id": "my-app", "delete_files": ["old.html"] })\nMissing paths are ignored.`,
          );
        }
        const delete_files = deleteFilesResult.value;
        const expectedVersion = args.expected_version !== undefined && args.expected_version !== null
          ? Number(args.expected_version) : undefined;
        const baseVersionResult = coerceBaseVersionArg(args.base_version);
        if (!baseVersionResult.ok) {
          return badArgsToolResult(env, authHeader, ctx, toolName, args, baseVersionResult.message);
        }
        const baseVersion = baseVersionResult.value;
        const force = args.force === true || args.force === 'true';
        if ((typeof args.preview_session_id === 'string' && typeof args.draft_id === 'string'
              && args.preview_session_id !== args.draft_id)
            || (typeof args.preview_operation_id === 'string' && typeof args.draft_operation_id === 'string'
              && args.preview_operation_id !== args.draft_operation_id)
            || (Object.prototype.hasOwnProperty.call(args, 'expected_preview_id')
              && Object.prototype.hasOwnProperty.call(args, 'expected_candidate_release_id')
              && args.expected_preview_id !== args.expected_candidate_release_id)) {
          return badArgsToolResult(
            env,
            authHeader,
            ctx,
            toolName,
            args,
            'Canonical preview fields and their deprecated aliases must match when both are sent.',
          );
        }
        const previewSessionId = typeof args.preview_session_id === 'string'
          ? args.preview_session_id
          : args.draft_id;
        const previewOperationId = typeof args.preview_operation_id === 'string'
          ? args.preview_operation_id
          : args.draft_operation_id;
        const hasExpectedPreview = Object.prototype.hasOwnProperty.call(args, 'expected_preview_id')
          || Object.prototype.hasOwnProperty.call(args, 'expected_candidate_release_id');
        const expectedPreviewId = Object.prototype.hasOwnProperty.call(args, 'expected_preview_id')
          ? args.expected_preview_id
          : args.expected_candidate_release_id;
        const patchBody: Record<string, unknown> = {
          project_id: args.project_id,
          ...(args.path !== undefined ? { path: args.path } : {}),
          ...(args.content !== undefined ? { content: args.content } : {}),
          ...(args.find !== undefined ? { find: args.find } : {}),
          ...(args.replace !== undefined ? { replace: args.replace } : {}),
          ...(delete_files !== undefined ? { delete_files } : {}),
          ...(expectedVersion !== undefined ? { expected_version: expectedVersion } : {}),
          ...(baseVersion !== undefined ? { base_version: baseVersion } : {}),
          ...(typeof args.base_release_id === 'string' && args.base_release_id.trim()
            ? { base_release_id: args.base_release_id.trim() }
            : {}),
          ...(force ? { force: true } : {}),
          ...(args.dry_run !== undefined ? { dry_run: args.dry_run === true || args.dry_run === 'true' } : {}),
          // agent-edit-safety (tsk_662038a8): the worker /deploy/patch route
          // already honors `preview` (dev-slot draft, no live write) — forward
          // it so preview:true → project_promote is reachable from MCP.
          ...(args.preview !== undefined ? { preview: args.preview === true || args.preview === 'true' } : {}),
          ...(typeof previewSessionId === 'string' ? { preview_session_id: previewSessionId } : {}),
          ...(typeof previewOperationId === 'string'
            ? { preview_operation_id: previewOperationId }
            : {}),
          ...(hasExpectedPreview
            ? { expected_preview_id: expectedPreviewId }
            : {}),
          source: 'mcp',
        };
        result = await callAPI(fetcher, 'POST', '/v1/deploy/patch', authHeader, patchBody);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'project_check',
    description: `**About to deploy source you edited? Run this first.** \`project_check\` typechecks / compiles / lints WITHOUT deploying — a fast green/red so you fix everything before you ship, instead of deploy→error→fix→redeploy. Runs the SAME compile gate a real deploy runs, against the source you pass in, and returns structured errors with \`file:line\` — but writes NOTHING (no version change, nothing goes live). A green here means the deploy's compile step will pass too.

Catches the deploy-fatal classes: **syntax errors** in your function code and inline \`<script>\` blocks, **undefined symbols** (a dropped import — the \`X is not defined\` that 500s at runtime), **JSX in a .js file**, and **Vite-only \`import.meta.glob\`**. Pass the files/functions you just edited; you don't have to deploy to find out if they're broken.

\`\`\`json
{
  "project_id": "my-app",
  "functions": { "api/hello.ts": "export default async (req, sw) => Response.json({ ok: true })" },
  "files": { "src/App.tsx": "export default function App(){ return <div/> }" }
}
\`\`\`

Returns \`{ ok, errors: [{ file, line, column, message, kind }], error_count, reference_checked, syntax_checked, notes }\`. \`reference_checked:false\` means undefined-symbol checking didn't run for this project (syntax + lint only) — the \`notes\` say so plainly; the deploy stays the final gate for that class. **\`somewhere typecheck\` runs local \`tsc --noEmit\`; \`somewhere deploy-check\` runs the platform's actual compiler gate. Shell-less clients use this MCP tool.**`,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, slug, or 'default'." },
        files: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Map of STATIC/source file paths to content (e.g. {"src/App.tsx": "..."}). Scanned for inline-script syntax, JSX-in-.js, Vite-glob, and undefined symbols. Object value preferred; a JSON-stringified object is also accepted.',
        },
        functions: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Map of function paths (api/*, _lib/*) to ES-module source. Checked for syntax + undefined symbols. Object value preferred; a JSON-stringified object is also accepted.',
        },
      },
      required: ['project_id'],
    },
  },
    annotations: {},
    group: 'project',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        // Pre-deploy compile/typecheck/lint oracle — no write, no deploy.
        const files = args.files ? parseJsonArg(args.files, 'files') : undefined;
        const functions = args.functions ? parseJsonArg(args.functions, 'functions') : undefined;
        result = await callAPI(fetcher, 'POST', '/v1/deploy/check', authHeader, {
          project_id: args.project_id,
          ...(files !== undefined ? { files } : {}),
          ...(functions !== undefined ? { functions } : {}),
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'project_check_handler',
    description: `**Advanced — \`somewhere preview\` only.** Run one server function against inputs without deploying. This tool uses the preview's isolated database and env and therefore requires a Pro or Scale plan plus explicit platform enablement. Without it, the call returns \`CLOUD_DEV_NOT_ENABLED\` before running code or creating isolated resources. Do not choose this tool in the default live workflow; use \`project_check\`, deploy, and verify the public live route.

When preview is explicitly enabled, use it to confirm a function against isolated bindings before a deploy.

\`\`\`json
{
  "project_id": "my-app",
  "functions": { "api/sum.ts": "export default async (req, sw) => { const { a, b } = await req.json(); return Response.json({ sum: a + b }); }" },
  "path": "/api/sum",
  "method": "POST",
  "body": "{\\"a\\":2,\\"b\\":3}"
}
\`\`\`

Returns \`{ response: { status, headers, body }, logs, errors, served, isolated_db, duration_ms }\`. If the isolated database is unavailable, it refuses rather than reading live data.`,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, slug, or 'default'." },
        functions: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Map of function paths to ES-module source to run, e.g. {"api/hello.ts": "export default async (req, sw) => Response.json({ ok: true })"}. Required and non-empty. Object value preferred; a JSON-stringified object is also accepted.',
        },
        path: { type: 'string', description: 'Request path to invoke, e.g. "/api/hello". Defaults to "/".' },
        method: { type: 'string', description: 'HTTP method (GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS). Defaults to GET.' },
        headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Optional request headers.' },
        body: { type: 'string', description: 'Optional request body (string; JSON-encode it yourself for application/json). Max 256KB.' },
        timeout_ms: { type: 'number', description: 'Abort the handler after N ms (default 10000, max 30000).' },
      },
      required: ['project_id', 'functions'],
    },
  },
    annotations: {},
    group: 'project',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { env, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        // Run one handler against inputs — no deploy, isolated dev bindings.
        const functions = parseJsonArg(args.functions, 'functions');
        const headers = args.headers ? parseJsonArg(args.headers, 'headers') : undefined;
        result = await callRunner(env, 'POST', '/check-handler', authHeader, {
          project_id: args.project_id,
          functions,
          ...(args.path !== undefined ? { path: args.path } : {}),
          ...(args.method !== undefined ? { method: args.method } : {}),
          ...(headers !== undefined ? { headers } : {}),
          ...(args.body !== undefined ? { body: args.body } : {}),
          ...(args.timeout_ms !== undefined ? { timeout_ms: Number(args.timeout_ms) } : {}),
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'project_undeploy',
    description: 'Undeploy a project — revokes its public subdomain and returns it to an inactive state. All data is preserved.',
    inputSchema: { type: 'object', properties: { project_id: { type: 'string', description: "Project ID, subdomain, or 'default'." } }, required: ['project_id'] },
  },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    group: 'project',
    core: true,
    coreRank: 79,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, env, authHeader, ctx, toolName } = runtime;
      let result: ToolUpstreamResult;
      {
        if (typeof args.project_id !== 'string' || !args.project_id) {
          return badArgsToolResult(
            env, authHeader, ctx, toolName, args,
            'project_undeploy requires project_id.\nExample:\nproject_undeploy({ "project_id": "my-app" })\nThis removes public serving but preserves files and database.',
          );
        }
        result = await callAPI(fetcher, 'POST', `/v1/projects/${encodeURIComponent(args.project_id as string)}/undeploy`, authHeader, {});
        return result;

      }
    },
  },
  {
    definition: {
    name: 'project_promote',
    description: `**Advanced — \`somewhere preview\` only.** Promote one explicitly reviewed preview to production. This requires a Pro or Scale plan plus explicit platform enablement; otherwise it returns \`CLOUD_DEV_NOT_ENABLED\`. It is not part of the default edit/deploy workflow.

\`\`\`json
{
  "project_id": "my-saas",
  "preview_session_id": "draft_123",
  "preview_id": "rel_456"
}
\`\`\`

Pass the exact \`preview_session_id\` and \`preview_id\` returned by the preview. \`message\` is an optional one-line deploy note.

**Stale-base guard (optional, recommended for shared projects):** pass \`base_live_version\` from the preview response. If production changed after that preview was created, promote returns 409 \`STALE_BASE\` with \`data.changed_files\`, \`data.last_change_source\`, and \`data.last_change_at\` instead of replacing the newer production version. On \`STALE_BASE\`, call \`project_diff_versions\` before forcing; pass \`force:true\` only after reviewing the remote changes.

To undo a promote, use \`project_rollback\`.`,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, slug, or 'default'." },
        message: { type: 'string', description: 'Optional one-line note recorded with the promoted version (max 200 chars).' },
        preview_session_id: { type: 'string', description: 'The exact preview_session_id returned with the preview.' },
        preview_id: { type: 'string', description: 'The exact immutable preview_id that was reviewed.' },
        draft_id: { type: 'string', description: 'Deprecated compatibility alias for preview_session_id.' },
        candidate_release_id: { type: 'string', description: 'Deprecated compatibility alias for preview_id.' },
        base_live_version: { type: 'number', description: 'Optional stale-base guard. Pass `base_live_version` from the preview response. A 409 STALE_BASE means production changed since the preview was created — call project_diff_versions before forcing.' },
        force: { type: 'boolean', description: 'Optional. Bypasses a STALE_BASE refusal after you have reviewed the newer production changes. Do not use on the first retry; call project_diff_versions first.' },
      },
      required: ['project_id'],
    },
  },
    annotations: {},
    group: 'project',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","chatgpt"],
    protocol: { surfaceAnnotations: { chatgpt: { destructiveHint: true, openWorldHint: true } }, oauthScopes: ['mcp'] },
    execute: async (runtime, args) => {
      const { fetcher, env, authHeader, ctx, toolName } = runtime;
      let result: ToolUpstreamResult;
      {
        if ((typeof args.preview_session_id === 'string' && typeof args.draft_id === 'string'
              && args.preview_session_id !== args.draft_id)
            || (typeof args.preview_id === 'string' && typeof args.candidate_release_id === 'string'
              && args.preview_id !== args.candidate_release_id)) {
          return badArgsToolResult(
            env,
            authHeader,
            ctx,
            toolName,
            args,
            'Canonical preview fields and their deprecated aliases must match when both are sent.',
          );
        }
        const previewSessionId = typeof args.preview_session_id === 'string'
          ? args.preview_session_id
          : args.draft_id;
        const previewId = typeof args.preview_id === 'string'
          ? args.preview_id
          : args.candidate_release_id;
        if (typeof previewSessionId !== 'string' || !previewSessionId
            || typeof previewId !== 'string' || !previewId) {
          return badArgsToolResult(
            env,
            authHeader,
            ctx,
            toolName,
            args,
            'project_promote requires the exact preview_session_id and preview_id returned by the preview.',
          );
        }
        const baseLiveVersion = coercePromoteBaseLiveVersionArg(args.base_live_version);
        const force = args.force === true || args.force === 'true';
        const body: Record<string, unknown> = {
          project_id: args.project_id,
          preview_session_id: previewSessionId,
          preview_id: previewId,
          ...(baseLiveVersion !== undefined ? { base_live_version: baseLiveVersion } : {}),
          ...(force ? { force: true } : {}),
        };
        if (typeof args.message === 'string' && args.message.trim()) body.message = args.message.trim().slice(0, 200);
        body.source = 'mcp';
        result = await callAPI(fetcher, 'POST', '/v1/promote', authHeader, body);
        if (result.status < 400 && result.data && typeof result.data === 'object') {
          (result.data as Record<string, unknown>).tip =
            "CLI equivalent: 'somewhere promote'. Same auth as MCP. Install: npm i -g @somewhere-tech/cli";
        }
        return result;

      }
    },
  },
  {
    definition: {
    name: 'project_rollback',
    description: "Roll back the last deploy. The code flips to the previous working version immediately. If the project uses a managed database (db/schema.ts), the response also returns a `schema` plan in plain language — what the previous version expects of the database vs. what it looks like now — WITHOUT changing the schema. To also roll the schema back, re-run with with_schema: true; it re-deploys the previous version's schema through the normal deploy path, so a column the new version added is refused (not silently dropped) and a column the old version still declares is restored from retention. Data is never touched beyond the retention/restore window. To review before applying, call with preview: true — it changes NOTHING and returns `target_version` (the version it would restore); pass that back as expected_target_version to confirm, and the rollback is refused (ROLLBACK_TARGET_CHANGED) if the live version moved since your preview, so you never roll to a different version than the one you reviewed.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID, subdomain, or 'default'." },
        with_schema: { type: 'boolean', description: 'Also roll the managed database schema back to the previous version (through the normal deploy path). Default false — the code rolls back and a schema plan is shown, but the schema is left unchanged until you confirm.' },
        preview: { type: 'boolean', description: 'Preview only — change nothing. Returns the schema plan and target_version (the version this would restore). Default false. Use this to review, then confirm with expected_target_version.' },
        expected_target_version: { type: 'number', description: 'The target_version you reviewed (from a preview). The rollback is refused with ROLLBACK_TARGET_CHANGED if the current rollback target differs — so a confirm never applies to a different version than the one reviewed.' },
      },
      required: ['project_id'],
    },
  },
    annotations: { title: 'Roll back to a previous deploy', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    group: 'project',
    core: true,
    coreRank: 19,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","connector","chatgpt"],
    protocol: { surfaceDescriptions: { connector: "Roll back a Somewhere project to its previous application release. By default this changes code without restoring data. with_schema also applies the previous schema through deployment checks and can affect data; preview returns the plan without applying it." }, oauthScopes: ['mcp'], surfaceAnnotations: { chatgpt: { destructiveHint: true, openWorldHint: true }, connector: { destructiveHint: true } } },
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', '/v1/promote/rollback', authHeader, { project_id: args.project_id, ...(args.with_schema !== undefined ? { with_schema: args.with_schema } : {}), ...(args.preview !== undefined ? { preview: args.preview } : {}), ...(args.expected_target_version !== undefined ? { expected_target_version: args.expected_target_version } : {}) });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'project_deploys',
    description: `List the recent deploy history for a project — successful deploys AND rejected/failed deploy attempts, interleaved by time (up to 30 entries). Each entry has a \`status\` field so you can tell a success from a rejection at a glance.

**Example:**

\`\`\`json
{ "project_id": "my-saas" }
// Returns: { "deploys": [
  { "status": "success", "version": 12, "message": "Add payment flow", "promoted_at": "2026-04-20T...", "is_live": true, "commit_sha": "...", "deployed_by": { "user_id": "...", "email": "..." } },
  { "status": "rejected", "version": 11, "reason": "BUNDLED_DEPLOY_REJECTED", "message": "This looks like pre-built output...", "at": "2026-04-19T...", "is_live": false },
  { "status": "success", "version": 10, "message": "Fix auth bug", "promoted_at": "2026-04-18T...", "is_live": false }
] }
\`\`\`

A rejected entry's \`version\` is the version it WOULD have become (may be \`null\`); it never went live. Each successful entry carries \`rollback_available\` — only entries marked \`true\` can be put back into production with \`project_restore_version\` / \`project_rollback\`. Failure entries also include \`failure_id\`, a safe \`classification\`, and \`remediation\`. Resolve one exact reference with \`somewhere api GET /v1/deploy/failure/<failure_id>\`; the endpoint requires access to the owning project and never returns the private stack or provider diagnostic.`,
    inputSchema: {
      type: 'object',
      properties: { project_id: { type: 'string', description: "Project ID, subdomain, or 'default'." } },
      required: ['project_id'],
    },
  },
    annotations: { title: 'List deploy history', readOnlyHint: true, idempotentHint: true },
    group: 'project',
    core: true,
    coreRank: 17,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","connector","chatgpt"],
    protocol: { surfaceDescriptions: { connector: "Read recent successful, rejected, and failed deployment attempts for a Somewhere project, with release identifiers and outcomes." }, oauthScopes: ['mcp'] },
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'GET', `/v1/projects/${encodeURIComponent(args.project_id as string)}/deploys`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'project_design_tokens',
    description: `**Design tokens read from the authored CSS of the project's active release** — palette, typography, spacing scale, radii — as structured JSON. The right starting point for a visual editor (Claude Design, Cursor) that wants to "match the existing look" before redesigning.

Scope is exact: the platform reads the \`.css\` files as you authored them in the source of the exact active release (\`source_scope: 'authored_css'\`) — not the compiled or rendered styles a browser sees, and never a newer or older deploy. The answer names what it read: \`version\`, \`release_id\` and \`source_manifest_hash\`, plus \`input_characters\` (the first 50,000 characters of the concatenated CSS are inspected; \`truncated: true\` when there was more) and \`cached\`. A cached result is reused only for the same release and source hash. If the project has no active release (\`ACTIVE_RELEASE_MISSING\`, 409) or the release has no authored CSS (\`NO_CSS_FOUND\`, 404), you get that error — never tokens from a different source. Requires editor access.

**Example:**

\`\`\`json
{ "project_id": "my-saas" }
// Returns:
{
  "project_id": "my-saas-uuid",
  "version": 12,
  "release_id": "rel_…",
  "source_manifest_hash": "…",
  "source_scope": "authored_css",
  "input_characters": 18342,
  "truncated": false,
  "cached": false,
  "colors":  ["#0a0a0a", "#2dd4bf", "rgba(255,255,255,0.08)"],
  "fonts":   ["\\"Instrument Serif\\", serif", "\\"DM Sans\\", sans-serif"],
  "spacing": ["0.5rem", "1rem", "1.5rem", "2rem"],
  "radii":   ["4px", "8px", "12px"]
}
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
      },
      required: ['project_id'],
    },
  },
    annotations: { title: 'Extract design tokens', readOnlyHint: true, idempotentHint: true },
    group: 'project',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(
          fetcher,
          'GET',
          `/v1/deploy/design-tokens?project_id=${encodeURIComponent(String(args.project_id))}`,
          authHeader,
        );
        return result;

      }
    },
  },
  {
    definition: {
    name: 'project_screenshots',
    description: `**Real picture of the deployed site for each recent version.** The platform captures a desktop screenshot of the project's homepage after every deploy and stores it alongside the version history. Use this to show "what does this app look like right now" (e.g. for design / visual-editor workflows) or "did my last deploy change the way the homepage renders" (regression spot-check).

Pass an optional \`version\` to filter to a specific deploy.

By DEFAULT returns metadata only per screenshot (version, viewport, captured_at, size_bytes) — the large inline base64 image bytes are omitted to keep your context lean. Pass \`include_data: true\` to get each as a \`data_url\` (\`data:image/png;base64,...\`) you can render with \`<img src={data_url}>\`, or use the \`browser\` tool to actually see/inspect the live page.

**Example:**

\`\`\`json
{ "project_id": "my-saas" }
// Returns (metadata only — data_url omitted by default):
{
  "project_id": "my-saas-uuid",
  "screenshots": [
    { "version": 12, "viewport": "desktop", "captured_at": "2026-05-19T...", "size_bytes": 142_321 },
    { "version": 11, "viewport": "desktop", "captured_at": "2026-05-18T...", "size_bytes": 138_004 }
  ]
}
// With include_data:true, each entry also contains: "data_url": "data:image/png;base64,..."
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        version: { type: 'number', description: 'Optional — filter to a single deploy version.' },
        include_data: { type: 'boolean', description: 'Optional, default false. When false (default) the response omits the large inline base64 image bytes and returns metadata only — keeps your context lean. Set true only when you actually need the pixels.' },
      },
      required: ['project_id'],
    },
  },
    annotations: { title: 'Screenshots per deploy', readOnlyHint: true, idempotentHint: true },
    group: 'project',
    core: true,
    coreRank: 11,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const params = new URLSearchParams({ project_id: String(args.project_id) });
        if (args.version !== undefined) params.set('version', String(args.version));
        result = await callAPI(fetcher, 'GET', `/v1/deploy/screenshots?${params.toString()}`, authHeader);
        // Strip the inline base64 data URLs by default — each is ~100KB-2MB and
        // bloats the agent's context (audit #17 / tsk_dd42ddc6). Return metadata
        // only unless the caller explicitly asks for the bytes.
        const includeData = args.include_data === true || args.include_data === 'true';
        if (!includeData && result.status < 400 && result.data && typeof result.data === 'object') {
          // callAPI returns the { ok, data } envelope; the screenshots array
          // lives on the inner payload (.data). (Fall back to the top level in
          // case an upstream ever returns it flat.)
          const envelope = result.data as Record<string, unknown>;
          const payload = (envelope.data && typeof envelope.data === 'object')
            ? envelope.data as Record<string, unknown>
            : envelope;
          if (Array.isArray(payload.screenshots)) {
            payload.screenshots = (payload.screenshots as Array<Record<string, unknown>>).map((s) => {
              if (s && typeof s === 'object' && 'data_url' in s) {
                const { data_url, ...rest } = s;
                void data_url;
                return { ...rest, data_omitted: true };
              }
              return s;
            });
            payload.note = 'Inline image bytes omitted to keep context lean. Pass include_data:true for base64 data URLs, or use the `browser` tool to see/inspect the live page.';
          }
        }
        return result;

      }
    },
  },
  {
    definition: {
    name: 'docs_query',
    description: `Query the source truth of a project — routes, symbols+doc-comments, import graph (depends-on/used-by), tables, task refs, coverage, and bounded rich route contracts — assembled from the source of the project's ACTIVE release. Use this INSTEAD of grepping files to understand a project.

By default the platform selects the sidecar of the exact active release (its ready, same-project version); there is no fallback to a newer or older sidecar. A successful default answer carries \`version_source: 'active_release'\`, \`release_id\` and \`source_manifest_hash\` as selection metadata — what was selected, not independent certification of the artifact bytes. Pass \`version\` for an exact older sidecar; that answer carries \`version_source: 'explicit'\` and no release metadata. When the active release cannot be resolved (none active, not found, not ready, its source missing or temporarily unavailable) the answer is a neutral release-status error with \`version_source: 'active_release'\` and the \`release_id\` where one exists — no source hash, and never a claim that you must redeploy. A project whose selected release has no sidecar answers \`DOCS_SIDECAR_NOT_FOUND\` (404). Input problems are ordinary validation or project-not-found errors.

The result comes from the deploy-version-keyed docs sidecar selected for that release, not from a live grep. Pass \`path\`, \`symbol\`, or \`route\` to receive the matching methods/query actions, schema columns and constraints, \`sw.*\` and environment-name bindings (never values), and imported-helper evidence. The response never includes the whole readable Markdown document. If a sidecar is partial or omitted files, the response includes source hash/version/completeness flags so absence is not mistaken for proof that code is not deployed. The private canonical platform artifact is explicitly SOURCE truth, not serving/runtime-effective truth.

**Examples:**

\`\`\`json
{ "project_id": "my-saas" }
{ "project_id": "my-saas", "path": "api/checkout.ts" }
{ "project_id": "my-saas", "symbol": "createCheckout" }
{ "project_id": "my-saas", "route": "POST /api/checkout" }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed." },
        version: { type: 'number', description: 'Optional — pin to a specific deploy version. Defaults to the current live deploy sidecar.' },
        path: { type: 'string', description: 'Optional — exact deployed source path, e.g. api/checkout.ts or src/App.tsx.' },
        symbol: { type: 'string', description: 'Optional — exported symbol name to find, including its doc comment and file.' },
        route: { type: 'string', description: 'Optional — route path or METHOD + path, e.g. /api/checkout or POST /api/checkout.' },
      },
      required: ['project_id'],
    },
  },
    annotations: { title: 'Query deployed source docs', readOnlyHint: true, idempotentHint: true },
    group: 'project',
    core: true,
    coreRank: 16,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","connector","chatgpt"],
    protocol: { surfaceDescriptions: { connector: "Query a project’s generated source index for routes, symbols, tables, and dependencies. Optional path, symbol, or route filters select relevant evidence. Defaults to the active release; an unavailable index returns a specific status error. The indexed source follows the Somewhere API contract at https://somewhere.tech/docs.txt (functions, schema file, routes)." }, oauthScopes: ['mcp'] },
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const params = new URLSearchParams({ project_id: String(args.project_id) });
        if (args.version !== undefined) params.set('version', String(args.version));
        if (args.path !== undefined) params.set('path', String(args.path));
        if (args.symbol !== undefined) params.set('symbol', String(args.symbol));
        if (args.route !== undefined) params.set('route', String(args.route));
        result = await callAPI(fetcher, 'GET', `/v1/docs-query?${params.toString()}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'project_docs',
    description: `**Readable documentation for the deployed project.** Returns deterministic docs generated from the exact deployed source, plus routes, symbols, data tables, dependency graph, coverage flags, and a Mermaid map. Read this BEFORE editing an unfamiliar project.

By default the document describes the project's active release (a successful default answer carries \`version_source: 'active_release'\`, \`release_id\` and \`source_manifest_hash\`); pass \`version\` for an exact older one, which carries \`version_source: 'explicit'\` and no release metadata. The deterministic document is available shortly after a successful deploy. A single asynchronous Luna flex-tier pass may add \`docs.prose\` without delaying deploy; it is separately labeled \`ai_generated_untrusted_summary\` and must be verified against \`docs.markdown\`. \`docs.status\` says \`deterministic\` or \`enriched\`. Existing projects receive docs on their next deploy and are not backfilled.`,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side." },
        version: { type: 'number', description: 'Optional deploy version; defaults to the current live deploy sidecar.' },
      },
      required: ['project_id'],
    },
  },
    annotations: { title: 'Project docs', readOnlyHint: true, idempotentHint: true },
    group: 'project',
    core: true,
    coreRank: 80,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","connector","chatgpt"],
    protocol: { surfaceDescriptions: { connector: "Read documentation generated from a project’s active release, or an explicitly requested older version. Includes source coverage and release identity. Optional AI prose is labeled as an untrusted summary; an unavailable document returns a specific status error." }, oauthScopes: ['mcp'] },
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const params = new URLSearchParams({ project_id: String(args.project_id) });
        if (args.version !== undefined) params.set('version', String(args.version));
        result = await callAPI(fetcher, 'GET', `/v1/project-docs?${params.toString()}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'project_description',
    description: `**2-3 sentence plain-English summary of what the project does, regenerated automatically on every promote.** An AI pass reads table names, route names, and sw.* usage and writes one short paragraph — like "Restaurant discovery and booking app with AI chatbot. 89 users browse 24 restaurants and book tables."

Useful when you have many projects and can't remember which one was "the recipe thing with the auth bug" — or when asked to operate on a project you've never seen.

Empty \`text\` means no description yet — fall back to project name + subdomain.

**Example:**

\`\`\`json
{ "project_id": "my-saas" }
// Returns:
{
  "project_id": "my-saas-uuid",
  "version": 12,
  "text": "Restaurant discovery and booking app with AI chatbot. 89 users browse 24 restaurants and book tables.",
  "generated_at": "2026-05-19T..."
}
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        version: { type: 'number', description: 'Optional — pin to a specific deploy version. Defaults to the latest generated description.' },
      },
      required: ['project_id'],
    },
  },
    annotations: { title: 'Plain-English summary', readOnlyHint: true, idempotentHint: true },
    group: 'project',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const params = new URLSearchParams({ project_id: String(args.project_id) });
        if (args.version !== undefined) params.set('version', String(args.version));
        result = await callAPI(fetcher, 'GET', `/v1/deploy/description?${params.toString()}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'project_comments_list',
    description: `**Open visual-annotator comments left on the deployed site.** The dashboard's "Review" mode lets a founder / collaborator click any element on the live page and leave a note; this tool returns those notes so an agent (Claude Design, Claude Code) can pick them up, apply the fix, and call \`project_comment_resolve\`.

Each comment carries the CSS selector of the element it was attached to, a short text snippet of what the user clicked, and the comment body. Use the selector + snippet to locate the element in your rendered source. (The record also has \`source_file\`/\`source_line\` fields, but the visual annotator does not populate them today — they're null in practice; don't rely on them.)

Pass \`status\` to filter — \`open\` (default), \`resolved\`, or \`all\`.

**Example:**

\`\`\`json
{ "project_id": "my-saas" }
// Returns:
{
  "project_id": "my-saas-uuid",
  "comments": [
    {
      "id": "cmt_...",
      "version": 12,
      "css_selector": "main > section:nth-of-type(2) > h2",
      "snippet": "Pricing",
      "body": "Bump this to 28px and add 16px top margin",
      "author_id": "...",
      "status": "open",
      "created_at": "2026-05-19T...",
      "resolved_at": null
    }
  ]
}
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        status: { type: 'string', enum: ['open', 'resolved', 'all'], description: 'Filter by resolution state. Defaults to "open".' },
      },
      required: ['project_id'],
    },
  },
    annotations: { title: 'Open review comments', readOnlyHint: true, idempotentHint: true },
    group: 'project',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const status = args.status ?? 'open';
        result = await callAPI(
          fetcher,
          'GET',
          `/v1/projects/${encodeURIComponent(String(args.project_id))}/comments?status=${encodeURIComponent(String(status))}`,
          authHeader,
        );
        return result;

      }
    },
  },
  {
    definition: {
    name: 'project_comment_resolve',
    description: `Mark a visual-annotator comment as resolved. Call this after you've shipped the change the comment was asking for — it stops the comment from showing in the dashboard's open queue and tells future agents the work is done.

**Example:**

\`\`\`json
{ "project_id": "my-saas", "comment_id": "cmt_..." }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        comment_id: { type: 'string', description: 'Comment ID (starts with cmt_) from project_comments_list.' },
      },
      required: ['project_id', 'comment_id'],
    },
  },
    annotations: { title: 'Resolve a comment', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    group: 'project',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(
          fetcher,
          'PATCH',
          `/v1/projects/${encodeURIComponent(String(args.project_id))}/comments/${encodeURIComponent(String(args.comment_id))}`,
          authHeader,
          { resolved: true },
        );
        return result;

      }
    },
  },
  {
    definition: {
    name: 'project_export',
    description: `**Pull the entire project in one call.** Returns every deployed file — static HTML/CSS/JS as text, binary assets (images, fonts, favicons, .ico/.png/.woff*/etc) base64-encoded, server functions as source — keyed by path. This is the Claude Design / visual-editor fast path: one call → entire project → edit → \`project_deploy\` back.

For workflows like "redesign my homepage" or "swap the color scheme on the live site," this is the entry point. Pairs with \`project_deploy\` (full replacement) and \`project_patch\` (single-file update) on the write side.

Response shape: flat \`files: [{ path, type, content, encoding }]\` array with explicit per-entry type ("static" / "binary" / "function"), plus the legacy \`static_files\` / \`binary_files\` / \`functions\` maps for backwards compatibility. SVG is utf-8 text (it's XML); PNG / ICO / fonts / etc come back base64.

**Pass \`static_only: true\` if you only need the visual layer** (HTML / CSS / SVG / images / fonts) and not the server functions. Typical projects have 5–10× more function bytes than static bytes, so this is the right default for design / redesign / "swap the color scheme" workflows. The \`functions\` map comes back empty; \`static_files\` and \`binary_files\` are unchanged.

If you only need one file (e.g. just CSS), use \`project_file_read\`. If you only need the tree (paths + sizes, no contents), use \`project_files_list\` — much cheaper.

**Example:**

\`\`\`json
{ "project_id": "my-saas", "static_only": true }
// Returns: {
//   project_id: "my-saas-uuid", env: "prod", version: 47,
//   files: [
//     { path: "index.html",        type: "static",   content: "<!DOCTYPE...", encoding: "utf-8" },
//     { path: "logo.svg",          type: "static",   content: "<svg...",     encoding: "utf-8" },
//     { path: "hero.jpg",          type: "binary",   content: "<base64>",    encoding: "base64" }
//   ],
//   static_files: { ... }, binary_files: { ... }, functions: {},  // legacy maps; functions empty when static_only
//   counts: { static_files: 8, binary_files: 2, functions: 0, total: 10 }
// }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        preview_session_id: { type: 'string', description: 'Exact open preview session. Supply with preview_id and env:"dev"; never falls back to another source.' },
        preview_id: { type: 'string', description: 'Exact current candidate of preview_session_id. Both fields are required together.' },
        project_id: { type: 'string', description: "Project ID, slug, subdomain, or 'default'." },
        env: { type: 'string', enum: ['dev', 'prod'], description: 'Which environment to pull from. Defaults to "prod" (the live deployed source). Explicit "dev" requires the optional Pro/Scale + enabled preview capability.' },
        static_only: { type: 'boolean', description: 'When true, skip server functions and return only static files (HTML/CSS/SVG/images/fonts). Right default for design / redesign workflows. Defaults to false.' },
      },
      required: ['project_id'],
    },
  },
    annotations: { title: 'Export project source', readOnlyHint: true, idempotentHint: true },
    group: 'project',
    core: true,
    coreRank: 12,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","connector","chatgpt"],
    protocol: { surfaceDescriptions: { connector: "Export a Somewhere project as raw source files for inspection or editing. This reads the project source; it does not deploy changes." }, oauthScopes: ['mcp'] },
    execute: async (runtime, args) => {
      const { fetcher, env, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const params = new URLSearchParams({ project_id: String(args.project_id) });
        params.set('env', String(args.env ?? 'prod'));
        if (args.preview_session_id !== undefined) params.set('preview_session_id', String(args.preview_session_id));
        if (args.preview_id !== undefined) params.set('preview_id', String(args.preview_id));
        if (args.static_only === true) params.set('static_only', 'true');
        result = await callAPI(fetcher, 'GET', `/v1/deploy/source?${params.toString()}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'project_deploy_log',
    description: `Get the build log for a deploy — the entry the bundler detected, every chunk it emitted with sizes, function bundle sizes, and any warnings. Compilation runs on the platform (you deploy raw source), so this is how you SEE what the build did — why CSS dropped, which chunk a warning came from — instead of reverse-engineering compiled output. Omit \`version\` for the latest deploy; pass a version from \`project_deploys\` for a past one. Complements the \`build_log\` + \`rollback\` fields that \`project_deploy\` now returns inline.

Also surfaces failure context alongside (or instead of) a normal build log: \`last_failed_build\` (the most recent build that failed to compile), \`last_rejected\` (the most recent deploy rejected before compile, e.g. bundled-output detection), and \`recent_failures\` (up to 5 safe rows with \`failure_id\`, \`code\`, \`classification\`, \`message\`, \`remediation\`, \`known_cause\`, \`version\`, and \`at\`). Resolve one exact reference with \`somewhere api GET /v1/deploy/failure/<failure_id>\`. If the project has never had a successful deploy, \`version\` comes back \`null\` with an empty \`build_log\` and whatever failure context exists — that's the answer to "why did my first deploy fail," not an error.`,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID, slug, subdomain, or 'default'." },
        version: { type: 'number', description: 'Deploy version to fetch the log for (from project_deploys). Omit for the latest deploy.' },
      },
      required: ['project_id'],
    },
  },
    annotations: { title: 'Build log for a deploy', readOnlyHint: true, idempotentHint: true },
    group: 'project',
    core: true,
    coreRank: 81,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const params = new URLSearchParams({ project_id: String(args.project_id) });
        if (args.version !== undefined) params.set('version', String(args.version));
        result = await callAPI(fetcher, 'GET', `/v1/deploy/log?${params.toString()}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'project_files_list',
    description: `List every deployed file in the project — path, type (static/binary/function), size, last_modified. **No file bytes.** Cheap tree listing for "show me what's in there" before deciding what to pull.

Pair with \`project_file_read\` for surgical one-file pulls, or \`project_export\` to grab everything in one shot.

**Example:**

\`\`\`json
{ "project_id": "my-saas" }
// Returns: {
//   project_id: "my-saas-uuid", env: "prod",
//   files: [
//     { path: "index.html", type: "static", size: 4203, last_modified: "..." },
//     { path: "hero.jpg",   type: "binary", size: 82310, last_modified: "..." },
//     { path: "api/checkout.mjs", type: "function", size: 1244 }
//   ],
//   counts: { static: 8, binary: 2, functions: 5 }
// }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        preview_session_id: { type: 'string', description: 'Exact open preview session. Supply with preview_id and env:"dev"; never falls back to another source.' },
        preview_id: { type: 'string', description: 'Exact current candidate of preview_session_id. Both fields are required together.' },
        project_id: { type: 'string', description: "Project ID, slug, subdomain, or 'default'." },
        env: { type: 'string', enum: ['dev', 'prod'], description: 'Which environment to list. Defaults to "prod" (live). Explicit "dev" requires the optional Pro/Scale + enabled preview capability.' },
      },
      required: ['project_id'],
    },
    outputSchema: readOutputSchema({
      project_id: { type: 'string' },
      env: { type: 'string', enum: ['dev', 'prod'] },
      active_release_id: { type: ['string', 'null'] },
      source_release_id: { type: 'string' },
      preview_session_id: { type: 'string' },
      preview_id: { type: 'string' },
      base_release_id: { type: 'string' },
      files: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            type: { type: 'string', enum: ['static', 'binary', 'function'] },
            size: { type: 'number' },
          },
          additionalProperties: true,
        },
      },
      counts: {
        type: 'object',
        properties: {
          static: { type: 'number' },
          binary: { type: 'number' },
          functions: { type: 'number' },
        },
        additionalProperties: true,
      },
    }),
  },
    annotations: { title: 'List project files', readOnlyHint: true, idempotentHint: true },
    group: 'project',
    core: true,
    coreRank: 13,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","connector","chatgpt"],
    protocol: { surfaceDescriptions: { connector: "List source file paths in a Somewhere project so individual files can be inspected before editing." }, oauthScopes: ['mcp'] },
    execute: async (runtime, args) => {
      const { fetcher, env, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const params = new URLSearchParams({ project_id: String(args.project_id) });
        params.set('env', String(args.env ?? 'prod'));
        if (args.preview_session_id !== undefined) params.set('preview_session_id', String(args.preview_session_id));
        if (args.preview_id !== undefined) params.set('preview_id', String(args.preview_id));
        result = await callAPI(fetcher, 'GET', `/v1/deploy/files-list?${params.toString()}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'project_file_read',
    description: `Read the raw source of a single deployed file. Returns the actual bytes that were uploaded — not DOM-rendered HTML, not a screenshot. Static files come back as UTF-8 text; binary files (images, fonts, etc.) come back base64-encoded; server functions return their source code.

Pair with \`project_files_list\` to discover available paths, or use \`project_export\` for a full pull.

**Example:**

\`\`\`json
{ "project_id": "my-saas", "path": "styles.css" }
// Returns: { project_id, env: "prod", path: "styles.css", type: "static", content: "body { ... }", encoding: "utf-8" }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        preview_session_id: { type: 'string', description: 'Exact open preview session. Supply with preview_id and env:"dev"; never falls back to another source.' },
        preview_id: { type: 'string', description: 'Exact current candidate of preview_session_id. Both fields are required together.' },
        project_id: { type: 'string', description: "Project ID, slug, subdomain, or 'default'." },
        path: { type: 'string', description: 'File path relative to the project root (e.g. "index.html", "api/checkout.mjs", "assets/hero.jpg").' },
        env: { type: 'string', enum: ['dev', 'prod'], description: 'Which environment to read from. Defaults to "prod" (live). Explicit "dev" requires the optional Pro/Scale + enabled preview capability.' },
      },
      required: ['project_id', 'path'],
    },
  },
    annotations: { title: 'Read a project file', readOnlyHint: true, idempotentHint: true },
    group: 'project',
    core: true,
    coreRank: 14,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","connector","chatgpt"],
    protocol: { surfaceDescriptions: { connector: "Read a source file from a Somewhere project by path. Project source follows the Somewhere API contract at https://somewhere.tech/docs.txt." }, oauthScopes: ['mcp'] },
    execute: async (runtime, args) => {
      const { fetcher, env, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const params = new URLSearchParams({ project_id: String(args.project_id), path: String(args.path) });
        params.set('env', String(args.env ?? 'prod'));
        if (args.preview_session_id !== undefined) params.set('preview_session_id', String(args.preview_session_id));
        if (args.preview_id !== undefined) params.set('preview_id', String(args.preview_id));
        result = await callAPI(fetcher, 'GET', `/v1/deploy/file?${params.toString()}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'project_grep',
    description: `Regex-search deployed authored source — every static source file and server function — and get back \`file:line\` matches in one call. The existing per-project call remains unchanged. Platform admins may instead pass \`scope:"live"\` (and omit project_id) to search every project currently serving production traffic (\`projects.status = 'deployed'\`). Release-pinned projects read their immutable release; legacy projects read their prod-slot authored source. Fleet responses report projects scanned/searched/skipped by reason, projects with no prod function script, and whether results were truncated. Every fleet hit carries the stable \`file\`/\`path\`/\`file_path\`, \`line\`/\`line_number\`, \`col\`/\`column\`, and \`text\`/\`matched_line\` compatibility fields.

\`pattern\` is a regular expression (not a literal substring). \`glob\` optionally scopes the search: a glob with no slash matches by filename (\`*.tsx\` → every .tsx file), one with a slash matches the path (\`api/**\` → just that folder).

**Example:**

\`\`\`json
{ "project_id": "my-saas", "pattern": "createClient\\\\(", "glob": "src/**" }
// Returns: {
//   project_id, env: "prod",
//   matches: [
//     { path: "src/lib/db.ts", line: 3, col: 18, text: "export const db = createClient(url, key)" }
//   ],
//   truncated: false, files_searched: 24
// }
\`\`\`

Returns at most \`max_results\` matches (default 100, max 1000), capped per file too; \`truncated: true\` means a cap clipped the results — narrow the \`pattern\` or \`glob\`. Searches the live \`prod\` source by default. Explicit \`env: "dev"\` requires the optional Pro/Scale + enabled preview capability.`,
    inputSchema: {
      type: 'object',
      properties: {
        preview_session_id: { type: 'string', description: 'Exact open preview session. Supply with preview_id and env:"dev"; never falls back to another source.' },
        preview_id: { type: 'string', description: 'Exact current candidate of preview_session_id. Both fields are required together.' },
        project_id: { type: 'string', description: "Project ID, slug, subdomain, or 'default'." },
        scope: { type: 'string', enum: ['live'], description: 'Admin-only. Search every live project instead of one project; omit project_id.' },
        pattern: { type: 'string', description: 'A regular expression to search for (e.g. "export function \\\\w+", "TODO|FIXME"). Catastrophic patterns (nested unbounded repeats like "(a+)+") are rejected.' },
        glob: { type: 'string', description: 'Optional path filter. No-slash globs match the filename ("*.ts"); slashed globs match the path ("api/**", "src/components/*.tsx").' },
        env: { type: 'string', enum: ['dev', 'prod'], description: 'Which environment\'s source to search. Defaults to "prod" (live). Explicit "dev" requires the optional Pro/Scale + enabled preview capability.' },
        max_results: { type: 'number', description: 'Cap on total matches returned. Default 100, max 1000.' },
        case_insensitive: { type: 'boolean', description: 'Match case-insensitively. Default false.' },
      },
      required: ['pattern'],
    },
  },
    annotations: { title: 'Search project source', readOnlyHint: true, idempotentHint: true },
    group: 'project',
    core: true,
    coreRank: 15,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","connector","chatgpt"],
    protocol: { surfaceDescriptions: { connector: "Search source files in a Somewhere project for text or a pattern and return matching locations." }, oauthScopes: ['mcp'] },
    execute: async (runtime, args) => {
      const { fetcher, env, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', '/v1/project/grep', authHeader, {
          project_id: args.project_id,
          scope: args.scope,
          pattern: args.pattern,
          glob: args.glob,
          env: args.env ?? 'prod',
          ...(args.preview_session_id !== undefined ? { preview_session_id: args.preview_session_id } : {}),
          ...(args.preview_id !== undefined ? { preview_id: args.preview_id } : {}),
          max_results: args.max_results,
          case_insensitive: args.case_insensitive,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'project_restore_version',
    description: `Restore a specific past deploy version to be the live production version. Use project_deploys first to see which versions are available: an entry with \`rollback_available: false\` is still in the history but its build is no longer restorable (the call is refused and nothing changes — deploy that version's source again to bring it back). The currently live version is a no-op.

**Example:**

\`\`\`json
{ "project_id": "my-saas", "version": 11 }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        version: { type: 'number', description: 'Version number to restore (from project_deploys)' },
      },
      required: ['project_id', 'version'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    group: 'project',
    core: true,
    coreRank: 20,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', '/v1/promote/restore', authHeader, {
          project_id: args.project_id,
          version: args.version,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'project_diff_versions',
    description: `Compare two preserved deploy versions of a project. Returns per-file added / removed / changed paths, plus truncated text previews for changed files. Use this after a 409 VERSION_CONFLICT to see what the other deployer shipped before merging and retrying.

Both versions must still exist in the preserved-snapshot window (the platform keeps the most recent 10 versions). Use \`project_deploys\` first to confirm both numbers are available.

**Example:**

\`\`\`json
{ "project_id": "my-saas", "from": 46, "to": 47 }
// Returns: {
//   from: 46, to: 47,
//   added:   [{ path: "api/billing.ts", size: 1244 }],
//   removed: [],
//   changed: [{ path: "index.html", from_size: 980, to_size: 1102, from_preview: "<html>...", to_preview: "<html>..." }],
//   functions: { added: ["api/billing.ts"], removed: [], changed: [] },
//   functions_changed: true
// }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        from: { type: 'number', description: 'The earlier version number (e.g. your last expected_version)' },
        to: { type: 'number', description: 'The later version number (e.g. current_version from the 409 response, or pass project_get().version)' },
      },
      required: ['project_id', 'from', 'to'],
    },
  },
    annotations: { readOnlyHint: true, idempotentHint: true },
    group: 'project',
    core: true,
    coreRank: 107,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const params = new URLSearchParams();
        params.set('from', String(args.from));
        params.set('to', String(args.to));
        result = await callAPI(fetcher, 'GET', `/v1/projects/${encodeURIComponent(args.project_id as string)}/diff?${params.toString()}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'project_transfer',
    description: `Transfer a project to another user by email. If they don't have a somewhere.tech account, they'll receive an invitation.

**Example:**

\`\`\`json
{ "project_id": "my-saas", "to_email": "cofounder@example.com" }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project ID' },
        to_email: { type: 'string', description: 'Recipient email address' },
      },
      required: ['project_id', 'to_email'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    group: 'project',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', `/v1/projects/${encodeURIComponent(args.project_id as string)}/transfer`, authHeader, { to_email: args.to_email });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'project_list_collaborators',
    description: `List collaborators on a project. Owner-only. Returns each collaborator's user_id, email, when they were added, and who added them.

Collaborators have full edit access (deploy, files, db, ai, email) EXCEPT: delete, transfer, env var values, spend caps, and managing other collaborators. All work billed to the project owner.`,
    inputSchema: {
      type: 'object',
      properties: { project_id: { type: 'string', description: 'Project ID' } },
      required: ['project_id'],
    },
  },
    annotations: { readOnlyHint: true, idempotentHint: true },
    group: 'project',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'GET', `/v1/projects/${encodeURIComponent(args.project_id as string)}/collaborators`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'project_add_collaborator',
    description: `Add a collaborator to a project by email. Owner-only. The user must already have a somewhere.tech account.

Collaborators get full edit access (deploy, files, db, ai, email) EXCEPT: delete, transfer, env var values, spend caps, and managing other collaborators. All work billed to the project owner.

**Example:**

\`\`\`json
{ "project_id": "my-saas", "email": "teammate@example.com" }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project ID' },
        email: { type: 'string', description: 'Email of an existing somewhere.tech user' },
      },
      required: ['project_id', 'email'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    group: 'project',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', `/v1/projects/${encodeURIComponent(args.project_id as string)}/collaborators`, authHeader, { email: args.email });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'project_remove_collaborator',
    description: `Remove a collaborator from a project. Owner-only. Pass the collaborator's user_id (from project_list_collaborators).`,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project ID' },
        user_id: { type: 'string', description: 'User ID of the collaborator to remove' },
      },
      required: ['project_id', 'user_id'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    group: 'project',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'DELETE', `/v1/projects/${encodeURIComponent(args.project_id as string)}/collaborators/${args.user_id}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'deploy_status',
    description: 'Return deploy state, including the immutable production release, current version, previews, and file counts. Every production hostname serves the selected production release.',
    inputSchema: {
      type: 'object',
      properties: { project_id: { type: 'string', description: "Project ID, subdomain, or 'default'." } },
      required: ['project_id'],
    },
    outputSchema: readOutputSchema({
      published: { type: 'boolean', description: 'Whether the project is currently published. False after project_undeploy — the source is retained, nothing is serving.' },
      active_release_id: { type: ['string', 'null'], description: 'The release currently serving. Null when the project is not published.' },
      retained_release_id: { type: ['string', 'null'], description: 'The release the project would serve if published — kept through an undeploy so export, patch, rollback and the next deploy all still work.' },
      preview_id: { type: ['string', 'null'] },
      candidate_release_id: { type: ['string', 'null'], description: 'Deprecated compatibility alias for preview_id.' },
      production_release: {
        type: ['object', 'null'],
        additionalProperties: true,
      },
      live_release: {
        type: ['object', 'null'],
        description: 'Deprecated compatibility alias for production_release.',
        properties: {
          release_id: { type: 'string' },
          version: { type: ['number', 'null'] },
          source_file_count: { type: ['number', 'null'] },
          has_functions: { type: 'boolean' },
          updated_at: { type: ['string', 'null'] },
        },
        additionalProperties: true,
      },
      current_candidate: { type: ['object', 'null'], description: 'Deprecated compatibility alias for the current preview.', additionalProperties: true },
      promoted_from_preview_id: { type: ['string', 'null'], description: 'The exact preview that was promoted into production, recorded at the moment production switched over. Null when the production release did not come from a promotion (a direct deploy, a patch, or a rollback) — it is never filled in with whichever preview happens to be open.' },
      promoted_from_candidate_id: { type: ['string', 'null'], description: 'Deprecated compatibility alias for promoted_from_preview_id.' },
      production_content_hash: { type: ['string', 'null'], description: "Immutable content hash of the production release's source. A promoted release and the preview it came from report the SAME hash, so confirming you shipped the artifact you tested is one equality check, with no diffing. Null for releases published before content hashes were recorded." },
      dev_updated_at: { type: ['string', 'null'] },
      prod_updated_at: { type: ['string', 'null'] },
      in_sync: { type: 'boolean' },
      dev_ahead: { type: 'boolean' },
      files_changed: { type: 'number' },
      dev_file_count: { type: ['number', 'null'] },
      prod_file_count: { type: ['number', 'null'] },
      dev_has_functions: { type: 'boolean' },
      prod_has_functions: { type: 'boolean' },
      added_files: { type: 'array', items: { type: 'string' } },
      removed_files: { type: 'array', items: { type: 'string' } },
      modified_files: { type: 'array', items: { type: 'string' } },
      dev_version: { type: ['number', 'null'] },
      prod_version: { type: ['number', 'null'] },
      last_change_source: { type: ['string', 'null'] },
      last_change_at: { type: ['string', 'null'] },
      preview_candidates: {
        type: 'array',
        description: 'Deprecated compatibility alias for previews.',
        items: {
          type: 'object',
          properties: {
            draft_id: { type: 'string' },
            candidate_release_id: { type: 'string' },
            base_release_id: { type: 'string' },
            preview_origin: { type: 'string' },
            created_at: { type: 'string' },
            last_updated_at: { type: 'string' },
            expires_at: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
      previews: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            preview_session_id: { type: 'string' },
            preview_id: { type: 'string' },
            base_release_id: { type: 'string' },
            preview_origin: { type: 'string' },
            created_at: { type: 'string' },
            last_updated_at: { type: 'string' },
            expires_at: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
      preview_session: { type: ['object', 'null'], additionalProperties: true },
      draft: { type: ['object', 'null'], description: 'Deprecated compatibility alias for preview_session.', additionalProperties: true },
    }),
  },
    annotations: { title: 'Show deploy status', readOnlyHint: true, idempotentHint: true },
    group: 'project',
    core: true,
    coreRank: 18,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","chatgpt"],
    protocol: { oauthScopes: ['mcp'] },
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'GET', `/v1/deploy/status?project_id=${encodeURIComponent(args.project_id as string)}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    description: `Get the public live URLs for a project. \`prod\` is the verified custom domain when one exists; \`prod_fallback\` is the public \`*.somewhere.site\` URL and always serves the latest live deploy.

**Example:**

\`\`\`json
{ "project_id": "my-saas" }
// Returns: {
//   "prod": "https://app.yourcompany.com",          // null if no custom domain
//   "prod_fallback": "https://my-saas.somewhere.site",
//   "prod_version": 12,
//   "has_custom_domain": true
// }
\`\`\``,
    name: 'project_view_urls',
    inputSchema: {
      type: 'object',
      properties: { project_id: { type: 'string', description: "Project ID, subdomain, or 'default'." } },
      required: ['project_id'],
    },
    outputSchema: readOutputSchema({
      active_release_id: { type: ['string', 'null'] },
      preview_id: { type: ['string', 'null'] },
      candidate_release_id: { type: ['string', 'null'], description: 'Deprecated compatibility alias for preview_id.' },
      production_release: { type: ['object', 'null'], additionalProperties: true },
      live_release: { type: ['object', 'null'], description: 'Deprecated compatibility alias for production_release.', additionalProperties: true },
      current_candidate: { type: ['object', 'null'], additionalProperties: true },
      prod: { type: ['string', 'null'] },
      prod_fallback: { type: ['string', 'null'] },
      prod_version: { type: ['number', 'null'] },
      prod_updated_at: { type: ['string', 'null'] },
      prod_file_count: { type: ['number', 'null'] },
      prod_has_functions: { type: 'boolean' },
      has_custom_domain: { type: 'boolean' },
      has_promoted: { type: 'boolean' },
      dev: { type: ['string', 'null'] },
      in_sync: { type: 'boolean' },
      dev_updated_at: { type: ['string', 'null'] },
      dev_file_count: { type: ['number', 'null'] },
      dev_has_functions: { type: 'boolean' },
      dev_ahead: { type: 'boolean' },
    }),
  },
    annotations: { title: 'Show project URLs', readOnlyHint: true, idempotentHint: true },
    group: 'project',
    core: true,
    coreRank: 10,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","connector","chatgpt"],
    protocol: { surfaceDescriptions: { connector: "Read a Somewhere project’s public URLs and release information, including its verified custom domain when available." }, oauthScopes: ['mcp'] },
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'GET', `/v1/projects/${encodeURIComponent(args.project_id as string)}/urls`, authHeader);
        return result;

      }
    },
  },
  // ── github ─────────────────────────────────────────────
  {
    definition: {
    name: 'github_app_install',
    description: `Start the preferred GitHub App connection flow. Returns a GitHub consent link for the human to open and choose an account/repositories. After consent, call \`github_installations\`, then \`github_list_repos\`, then \`github_connect\` with the selected \`installation_id\`. No personal access token or manual webhook is needed.`,
    inputSchema: {
      type: 'object',
      properties: {
        return_to: { type: 'string', description: 'Optional somewhere.tech dashboard URL GitHub should return the browser to.' },
      },
      required: [],
    },
  },
    annotations: { title: 'Install the GitHub App', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    group: 'github',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      const returnTo = typeof args.return_to === 'string' ? args.return_to : 'https://somewhere.tech/dashboard';
      return callAPI(
        fetcher,
        'GET',
        `/v1/github/app/install?format=json&return_to=${encodeURIComponent(returnTo)}`,
        authHeader,
      );
    },
  },
  {
    definition: {
    name: 'github_installations',
    description: `List the caller's authorized GitHub App installations. Use the returned \`installation_id\` with \`github_list_repos\` and \`github_connect\`. An empty list means the human still needs to open the link from \`github_app_install\`.`,
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
    annotations: { title: 'List GitHub App installations', readOnlyHint: true, idempotentHint: true },
    group: 'github',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime) => {
      const { fetcher, authHeader } = runtime;
      return callAPI(fetcher, 'GET', '/v1/github/app/installations', authHeader);
    },
  },
  {
    definition: {
    name: 'github_connect',
    description: `Connect a GitHub repository + branch to a project, deploy the branch's current HEAD, then automatically deploy every future push through the same pipeline as \`somewhere deploy\`.

Preferred: call \`github_app_install\` if needed, choose an ID from \`github_installations\`, and pass \`installation_id\`. The App uses short-lived tokens and signed App-level webhooks—no PAT paste or manual repo webhook. By default this call resolves and deploys HEAD immediately; poll \`github_status\` for the returned \`initial_deploy.commit_sha\` until deployed/failed. The PAT/manual-webhook fields remain compatibility fallbacks.

**Example:**

\`\`\`json
{ "project_id": "my-saas", "repo": "alice/my-saas", "installation_id": 123, "branch": "main" }
// Returns: { "repo": "alice/my-saas", "via_app": true, "initial_deploy": { "status": "deploying", "commit_sha": "..." } }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, slug, or 'default'." },
        repo: { type: 'string', description: 'Repository as "owner/name" (e.g. "alice/my-saas").' },
        branch: { type: 'string', description: 'Branch to deploy from. Defaults to "main".' },
        root_dir: { type: 'string', description: 'Optional subdirectory inside the repo to deploy (a monorepo package dir). Omit to deploy from the repo root.' },
        installation_id: { type: 'number', description: 'Preferred. Caller-owned GitHub App installation from github_installations.' },
        deploy_head: { type: 'boolean', description: 'Resolve and deploy the branch HEAD immediately. Defaults to true; set false only when updating connection metadata without a deploy.' },
        access_token: { type: 'string', description: 'GitHub personal access token (repo + webhook scope). Supply it to auto-install the push webhook and to read private repos. Omit on reconnect to keep the stored token; pass "" to clear it.' },
      },
      required: ['project_id', 'repo'],
    },
  },
    annotations: { title: 'Connect GitHub push-to-deploy', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    group: 'github',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const body: Record<string, unknown> = {
          project_id: args.project_id,
          repo: args.repo,
        };
        if (typeof args.branch === 'string') body.branch = args.branch;
        if (typeof args.root_dir === 'string') body.root_dir = args.root_dir;
        if (typeof args.installation_id === 'number') body.installation_id = args.installation_id;
        body.deploy_head = args.deploy_head !== false;
        // access_token maps to the route's github_token field. undefined =
        // keep stored, '' = clear, value = replace — preserved by only
        // forwarding the key when the arg is present.
        if (args.access_token !== undefined) body.github_token = args.access_token;
        result = await callAPI(fetcher, 'POST', '/v1/github/connect', authHeader, body);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'github_status',
    description: `Show a project's GitHub push-to-deploy connection: repo, branch, App/manual mode, and the last exact commit's deploy status/error. After \`github_connect\`, poll until that commit is \`deployed\` or \`failed\`; \`connected\` alone does not prove the site deployed. Returns \`{ connected: false }\` if no repo is connected.

**Example:**

\`\`\`json
{ "project_id": "my-saas" }
// Returns: { "connected": true, "repo": "alice/my-saas", "branch": "main", "hook_installed": true, "last_commit_sha": "...", "last_status": "deployed" }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: { project_id: { type: 'string', description: "Project ID (UUID), subdomain, slug, or 'default'." } },
      required: ['project_id'],
    },
  },
    annotations: { title: 'GitHub connection status', readOnlyHint: true, idempotentHint: true },
    group: 'github',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'GET', `/v1/github/connection?project_id=${encodeURIComponent(args.project_id as string)}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'github_disconnect',
    description: `Disconnect a project from GitHub push-to-deploy. Removes the connection and best-effort deletes a legacy per-repository webhook when present. Already-deployed code stays live—this only stops future pushes from auto-deploying.

**Example:**

\`\`\`json
{ "project_id": "my-saas" }
// Returns: { "disconnected": true }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: { project_id: { type: 'string', description: "Project ID (UUID), subdomain, slug, or 'default'." } },
      required: ['project_id'],
    },
  },
    annotations: { title: 'Disconnect GitHub', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    group: 'github',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'DELETE', `/v1/github/connection?project_id=${encodeURIComponent(args.project_id as string)}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'github_list_repos',
    description: `List repositories available to a GitHub App installation so you can pick one for \`github_connect\`. Preferred: pass \`installation_id\` from \`github_installations\`. A personal access token remains an optional compatibility fallback and is used only for this request.

**Example:**

\`\`\`json
{ "installation_id": 123 }
// Returns: [{ "name": "alice/my-saas", "private": false, "default_branch": "main", ... }]
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        installation_id: { type: 'number', description: 'Preferred. GitHub App installation from github_installations.' },
        access_token: { type: 'string', description: 'GitHub personal access token (read access to your repos). Used for this call only; not stored.' },
      },
      required: [],
    },
  },
    annotations: { title: 'List GitHub repos', readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    group: 'github',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        if (typeof args.installation_id === 'number') {
          result = await callAPI(
            fetcher,
            'GET',
            `/v1/github/app/repos?installation_id=${encodeURIComponent(args.installation_id)}`,
            authHeader,
          );
        } else if (typeof args.access_token === 'string' && args.access_token) {
          result = await callAPI(fetcher, 'GET', '/v1/github/repos', authHeader, undefined, {
            'X-GitHub-Token': args.access_token,
          });
        } else {
          result = { status: 400, data: { ok: false, error: 'VALIDATION_ERROR', message: 'installation_id or access_token is required.' } };
        }
        return result;

      }
    },
  },
  // ── db ─────────────────────────────────────────────
  {
    definition: {
    name: 'db_describe',
    description: `Schema inspection, list tables, show schema, table structure, columns, types — describe the project database. With no table argument, lists the table names. With a table name, returns its column names, types, constraints, and row count.

**Example:**

\`\`\`json
// List all tables:
{ "project_id": "my-saas" }

// Describe one table:
{ "project_id": "my-saas", "table": "users" }
// Returns: [{ "name": "id", "type": "TEXT", "pk": true }, { "name": "email", "type": "TEXT", "notnull": true }, ...]
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        table: { type: 'string', description: 'Optional table name. Omit to list all tables.' },
      },
      required: ['project_id'],
    },
  },
    annotations: { title: 'Describe DB schema', readOnlyHint: true, idempotentHint: true },
    group: 'db',
    core: true,
    coreRank: 27,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","connector","chatgpt"],
    protocol: { surfaceDescriptions: { connector: "Inspect a Somewhere project database. With no table, list table names; with a table, read its columns, types, constraints, and row count." }, oauthScopes: ['mcp'] },
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const params = new URLSearchParams();
        params.set('project_id', args.project_id as string);
        if (args.table) {
          // Single table schema
          params.set('table', args.table as string);
          result = await callAPI(fetcher, 'GET', `/v1/db/schema?${params.toString()}`, authHeader);
        } else {
          // List all tables
          result = await callAPI(fetcher, 'GET', `/v1/db/tables?${params.toString()}`, authHeader);
        }
        return result;

      }
    },
  },
  {
    definition: {
    name: 'db_query',
    description: `SQL query, run SQL, SELECT, INSERT, UPDATE, DELETE, execute SQL against the project database — the read/write-ROWS entry point. A documented Postgres-flavored syntax subset is translated; the default database keeps its own expression, typing, comparison, and ordering semantics. For example, division by zero returns NULL rather than throwing. The database is created on first use, but tables are not — define your schema with db_migrate first.

Schema changes (CREATE / ALTER / DROP) belong in db_migrate, NOT here and NEVER inline in a deployed function's handler: runtime DDL runs on every request, isn't versioned, and hides new tables from the platform's per-user data protections (a table with an owner_id/user_id column is cross-user readable until it's scoped). db_query is for the rows.

Every successful query returns \`{ data: [], count: N, changes: N, last_row_id: X }\`: \`data\` contains returned rows, \`count\` counts those rows, and \`changes\` counts affected rows. A write without RETURNING has empty \`data\` and a zero \`count\` even when it changes rows. \`last_row_id\` is a number, an exact decimal integer string when the ID exceeds JavaScript’s safe integer range, or null; other transport metadata may also be present.

**Example:**

\`\`\`json
{
  "project_id": "my-saas",
  "sql": "SELECT id, email FROM users WHERE created_at > ? ORDER BY created_at DESC LIMIT 20",
  "params": [1704067200]
}
\`\`\`

The database has a 30-second hard query ceiling. \`timeout_ms\` bounds how long this call waits (default 30000, max 30000) and returns QUERY_TIMEOUT; it does not promise cancellation of work already accepted by the database.`,
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        data: DATABASE_QUERY_RESULT_SCHEMA,
      },
      required: ['ok', 'data'],
      additionalProperties: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        sql: { type: 'string', description: 'SQL to execute. Use ? placeholders + params for user input (never string-concatenate).' },
        params: { type: ['array', 'string'], description: 'Bind parameters for ? placeholders. Prefer a native JSON array, e.g. ["alice@example.com", 42]. A JSON-stringified array is also accepted. Omit when there are no placeholders.' },
        timeout_ms: { type: 'number', description: 'Stop waiting after N ms. Default 30000. Clamped to [1, 30000]. Returns QUERY_TIMEOUT; already-accepted database work may continue up to the hard ceiling.' },
        ...DATABASE_TARGET_INPUT_PROPERTIES,
      },
      required: ['project_id', 'sql'],
    },
  },
    annotations: { title: 'Run SQL against project DB', readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    group: 'db',
    core: true,
    coreRank: 26,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","chatgpt","connector"],
    protocol: { surfaceDescriptions: { connector: "Execute SQL against a project database, with optional bound parameters. Statements can read, insert, update, or delete data; writes persist." }, surfaceAnnotations: { chatgpt: { destructiveHint: true }, connector: {"title":"Db Query","readOnlyHint":false,"destructiveHint":true} }, oauthScopes: ['mcp'] },
    execute: async (runtime, args) => {
      const { fetcher, env, authHeader, ctx, toolName } = runtime;
      let result: ToolUpstreamResult;
      {
        const params = args.params ? parseJsonArg(args.params, 'params') : undefined;
        if (typeof args.sql !== 'string' || !args.sql.trim()) {
          return badArgsToolResult(
            env, authHeader, ctx, toolName, args,
            'db_query requires a non-empty sql string.\nExample:\ndb_query({ "project_id": "my-app", "sql": "SELECT * FROM users WHERE id = ?", "params": ["usr_123"] })\nUse db_migrate for CREATE/ALTER/DROP schema changes.',
          );
        }
        if (params !== undefined && !Array.isArray(params)) {
          return badArgsToolResult(
            env, authHeader, ctx, toolName, args,
            'db_query params must be an array that matches the ? placeholders.\nExample:\ndb_query({ "project_id": "my-app", "sql": "SELECT * FROM users WHERE id = ?", "params": ["usr_123"] })\nOmit params entirely when the SQL has no placeholders.',
          );
        }
        result = await callAPI(fetcher,'POST', '/v1/db/query', authHeader, {
          project_id: args.project_id,
          sql: args.sql,
          params,
          ...(args.timeout_ms !== undefined ? { timeout_ms: args.timeout_ms } : {}),
          ...databaseTargetBody(args),
        });
        return result;

      }
    },
  },
  // ── code ─────────────────────────────────────────────
  {
    definition: {
    name: 'run_code',
    description: `Run a short script once, server-side, against a project's own bindings — get the result + console logs back in one call. Use this instead of deploying a throwaway debug endpoint or making dozens of tool calls to inspect data, try a query variant, or run a one-off transformation.

\`code\` is an ES module whose default async function receives \`sw\` (the same database / files / search / ai bindings a deployed function gets) and returns a JSON-serializable value:

\`\`\`json
{
  "project_id": "my-saas",
  "code": "export default async function (sw) { const r = await sw.db.query('SELECT count(*) AS n FROM users'); return r.data[0]; }"
}
\`\`\`

Runs with the project's OWN authority, not your developer key: no env secrets unless you pass \`include_env: true\`, no admin, no cross-project access, and outbound fetch is limited to public hosts. Returns \`{ result, logs, duration_ms, error? }\`. \`result\` is capped at 256KB (truncated with a notice past that); \`timeout_ms\` defaults to 10000, max 30000.

**Threading state across calls (opt-in):** pass a stable \`session_id\` to carry explicit JSON state between runs. The saved JSON is exposed to your script as a read-only \`sw.session\`; to save state for the next call, return a \`{ session: {...} }\` object (it is stored under that \`session_id\`, separately from \`result\`). Absent \`session_id\` = stateless, byte-identical to a normal run. This is explicit data you thread by id — NOT live-variable/closure persistence.`,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, slug, or 'default'. Resolved server-side." },
        code: { type: 'string', description: 'ES module source: export default async function (sw) { ...; return value }. The default export is called with sw; its (JSON-serializable) return value comes back as result.' },
        timeout_ms: { type: 'number', description: 'Abort the script after N ms. Default 10000. Clamped to [1, 30000].' },
        include_env: { type: 'boolean', description: 'Expose the project env vars as sw.env. Default false — leave off unless the script genuinely needs a secret.' },
        session_id: { type: 'string', description: 'Opt-in session key (<=128 chars, [A-Za-z0-9_-]). Loads saved JSON as a read-only sw.session before the run; return { session } to persist for the next call (stored state capped at 64KB). Absent = stateless.' },
      },
      required: ['project_id', 'code'],
    },
  },
    annotations: { title: 'Run code against the project', readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    group: 'code',
    core: true,
    coreRank: 35,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","chatgpt","connector"],
    protocol: { surfaceDescriptions: { connector: "Execute a short ES-module script against one project’s live bindings and return JSON plus console logs. The default async function receives sw. Writes persist; the script is temporary. Optional session_id preserves explicit returned JSON between runs. include_env exposes project secrets only when true. Platform AI media generation and financial transfers are unavailable in connector runs. Runtime API reference: https://somewhere.tech/docs.txt." }, surfaceAnnotations: { chatgpt: { destructiveHint: true, openWorldHint: true }, connector: {"title":"Run Code","readOnlyHint":false,"destructiveHint":true} }, oauthScopes: ['mcp'] },
    execute: async (runtime, args) => {
      const { env, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        // Rooted at the runner worker, NOT the API worker (env.API_SERVICE) —
        // see callRunner. Routing this through the API worker would self-loop (522).
        result = await callRunner(env, 'POST', '/run', authHeader, {
          project_id: args.project_id,
          code: args.code,
          timeout_ms: args.timeout_ms,
          include_env: args.include_env,
          session_id: args.session_id,
          ...(runtime.surface === 'connector' ? { execution_policy: 'connector' } : {}),
        });
        return result;

      }
    },
  },
  // ── db ─────────────────────────────────────────────
  {
    definition: {
    name: 'db_batch',
    description: `Run multiple SQL statements as a single atomic transaction. Every statement commits together, or none do — a single failure rolls the entire batch back. Use this whenever a logical operation spans more than one write (account deletion across multiple tables, moving money between rows, denormalized counters). Max 1000 statements per call.

Each statement returns its own \`{ rows, count, changes, last_row_id }\` in \`results[i]\` matching the order you passed in.

**Example (account deletion):**

\`\`\`json
{
  "project_id": "my-saas",
  "statements": [
    { "sql": "UPDATE accounts SET status = 'deleted' WHERE id = ?", "params": ["u_abc"] },
    { "sql": "DELETE FROM sessions WHERE user_id = ?",            "params": ["u_abc"] },
    { "sql": "DELETE FROM posts WHERE author_id = ?",             "params": ["u_abc"] }
  ]
}
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        statements: { type: ['array', 'string'], description: 'Array of { sql, params? } objects. Prefer a native JSON array; a JSON-stringified array is also accepted. Each runs atomically; any error rolls every statement back. Max 1000.' },
        ...DATABASE_TARGET_INPUT_PROPERTIES,
      },
      required: ['project_id', 'statements'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    group: 'db',
    core: true,
    coreRank: 65,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, env, authHeader, ctx, toolName } = runtime;
      let result: ToolUpstreamResult;
      {
        let statements = args.statements !== undefined ? parseJsonArg(args.statements, 'statements') : undefined;
        if (statements === undefined && typeof args.sql === 'string') {
          const params = args.params ? parseJsonArg(args.params, 'params') : undefined;
          if (params !== undefined && !Array.isArray(params)) {
            return badArgsToolResult(
              env, authHeader, ctx, toolName, args,
              'db_batch params must be an array when using the sql shortcut.\nExample:\ndb_batch({ "project_id": "my-app", "statements": [{ "sql": "INSERT INTO users(email) VALUES (?)", "params": ["a@example.com"] }] })\nUse db_query for a single standalone SQL statement.',
            );
          }
          statements = [{ sql: args.sql, ...(params !== undefined ? { params } : {}) }];
        }
        if (isRecord(statements)) statements = [statements];
        if (!Array.isArray(statements) || statements.length === 0) {
          return badArgsToolResult(
            env, authHeader, ctx, toolName, args,
            'db_batch statements must be a non-empty array of { sql, params? } objects.\nExample:\ndb_batch({ "project_id": "my-app", "statements": [{ "sql": "UPDATE users SET name = ? WHERE id = ?", "params": ["Alice", "usr_123"] }] })\nUse db_query({ project_id, sql, params }) for one statement.',
          );
        }
        for (let i = 0; i < statements.length; i++) {
          const statement = statements[i];
          if (!isRecord(statement) || typeof statement.sql !== 'string' || (statement.params !== undefined && !Array.isArray(statement.params))) {
            return badArgsToolResult(
              env, authHeader, ctx, toolName, args,
              `db_batch statements[${i}] must be { sql: string, params?: array }.\nExample:\ndb_batch({ "project_id": "my-app", "statements": [{ "sql": "INSERT INTO users(email) VALUES (?)", "params": ["a@example.com"] }] })\nAll statements run atomically.`,
            );
          }
        }
        result = await callAPI(fetcher, 'POST', '/v1/db/batch', authHeader, {
          project_id: args.project_id,
          statements,
          ...databaseTargetBody(args),
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'db_migrate',
    description: `Create a table / add a column / change the schema — run a schema migration (DDL) against the project database. Use for CREATE TABLE, ALTER TABLE, ADD COLUMN, CREATE INDEX, DROP. This is how you set up your database tables before inserting data. Multiple statements allowed, separated by \`;\`. Idempotent migrations (\`IF NOT EXISTS\`) are safe to re-run. Developer-only — app-user JWTs are rejected.

**Example:**

\`\`\`json
{
  "project_id": "my-saas",
  "sql": "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, created_at INTEGER); CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);"
}
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        sql: { type: 'string', description: 'DDL statements separated by semicolons.' },
        ...DATABASE_TARGET_INPUT_PROPERTIES,
      },
      required: ['project_id', 'sql'],
    },
  },
    annotations: { title: 'Run DDL migration', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    group: 'db',
    core: true,
    coreRank: 28,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","chatgpt","connector"],
    protocol: { surfaceDescriptions: { connector: "Apply a SQL migration to a project database. Schema and data changes persist." }, surfaceAnnotations: { chatgpt: { destructiveHint: true }, connector: {"title":"Db Migrate","readOnlyHint":false,"destructiveHint":true} }, oauthScopes: ['mcp'] },
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher,'POST', '/v1/db/migrate', authHeader, {
          project_id: args.project_id,
          sql: args.sql,
          ...databaseTargetBody(args),
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'db_import',
    description: `Bring an existing database table under schema management — introspect a table you already have and GENERATE its \`db/schema.ts\` entry so a deploy can manage it. Read-only: it proposes an entry you paste into db/schema.ts and deploy; the deploy is what adopts the table (never a hidden change).

The generated entry preserves the table's shape faithfully — column types, single-column primary key, indexes, unique constraints, auto-timestamp defaults, and (for a per-user table) its owner column as \`owner({ column })\`. A composite primary key, a view, a triggered table, or a column type the managed schema can't represent is refused with a plain fix-it. A column whose stored values don't match its declared type is loosened and reported, never silently changed.

Pass \`with\` when importing several related tables at once so a foreign key between them can be represented.

**Example:**

\`\`\`json
{
  "project_id": "my-saas",
  "table": "products"
}
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side. 'default' works when the account has exactly one project." },
        table: { type: 'string', description: 'The existing table to import into schema management.' },
        with: { type: 'array', items: { type: 'string' }, description: 'Other tables imported in the same batch, so a foreign key between them can be represented. Optional.' },
      },
      required: ['project_id', 'table'],
    },
  },
    annotations: { title: 'Import a table into schema management', readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    group: 'db',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","chatgpt","connector"],
    protocol: { surfaceDescriptions: { connector: "Read an existing table and generate its managed schema declaration without changing the database." }, surfaceAnnotations: { connector: {"title":"Db Import","readOnlyHint":true} },  oauthScopes: ['mcp'] },
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      const body: Record<string, unknown> = { project_id: args.project_id, table: args.table };
      if (args.with !== undefined) body.with = args.with;
      return await callAPI(fetcher, 'POST', '/v1/db/import', authHeader, body);
    },
  },
  {
    definition: {
    name: 'db_import_csv',
    description: `Import CSV data into a database table. If the table doesn't exist and \`create_table\` is true, it will be created with column types inferred from the data (INTEGER / REAL / TEXT). Headers in the CSV become column names.

Inline CSV strings are capped at 5 MB. For larger files, upload to \`/v1/fs\` first and pass the filepath.

**Example:**

\`\`\`json
{
  "project_id": "my-saas",
  "table": "products",
  "csv": "name,price\\nWidget,9.99\\nGadget,19.99",
  "create_table": true
}
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        table: { type: 'string', description: 'Target table name.' },
        csv: { type: 'string', description: 'Inline CSV body. Either csv or file_path is required.' },
        file_path: { type: 'string', description: 'Path of a CSV in your project files (e.g. "/data/products.csv"). Alternative to csv.' },
        create_table: { type: 'boolean', description: 'Create the table from CSV headers if it does not exist. Default false.' },
      },
      required: ['project_id', 'table'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    group: 'db',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', '/v1/db/import', authHeader, {
          project_id: args.project_id,
          table: args.table,
          ...(args.csv !== undefined ? { csv: args.csv } : {}),
          ...(args.file_path !== undefined ? { file_path: args.file_path } : {}),
          ...(args.create_table !== undefined ? { create_table: args.create_table } : {}),
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'db_browse',
    description: `Browse rows in a database table with pagination, sorting, and filtering. Use this to inspect data without writing SQL.

Filters use the same operators as db_query: \`eq\`, \`neq\`, \`gt\`, \`gte\`, \`lt\`, \`lte\`, \`like\`, \`ilike\`, \`is\`, \`not\`.

**Example:**

\`\`\`json
{
  "project_id": "my-saas",
  "table": "users",
  "limit": 10,
  "order_by": "created_at",
  "order": "desc",
  "filters": [{ "column": "email_verified", "op": "eq", "value": true }]
}
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        table: { type: 'string', description: 'Table to browse.' },
        limit: { type: 'number', description: '1-500, default 50.' },
        offset: { type: 'number', description: 'Default 0.' },
        order_by: { type: 'string', description: 'Column to sort by.' },
        order: { type: 'string', description: 'asc | desc. Default desc.' },
        filters: {
          type: 'array',
          description: 'Optional filters: [{ column, op, value }]. Operators: eq, neq, gt, gte, lt, lte, like, ilike, is, not.',
        },
      },
      required: ['project_id', 'table'],
    },
  },
    annotations: { title: 'Browse DB rows', readOnlyHint: true, idempotentHint: true },
    group: 'db',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const filters = args.filters ? parseJsonArg(args.filters, 'filters') : undefined;
        result = await callAPI(fetcher, 'POST', '/v1/db/rows', authHeader, {
          project_id: args.project_id,
          table: args.table,
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
          ...(args.offset !== undefined ? { offset: args.offset } : {}),
          ...(args.order_by !== undefined ? { order_by: args.order_by } : {}),
          ...(args.order !== undefined ? { order: args.order } : {}),
          ...(filters !== undefined ? { filters } : {}),
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'db_export',
    description: `Export a database table as CSV. Returns the CSV content as a string. Pass filters to export a subset (same shape as db_browse). Capped at 100,000 rows — use filters for larger tables.

**Example:**

\`\`\`json
{ "project_id": "my-saas", "table": "users" }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        table: { type: 'string', description: 'Table to export.' },
        filters: {
          type: 'array',
          description: 'Optional filters in the same shape as db_browse. If omitted, exports all rows up to the cap.',
        },
      },
      required: ['project_id', 'table'],
    },
  },
    annotations: { readOnlyHint: true, idempotentHint: true },
    group: 'db',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        // db_export returns text/csv, not JSON — fetch directly so we
        // can wrap the CSV body in a tool-friendly result envelope.
        const filters = args.filters ? parseJsonArg(args.filters, 'filters') : undefined;
        const exportReq = new Request('https://api-internal/v1/db/export', {
          method: 'POST',
          headers: {
            'Authorization': authHeader,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            project_id: args.project_id,
            table: args.table,
            ...(filters !== undefined ? { filters } : {}),
          }),
        });
        const exportResp = await fetcher.fetch(exportReq);
        const ct = exportResp.headers.get('Content-Type') || '';
        if (!ct.includes('text/csv')) {
          // Error path — upstream returned JSON envelope
          const body = await exportResp.text();
          let parsed: unknown;
          try { parsed = JSON.parse(body); } catch { parsed = { ok: false, error: 'UPSTREAM_ERROR', message: body.slice(0, 500) }; }
          result = { status: exportResp.status, data: parsed };
        } else {
          const csv = await exportResp.text();
          result = {
            status: exportResp.status,
            data: {
              ok: true,
              data: {
                table: args.table,
                csv,
                row_count: parseInt(exportResp.headers.get('X-Row-Count') || '0', 10),
                ...(exportResp.headers.get('X-Truncated') ? { truncated: exportResp.headers.get('X-Truncated') } : {}),
              },
            },
          };
        }
        return result;

      }
    },
  },
  {
    definition: {
    name: 'db_dump',
    description: `Full SQL dump of the project's database — schema (CREATE TABLE / INDEX / TRIGGER) + every row as INSERT statements. The output is standard SQL you can pipe into any SQL database client to restore, or migrate to Postgres via \`pgloader\`.

Returns the raw .sql file as a string. One call gives you the complete database schema and rows to take anywhere.

Table access declarations and sensitive-column marks are platform policy, not SQL. Their labels travel as comment lines in the SQL preamble and, parsed, as \`excluded_security_policy.policies\` (labels only, never applied by a SQL restore); a warning appears only when the list is non-empty. \`policies: []\` on a successful capture means no table-access declarations were found in this capture — it does not establish that access is safe or preserve your application's authorization, and member join definitions and handler authorization are outside that list. After restoring, re-declare with \`db_scope_set\` or redeploy \`db/schema.ts\`, then verify with \`db_scope_list\`.

\`excluded_security_policy.capture\` (v1) is the capture receipt, carrying identity, hashes and times only: canonical \`project_id\` and \`database_id\` (the top-level \`project_id\` echoes your reference), \`sql_sha256\` / \`schema_sha256\` / \`policy_sha256\`, and \`policy_observed_at\`, \`data_observation_started_at\`, \`data_observation_completed_at\`, \`binding_checked_at\`. The hashes detect changed bytes against metadata you retain; they are not a signature, not provenance, and not a cross-store snapshot. Matching binding checks before and after mean the same project, owner and database were observed; they do not exclude a change in between. When capture metadata is present but malformed, or its SQL or policy hash does not match, this tool returns \`DUMP_INTEGRITY_UNCONFIRMED\` (502) and no SQL. An absent \`capture\` (an older API during a rolling release) means no capture-integrity evidence; the informational policy labels may still be present.

Refusals, never a partial file: \`DATABASE_NOT_INITIALIZED\` (409 — the dump never creates a database), \`DUMP_SOURCE_CHANGED\` (409), \`DUMP_SCHEMA_CHANGED\` (409), \`DUMP_POLICY_INVALID\` (422), \`DUMP_UNSUPPORTED_SCHEMA\` (422), \`DUMP_ROW_LIMIT_EXCEEDED\` (413, above 1,000,000 rows in a table — no truncation and no streaming export; narrow with \`db_export_csv\` filters), \`DUMP_CAPTURE_LIMIT_EXCEEDED\` (413), \`DUMP_POLICY_UNAVAILABLE\` (503), \`DUMP_CAPTURE_UNCONFIRMED\` (503), \`DUMP_SCHEMA_UNAVAILABLE\` (503), \`PROJECT_ACCESS_DENIED\` (403).

**Example:**

\`\`\`json
{ "project_id": "my-saas" }
// Returns the full .sql as text — write it to disk and you're portable.
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
      },
      required: ['project_id'],
    },
  },
    annotations: { title: 'Export the full database as SQL', readOnlyHint: true, idempotentHint: true },
    group: 'db',
    core: true,
    coreRank: 29,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","connector"],
    protocol: { surfaceDescriptions: { connector: "Read a project database export as SQL, including schema and data." }, surfaceAnnotations: { connector: {"title":"Db Dump","readOnlyHint":true} },  },
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        // db_dump returns application/sql, not JSON — fetch directly
        // so we can return the raw SQL in a tool-friendly envelope.
        const dumpReq = new Request('https://api-internal/v1/db/dump', {
          method: 'POST',
          headers: {
            'Authorization': authHeader,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ project_id: args.project_id }),
        });
        const dumpResp = await fetcher.fetch(dumpReq);
        result = await databaseDumpResult(dumpResp, args.project_id);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'db_scope_set',
    description: `Legacy SQL-mode projects only. A project with a managed \`db/schema.ts\` declares table access in that file (scope: owner() / shared() / member() / serverOnly(), plus a \`client\` block for browser access) and deploys; on those projects this call is refused with \`SCHEMA_MANAGED\`, and browsers reach data through the generated \`somewhere:data\` client (see docs({ topic: 'declared-data' })).

For a SQL-mode project: declare a database table as per-user scoped — the platform scopes STRUCTURED queries against it (\`sw.db.from\` / \`count\` / \`insert\` / \`update\` / \`remove\`) to the rows the signed-in user owns (their \`owner_column\` value). Developer-only. Scoping applies only to the structured builder the platform composes; raw \`sw.db.query\` SQL is trusted server code and runs exactly as written, so write the ownership filter into raw statements yourself (\`WHERE user_id = ?\`). On the legacy SQL-mode HTTP/SDK surface, app-user browser requests to the database are refused with \`BROWSER_DB_ACCESS_REMOVED\`; a SQL-mode app's browser reaches data only through its server functions.

Pass \`intent: "shared"\` to mark a SQL-mode table as intentionally cross-user, or re-call to lift enforcement on an already-scoped table (keeps the row on record, turns off enforcement, rebakes live functions). The same call is available in-band from a deployed function or run_code script as \`await sw.db.scope("bookings", { owner_column: "user_id" })\` on SQL-mode projects.

**Example:**

\`\`\`json
{ "project_id": "my-saas", "table": "bookings", "owner_column": "user_id" }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        table: { type: 'string', description: 'Table to scope.' },
        owner_column: { type: 'string', description: 'The column holding the owning user id (e.g. user_id, owner_id). Required only when intent is "scoped".' },
        sensitive_columns: { type: 'array', description: 'Optional list of column names to mark sensitive — the dashboard redacts them by default with click-to-reveal.' },
        intent: { type: 'string', enum: ['scoped', 'shared', 'server_only'], description: '"scoped" (default) arms per-user enforcement on owner_column; "shared" marks the table intentionally cross-user; "server_only" rejects direct app-user access while bare trusted server queries pass.' },
      },
      required: ['project_id', 'table'],
    },
  },
    annotations: { title: 'Declare a per-user table scope', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    group: 'db',
    core: true,
    coreRank: 74,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","connector","chatgpt"],
    protocol: { surfaceAnnotations: { chatgpt: { destructiveHint: true }, connector: { destructiveHint: true } }, surfaceDescriptions: { connector: "Declare the owner column and access scope for a Somewhere project database table. This changes authorization rules for structured database access." }, oauthScopes: ['mcp'] },
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const sensitive = args.sensitive_columns
          ? parseJsonArg(args.sensitive_columns, 'sensitive_columns')
          : undefined;
        result = await callAPI(fetcher, 'POST', '/v1/db/scopes', authHeader, {
          project_id: args.project_id,
          table: args.table,
          ...(args.owner_column !== undefined ? { owner_column: args.owner_column } : {}),
          ...(sensitive !== undefined ? { sensitive_columns: sensitive } : {}),
          ...(args.intent !== undefined ? { intent: args.intent } : {}),
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'db_scope_list',
    description: `List the table scopes a project has on record, plus tables that LOOK like per-user data (a user_id/owner_id-style column) with no scope on record. An entry in \`unscoped_user_tables\` is a finding to inspect under the table's actual access contract, not a verdict: on a managed project the contract is the table's declaration in \`db/schema.ts\` (and structured queries on an undeclared table are refused, not run unscoped); on a SQL-mode project it is what db_scope_set recorded, and raw SQL in server functions is unscoped by design. Developer-only.

**Example:**

\`\`\`json
{ "project_id": "my-saas" }
// Returns: { "scopes": [{ "table": "bookings", "owner_column": "user_id", "intent": "scoped", ... }], "unscoped_user_tables": [{ "table": "notes", "owner_column": "user_id" }] }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
      },
      required: ['project_id'],
    },
  },
    annotations: { title: 'List per-user table scopes', readOnlyHint: true, idempotentHint: true },
    group: 'db',
    core: true,
    coreRank: 75,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","connector","chatgpt"],
    protocol: { surfaceDescriptions: { connector: "Read configured table ownership and access scopes for a Somewhere project database." }, oauthScopes: ['mcp'] },
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'GET', `/v1/db/scopes?project_id=${encodeURIComponent(String(args.project_id))}`, authHeader);
        return result;

      }
    },
  },
  // ── auth ─────────────────────────────────────────────
  {
    definition: {
    name: 'auth_signup',
    description: `Register user, create account, new user, sign up, onboard user — sign up a new end user for your app. Returns the user ID and authentication token. Passwords are securely hashed. Call this from your server-side code, not from browser code.

**Example:**

\`\`\`json
{ "project_id": "my-saas", "email": "alice@example.com", "password": "s3cure!Pass" }
// Returns: { "user_id": "u_abc", "token": "eyJ...", "refresh_token": "rt_..." }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        email: { type: 'string', description: "User's email" },
        password: { type: 'string', description: 'Min 8 characters. Securely hashed server-side.' },
        display_name: { type: 'string', description: 'Optional display name' },
        displayName: { type: 'string', description: 'Alias for display_name' },
        full_name: { type: 'string', description: 'Alias for display_name' },
        fullName: { type: 'string', description: 'Alias for display_name' },
        name: { type: 'string', description: 'Alias for display_name' },
      },
      required: ['project_id', 'email', 'password'],
    },
  },
    annotations: { title: 'Create an end-user account', readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    group: 'auth',
    core: true,
    coreRank: 37,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","connector"],
    protocol: { surfaceDescriptions: { connector: "Create an app-user account in a project using the supplied credentials." }, surfaceAnnotations: { connector: {"title":"Auth Signup","readOnlyHint":false,"destructiveHint":true} },  },
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', '/v1/auth/signup', authHeader, {
          project_id: args.project_id,
          email: args.email,
          password: args.password,
          display_name: args.display_name ?? args.displayName ?? args.full_name ?? args.fullName ?? args.name,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'auth_login',
    description: `Sign in user, authenticate, login user, password check, end-user login — log in an existing end user of your app. Returns user profile, authentication token, and session token.

**Example:**

\`\`\`json
{ "project_id": "my-saas", "email": "alice@example.com", "password": "s3cure!Pass" }
// Returns: { "user": { "id": "u_abc", "email": "alice@example.com" }, "token": "eyJ...", "session_token": "st_...", "refresh_token": "rt_..." }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        email: { type: 'string', description: "User's email" },
        password: { type: 'string', description: "User's password" },
      },
      required: ['project_id', 'email', 'password'],
    },
  },
    annotations: { title: 'Sign in an end-user', readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    group: 'auth',
    core: true,
    coreRank: 38,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","connector"],
    protocol: { surfaceDescriptions: { connector: "Authenticate an app user and create a session using the supplied credentials." }, surfaceAnnotations: { connector: {"title":"Auth Login","readOnlyHint":false,"destructiveHint":true} },  },
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', '/v1/auth/login', authHeader, {
          project_id: args.project_id,
          email: args.email,
          password: args.password,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'auth_me',
    description: `Get the current end user's profile from their authentication token.

**Example:**

\`\`\`json
{ "app_token": "eyJ..." }
// Returns: { "id": "u_abc", "email": "alice@example.com", "email_verified": true, "display_name": "Alice" }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        app_token: { type: 'string', description: 'App-user JWT to validate. Returns the matching user row.' },
      },
      required: ['app_token'],
    },
  },
    annotations: { title: 'Show current user', readOnlyHint: true, idempotentHint: true },
    group: 'auth',
    core: true,
    coreRank: 36,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","connector"],
    protocol: { surfaceDescriptions: { connector: "Read the app user associated with the supplied session." }, surfaceAnnotations: { connector: {"title":"Auth Me","readOnlyHint":true} },  },
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        // BFF mode: send the developer key in Authorization plus the
        // app_user JWT in X-App-Token. /v1/auth/me reads either auth.
        const headers = new Headers({
          'Authorization': authHeader,
          'X-App-Token': args.app_token as string,
        });
        const req = new Request('https://api-internal/v1/auth/me', { method: 'GET', headers });
        const resp = await fetcher.fetch(req);
        result = { status: resp.status, data: await resp.json() };
        return result;

      }
    },
  },
  {
    definition: {
    name: 'auth_google_url',
    description: `Get a Google OAuth URL for end-user login. Redirect users to this URL to start the OAuth flow. After login, the platform redirects back to redirect_uri with a short-lived authorization code in the query string (\`?code=...\`). The JWT is never put in the URL — your backend exchanges the code for the JWT via POST /v1/auth/google/exchange (smt_ key required, server-side only), or via \`sw.auth.googleExchange({ code })\` from inside a deployed function. Codes are single-use and expire after 60 seconds. See docs({ topic: 'sw.auth' }) for the full flow.

**Example:**

\`\`\`json
{ "project_id": "my-saas", "redirect_uri": "https://my-saas.somewhere.site/auth/callback" }
// Returns: { "url": "https://api.somewhere.tech/v1/auth/google?project_id=...&redirect_uri=..." }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        redirect_uri: { type: 'string', description: 'URL to redirect to after OAuth completes — receives ?code=AUTH_CODE (not the JWT). Your backend exchanges the code for a JWT via POST /v1/auth/google/exchange.' },
      },
      required: ['project_id', 'redirect_uri'],
    },
  },
    annotations: { readOnlyHint: false, openWorldHint: true },
    group: 'auth',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      {
        // Public custom-domain URL — was hardcoded to the .workers.dev
        // staging hostname which leaked into end-user OAuth flows.
        const url = `https://api.somewhere.tech/v1/auth/google?project_id=${encodeURIComponent(args.project_id as string)}&redirect_uri=${encodeURIComponent(args.redirect_uri as string)}`;
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { url } }, null, 2) }],
        };

      }
    },
  },
  {
    definition: {
    name: 'auth_users_list',
    description: 'List end-user accounts of your app — the people who signed up via auth_signup. Distinct from `project_list` (your own projects). Returns id, email, display_name, email_verified, created_at, last_login_at. Paginated by created_at descending.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        search: { type: 'string', description: 'Optional case-insensitive email substring filter' },
        limit: { type: 'number', description: 'Page size (default 50, max 200)' },
        cursor: { type: 'string', description: 'Pagination cursor from a previous response' },
      },
      required: ['project_id'],
    },
  },
    annotations: { title: 'List app users', readOnlyHint: true, idempotentHint: true },
    group: 'auth',
    core: true,
    coreRank: 94,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","connector"],
    protocol: { surfaceDescriptions: { connector: "List app-user accounts for an authorized project." }, surfaceAnnotations: { connector: {"title":"Auth Users List","readOnlyHint":true} },  },
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const params = new URLSearchParams();
        params.set('project_id', args.project_id as string);
        if (args.search) params.set('search', args.search as string);
        if (args.limit) params.set('limit', String(args.limit));
        if (args.cursor) params.set('cursor', args.cursor as string);
        result = await callAPI(fetcher, 'GET', `/v1/auth/users?${params.toString()}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'auth_user_delete',
    description: 'Delete an end-user account by id from one of your projects. Cascades through sessions, password resets, and email verifications. Use this for admin tooling and test-harness cleanup — end users delete their own account through their app, not via this tool. Customer data in your project database is NOT touched (delete those rows yourself before calling this).',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        user_id: { type: 'string', description: 'The end-user id to delete (from auth_users_list or auth_signup)' },
      },
      required: ['project_id', 'user_id'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    group: 'auth',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const params = new URLSearchParams();
        params.set('project_id', args.project_id as string);
        result = await callAPI(
          fetcher,
          'DELETE',
          `/v1/auth/users/${encodeURIComponent(args.user_id as string)}?${params.toString()}`,
          authHeader,
        );
        return result;

      }
    },
  },
  {
    definition: {
    name: 'auth_user_update',
    description: "Edit an end-user account by id from one of your projects. Updatable fields: display_name, metadata, role, banned, banned_reason. This developer-key control-plane tool is the safe way to grant the first admin: signup always creates role=user, so an app user cannot self-promote. Email and password are intentionally NOT editable here (they have their own verification + reset flows). metadata is REPLACED, not merged; max 16 KB. Changing role is audited and invalidates existing access tokens. Passing banned:true wipes the user's sessions and refresh tokens — they're booted everywhere the next time /me runs.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        user_id: { type: 'string', description: 'The end-user id to update (from auth_users_list or auth_signup)' },
        display_name: { type: 'string', description: 'New display name (max 200 chars). Pass null via raw JSON to clear.' },
        metadata: { type: 'object', description: 'Replacement metadata blob (any JSON-serializable object, max 16 KB). Pass null via raw JSON to clear.' },
        role: { type: 'string', enum: ['user', 'admin'], description: 'Platform-owned app role. Only this developer-key control-plane path can change it; app-user profile updates cannot.' },
        banned: { type: 'boolean', description: 'Set true to suspend the account; false to lift the ban. Suspended users can\'t log in, refresh, or use any existing JWT (next /me call returns 403 AUTH_BANNED).' },
        banned_reason: { type: 'string', description: 'Operator-set free text shown only in admin tooling (never to the user). Max 1000 chars.' },
      },
      required: ['project_id', 'user_id'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    group: 'auth',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const params = new URLSearchParams();
        params.set('project_id', args.project_id as string);
        const body: Record<string, unknown> = {};
        if (args.display_name !== undefined) body.display_name = args.display_name;
        if (args.metadata !== undefined) body.metadata = args.metadata;
        if (args.role !== undefined) body.role = args.role;
        if (args.banned !== undefined) body.banned = args.banned;
        if (args.banned_reason !== undefined) body.banned_reason = args.banned_reason;
        result = await callAPI(
          fetcher,
          'PATCH',
          `/v1/auth/users/${encodeURIComponent(args.user_id as string)}?${params.toString()}`,
          authHeader,
          body,
        );
        return result;

      }
    },
  },
  {
    definition: {
    name: 'auth_impersonate',
    description: `Mint a 1-hour access token bound to a target end user so you can act as them (support reproduction, admin tooling, debugging). The token carries \`impersonating: true\` plus \`impersonator_id\` claims, so any audit log can tell impersonated requests apart. No refresh token is issued — mint a fresh one if you need more time. Banned users cannot be impersonated.

**Example:**

\`\`\`json
{ "project_id": "my-saas", "user_id": "au_abc123" }
// Returns: { "access_token": "eyJ...", "user": {...}, "expires_in": 3600, "impersonating": true }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        user_id: { type: 'string', description: 'The end-user id to impersonate' },
      },
      required: ['project_id', 'user_id'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    group: 'auth',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const params = new URLSearchParams();
        params.set('project_id', args.project_id as string);
        result = await callAPI(
          fetcher,
          'POST',
          `/v1/auth/users/${encodeURIComponent(args.user_id as string)}/impersonate?${params.toString()}`,
          authHeader,
          {},
        );
        return result;

      }
    },
  },
  {
    definition: {
    name: 'auth_list_sessions',
    description: "List a user's active sessions (most recent first). Returns session id, created_at, expires_at — never the session token itself (we only store hashes). Use the id with auth_revoke_session to kill a single device.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        user_id: { type: 'string', description: 'The end-user id whose sessions to list' },
      },
      required: ['project_id', 'user_id'],
    },
  },
    annotations: { readOnlyHint: true, idempotentHint: true },
    group: 'auth',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const params = new URLSearchParams();
        params.set('project_id', args.project_id as string);
        result = await callAPI(
          fetcher,
          'GET',
          `/v1/auth/users/${encodeURIComponent(args.user_id as string)}/sessions?${params.toString()}`,
          authHeader,
        );
        return result;

      }
    },
  },
  {
    definition: {
    name: 'auth_revoke_session',
    description: "Revoke a single session by id (from auth_list_sessions). The session token immediately stops authenticating. Pair with banning if you also want to kill the 1-hour access JWT before it expires.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        session_id: { type: 'string', description: 'Session id from auth_list_sessions' },
      },
      required: ['project_id', 'session_id'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    group: 'auth',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const params = new URLSearchParams();
        params.set('project_id', args.project_id as string);
        result = await callAPI(
          fetcher,
          'DELETE',
          `/v1/auth/sessions/${encodeURIComponent(args.session_id as string)}?${params.toString()}`,
          authHeader,
        );
        return result;

      }
    },
  },
  {
    definition: {
    name: 'auth_revoke_all_sessions',
    description: "Revoke every session AND refresh token the user holds. Force-logout the user everywhere. Active 1-hour access JWTs keep validating signature-wise until they expire — pair with auth_user_update {banned:true} for immediate cut-off.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        user_id: { type: 'string', description: 'The end-user id whose sessions + refresh tokens to wipe' },
      },
      required: ['project_id', 'user_id'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    group: 'auth',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const params = new URLSearchParams();
        params.set('project_id', args.project_id as string);
        result = await callAPI(
          fetcher,
          'DELETE',
          `/v1/auth/users/${encodeURIComponent(args.user_id as string)}/sessions?${params.toString()}`,
          authHeader,
        );
        return result;

      }
    },
  },
  {
    definition: {
    name: 'auth_webhook_set',
    description: "Configure a project-scoped webhook URL that fires on app-user lifecycle events (currently auth.user.deleted; more events later). Use this to clean up your own per-project tables (posts.author_id, comments.user_id, etc.) when a user is deleted — the platform cascades sessions/resets/verifications but not your application data, so without a webhook those rows are orphaned. Returns the HMAC secret used to sign delivery — store it server-side. Re-call with rotate_secret=true to rotate. Signature header X-Somewhere-Signature: t={ms},v1={hex} computed as HMAC-SHA256({ms}.{rawBody}, secret). Same scheme as inbox webhooks.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        url: { type: 'string', description: 'Absolute https:// URL the platform will POST events to. http:// is allowed for local development.' },
        rotate_secret: { type: 'boolean', description: 'If true, generate a fresh HMAC secret even if one already exists. Default false (keeps the existing secret).' },
      },
      required: ['project_id', 'url'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    group: 'auth',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const params = new URLSearchParams();
        params.set('project_id', args.project_id as string);
        const body: Record<string, unknown> = { url: args.url };
        if (args.rotate_secret === true) body.rotate_secret = true;
        result = await callAPI(fetcher, 'PUT', `/v1/auth/webhook?${params.toString()}`, authHeader, body);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'auth_webhook_delete',
    description: "Clear the project's auth webhook URL and HMAC secret. After this call, no auth lifecycle webhooks will fire for the project until it's reconfigured.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
      },
      required: ['project_id'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    group: 'auth',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const params = new URLSearchParams();
        params.set('project_id', args.project_id as string);
        result = await callAPI(fetcher, 'DELETE', `/v1/auth/webhook?${params.toString()}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'auth_logout',
    description: 'Revoke an end-user session AND/OR their refresh token. Pass at least one of session_token or refresh_token. Both are accepted in the same call — passing both is the safe default after a logout button click so a leaked refresh token can\'t outlive the session row.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        session_token: { type: 'string', description: 'Session token returned by auth_login/auth_signup' },
        refresh_token: { type: 'string', description: 'Refresh token returned by auth_login/auth_signup or auth_refresh' },
      },
      required: ['project_id'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    group: 'auth',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const body: Record<string, unknown> = { project_id: args.project_id };
        if (args.session_token !== undefined) body.session_token = args.session_token;
        if (args.refresh_token !== undefined) body.refresh_token = args.refresh_token;
        result = await callAPI(fetcher, 'POST', '/v1/auth/logout', authHeader, body);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'auth_request_reset',
    description: "Request a password-reset email for an end user. Always returns success even if the email isn't registered (prevents enumeration). Auth emails are platform email — sent from noreply@somewhere.tech with no per-project domain setup required.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        email: { type: 'string', description: "End user's email address" },
      },
      required: ['project_id', 'email'],
    },
  },
    annotations: { readOnlyHint: false, openWorldHint: true },
    group: 'auth',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', '/v1/auth/forgot', authHeader, {
          project_id: args.project_id,
          email: args.email,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'auth_reset_password',
    description: `Consume a password-reset token (from the email link) and set a new password. Token is single-use. After success, all existing sessions for the user are invalidated.

**Example:**

\`\`\`json
{ "project_id": "my-saas", "token": "rst_abc123", "new_password": "n3wS3cure!Pass" }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        token: { type: 'string', description: 'Reset token from the email link' },
        new_password: { type: 'string', description: 'New password (min 8 chars)' },
      },
      required: ['project_id', 'token', 'new_password'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    group: 'auth',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', '/v1/auth/reset', authHeader, {
          project_id: args.project_id,
          token: args.token,
          new_password: args.new_password,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'auth_request_email_verification',
    description: 'Send a 6-digit verification code to the logged-in end user. Pass the user\'s app token. Code expires in 15 minutes. Rate-limited to 1 send per minute per user.',
    inputSchema: {
      type: 'object',
      properties: {
        app_token: { type: 'string', description: 'App-user JWT for the logged-in user' },
      },
      required: ['app_token'],
    },
  },
    annotations: { readOnlyHint: false, openWorldHint: true },
    group: 'auth',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        // App-user JWT mode — pass developer key as Authorization plus
        // the user's JWT as X-App-Token. Same pattern as auth_me.
        const headers = new Headers({
          'Authorization': authHeader,
          'X-App-Token': args.app_token as string,
          'Content-Type': 'application/json',
        });
        const req = new Request('https://api-internal/v1/auth/request-email-verification', {
          method: 'POST', headers, body: '{}',
        });
        const resp = await fetcher.fetch(req);
        result = { status: resp.status, data: await resp.json() };
        return result;

      }
    },
  },
  {
    definition: {
    name: 'auth_verify_email',
    description: `Verify the 6-digit code that was emailed to the user. On success, \`email_verified\` is set to true. After 5 wrong attempts the code is wiped — request a new one.

**Example:**

\`\`\`json
{ "app_token": "eyJ...", "code": "482917" }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        app_token: { type: 'string', description: 'App-user JWT for the user being verified' },
        code: { type: 'string', description: 'The 6-digit code from the verification email' },
      },
      required: ['app_token', 'code'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    group: 'auth',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const headers = new Headers({
          'Authorization': authHeader,
          'X-App-Token': args.app_token as string,
          'Content-Type': 'application/json',
        });
        const req = new Request('https://api-internal/v1/auth/verify-email', {
          method: 'POST', headers, body: JSON.stringify({ code: args.code }),
        });
        const resp = await fetcher.fetch(req);
        result = { status: resp.status, data: await resp.json() };
        return result;

      }
    },
  },
  {
    definition: {
    name: 'auth_send_magic_link',
    description: `Email a one-shot sign-in link to a user (passwordless / OTP). Auto-creates the user if they don't exist yet — same call covers sign-in and sign-up.

The link expires in 15 minutes and can only be used once. Token verification goes through \`auth_verify_magic_link\` (or \`sw.auth.verifyOtp({ token })\` from a deployed function).

**Example:**

\`\`\`json
{ "project_id": "my-saas", "email": "alex@example.com", "redirect_uri": "https://my-saas.somewhere.site/auth/callback" }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        email: { type: 'string', description: 'Recipient email' },
        redirect_uri: { type: 'string', description: 'Optional — where the user should land after verify. Must be a verified hostname for the project.' },
      },
      required: ['project_id', 'email'],
    },
  },
    annotations: { readOnlyHint: false, openWorldHint: true },
    group: 'auth',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const body: Record<string, unknown> = {
          project_id: args.project_id,
          email: args.email,
        };
        if (args.redirect_uri !== undefined) body.redirect_uri = args.redirect_uri;
        result = await callAPI(fetcher, 'POST', '/v1/auth/magic-link', authHeader, body);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'auth_verify_magic_link',
    description: 'Exchange a magic-link token for a fresh (access_token, refresh_token, session_token) trio — same shape as `auth_login`. Single-use; replaying the same token returns AUTH_INVALID_CREDS.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        token: { type: 'string', description: 'The magic-link token captured from the URL query (?token=...)' },
      },
      required: ['project_id', 'token'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    group: 'auth',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', '/v1/auth/magic-link/verify', authHeader, {
          project_id: args.project_id,
          token: args.token,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'auth_mfa_enroll',
    description: `Start TOTP enrolment for the logged-in end user. Returns \`{ secret, otpauth_uri, issuer, account }\` — render \`otpauth_uri\` as a QR code so the user can scan it with Google Authenticator / Authy / 1Password.

The secret is stored on the user row immediately, but \`mfa_enabled\` stays 0 until the user confirms with \`auth_mfa_verify\`. That way a closed tab mid-enrol can't lock anyone out.

Returns 409 ALREADY_ENROLLED if the user already has MFA on — call \`auth_mfa_unenroll\` first.`,
    inputSchema: {
      type: 'object',
      properties: {
        app_token: { type: 'string', description: 'App-user JWT for the user enrolling' },
      },
      required: ['app_token'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    group: 'auth',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher } = runtime;
      let result: ToolUpstreamResult;
      {
        // MFA enroll is an end-user action — eitherAuth needs to see the
        // JWT in Authorization (not smt_). The JWT carries project_id.
        const headers = new Headers({
          'Authorization': 'Bearer ' + (args.app_token as string),
          'Content-Type': 'application/json',
        });
        const req = new Request('https://api-internal/v1/auth/mfa/enroll', {
          method: 'POST', headers, body: '{}',
        });
        const resp = await fetcher.fetch(req);
        result = { status: resp.status, data: await resp.json() };
        return result;

      }
    },
  },
  {
    definition: {
    name: 'auth_mfa_verify',
    description: `Confirm a pending TOTP enrolment by submitting the first 6-digit code from the authenticator app. On first success flips \`mfa_enabled\` to 1 and returns 8 single-use \`backup_codes\` — surface them once; they will not be returned again.

On a re-verify (user already had MFA on), \`backup_codes\` is null and existing codes are preserved.`,
    inputSchema: {
      type: 'object',
      properties: {
        app_token: { type: 'string', description: 'App-user JWT for the user verifying' },
        code: { type: 'string', description: '6-digit code from the authenticator app' },
      },
      required: ['app_token', 'code'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    group: 'auth',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher } = runtime;
      let result: ToolUpstreamResult;
      {
        const headers = new Headers({
          'Authorization': 'Bearer ' + (args.app_token as string),
          'Content-Type': 'application/json',
        });
        const req = new Request('https://api-internal/v1/auth/mfa/verify', {
          method: 'POST', headers, body: JSON.stringify({ code: args.code }),
        });
        const resp = await fetcher.fetch(req);
        result = { status: resp.status, data: await resp.json() };
        return result;

      }
    },
  },
  {
    definition: {
    name: 'auth_mfa_challenge',
    description: `Second factor exchange. Call this from your BFF after \`auth_login\` returned \`{ mfa_required: true, mfa_token }\`. \`code\` is either the user's current 6-digit TOTP or one of their 10-char backup codes (backup codes are consumed on use).

On success returns the same shape as \`auth_login\` — \`access_token\`, \`refresh_token\`, \`session_token\`, and the user object.`,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        mfa_token: { type: 'string', description: 'Short-lived MFA ticket returned by auth_login' },
        code: { type: 'string', description: 'Current 6-digit TOTP code or a 10-char backup code' },
      },
      required: ['project_id', 'mfa_token', 'code'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    group: 'auth',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        // Challenge runs from the developer's BFF after /login returned
        // mfa_required. smt_ key auth.
        result = await callAPI(fetcher, 'POST', '/v1/auth/mfa/challenge', authHeader, {
          project_id: args.project_id,
          mfa_token: args.mfa_token,
          code: args.code,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'auth_mfa_unenroll',
    description: 'Turn MFA off for the logged-in user. Requires a fresh 6-digit TOTP or backup code so a stolen JWT alone cannot disable MFA. Wipes the TOTP secret and all remaining backup codes.',
    inputSchema: {
      type: 'object',
      properties: {
        app_token: { type: 'string', description: 'App-user JWT for the user disabling MFA' },
        code: { type: 'string', description: 'Current 6-digit TOTP code or a 10-char backup code' },
      },
      required: ['app_token', 'code'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    group: 'auth',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher } = runtime;
      let result: ToolUpstreamResult;
      {
        const headers = new Headers({
          'Authorization': 'Bearer ' + (args.app_token as string),
          'Content-Type': 'application/json',
        });
        const req = new Request('https://api-internal/v1/auth/mfa/unenroll', {
          method: 'POST', headers, body: JSON.stringify({ code: args.code }),
        });
        const resp = await fetcher.fetch(req);
        result = { status: resp.status, data: await resp.json() };
        return result;

      }
    },
  },
  {
    definition: {
    name: 'auth_refresh',
    description: `Exchange a refresh token for a fresh (access_token, refresh_token) pair. Refresh tokens rotate — the old one is invalidated. Access tokens last 1 hour; refresh tokens last 30 days. Call this from your server, not browser code.

**Example:**

\`\`\`json
{ "project_id": "my-saas", "refresh_token": "rt_abc123" }
// Returns: { "token": "eyJ...new", "refresh_token": "rt_def456" }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        refresh_token: { type: 'string', description: 'Refresh token from auth_login or a previous auth_refresh' },
      },
      required: ['project_id', 'refresh_token'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    group: 'auth',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', '/v1/auth/refresh', authHeader, {
          project_id: args.project_id,
          refresh_token: args.refresh_token,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'auth_cli_pair',
    description: `Mint a short-lived \`smt_\` API key for ephemeral environments (Claude Code Web, sandboxes, containers). The agent writes the returned token to \`~/.somewhere/credentials\` (or runs \`somewhere auth set <token>\`) and the CLI works for the rest of the session — without sending the user through a browser-based login.

Returns: \`{ id, key: "smt_...", prefix, name, kind: "cli_pair", expires_at, ttl_seconds }\`. Key auto-expires in 24h; call this again on the next session.

Use when you have a shell but no CLI credentials. After pairing, use first-class CLI commands for routine work and \`somewhere call <tool> '<json>'\` for the complete platform tool catalog. If no shell exists, stay on MCP.

Security note: scoped to the same user as the caller. Auditable as kind='cli_pair' separately from your main developer key, so a stolen ephemeral token is revocable on its own.

**Example flow (run once per session):**

\`\`\`text
1. Call auth_cli_pair() → { key: "smt_...", expires_at: "..." }
2. Run: somewhere auth set <key>
3. Run: somewhere whoami     // confirms identity
4. somewhere deploy           // fast file-system deploy
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        label: {
          type: 'string',
          description: 'Optional short label that ends up in the key name for audit trail (e.g. "claude-code-web", "codespace-1234"). Defaults to "ephemeral". Max 40 chars; non-alphanumeric stripped.',
        },
      },
      required: [],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    group: 'auth',
    core: true,
    coreRank: 95,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const body: Record<string, unknown> = {};
        if (typeof args.label === 'string') body.label = args.label;
        result = await callAPI(fetcher, 'POST', '/v1/keys/cli-pair', authHeader, body);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'auth_update_password',
    description: 'Change the password for the logged-in end user. Requires the current password unless the user has no password set yet (e.g. signed up via Google). After success, all sessions and refresh tokens for the user are wiped — the user must log in again everywhere.',
    inputSchema: {
      type: 'object',
      properties: {
        app_token: { type: 'string', description: 'App-user JWT for the user changing their password' },
        current_password: { type: 'string', description: 'Current password (required unless the user has no password yet)' },
        new_password: { type: 'string', description: 'New password (min 8 chars)' },
      },
      required: ['app_token', 'new_password'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    group: 'auth',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const headers = new Headers({
          'Authorization': authHeader,
          'X-App-Token': args.app_token as string,
          'Content-Type': 'application/json',
        });
        const body: Record<string, unknown> = { new_password: args.new_password };
        if (args.current_password !== undefined) body.current_password = args.current_password;
        const req = new Request('https://api-internal/v1/auth/update-password', {
          method: 'POST', headers, body: JSON.stringify(body),
        });
        const resp = await fetcher.fetch(req);
        result = { status: resp.status, data: await resp.json() };
        return result;

      }
    },
  },
  {
    definition: {
    name: 'auth_delete_account',
    description: "Delete the logged-in end user's account. Wipes their app_users row plus sessions, refresh tokens, password reset rows, and pending email verifications. Project-level data your app stored about them is NOT touched — your backend handles that before calling this.",
    inputSchema: {
      type: 'object',
      properties: {
        app_token: { type: 'string', description: 'App-user JWT for the user being deleted' },
      },
      required: ['app_token'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    group: 'auth',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const headers = new Headers({
          'Authorization': authHeader,
          'X-App-Token': args.app_token as string,
        });
        const req = new Request('https://api-internal/v1/auth/users/me', {
          method: 'DELETE', headers,
        });
        const resp = await fetcher.fetch(req);
        result = { status: resp.status, data: await resp.json() };
        return result;

      }
    },
  },
  {
    definition: {
    name: 'auth_templates_list',
    description: 'List the three platform-issued email templates for a project: `password_reset`, `email_verification`, and `welcome`. Returns the live subject + HTML, whether it\'s a custom override or the default, and the default values inline.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
      },
      required: ['project_id'],
    },
  },
    annotations: { readOnlyHint: true, idempotentHint: true },
    group: 'auth',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(
          fetcher, 'GET',
          `/v1/auth/templates?project_id=${encodeURIComponent(args.project_id as string)}`,
          authHeader,
        );
        return result;

      }
    },
  },
  {
    definition: {
    name: 'auth_template_set',
    description: `Save a custom email template for a project. Overrides the default for that template_key.

Available variables: \`{{project_name}}\`, \`{{reset_link}}\` (password_reset), \`{{verify_code}}\` (email_verification), \`{{user_email}}\` (welcome).

**Example:**

\`\`\`json
{
  "project_id": "my-saas",
  "template_key": "password_reset",
  "subject": "Reset your {{project_name}} password",
  "html": "<p>Click <a href='{{reset_link}}'>here</a> to reset your password.</p>"
}
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        template_key: { type: 'string', description: 'Which template to override. One of: password_reset, email_verification, welcome.' },
        subject: { type: 'string', description: 'Email subject line (max 200 chars)' },
        html: { type: 'string', description: 'Email body as HTML (max 64 KB)' },
      },
      required: ['project_id', 'template_key', 'subject', 'html'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    group: 'auth',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const key = encodeURIComponent(args.template_key as string);
        result = await callAPI(fetcher, 'PUT', `/v1/auth/templates/${key}`, authHeader, {
          project_id: args.project_id,
          subject: args.subject,
          html: args.html,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'auth_template_reset',
    description: 'Remove a custom email template, falling back to the platform default for that key.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        template_key: { type: 'string', description: 'Which template to revert. One of: password_reset, email_verification, welcome.' },
      },
      required: ['project_id', 'template_key'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    group: 'auth',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const key = encodeURIComponent(args.template_key as string);
        result = await callAPI(
          fetcher, 'DELETE',
          `/v1/auth/templates/${key}?project_id=${encodeURIComponent(args.project_id as string)}`,
          authHeader,
        );
        return result;

      }
    },
  },
  // ── fs ─────────────────────────────────────────────
  {
    definition: {
    name: 'fs_write',
    description: `**fs_write = text and small inline content. fs_upload = real files.** Write UTF-8 text or other small content already present in the tool call to project file storage. Parent directories are auto-created. Overwrites create a new version automatically (history keeps the last 3 versions on Free, 10 on Builder).

For images, PDFs, video, zip files, fonts, large artifacts, and task attachments, use \`fs_upload\` so binary bytes never enter model context. Base64 input remains accepted here only for backward compatibility with existing callers; do not choose it for new binary uploads.

Use this for notes, JSON, CSV, generated source text, and small cached text that is not project code (project code goes through project_deploy).

There are two file surfaces: deployed source is read with \`project_files_list\` / \`project_file_read\`; \`fs_write\` and \`fs_read\` are runtime storage for uploads and generated files via \`sw.fs\`. If you want \`src/App.tsx\` or \`api/foo.ts\`, use \`project_file_read\`, not \`fs_read\`.

**Files are PRIVATE by default.** To serve a file at a public URL (e.g. an image you embed in your app), pass \`public: true\` — then call \`fs_public_url\` to get the URL. Without it the file is only reachable through your authenticated code.

**Example (text):**

\`\`\`json
{ "project_id": "my-saas", "path": "/notes/run.txt", "content_type": "text/plain", "content": "upload completed" }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        path: { type: 'string', description: 'Full path with leading slash, e.g. "/images/avatar.png"' },
        content: { type: 'string', description: 'File content — UTF-8 text or base64 bytes (set content_type to match).' },
        content_type: { type: 'string', description: 'MIME type, e.g. "image/png", "application/pdf". Defaults to application/octet-stream.' },
        public: { type: 'boolean', description: 'Serve this file at a public /storage URL (no auth). Default false — files are private. Set true for images/assets you embed in your app.' },
      },
      required: ['project_id', 'path', 'content'],
    },
  },
    annotations: { title: 'Write a file', readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    group: 'fs',
    core: true,
    coreRank: 31,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","chatgpt","connector"],
    protocol: { surfaceDescriptions: { connector: "Write content to a project file path. Existing content at that path is replaced. See https://somewhere.tech/docs.txt for the Somewhere file API contract (paths, visibility, signed and public URLs)." }, surfaceAnnotations: { chatgpt: { destructiveHint: true }, connector: {"title":"Fs Write","readOnlyHint":false,"destructiveHint":true} },  oauthScopes: ['mcp'] },
    execute: async (runtime, args) => {
      const { fetcher, env, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const projectId = encodeURIComponent(args.project_id as string);
        const path = (args.path as string).startsWith('/')
          ? (args.path as string).slice(1)
          : (args.path as string);
        const contentType = (args.content_type as string) || 'application/octet-stream';
        // Files default private (worker reads X-Visibility). public:true opts a
        // single write into public /storage serving in one call — restores the
        // one-call public-upload path after the default flipped to private.
        const writeHeaders: Record<string, string> = { 'Authorization': authHeader, 'Content-Type': contentType };
        if (args.public === true) writeHeaders['X-Visibility'] = 'public';
        const resp = await fetcher.fetch(`https://api-internal/v1/fs/${projectId}/${path}`, {
          method: 'PUT',
          headers: writeHeaders,
          body: args.content as string,
        });
        // FAIL LOUDLY (tsk_55b39e3b, Principle #7): tie success to the
        // REAL result, never to "the call completed." A non-JSON or
        // non-2xx response means the file did NOT save (e.g. an edge
        // block before the write, an auth/policy denial, a 5xx) — we used
        // to return {status, data} regardless, so the caller saw a 403 as
        // "ok" and lost their file silently. Now: surface it as an error.
        const ct = resp.headers.get('Content-Type') || '';
        const data = ct.includes('application/json')
          ? await resp.json().catch(() => null)
          : await resp.text().catch(() => '');
        if (resp.status < 200 || resp.status >= 300) {
          const detail = typeof data === 'string' ? data.slice(0, 300) : data;
          return {
            content: [{ type: 'text', text: JSON.stringify({
              ok: false,
              error: 'FS_WRITE_FAILED',
              status: resp.status,
              message: `fs_write FAILED (HTTP ${resp.status}) — the file was NOT saved.` +
                (resp.status === 403
                  ? ' A large or pattern-flagged body can be blocked at the edge before reaching storage; retry with smaller content, or use fs_replace for edits to an existing file.'
                  : ''),
              detail,
            }, null, 2) }],
            isError: true,
          };
        }
        // Confirm the bytes actually landed — a non-empty content that
        // persisted 0 bytes is a silent loss, not a success.
        const env = (data && typeof data === 'object') ? data as Record<string, unknown> : {};
        const inner = (env.data && typeof env.data === 'object') ? env.data as Record<string, unknown> : env;
        const savedBytes = typeof inner.size_bytes === 'number' ? inner.size_bytes : null;
        const intendedBytes = typeof args.content === 'string'
          ? new TextEncoder().encode(args.content).length : 0;
        if (intendedBytes > 0 && savedBytes === 0) {
          return {
            content: [{ type: 'text', text: JSON.stringify({
              ok: false,
              error: 'FS_WRITE_EMPTY',
              message: `fs_write reported success but persisted 0 bytes for ${intendedBytes} bytes of content — the write did NOT land. File NOT saved.`,
            }, null, 2) }],
            isError: true,
          };
        }
        result = { status: resp.status, data };
        return result;

      }
    },
  },
  {
    definition: {
    name: 'fs_upload',
    description: `**fs_upload = files. fs_write = text and small inline content.** Upload an image, PDF, video, zip, font, large artifact, or attachment without putting binary bytes or base64 in model context.

**Client capability matrix:**
- **ChatGPT:** \`file\` is a native connector file parameter. ChatGPT supplies a temporary authorized file reference and this tool streams it through the existing upload relay.
- **CLI/IDE agents and scripts with raw HTTP access:** omit \`file\` to mint a one-time \`upload_url\`, then PUT the raw file bytes to that URL with the returned Content-Type. This is two transport steps but still sends no base64 through model context.
- **Shell-less non-ChatGPT MCP connectors:** standard MCP tool arguments have no protocol-level file input, and the host may not be able to execute the raw PUT. Such a client cannot upload through this tool unless its host supplies compatible file references or raw HTTP access.

The connector reference and upload URL are temporary transports, not the durable artifact. After storage, every client uses the same saved bytes by \`path\`; use \`fs_signed_url\` for a private human download or \`public:true\` + \`fs_public_url\` for a permanent public URL. The PUT response and native call both return \`{ path, size_bytes, content_type, version }\`.

\`file\` must be a connector-provided file reference. A local path string, URL string, base64 string, or text value is rejected rather than being mistaken for bytes. \`content_type\` overrides connector metadata; otherwise MIME is inferred from connector metadata and the filename/path. Files are private unless \`public:true\` is supplied.

**Native connector call:**

\`\`\`json
{ "project_id": "my-saas", "path": "/uploads/alice/avatar.png", "file": "<attached connector file>", "public": true }
\`\`\`

**Raw-PUT fallback:**

\`\`\`json
{ "project_id": "my-saas", "path": "/uploads/archive.zip", "content_type": "application/zip" }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        path: { type: 'string', description: 'Destination storage path with leading slash, e.g. "/uploads/avatar.png".' },
        file: {
          type: 'object',
          description: 'Native connector file. ChatGPT supplies {download_url, file_id, mime_type?, file_name?}. Never pass a path string, base64, or inline bytes. Omit only to request the raw-PUT upload_url fallback.',
          properties: {
            download_url: { type: 'string', description: 'Temporary connector-authorized download URL.' },
            file_id: { type: 'string', description: 'Connector file identifier.' },
            mime_type: { type: 'string', description: 'Connector-provided MIME type, when available.' },
            file_name: { type: 'string', description: 'Original filename, when available.' },
          },
          required: ['download_url', 'file_id'],
        },
        content_type: { type: 'string', description: 'Optional MIME override, e.g. "image/png". Otherwise inferred from connector metadata and filename/path.' },
        public: { type: 'boolean', description: 'Serve this file at a public /storage URL. Default false (private).' },
      },
      required: ['project_id', 'path'],
    },
    _meta: { 'openai/fileParams': ['file'] },
  },
    annotations: { title: 'Upload a file', readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    group: 'fs',
    core: true,
    coreRank: 32,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","chatgpt","connector"],
    protocol: { surfaceDescriptions: { connector: "Upload a file from a supplied URL into project files. See https://somewhere.tech/docs.txt for the Somewhere file API contract (paths, visibility, signed and public URLs)." }, surfaceAnnotations: { chatgpt: { destructiveHint: true, openWorldHint: true }, connector: {"title":"Fs Upload","readOnlyHint":false,"destructiveHint":true} },  oauthScopes: ['mcp'] },
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        try {
          const destinationPath = typeof args.path === 'string' ? args.path : '';
          const file = args.file === undefined
            ? undefined
            : parseConnectorFileReference(args.file);
          const contentType = resolveUploadContentType(
            typeof args.content_type === 'string' ? args.content_type : undefined,
            file,
            destinationPath,
          );

          // Mint first: the worker resolves the project and enforces the same
          // owner/collaborator scope as fs_write before this MCP worker makes
          // any outbound request for connector-controlled bytes.
          const mint = await mintUploadRelay(
            fetcher,
            authHeader,
            args.project_id,
            args.path,
            contentType,
            args.public === true,
          );

          if (!file) {
            result = {
              status: 200,
              data: {
                ok: true,
                data: {
                  upload_url: mint.url,
                  path: mint.path,
                  expires_at: mint.expires_at,
                  max_size: mint.max_size,
                  content_type: mint.content_type,
                  public: mint.public === true,
                  method: 'PUT',
                  headers: { 'Content-Type': mint.content_type },
                  next: 'PUT the raw file bytes to upload_url. The PUT response is the storage record.',
                },
              },
            };
            return result;
          }

          const record = await streamConnectorFileToUpload(
            fetcher,
            mint.url,
            file,
            contentType,
            undefined,
            mint.max_size,
          );
          result = { status: 200, data: { ok: true, data: record } };
        } catch (error) {
          if (error instanceof FileUploadError) return fileUploadToolError(error);
          throw error;
        }
        return result;

      }
    },
  },
  {
    definition: {
    name: 'fs_read',
    description: `Get file, download file, fetch file contents, view file, cat, ls — read a file or list a directory from the project filesystem. If the path ends with \`/\` or matches a directory, returns a directory listing; otherwise returns the file content.

There are two file surfaces: deployed source is read with \`project_files_list\` / \`project_file_read\`; \`fs_read\`, \`fs_write\`, and \`fs_upload\` use runtime storage via \`sw.fs\`. If you want \`src/App.tsx\` or \`api/foo.ts\`, use \`project_file_read\`, not \`fs_read\`.

Optional \`lines\` returns only a line range from a text file as JSON with \`{ content, lines: [start, end], total_lines }\` — useful for peeking into large files without downloading them whole.

For a directory listing, set \`recursive: true\` to return every descendant in one call, with an optional \`depth\` cap.

**Example:**

\`\`\`json
// Read a whole file:
{ "project_id": "my-saas", "path": "/uploads/users/alice/avatar.png" }

// Read lines 50–75 of a stored text file:
{ "project_id": "my-saas", "path": "/logs/import-run.txt", "lines": "50-75" }

// List a directory (immediate children):
{ "project_id": "my-saas", "path": "/uploads/users/" }

// List a directory tree, two levels deep:
{ "project_id": "my-saas", "path": "/uploads/", "recursive": true, "depth": 2 }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        path: { type: 'string', description: 'Full path with leading slash. A trailing slash (or a directory path) returns a listing.' },
        lines: { type: 'string', description: 'Optional line range as "START-END" (1-indexed, inclusive). Text files only.' },
        recursive: { type: 'boolean', description: 'Optional. For a directory listing, include every descendant (not just immediate children).' },
        depth: { type: 'number', description: 'Optional. When recursive, cap how many levels below the directory to include.' },
      },
      required: ['project_id', 'path'],
    },
  },
    annotations: { title: 'Read a file or list a directory', readOnlyHint: true, idempotentHint: true },
    group: 'fs',
    core: true,
    coreRank: 30,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","chatgpt","connector"],
    protocol: { surfaceDescriptions: { connector: "Read a project file’s content. See https://somewhere.tech/docs.txt for the Somewhere file API contract (paths, visibility, signed and public URLs)." }, surfaceAnnotations: { connector: {"title":"Fs Read","readOnlyHint":true} },  oauthScopes: ['mcp'] },
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const projectId = encodeURIComponent(args.project_id as string);
        let path = (args.path as string).startsWith('/')
          ? (args.path as string).slice(1)
          : (args.path as string);
        const params = new URLSearchParams();
        if (typeof args.lines === 'string' && args.lines) params.set('lines', args.lines as string);
        // Directory-listing params (mirror the former fs_list): force a
        // trailing slash so the worker treats the path as a directory.
        if (args.recursive || typeof args.depth === 'number') {
          if (path && !path.endsWith('/')) path = path + '/';
          if (args.recursive) params.set('recursive', '1');
          if (typeof args.depth === 'number') params.set('depth', String(args.depth));
        }
        const qs = params.toString() ? `?${params.toString()}` : '';
        const resp = await fetcher.fetch(`https://api-internal/v1/fs/${projectId}/${path}${qs}`, {
          method: 'GET',
          headers: { 'Authorization': authHeader },
        });
        const ct = resp.headers.get('Content-Type') || '';
        if (ct.includes('application/json')) {
          const data = await resp.json();
          result = { status: resp.status, data };
        } else {
          const text = await resp.text();
          // Wrap the full-file read in the standard { ok, data } envelope so the
          // agent reads payload.data.content like every other tool (and like the
          // lines/dir JSON branch above). Previously this bare shape made the
          // full-file read inconsistent with the rest (pfb_6c90fad9).
          result = { status: resp.status, data: { ok: true, data: { content: text.slice(0, 50000), truncated: text.length > 50000 } } };
        }
        return result;

      }
    },
  },
  {
    definition: {
    name: 'fs_diff',
    description: `Unified diff between the current contents of a file and one of its archived versions. The diff string includes standard \`---\` / \`+++\` file headers and \`@@\` hunk headers. Defaults to the most recent previous version ("what changed since the last write").

Text files only. Capped at 2000 lines per side.

**Example:**

\`\`\`json
// Diff vs previous version:
{ "project_id": "my-saas", "path": "/src/index.ts" }

// Diff vs a specific archived version:
{ "project_id": "my-saas", "path": "/src/index.ts", "version": 4 }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        path: { type: 'string', description: 'Full path to the file with leading slash.' },
        version: { type: 'number', description: 'Archived version number to diff against. Omit for the most recent previous version.' },
      },
      required: ['project_id', 'path'],
    },
  },
    annotations: { readOnlyHint: true, idempotentHint: true },
    group: 'fs',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const body: Record<string, unknown> = { path: args.path };
        if (typeof args.version === 'number') body.version = args.version;
        result = await callAPI(fetcher, 'POST', `/v1/fs/${encodeURIComponent(args.project_id as string)}/diff`, authHeader, body);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'fs_glob',
    description: `Match file paths against a glob pattern. Fast metadata query — no file contents are read, no scan.

Supported syntax: \`*\` (not across /), \`**\` (across /), \`?\` (one char), \`{a,b,c}\` (brace expansion).

**Example:**

\`\`\`json
// All TypeScript files under src/api:
{ "project_id": "my-saas", "pattern": "/src/api/**/*.ts" }

// JS or TS top-level files:
{ "project_id": "my-saas", "pattern": "/*.{js,ts}" }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        pattern: { type: 'string', description: 'Glob pattern. Leading slash is added if missing.' },
        limit: { type: 'number', description: 'Max matches to return (default 500, cap 5000).' },
      },
      required: ['project_id', 'pattern'],
    },
  },
    annotations: { readOnlyHint: true, idempotentHint: true },
    group: 'fs',
    core: true,
    coreRank: 64,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const body: Record<string, unknown> = { pattern: args.pattern };
        if (typeof args.limit === 'number') body.limit = args.limit;
        result = await callAPI(fetcher, 'POST', `/v1/fs/${encodeURIComponent(args.project_id as string)}/glob`, authHeader, body);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'fs_delete',
    description: 'Delete a file or directory. Directory deletes are recursive — all children are removed. Archived versions are also cleaned up.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        path: { type: 'string', description: 'Full path with leading slash' },
      },
      required: ['project_id', 'path'],
    },
  },
    annotations: { title: 'Delete a file', readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    group: 'fs',
    core: true,
    coreRank: 83,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const projectId = encodeURIComponent(args.project_id as string);
        const path = (args.path as string).startsWith('/')
          ? (args.path as string).slice(1)
          : (args.path as string);
        const resp = await fetcher.fetch(`https://api-internal/v1/fs/${projectId}/${path}`, {
          method: 'DELETE',
          headers: { 'Authorization': authHeader },
        });
        const data = await resp.json();
        result = { status: resp.status, data };
        return result;

      }
    },
  },
  {
    definition: {
    name: 'fs_move',
    description: `Move or rename a file or directory. Instant regardless of file size. Pass \`overwrite: true\` to atomically replace the destination if it already exists — use this instead of a separate \`fs_delete\` + \`fs_move\` pair, which can race and leave the file in an inconsistent state.

**Example:**

\`\`\`json
{ "project_id": "my-saas", "from": "/uploads/temp/photo.jpg", "to": "/uploads/users/alice/photo.jpg", "overwrite": true }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        from: { type: 'string', description: 'Source path with leading slash' },
        to: { type: 'string', description: 'Destination path with leading slash' },
        overwrite: { type: 'boolean', description: 'If true and destination exists, atomically replace it (file destinations only). Default false: returns VALIDATION_ERROR when destination exists.' },
      },
      required: ['project_id', 'from', 'to'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    group: 'fs',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const moveBody: Record<string, unknown> = { from: args.from, to: args.to };
        if (args.overwrite === true) moveBody.overwrite = true;
        result = await callAPI(fetcher, 'POST', `/v1/fs/${encodeURIComponent(args.project_id as string)}/move`, authHeader, moveBody);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'fs_copy',
    description: 'Copy a file to a new path. The copy is independent of the original.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        from: { type: 'string', description: 'Source path with leading slash' },
        to: { type: 'string', description: 'Destination path with leading slash' },
      },
      required: ['project_id', 'from', 'to'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    group: 'fs',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', `/v1/fs/${encodeURIComponent(args.project_id as string)}/copy`, authHeader, {
          from: args.from,
          to: args.to,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'fs_stat',
    description: 'Get metadata for a file or directory without downloading the contents. Returns path, name, type, size_bytes, content_type, visibility, version, created_at, and updated_at.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        path: { type: 'string', description: 'Full path with leading slash' },
      },
      required: ['project_id', 'path'],
    },
  },
    annotations: { readOnlyHint: true, idempotentHint: true },
    group: 'fs',
    core: true,
    coreRank: 84,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const projectId = encodeURIComponent(args.project_id as string);
        const path = (args.path as string).startsWith('/')
          ? (args.path as string).slice(1)
          : (args.path as string);
        result = await callAPI(fetcher, 'GET', `/v1/fs/${projectId}/stat/${path}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'fs_public_url',
    description: `Get a public URL for a file written via fs_write. The URL is hosted on the project's subdomain at \`/storage/{path}\` and can be embedded directly as an image src, anchor href, etc. — no signing or auth.

Files are PRIVATE by default. Asking for a public URL does NOT silently expose a private file: a private file returns an error unless you pass \`make_public: true\` to publish it. An already-public file just returns its URL. For a time-limited link to a private file WITHOUT making it world-readable, use \`fs_signed_url\`.

**Example:**

\`\`\`json
{ "project_id": "my-saas", "path": "/uploads/users/alice/avatar.png", "make_public": true }
// Returns: { "public_url": "https://my-saas.somewhere.site/storage/uploads/users/alice/avatar.png", ... }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        path: { type: 'string', description: 'Full path with leading slash' },
        make_public: { type: 'boolean', description: 'Publish a private file so the URL is world-readable. Required to expose a private file; an already-public file ignores it. Omit to keep the file private (a private file then returns an error instead of being silently exposed).' },
      },
      required: ['project_id', 'path'],
    },
  },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    group: 'fs',
    core: true,
    coreRank: 33,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","chatgpt","connector"],
    protocol: { surfaceDescriptions: { connector: "Make a project file public and return its public URL. See https://somewhere.tech/docs.txt for the Somewhere file API contract (paths, visibility, signed and public URLs)." }, surfaceAnnotations: { connector: {"title":"Fs Public Url","readOnlyHint":false,"destructiveHint":true} },  oauthScopes: ['mcp'] },
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const projectId = encodeURIComponent(args.project_id as string);
        const params = new URLSearchParams({ path: args.path as string });
        if (args.make_public === true) params.set('make_public', '1');
        result = await callAPI(fetcher, 'GET', `/v1/fs/${projectId}/public-url?${params}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'fs_versions',
    description: `List previous versions of a file. Returns \`{ path, current_version, versions }\`; each item in \`versions\` has \`version\`, \`size_bytes\`, \`content_type\`, and \`created_at\`.

**Example:**

\`\`\`json
{ "project_id": "my-saas", "path": "/uploads/config.json" }
// Returns: { "path": "/uploads/config.json", "current_version": 3, "versions": [{ "version": 2, "size_bytes": 1024, "content_type": "application/json", "created_at": "2026-04-18T..." }] }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        path: { type: 'string', description: 'Full path with leading slash' },
      },
      required: ['project_id', 'path'],
    },
  },
    annotations: { readOnlyHint: true, idempotentHint: true },
    group: 'fs',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const projectId = encodeURIComponent(args.project_id as string);
        const path = (args.path as string).startsWith('/')
          ? (args.path as string).slice(1)
          : (args.path as string);
        result = await callAPI(fetcher, 'GET', `/v1/fs/${projectId}/versions/${path}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'fs_restore',
    description: `Restore a previous version of a file. The current state is first archived as a new version (so the restore is non-destructive), then the chosen version becomes the current contents.

**Example:**

\`\`\`json
{ "project_id": "my-saas", "path": "/uploads/config.json", "version": 2 }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        path: { type: 'string', description: 'Full path with leading slash' },
        version: { type: 'number', description: 'Version number to restore (from fs_versions)' },
      },
      required: ['project_id', 'path', 'version'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    group: 'fs',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', `/v1/fs/${encodeURIComponent(args.project_id as string)}/restore`, authHeader, {
          path: args.path,
          version: args.version,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'fs_search',
    description: `Search for text across files in the project filesystem. Literal substring match (case-sensitive), returns matching file paths with line numbers and one line of context above and below each hit.

Only searches text files (source code, JSON, markdown, HTML, CSS, etc.) — skips binaries. Caps at 1 MB per file, 500 files scanned by default.

**Example:**

\`\`\`json
// Find every place we import the auth helper:
{ "project_id": "my-saas", "path": "/", "query": "from './auth'" }

// Scoped to a subtree:
{ "project_id": "my-saas", "path": "/src/api/", "query": "TODO" }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        path: { type: 'string', description: 'Directory to search under (defaults to "/"). Trailing slash optional.' },
        query: { type: 'string', description: 'Literal substring to search for. Case-sensitive.' },
        limit: { type: 'number', description: 'Max matches to return (default 50, cap 500).' },
        max_files: { type: 'number', description: 'Max files to scan (default 500, cap 2000).' },
      },
      required: ['project_id', 'query'],
    },
  },
    annotations: { title: 'Search files', readOnlyHint: true, idempotentHint: true },
    group: 'fs',
    core: true,
    coreRank: 85,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const body: Record<string, unknown> = { query: args.query };
        if (typeof args.path === 'string') body.path = args.path;
        if (typeof args.limit === 'number') body.limit = args.limit;
        if (typeof args.max_files === 'number') body.max_files = args.max_files;
        result = await callAPI(fetcher, 'POST', `/v1/fs/${encodeURIComponent(args.project_id as string)}/search`, authHeader, body);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'fs_replace',
    description: `Find-and-replace text in a single file, server-side. No read-modify-write cycle from the client. Archives the current contents as a new version before writing (same retention as fs_write), so fs_restore can roll back.

Literal string match (not regex). Only works on text files.

**Example:**

\`\`\`json
{ "project_id": "my-saas", "path": "/src/config.ts", "find": "API_URL = 'https://staging...'", "replace": "API_URL = 'https://api...'" }
// Returns: { "ok": true, "replacements": 1, "version": 4 }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        path: { type: 'string', description: 'Full path to the file with leading slash.' },
        find: { type: 'string', description: 'Exact string to find (non-empty).' },
        replace: { type: 'string', description: 'Replacement string (may be empty to delete matches).' },
      },
      required: ['project_id', 'path', 'find', 'replace'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    group: 'fs',
    core: true,
    coreRank: 82,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', `/v1/fs/${encodeURIComponent(args.project_id as string)}/replace`, authHeader, {
          path: args.path,
          find: args.find,
          replace: args.replace,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'fs_signed_url',
    description: `Mint a short-lived signed URL for a file. The URL is fetchable without an API key — the token IS the auth. Use for email attachments, image previews, "download once" handoffs to recipients who don't have a developer key.

\`expires_in\` is in seconds, min 60, max 604800 (7 days), default 3600 (1 hour). After expiry the URL returns 403.

**Example:**

\`\`\`json
{ "project_id": "my-saas", "path": "/uploads/invoice-2026.pdf", "expires_in": 86400 }
// Returns: { "url": "https://api.somewhere.tech/v1/fs-signed/eyJ...", "expires_at": "2026-05-13T..." }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        path: { type: 'string', description: 'Full path with leading slash.' },
        expires_in: { type: 'number', description: 'Seconds until URL expires. Min 60, max 604800. Default 3600.' },
      },
      required: ['project_id', 'path'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    group: 'fs',
    core: true,
    coreRank: 34,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","chatgpt","connector"],
    protocol: { surfaceDescriptions: { connector: "Create a temporary signed link granting access to a project file. See https://somewhere.tech/docs.txt for the Somewhere file API contract (paths, visibility, signed and public URLs)." }, surfaceAnnotations: { connector: {"title":"Fs Signed Url","readOnlyHint":false,"destructiveHint":true} },  oauthScopes: ['mcp'] },
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const body: Record<string, unknown> = { path: args.path };
        if (typeof args.expires_in === 'number') body.expires_in = args.expires_in;
        result = await callAPI(fetcher, 'POST', `/v1/fs/${encodeURIComponent(args.project_id as string)}/sign`, authHeader, body);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'fs_integrity_check',
    description: `Scan a project's files for orphan metadata — rows pointing at a file blob that no longer exists. Returns the list of orphans. Pass \`auto_clean: true\` to delete the orphan rows in the same call.

Use after suspected partial-failure incidents or as a periodic sweep. Returns counts and a sample of orphan paths.

**Example:**

\`\`\`json
{ "project_id": "my-saas" }
// Returns: { "scanned": 1240, "orphan_files": [], "orphan_versions": [],
//            "auto_clean": false, "cleaned": { "files": 0, "versions": 0 },
//            "next_cursor": null }

{ "project_id": "my-saas", "auto_clean": true }
// Returns: { "scanned": 1240, "orphan_files": [{ "id": "...", "path": "/x.bin", "storage_key": "..." }],
//            "orphan_versions": [], "auto_clean": true,
//            "cleaned": { "files": 1, "versions": 0 }, "next_cursor": null }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        auto_clean: { type: 'boolean', description: 'Delete orphan rows. Default false (dry-run).' },
        limit: { type: 'number', description: 'Max rows to scan per call. Default 1000, max 5000.' },
        cursor: { type: 'string', description: 'Pagination cursor from a previous call.' },
      },
      required: ['project_id'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    group: 'fs',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const body: Record<string, unknown> = {};
        if (args.auto_clean === true) body.auto_clean = true;
        if (typeof args.limit === 'number') body.limit = args.limit;
        if (typeof args.cursor === 'string') body.cursor = args.cursor;
        result = await callAPI(fetcher, 'POST', `/v1/fs/${encodeURIComponent(args.project_id as string)}/integrity-check`, authHeader, body);
        return result;

      }
    },
  },
  // ── env ─────────────────────────────────────────────
  {
    definition: {
    name: 'env',
    description: `Environment variables, secrets, env vars, config, API keys, .env, settings — get/set/delete project environment variables. Set: provide key + value. Delete: provide key + \`delete: true\`. List: provide only project_id. Values are encrypted at rest and never exposed in list responses.

⚠️ **A \`VITE_\`/\`REACT_APP_\` prefix makes the value PUBLIC.** Those names are compiled into the project's browser JavaScript as plain text, so every visitor can read them — that is what the prefix means to Vite/CRA. Pass \`public: true\` for values that are genuinely public (API base URL, Supabase URL or anon/publishable key, Stripe *publishable* key). NEVER give a real secret one of those names: \`VITE_STRIPE_SECRET\` is a published secret. Keep secrets prefix-free and read them as \`sw.env.KEY\` inside a function. \`public: true\` records that the exposure is intended — it does NOT withhold anything: a prefixed value is compiled into browser code whether or not it is marked, and leaving it unmarked only means you get warned about it at set time and on every deploy. Renaming without the prefix is the only thing that keeps a value out of the browser. List results include \`browser_exposed\` (the name publishes this value) and \`visibility\` (\`public\` once the owner confirmed that is intended).

⏱ **Takes effect on next \`project_deploy\`, not next request.** Env vars are baked into the function bundle at deploy time — and, for \`VITE_\`/\`REACT_APP_\` names, into the browser bundle. Running functions keep the old value until you redeploy.

**Example:**

\`\`\`json
// Set:
{ "project_id": "my-saas", "key": "STRIPE_SECRET_KEY", "value": "sk_live_..." }

// Delete:
{ "project_id": "my-saas", "key": "OLD_KEY", "delete": true }

// List:
{ "project_id": "my-saas" }
// Returns: { "project_id": "...", "keys": [{ "key": "STRIPE_SECRET_KEY", "scope": "all", "visibility": "server", "browser_exposed": false, "created_at": "2026-04-20T..." }, ...] }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        key: { type: 'string', description: 'Variable name, e.g. "STRIPE_SECRET_KEY"' },
        value: { type: 'string', description: 'Variable value (will be encrypted). Required when setting.' },
        scope: { type: 'string', enum: ['all', 'dev', 'prod'], description: "Optional scope. 'all' (default) applies to the live project and any explicitly enabled preview. 'prod' restricts the value to live. 'dev' is advanced and requires the optional Pro/Scale + enabled preview capability." },
        delete: { type: 'boolean', description: 'Set to true to delete the variable specified by key.' },
        public: { type: 'boolean', description: "Explicit consent for this value to be compiled into the project's PUBLIC browser JavaScript. Only meaningful for VITE_/REACT_APP_ names (those are the ones the compiler inlines). Default false = server-side only. Set true for values any visitor may read (API base URL, Supabase URL / anon or publishable key, Stripe publishable key). Never true for a real secret." },
      },
      required: ['project_id'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    group: 'env',
    core: true,
    coreRank: 51,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        if (args.key && args.delete) {
          // Delete env var
          const projectId = encodeURIComponent(args.project_id as string);
          const key = encodeURIComponent(args.key as string);
          result = await callAPI(fetcher, 'DELETE', `/v1/env/${projectId}/${key}`, authHeader);
        } else if (args.key && args.value !== undefined) {
          // Set env var (tsk_9cf9 — optional scope)
          result = await callAPI(fetcher, 'POST', '/v1/env', authHeader, {
            project_id: args.project_id,
            key: args.key,
            value: args.value,
            scope: args.scope,
            // Only forwarded when the caller said something about it — the
            // worker preserves an existing visibility when the field is absent,
            // so a plain value rotation cannot silently un-publish a value a
            // project depends on. (tsk_20b7f5f9)
            ...(args.public !== undefined ? { public: args.public } : {}),
          });
        } else {
          // List env vars
          result = await callAPI(fetcher, 'GET', `/v1/env?project_id=${encodeURIComponent(args.project_id as string)}`, authHeader);
        }
        return result;

      }
    },
  },
  // ── project ─────────────────────────────────────────────
  {
    definition: {
    name: 'dev_env_init',
    description: `**Advanced — \`somewhere preview\` only.** Initialize an isolated backend for this project. This requires a Pro or Scale plan plus explicit platform enablement; otherwise it returns \`CLOUD_DEV_NOT_ENABLED\` before creating resources. The fork runs asynchronously; poll with \`dev_env_status\` until \`dev_db_status: 'ready'\`. Per-table row cap is 50,000 for the fork — larger tables truncate (returned in \`truncatedTables\`).

\`\`\`json
// Init dev backend (one-time):
{ "project_id": "my-saas" }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, slug, or 'default'." },
      },
      required: ['project_id'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    group: 'project',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', '/v1/dev-env/init', authHeader, { project_id: args.project_id });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'dev_env_refresh',
    description: `**Advanced — \`somewhere preview\` only.** Re-fork production into the existing isolated preview database. Requires a Pro or Scale plan plus explicit platform enablement. Async — poll \`dev_env_status\`; the isolated environment must already exist.`,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project ID, subdomain, slug.' },
      },
      required: ['project_id'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    group: 'project',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', '/v1/dev-env/refresh', authHeader, { project_id: args.project_id });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'dev_env_status',
    description: `**Advanced — \`somewhere preview\` only.** Return isolated-environment status. Requires a Pro or Scale plan plus explicit platform enablement. Fields: \`has_dev_db\`, \`dev_db_status\`, \`dev_db_initialized_at\`, and \`dev_db_error\`.`,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project ID, subdomain, slug.' },
      },
      required: ['project_id'],
    },
  },
    annotations: { readOnlyHint: true, idempotentHint: true },
    group: 'project',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'GET', `/v1/dev-env/status?project_id=${encodeURIComponent(args.project_id as string)}`, authHeader);
        return result;

      }
    },
  },
  // ── email ─────────────────────────────────────────────
  {
    definition: {
    name: 'email_send',
    description: `**Adding a welcome, receipt, status, or alert email to an app?** \`email_send\` sends one transactional email to one recipient on every plan. Omit \`from\` to use the platform-managed sender immediately; the project name appears as the sender label. Pass \`from\` to use your own verified sender domain. Domains bought through us or connected with our nameservers are set up automatically; for a domain you host elsewhere, verify it once in Settings → Domains. A caller cannot explicitly name a platform domain.

The platform-managed sender is transactional-only. Add a verified sender domain for your own branding and marketing email. Outbound transactional email is available on Free, Builder, Pro, Scale, and Enterprise. The plan's email allowance and send rate limit apply either way; read current limits from /v1/pricing. Provide \`html\` or \`text\` (or both). \`reply_to\` is optional.

**Example:**

\`\`\`json
{
  "project_id": "my-saas",
  "to": "alice@example.com",
  "subject": "Your order shipped",
  "html": "<p>Tracking number: ABC123</p>"
}
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject line' },
        html: { type: 'string', description: 'HTML body. Optional if text is set.' },
        text: { type: 'string', description: 'Plaintext body. Optional if html is set.' },
        from: { type: 'string', description: 'Optional sender on a verified sender domain. Omit it to use the platform-managed transactional sender with the project name as its label.' },
        reply_to: { type: 'string', description: 'Optional reply-to address.' },
      },
      required: ['project_id', 'to', 'subject'],
    },
  },
    annotations: { title: 'Send an email', readOnlyHint: false, openWorldHint: true },
    group: 'email',
    core: true,
    coreRank: 54,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","connector"],
    protocol: { surfaceDescriptions: { connector: "Send an email from an authorized project to the supplied recipients." }, surfaceAnnotations: { connector: {"title":"Email Send","readOnlyHint":false,"destructiveHint":true} },  },
    execute: async (runtime, args) => {
      const { fetcher, env, authHeader, ctx, toolName } = runtime;
      let result: ToolUpstreamResult;
      {
        if (typeof args.to !== 'string' || !args.to.trim()) {
          return badArgsToolResult(
            env, authHeader, ctx, toolName, args,
            'email_send requires to as one email address string.\nExample:\nemail_send({ "project_id": "my-app", "to": "user@example.com", "from": "notifications@yourdomain.com", "subject": "Welcome", "text": "Hello" })\nFor multiple recipients, call email_send once per recipient.',
          );
        }
        if (typeof args.subject !== 'string' || !args.subject.trim()) {
          return badArgsToolResult(
            env, authHeader, ctx, toolName, args,
            'email_send requires subject.\nExample:\nemail_send({ "project_id": "my-app", "to": "user@example.com", "from": "notifications@yourdomain.com", "subject": "Welcome", "text": "Hello" })\nUse text or html for the body.',
          );
        }
        if (typeof args.html !== 'string' && typeof args.text !== 'string') {
          return badArgsToolResult(
            env, authHeader, ctx, toolName, args,
            'email_send requires html or text body.\nExample:\nemail_send({ "project_id": "my-app", "to": "user@example.com", "from": "notifications@yourdomain.com", "subject": "Welcome", "text": "Hello" })\nA single "body" string is also accepted and treated as text unless it starts with "<".',
          );
        }
        const emailBody: Record<string, unknown> = {
          project_id: args.project_id,
          to: args.to,
          subject: args.subject,
        };
        if (args.from) emailBody.from = args.from;
        if (args.reply_to) emailBody.reply_to = args.reply_to;
        if (args.html) emailBody.html = args.html;
        if (args.text) emailBody.text = args.text;
        result = await callAPI(fetcher, 'POST', '/v1/email/send', authHeader, emailBody);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'email_status',
    description: `Look up the safe delivery timeline for an email previously sent by a project or issued by the platform for that project's app auth. Pass the tracking_id (same as the id returned from email_send or an authorized project workflow). Returns origin, source, auth_purpose when recorded, every lifecycle event — sent, delivered, opened, clicked, bounced, complained — in order, and event_counts. Message bodies, auth codes, credential links, and provider payloads are not returned. Historical rows without trusted sent provenance report origin/source as unknown. An opened event may come from an image proxy or automated scanner; it does not prove a person read the email or signed in. Missing events mean unknown, and this tool does not imply that open tracking is active.

**Example:**

\`\`\`json
{ "id": "1234-abcd-..." }
// Returns: { "current_status": "delivered", "events": [{ "event_type": "sent", ... }, { "event_type": "delivered", ... }] }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Tracking id from email_send.' },
      },
      required: ['id'],
    },
  },
    annotations: { readOnlyHint: true, idempotentHint: true },
    group: 'email',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'GET', `/v1/email/status?id=${encodeURIComponent(args.id as string)}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'email_events_list',
    description: `List recent project mail and platform-issued app auth mail recorded for an authorized project. Each row includes origin, source, auth_purpose when recorded, latest delivery status (sent / delivered / opened / clicked / bounced / complained / delivery_delayed), and event_counts. Historical rows without trusted sent provenance report origin/source as unknown. Use the timeline for delivery diagnostics: an opened event may come from an image proxy or automated scanner and does not prove a human read the email or signed in; missing events mean unknown, and this tool does not imply that open tracking is active. For a specific message's safe timeline, follow up with email_status({ id: tracking_id }).`,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        limit: { type: 'number', description: 'Page size (default 50, max 200).' },
        offset: { type: 'number', description: 'Pagination offset (default 0).' },
      },
      required: ['project_id'],
    },
  },
    annotations: { readOnlyHint: true, idempotentHint: true },
    group: 'email',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const params = new URLSearchParams();
        params.set('project_id', String(args.project_id));
        if (args.limit !== undefined) params.set('limit', String(args.limit));
        if (args.offset !== undefined) params.set('offset', String(args.offset));
        result = await callAPI(fetcher, 'GET', `/v1/email/list?${params.toString()}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'email_bounces_list',
    description: `Deduplicated list of recipient addresses that have bounced or complained (spam-marked) in a project. Use this to scrub a mailing list before sending — "kept blasting a dead address" is the most common email bug we see. Returns one row per address with last_status, last_at, and occurrences. Window defaults to 30 days (max 365). Pair with your own send loop: skip any address that appears here.`,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        days: { type: 'number', description: 'Lookback window in days (default 30, max 365).' },
        limit: { type: 'number', description: 'Max addresses returned (default 200, max 1000).' },
      },
      required: ['project_id'],
    },
  },
    annotations: { readOnlyHint: true, idempotentHint: true },
    group: 'email',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const params = new URLSearchParams();
        params.set('project_id', String(args.project_id));
        if (args.days !== undefined) params.set('days', String(args.days));
        if (args.limit !== undefined) params.set('limit', String(args.limit));
        result = await callAPI(fetcher, 'GET', `/v1/email/bounces?${params.toString()}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'email_test_inbox',
    description: `Read rendered auth messages sent to one address in a project's controlled test inbox. Use an address shaped like \`robot@<project-subdomain>.test.somewhere.site\` when testing passwordless sign-in. These messages are stored instead of being delivered, and each row includes \`magic_link\` when the auth template supplied one. Real recipient mail never appears here.`,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project ID, subdomain, or slug.' },
        address: { type: 'string', description: 'Exact project-owned test address to read.' },
        limit: { type: 'number', description: 'Newest messages to return (default 20, max 100).' },
      },
      required: ['project_id', 'address'],
    },
  },
    annotations: { readOnlyHint: true, idempotentHint: true },
    group: 'email',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      const params = new URLSearchParams();
      params.set('project_id', String(args.project_id));
      params.set('address', String(args.address));
      if (args.limit !== undefined) params.set('limit', String(args.limit));
      return callAPI(fetcher, 'GET', `/v1/email/test-inbox?${params.toString()}`, authHeader);
    },
  },
  {
    definition: {
    name: 'managed_email_send',
    description: `Compose one managed email and send it to either an explicit recipient list or a saved contact segment. A segment is \`{ "tag": "..." }\` or \`{ "all": true }\`. Every recipient gets a distinct idempotency claim derived from \`idempotency_key\`, so retrying the same batch does not send duplicates. The result reports every recipient as sent, suppressed, preference-blocked, failed, or queued for a rate-limited later minute.

Marketing email requires \`topic\`; recipient preferences, suppression, and the unsubscribe footer are enforced by the managed email sender. Provide \`html\` or \`text\` (or both).`,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project ID, subdomain, slug, or default.' },
        recipients: { type: 'array', maxItems: 1000, items: { type: 'string' }, description: 'Explicit recipient email addresses. Use this or segment, not both.' },
        segment: {
          type: 'object',
          description: 'Saved contact audience: exactly one of tag or all: true.',
          properties: {
            tag: { type: 'string', description: 'Match contacts whose properties.tags array contains this tag.' },
            all: { type: 'boolean', description: 'Send to every managed contact when true.' },
          },
        },
        from: { type: 'string', description: 'Sender on a verified sender domain.' },
        subject: { type: 'string', description: 'Email subject line.' },
        html: { type: 'string', description: 'HTML body. Optional if text is set.' },
        text: { type: 'string', description: 'Plaintext body. Optional if html is set.' },
        category: { type: 'string', enum: ['transactional', 'marketing'], description: 'Defaults to transactional.' },
        topic: { type: 'string', enum: ['project-updates', 'milestones', 'announcements', 'founder-notes'], description: 'Required for marketing email.' },
        subtype: { type: 'string', description: 'Optional reporting subtype.' },
        template_key: { type: 'string', description: 'Optional reporting template key.' },
        idempotency_key: { type: 'string', description: 'Stable key for this composed batch. Reuse it only when retrying the identical send.' },
      },
      required: ['project_id', 'from', 'subject', 'idempotency_key'],
    },
  },
    annotations: { title: 'Send a managed email batch', readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    group: 'email',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', '/v1/email/managed-send/batch', authHeader, {
          project_id: args.project_id,
          ...(args.recipients !== undefined ? { recipients: args.recipients } : {}),
          ...(args.segment !== undefined ? { segment: args.segment } : {}),
          from: args.from,
          subject: args.subject,
          ...(args.html !== undefined ? { html: args.html } : {}),
          ...(args.text !== undefined ? { text: args.text } : {}),
          ...(args.category !== undefined ? { category: args.category } : {}),
          ...(args.topic !== undefined ? { topic: args.topic } : {}),
          ...(args.subtype !== undefined ? { subtype: args.subtype } : {}),
          ...(args.template_key !== undefined ? { template_key: args.template_key } : {}),
          idempotency_key: args.idempotency_key,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'managed_email_status',
    description: `Read the managed email ledger for a project. Returns recent message history and, when \`id\` is provided, that message's complete tracking event timeline. The id may be the internal message id or provider message id.`,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project ID, subdomain, slug, or default.' },
        id: { type: 'string', description: 'Optional internal or provider message id for its full event timeline.' },
        limit: { type: 'number', description: 'History page size (default 50, max 200).' },
        offset: { type: 'number', description: 'History pagination offset (default 0).' },
      },
      required: ['project_id'],
    },
  },
    annotations: { title: 'View managed email status', readOnlyHint: true, idempotentHint: true },
    group: 'email',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const params = new URLSearchParams();
        params.set('project_id', String(args.project_id));
        if (args.limit !== undefined) params.set('limit', String(args.limit));
        if (args.offset !== undefined) params.set('offset', String(args.offset));
        const history = await callAPI(fetcher, 'GET', `/v1/email/history?${params.toString()}`, authHeader);
        if (args.id === undefined) {
          result = history;
          return result;
        }
        const statusParams = new URLSearchParams({
          project_id: String(args.project_id),
          id: String(args.id),
        });
        const status = await callAPI(fetcher, 'GET', `/v1/email/managed-status?${statusParams.toString()}`, authHeader);
        result = {
          status: Math.max(history.status, status.status),
          data: { history: history.data, status: status.data },
        };
        return result;

      }
    },
  },
  // ── ai ─────────────────────────────────────────────
  {
    definition: {
    name: 'ai_complete',
    description: `LLM chat completion, prompt model, GPT, Claude, Gemini, chat with AI, generate text, completion, inference — call an AI model through the somewhere.tech proxy. Supports multiple providers and models through a single unified API. Returns the model's response and cost breakdown.

**Free models** (available to all users, no activation required):
- \`provider: "workers-ai"\` — Kimi K2.6, Kimi K2.5, Gemma 4 26B, Llama 3.3 70B, Qwen3 30B, GLM-4.7 Flash, Llama 4 Scout, Mistral Small 3.1. These are frontier-quality open models running on our infrastructure at no cost to you. Rate limits (per user): Free tier 10/min and 200/day; Builder tier 200/min and 10,000/day.

**Paid models** (activation required in dashboard settings; rates by plan at /v1/pricing):
- \`provider: "anthropic"\` — Claude Sonnet 4.6, Claude Opus 4.6, Claude Haiku 4.5
- \`provider: "openai"\` — GPT-5.5, GPT-5.4 mini, GPT-5.4
- \`provider: "xai"\` — Grok 4, Grok 4 Fast, Grok 3 Mini, Grok Code Fast 1

Cost breakdown is included in every response: \`api_cost\` (what the provider charges), \`platform_fee\` (the markup — tiered by plan; see /v1/pricing), \`total\`. Free models return \`$0.000000\` for all three.

**Example (free model):**

\`\`\`json
{
  "project_id": "my-saas",
  "provider": "workers-ai",
  "model": "@cf/meta/llama-4-scout-17b-16e-instruct",
  "messages": [{ "role": "user", "content": "Summarize this text: ..." }],
  "max_tokens": 1024
}
\`\`\`

**Example (paid model):**

\`\`\`json
{
  "project_id": "my-saas",
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "system": "You are a helpful assistant.",
  "messages": [{ "role": "user", "content": "Write a haiku about APIs" }],
  "max_tokens": 256
}
\`\`\`

**Tool use (Anthropic passthrough):**

Send Anthropic tool definitions via \`tools\`; the response \`content\` array comes back with Anthropic's native blocks (text + tool_use). For multi-turn, append the assistant message and a user message with tool_result blocks — message \`content\` can be a string OR the full Anthropic content-block array.

\`\`\`json
{
  "project_id": "my-saas",
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
  "messages": [{ "role": "user", "content": "Find files containing TODO." }],
  "tools": [
    { "name": "fs_search", "description": "Search files for a literal substring.",
      "input_schema": { "type": "object", "properties": { "query": { "type": "string" } }, "required": ["query"] } }
  ]
}
// Response: { "content": [{ "type": "text", "text": "I'll search..." }, { "type": "tool_use", "id": "...", "name": "fs_search", "input": { "query": "TODO" } }], "text": "I'll search...", "stop_reason": "tool_use", ... }
\`\`\`

**Conversation history (Anthropic only):**

Pass \`conversation_id\` to make the platform store and replay the chat. Prior turns are loaded from the project's database, prepended to your \`messages\`, and sent to the model. After the response returns, your new user message(s) and the assistant reply are saved under the same id. On the next call, send only the new user message — history is loaded server-side.

Trim the loaded history with two optional caps: \`history_max_messages\` (default 50) and \`history_max_tokens\` (default 32000, char/4 estimate). Oldest user/assistant messages are dropped first; the new user messages in this call and the \`system\` prompt are never dropped. The model's full 200K window still applies on top — the smaller cap wins. \`conversation_truncated: true\` comes back in the response when any drop happened.

Pass \`compaction: "summarize"\` to keep the dropped context instead of losing it. When messages overflow, they are folded into a rolling summary by Haiku and that summary is prepended to the system prompt on every subsequent call. One Haiku call per overflow event (billed normally, ~1¢). \`compaction: "truncate"\` (the default) is the cheaper option that just drops the oldest messages. The summarizer falls back to truncate on upstream error. \`conversation_summarized: true\` comes back when summarization actually ran.

Use any string up to 128 chars as the id; if it doesn't exist, the conversation is created. List, fetch, fork, and delete via \`ai_conversation_list\` (pass a conversation_id to fetch one) / \`ai_conversation_fork\` / \`ai_conversation_delete\`. Works on every provider (anthropic, openai, xai, workers-ai). Not supported with \`stream: true\` yet.

\`\`\`json
// First call: client picks the id (any uuid will do)
{ "project_id": "my-saas", "conversation_id": "c_abc123", "messages": [{ "role": "user", "content": "What's the capital of France?" }] }
// Second call: send only the new turn — server loads the prior turns
{ "project_id": "my-saas", "conversation_id": "c_abc123", "messages": [{ "role": "user", "content": "And of Spain?" }] }
\`\`\`

**Structured output (\`response_schema\`, Anthropic only):**

Pass a JSON Schema object to get a validated, parsed response. The platform injects a synthetic tool with that schema as its input_schema and forces the model to call it. The response gains \`parsed\` (the object) and \`parse_error\` (null on success). One silent retry on validation failure. Mutually exclusive with caller-provided \`tools\` — handle the tool-use loop yourself if you need both.

\`\`\`json
{
  "project_id": "my-saas",
  "provider": "anthropic",
  "messages": [{ "role": "user", "content": "Extract: 'Order #1234 for Alice, $49.99'" }],
  "response_schema": "{\\"type\\":\\"object\\",\\"properties\\":{\\"order_id\\":{\\"type\\":\\"string\\"},\\"customer\\":{\\"type\\":\\"string\\"},\\"amount\\":{\\"type\\":\\"number\\"}},\\"required\\":[\\"order_id\\",\\"customer\\",\\"amount\\"]}"
}
// Response: { "parsed": { "order_id": "1234", "customer": "Alice", "amount": 49.99 }, "parse_error": null, ... }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        messages: { type: 'string', description: 'JSON-stringified array of {role, content} messages. content is a string OR Anthropic content-block array (for tool_result multi-turn).' },
        provider: { type: 'string', description: 'Optional. "anthropic" (default, paid), "openai" (paid GPT), "xai" (paid Grok), or "workers-ai" (free, rate-limited).' },
        model: { type: 'string', description: 'Optional model ID. For anthropic defaults to claude-sonnet-4-6; for openai pass gpt-5.6-sol, gpt-5.6-terra, gpt-5.6-luna, gpt-5.4-nano, etc.; for workers-ai defaults to @cf/meta/llama-4-scout-17b-16e-instruct; for xai pass one of grok-4, grok-4-fast, grok-3-mini, grok-code-fast-1.' },
        max_tokens: { type: 'number', description: 'Optional max output tokens. Defaults to 1024. Anthropic capped at the model native limit (Sonnet 4.6: 128000, Sonnet 4.5: 64000, Opus 4.6: 32000, Haiku 4.5: 16384). xAI native limits: grok-4 65536, grok-4-fast / grok-code-fast-1 32000, grok-3-mini 16384. workers-ai free tier capped at 4096. Set higher than the default for code generation to avoid building continuation loops.' },
        system: { type: 'string', description: 'Optional system prompt' },
        tools: { type: 'string', description: 'Optional JSON-stringified Anthropic tool definitions. Passed through unchanged.' },
        tool_choice: { type: 'string', description: 'Optional JSON-stringified Anthropic tool_choice directive (e.g. {"type":"auto"} or {"type":"tool","name":"fs_search"}).' },
        response_schema: { type: 'string', description: 'Optional JSON-stringified JSON Schema. When set on provider:"anthropic", the response includes a validated `parsed` object. Mutually exclusive with `tools` and `stream`.' },
        conversation_id: { type: 'string', description: 'Optional. Persist this turn under a conversation id (any string up to 128 chars). Prior turns are loaded server-side and replayed on every provider — conversation history works on anthropic, workers-ai, and xai alike.' },
        history_max_messages: { type: 'number', description: 'Optional. Cap on the number of stored history messages prepended on this call. Oldest dropped first. Default 50. Only applies when conversation_id is set.' },
        history_max_tokens: { type: 'number', description: 'Optional. Cap on combined (system + history + new) input tokens (char/4 estimate). Oldest history dropped first. Default 32000. Only applies when conversation_id is set.' },
        compaction: { type: 'string', description: 'Optional. "truncate" (default) drops the oldest messages when the caps are hit. "summarize" folds them into a rolling Haiku summary that is prepended to the system prompt on every subsequent call — costs one extra Haiku request per overflow but preserves context. Only applies when conversation_id is set.' },
      },
      required: ['project_id', 'messages'],
    },
  },
    annotations: { title: 'Call an AI model', readOnlyHint: false, openWorldHint: true },
    group: 'ai',
    core: true,
    coreRank: 52,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","connector"],
    protocol: { surfaceDescriptions: { connector: "Generate a text response using a platform AI model. Usage is charged to the project." }, surfaceAnnotations: { connector: {"title":"Ai Complete","readOnlyHint":false,"destructiveHint":true} },  },
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const messages = parseJsonArg(args.messages, 'messages');
        const tools = typeof args.tools === 'string'
          ? (() => { try { return JSON.parse(args.tools as string); } catch { return undefined; } })()
          : args.tools;
        const toolChoice = typeof args.tool_choice === 'string'
          ? (() => { try { return JSON.parse(args.tool_choice as string); } catch { return args.tool_choice; } })()
          : args.tool_choice;
        const payload: Record<string, unknown> = {
          project_id: args.project_id,
          messages,
          provider: args.provider,
          model: args.model,
          max_tokens: args.max_tokens,
          system: args.system,
        };
        if (tools !== undefined) payload.tools = tools;
        if (toolChoice !== undefined) payload.tool_choice = toolChoice;
        if (args.response_schema !== undefined) {
          payload.response_schema = parseJsonArg(args.response_schema, 'response_schema');
        }
        if (args.conversation_id !== undefined) payload.conversation_id = args.conversation_id;
        if (args.history_max_messages !== undefined) payload.history_max_messages = args.history_max_messages;
        if (args.history_max_tokens !== undefined) payload.history_max_tokens = args.history_max_tokens;
        if (args.compaction !== undefined) payload.compaction = args.compaction;
        result = await callAPI(fetcher, 'POST', '/v1/ai/complete', authHeader, payload);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'ai_conversation_list',
    description: 'List the saved AI conversations for one subject, or fetch one with its messages. subject_type and subject_id are required so conversation history never falls back to a project-wide view. Omit conversation_id to list (most-recently-updated first; each row includes id, created_at, updated_at, message_count, summarized_message_count, and summary_updated_at). Pass conversation_id to fetch that single conversation — returns its summary (rolling text from compaction:"summarize", null otherwise), summary_updated_at, and the message log in chronological order. By default a fetch returns only live (non-summarized) messages, matching what the model sees on the next call; pass include_summarized:true to also see rows folded into the summary.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        subject_type: { type: 'string', description: "Conversation owner type. Use 'app_user' for signed-in app users." },
        subject_id: { type: 'string', description: 'Conversation owner id. The server applies this scope to both list and single-conversation reads.' },
        conversation_id: { type: 'string', description: 'Optional. Pass the id you used with ai_complete to fetch one conversation with its messages. Omit to list all conversations.' },
        include_summarized: { type: 'boolean', description: 'Optional. Only applies when fetching one conversation: when true, also returns messages folded into the summary (the full transcript). Default false.' },
        limit: { type: 'number', description: 'Optional. Only applies when listing. Max conversations to return. Default 50, max 200.' },
      },
      required: ['project_id', 'subject_type', 'subject_id'],
    },
  },
    annotations: { title: 'List saved conversations, or read one', readOnlyHint: true, idempotentHint: true },
    group: 'ai',
    core: true,
    coreRank: 92,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const params = new URLSearchParams({ project_id: String(args.project_id) });
        params.set('subject_type', String(args.subject_type));
        params.set('subject_id', String(args.subject_id));
        if (typeof args.conversation_id === 'string' && args.conversation_id) {
          // Fetch one conversation with its messages
          if (args.include_summarized === true || args.include_summarized === 'true') {
            params.set('include_summarized', '1');
          }
          result = await callAPI(fetcher, 'GET', `/v1/ai/conversations/${encodeURIComponent(String(args.conversation_id))}?${params.toString()}`, authHeader);
        } else {
          // List all conversations
          if (args.limit !== undefined) params.set('limit', String(args.limit));
          result = await callAPI(fetcher, 'GET', `/v1/ai/conversations?${params.toString()}`, authHeader);
        }
        return result;

      }
    },
  },
  {
    definition: {
    name: 'ai_conversation_delete',
    description: 'Delete one subject-owned AI conversation and all its messages. subject_type and subject_id are required and rechecked against the conversation row. Idempotent — returns deleted: false if the id was already gone or belongs to another subject.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        subject_type: { type: 'string', description: "Conversation owner type. Use 'app_user' for signed-in app users." },
        subject_id: { type: 'string', description: 'Conversation owner id.' },
        conversation_id: { type: 'string', description: 'The id to delete.' },
      },
      required: ['project_id', 'subject_type', 'subject_id', 'conversation_id'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    group: 'ai',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const params = new URLSearchParams({ project_id: String(args.project_id) });
        params.set('subject_type', String(args.subject_type));
        params.set('subject_id', String(args.subject_id));
        result = await callAPI(fetcher, 'DELETE', `/v1/ai/conversations/${encodeURIComponent(String(args.conversation_id))}?${params.toString()}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'ai_conversation_fork',
    description: 'Branch one subject-owned AI conversation under a new id without losing the original. subject_type and subject_id are required and rechecked against the source row. Use for "regenerate from this point" or "what if I asked differently" UIs. Pass up_to_message_id (the numeric id from ai_conversation_list messages[]) to truncate the copy at that message inclusive; omit to copy the full history. Returns 404 if the source is missing or belongs to another subject, 409 if the new id is already in use.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        subject_type: { type: 'string', description: "Conversation owner type. Use 'app_user' for signed-in app users." },
        subject_id: { type: 'string', description: 'Conversation owner id.' },
        conversation_id: { type: 'string', description: 'The source id to branch from.' },
        new_conversation_id: { type: 'string', description: 'The new id for the forked copy. 1-128 chars; must differ from the source.' },
        up_to_message_id: { type: 'number', description: 'Optional. Numeric message id (from ai_conversation_list with a conversation_id) to truncate the copy at, inclusive. Omit to copy the full history.' },
      },
      required: ['project_id', 'subject_type', 'subject_id', 'conversation_id', 'new_conversation_id'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    group: 'ai',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', `/v1/ai/conversations/${encodeURIComponent(String(args.conversation_id))}/fork`, authHeader, {
          project_id: args.project_id,
          subject_type: args.subject_type,
          subject_id: args.subject_id,
          new_conversation_id: args.new_conversation_id,
          ...(args.up_to_message_id !== undefined ? { up_to_message_id: Number(args.up_to_message_id) } : {}),
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'ai_embed',
    description: 'Need custom semantic similarity, clustering, or recommendation math? ai_embed turns text into vectors you control. For a managed FAQ/catalog/RAG index, prefer search_upsert instead — it embeds and indexes content for you. Returns an array of float vectors. Free via provider:"workers-ai" (bge-base-en-v1.5, bge-large-en-v1.5, bge-small-en-v1.5, qwen3-embedding-0.6b, embeddinggemma-300m). Pass one string or up to 100 strings. No activation required for free models. Rate limits: Free tier 10/min and 200/day; Builder tier 200/min and 10,000/day.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        input: { type: 'string', description: 'A single string, or a JSON-stringified array of up to 100 strings.' },
        provider: { type: 'string', description: 'Optional. Currently only "workers-ai" is supported (default).' },
        model: { type: 'string', description: 'Optional model ID. Defaults to @cf/baai/bge-base-en-v1.5 (768-dim).' },
      },
      required: ['project_id', 'input'],
    },
  },
    annotations: { readOnlyHint: false, openWorldHint: true },
    group: 'ai',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        // Accept `input` as either a raw string or a JSON-stringified array,
        // then map to the REST endpoint's `text` parameter (which takes
        // string | string[]). Falling back to the raw value preserves single
        // strings that aren't valid JSON.
        let text: unknown = args.input;
        if (typeof args.input === 'string') {
          const trimmed = (args.input as string).trim();
          if (trimmed.startsWith('[')) {
            try { text = JSON.parse(trimmed); } catch { /* keep as string */ }
          }
        }
        result = await callAPI(fetcher, 'POST', '/v1/ai/embeddings', authHeader, {
          project_id: args.project_id,
          text,
          model: args.model,
        });
        return result;

      }
    },
  },
  // ── jobs ─────────────────────────────────────────────
  {
    definition: {
    name: 'job_create',
    description: `**Will work outlive the user request, need retries, or need a status later?** \`job_create\` queues a durable background job. The platform POSTs the payload to your handler URL and retries on failure (at-least-once, up to 5 attempts with exponential backoff). Make handlers idempotent.

Use this for work that shouldn't block a user request: image processing, report generation, outbound email batches, webhook deliveries.

**Example:**

\`\`\`json
{
  "project_id": "my-saas",
  "handler": "https://my-saas.somewhere.site/api/jobs/process-upload",
  "payload": { "upload_id": "u123", "user_id": "u_alice" },
  "timeout_seconds": 600
}
// Returns: { "job_id": "j_abc", "status": "queued" }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        idempotency_key: { type: 'string', maxLength: 200, description: 'Stable key for one logical creation. Reuse it with identical arguments after a lost response; use a new key for independent work.' },
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        handler: { type: 'string', description: 'Full https:// URL. The platform POSTs the payload here. Usually one of your own /api/... function routes.' },
        payload: { type: ['string', 'object'], description: 'JSON string or object — becomes the POST body your handler receives.' },
        webhook_url: { type: 'string', description: 'Optional https:// URL — platform POSTs {job_id, status, result} here when the job reaches a terminal state.' },
        timeout_seconds: { type: 'number', description: 'Max wall-clock seconds per attempt. Default 300. Max 1800.' },
      },
      required: ['project_id', 'handler'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    group: 'jobs',
    core: true,
    coreRank: 61,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      const invocationKey = args.idempotency_key !== undefined ? args.idempotency_key : crypto.randomUUID();
      let result: ToolUpstreamResult;
      {
        const payload = args.payload ? parseJsonArg(args.payload, 'payload') : undefined;
        result = await callAPI(fetcher, 'POST', '/v1/jobs', authHeader, {
          project_id: args.project_id,
          idempotency_key: invocationKey,
          handler: args.handler,
          payload,
          webhook_url: args.webhook_url,
          timeout_seconds: args.timeout_seconds,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'job_get',
    description: `Get background job details. Pass a \`job_id\` to get one job, or pass \`project_id\` (without job_id) to list recent jobs. Optionally filter by status.

**Example:**

\`\`\`json
// Single job:
{ "project_id": "my-saas", "job_id": "j_abc" }

// List recent:
{ "project_id": "my-saas", "status": "failed" }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'The job ID. If provided, returns details for this single job.' },
        project_id: { type: 'string', description: "Optional — filter to one project. Accepts UUID, subdomain, or 'default'." },
        status: { type: 'string', description: 'Optional — queued | running | complete | failed | cancelled' },
        cron_id: { type: 'string', description: 'Optional — list only the history created by this scheduled task.' },
        limit: { type: 'number', description: 'Max rows when listing (default 20, max 100)' },
      },
      required: [],
    },
  },
    annotations: { readOnlyHint: true, idempotentHint: true },
    group: 'jobs',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        if (args.job_id) {
          // Get single job by ID
          result = await callAPI(fetcher, 'GET', `/v1/jobs/${args.job_id}`, authHeader);
        } else {
          // List jobs with optional filters
          const params = new URLSearchParams();
          if (args.project_id) params.set('project_id', args.project_id as string);
          if (args.status) params.set('status', args.status as string);
          if (args.cron_id) params.set('cron_id', args.cron_id as string);
          if (args.limit) params.set('limit', String(args.limit));
          const qs = params.toString() ? `?${params}` : '';
          result = await callAPI(fetcher, 'GET', `/v1/jobs${qs}`, authHeader);
        }
        return result;

      }
    },
  },
  {
    definition: {
    name: 'job_cancel',
    description: 'Cancel a queued or running job. Best-effort: the row is marked cancelled immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'The job ID' },
      },
      required: ['job_id'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    group: 'jobs',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', `/v1/jobs/${args.job_id}/cancel`, authHeader);
        return result;

      }
    },
  },
  // ── cron ─────────────────────────────────────────────
  {
    definition: {
    name: 'cron_create',
    description: `Create a scheduled trigger. Schedule is a 5-field cron expression (\`minute hour dom month dow\`). It uses UTC by default; pass an IANA \`timezone\` such as \`America/Los_Angeles\` for local wall-clock scheduling with daylight-saving changes handled automatically. Each fire dispatches a job to your handler (at-least-once delivery — build idempotently). Missed fires during platform downtime are NOT replayed.

**Common patterns:**

| Pattern | Schedule |
|---------|----------|
| Every 15 minutes | \`*/15 * * * *\` |
| Daily at 08:00 UTC | \`0 8 * * *\` |
| Every 6 hours | \`0 */6 * * *\` |
| Weekly Monday midnight | \`0 0 * * 1\` |

**Minimum interval.** Your plan sets the smallest gap allowed between two
fires. \`cron_list({ project_id })\` reports it as
\`policy.min_interval_minutes\`, alongside \`policy.max_per_project\`. A
schedule tighter than the floor is refused with
\`CRON_SCHEDULE_TOO_FREQUENT\` and the message names both intervals.
Schedules that already exist are never re-checked — they keep firing on the
cadence they were created with.

**Example:**

\`\`\`json
{
  "project_id": "my-saas",
  "name": "daily-digest",
  "schedule": "0 8 * * *",
  "handler": "https://my-saas.somewhere.site/api/cron/daily-digest",
  "payload": { "type": "digest" }
}
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        schedule: { type: 'string', description: '5-field cron expression in the selected timezone (UTC when omitted). Must not fire more often than the plan floor reported by cron_list.' },
        timezone: { type: 'string', description: 'Optional IANA timezone, e.g. America/Los_Angeles. Defaults to UTC; daylight-saving transitions are handled by the scheduler.' },
        handler: { type: 'string', description: 'Project-relative /api path or full https:// URL the platform POSTs to on each fire.' },
        payload: { type: ['string', 'object'], description: 'Optional JSON object or JSON string — becomes the POST body on each fire.' },
        name: { type: 'string', description: 'Optional display name, shown in the dashboard.' },
        enabled: { type: 'boolean', description: 'Optional. Whether the trigger should fire. Defaults to true.' },
      },
      required: ['project_id', 'schedule', 'handler'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    group: 'cron',
    core: true,
    coreRank: 62,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const payload = args.payload ? parseJsonArg(args.payload, 'payload') : undefined;
        result = await callAPI(fetcher, 'POST', '/v1/cron', authHeader, {
          project_id: args.project_id,
          schedule: args.schedule,
          timezone: args.timezone,
          handler: args.handler,
          payload,
          name: args.name,
          enabled: args.enabled,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'cron_list',
    description: 'List cron triggers for a project (or all your projects). Each row includes timezone, last_run_at, last_run_status, and next_run_at. Passing project_id also returns `policy` — the project owner\'s plan name, the smallest interval a new or edited schedule may have, and how many scheduled tasks the project may hold.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Optional — filter to one project. Accepts UUID, subdomain, or 'default'." },
      },
      required: [],
    },
  },
    annotations: { readOnlyHint: true, idempotentHint: true },
    group: 'cron',
    core: true,
    coreRank: 98,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const qs = args.project_id ? `?project_id=${encodeURIComponent(args.project_id as string)}` : '';
        result = await callAPI(fetcher, 'GET', `/v1/cron${qs}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
      name: 'cron_run',
      description: 'Run an existing scheduled task once now through the same job handler used by scheduled fires. This does not change its schedule. The run is recorded in job history with trigger `manual`.',
      inputSchema: {
        type: 'object',
        properties: {
          cron_id: { type: 'string', description: 'The cron ID' },
        },
        required: ['cron_id'],
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    group: 'cron',
    core: true,
    coreRank: 110,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      return callAPI(fetcher, 'POST', `/v1/cron/${encodeURIComponent(args.cron_id as string)}/run`, authHeader);
    },
  },
  {
    definition: {
    name: 'cron_delete',
    description: 'Delete a cron trigger. Past runs are not deleted — the cron stops firing future ones.',
    inputSchema: {
      type: 'object',
      properties: {
        cron_id: { type: 'string', description: 'The cron ID' },
      },
      required: ['cron_id'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    group: 'cron',
    core: true,
    coreRank: 104,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'DELETE', `/v1/cron/${encodeURIComponent(args.cron_id as string)}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'cron_update',
    description: 'Update a cron trigger\'s schedule, IANA timezone, handler, payload, display name, or enabled state. Sending a new `schedule` or `timezone` recomputes the next fire and re-checks the plan minimum (see cron_list `policy`); every other edit, including resuming a paused task, leaves an existing schedule alone.',
    inputSchema: {
      type: 'object',
      properties: {
        cron_id: { type: 'string', description: 'The cron ID' },
        schedule: { type: 'string', description: 'New 5-field cron expression. Re-checked against the plan floor; omit it to leave the current schedule untouched.' },
        timezone: { type: 'string', description: 'New IANA timezone, e.g. America/Los_Angeles. Changing it recomputes next_run_at; omit it to keep the current timezone.' },
        handler: { type: 'string', description: 'New project-relative /api path or full https:// URL the platform will POST to' },
        payload: { type: ['string', 'object'], description: 'New JSON object or JSON string passed to the handler' },
        name: { type: 'string', description: 'New display name' },
        enabled: { type: 'boolean', description: 'Enable or disable future fires' },
      },
      required: ['cron_id'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    group: 'cron',
    core: true,
    coreRank: 105,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const body: Record<string, unknown> = {};
        if (args.schedule) body.schedule = args.schedule;
        if (args.timezone !== undefined) body.timezone = args.timezone;
        if (args.handler) body.handler = args.handler;
        if (args.payload) body.payload = parseJsonArg(args.payload, 'payload');
        if (args.name) body.name = args.name;
        if (args.enabled !== undefined) body.enabled = args.enabled;
        result = await callAPI(fetcher, 'PATCH', `/v1/cron/${encodeURIComponent(args.cron_id as string)}`, authHeader, body);
        return result;

      }
    },
  },
  // ── queue ─────────────────────────────────────────────
  {
    definition: {
    name: 'queue_send',
    description: `**Need to kick off a side effect after responding, with no status or result to inspect?** \`queue_send\` dispatches fire-and-forget background work. It is lighter than a job; use \`job_create\` when you need retries you can inspect, progress, or a result.

**Example:**

\`\`\`json
{
  "project_id": "my-saas",
  "handler": "https://my-saas.somewhere.site/api/hooks/slack-notify",
  "payload": { "message": "New signup: alice@example.com" }
}
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        handler: { type: 'string', description: 'Full https:// URL to POST the payload to' },
        payload: { type: ['string', 'object'], description: 'Optional JSON string or object passed to the handler' },
        delay_seconds: { type: 'number', description: 'Optional delay before processing (max 12h)' },
      },
      required: ['project_id', 'handler'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    group: 'queue',
    core: true,
    coreRank: 63,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const payload = args.payload ? parseJsonArg(args.payload, 'payload') : undefined;
        result = await callAPI(fetcher, 'POST', '/v1/queue', authHeader, {
          project_id: args.project_id,
          handler: args.handler,
          payload,
          delay_seconds: args.delay_seconds,
        });
        return result;

      }
    },
  },
  // ── project ─────────────────────────────────────────────
  {
    definition: {
    name: 'project_logs',
    description: `Tail function logs, read recent runtime output, debug a just-deployed endpoint, see what console.log printed, observability. **After every project_deploy / project_patch, call this with the project_id to see what the new code logged on the first few requests — no need to curl the endpoint and guess.** Also writes logs (provide a message).

Read mode (omit message): returns the most recent log lines for the project, newest first. Filter by level, source (server | client | function | job | cron | queue | system | oauth), substring match, or trace ID. Default limit 50, max 500.

Write mode (include message): records a structured log line. Used by your own monitoring code, or by an agent that wants to mark a checkpoint. Writes are durable but ingested asynchronously — a line you just wrote may take a few seconds to appear in a read. \`queued:true\` confirms acceptance, not immediate readability.

**Example:**

\`\`\`json
// Read recent logs after a deploy:
{ "project_id": "my-saas", "limit": 50 }

// Read only errors:
{ "project_id": "my-saas", "level": "error", "limit": 50 }

// Read logs from one source:
{ "project_id": "my-saas", "source": "server", "search": "/api/checkout" }

// Write (with structured data):
{ "project_id": "my-saas", "message": "Payment processed", "level": "info", "data": "{\\"amount\\":49.99}" }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        message: { type: 'string', description: 'Log message. Omit to read logs instead of writing.' },
        level: { type: 'string', description: 'debug | info | warn | error (default info)' },
        data: { type: 'string', description: 'Optional JSON string of structured data (write mode)' },
        source: { type: 'string', description: 'Filter to one source: server | client | function | job | cron | queue | system | oauth (read mode)' },
        search: { type: 'string', description: 'Substring match on message (read mode)' },
        trace_id: { type: 'string', description: 'Optional 32-character trace id. Returns only log lines from that distributed request.' },
        limit: { type: 'number', description: 'Max rows (default 50, max 500, read mode)' },
      },
      required: ['project_id'],
    },
  },
    annotations: { title: 'Tail or write a log line', readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    group: 'project',
    core: true,
    coreRank: 47,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","chatgpt"],
    protocol: { oauthScopes: ['mcp'] },
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        if (args.message) {
          // Write log
          const data = args.data ? parseJsonArg(args.data, 'data') : undefined;
          result = await callAPI(fetcher, 'POST', '/v1/logs', authHeader, {
            project_id: args.project_id,
            level: args.level || 'info',
            message: args.message,
            data,
          });
        } else {
          // Read logs
          const params = new URLSearchParams();
          params.set('project_id', args.project_id as string);
          if (args.level) params.set('level', args.level as string);
          if (args.source) params.set('source', args.source as string);
          if (args.search) params.set('search', args.search as string);
          if (args.trace_id) params.set('trace_id', args.trace_id as string);
          if (args.limit) params.set('limit', String(args.limit));
          result = await callAPI(fetcher, 'GET', `/v1/logs?${params}`, authHeader);
        }
        return result;

      }
    },
  },
  // ── logs ─────────────────────────────────────────────
  {
    definition: {
    name: 'errors',
    description: `Why is my app broken, exceptions, stack traces, failures, recent errors, crash reports, debugging. Pass one trace_id to get the complete ordered parent/child operation waterfall plus its correlated logs, errors, deploy failures, and journey events. No project lookup is required for that one-id path. Without a trace id, pass project_id to get the last 24h of failures from that project's functions. Each row carries \`kind\`: "exception" means nobody chose the outcome (an uncaught throw, or a 5xx) and "refusal" means a handler answered 4xx on purpose — a 401 from your own auth gate is a refusal, not a bug, so filter on \`kind\` before concluding something is broken.

**Example:**

\`\`\`json
{ "project_id": "my-saas", "limit": 20 }
// Returns: [{ "timestamp": "2026-04-20T...", "path": "/api/users/signup", "status": 500, "message": "UNIQUE constraint failed: users.email" }, ...]
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        trace_id: { type: 'string', description: 'Optional 32-character trace id returned by the platform. When supplied, returns the ordered waterfall and all correlated evidence; project_id is optional.' },
        limit: { type: 'number', description: 'Max number of errors to return (default: 10, max: 100)' },
      },
      required: [],
    },
  },
    annotations: { title: 'Read recent app errors', readOnlyHint: true, idempotentHint: true },
    group: 'logs',
    core: true,
    coreRank: 48,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","chatgpt"],
    protocol: { oauthScopes: ['mcp'] },
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        if (typeof args.trace_id === 'string' && args.trace_id.length > 0) {
          const params = new URLSearchParams();
          if (typeof args.project_id === 'string' && args.project_id.length > 0) {
            params.set('project_id', args.project_id);
          }
          result = await callAPI(fetcher, 'GET', `/v1/traces/${encodeURIComponent(args.trace_id)}?${params}`, authHeader);
          return result;
        }
        if (typeof args.project_id !== 'string' || args.project_id.length === 0) {
          return {
            content: [{ type: 'text', text: 'errors requires either trace_id for one request waterfall or project_id for recent errors.' }],
            isError: true,
          };
        }
        const params = new URLSearchParams();
        params.set('project_id', args.project_id as string);
        if (args.limit) params.set('limit', args.limit as string);
        result = await callAPI(fetcher, 'GET', `/v1/errors/recent?${params}`, authHeader);
        return result;

      }
    },
  },
  // ── usage ─────────────────────────────────────────────
  {
    definition: {
    name: 'usage_summary',
    description: `Get usage metrics. With no arguments this delegates to the authoritative account-wide \`/v1/usage/summary\` and includes per-project database snapshots, file/artifact storage, combined storage, limits, and 30-day totals. Passing \`project_id\` or \`period\` preserves the narrower historical usage call (deploys, AI calls/costs, emails) and does not claim to include storage.

**Example:**

\`\`\`json
{}
// Returns the account-wide usage summary including storage and database bytes.
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Optional. Accepts UUID, subdomain, or 'default'. Omit for all projects." },
        period: { type: 'string', description: 'Time period, e.g. "7d", "30d" (default: 30d)' },
      },
      required: [],
    },
  },
    annotations: { title: 'Show usage + cost', readOnlyHint: true, idempotentHint: true },
    group: 'usage',
    core: true,
    coreRank: 49,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const params = new URLSearchParams();
        if (args.project_id) params.set('project_id', args.project_id as string);
        if (args.period) params.set('period', args.period as string);
        const hasNarrowFilter = params.toString().length > 0;
        if (hasNarrowFilter) {
          result = await callAPI(fetcher, 'GET', `/v1/usage?${params}`, authHeader);
        } else {
          result = await callAPI(fetcher, 'GET', '/v1/usage/summary', authHeader);
        }
        return result;

      }
    },
  },
  // ── feedback ─────────────────────────────────────────────
  {
    definition: {
    name: 'feedback',
    description: `End-user app feedback sent to the project's private owner inbox (\`destination: "project_owner_inbox"\`) — this does not reach the somewhere.tech platform team. Every successful submission repeats that destination and names the exact platform-support calls. Submit: provide a message about that project's own UI or behavior. List: omit message to see feedback on a project you own. When the project owner resolves one of these reports, the owner-facing project channel can emit a \`feedback_resolved\` event.

For a somewhere.tech platform bug, missing capability, deploy/API problem, or documentation issue, do not use this tool. Use \`support_ticket({ message: "..." })\`, which sends the report to the platform support queue.

**Example:**

\`\`\`json
// Submit:
{ "project_id": "my-saas", "message": "The checkout button in this app does nothing after I enter my card" }

// List:
{ "project_id": "my-saas" }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        message: { type: 'string', description: 'Feedback message. Omit to list feedback instead.' },
        page_url: { type: 'string', description: 'Optional page URL the feedback is about (submit mode)' },
      },
      required: ['project_id'],
    },
  },
    annotations: { title: 'Send app feedback to its owner', readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    group: 'feedback',
    core: true,
    coreRank: 3,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        if (args.message) {
          // Submit feedback
          result = await callAPI(fetcher, 'POST', `/v1/projects/${encodeURIComponent(args.project_id as string)}/feedback`, authHeader, {
            message: args.message,
            page_url: args.page_url,
          });
        } else {
          // List feedback
          result = await callAPI(fetcher, 'GET', `/v1/projects/${encodeURIComponent(args.project_id as string)}/feedback`, authHeader);
        }
        return result;

      }
    },
  },
  {
    definition: {
    name: 'support_ticket',
    description: `Support tickets for the somewhere.tech platform team — submit, check, list, or resolve your own tickets. Use this when something on the platform itself surprises you, blocks you, or seems wrong: a doc gap, an unexpected error shape, a missing capability, a bug in an MCP tool, or an inconsistency between docs and behavior. **Not** for feedback on a user's own app — that's the \`feedback\` tool.

**Four modes, by argument:**
- Pass \`message\` → submit a new support ticket. Returns a durable \`ticket_id\` immediately, stores the raw ticket in the support inbox, and notifies the team. The team replies on that same ticket. When the team records a reply or resolves the ticket, the reporting developer receives an email and a developer-channel \`feedback_resolved\` event automatically. Ticket status remains readable before that notification arrives.
- Pass \`ticket_id\` and \`action: "resolve"\` → resolve a ticket you submitted. This cannot resolve another submitter's ticket. An authenticated platform admin may also pass \`response\` to write the customer-facing reply and resolve the ticket atomically.
- Pass \`ticket_id\` (no message) → read that one ticket. Returns its \`status\` (open / investigating / resolved) and \`response\` (the team's reply, once written).
- Omit both → list your own tickets, most recent first (open and resolved), each with status, response, and resolution timestamp. Add a \`status\` filter to narrow the list.

**Example:**

\`\`\`json
// Submit:
{
  "message": "PUT /v1/fs binary upload returns 200 but reads back as UTF-8-replaced bytes — every byte ≥0x80 becomes EF BF BD. Reproed with curl --data-binary @cat.jpg.",
  "context": { "endpoint": "PUT /v1/fs", "file_size": 82823, "tried": ["binary_files base64 (worked)"] }
}

// Check one ticket:
{ "ticket_id": "pfb_a1b2c3d4e5f6" }

// Resolve your own ticket:
{ "ticket_id": "pfb_a1b2c3d4e5f6", "action": "resolve" }

// Admin reply + resolve:
{ "ticket_id": "pfb_a1b2c3d4e5f6", "action": "resolve", "response": "This is fixed and live. No action needed." }

// List open tickets:
{ "status": "open", "limit": 20 }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Submit mode. The support-ticket details — be specific: what you tried, what you expected, what happened. Up to 8000 chars.' },
        ticket_id: { type: 'string', description: 'Check or resolve mode. A ticket id returned by a prior submit. Omit message when using this.' },
        action: { type: 'string', enum: ['resolve'], description: 'Resolve mode. Pass "resolve" with ticket_id to close a support ticket you submitted. Admins may add response to reply and close atomically.' },
        response: { type: 'string', description: 'Admin resolve mode only. Written customer-facing reply to store and send while resolving the ticket atomically. Regular submitters should omit this and keep using action: "resolve" unchanged.' },
        status: { type: 'string', description: 'List mode. Optional filter: open, investigating, or resolved. Omit message and ticket_id to list your tickets.' },
        limit: { type: 'number', description: 'List mode. Optional. Max tickets to return (default 50, max 200).' },
        project_id: { type: 'string', description: 'Submit mode. Optional. Project the support ticket relates to (UUID, subdomain, or "default").' },
        context: { type: 'object', description: 'Submit mode. Optional structured context — endpoint, file size, error code, anything reproducible. Free-form JSON, up to 16KB.' },
        parent_id: { type: 'string', description: 'Submit mode. Optional. The one narrowed task this ticket is about. Multiple tickets may link to the same task; its shipped version closes the linked tickets.' },
      },
      required: [],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    group: 'feedback',
    core: true,
    coreRank: 4,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","chatgpt"],
    protocol: { surfaceAnnotations: { chatgpt: { destructiveHint: true, openWorldHint: true } }, oauthScopes: ['mcp'] },
    execute: async (runtime, args) => {
      const { fetcher, env, authHeader, ctx, toolName } = runtime;
      let result: ToolUpstreamResult;
      {
        if (toolName === 'support_ticket' && args.action !== undefined && (
          args.action !== 'resolve'
          || typeof args.ticket_id !== 'string'
          || !args.ticket_id
          || args.message !== undefined
          || (args.response !== undefined && (
            typeof args.response !== 'string'
            || !args.response.trim()
            || args.response.length > 16000
          ))
        )) {
          return badArgsToolResult(
            env, authHeader, ctx, toolName, args,
            'support_ticket resolve requires ticket_id, cannot be combined with message, and accepts an optional non-empty response up to 16000 characters for admins.\nExamples:\nsupport_ticket({ "ticket_id": "pfb_a1b2c3d4e5f6", "action": "resolve" })\nsupport_ticket({ "ticket_id": "pfb_a1b2c3d4e5f6", "action": "resolve", "response": "This is fixed and live. No action needed." })',
          );
        }
        if (args.response !== undefined && args.action !== 'resolve') {
          return badArgsToolResult(
            env, authHeader, ctx, toolName, args,
            'support_ticket response is admin-only resolve input and requires ticket_id with action: "resolve".',
          );
        }
        const request = buildSupportTicketRestRequest(toolName as 'support_ticket', args);
        result = await callAPI(fetcher, request.method, request.path, authHeader, request.body);
        return result;

      }
    },
  },
  // ── domains ─────────────────────────────────────────────
  {
    definition: {
    name: 'domain_add',
    description: `Add a custom domain to your project. Returns the DNS targets you need to configure at your registrar.

**Example:**

\`\`\`json
{ "project_id": "my-saas", "domain": "app.yourcompany.com" }
// Returns: { "domain": "app.yourcompany.com", "cname_target": "proxy.somewhere.tech", "verified": false, "verification_txt_name": "_somewhere-verify.app.yourcompany.com", "verification_txt_value": "smt-verify-...", "instructions": "..." }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        domain: { type: 'string', description: 'Custom domain, e.g. "example.com" or "app.example.com"' },
      },
      required: ['project_id', 'domain'],
    },
  },
    annotations: { title: 'Add an existing domain', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    group: 'domains',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","connector"],
    protocol: { surfaceDescriptions: { connector: "Attach an existing domain to a project and return DNS configuration instructions." }, surfaceAnnotations: { connector: {"title":"Domain Add","readOnlyHint":false,"destructiveHint":true} },  },
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', '/v1/domains/add', authHeader, {
          project_id: args.project_id,
          domain: args.domain,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'domain_verify',
    description: 'Check if a custom domain\'s DNS is configured correctly.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        domain: { type: 'string', description: 'Custom domain to verify' },
      },
      required: ['domain'],
    },
  },
    annotations: { title: 'Verify a domain', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    group: 'domains',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","connector"],
    protocol: { surfaceDescriptions: { connector: "Check DNS configuration and activate an attached domain when verification succeeds." }, surfaceAnnotations: { connector: {"title":"Domain Verify","readOnlyHint":false,"destructiveHint":true} },  },
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const params = new URLSearchParams({ domain: String(args.domain) });
        if (args.project_id !== undefined) params.set('project_id', String(args.project_id));
        result = await callAPI(fetcher, 'GET', `/v1/domains/verify?${params.toString()}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'domain_list',
    description: 'List custom domains configured for a project, with their verification status.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
      },
      required: ['project_id'],
    },
  },
    annotations: { title: 'List your domains', readOnlyHint: true, idempotentHint: true },
    group: 'domains',
    core: true,
    coreRank: 25,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'GET', `/v1/domains?project_id=${encodeURIComponent(args.project_id as string)}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'domain_remove',
    description: 'Remove a custom domain from a project. Ownership is derived from the domain and your key — no project_id needed.',
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Custom domain to remove' },
      },
      required: ['domain'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    group: 'domains',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const path = `/v1/domains/${encodeURIComponent(String(args.domain))}`;
        result = await callAPI(fetcher, 'DELETE', path, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'domain_check',
    description: `Check if a domain is available for purchase and get the price.

**Example:**

\`\`\`json
{ "domain": "acmedash.com" }
// Returns: { "available": true, "price": "$12.00/year" }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain to check, e.g. mybooking.com' },
      },
      required: ['domain'],
    },
  },
    annotations: { title: 'Check domain availability', readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    group: 'domains',
    core: true,
    coreRank: 24,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","connector"],
    protocol: { surfaceDescriptions: { connector: "Check availability and purchase pricing for one exact domain name. This does not purchase the domain." }, surfaceAnnotations: { connector: {"title":"Domain Check","readOnlyHint":true} },  },
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'GET', `/v1/domains/check?domain=${encodeURIComponent(args.domain as string)}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'domain_buy',
    description: `Preview a domain purchase and get a secure checkout link.

Call \`domain_buy\` with project_id + domain. The platform returns the price and a \`dashboard_checkout_url\`. Show the price to the user verbatim, then share that secure checkout link to complete payment.

Customer purchases cannot be completed through another MCP tool. The user completes payment through the checkout link, and registration begins only after that payment settles.

The domain is registered **in the buyer's name** — they own it outright and can transfer it to any registrar or account whenever they want. Mention this when sharing the checkout link; details: https://somewhere.tech/domain-ownership

**Example:**

\`\`\`json
{ "project_id": "my-saas", "domain": "acmedash.com" }
\`\`\`

The response will be an error of type \`PURCHASE_CONFIRMATION_REQUIRED\` carrying the price and checkout URL, e.g. \`{ "ok": false, "error": "PURCHASE_CONFIRMATION_REQUIRED", "domain": "acmedash.com", "price": "$17/year", "confirm_token": "...", "dashboard_checkout_url": "https://somewhere.tech/dashboard/projects/.../?tab=domains&buy=acmedash.com" }\`. Treat this response as a checkout handoff: share the \`dashboard_checkout_url\` and let the user complete payment there.`,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project ID' },
        domain: { type: 'string', description: 'Domain to purchase, e.g. mybooking.com' },
      },
      required: ['project_id', 'domain'],
    },
  },
    annotations: { title: 'Buy a domain', readOnlyHint: false, openWorldHint: true },
    group: 'domains',
    core: true,
    coreRank: 23,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        // Preview the purchase, then attach the dashboard checkout URL. The
        // agent hands that URL to the customer; no MCP tool finalizes payment.
        result = await callAPI(fetcher, 'POST', '/v1/domains/buy/preview', authHeader, {
          project_id: args.project_id,
          domain: args.domain,
        });
        if (result.data && typeof result.data === 'object' && !Array.isArray(result.data)) {
          const projectIdEnc = encodeURIComponent(String(args.project_id));
          const domainEnc = encodeURIComponent(String(args.domain));
          (result.data as Record<string, unknown>).dashboard_checkout_url =
            `https://somewhere.tech/dashboard/projects/${projectIdEnc}?tab=domains&buy=${domainEnc}`;
        }
        return result;

      }
    },
  },
  {
    definition: {
    name: 'domain_claim',
    description: `Claim a domain you already own by delegating its nameservers to us. The platform creates a dedicated zone, returns the nameserver pair to paste at your registrar, and starts polling for propagation. Once the zone goes active you can attach the domain to any project (and re-attach later without re-claiming).

This is the recommended path for any domain you control — it covers apex (\`example.com\`), \`www\`, and any subdomain in one move, and unlocks inbox routing on the same domain.

Claims belong to your account, not to a project. Project deletion is not the cleanup path for an unattached or pending claim. To remove one from your account (including a claim created for a temporary test), call \`domain_remove({ domain: "example.com" })\` before deleting the project.

**Example:**

\`\`\`json
{ "domain": "example.com" }
// Returns: { "id": "...", "nameservers": ["<assigned-ns1>", "<assigned-ns2>"], "claim_status": "pending_ns", "instructions": [...] }
// The actual nameserver hostnames are assigned by the platform and returned by this call.
\`\`\`

After updating nameservers at your registrar, call \`domain_check_ns\` (or wait for the hourly poll) to flip \`claim_status\` to \`active\`. Then call \`domain_attach\` to bind it to a project.`,
    inputSchema: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Registered domain name (apex), e.g. "example.com". Subdomains are normalized to the registered domain — claim once, attach subdomains separately.' },
      },
      required: ['domain'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    group: 'domains',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', '/v1/domains/claim', authHeader, {
          domain: args.domain,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'domain_owned',
    description: 'List every account-level domain claim created via `domain_claim`, regardless of which project (if any) it is currently attached to. Project deletion is not the cleanup path for an unattached claim; use `domain_remove({ domain })` to remove one from your account.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
    annotations: { readOnlyHint: true, idempotentHint: true },
    group: 'domains',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'GET', '/v1/domains/owned', authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'domain_check_ns',
    description: 'Force an immediate nameserver check for a claimed domain. Returns the new claim_status. The platform also polls hourly in the background — use this when the user just updated their registrar and wants instant feedback.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Domain ID returned by domain_claim or domain_owned.' },
      },
      required: ['id'],
    },
  },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    group: 'domains',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', `/v1/domains/${encodeURIComponent(String(args.id))}/check-ns`, authHeader, {});
        return result;

      }
    },
  },
  {
    definition: {
    name: 'domain_attach',
    description: `Bind a claimed (active) domain to one of your projects. \`host\` picks the entry point — \`apex\` (\`example.com\`), \`www\` (\`www.example.com\`), or a single subdomain label like \`app\` (→ \`app.example.com\`).

Re-attaching to a different project is a clean swap — no re-verification. To free the binding without unclaiming, call \`domain_detach\`.

**Example:**

\`\`\`json
{ "id": "dom_...", "project_id": "my-saas", "host": "apex" }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Domain ID returned by domain_claim or domain_owned.' },
        project_id: { type: 'string', description: 'Project to bind the domain to.' },
        host: { type: 'string', description: 'Entry point on the domain. "apex" | "www" | a single subdomain label. Defaults to "apex".' },
      },
      required: ['id', 'project_id'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    group: 'domains',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', `/v1/domains/${encodeURIComponent(String(args.id))}/attach`, authHeader, {
          project_id: args.project_id,
          host: args.host,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'domain_detach',
    description: 'Release the project binding on a claimed domain without giving up the claim. The domain stays in your `domain_owned` list and can be re-attached to any project without re-verifying ownership.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Domain ID returned by domain_claim or domain_owned.' },
      },
      required: ['id'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    group: 'domains',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', `/v1/domains/${encodeURIComponent(String(args.id))}/detach`, authHeader, {});
        return result;

      }
    },
  },
  {
    definition: {
    name: 'domain_enable_email',
    description: '**Destructive.** Turn on inbox routing for a claimed domain — replaces any existing MX records on the domain. Skip this if the user already receives email at the domain via Gmail / Workspace / their own server. Required before `inbox_create_address` will work on this domain.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Domain ID returned by domain_claim or domain_owned.' },
      },
      required: ['id'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    group: 'domains',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', `/v1/domains/${encodeURIComponent(String(args.id))}/enable-email`, authHeader, {});
        return result;

      }
    },
  },
  {
    definition: {
    name: 'domain_publish',
    description: `Recovery action for a claimed domain that isn't resolving. Re-asserts the apex + www records and the platform routing — idempotent, so safe to run any time. Use this when \`domain_owned\` shows \`claim_status: active\` and \`zone_status: active\` but \`dig <domain>\` returns NXDOMAIN or empty answers. \`domain_claim\` already runs this once; this is the manual unstick path for the rare case where the initial publish had a partial failure.

Inbox routing is only re-asserted if it was already enabled on this domain — \`domain_publish\` will never silently overwrite a user's MX records.`,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Domain ID returned by domain_claim or domain_owned.' },
      },
      required: ['id'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    group: 'domains',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', `/v1/domains/${encodeURIComponent(String(args.id))}/publish`, authHeader, {});
        return result;

      }
    },
  },
  // ── search ─────────────────────────────────────────────
  {
    definition: {
    name: 'search_index_create',
    description: `**Adding natural-language search to FAQs, docs, products, or other app content?** Create the named search index once, then feed it with \`search_upsert\`. Indexes hold items you can later find by keyword or meaning. Idempotent — returns the existing index if one already has this name.

**Example:**

\`\`\`json
{ "project_id": "my-saas", "name": "help-articles" }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        name: { type: 'string', description: 'Index name (1-64 chars, letters/numbers/underscore/hyphen).' },
      },
      required: ['project_id', 'name'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    group: 'search',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', '/v1/search/index', authHeader, {
          project_id: args.project_id,
          name: args.name,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'search_index_list',
    description: 'List all search indexes for a project.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
      },
      required: ['project_id'],
    },
  },
    annotations: { readOnlyHint: true, idempotentHint: true },
    group: 'search',
    core: true,
    coreRank: 100,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const params = new URLSearchParams();
        params.set('project_id', args.project_id as string);
        result = await callAPI(fetcher, 'GET', `/v1/search/index?${params}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'search_delete',
    description: `Delete from a search index. Pass \`ids\` to remove specific items; omit \`ids\` to delete the entire index and all its items.

**Example:**

\`\`\`json
// Remove specific items:
{ "project_id": "my-saas", "index": "help-articles", "ids": ["art-1", "art-2"] }

// Delete the whole index:
{ "project_id": "my-saas", "index": "help-articles" }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        index: { type: 'string', description: 'Index name.' },
        ids: { type: 'string', description: 'Optional. JSON array of item ids to remove. Example: \'["p1","p2"]\'. Omit to delete the entire index.' },
      },
      required: ['project_id', 'index'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    group: 'search',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const ids = parseJsonArg(args.ids, 'ids');
        const hasIds = Array.isArray(ids) ? ids.length > 0 : ids !== undefined && ids !== null;
        if (hasIds) {
          // Remove specific items from the index
          result = await callAPI(fetcher, 'POST', '/v1/search/remove', authHeader, {
            project_id: args.project_id,
            index: args.index,
            ids,
          });
        } else {
          // Delete the entire index and all its items
          const params = new URLSearchParams();
          params.set('project_id', args.project_id as string);
          const name = encodeURIComponent(args.index as string);
          result = await callAPI(fetcher, 'DELETE', `/v1/search/index/${name}?${params}`, authHeader);
        }
        return result;

      }
    },
  },
  {
    definition: {
    name: 'search_upsert',
    description: `**Did searchable content get created or edited?** Call \`search_upsert\` with its stable \`id\` and \`content\`; the platform creates the index if needed and generates embeddings for you. Reusing an id updates that item. Pass up to 100 items per call.

**Example:**

\`\`\`json
{
  "project_id": "my-saas",
  "index": "help-articles",
  "items": [
    { "id": "art-1", "content": "How to reset your password: Go to Settings > Security > Reset Password...", "metadata": { "category": "account" } },
    { "id": "art-2", "content": "Billing FAQ: We charge monthly on the date you signed up...", "metadata": { "category": "billing" } }
  ]
}
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        index: { type: 'string', description: 'Index name. Auto-created if it does not exist.' },
        items: {
          type: ['string', 'array'],
          description:
            'Array (or JSON-stringified array) of { id: string, content: string, metadata?: object }. Example: \'[{"id":"p1","content":"red cotton t-shirt","metadata":{"price":29}}]\'',
        },
      },
      required: ['project_id', 'index', 'items'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    group: 'search',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const items = parseJsonArg(args.items, 'items');
        result = await callAPI(fetcher, 'POST', '/v1/search/upsert', authHeader, {
          project_id: args.project_id,
          index: args.index,
          items,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'search_query',
    description: `Search an index. The default \`hybrid\` ranking fuses exact-keyword matching (typo-tolerant, great for SKUs, usernames, IDs, and any literal term) with meaning-based matching — so a document containing the query words ranks first, AND conceptually related documents are still found. Each result has its original content and metadata, a relevance score, a \`snippet\` that highlights the match (wrapped in <mark>…</mark>), and a \`signals\` breakdown of which signal(s) matched. Page through results with \`offset\` — the response carries a \`page\` object with \`total\` and \`has_more\`.

**Example:**

\`\`\`json
{
  "project_id": "my-saas",
  "index": "help-articles",
  "query": "reset password",
  "limit": 5
}
// Returns: {
//   "results": [{ "id": "art-1", "content": "How to reset your password...", "metadata": { "category": "account" }, "score": 0.031, "snippet": "How to <mark>reset</mark> your <mark>password</mark>...", "signals": { "lexical": -3.1, "semantic": 0.92 } }, ...],
//   "page": { "offset": 0, "limit": 5, "total": 12, "has_more": true },
//   "mode": "hybrid"
// }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        index: { type: 'string', description: 'Index name to search.' },
        query: { type: 'string', description: 'Query text — keywords and/or natural language.' },
        limit: { type: 'number', description: 'Max results per page (default 10, max 100).' },
        offset: { type: 'number', description: 'Skip this many results for pagination (default 0). Use with limit to page; the response includes page.total and page.has_more. Applies to hybrid and lexical modes.' },
        mode: { type: 'string', enum: ['hybrid', 'semantic', 'lexical'], description: "Ranking mode: 'hybrid' (default — keyword + meaning, fused), 'semantic' (meaning only), or 'lexical' (keyword only, with typo-tolerant prefix matching)." },
      },
      required: ['project_id', 'index', 'query'],
    },
  },
    annotations: { readOnlyHint: true, idempotentHint: true },
    group: 'search',
    core: true,
    coreRank: 58,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', '/v1/search/query', authHeader, {
          project_id: args.project_id,
          index: args.index,
          query: args.query,
          limit: args.limit,
          offset: args.offset,
          mode: args.mode,
        });
        return result;

      }
    },
  },
  // ── ai ─────────────────────────────────────────────
  {
    definition: {
    name: 'ai_transcribe',
    description: `**Accepting voice notes, meeting recordings, interviews, or audio uploads?** \`ai_transcribe\` turns audio into text from base64 bytes or a public URL, returning the transcription, duration, and cost.

Rates by plan at /v1/pricing. Activation required: \`ai_transcribe\`.

**Example:**

\`\`\`json
{
  "project_id": "my-saas",
  "audio_url": "https://my-saas.somewhere.site/uploads/recording.mp3"
}
// Returns: { "text": "Hello, this is a test recording...", "duration_seconds": 45, "cost": { "total": "$0.000394" } }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        audio: { type: 'string', description: 'Base64-encoded audio bytes (mp3/wav/flac/m4a). Use audio_url instead for remote files. Max 25MB.' },
        audio_url: { type: 'string', description: 'Public http(s) URL to the audio file. No private networks.' },
        model: { type: 'string', description: 'Optional. @cf/openai/whisper-large-v3-turbo (default), @cf/openai/whisper, @cf/openai/whisper-tiny-en.' },
      },
      required: ['project_id'],
    },
  },
    annotations: { readOnlyHint: false, openWorldHint: true },
    group: 'ai',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', '/v1/ai/transcribe', authHeader, {
          project_id: args.project_id,
          audio: args.audio,
          audio_url: args.audio_url,
          model: args.model,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'ai_tts',
    description: `Synthesize speech from text. Returns audio bytes as base64, or saves to a storage path.

Omit \`model\` and you get the free default voice — no activation, no bill, nothing to choose.

- \`hexgrad/Kokoro-82M\` (default) — free: 54 natural voices across 9 languages (American/British English, Mandarin, Japanese, Hindi, Spanish, Brazilian Portuguese, Italian, French). Pass a voice id as \`voice\` (default af_bella); the full id list, grouped by language, is in ai_catalog. First 100,000 chars/month free; rates beyond that by plan at /v1/pricing. Cap 15,000 chars.

Activation required: \`ai_tts\`.

**Example:**

\`\`\`json
{
  "project_id": "my-saas",
  "model": "hexgrad/Kokoro-82M",
  "voice": "af_bella",
  "text": "Welcome to our app! Let's get started.",
  "storage": "/audio/welcome.mp3"
}
// Returns: { "storage_path": "/audio/welcome.mp3", "size_bytes": 40320, "cost": { "total": "$0.00" } }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        text: { type: 'string', description: 'Text to speak. Max 15,000 chars.' },
        model: { type: 'string', description: 'Optional. Leave it out for the free default voice (hexgrad/Kokoro-82M). Call ai_catalog for every model that can serve today.' },
        voice: { type: 'string', description: 'Voice id, e.g. af_bella (default), am_michael, bm_george — full list grouped by language in ai_catalog.' },
        lang: { type: 'string', description: 'Language code (en, es, fr, zh, ja, ko, …). Default en.' },
        storage: { type: 'string', description: 'Optional storage path like /audio/greeting.mp3. When set, saves to the project filesystem.' },
      },
      required: ['project_id', 'text'],
    },
  },
    annotations: { readOnlyHint: false, openWorldHint: true },
    group: 'ai',
    core: true,
    coreRank: 90,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        // When `storage` is set the API returns JSON and we pass through.
        // Without storage it returns raw audio bytes which we base64-encode
        // for MCP transport.
        if (args.storage) {
          result = await callAPI(fetcher, 'POST', '/v1/ai/tts', authHeader, {
            project_id: args.project_id,
            text: args.text,
            model: args.model,
            voice: args.voice,
            lang: args.lang,
            storage: args.storage,
          });
        } else {
          const resp = await fetcher.fetch('https://api-internal/v1/ai/tts', {
            method: 'POST',
            headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              project_id: args.project_id,
              text: args.text,
              model: args.model,
              voice: args.voice,
              lang: args.lang,
            }),
          });
          const contentType = resp.headers.get('Content-Type') || '';
          if (contentType.includes('application/json')) {
            result = { status: resp.status, data: await resp.json() };
          } else {
            const buf = new Uint8Array(await resp.arrayBuffer());
            let binary = '';
            for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
            result = {
              status: resp.status,
              data: {
                content_type: contentType,
                size_bytes: buf.byteLength,
                cost_cents: Number(resp.headers.get('X-AI-Cost-Cents')) || null,
                base64: btoa(binary),
              },
            };
          }
        }
        return result;

      }
    },
  },
  {
    definition: {
    name: 'ai_generate_image',
    description: `**Need a hero, product image, social card, thumbnail, or draft visual?** \`ai_generate_image\` creates it from a text prompt without wiring a separate image provider. Returns image bytes (base64) or a stored path plus cost.

One managed model: \`@cf/black-forest-labs/flux-1-schnell\` (default) — fast, billed per tile and per step at the rate in /v1/pricing. Earlier premium managed models are retired; a request for one is refused with a message naming the default. For any other model, bring your own provider: store the vendor's key as a project secret and call the vendor from your own function; there is no managed AI charge on that path (the vendor bills you directly; your function's ordinary platform usage still applies).

**Inline rendering:** Pass \`inline: true\` to get the image as an MCP image content block alongside the JSON result. Claude.ai (and any MCP client that respects image content blocks) renders it directly in the conversation. Default \`inline: false\` keeps the response lightweight (base64 only when not stored).

**Example:**

\`\`\`json
{
  "project_id": "my-saas",
  "prompt": "A minimalist logo for a fitness app, clean lines, blue and white",
  "inline": true
}
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        prompt: { type: 'string', description: 'Image description (max 2000 chars).' },
        model: { type: 'string', description: 'Optional. @cf/black-forest-labs/flux-1-schnell (default and only managed option); retired ids are refused with a typed error.' },
        width: { type: 'number', description: 'Ignored by the managed model: output is a fixed 1024×1024 square.' },
        height: { type: 'number', description: 'Ignored by the managed model: output is a fixed 1024×1024 square.' },
        steps: { type: 'number', description: 'Inference steps, 1-8 (default 4).' },
        storage: { type: 'string', description: 'Optional storage path like /images/hero.png. When set, saves to the project filesystem.' },
        inline: { type: 'boolean', description: 'When true, return the image as an MCP image content block so clients (Claude.ai, etc.) render it inline. Default false.' },
      },
      required: ['project_id', 'prompt'],
    },
  },
    annotations: { title: 'Generate an image with AI', readOnlyHint: false, openWorldHint: true },
    group: 'ai',
    core: true,
    coreRank: 53,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        if (args.storage && !args.inline) {
          // Save to project filesystem, return URL only.
          result = await callAPI(fetcher, 'POST', '/v1/ai/generate-image', authHeader, {
            project_id: args.project_id,
            prompt: args.prompt,
            model: args.model,
            width: args.width,
            height: args.height,
            steps: args.steps,
            storage: args.storage,
          });
        } else {
          // Pull raw bytes. With inline=true we also stash them as
          // _inlineImage so the response wrapper emits an MCP image
          // content block for in-conversation rendering.
          const resp = await fetcher.fetch('https://api-internal/v1/ai/generate-image', {
            method: 'POST',
            headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              project_id: args.project_id,
              prompt: args.prompt,
              model: args.model,
              width: args.width,
              height: args.height,
              steps: args.steps,
              ...(args.storage ? { storage: args.storage } : {}),
            }),
          });
          const contentType = resp.headers.get('Content-Type') || '';
          if (contentType.includes('application/json')) {
            result = { status: resp.status, data: await resp.json() };
          } else {
            const buf = new Uint8Array(await resp.arrayBuffer());
            let binary = '';
            for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
            const b64 = btoa(binary);
            result = {
              status: resp.status,
              data: {
                content_type: contentType,
                size_bytes: buf.byteLength,
                cost_cents: Number(resp.headers.get('X-AI-Cost-Cents')) || null,
                base64: args.inline ? '<sent as image content block>' : b64,
              },
              ...(args.inline ? { _inlineImage: { mimeType: contentType || 'image/png', data: b64 } } : {}),
            };
          }
        }
        return result;

      }
    },
  },
  {
    definition: {
    name: 'ai_remove_background',
    description: `Background removal is not offered as a managed capability: this call is refused with a typed error before anything runs, and nothing is charged. To remove backgrounds, bring your own provider — store its key as a project secret and call it from your own function. A generative image model is not a substitute for background removal, so the platform does not silently swap one in. Kept so older callers get a typed refusal rather than an unknown tool.`,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        image_url: { type: 'string', description: 'Publicly fetchable http(s) URL to the source image.' },
        model: { type: 'string', description: 'Ignored: no managed background-removal model is offered.' },
        storage: { type: 'string', description: 'Optional storage path like /images/cutout.png. When set, saves to the project filesystem.' },
        inline: { type: 'boolean', description: 'When true, return the cutout as an MCP image content block so clients render it inline. Default false.' },
      },
      required: ['project_id', 'image_url'],
    },
  },
    annotations: { readOnlyHint: false, openWorldHint: true },
    group: 'ai',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        if (args.storage && !args.inline) {
          result = await callAPI(fetcher, 'POST', '/v1/ai/remove-background', authHeader, {
            project_id: args.project_id,
            image_url: args.image_url,
            model: args.model,
            storage: args.storage,
          });
        } else {
          const resp = await fetcher.fetch('https://api-internal/v1/ai/remove-background', {
            method: 'POST',
            headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              project_id: args.project_id,
              image_url: args.image_url,
              model: args.model,
              ...(args.storage ? { storage: args.storage } : {}),
            }),
          });
          const contentType = resp.headers.get('Content-Type') || '';
          if (contentType.includes('application/json')) {
            result = { status: resp.status, data: await resp.json() };
          } else {
            const buf = new Uint8Array(await resp.arrayBuffer());
            let binary = '';
            for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
            const b64 = btoa(binary);
            result = {
              status: resp.status,
              data: {
                content_type: contentType,
                size_bytes: buf.byteLength,
                cost_cents: Number(resp.headers.get('X-AI-Cost-Cents')) || null,
                base64: args.inline ? '<sent as image content block>' : b64,
              },
              ...(args.inline ? { _inlineImage: { mimeType: contentType || 'image/png', data: b64 } } : {}),
            };
          }
        }
        return result;

      }
    },
  },
  {
    definition: {
    name: 'ai_catalog',
    description: `List every AI model the platform offers — feature, model id, provider, pricing string, and whether it's free for Builders. Paid-model rates vary by plan; see /v1/pricing. Use this to discover what's available before picking a model for \`ai_complete\`, \`ai_tts\`, \`ai_generate_image\`, \`ai_remove_background\`, or embeddings.

Read-only. No activation needed.

**Example:**

\`\`\`json
{}
// Returns: { "free_tier": { ... }, "markup_rate": 0.05, "models": [{ "feature": "tts", "model": "hexgrad/Kokoro-82M", "provider": "deepinfra", ... }, ...] }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
    annotations: { title: 'List available AI models', readOnlyHint: true, idempotentHint: true },
    group: 'ai',
    core: true,
    coreRank: 89,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'GET', '/v1/ai/catalog', authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'ai_usage',
    description: `Return this month's AI spend broken down by feature (transcribe, tts, generate_image, complete). Read-only; no charges.

**Example:**

\`\`\`json
{}
// Returns: { "complete": { "calls": 142, "cost": "$0.23" }, "tts": { "calls": 12, "cost": "$0.003" }, ... }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
    annotations: { readOnlyHint: true, idempotentHint: true },
    group: 'ai',
    core: true,
    coreRank: 91,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'GET', '/v1/ai/usage', authHeader);
        return result;

      }
    },
  },
  // ── stock_photos ─────────────────────────────────────────────
  {
    definition: {
    name: 'stock_photos_search',
    description: `Search a free library of royalty-free stock photos by keyword. Use when the user wants real photographs (not AI-generated). Free — no activation required.

Each photo includes a photographer name and source URL. Display attribution somewhere on the page when you use the image.

**Example:**

\`\`\`json
{ "project_id": "my-app", "query": "mountain sunset", "per_page": 5 }
// Returns: [{ "url": "https://...", "width": 4000, "height": 2667, "photographer": "Jane Doe", "source_url": "https://..." }, ...]
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, slug, or 'default'. Slug and subdomain are resolved server-side — you don't need to look up the UUID. Searches are attributed to this project's usage." },
        query: { type: 'string', description: 'Search text, e.g. "mountain sunset" or "office workspace".' },
        per_page: { type: 'number', description: '1-80, default 15.' },
        page: { type: 'number', description: '1-based page number, default 1.' },
        orientation: { type: 'string', description: 'landscape | portrait | square.' },
        size: { type: 'string', description: 'large (24MP+) | medium (12MP+) | small (4MP+).' },
        color: { type: 'string', description: 'red, orange, yellow, green, turquoise, blue, violet, pink, brown, black, gray, white, or a hex like "ff5733".' },
      },
      required: ['project_id', 'query'],
    },
  },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    group: 'stock_photos',
    core: true,
    coreRank: 67,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        // project_id is REQUIRED by /v1/stock/photos (2026-05-25 audit §7 —
        // attribution + throttling). The schema omitted it and this handler
        // dropped it, making the tool uncallable (pfb_c1f509cd7bfd).
        const params = new URLSearchParams({
          project_id: String(args.project_id),
          query: String(args.query),
        });
        if (args.per_page !== undefined) params.set('per_page', String(args.per_page));
        if (args.page !== undefined) params.set('page', String(args.page));
        if (args.orientation) params.set('orientation', String(args.orientation));
        if (args.size) params.set('size', String(args.size));
        if (args.color) params.set('color', String(args.color));
        result = await callAPI(fetcher, 'GET', `/v1/stock/photos?${params.toString()}`, authHeader);
        return result;

      }
    },
  },
  // ── browser: the ONE capture surface ───────────────────────────────
  {
    definition: {
    name: 'browser',
    description: `SEE, inspect, DRIVE and CAPTURE any web page — your app's EYES for perception, a VERIFY harness for QA, AND the one way to turn a page into a picture or a PDF. One call returns a structured health SIGNAL (console errors, page errors, failed network requests), not a raw image to vision-parse; a bad step or wrong shape hands back a correcting error.

**This is the ONE capture surface.** \`render_screenshot\` and \`render_pdf\` are deprecated aliases of this tool — they still work, but everything they could do lives here, and things neither could do compose freely: a full-page **webp** of a logged-in view saved to a path you choose, or a **PDF invoice**, out of the same call.

**Choose the output, not the tool** — \`capture: { "as": "png" | "jpeg" | "webp" | "pdf" }\`. Printing is an output format, not a different operation:

\`\`\`json
{ "project_id": "my-saas", "url": "https://my-saas.somewhere.site/pricing",
  "capture": { "as": "webp", "full_page": true }, "storage": "/renders/pricing.webp" }
\`\`\`

\`\`\`json
{ "project_id": "my-saas", "html": "<h1>Invoice #1234</h1><p>Total: $49.99</p>",
  "capture": { "as": "pdf", "paper": "A4" }, "storage": "/invoices/inv-1234.pdf" }
\`\`\`

**Pick your mode:**
- **EYES (perception)** — NO \`project_id\`, any public \`url\` (e.g. \`{ "url": "https://example.com" }\`): look at / inspect / screenshot ANY page. Ephemeral output — the screenshot returns **inline** (auto-downscaled to fit) by default, or pass \`store:true\` for a short-TTL signed scratch URL (\`screenshots[].scratch_url\`, never durable project storage). Lean payload by default; add \`include:["network","dom"]\` for the full network table + clickable-element map. No auth, no origin-lock — point it at anything.
- **VERIFY (project QA)** — pass \`project_id\`: drive + assert YOUR deployed app. Add \`actions\` to click / fill / assert a flow, \`auth:{ "user_id": "…" }\` to run it as a logged-in user (1h audited impersonation), and screenshots store durably to the project filesystem (\`screenshots[].fs_path\`). Origin-locked — a \`url\` must be on the project's own origin.

Same engine and the same signals-first report either way. Each completed page run also returns one \`accessibility_layout\` line for WCAG AA text contrast, horizontal overflow, and tap targets below 44×44px. Those findings are advisory and never change \`passed\`.

- **Omit \`actions\`** → you get a LEAN health snapshot by default: console errors, page errors, failed network requests (the 4xx/5xx + dropped calls — the real signal), the rendered page text (\`rendered_text\` — grep-able structured text beats a screenshot ~80% of the time), \`final_url\`, and a small screenshot. The heavy bits are opt-in via \`include\`: pass \`include:["network"]\` for the full per-request \`network\` table (method/status/timing) + redirect chain, and/or \`include:["dom"]\` for the interactive-element map (\`dom_outline\` — every button/input/link with a selector) + the testid handle map. This is the quick "what does my app look like and is it healthy" call (it replaces a standalone screenshot). That page screenshot comes back **inline as an MCP image content block by default** (it renders directly in the conversation) while its file path stays in the output as the durable artifact; pass \`inline:false\` to skip the inline image and keep only the path. An oversized capture on a tall/heavy page is auto-downscaled to fit inline — a no-\`project_id\` call still returns a real image in one shot.
- **Add \`actions\`** → use the same concise action-sequence JSON as the CLI: \`{click}\`, \`{fill,value}\`, \`{upload,file,name?}\`, \`{select,value}\`, \`{wait}\`, \`{expect}\`, \`{screenshot}\`, and \`{eval}\`. Every item reports ok/fail with a reason, and the first failure stops the sequence.
- Existing expanded \`steps\` remain accepted for older callers; new flows use the shared \`actions\` shape above.
- **Pass \`url\` with NO \`project_id\`** → capture/inspect ANY public third-party page (e.g. \`{ "url": "https://example.com" }\`), not just your own app. (When you DO pass \`project_id\`, \`url\` is scoped to that project's origin.) The screenshot comes back inline by default; add \`store:true\` to instead get a short-lived, auto-expiring signed URL to the full-res image (\`screenshots[].scratch_url\`) — handy for a big external capture you'd rather link than inline. It's kept in an ephemeral scratch store and never touches project storage.
- **Pass \`html\`** → render a raw HTML snippet straight to an image (e.g. an OG card). No page navigation, no steps; returns the image inline, or the stored file path when \`storage\` is set. This is render_screenshot's html niche, folded in.
- **Pass \`extract:"markdown"\`** (or \`include:["markdown"]\`) → READ the page as clean MARKDOWN (headings, links, lists, main content) in the \`markdown\` field, instead of vision-parsing the screenshot. The cheapest way to actually read a page's content. (The plain rendered text is always in \`rendered_text\`.)
- **Pass \`session_id\`** → keep ONE live browser page alive ACROSS calls (persistent session). Navigate in call 1; in call 2 (same session_id) wait for a 20s stream and screenshot the SAME page — cookies, current URL, and the in-flight stream all survive. The call returns \`session_id\` + \`session_expires_at\`; a reconnect skips the initial navigation (the page is where you left it — use a \`goto\` step to move). Sessions are yours only, capped per developer, and idle out fast (~3 min, ~10 min hard cap); an expired one transparently restarts (\`session_note\`). OMIT it for the default fresh-per-call browser (cache-safe — use a session only when you need cross-call state).

**Shell-having agents:** use \`somewhere browser\` for navigation, waits, evaluation, screenshots, and flow steps. Use this MCP tool when no shell exists or when an inline image/result is materially more useful.

Use it to check what your UI looks like AND whether it works — clicks land, the form submits, the modal opens — and to catch the 500-ing API call a screenshot alone would hide. (run_code proves a function's backend; \`browser\` proves the rendered UI.) Signals come FIRST: \`passed\` reflects step outcomes only — always read console_errors / page_errors / failed_requests too (a 500 shows there even when every step "passes").

You wrote the DOM, so target elements directly by selector — don't guess at pixel coordinates.

**Shared action-sequence JSON** (preferred; the CLI's \`--actions\` file uses this exact array):

\`\`\`json
"actions": [
  { "fill": "#email", "value": "a@b.co" },
  { "upload": "#avatar", "file": "data:image/png;base64,iVBORw0KGgo=", "name": "avatar.png" },
  { "select": "#plan", "value": "pro" },
  { "click": "button[type=submit]" },
  { "wait": ".dashboard" },
  { "expect": { "selector": ".welcome", "text": "Hi", "visible": true, "count": 1 } },
  { "screenshot": "after" },
  { "eval": "document.title" }
]
\`\`\`

\`wait\` is a CSS selector string or a millisecond number. \`expect\` requires a selector and at least one of \`text\` (substring), \`visible\` (boolean), or \`count\` (exact non-negative integer); conditions may be combined. A failed action stops the sequence and names its zero-based action index.

Expanded \`steps\` remain runtime-compatible for older callers, but are not a
second authoring contract. Use \`actions\` for new flows. A failed action aborts
the run while preserving console, network, and screenshot state.

**Examples:**

\`\`\`json
// See + inspect — screenshot, signals, and the clickable-element map, no actions:
{ "project_id": "my-saas" }
\`\`\`

\`\`\`json
// Drive a logged-in flow as a specific user (impersonation, 1h, audited):
{ "project_id": "my-saas", "auth": { "user_id": "usr_123" }, "actions": [
  { "wait": "h1" },
  { "expect": { "selector": "h1", "text": "Welcome" } }
] }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project to look at / test (UUID, subdomain, slug, or 'default'). Resolved server-side; opens the project's deployed root by default. Recommended — required for screenshots + auth. Omit it (with a `url`) to inspect an arbitrary third-party page; omit it (with `html`) to render a snippet that isn't stored." },
        url: { type: 'string', description: 'Page URL to open (http/https, no private networks). WITHOUT project_id this can be ANY public third-party page (e.g. https://example.com); WITH project_id it must be on the project\'s own origin. A *.somewhere.site url resolves to your project automatically.' },
        html: { type: 'string', description: 'Raw HTML to render straight to an image (up to 1MB), instead of navigating a url. No steps/auth/DOM-map — just the rendered picture (e.g. an OG card). Returns the image inline (base64), or the stored file path when `storage` is set (storage requires project_id). Honours the full `capture` bag — including `as: "pdf"` (an invoice/receipt/certificate from an HTML string), `full_page` and `quality` — plus width/height/wait_for. An html snippet has no origin, so steps, auth and cookies do not apply to it.' },
        actions: {
          type: 'array',
          maxItems: 30,
          description: 'Preferred concise action sequence, shared exactly with the CLI --actions JSON file. Each item has one action key: {click:selector}, {fill:selector,value}, {upload:selector,file:data-url-or-base64,name?}, {select:selector,value}, {wait:selector|ms}, {expect:{selector,text?|value?|visible?|count?}}, {screenshot:label}, or {eval:js}. The CLI additionally resolves a local path in upload.file before calling the hosted API. Always stops on the first failure; every result includes ok and an error reason when false.',
          items: { type: 'object' },
        },
        steps: { type: 'array', description: 'Legacy ordered step objects. Each step has an action plus that action fields; add frame to target an iframe. Omit or pass [] to inspect without driving. Ignored when html is set.', items: { type: 'object' } },
        expect_requests: {
          type: 'array',
          maxItems: 30,
          description: 'Expected request outcomes. An observed matching path and status is a PASS and is excluded from failed_requests and failed-resource console errors. A different 4xx/5xx or a missing expected request still fails.',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'URL substring to match, normally an app path such as /api/tasks.' },
              status: { type: 'number', description: 'Expected HTTP status from 100 through 599.' },
            },
            required: ['path', 'status'],
          },
        },
        visible_only: { type: 'boolean', description: 'When true, dom_outline omits hidden controls. Every returned node still carries visible, plus disabled when applicable.' },
        include: { type: 'array', description: 'Opt-in heavy sections for a no-steps inspect call (omitted by default to keep the payload lean). Values: "network" (the full per-request network table — method/status/timing — plus the redirect chain), "dom" (dom_outline — every interactive element with a selector — plus the testid handle map), and/or "markdown" (the page extracted as clean MARKDOWN — headings, links, lists — so you read structured text instead of vision-parsing the screenshot). Example: ["network","dom","markdown"]. console_errors / page_errors / failed_requests / rendered_text are ALWAYS returned regardless. "dom" works on a steps run too — the map is read after the last step, so it describes the page your flow left behind; "network" and "markdown" apply to a no-steps inspect call.', items: { type: 'string', enum: ['network', 'dom', 'markdown'] } },
        extract: { type: 'string', description: 'Structured extraction shortcut for a no-steps inspect call (same as include:["markdown"]). "markdown" (or true) → return the page as clean MARKDOWN in the `markdown` field — headings, links, lists, emphasis, main content only — the cheapest way to READ a page vs vision-parsing a screenshot or grepping rendered_text. "text" is a no-op (the plain rendered text is already returned as `rendered_text`). Bounded.', enum: ['markdown', 'text'] },
        session_id: { type: 'string', description: 'Opt-in PERSISTENT SESSION handle (1–64 chars: letters/digits/dot/dash/underscore, e.g. "checkout-flow"). Pass the SAME session_id across calls to keep ONE live browser page alive between them — navigate in call 1, then in call 2 wait for a slow stream and screenshot, all against the same page (cookies, current URL, in-flight stream preserved). Call 1 launches + records the session and returns session_id + session_expires_at; later calls RECONNECT (a reconnect skips the initial navigation — the page is where you left it). The session is yours only (scoped to your key), capped by your account plan, and idles out fast (~3 min) with a ~10 min hard cap; if it has expired the call transparently starts fresh (session_note: "session expired, started fresh"). OMIT for the default: every call is a fresh, cache-safe browser (recommended unless you specifically need cross-call state).' },
        help: { type: 'boolean', description: 'Return the full action reference (every action + its fields, the `frame` targeting note, the wait/eval semantics) WITHOUT running anything. Use this first if you\'re unsure of the step shape.' },
        viewport: { type: ['string', 'object'], description: "The LAYOUT viewport — real geometry, not a preset-only enum. 'desktop' (1280×800, default), 'mobile' (390×844), or an explicit { \"width\": 1600, \"height\": 1200 } (width 100–3840, height 100–2160). Use this to test a responsive breakpoint. NOTE: this is the page size; `capture.width` only shrinks the resulting IMAGE." },
        inline: { type: 'boolean', description: 'Return the screenshot inline as an MCP image content block so it renders directly in the conversation. Default true. In page/steps mode the inline image is the "just look" page shot only (steps screenshots stay as stored file paths); in `html` mode it is the rendered snippet. The file path is always kept in the output as the durable artifact. An image whose base64 exceeds ~750KB is not inlined. Pass false to skip the inline image entirely.' },
        store: { type: 'boolean', description: 'No-`project_id` ("eyes" mode) only: persist the FULL-RES screenshot to an ephemeral, self-expiring scratch store and return a short-lived signed URL (screenshots[].scratch_url + scratch_expires_at, ~1h, auto-deleted after a couple of days) INSTEAD of the inline base64. Use this for a big external-page capture you want as a link rather than a large inline blob. It never touches any project storage. Ignored WITH a project_id (those screenshots save to the project filesystem). Default off (inline unchanged).' },
        capture: { type: 'object', description: 'What to capture and how — the ONE output knob. Fields: `as` ("png" | "jpeg" | "webp" | **"pdf"** — pdf PRINTS the page, no separate tool), `full_page` (capture the whole scrollable page), `width` (target OUTPUT image width in px, default 800 — shrinks the image, never upscales, and does NOT change the layout: use `viewport` for that), `quality` (1–100, jpeg/webp only, default 70), and for pdf: `paper` ("A4" | "A3" | "Letter" | "Legal" | "Tabloid", default Letter), `landscape`, `print_background` (default true). Small + cheap by default (~800px JPEG q70) so vision-token cost stays low; override when you need pixel precision, e.g. { "width": 1280, "as": "png" }. Applies to the no-steps page capture and any screenshot step.' },
        screenshot: { type: 'object', description: 'Deprecated spelling of `capture` (same fields; `format` is accepted as an alias of `as`). Kept working for existing callers — new code should use `capture`.' },
        auth: { type: 'object', description: 'Drive as a logged-in user: { "user_id": "..." }. Mints a 1-hour impersonation session for that app user (audited) and injects it before navigation. Requires a project. Ignored when `html` is set.' },
        continue_on_failure: { type: 'boolean', description: 'Run every step even after one fails (default false: a failed step aborts but still returns captured signals).' },
        storage: { type: 'string', description: 'A project files path for THE capture — e.g. "/renders/hero.webp", "/og/card.png", "/invoices/inv-1234.pdf" (requires project_id). Works for a `url` capture, an `html` snippet, AND a `steps` run (there the capture is taken last, after the flow has put the page where you wanted it); the response returns the stored path. Omit it to get the image inline. Screenshots taken by `screenshot` STEPS keep their own /_browser_tests/ run directory — a steps run makes many labelled images and one path cannot name them all.' },
        local_storage: { type: 'object', description: 'Key→value strings seeded into localStorage before page load — this is how you drive a page with a session you ALREADY hold (as opposed to `auth`, which mints one for one of your app users). The standard auth client keeps its session under "sw_auth". Requires url + project_id, and is hard-scoped to that project\'s own origins so credentials are never sent to a third-party site. Values are never logged. 8KB total cap across local_storage/cookies/headers.' },
        cookies: { type: 'array', description: 'Array of { name, value } cookies set on the target origin before load. Same origin scoping and size cap as local_storage.', items: { type: 'object' } },
        headers: { type: 'object', description: 'Flat object of extra request headers (e.g. Authorization) sent with page requests. Same origin scoping and size cap as local_storage.' },
        width: { type: 'number', description: 'Legacy flat alias for viewport width (prefer `viewport: { width, height }`). With `html`, the snippet viewport width (default 1280).' },
        height: { type: 'number', description: 'Legacy flat alias for viewport height (prefer `viewport: { width, height }`). With `html`, the snippet viewport height (default 800).' },
        wait_for: { type: ['string', 'object'], description: 'A wait to satisfy BEFORE the capture. A CSS selector string, or ANY wait_for condition object: { "selector": "#status", "contains": "Ready" }, { "text": "All loaded" }, { "text_gone": "Loading…" }, { "settled": true }, { "network_idle": true }, { "url": "/dashboard" }, { "predicate": "window.__ready === true" } — with optional `timeout` / `idle_ms` / `frame`. Same condition engine as a wait_for step, so a rich wait now composes with `storage` in ONE call. On a `steps` run, sequence the wait as a step instead.' },
      },
      required: [],
    },
  },
    annotations: { title: 'Open a web page in a browser', readOnlyHint: false, openWorldHint: true },
    group: 'browser',
    core: true,
    coreRank: 50,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","connector"],
    protocol: { surfaceDescriptions: { connector: "Open a URL in a browser, optionally perform the supplied actions, and return page evidence. Actions can change the target website. See https://somewhere.tech/docs.txt (Verify before deploy) for how browser checks fit the Somewhere deployment contract." }, surfaceAnnotations: { connector: {"title":"Browser","readOnlyHint":false,"destructiveHint":true} },  },
    execute: async (runtime, args) => runCapture(runtime, args),
  },
  {
    definition: {
      name: 'site_verify',
      description: 'Run one browser flow across desktop and phone viewports and return one structured verdict: every named step, page/console/network health, expected request outcomes, both screenshot paths or URLs, and a non-blocking accessibility/layout line per viewport covering WCAG AA text contrast, horizontal overflow, and tap targets below 44×44px. Pass auth or an existing project-scoped session seed to run every viewport logged in. Omit actions for a default load/health/two-screenshot check. Each viewport uses a fresh browser that is closed inside the call, including on failure.',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'Owned project to verify. Recommended so screenshots are stored in project files.' },
          url: { type: 'string', description: 'Live URL to verify. With project_id it must be on that project origin; without project_id it may be any safe public URL and screenshots use short-lived links.' },
          actions: {
            type: 'array',
            maxItems: 30,
            description: 'The concise browser actions contract: {click}, {fill,value}, {upload,file,name?}, {select,value}, {wait}, {expect:{selector,text?|visible?|count?}}, {screenshot}, or {eval}. Stops at the first failed action and names its 1-based step in the verdict.',
            items: { type: 'object' },
          },
          auth: {
            type: 'object',
            description: 'Optional logged-in app user for every viewport: { user_id }. Requires an owned project target and mints an audited one-hour session.',
            properties: { user_id: { type: 'string' } },
            required: ['user_id'],
          },
          local_storage: { type: 'object', additionalProperties: { type: 'string' }, description: 'Optional existing session values seeded before navigation for every viewport. Requires url + project_id and is origin-scoped.' },
          cookies: { type: 'array', items: { type: 'object' }, description: 'Optional existing cookies seeded before navigation for every viewport. Requires url + project_id and is origin-scoped.' },
          headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Optional request headers seeded for every viewport. Requires url + project_id and is origin-scoped.' },
          expect_requests: {
            type: 'array',
            maxItems: 30,
            description: 'Expected request outcomes as { path, status }. A matching refusal is excluded from console/network failures; a missing or different status fails verification.',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                status: { type: 'number' },
              },
              required: ['path', 'status'],
            },
          },
          visible_only: { type: 'boolean', description: 'When true, action selectors match visible elements only. Defaults to false, matching the existing browser actions contract.' },
          viewports: {
            type: 'array',
            maxItems: 4,
            description: 'Viewport list. Defaults to ["desktop", "mobile"] (1280×800 and 390×844). Each item is a preset or { label, width, height }.',
            items: {
              oneOf: [
                { type: 'string', enum: ['desktop', 'mobile'] },
                {
                  type: 'object',
                  properties: {
                    label: { type: 'string' },
                    width: { type: 'number' },
                    height: { type: 'number' },
                  },
                  required: ['label', 'width', 'height'],
                },
              ],
            },
          },
        },
        required: [],
      },
    },
    annotations: { title: 'Verify a site in one browser flow', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    group: 'browser',
    core: true,
    coreRank: 109,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","connector"],
    protocol: {
      oauthScopes: ['mcp'],
      surfaceDescriptions: { connector: 'Run a browser verification flow on a website at desktop and phone sizes. Returns step results, page errors, network outcomes, and screenshots. Supplied actions can interact with the site and change application data; screenshots may be saved in project files. See https://somewhere.tech/docs.txt (Verify before deploy) for how verification fits the Somewhere deployment contract.' },
      surfaceAnnotations: { connector: { destructiveHint: true } },
    },
    execute: async (runtime, args) => runSiteVerify(runtime, args),
  },
  // ── capture aliases (deprecated, still callable) ───────────────────
  // These two are the OLD names for what `browser` now does. They are
  // `aliasOf` specs: registered and callable on every surface they list, but
  // NOT advertised in tools/list or the catalog — so an agent reading the
  // surface sees ONE capture tool, while every already-deployed caller of the
  // old names keeps working unchanged (rule 9: no consolidation may break
  // existing working code). Both run the SAME handler as `browser`; there is
  // no second implementation to drift.
  {
    definition: {
    name: 'render_screenshot',
    description: `DEPRECATED alias of \`browser\` — still works, but \`browser\` is the one capture surface and does strictly more: the same url/html capture plus png/jpeg/**webp**/**pdf** output, whole-page capture, real viewport geometry, rich waits (element text, DOM settled, network idle, URL change, JS predicate), step-driven flows, app-user impersonation, and the same \`storage\` path — with page health signals returned alongside.

Migrate by moving the format options into \`capture\`:

\`\`\`json
// was: render_screenshot({ url, format: "webp", full_page: true, storage: "/renders/hero.webp" })
{ "project_id": "my-saas", "url": "https://my-saas.somewhere.site",
  "capture": { "as": "webp", "full_page": true }, "storage": "/renders/hero.webp" }
\`\`\`

This tool's own behaviour is unchanged: with \`storage\` it returns the saved path, otherwise the image comes back inline as an MCP image content block (a small JPEG to keep vision-token cost low; \`inline:false\` returns the raw base64 instead).`,
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Page URL to screenshot (http/https, no private networks).' },
        html: { type: 'string', description: 'Raw HTML to render (up to 1MB). Use instead of url.' },
        inline: { type: 'boolean', description: 'Return the image inline as an MCP image content block. Default true (ignored when `storage` is set). An image whose base64 exceeds ~750KB is not inlined.' },
        width: { type: 'number', description: 'Viewport width in px (default 1280).' },
        height: { type: 'number', description: 'Viewport height in px (default 800).' },
        format: { type: 'string', description: 'png | jpeg | webp (default png). On `browser` this is `capture.as`.' },
        quality: { type: 'number', description: 'Quality 0-100 for jpeg/webp (default 80).' },
        full_page: { type: 'boolean', description: 'Capture the entire scrollable page.' },
        wait_for: { type: 'string', description: 'Optional CSS selector to wait for before capture.' },
        project_id: { type: 'string', description: 'Required when `storage` is set, and when seeding a session (it scopes the allowed origins).' },
        storage: { type: 'string', description: 'Optional storage path like /renders/hero.png. When set, the image is saved to the project filesystem and the response returns the path + size.' },
        local_storage: { type: 'object', description: 'Key→value strings seeded into localStorage before page load. Only allowed on the project\'s own origins; requires url + project_id. Values are never logged. 8KB total cap.' },
        cookies: { type: 'array', description: 'Array of {name, value} cookies set on the target origin before load.', items: { type: 'object' } },
        headers: { type: 'object', description: 'Flat object of extra request headers sent with page requests.' },
      },
      required: [],
    },
  },
    annotations: { readOnlyHint: false, openWorldHint: true },
    group: 'render',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    aliasOf: 'browser',
    execute: async (runtime, args) => runCapture(runtime, args),
  },
  {
    definition: {
    name: 'render_pdf',
    description: `DEPRECATED alias of \`browser\` — still works. Printing is now an OUTPUT of the one capture surface rather than a separate tool, so a PDF comes out of the same call as a screenshot:

\`\`\`json
// was: render_pdf({ html, format: "A4", storage: "/invoices/inv-1234.pdf" })
{ "project_id": "my-saas", "html": "<h1>Invoice #1234</h1><p>Total: $49.99</p>",
  "capture": { "as": "pdf", "paper": "A4" }, "storage": "/invoices/inv-1234.pdf" }
\`\`\`

Note the rename: the paper size is \`capture.paper\`, because \`format\` used to mean an image codec on one tool and a paper size on the other. This tool's own behaviour is unchanged — set \`storage\` to save the PDF in the project's files, otherwise it returns base64.`,
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Page URL to render (http/https, no private networks).' },
        html: { type: 'string', description: 'Raw HTML to render (up to 1MB). Use instead of url.' },
        format: { type: 'string', description: 'PAPER size: A4 | A3 | Letter | Legal | Tabloid (default Letter). On `browser` this is `capture.paper`.' },
        landscape: { type: 'boolean', description: 'Landscape orientation.' },
        print_background: { type: 'boolean', description: 'Render CSS backgrounds (default true).' },
        wait_for: { type: 'string', description: 'Optional CSS selector to wait for before capture.' },
        project_id: { type: 'string', description: 'Required when `storage` is set — the project that owns the storage path.' },
        storage: { type: 'string', description: 'Optional storage path like /renders/invoice.pdf. When set, the PDF is saved to the project filesystem and the response returns the path + size.' },
      },
      required: [],
    },
  },
    annotations: { readOnlyHint: false, openWorldHint: true },
    group: 'render',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    aliasOf: 'browser',
    execute: async (runtime, args) => runCapture(runtime, args),
  },
  // ── web ─────────────────────────────────────────────
  {
    definition: {
    name: 'web_scrape',
    description: `Fetch a public web page and return its content as clean markdown (default), with optional html, raw_html, links, and screenshot. Strips nav/footer/sidebar by default so you get the main article body.

Use this when you need to read a page an agent doesn't have local access to — docs, blog posts, marketing pages, articles. The response is page metadata (title, description, language) plus the requested formats. If the page served a bot-challenge interstitial ("verify you are human") instead of real content, the response carries \`challenge_detected: true\` — treat the content as unusable and don't retry in a loop.

**Screenshot format** (\`formats: ["screenshot"]\`) uses the same three-tier answer as \`browser\`: small enough (auto-downscaled) → inline \`data:image/...;base64,...\`; too large with no \`storage\` → a short-TTL \`scratch_url\` you don't have to clean up; \`storage: "/path.jpg"\` set → written permanently to project files, returned as \`{ storage_path, size_bytes }\`.

**Example:**

\`\`\`json
{ "project_id": "my-saas", "url": "https://docs.somewhere.tech/getting-started" }
// Returns: { "url": "...", "title": "Getting started", "markdown": "# Getting started\\n...", "status_code": 200 }
\`\`\`

\`\`\`json
{ "project_id": "my-saas", "url": "https://example.com", "formats": ["markdown", "links"], "only_main": false }
\`\`\`

\`\`\`json
{ "project_id": "my-saas", "url": "https://example.com", "formats": ["screenshot"], "storage": "/scratch/hero.jpg" }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        url: { type: 'string', description: 'http(s) URL to scrape, max 2048 chars.' },
        formats: { type: ['string', 'array'], description: 'Optional array (or JSON-stringified array) of formats to return. Allowed: markdown, html, rawHtml, links, screenshot. Default: ["markdown"]. Example: \'["markdown","links"]\'.' },
        only_main: { type: 'boolean', description: 'Strip nav/footer/sidebar to keep only the main article content. Default true.' },
        wait_for: { type: 'number', description: 'Optional milliseconds to wait for the page to settle before scraping (max 30000). Use for SPAs that hydrate after load.' },
        storage: { type: 'string', description: 'Only meaningful with formats:["screenshot"]. A project files path like "/scratch/hero.jpg" to write the shot permanently instead of the default inline/ephemeral behavior. Returns { storage_path, size_bytes } instead of the image bytes.' },
      },
      required: ['project_id', 'url'],
    },
  },
    annotations: { readOnlyHint: false, openWorldHint: true },
    group: 'web',
    core: true,
    coreRank: 102,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const formats = parseJsonArg(args.formats, 'formats');
        result = await callAPI(fetcher, 'POST', '/v1/web/scrape', authHeader, {
          project_id: args.project_id,
          url: args.url,
          ...(formats !== undefined ? { formats } : {}),
          ...(args.only_main !== undefined ? { only_main: args.only_main } : {}),
          ...(args.wait_for !== undefined ? { wait_for: Number(args.wait_for) } : {}),
          ...(args.storage !== undefined ? { storage: args.storage } : {}),
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'web_search',
    description: `Search the public web by keyword. Returns up to 20 results — each with url, title, description, age, and source — without page bodies. Pair with \`web_scrape\` when you want the full content of a specific result.

Use this when an agent needs to find current information it doesn't have — recent news, comparison pages, error references, library docs by name. Results are ranked by the upstream search index, not your project.

**Example:**

\`\`\`json
{ "project_id": "my-saas", "query": "react server components streaming", "count": 5 }
// Returns: { "query": "...", "results": [{ "url": "...", "title": "...", "description": "...", "age": "2 days ago", "source": "react.dev" }, ...], "count": 5 }
\`\`\`

\`\`\`json
{ "project_id": "my-saas", "query": "react server components", "freshness": "pw", "count": 10 }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        query: { type: 'string', description: 'Search text, max 400 chars.' },
        count: { type: 'number', description: 'Number of results to return (1-20, default 10).' },
        country: { type: 'string', description: 'Optional 2-letter country code to bias results, e.g. "us", "gb", "de".' },
        freshness: { type: 'string', description: 'Optional time filter: pd (past day) | pw (past week) | pm (past month) | py (past year).' },
        safesearch: { type: 'string', description: 'Optional content filter: off | moderate | strict (default moderate).' },
      },
      required: ['project_id', 'query'],
    },
  },
    annotations: { readOnlyHint: false, openWorldHint: true },
    group: 'web',
    core: true,
    coreRank: 66,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', '/v1/web/search', authHeader, {
          project_id: args.project_id,
          query: args.query,
          ...(args.count !== undefined ? { count: Number(args.count) } : {}),
          ...(args.country !== undefined ? { country: args.country } : {}),
          ...(args.freshness !== undefined ? { freshness: args.freshness } : {}),
          ...(args.safesearch !== undefined ? { safesearch: args.safesearch } : {}),
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'ingest',
    description: `Point an app at a website and it becomes data: crawl a site, land every page as markdown in the project's files, and index it into the project's search — one call instead of wiring up a crawler, a file store, and a search index yourself. Always runs as a background job (crawls take minutes) — this call returns immediately with a \`job_id\`; poll it with \`tasks_get\`-style status via the jobs API, or just call \`search_query\` against the \`"ingest"\` index once you expect it's done.

The crawl never follows a link off the seed URL's exact host — it can't wander onto another site. Re-ingesting the same URL overwrites the same file and search item rather than duplicating it, so re-running ingest after a docs site updates is safe.

**Example:**

\`\`\`json
{ "project_id": "my-saas", "url": "https://docs.example.com", "max_pages": 40 }
// Returns: { "job_id": "job_...", "status": "queued" }
\`\`\`

Then, once the job completes:

\`\`\`json
{ "project_id": "my-saas", "index": "ingest", "query": "how do I authenticate" }
// via search_query — returns hits pulled straight from the crawled pages.
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        idempotency_key: { type: 'string', maxLength: 200, description: 'Stable key for one logical creation. Reuse it with identical arguments after a lost response; use a new key for independent work.' },
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        url: { type: 'string', description: 'Seed http(s) URL to start crawling from, max 2048 chars. Only pages on this exact host are ever crawled.' },
        max_pages: { type: 'number', description: 'Maximum pages to crawl (1-200, default 50).' },
        path_prefix: { type: 'string', description: 'Project files folder pages land under, default "ingest". Pages land at /{path_prefix}/{hostname}/{page-path}.md.' },
      },
      required: ['project_id', 'url'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    group: 'web',
    core: true,
    coreRank: 106,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      const invocationKey = args.idempotency_key !== undefined ? args.idempotency_key : crypto.randomUUID();
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', '/v1/web/ingest', authHeader, {
          project_id: args.project_id,
          idempotency_key: invocationKey,
          url: args.url,
          ...(args.max_pages !== undefined ? { max_pages: Number(args.max_pages) } : {}),
          ...(args.path_prefix !== undefined ? { path_prefix: args.path_prefix } : {}),
        });
        return result;

      }
    },
  },
  // ── push ─────────────────────────────────────────────
  {
    definition: {
    name: 'push_vapid_key',
    description: `**Building notifications that must arrive after the app tab closes?** Start by getting the project's VAPID public key, then pass it to \`PushManager.subscribe({ applicationServerKey })\` in the browser. The key is auto-generated and stable for the project's lifetime.

**Example:**

\`\`\`json
{ "project_id": "my-saas" }
// Returns: { "vapid_public_key": "BN..." }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: { project_id: { type: 'string', description: "Project ID (UUID), subdomain, or 'default'." } },
      required: ['project_id'],
    },
  },
    annotations: { readOnlyHint: true, idempotentHint: true },
    group: 'push',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(
          fetcher,
          'GET',
          `/v1/push/vapid-public-key?project_id=${encodeURIComponent(args.project_id as string)}`,
          authHeader,
        );
        return result;

      }
    },
  },
  {
    definition: {
    name: 'push_subscribe',
    description: `**After the browser returns a \`PushManager.subscribe()\` result, persist it here** so later \`push_send\` calls can reach that browser or app-user. This is the ONLY registration path today: it needs developer authority (this tool or \`POST /v1/push/subscribe\` with a developer key), an app-user session is not authorized for it, and \`sw.push.subscribe\` inside a deployed function throws \`PUSH_SUBSCRIBE_UNAVAILABLE\` — so an app's visitors cannot register themselves. Idempotent on (project_id, endpoint).

**Example:**

\`\`\`json
{
  "project_id": "my-saas",
  "subscription": { "endpoint": "https://fcm...", "keys": { "p256dh": "...", "auth": "..." } },
  "user_id": "u_alice"
}
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        subscription: { type: ['string', 'object'], description: 'JSON object (or stringified) exactly as returned by PushManager.subscribe(). Must contain `endpoint` and `keys.{p256dh, auth}`.' },
        user_id: { type: 'string', description: 'Optional end-user identifier to attach to the subscription. Used to target sends with `user_id`.' },
      },
      required: ['project_id', 'subscription'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    group: 'push',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const subscription = parseJsonArg(args.subscription, 'subscription');
        result = await callAPI(fetcher, 'POST', '/v1/push/subscribe', authHeader, {
          project_id: args.project_id,
          subscription,
          ...(args.user_id !== undefined ? { user_id: args.user_id } : {}),
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'push_unsubscribe',
    description: `**When a user disables notifications or a browser subscription is replaced,** remove the old subscription by endpoint. The operation is idempotent.

**Example:**

\`\`\`json
{ "project_id": "my-saas", "endpoint": "https://fcm.googleapis.com/..." }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        endpoint: { type: 'string', description: 'The subscription endpoint URL to remove.' },
      },
      required: ['project_id', 'endpoint'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    group: 'push',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', '/v1/push/unsubscribe', authHeader, {
          project_id: args.project_id,
          endpoint: args.endpoint,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'push_send',
    description: `**Need an alert to reach a user even when the app tab is closed?** \`push_send\` sends a web push notification to one endpoint, one app-user's subscriptions, or the whole project.

Recipient targeting (pick one):
- \`endpoint\`: send to a single subscription (idempotent retry).
- \`user_id\`: fan out to every subscription registered for that app-user.
- neither: broadcast to every subscription in the project — use sparingly.

\`payload\` may be a JSON object (recommended — your service worker parses it) or a string. Subscriptions that the push provider reports as gone (404/410) are auto-deleted. Inside a deployed function the equivalent call is \`sw.push.send({ payload, user_id })\` — one object, payload nested; there is no second options argument.

**Example:**

\`\`\`json
{
  "project_id": "my-saas",
  "user_id": "u_alice",
  "payload": { "title": "New message", "body": "From Bob", "url": "/inbox/123" }
}
// Returns: { "sent": 1, "failed": 0, "gone": 0, "recipients": 1 }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        payload: { type: ['string', 'object'], description: 'Notification body. JSON object or string. Your service worker reads this in the push event.' },
        user_id: { type: 'string', description: 'Optional: send to every subscription for this app-user.' },
        endpoint: { type: 'string', description: 'Optional: send to a single subscription by its endpoint URL.' },
        ttl: { type: 'number', description: 'Optional time-to-live in seconds (default 86400). The push service holds the message at most this long if the device is offline.' },
        contact: { type: 'string', description: 'Optional VAPID contact (mailto:you@example.com). Defaults to the platform contact.' },
      },
      required: ['project_id', 'payload'],
    },
  },
    annotations: { readOnlyHint: false, openWorldHint: true },
    group: 'push',
    core: true,
    coreRank: 59,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        let payload: unknown = args.payload;
        if (typeof payload === 'string') {
          // Accept either a stringified JSON object or a plain string body.
          // Try to parse as JSON; fall back to the raw string.
          try { payload = JSON.parse(payload); } catch { /* keep raw string */ }
        }
        result = await callAPI(fetcher, 'POST', '/v1/push/send', authHeader, {
          project_id: args.project_id,
          payload,
          ...(args.user_id !== undefined ? { user_id: args.user_id } : {}),
          ...(args.endpoint !== undefined ? { endpoint: args.endpoint } : {}),
          ...(args.ttl !== undefined ? { ttl: Number(args.ttl) } : {}),
          ...(args.contact !== undefined ? { contact: args.contact } : {}),
        });
        return result;

      }
    },
  },
  // ── rate_limit ─────────────────────────────────────────────
  {
    definition: {
    name: 'rate_limit_check',
    description: `Atomically check and increment a rate-limit counter. Each call counts as one hit against \`key\` for the current fixed window. Returns whether this hit is allowed and how many remain.

Use this when you'd otherwise hand-roll per-IP / per-user throttling. Window granularity is per-second; pick \`window_seconds\` based on the cadence you want (60 for per-minute, 3600 for per-hour, etc.). The platform handles atomicity; race-safe for typical throttling use.

**Example:**

\`\`\`json
{ "project_id": "my-saas", "key": "ip:1.2.3.4:signup", "max": 5, "window_seconds": 60 }
// Returns: { "allowed": true, "remaining": 4, "reset": 1715212800, "limit": 5, "window_seconds": 60 }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        key: { type: 'string', description: 'Bucket key — e.g. "ip:1.2.3.4:login" or "user:u_alice:checkout". Max 256 chars.' },
        max: { type: 'number', description: 'Max hits allowed in the window (1 to 1,000,000).' },
        window_seconds: { type: 'number', description: 'Window length in seconds (1 to 86400).' },
      },
      required: ['project_id', 'key', 'max', 'window_seconds'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    group: 'rate_limit',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', '/v1/rate-limit/check', authHeader, {
          project_id: args.project_id,
          key: args.key,
          max: Number(args.max),
          window_seconds: Number(args.window_seconds),
        });
        return result;

      }
    },
  },
  // ── telegram ─────────────────────────────────────────────
  {
    definition: {
    name: 'telegram_link',
    description: `Mint a one-time link code and return a t.me URL the user clicks to connect their Telegram account to the platform. The link expires in 10 minutes. After the user clicks /start in Telegram, the link is finalized server-side.

Use this when you want to offer "Connect Telegram" as a setup step inside an app flow. Once linked, the user can talk to the bot to control their hosted workspace.

**Example:**

\`\`\`json
{}
// Returns: { "link_url": "https://t.me/somewheretech_bot?start=LINK_abc123", "expires_in": "10 minutes", "bot_username": "somewheretech_bot" }
\`\`\``,
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
    annotations: { readOnlyHint: false, openWorldHint: true },
    group: 'telegram',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', '/v1/telegram/link', authHeader, {});
        return result;

      }
    },
  },
  {
    definition: {
    name: 'telegram_status',
    description: `Check whether the developer's account is linked to Telegram. Returns \`linked: false\` (with \`bot_configured\` flag) before linking, or the linked telegram username + active project after.

**Example:**

\`\`\`json
{}
// Linked:   { "linked": true, "telegram_username": "alice", "active_project": "my-saas", "linked_at": "2026-04-01T..." }
// Unlinked: { "linked": false, "bot_configured": true }
\`\`\``,
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    group: 'telegram',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'GET', '/v1/telegram/status', authHeader);
        return result;

      }
    },
  },
  // ── analytics ─────────────────────────────────────────────
  {
    definition: {
    name: 'analytics_track',
    description: `**Building anything with users?** \`analytics_track\` gives the app per-event product analytics with one call. Track the moment a user signs up, starts checkout, purchases, publishes, or completes another product action; query it within seconds via \`analytics_query\`. Up to 20 numeric properties are automatically aggregatable (sum/avg).

**Example:**

\`\`\`json
{
  "project_id": "my-saas",
  "event": "purchase_completed",
  "user_id": "u_alice",
  "properties": { "amount": 49.99, "plan": "pro", "source": "landing_page" }
}
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        event: { type: 'string', description: 'Event name, max 128 chars. Keep it stable — this is what you filter on later (e.g. "signup", "checkout_started").' },
        user_id: { type: 'string', description: 'Optional end-user identifier to group events by user.' },
        properties: { type: 'string', description: 'Optional JSON object of custom properties. Numeric values become aggregatable. Max 8KB. Example: \'{"plan":"pro","amount":49,"items":3}\'' },
        page: { type: 'string', description: 'Optional page URL where the event fired.' },
        referrer: { type: 'string', description: 'Optional referrer URL.' },
        user_agent: { type: 'string', description: 'Optional user agent string.' },
      },
      required: ['project_id', 'event'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    group: 'analytics',
    core: true,
    coreRank: 68,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        let props: Record<string, unknown> | undefined;
        if (typeof args.properties === 'string' && args.properties.length > 0) {
          try { props = JSON.parse(args.properties as string); }
          catch {
            return { content: [{ type: 'text', text: 'properties must be valid JSON when provided as a string.' }], isError: true };
          }
        } else if (args.properties && typeof args.properties === 'object') {
          props = args.properties as Record<string, unknown>;
        }
        result = await callAPI(fetcher, 'POST', '/v1/analytics/track', authHeader, {
          project_id: args.project_id,
          event: args.event,
          user_id: args.user_id,
          properties: props,
          page: args.page,
          referrer: args.referrer,
          user_agent: args.user_agent,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'analytics_query',
    description: `Query product analytics. Filter by event name and time range; group by hour, day, event, or user. Returns aggregated counts and numeric sums.

**Example:**

\`\`\`json
{
  "project_id": "my-saas",
  "event": "purchase_completed",
  "from": "2026-04-01",
  "to": "2026-04-20",
  "group_by": "day"
}
// Returns: [{ "date": "2026-04-01", "count": 12, "sum_amount": 587.88 }, ...]
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        event: { type: 'string', description: 'Optional event name to filter on. If omitted, all events match.' },
        from: { type: ['string', 'number'], description: 'Optional start time — ISO-8601 string or unix-ms integer.' },
        to: { type: ['string', 'number'], description: 'Optional end time — ISO-8601 string or unix-ms integer.' },
        group_by: { type: 'string', description: 'Optional. One of: hour, day, event, user. Omit for raw event rows (most recent first).' },
        limit: { type: 'number', description: 'Max rows (default 1000, max 10000).' },
      },
      required: ['project_id'],
    },
  },
    annotations: { title: 'Query analytics', readOnlyHint: true, idempotentHint: true },
    group: 'analytics',
    core: true,
    coreRank: 93,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', '/v1/analytics/query', authHeader, {
          project_id: args.project_id,
          event: args.event,
          from: args.from,
          to: args.to,
          group_by: args.group_by,
          limit: args.limit,
        });
        return result;

      }
    },
  },
  // ── security ─────────────────────────────────────────────
  {
    definition: {
    name: 'security_sitekey',
    description: `Get the CAPTCHA site key to embed in your frontend HTML. This is safe to expose publicly — it identifies the widget, not the user.

**Example:**

\`\`\`json
{}
// Returns: { "sitekey": "0x..." }
\`\`\`

**Usage in HTML:**

\`\`\`html
<div class="cf-captcha" data-sitekey="0x..."></div>
<script src="https://your-captcha-provider.example/widget.js" async defer></script>
\`\`\``,
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
    annotations: { readOnlyHint: true, idempotentHint: true },
    group: 'security',
    core: true,
    coreRank: 70,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'GET', '/v1/security/sitekey', authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'security_verify',
    description: `Verify a CAPTCHA token submitted from a form. Call this server-side before trusting the form data.

**Example:**

\`\`\`json
{ "token": "0.abc123..." }
// Returns: { "success": true }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        token: { type: 'string', description: 'The CAPTCHA token from the client form submission.' },
        remote_ip: { type: 'string', description: 'Optional end-user IP — strengthens verification when provided.' },
      },
      required: ['token'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    group: 'security',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', '/v1/security/verify', authHeader, {
          token: args.token,
          remote_ip: args.remote_ip,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'security_review',
    description: `On-demand LLM security review of a project's deployed functions. Returns a structured Markdown report — findings (one per real risk), severity, and a fix.

Tier picks the depth: Free / Builder get a fast, broad-strokes AI review. Pro / Scale / Enterprise / admin get a deeper review with more context. Same response shape — only the depth differs.

Advisory only — never blocks anything. The deploy path no longer runs a regex scanner as a blocker; it surfaces hits as warnings and this tool is how you get the deep dive.

project_id is required (returns VALIDATION_ERROR if omitted). Backend failures are distinguishable so you don't retry in vain: a transient outage returns UPSTREAM_DOWN / UPSTREAM_RATE_LIMITED (retryable), while a persistent platform problem returns UPSTREAM_ERROR / CONFIG_ERROR (not retryable — report it instead of looping).

**Example:**

\`\`\`json
{ "project_id": "my-saas" }
// Returns: { "findings": "## Findings\\n### Auth bypass at api/checkout.ts ...\\n...", "review_depth": "standard", "tier_unlocks_deep_review": false, ... }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, slug, or 'default'. Resolved server-side." },
        focus: { type: 'string', description: 'Optional area to focus the review on (e.g. "the new payments flow", "auth changes since last week"). Up to 500 chars.' },
      },
      required: ['project_id'],
    },
  },
    annotations: { title: 'Run a security review', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    group: 'security',
    core: true,
    coreRank: 71,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","chatgpt","connector"],
    protocol: { surfaceDescriptions: { connector: "Run a security review of a project’s deployed source and record the findings." }, surfaceAnnotations: { chatgpt: { destructiveHint: true, openWorldHint: true }, connector: {"title":"Security Review","readOnlyHint":false,"destructiveHint":true} },  oauthScopes: ['mcp'] },
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', '/v1/security/review', authHeader, {
          project_id: args.project_id,
          focus: args.focus,
        });
        return result;

      }
    },
  },
  // ── db ─────────────────────────────────────────────
  {
    definition: {
    name: 'db_bookmark_create',
    description: `Record a named point in the project database's 30-day history. Restoring a database in place is not available (db_restore refuses with \`DATABASE_RESTORE_UNAVAILABLE\`), so a bookmark is a recorded marker, not an undo. Reusing a label overwrites the previous bookmark.

**Example:**

\`\`\`json
{ "project_id": "my-saas", "label": "before-migration-v3" }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        label: { type: 'string', description: 'A friendly label for this restore point (max 96 chars). Example: "pre-migration-v12" or "before-cleanup".' },
      },
      required: ['project_id', 'label'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    group: 'db',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', '/v1/db/bookmark', authHeader, {
          project_id: args.project_id,
          label: args.label,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'db_bookmarks_list',
    description: 'List the named points recorded in a project database\'s 30-day history. Restoring in place is not available; these are markers, not undo points.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
      },
      required: ['project_id'],
    },
  },
    annotations: { readOnlyHint: true, idempotentHint: true },
    group: 'db',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'GET', `/v1/db/bookmarks?project_id=${encodeURIComponent(args.project_id as string)}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'db_restore',
    description: `Restoring a project database in place is not available: this call is refused with \`DATABASE_RESTORE_UNAVAILABLE\` before anything changes, for every project. No restore is admitted, so there is no restore outcome to read. Kept so older callers get a typed refusal rather than an unknown tool. Downloads and exports (db_dump, db_export) are unaffected and are the way to take data out.`,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        label: { type: 'string', description: 'Bookmark label from db_bookmark_create. Use this OR timestamp, not both.' },
        timestamp: { type: 'string', description: 'ISO-8601 timestamp within the last 30 days. Use this OR label, not both.' },
      },
      required: ['project_id'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    group: 'db',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', '/v1/db/restore', authHeader, {
          project_id: args.project_id,
          label: args.label,
          timestamp: args.timestamp,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'db_webhook_set',
    description: `Register an HTTPS endpoint to receive database change notifications for this project. Fires after a successful INSERT / UPDATE / UPSERT / DELETE through db_query — one POST per mutation, no row contents.

The first call generates a per-project secret you'll see in the response (\`secret\`). Subsequent calls update the URL or event filter and return the same secret. Verify the incoming \`X-Somewhere-Signature: t={ms},v1={hex}\` header by recomputing \`HMAC-SHA256(secret, "{ms}." + rawBody)\`.

**Example:**

\`\`\`json
{ "project_id": "my-saas", "url": "https://example.com/db-hook", "events": ["insert", "update"] }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        url: { type: 'string', description: 'HTTPS URL the platform will POST change events to.' },
        events: {
          type: 'string',
          description: 'JSON-encoded array of event names to subscribe to. Defaults to all three when omitted. Example: \'["insert","update"]\'. (Upserts ride on the insert subscription.)',
        },
      },
      required: ['project_id', 'url'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    group: 'db',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const events = parseJsonArg(args.events, 'events');
        result = await callAPI(fetcher, 'PUT', '/v1/db/webhook', authHeader, {
          project_id: args.project_id,
          url: args.url,
          events,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'db_webhook_get',
    description: 'Return the current database change-webhook registration for a project (url, events, secret, last delivery status). Returns `{ webhook: null }` when none is set.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
      },
      required: ['project_id'],
    },
  },
    annotations: { readOnlyHint: true, idempotentHint: true },
    group: 'db',
    core: true,
    coreRank: 103,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'GET', `/v1/db/webhook?project_id=${encodeURIComponent(args.project_id as string)}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'db_webhook_delete',
    description: 'Remove the database change-webhook for a project. After this call, no further change notifications fire until db_webhook_set runs again.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
      },
      required: ['project_id'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    group: 'db',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'DELETE', `/v1/db/webhook?project_id=${encodeURIComponent(args.project_id as string)}`, authHeader);
        return result;

      }
    },
  },
  // ── webhooks ─────────────────────────────────────────────
  {
    definition: {
    name: 'webhook_deliveries_list',
    description: 'List recent project outbound webhook deliveries with stable event and delivery ids, current outcome, and the append-only history of every attempt. A timed-out attempt is reported as indeterminate because the receiver may have committed before the connection timed out.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        limit: { type: 'number', description: 'Maximum deliveries to return (default 50, max 100).' },
      },
      required: ['project_id'],
    },
  },
    annotations: { title: 'List outbound webhook deliveries', readOnlyHint: true, idempotentHint: true },
    group: 'webhooks',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const projectId = encodeURIComponent(args.project_id as string);
        const limit = typeof args.limit === 'number' ? `&limit=${encodeURIComponent(String(args.limit))}` : '';
        result = await callAPI(fetcher, 'GET', `/v1/webhooks/deliveries?project_id=${projectId}${limit}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'webhook_delivery_redrive',
    description: 'Redrive one project outbound webhook delivery using the exact immutable request bytes and the same stable event and delivery ids. The new attempt is appended to delivery history. Use the receiver-facing delivery id for dedupe, especially when the prior outcome is indeterminate.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        delivery_id: { type: 'string', description: 'Stable delivery id returned by webhook_deliveries_list.' },
      },
      required: ['project_id', 'delivery_id'],
    },
  },
    annotations: { title: 'Redrive an outbound webhook delivery', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    group: 'webhooks',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const deliveryId = encodeURIComponent(args.delivery_id as string);
        result = await callAPI(fetcher, 'POST', `/v1/webhooks/deliveries/${deliveryId}/redrive`, authHeader, {
          project_id: args.project_id,
        });
        return result;

      }
    },
  },
  // ── connect ─────────────────────────────────────────────
  {
    definition: {
    name: 'connect_stripe_url',
    description: `Get a link that lets a creator connect their EXISTING Stripe account read-only, so this project can read their subscriber list — the "gated content with your existing subscribers" use case. Returns { url }; send the creator's browser there to authorize. This is the OPPOSITE of payments_* (which is for ACCEPTING money) — connect reads another account's data, it never moves money.

**Example:**

\`\`\`json
{ "project_id": "my-gated-site", "return_url": "https://my-gated-site.somewhere.site/settings" }
// Returns: { "url": "https://connect.stripe.com/oauth/authorize?..." }
// After the creator authorizes, Stripe returns them to return_url with ?connect=success.
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, slug, or 'default'." },
        return_url: { type: 'string', description: 'Where Stripe returns the creator after they authorize (gets ?connect=success|error appended). Optional.' },
      },
      required: ['project_id'],
    },
  },
    annotations: { title: 'Get a Stripe connect link', readOnlyHint: false, openWorldHint: true },
    group: 'connect',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', '/v1/connect/stripe/connect', authHeader, {
          project_id: args.project_id,
          return_url: args.return_url,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'connect_stripe_subscribers',
    description:
      "List the subscribers of the Stripe account connected to this project. Reads the platform's cached list (kept fresh by the Connect webhook) — fast, no per-call Stripe round-trip. Each row: { email, stripe_customer_id, subscription_id, status, price_id, product_id, tier, current_period_end (Unix seconds), amount, currency }. `tier` is the Stripe Price nickname or lookup_key. Paginated: pass `cursor` (the previous response's next_cursor) to page. Returns 409 CONNECT_NOT_CONNECTED if no Stripe account is connected yet — call connect_stripe_url first.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, slug, or 'default'." },
        status: { type: 'string', description: "Optional Stripe subscription status filter (e.g. 'active', 'past_due', 'canceled')." },
        limit: { type: 'number', description: 'Page size (default 100, max 200).' },
        cursor: { type: 'string', description: "Pagination cursor (the prior response's next_cursor)." },
      },
      required: ['project_id'],
    },
  },
    annotations: { title: 'List connected Stripe subscribers', readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    group: 'connect',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const pid = encodeURIComponent(args.project_id as string);
        const st = args.status ? `&status=${encodeURIComponent(args.status as string)}` : '';
        const lim = args.limit ? `&limit=${args.limit}` : '';
        const cur = args.cursor ? `&cursor=${encodeURIComponent(args.cursor as string)}` : '';
        result = await callAPI(fetcher, 'GET', `/v1/connect/stripe/subscribers?project_id=${pid}${st}${lim}${cur}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'connect_stripe_status',
    description:
      'Show whether a Stripe account is connected to this project: { connected, account_id, scope, status, connected_at }. Never returns the token.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, slug, or 'default'." },
      },
      required: ['project_id'],
    },
  },
    annotations: { title: 'Show Stripe connection status', readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    group: 'connect',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const pid = encodeURIComponent(args.project_id as string);
        result = await callAPI(fetcher, 'GET', `/v1/connect/stripe/status?project_id=${pid}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'connect_stripe_disconnect',
    description:
      'Disconnect the Stripe account from this project — revokes the platform access at Stripe and deletes the cached subscriber list. The creator can reconnect later via connect_stripe_url.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, slug, or 'default'." },
      },
      required: ['project_id'],
    },
  },
    annotations: { title: 'Disconnect Stripe', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    group: 'connect',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', '/v1/connect/stripe/disconnect', authHeader, {
          project_id: args.project_id,
        });
        return result;

      }
    },
  },
  // ── payments ─────────────────────────────────────────────
  {
    definition: {
    name: 'payments_onboard',
    description: `Start Stripe Connect onboarding for the developer (per-account, not per-project — onboard once and every project you own uses the same connected account). Returns a URL the developer visits to set up identity, bank, and tax info for live charges. Charges then settle to their connected account with Stripe's standard processing fee deducted; the response carries the current platform fee so the onboarding UI can show it.

**You do NOT need this to start building.** Test-mode checkouts work immediately — payments_checkout in dev mode runs on the platform's own Stripe test account (no Connect destination, no fee) until you onboard, so card 4242 4242 4242 4242 succeeds with no setup.

**Example:**

\`\`\`json
{ "return_url": "https://my-app.somewhere.site/done", "refresh_url": "https://my-app.somewhere.site/retry" }
// Returns: { "onboarding_url": "https://connect.stripe.com/setup/..." }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        refresh_url: { type: 'string', description: 'URL Stripe bounces the user to if the onboarding link expires.' },
        return_url: { type: 'string', description: 'URL Stripe sends the user to when onboarding completes.' },
      },
      required: ['refresh_url', 'return_url'],
    },
  },
    annotations: { readOnlyHint: false, openWorldHint: true },
    group: 'payments',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', '/v1/payments/onboard', authHeader, {
          refresh_url: args.refresh_url,
          return_url: args.return_url,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'payments_status',
    description:
      "Get the caller's Stripe Connect status: connected, onboarded, charges_enabled, payouts_enabled, details_submitted. Per-account (not per-project). Pass refresh=true to force a live Stripe API lookup (otherwise returns the last-cached DB state).",
    inputSchema: {
      type: 'object',
      properties: {
        refresh: { type: 'boolean', description: 'If true, re-query Stripe. Default false.' },
      },
      required: [],
    },
  },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    group: 'payments',
    core: true,
    coreRank: 86,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const refresh = args.refresh ? '?refresh=1' : '';
        result = await callAPI(fetcher, 'GET', `/v1/payments/status${refresh}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'payments_checkout',
    description:
      "Create a Stripe Checkout Session for a project. Once the project owner has onboarded, funds settle to their connected account; the response's fee_percent is the platform fee on the session (current rate at /v1/pricing) and Stripe's standard processing fee also applies. Before onboarding, env='dev' checkouts run on the platform's own Stripe test account with no Connect destination — the response includes is_stand_in: true and platform_fee_cents: 0 so card 4242 4242 4242 4242 succeeds end-to-end. env='prod' returns 412 until the owner finishes onboarding. Supports mode='payment' | 'subscription'.\n\nThree payment bases (pass exactly one): line_items (ad-hoc), quote_id (a stored quote from a payments quote — server supplies the amount; one-time only, and may compose with calendar_hold_token + booking_id for an atomic booking checkout), or plan (a catalog plan slug — the <PricingTable>/sw.billing subscribe path).\n\nAutomatic plan tracking: pass metadata={\"app_user_id\":\"<id>\",\"plan\":\"<slug>\"} and the platform will set app_users.plan=<slug>, plan_status='active' on checkout.session.completed, 'past_due' on invoice.payment_failed, and 'canceled' on customer.subscription.deleted — no webhook code required. sw.auth.me() and sw.auth.fromRequest() return the current plan and plan_status on the user object.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        mode: { type: 'string', description: "'payment' for one-time or 'subscription' for recurring." },
        env: { type: 'string', description: "'dev' (default — test-mode Stripe; works without onboarding) or 'prod' (real Stripe; requires the project owner to have onboarded)." },
        line_items: { type: ['array', 'string'], description: 'Array of line_items. Prefer a native JSON array; a JSON-stringified array is also accepted. Each item is EITHER {price:"<stripe_price_id>", quantity} OR {amount:<integer cents>, currency:"usd", name:"<label>", quantity}. For an ad-hoc price use the {amount, currency, name} trio — a nested Stripe price object is not accepted.' },
        success_url: { type: 'string', description: 'Redirect URL on successful payment.' },
        cancel_url: { type: 'string', description: 'Redirect URL on cancellation.' },
        customer_email: { type: 'string', description: 'Optional prefilled email for the Checkout page.' },
        metadata: { type: ['object', 'string'], description: 'Optional key/value object forwarded to the Checkout Session. Prefer a native object; a JSON-stringified object is also accepted. Pass {"app_user_id":"<id>","plan":"<slug>"} to enable automatic plan tracking on app_users (plan + plan_status are maintained by the Connect webhook).' },
        quote_id: { type: 'string', description: 'Quote-based checkout: the id from a payments quote. The stored quote supplies the line items and amount (server-authoritative), so DO NOT also pass line_items. One-time payment only (not subscription). May be combined with calendar_hold_token and booking_id for an atomic booking checkout.' },
        booking_id: { type: 'string', description: 'Optional booking id to link this checkout to a booking record (composed with quote_id).' },
        calendar_hold_token: { type: 'string', description: 'Optional calendar-hold token to atomically confirm a held time slot on successful payment (composed with quote_id).' },
        plan: { type: 'string', description: 'Catalog-plan checkout: a catalog plan slug (the <PricingTable> / sw.billing subscribe path). Use instead of line_items to check out a predefined plan.' },
      },
      // A payment basis (line_items, or quote_id, or plan) is required but is
      // enforced in the handler, since exactly one of the three applies.
      required: ['project_id', 'success_url', 'cancel_url'],
    },
  },
    annotations: { title: 'Create a Stripe checkout session', readOnlyHint: false, openWorldHint: true },
    group: 'payments',
    core: true,
    coreRank: 56,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, env, authHeader, ctx, toolName } = runtime;
      let result: ToolUpstreamResult;
      {
        const hasQuote = typeof args.quote_id === 'string' && args.quote_id.length > 0;
        const hasPlan = typeof args.plan === 'string' && args.plan.length > 0;
        // line_items is now optional — a quote_id or plan checkout supplies the
        // amount server-side. Parse it only when provided.
        const lineItems = args.line_items !== undefined ? parseJsonArg(args.line_items, 'line_items') : undefined;
        const hasLineItems = Array.isArray(lineItems) && lineItems.length > 0;
        const metadata = args.metadata !== undefined ? parseJsonArg(args.metadata, 'metadata') : undefined;
        // Exactly one payment basis. quote_id (stored quote → server amount),
        // plan (catalog plan), or an explicit line_items array.
        if (!hasQuote && !hasPlan && !hasLineItems) {
          return badArgsToolResult(
            env, authHeader, ctx, toolName, args,
            'payments_checkout needs a payment basis: line_items (array), OR quote_id (from a payments quote), OR plan (a catalog plan slug).\nExample (line items):\npayments_checkout({ "project_id": "my-app", "mode": "payment", "line_items": [{ "amount": 1000, "currency": "usd", "name": "Pro plan", "quantity": 1 }], "success_url": "https://example.com/success", "cancel_url": "https://example.com/cancel" })\nExample (quote): payments_checkout({ "project_id": "my-app", "quote_id": "<id>", "success_url": "...", "cancel_url": "..." })',
          );
        }
        if (hasQuote && hasLineItems) {
          return badArgsToolResult(
            env, authHeader, ctx, toolName, args,
            'payments_checkout: a quote_id checkout must not also pass line_items — the stored quote supplies the line items and amount. Pass one or the other.',
          );
        }
        if (metadata !== undefined && !isRecord(metadata)) {
          return badArgsToolResult(
            env, authHeader, ctx, toolName, args,
            'payments_checkout metadata must be an object of key/value pairs.\nExample:\npayments_checkout({ "project_id": "my-app", "mode": "payment", "line_items": [{ "amount": 1000, "currency": "usd", "name": "Pro plan", "quantity": 1 }], "success_url": "https://example.com/success", "cancel_url": "https://example.com/cancel", "metadata": { "plan": "pro" } })\nOmit metadata if you do not need webhook context.',
          );
        }
        result = await callAPI(fetcher, 'POST', '/v1/payments/checkout', authHeader, {
          project_id: args.project_id,
          mode: args.mode,
          env: args.env || 'dev',
          ...(hasLineItems ? { line_items: lineItems } : {}),
          ...(hasQuote ? { quote_id: args.quote_id } : {}),
          ...(typeof args.booking_id === 'string' && args.booking_id.length > 0 ? { booking_id: args.booking_id } : {}),
          ...(hasPlan ? { plan: args.plan } : {}),
          ...(typeof args.calendar_hold_token === 'string' && args.calendar_hold_token.length > 0 ? { calendar_hold_token: args.calendar_hold_token } : {}),
          success_url: args.success_url,
          cancel_url: args.cancel_url,
          customer_email: args.customer_email,
          metadata,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'payments_dashboard_link',
    description:
      "Create a one-time login link to the developer's Stripe Express dashboard (live mode). Use this for \"View payouts\" or \"Update bank details\" buttons in your UI. 400s if the caller has not onboarded for live payments yet.",
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    group: 'payments',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'GET', '/v1/payments/dashboard-link', authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'payments_refund',
    description:
      "Refund a previous charge on the project owner's connected account. Pass `payment_intent_id` (preferred — what Checkout returns) OR `charge_id`. `amount` is in the smallest currency unit (cents); omit for a full refund. `reason` is `requested_by_customer`, `duplicate`, or `fraudulent`. A full refund returns the amount the customer was charged.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        payment_intent_id: { type: 'string', description: 'Stripe PaymentIntent id (pi_...). Preferred over charge_id.' },
        charge_id: { type: 'string', description: 'Stripe Charge id (ch_...). Used if payment_intent_id is not provided.' },
        amount: { type: 'number', description: 'Amount to refund in cents. Omit for a full refund.' },
        reason: { type: 'string', description: "Optional refund reason: 'requested_by_customer', 'duplicate', or 'fraudulent'." },
        env: { type: 'string', description: "'dev' (default — test-mode) or 'prod' (live mode)." },
      },
      required: ['project_id'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    group: 'payments',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, env, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', '/v1/payments/refund', authHeader, {
          project_id: args.project_id,
          payment_intent_id: args.payment_intent_id,
          charge_id: args.charge_id,
          amount: args.amount,
          reason: args.reason,
          env: args.env || 'dev',
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'payments_cancel_subscription',
    description:
      "Cancel a Stripe subscription on the project owner's connected account. By default the subscription stays active until the end of the current billing period (polite cancel). Pass `immediately: true` to terminate now and stop billing. Plan tracking on `app_users` (plan/plan_status) is updated automatically by the webhook on `customer.subscription.deleted`.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        subscription_id: { type: 'string', description: 'Stripe Subscription id (sub_...).' },
        immediately: { type: 'boolean', description: 'If true, cancel right now. If false/omitted, cancel at the end of the current billing period.' },
        env: { type: 'string', description: "'dev' (default — test-mode) or 'prod' (live mode)." },
      },
      required: ['project_id', 'subscription_id'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    group: 'payments',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, env, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', '/v1/payments/cancel-subscription', authHeader, {
          project_id: args.project_id,
          subscription_id: args.subscription_id,
          immediately: args.immediately,
          env: args.env || 'dev',
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'payments_transactions',
    description:
      "List recent charges on the project owner's connected account. Returns Stripe's native cursor pagination — pass `starting_after` from the previous response's `next_cursor` to fetch the next page. Default page size 20, max 100. env=prod lists live-mode charges; default env=dev lists test-mode.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        limit: { type: 'number', description: 'Page size (1-100). Default 20.' },
        starting_after: { type: 'string', description: 'Stripe cursor — pass the previous page\'s `next_cursor`.' },
        env: { type: 'string', description: "'dev' (default — test-mode) or 'prod' (live mode)." },
      },
      required: ['project_id'],
    },
  },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    group: 'payments',
    core: true,
    coreRank: 88,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, env, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const pid = encodeURIComponent(args.project_id as string);
        const env = encodeURIComponent((args.env as string) || 'dev');
        const lim = args.limit ? `&limit=${args.limit}` : '';
        const after = args.starting_after ? `&starting_after=${encodeURIComponent(args.starting_after as string)}` : '';
        result = await callAPI(fetcher, 'GET', `/v1/payments/transactions?project_id=${pid}&env=${env}${lim}${after}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'payments_portal',
    description:
      "Create a Stripe Billing Portal session for an app user. The platform resolves the stored Stripe customer for `app_user_id` server-side; raw Stripe customer ids are not accepted by this tool. Returns a short-lived URL to redirect to.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        app_user_id: { type: 'string', description: 'App user id whose billing customer should be opened.' },
        return_url: { type: 'string', description: 'URL Stripe redirects to when the customer closes the portal.' },
        env: { type: 'string', description: "'dev' (default — test-mode) or 'prod' (live mode)." },
      },
      required: ['project_id', 'app_user_id', 'return_url'],
    },
  },
    annotations: { readOnlyHint: false, openWorldHint: true },
    group: 'payments',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, env, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', '/v1/payments/portal', authHeader, {
          project_id: args.project_id,
          app_user_id: args.app_user_id,
          return_url: args.return_url,
          env: args.env || 'dev',
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'payments_events',
    description:
      "Paginated feed of Stripe webhook events the platform received for this project (from the payments_events ledger). Use this to drive an in-product activity feed or to verify webhook reception during integration. The webhook handler is idempotent — duplicate Stripe redeliveries appear once.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Optional project UUID/subdomain filter. Omit to list every event attributed to this developer." },
        limit: { type: 'number', description: 'Page size (1-200). Default 50.' },
        before: { type: 'number', description: 'Cursor — pass the previous page\'s `next_cursor` (ms epoch).' },
        type: { type: 'string', description: 'Optional Stripe event type filter, e.g. `checkout.session.completed`.' },
      },
      required: [],
    },
  },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
    group: 'payments',
    core: true,
    coreRank: 87,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const params = new URLSearchParams();
        if (args.project_id) params.set('project_id', args.project_id as string);
        if (args.limit) params.set('limit', String(args.limit));
        if (args.before) params.set('before', String(args.before));
        if (args.type) params.set('type', args.type as string);
        const qs = params.toString() ? `?${params.toString()}` : '';
        result = await callAPI(fetcher, 'GET', `/v1/payments/events${qs}`, authHeader);
        return result;

      }
    },
  },
  // ── realtime ─────────────────────────────────────────────
  {
    definition: {
    name: 'realtime_publish',
    description: `**Fanning an event out to server-side consumers you run?** \`realtime_publish\` delivers to every socket subscribed to a channel. Channels are DEVELOPER AUTHORITY ONLY — an app-user or anonymous browser session is refused on subscribe and publish alike (\`CHANNEL_FORBIDDEN\`), so this does not reach your app's visitors. For a browser, declare a live view server-side with \`sw.db.live(name, sw.db.from(...))\` and subscribe with \`watchLive\`. Realtime is not durable history; write the source of truth to the database first. Channel names must match \`[a-zA-Z0-9][a-zA-Z0-9_\\-:.]{0,127}\`. Payloads are JSON-serialized and capped at 64 KB. Free plan supports 100,000 publishes/month; Builder is unlimited.

**Example:**

\`\`\`json
{
  "project_id": "my-saas",
  "channel": "dashboard:updates",
  "event": "new_order",
  "data": { "order_id": "ord_123", "total": 49.99 }
}
\`\`\`

**Subscribe (server-side consumer, developer key on the URL — never ship this key to a browser):**

\`\`\`javascript
const ws = new WebSocket("wss://api.somewhere.tech/v1/realtime/subscribe?project_id=my-saas&channel=dashboard:updates&token=smt_...");
ws.onmessage = (e) => console.log(JSON.parse(e.data));
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        channel: { type: 'string', description: 'Channel name scoped within the project.' },
        event: { type: 'string', description: "Event name. Defaults to 'message'." },
        data: { type: ['string', 'object'], description: 'Payload to publish. Any JSON value (object, array, or JSON string).' },
        from: { type: 'string', description: 'Optional sender label attached to the envelope.' },
      },
      required: ['project_id', 'channel', 'data'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    group: 'realtime',
    core: true,
    coreRank: 57,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const data = parseJsonArg(args.data, 'data');
        result = await callAPI(fetcher, 'POST', `/v1/realtime/publish`, authHeader, {
          project_id: args.project_id,
          channel: args.channel,
          event: args.event,
          data,
          from: args.from,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'realtime_channels',
    description: `**Debugging a live screen or checking whether anyone is listening before you publish?** List channels with subscribers or recent publishes in the last 10 minutes. Each entry includes the current subscriber count and last publish timestamp.

**Example:**

\`\`\`json
{ "project_id": "my-saas" }
// Returns: { "channels": [{ "channel": "dashboard:updates", "subscribers": 3, "last_publish_at": "2026-05-11T14:32:00Z", "updated_at": "..." }] }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
      },
      required: ['project_id'],
    },
  },
    annotations: { readOnlyHint: true, idempotentHint: true },
    group: 'realtime',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const pid = encodeURIComponent(args.project_id as string);
        result = await callAPI(fetcher, 'GET', `/v1/realtime/channels?project_id=${pid}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'realtime_broadcast',
    description: `[Legacy] Fan out a message to every subscriber on a channel. Developer authority only — app-user and anonymous sessions cannot subscribe, so this does not reach browser clients. Channel names must match \`[a-zA-Z0-9][a-zA-Z0-9_\\-:.]{0,127}\`. Messages are JSON-serialized and capped at 64 KB. Prefer realtime_publish for new code — it supports a named event field and matches the WebSocket envelope shape.

**Example:**

\`\`\`json
{
  "project_id": "my-saas",
  "channel": "dashboard:updates",
  "message": { "event": "new_order", "order_id": "ord_123", "total": 49.99 }
}
\`\`\`

**Subscription (server-side consumer, developer key):**

\`\`\`javascript
const ws = new WebSocket("wss://api.somewhere.tech/v1/realtime/subscribe?project_id=my-saas&channel=dashboard:updates&token=smt_...");
ws.onmessage = (e) => {
  const data = JSON.parse(e.data);
  console.log("New event:", data);
};
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        channel: { type: 'string', description: 'Channel name scoped within the project.' },
        message: { type: ['string', 'object'], description: 'Payload to broadcast (object or JSON string).' },
        from: { type: 'string', description: 'Optional sender label attached to the envelope.' },
      },
      required: ['project_id', 'channel', 'message'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    group: 'realtime',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const channel = encodeURIComponent(args.channel as string);
        const message = parseJsonArg(args.message, 'message');
        result = await callAPI(fetcher, 'POST', `/v1/realtime/channels/${channel}/broadcast`, authHeader, {
          project_id: args.project_id,
          message,
          from: args.from,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'realtime_meta',
    description: `Get subscriber count and last-message timestamp for a realtime channel. Useful for "is anyone listening?" checks before broadcasting.

**Example:**

\`\`\`json
{ "project_id": "my-saas", "channel": "dashboard:updates" }
// Returns: { "subscribers": 3, "last_message_at": "2026-04-20T14:32:00Z" }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        channel: { type: 'string', description: 'Channel name.' },
      },
      required: ['project_id', 'channel'],
    },
  },
    annotations: { readOnlyHint: true, idempotentHint: true },
    group: 'realtime',
    core: true,
    coreRank: 99,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const channel = encodeURIComponent(args.channel as string);
        const pid = encodeURIComponent(args.project_id as string);
        result = await callAPI(fetcher, 'GET', `/v1/realtime/channels/${channel}/meta?project_id=${pid}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'realtime_subscribe_project',
    description: `Get the connection recipe for the project's system channel. The platform automatically pushes lifecycle events to this channel — deploys, quota warnings, database health, and auth admin actions. Subscribe once and you get notified the moment any of these happen.

Event shapes the channel emits (\`event\` field on the WebSocket envelope):

- \`deployed\` / \`patched\` / \`restored\` / \`rolled_back\` — \`{ version, by, message, has_functions, at }\`. Multi-editor conflict prevention: if you're holding a write, see a version bump, pull before pushing.
- \`db_health\` — \`{ event: "cpu_exhaust_recovered" | "cpu_exhaust_failed", query_fingerprint, at }\`. Fires when the platform retried a slow query for the user.
- \`quota_warning\` — \`{ resource: "storage" | "database" | "email" | "realtime" | "ai" | "inbox", usage_percent, message, at }\`. Fires once per resource per 80%/95% crossing per month.
- \`auth_event\` — \`{ event: "user_deleted" | "user_banned" | "user_unbanned" | "impersonation_started" | "impersonation_ended", user_id, actor_id, at }\`.

**Example:**

\`\`\`json
{ "project_id": "my-saas" }
// Returns:
// {
//   "channel": "system:project",
//   "websocket_url": "wss://api.somewhere.tech/v1/realtime/subscribe?project_id=my-saas&channel=system:project&token=smt_...",
//   "event_types": ["deployed", "patched", "restored", "rolled_back", "db_health", "quota_warning", "auth_event"]
// }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
      },
      required: ['project_id'],
    },
  },
    annotations: { readOnlyHint: true, idempotentHint: true },
    group: 'realtime',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        // Pure-MCP synthesizer (no upstream REST call) — but the
        // finalization downstream reads `result.status` + `result.data`
        // off everything that lands in `result`. Earlier code returned
        // `{ ok, data }` directly, which made both `status` and `data`
        // undefined and the tool reply serialized as null. Wrap in the
        // dispatcher's expected shape (audit §"MCP Server Type Errors").
        const pid = encodeURIComponent(args.project_id as string);
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
        result = {
          status: 200,
          data: {
            ok: true,
            data: {
              channel: 'system:project',
              websocket_url: `wss://api.somewhere.tech/v1/realtime/subscribe?project_id=${pid}&channel=system:project&token=${encodeURIComponent(token)}`,
              event_types: ['deployed', 'patched', 'restored', 'rolled_back', 'db_health', 'quota_warning', 'auth_event'],
            },
          },
        };
        return result;

      }
    },
  },
  {
    definition: {
    name: 'realtime_subscribe_user',
    description: `Get the connection recipe for the caller's personal system channel. The platform pushes user-scoped events here that aren't tied to one project — currently \`feedback_resolved\` when the platform team responds to or resolves a \`support_ticket\` ticket.

Auth: developer smt_ key only. The channel is bound to the caller's own user id — there is no cross-user subscribe.

**Example:**

\`\`\`json
{}
// Returns:
// {
//   "channel": "system:user",
//   "websocket_url": "wss://api.somewhere.tech/v1/realtime/subscribe-user?token=smt_...",
//   "event_types": ["feedback_resolved"]
// }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
    annotations: { readOnlyHint: true, idempotentHint: true },
    group: 'realtime',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
        result = {
          status: 200,
          data: {
            ok: true,
            data: {
              channel: 'system:user',
              websocket_url: `wss://api.somewhere.tech/v1/realtime/subscribe-user?token=${encodeURIComponent(token)}`,
              event_types: ['feedback_resolved'],
            },
          },
        };
        return result;

      }
    },
  },
  // ── video ─────────────────────────────────────────────
  {
    definition: {
    name: 'video_upload_url',
    description: `Get a one-time direct-upload URL for video. **Starting a new upload is included on Pro and Scale**; on Free and Builder this returns \`VIDEO_NOT_IN_PLAN\` (403) before anything is charged or reserved, and retrying does not change that. Listing, reading and deleting video already uploaded are not gated on any plan. The live per-plan answer is \`limits.video_enabled\` on \`GET /v1/pricing\`. The client POSTs the video bytes directly to this URL — the bytes never touch your server. The platform handles transcoding and global delivery via HLS/DASH. \`max_duration_seconds\` is clamped to 30–21,600 (6 hours) and defaults to 600 (10 minutes); ask for more only when the source really is longer, because the ceiling you name is held against video storage until the upload lands or the link expires. The response carries \`expires_at\` — after that the link stops working and its reservation is released.

**Example:**

\`\`\`json
{
  "project_id": "my-saas",
  "max_duration_seconds": 600,
  "title": "Demo Recording"
}
// Returns: { "upload_url": "https://upload.somewhere.tech/tus/...", "video_id": "v_abc123", "max_duration_seconds": 600, "expires_at": "2026-09-02T11:22:33.000Z" }
\`\`\`

**Client-side upload:**

\`\`\`javascript
await fetch(uploadUrl, { method: "POST", body: videoFile });
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        title: { type: 'string', description: 'Display title.' },
        max_duration_seconds: { type: 'integer', description: 'Ceiling for source duration. Default 600 (10 min). The ceiling is held against video storage from the moment the link is issued until the upload lands or the link expires, so name only what the source needs.' },
        require_signed_urls: { type: 'boolean', description: 'If true, playback requires a signed token. Default false.' },
      },
      required: ['project_id'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    group: 'video',
    hidden: true, // founder 2026-08-05: hide video everywhere — callable, not advertised (tsk_9a68e374)
    core: true,
    coreRank: 60,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', '/v1/video/upload-url', authHeader, {
          project_id: args.project_id,
          title: args.title,
          max_duration_seconds: args.max_duration_seconds,
          require_signed_urls: args.require_signed_urls,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'video_list',
    description:
      "List a project's videos with readiness state, playback URLs, thumbnail, duration, and size. Not plan-gated — video already uploaded stays listable on every plan (only new uploads need Pro or Scale).",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        limit: { type: 'integer', description: 'Max results, 1–200. Default 50.' },
      },
      required: ['project_id'],
    },
  },
    annotations: { readOnlyHint: true, idempotentHint: true },
    group: 'video',
    hidden: true, // founder 2026-08-05: hide video everywhere — callable, not advertised (tsk_9a68e374)
    core: true,
    coreRank: 101,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const pid = encodeURIComponent(args.project_id as string);
        const lim = args.limit ? `&limit=${args.limit}` : '';
        result = await callAPI(fetcher, 'GET', `/v1/video?project_id=${pid}${lim}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'video_get',
    description: `Get metadata and streaming URLs (HLS/DASH) for a single video. Not plan-gated — video already uploaded stays readable on every plan (only new uploads need Pro or Scale). Ownership is verified via the \`user_id\` in metadata.

**Example:**

\`\`\`json
{ "id": "v_abc123" }
// Returns: { "id": "v_abc123", "status": "ready", "duration": 124.5, "hls_url": "https://...", "dash_url": "https://...", "thumbnail": "https://..." }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Video ID.' } },
      required: ['id'],
    },
  },
    annotations: { readOnlyHint: true, idempotentHint: true },
    group: 'video',
    hidden: true, // founder 2026-08-05: hide video everywhere — callable, not advertised (tsk_9a68e374)
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const id = encodeURIComponent(args.id as string);
        result = await callAPI(fetcher, 'GET', `/v1/video/${id}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'video_delete',
    description: 'Delete a video. Irreversible. Not plan-gated — an account can always remove video it owns, on every plan.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Video ID.' } },
      required: ['id'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    group: 'video',
    hidden: true, // founder 2026-08-05: hide video everywhere — callable, not advertised (tsk_9a68e374)
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const id = encodeURIComponent(args.id as string);
        result = await callAPI(fetcher, 'DELETE', `/v1/video/${id}`, authHeader);
        return result;

      }
    },
  },
  // ── inbox ─────────────────────────────────────────────
  {
    definition: {
    name: 'inbox_create_address',
    description: `Create an inbox address on a verified, email-routing-enabled custom domain. Defaults to kind="admin" so the address appears in the project's Email tab in the dashboard. Pass kind="app" when minting per-user mailboxes from app code that shouldn't pollute the admin view. Optional webhook_url receives HMAC-signed inbox.message.received events — the POST body is \`{ schema_version: 2, type: "inbox.message.received", message: {...} }\`, with \`event\`/\`data\` aliases (identical to \`type\`/\`message\`) kept for compatibility with handlers written against the original payload shape; webhook_secret is returned once on creation. Optional forward_to also delivers a copy of every inbound message to an external mailbox (the user's real Gmail/Outlook) — see inbox_forward_set for how confirmation works.

**Example:**

\`\`\`json
{ "project_id": "my-app", "address": "support@example.com", "label": "Support", "forward_to": "you@gmail.com" }
// Returns: { "id": "iba_...", "address": "support@example.com", "kind": "admin", "forward": { "forward_to": "you@gmail.com", "status": "pending_verification", "message": "…check your inbox and confirm…" } }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        address: { type: 'string', description: 'Full email address on a verified custom domain, e.g. support@example.com.' },
        label: { type: 'string', description: 'Optional display label.' },
        kind: { type: 'string', enum: ['admin', 'app'], description: '"admin" (default) = dashboard-visible mailbox; "app" = runtime-minted, hidden from the dashboard Email tab.' },
        webhook_url: { type: 'string', description: 'Optional https:// endpoint for signed inbound-message webhooks.' },
        forward_to: { type: 'string', description: 'Optional external mailbox to forward a copy of inbound mail to (e.g. "you@gmail.com"). The project inbox keeps a copy either way.' },
      },
      required: ['project_id', 'address'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    group: 'inbox',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', '/v1/inbox/addresses', authHeader, {
          project_id: args.project_id,
          address: args.address,
          label: args.label,
          kind: args.kind,
          webhook_url: args.webhook_url,
          forward_to: args.forward_to,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'inbox_addresses',
    description: 'List a project\'s configured inbox addresses. Defaults to kind="admin" (dashboard-managed mailboxes). Pass kind="app" to see runtime-minted ones, or kind="all" for both. Each row includes forward_to + forward_status ("active" | "pending_verification" | null) when forwarding is configured.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        kind: { type: 'string', enum: ['admin', 'app', 'all'], description: 'Filter by mailbox kind. Defaults to "admin".' },
      },
      required: ['project_id'],
    },
  },
    annotations: { readOnlyHint: true, idempotentHint: true },
    group: 'inbox',
    core: true,
    coreRank: 96,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const pid = encodeURIComponent(args.project_id as string);
        const kind = args.kind ? `&kind=${encodeURIComponent(args.kind as string)}` : '';
        result = await callAPI(fetcher, 'GET', `/v1/inbox/addresses?project_id=${pid}${kind}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'inbox_forward_set',
    description: `Forward a copy of every inbound message on an inbox address to an external mailbox (the user's real Gmail/Outlook/etc). The project inbox ALWAYS keeps its copy — forwarding is additive, not a redirect.

Returns status "active" (live now) or "pending_verification" — the destination mailbox received a one-time confirmation email and forwarding starts automatically once its link is clicked. The returned message states the required human verification. Re-call this tool (or inbox_addresses) later to see the status flip to active. Spam-suspect messages are kept in the inbox but never forwarded. Idempotent: call again to change the destination.`,
    inputSchema: {
      type: 'object',
      properties: {
        address_id: { type: 'string', description: 'Inbox address id (iba_… from inbox_addresses).' },
        forward_to: { type: 'string', description: 'External destination mailbox, e.g. "you@gmail.com".' },
      },
      required: ['address_id', 'forward_to'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    group: 'inbox',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const aid = encodeURIComponent(args.address_id as string);
        result = await callAPI(fetcher, 'POST', `/v1/inbox/addresses/${aid}/forward`, authHeader, {
          forward_to: args.forward_to,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'inbox_forward_remove',
    description: 'Stop forwarding an inbox address to an external mailbox. Inbound mail keeps landing in the project inbox as before.',
    inputSchema: {
      type: 'object',
      properties: {
        address_id: { type: 'string', description: 'Inbox address id (iba_… from inbox_addresses).' },
      },
      required: ['address_id'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    group: 'inbox',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const aid = encodeURIComponent(args.address_id as string);
        result = await callAPI(fetcher, 'DELETE', `/v1/inbox/addresses/${aid}/forward`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'inbox_delete_address',
    description: 'Delete an inbox address. Past messages to this address remain stored.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'inbox_address id from inbox_addresses.' } },
      required: ['id'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    group: 'inbox',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const id = encodeURIComponent(args.id as string);
        result = await callAPI(fetcher, 'DELETE', `/v1/inbox/addresses/${id}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'inbox_list',
    description: "List received messages, most recent first. Filter by address_id to scope to one inbox, unread:true to skip already-read messages, or q for free-text search across subject, body preview, and sender. Spam-suspect messages are hidden by default; pass include_spam:true to include them.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        address_id: { type: 'string', description: 'Optional: restrict to one address.' },
        unread: { type: 'boolean', description: 'Optional: only return messages with read_at IS NULL.' },
        include_spam: { type: 'boolean', description: 'Optional: include messages flagged as spam-suspect.' },
        q: { type: 'string', description: 'Optional: free-text search across subject, body preview, and mail_from. Tokens match as prefixes (typeahead-style).' },
        limit: { type: 'integer', description: '1–200, default 50.' },
      },
      required: ['project_id'],
    },
  },
    annotations: { readOnlyHint: true, idempotentHint: true },
    group: 'inbox',
    core: true,
    coreRank: 55,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const pid = encodeURIComponent(args.project_id as string);
        const aid = args.address_id ? `&address_id=${encodeURIComponent(args.address_id as string)}` : '';
        const unread = args.unread ? '&unread=1' : '';
        const includeSpam = args.include_spam ? '&include_spam=1' : '';
        const q = args.q ? `&q=${encodeURIComponent(args.q as string)}` : '';
        const lim = args.limit ? `&limit=${args.limit}` : '';
        result = await callAPI(fetcher, 'GET', `/v1/inbox?project_id=${pid}${aid}${unread}${includeSpam}${q}${lim}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'inbox_get',
    description: `Fetch one received message: headers, preview text, attachments metadata, and URLs to download raw MIME or individual attachments. Pass include_html:true to get the full HTML body alongside the text preview.

**Example:**

\`\`\`json
{ "id": "msg_abc", "include_html": true }
// Returns: { "from": "customer@example.com", "subject": "Help with billing", "text_preview": "Hi, I need help with...", "html_preview": "<p>Hi…</p>", "attachments": [{ "filename": "invoice.pdf", "content_type": "application/pdf", "size_bytes": 21034 }], "received_at": "2026-04-20T...", "raw_url": "/v1/inbox/msg_abc/raw" }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Message id returned from inbox_list.' },
        include_html: { type: 'boolean', description: 'Include the parsed HTML body (capped at ~50KB).' },
      },
      required: ['id'],
    },
  },
    annotations: { readOnlyHint: true, idempotentHint: true },
    group: 'inbox',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const id = encodeURIComponent(args.id as string);
        const qs = args.include_html ? '?include=html' : '';
        result = await callAPI(fetcher, 'GET', `/v1/inbox/${id}${qs}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'inbox_mark_read',
    description: 'Mark a received message as read (or unread with read:false). Idempotent — calling again with read:true keeps it read.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Message id from inbox_list.' },
        read: { type: 'boolean', description: 'Defaults to true. Pass false to clear the read flag.' },
      },
      required: ['id'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    group: 'inbox',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const id = encodeURIComponent(args.id as string);
        const read = args.read === false ? false : true;
        result = await callAPI(fetcher, 'POST', `/v1/inbox/${id}/read`, authHeader, { read });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'inbox_attachment',
    description: 'Stream a single attachment from a received message. Returns the binary contents with the original content type and filename. Use the index from the `attachments` array on `inbox_get`.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Message id from inbox_list.' },
        index: { type: 'integer', description: 'Zero-based attachment index from inbox_get.attachments.' },
      },
      required: ['id', 'index'],
    },
  },
    annotations: { readOnlyHint: true, idempotentHint: true },
    group: 'inbox',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const id = encodeURIComponent(args.id as string);
        const idx = Number(args.index);
        result = await callAPI(fetcher, 'GET', `/v1/inbox/${id}/attachments/${idx}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'inbox_delete',
    description: 'Delete a received message and its stored raw content.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Message id.' } },
      required: ['id'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    group: 'inbox',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const id = encodeURIComponent(args.id as string);
        result = await callAPI(fetcher, 'DELETE', `/v1/inbox/${id}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'inbox_reply',
    description: 'Reply to an inbound message in one call. Sends from the same address that originally received the message, threads correctly via In-Reply-To / References headers, and re-prefixes the subject. Requires the receiving domain to be verified as a sender domain on the project (so the reply is signed and deliverable).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Inbox message id (from inbox_list).' },
        body: { type: 'string', description: 'Reply text. Alias for text — pick whichever reads better in your prompt.' },
        text: { type: 'string', description: 'Plain-text body. At least one of text/body/html is required.' },
        html: { type: 'string', description: 'HTML body. At least one of text/body/html is required.' },
        subject: { type: 'string', description: 'Override the subject. Default: original prefixed with "Re:".' },
      },
      required: ['id'],
    },
  },
    annotations: { title: 'Reply to a message', readOnlyHint: false, openWorldHint: true },
    group: 'inbox',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const id = encodeURIComponent(args.id as string);
        result = await callAPI(fetcher, 'POST', `/v1/inbox/${id}/reply`, authHeader, {
          body: args.body,
          text: args.text,
          html: args.html,
          subject: args.subject,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'inbox_send',
    description: 'Send a fresh email from an inbox address (compose-new, not a reply). Use this when starting a new conversation from hello@yourdomain.com — sw.inbox.reply is for replies, sw.inbox.send is for new threads. Records a Message-ID so future replies thread back automatically. The address\'s domain must be verified as a sender domain on the project.',
    inputSchema: {
      type: 'object',
      properties: {
        address_id: { type: 'string', description: 'Inbox address id (from inbox_addresses).' },
        to: { type: 'string', description: 'Recipient email address.' },
        subject: { type: 'string', description: 'Subject line.' },
        body: { type: 'string', description: 'Body text. Alias for text.' },
        text: { type: 'string', description: 'Plain-text body.' },
        html: { type: 'string', description: 'HTML body. At least one of text/body/html is required.' },
      },
      required: ['address_id', 'to', 'subject'],
    },
  },
    annotations: { readOnlyHint: false, openWorldHint: true },
    group: 'inbox',
    core: true,
    coreRank: 97,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const aid = encodeURIComponent(args.address_id as string);
        result = await callAPI(fetcher, 'POST', `/v1/inbox/addresses/${aid}/send`, authHeader, {
          to: args.to,
          subject: args.subject,
          body: args.body,
          text: args.text,
          html: args.html,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'inbox_threads',
    description: 'List conversation threads grouped across inbound + outbound mail on the project. Each thread aggregates received messages (from inbox_messages) and sent messages (replies + composed new). Default-hides messages flagged spam_suspect; pass include_spam:true to include them.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        address_id: { type: 'string', description: 'Optional: scope to threads involving one inbox address.' },
        include_spam: { type: 'boolean', description: 'Include threads whose latest inbound message is spam-suspect.' },
        limit: { type: 'integer', description: '1–200, default 50.' },
      },
      required: ['project_id'],
    },
  },
    annotations: { title: 'List inbox threads', readOnlyHint: true, idempotentHint: true },
    group: 'inbox',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const pid = encodeURIComponent(args.project_id as string);
        const aid = args.address_id ? `&address_id=${encodeURIComponent(args.address_id as string)}` : '';
        const spam = args.include_spam ? '&include_spam=1' : '';
        const lim = args.limit ? `&limit=${args.limit}` : '';
        result = await callAPI(fetcher, 'GET', `/v1/inbox/threads?project_id=${pid}${aid}${spam}${lim}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'inbox_thread_get',
    description: 'Fetch every message in one thread — inbound + outbound — in chronological order. Use the `thread_root` returned by inbox_threads or inbox_get.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        root: { type: 'string', description: 'thread_root value from inbox_threads or inbox_get. Includes the angle brackets.' },
      },
      required: ['project_id', 'root'],
    },
  },
    annotations: { readOnlyHint: true, idempotentHint: true },
    group: 'inbox',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const pid = encodeURIComponent(args.project_id as string);
        const root = encodeURIComponent(args.root as string);
        result = await callAPI(fetcher, 'GET', `/v1/inbox/threads/by-root?project_id=${pid}&root=${root}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'inbox_rule_list',
    description: 'List allow/deny sender rules. Allow rules whitelist senders that would otherwise be marked spam_suspect (e.g. legitimate senders with broken DMARC). Deny rules blacklist senders that pass auth checks but you still don\'t want.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        address_id: { type: 'string', description: 'Optional: scope to one inbox address. Returns project-wide rules too.' },
      },
      required: ['project_id'],
    },
  },
    annotations: { readOnlyHint: true, idempotentHint: true },
    group: 'inbox',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const pid = encodeURIComponent(args.project_id as string);
        const aid = args.address_id ? `&address_id=${encodeURIComponent(args.address_id as string)}` : '';
        result = await callAPI(fetcher, 'GET', `/v1/inbox/rules?project_id=${pid}${aid}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'inbox_rule_create',
    description: 'Create an allow or deny sender rule. pattern can be a full email ("spam@evil.com") for exact mailbox match, or a domain ("evil.com") for domain + subdomain match. allow rules win against deny rules and against the auth-results spam check.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        address_id: { type: 'string', description: 'Optional: scope to one inbox address. Omit for project-wide.' },
        pattern: { type: 'string', description: 'Email address (exact) or domain (suffix match).' },
        action: { type: 'string', description: 'allow whitelists; deny blacklists. Accepted values: "allow", "deny".' },
      },
      required: ['project_id', 'pattern', 'action'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    group: 'inbox',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', '/v1/inbox/rules', authHeader, {
          project_id: args.project_id,
          address_id: args.address_id,
          pattern: args.pattern,
          action: args.action,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'inbox_rule_delete',
    description: 'Delete an allow/deny sender rule by id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Rule id from inbox_rule_list.' } },
      required: ['id'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    group: 'inbox',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const id = encodeURIComponent(args.id as string);
        result = await callAPI(fetcher, 'DELETE', `/v1/inbox/rules/${id}`, authHeader);
        return result;

      }
    },
  },
  // ── calls ─────────────────────────────────────────────
  {
    definition: {
    name: 'calls_new_session',
    description: `Create a new voice/video session. Returns a \`session_id\` the client uses for subsequent track operations (add/remove audio and video tracks). Session lifecycle is managed by the platform — store the session_id client-side.

**Example:**

\`\`\`json
{ "project_id": "my-saas" }
// Returns: { "session_id": "sess_abc123" }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        thirdparty: { type: 'boolean', description: 'If true, the session is treated as pure data relay (no platform-originated media tracks).' },
      },
      required: ['project_id'],
    },
  },
    annotations: { readOnlyHint: false, openWorldHint: true },
    group: 'calls',
    core: true,
    coreRank: 69,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', '/v1/calls/sessions', authHeader, {
          project_id: args.project_id,
          thirdparty: args.thirdparty,
        });
        return result;

      }
    },
  },
  // ── tasks ─────────────────────────────────────────────
  {
    definition: {
    name: 'tasks_create',
    description: `Create a task in a project. Tasks are per-project tickets — useful for bugs, todos, or end-user-filed feedback inside your app. Tasks live in the project's own database.

**Example:**

\`\`\`json
{
  "project_id": "my-saas",
  "title": "Fix login redirect",
  "description": "After OAuth, users land on /home instead of /dashboard.",
  "priority": "high",
  "labels": ["bug", "auth"]
}
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, you don't need to look up the UUID. Use 'default' (or 'spine') to target the org's shared atomic task board; this is the right value for the platform's own dogfood/resolution-note workflow." },
        title: { type: 'string', description: 'Short summary, required.' },
        description: { type: 'string', description: 'Long-form body.' },
        status: { type: 'string', enum: ['backlog', 'open', 'in_progress', 'blocked', 'needs_review', 'done', 'archived'], description: "Defaults to 'open'. Use 'backlog' for raw ideas that haven't been triaged yet — devs filter them out with status='open'. Use 'blocked' when external action is required, 'needs_review' when work is done but waiting on sign-off." },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'], description: "Defaults to 'normal'." },
        type: { type: 'string', description: "Defaults to 'task'. Classifies the row across the org spine: philosophy, roadmap, epic, task, bug, directive, report, spec — or whatever fits; type is a filter, not a taxonomy." },
        assignee: { type: 'string', description: 'Free-form assignee (user ID, email, or label).' },
        reporter: { type: 'string', description: 'Optional reporter override; defaults to the caller.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Tag labels for filtering. Task OS recognizes explicit opt-ins requires-deployment, requires-smoke-test, and requires-resolution-note as completion guidance. In v1 only requires-deployment has machine-verifiable evidence and blocks close; freeform prose never activates a gate.' },
        due_at: { type: 'number', description: 'Optional Unix timestamp (ms).' },
        area: { type: 'string', description: 'Optional subsystem tag (free-form, e.g. "billing", "auth", "ui") for filtering related tasks.' },
        parent_id: { type: 'string', description: 'Optional parent task ID — makes this a sub-task of the given task.' },
        attachments: { type: 'array', items: { type: 'string' }, description: 'sw.fs paths to attach to this task (screenshots, logs, repro files). Each path is a string like "/uploads/screenshot.png" — not a full URL. Max 25 per task.' },
        template: { type: 'string', enum: ['bug', 'feature', 'incident', 'security', 'docs', 'chore'], description: 'Optional template — fills priority/labels/area/description with sensible defaults. Caller-provided fields always win over template defaults. Use `tasks_templates` to inspect each template before picking.' },
      },
      required: ['project_id', 'title'],
    },
  },
    annotations: { title: 'Create a task', readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    group: 'tasks',
    core: true,
    coreRank: 42,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","chatgpt","connector"],
    protocol: { surfaceDescriptions: { connector: "Create a task with its description, metadata, and optional authorized file attachments." }, surfaceAnnotations: { chatgpt: { openWorldHint: true }, connector: {"title":"Tasks Create","readOnlyHint":false,"destructiveHint":true} },  oauthScopes: ['mcp'] },
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', '/v1/tasks', authHeader, {
          project_id: args.project_id,
          title: args.title,
          description: args.description,
          status: args.status,
          priority: args.priority,
          type: args.type,
          assignee: args.assignee,
          reporter: args.reporter,
          labels: args.labels,
          due_at: args.due_at,
          area: args.area,
          parent_id: args.parent_id,
          attachments: args.attachments,
          template: args.template,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'tasks_templates',
    description: 'List the predefined task templates. Each entry shows the priority / labels / area / description the template would fill in if used. Pass the `key` to `tasks_create` as the `template` arg.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
    annotations: { readOnlyHint: true, idempotentHint: true },
    group: 'tasks',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'GET', `/v1/tasks/templates`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'tasks_bulk_update',
    description: 'Apply the same field changes to many tasks in one call (cap 100 per call). One request → one batch DB write per target + one activity-log row per changed field. Failures are returned per-task so partial errors do not roll back the whole batch.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project that owns the tasks — UUID, subdomain, or slug. Use 'default' (or 'spine') for the org's shared atomic task board." },
        task_ids: { type: 'array', items: { type: 'string' }, description: 'Task IDs to update (1–100).' },
        updates: {
          type: 'object',
          description: 'Field changes to apply to every listed task. At least one of status/priority/assignee/labels/area/parent_id is required.',
          properties: {
            status: { type: 'string', enum: ['backlog', 'open', 'in_progress', 'blocked', 'needs_review', 'done', 'archived'] },
            priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
            assignee: { type: 'string' },
            labels: { type: 'array', items: { type: 'string' } },
            area: { type: 'string' },
            parent_id: { type: 'string' },
          },
        },
      },
      required: ['project_id', 'task_ids', 'updates'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    group: 'tasks',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', `/v1/tasks/bulk-update`, authHeader, {
          project_id: args.project_id,
          task_ids: args.task_ids,
          updates: args.updates,
        });
        return result;

      }
    },
  },
  ...TASK_READ_TOOL_SPECS,
  {
    definition: {
    name: 'tasks_summary',
    description: 'At-a-glance ticket counts for a project with ZERO rows returned — total plus counts grouped by status, priority, area, and assignee, plus a stale count (in_progress tasks untouched beyond stale_days). Use this for a dashboard number ("urgent: 3, high: 28, blocked: 5") instead of listing every task; it scales to thousands of tickets. For the rows themselves, use tasks_list.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side. Use 'default' (or 'spine') to target the org's shared atomic task board." },
        stale_days: { type: 'number', description: 'Days without an update after which an in_progress task counts as stale (default 7).' },
      },
      required: ['project_id'],
    },
  },
    annotations: { title: 'Task counts summary', readOnlyHint: true, idempotentHint: true },
    group: 'tasks',
    core: true,
    coreRank: 41,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const q = new URLSearchParams({ project_id: String(args.project_id) });
        if (args.stale_days !== undefined) q.set('stale_days', String(args.stale_days));
        result = await callAPI(fetcher, 'GET', `/v1/tasks/summary?${q.toString()}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'tasks_reconcile',
    description: 'Reconcile Board proposal pass for Task OS. Scans active tasks, runs objective drift rules plus a bounded cheap classification pass, and returns proposed relationship/status/assignment/duplicate corrections. Proposal-only: applied is always false and this tool never changes tasks or edges. Review proposals and apply selected changes with tasks_update.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project whose task board to inspect. Use 'default' or 'spine' for the org spine." },
      },
      required: ['project_id'],
    },
  },
    annotations: { title: 'Propose board reconciliation', readOnlyHint: true, idempotentHint: false },
    group: 'tasks',
    core: true,
    coreRank: 44,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', '/v1/tasks/reconcile', authHeader, {
          project_id: args.project_id,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'tasks_update',
    description: "Update a task's fields, append a comment, or upload and attach authorized file references. Supply `comment` to add a comment without changing other fields. Status transitions to 'done' automatically stamp completed_at. **When closing a task (status: 'done'), always pass `resolution_note`** — it's persisted as a comment AND included in the resolution email/webhook so the reporter knows what was done. Omitting it on a task with no prior comments returns a non-blocking `hint` field nudging you to add one.\n\n**To report progress, set `status_note` (and `health`) — do NOT add a comment per step.** The three fields have distinct jobs: `description` is the living document (intent and contract, rewritten as the truth changes), `status_note` is the current state (overwritten each update, so one read tells you where things stand), and comments are append-only EVIDENCE — commit hashes, verification output, links. Appending status as comments is what makes a long-lived task unreadable: the thread renders oldest-first, so a reader meets the superseded version before the live one. Overwriting `status_note` loses nothing; the old value is kept in the activity log.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project that owns the task — UUID, subdomain, or slug. Use 'default' (or 'spine') for the org's shared atomic task board." },
        task_id: { type: 'string', description: 'The task ID.' },
        title: { type: 'string', description: 'New title.' },
        description: { type: 'string', description: 'New description.' },
        status: { type: 'string', enum: ['backlog', 'open', 'in_progress', 'blocked', 'needs_review', 'done', 'archived'], description: "New status. Use 'blocked' when external action is required, 'needs_review' when work is done but waiting on sign-off." },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'], description: 'New priority.' },
        type: { type: 'string', description: "New type. House vocab: philosophy, roadmap, epic, task, bug, directive, report, spec — or whatever fits; type is a filter, not a taxonomy. Empty value is a no-op (type can't be cleared)." },
        superseded_by: { type: 'string', description: 'Task ID of the row that replaces this one (a newer spec, a corrected directive). Empty string clears it.' },
        shipped_in: { type: 'string', description: 'The deploy/version this work shipped in — a freeform tag you read from the deploy object at ship time (e.g. "v7"). Tagging it lets the reports under this task surface for review-for-closure. Empty string clears it.' },
        status_note: { type: 'string', description: 'CURRENT STATE — one short paragraph answering "what is true right now", OVERWRITTEN each time rather than appended. This is the field to update as work progresses; do NOT add a new comment per step, which is what turns a long-lived task into an unreadable chronological tail. The previous value is kept in the activity log, so overwriting loses nothing. Capped at 2000 chars: it is a status line, not a document — the document is `description`. Empty string clears it.' },
        health: { type: 'string', enum: ['on_track', 'at_risk', 'off_track'], description: 'Structured signal for how the work is GOING, independent of where it sits (`status`). A task can be in_progress and off_track at once. Leave unset when nobody has assessed it — absent reads differently from someone asserting it is fine. Pass null to clear.' },
        assignee: { type: 'string', description: 'New assignee.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Replacement labels list. Task OS completion guidance is explicit-label-only; in v1 requires-deployment is the machine-enforced gate.' },
        due_at: { type: 'number', description: 'Unix timestamp (ms), or null to clear.' },
        area: { type: 'string', description: 'New subsystem tag, or empty string to clear.' },
        parent_id: { type: 'string', description: 'New parent task ID, or empty string to detach. A task may not be its own parent.' },
        attachments: { type: 'array', items: { type: 'string' }, description: 'Replace the task attachments (sw.fs paths). Pass an empty array to clear.' },
        upload_attachments: {
          type: 'array',
          description: 'Native connector files to upload and append in this call. ChatGPT supplies a top-level array of authorized file-reference objects through openai/fileParams. Each file is stored privately under /tasks/{task_id}/attachments/<name>; saved sw.fs paths are returned and appended. Binary bytes never enter model context. Do not pass path/base64 strings here.',
          items: {
            type: 'object',
            properties: {
              download_url: { type: 'string', description: 'Temporary connector-authorized download URL.' },
              file_id: { type: 'string', description: 'Connector file identifier.' },
              mime_type: { type: 'string', description: 'Connector-provided MIME type, when available.' },
              file_name: { type: 'string', description: 'Original filename, when available.' },
            },
            required: ['download_url', 'file_id'],
          },
        },
        comment: { type: 'string', description: 'If supplied, appends a comment with this body.' },
        author: { type: 'string', description: 'Optional display label to attribute the comment to (e.g. "bus", "sw-tasks-dx", "Uzair"). Lets many entities that share one account self-identify on the thread. Only used when `comment` is supplied; defaults to the account.' },
        resolution_note: { type: 'string', description: "When closing a task (status='done'), the short explanation of what was done. Persisted as a comment and included in the resolution notification email + webhook payload. Strongly recommended whenever you set status to 'done'." },
        deployment_project_id: { type: 'string', description: "The project whose successful deploy proves this work is live — ID, subdomain, or slug. It does not have to be the project that owns the task, and on the shared board it never is (the board holds no deploys of its own). Defaults to the task's project. You must have access to it." },
        deployment_version: { type: 'number', description: 'Successful production version number of deployment_project_id, verified before the task is updated or closed. Read it from project_deploys for that project.' },
        relationship: {
          type: 'object',
          description: 'Add one typed relationship from this task to another task in the same project.',
          properties: {
            type: { type: 'string', enum: ['child_of', 'discovered_by', 'implements', 'blocked_by', 'duplicate_of', 'supersedes'] },
            task_id: { type: 'string', description: 'Related task id in the same project.' },
          },
          required: ['type', 'task_id'],
        },
        remove_relationship_id: { type: 'string', description: 'Delete one explicit relationship by id. parent_id-backed child_of edges must be removed by clearing parent_id.' },
      },
      required: ['project_id', 'task_id'],
    },
    _meta: { 'openai/fileParams': ['upload_attachments'] },
  },
    annotations: { title: 'Update a task', readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    group: 'tasks',
    core: true,
    coreRank: 43,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","chatgpt","connector"],
    protocol: { surfaceDescriptions: { connector: "Update a task, append a comment, or attach authorized files. Supplied fields change the task; omitted fields remain unchanged. A resolution_note records the outcome when closing a task." }, surfaceAnnotations: { chatgpt: { destructiveHint: true, openWorldHint: true }, connector: {"title":"Tasks Update","readOnlyHint":false,"destructiveHint":true} },  oauthScopes: ['mcp'] },
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const id = encodeURIComponent(args.task_id as string);
        let uploadedAttachmentPaths: string[] = [];
        const uploadedAttachmentRecords: StorageRecord[] = [];

        if (args.upload_attachments !== undefined) {
          try {
            const files: ConnectorFileReference[] = parseConnectorFileReferences(args.upload_attachments);
            const projectRef = encodeURIComponent(String(args.project_id));
            const taskResponse = await callAPI(
              fetcher,
              'GET',
              `/v1/tasks/${id}?project_id=${projectRef}`,
              authHeader,
            );
            if (taskResponse.status >= 400) {
              result = taskResponse;
              return result;
            }
            const task = envelopeDataObject(taskResponse.data);
            const canonicalTaskId = task && typeof task.id === 'string' ? task.id : null;
            const canonicalProjectId = task && typeof task.project_id === 'string' ? task.project_id : null;
            const allowedActions = task && Array.isArray(task.allowed_actions) ? task.allowed_actions : [];
            if (!canonicalTaskId || !canonicalProjectId) {
              return fileUploadToolError(new FileUploadError(
                'TASK_UPLOAD_CONTEXT_INVALID',
                'The task service did not return canonical task and project identifiers.',
                502,
                taskResponse.data,
              ));
            }
            if (!allowedActions.includes('update')) {
              return fileUploadToolError(new FileUploadError(
                'FORBIDDEN',
                'Editor access is required to upload task attachments.',
                403,
              ));
            }

            const existingAttachments = task && Array.isArray(task.attachments)
              ? task.attachments.filter((item): item is string => typeof item === 'string')
              : [];
            const requestedAttachments = args.attachments === undefined
              ? existingAttachments
              : Array.isArray(args.attachments)
                ? args.attachments.filter((item): item is string => typeof item === 'string')
                : [];
            uploadedAttachmentPaths = taskAttachmentPaths(canonicalTaskId, files);
            const prospectiveAttachments = [...new Set([...requestedAttachments, ...uploadedAttachmentPaths])];
            if (prospectiveAttachments.length > 25) {
              return fileUploadToolError(new FileUploadError(
                'TASK_ATTACHMENTS_LIMIT',
                'A task may have at most 25 attachments.',
                400,
              ));
            }

            for (let index = 0; index < files.length; index++) {
              const file = files[index];
              const path = uploadedAttachmentPaths[index];
              const contentType = resolveUploadContentType(undefined, file, path);
              const mint = await mintUploadRelay(
                fetcher,
                authHeader,
                canonicalProjectId,
                path,
                contentType,
                false,
              );
              const record = await streamConnectorFileToUpload(
                fetcher,
                mint.url,
                file,
                contentType,
                undefined,
                mint.max_size,
              );
              if (record.path !== path) {
                return fileUploadToolError(new FileUploadError(
                  'TASK_ATTACHMENT_PATH_MISMATCH',
                  'The upload relay stored a task attachment at an unexpected path.',
                  502,
                  record,
                ));
              }
              uploadedAttachmentRecords.push(record);
            }
          } catch (error) {
            if (error instanceof FileUploadError) return fileUploadToolError(error);
            throw error;
          }
        }

        // Combined "update OR comment" affordance — fewer tools to memorize.
        // If `comment` is supplied, post it; if other fields are supplied,
        // PATCH them. At least one of the two paths always runs (caller
        // must pass *something* to make this tool useful).
        let didWork = false;
        result = { status: 200, data: { ok: true } };
        // deployment_project_id / deployment_version ride the PATCH itself
        // (below) rather than a separate pre-call: the closure gate has to read
        // the evidence THIS request supplied, not a value an earlier request
        // wrote and this one read back (pfb_750993037c77). The dedicated
        // POST /v1/tasks/:id/link-deployment endpoint is unchanged for callers
        // that link without closing.
        if (args.relationship && typeof args.relationship === 'object') {
          const relationship = args.relationship as Record<string, unknown>;
          result = await callAPI(fetcher, 'POST', `/v1/tasks/${id}/relationships`, authHeader, {
            project_id: args.project_id,
            type: relationship.type,
            task_id: relationship.task_id,
          });
          didWork = true;
          if (result.status >= 400) return result;
        }
        if (typeof args.remove_relationship_id === 'string' && args.remove_relationship_id) {
          const edgeId = encodeURIComponent(args.remove_relationship_id);
          const pid = encodeURIComponent(String(args.project_id));
          result = await callAPI(fetcher, 'DELETE', `/v1/tasks/${id}/relationships/${edgeId}?project_id=${pid}`, authHeader);
          didWork = true;
          if (result.status >= 400) return result;
        }
        if (args.comment) {
          result = await callAPI(fetcher, 'POST', `/v1/tasks/${id}/comments`, authHeader, {
            project_id: args.project_id,
            body: args.comment,
            author: args.author,
          });
          didWork = true;
        }
        const patchBody: Record<string, unknown> = { project_id: args.project_id };
        for (const f of ['title', 'description', 'status', 'priority', 'type', 'assignee', 'labels', 'due_at', 'area', 'parent_id', 'superseded_by', 'shipped_in', 'status_note', 'health', 'attachments', 'resolution_note', 'deployment_project_id', 'deployment_version']) {
          if (args[f] !== undefined) patchBody[f] = args[f];
        }
        if (uploadedAttachmentPaths.length > 0) {
          patchBody.append_attachments = uploadedAttachmentPaths;
        }
        if (Object.keys(patchBody).length > 1) {
          result = await callAPI(fetcher, 'PATCH', `/v1/tasks/${id}`, authHeader, patchBody);
          didWork = true;
        }
        if (!didWork) {
          result = { status: 400, data: { ok: false, error: 'VALIDATION_ERROR', message: 'Provide at least one field to update or a comment to append.' } };
        }
        if (result.status < 400 && uploadedAttachmentPaths.length > 0) {
          result = {
            ...result,
            data: attachSavedUploadResult(result.data, uploadedAttachmentPaths, uploadedAttachmentRecords),
          };
        }
        return result;

      }
    },
  },
  {
    definition: {
    name: 'tasks_comment_edit',
    description: 'Edit the body of a task comment. Permission: the account that wrote the comment, or the project owner. Sets an "edited" marker on the comment.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project that owns the task — UUID, subdomain, or slug. Use 'default' (or 'spine') for the org's shared atomic task board." },
        task_id: { type: 'string', description: 'The task the comment belongs to.' },
        comment_id: { type: 'string', description: 'The comment ID (starts with tcm_).' },
        body: { type: 'string', description: 'New comment body (must be non-empty).' },
      },
      required: ['project_id', 'task_id', 'comment_id', 'body'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    group: 'tasks',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const id = encodeURIComponent(args.task_id as string);
        const cid = encodeURIComponent(args.comment_id as string);
        result = await callAPI(fetcher, 'PATCH', `/v1/tasks/${id}/comments/${cid}`, authHeader, {
          project_id: args.project_id,
          body: args.body,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'tasks_comment_delete',
    description: 'Delete a task comment. Permission: the account that wrote the comment, or the project owner. Hard delete — not reversible.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project that owns the task — UUID, subdomain, or slug. Use 'default' (or 'spine') for the org's shared atomic task board." },
        task_id: { type: 'string', description: 'The task the comment belongs to.' },
        comment_id: { type: 'string', description: 'The comment ID (starts with tcm_).' },
      },
      required: ['project_id', 'task_id', 'comment_id'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    group: 'tasks',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const id = encodeURIComponent(args.task_id as string);
        const cid = encodeURIComponent(args.comment_id as string);
        const pid = encodeURIComponent(args.project_id as string);
        result = await callAPI(fetcher, 'DELETE', `/v1/tasks/${id}/comments/${cid}?project_id=${pid}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'tasks_delete',
    description: 'Delete a task and its comments. Hard delete — not reversible.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project that owns the task — UUID, subdomain, or slug. Use 'default' (or 'spine') for the org's shared atomic task board." },
        task_id: { type: 'string', description: 'The task ID.' },
      },
      required: ['project_id', 'task_id'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    group: 'tasks',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const id = encodeURIComponent(args.task_id as string);
        const pid = encodeURIComponent(args.project_id as string);
        result = await callAPI(fetcher, 'DELETE', `/v1/tasks/${id}?project_id=${pid}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'tasks_settings_get',
    description: 'Read notification settings for a project. Returns webhook_url and notify_email (nulls when unset). The webhook_secret itself is not returned — it is only surfaced once at tasks_settings_update time when first generated.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project to read settings for.' },
      },
      required: ['project_id'],
    },
  },
    annotations: { readOnlyHint: true, idempotentHint: true },
    group: 'tasks',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const pid = encodeURIComponent(args.project_id as string);
        result = await callAPI(fetcher, 'GET', `/v1/tasks/settings?project_id=${pid}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'tasks_settings_update',
    description: 'Configure where task events are delivered. Set webhook_url to receive signed POSTs (X-Somewhere-Signature: t=<ms>,v1=<hmac-sha256-hex>) and/or notify_email to receive emails. Pass an empty string to clear a field. The first time webhook_url is set, the response includes webhook_secret exactly once — store it server-side to verify the signature.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project to update settings for.' },
        webhook_url: { type: 'string', description: 'HTTPS URL receiving task event POSTs. Empty string clears it (also clears the secret).' },
        notify_email: { type: 'string', description: 'Email address that receives task event notifications. Empty string clears it.' },
      },
      required: ['project_id'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    group: 'tasks',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const patchBody: Record<string, unknown> = { project_id: args.project_id };
        if (args.webhook_url !== undefined) patchBody.webhook_url = args.webhook_url;
        if (args.notify_email !== undefined) patchBody.notify_email = args.notify_email;
        result = await callAPI(fetcher, 'PATCH', '/v1/tasks/settings', authHeader, patchBody);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'memory_save',
    description: "Log a principle/SOP/supplier/learning/content idea/vision/spec to the org's memory. Use at close-out when what-we-believe changes. Title states the claim as a sentence.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "The org-memory project (UUID, subdomain, slug, or 'default'). Resolved server-side." },
        title: { type: 'string', description: 'The claim, stated as a sentence. Required, non-empty.' },
        body: { type: 'string', description: 'Long-form detail. Reference related rows inline (their task IDs) — refs live in the body, not a separate field.' },
        type: { type: 'string', description: "Knowledge type. Defaults to 'learning'. Use what fits: philosophy, directive, spec, principle, sop, supplier, vision, content. Type is a filter, not a taxonomy." },
        area: { type: 'string', description: 'Optional subsystem tag for filtering (free-form).' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Optional tags for filtering.' },
      },
      required: ['project_id', 'title'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    group: 'tasks',
    core: true,
    coreRank: 45,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        // Thin wrapper on tasks_create — write a durable belief to the spine.
        // Require a non-empty title (the claim as a sentence); default the
        // type to a knowledge type.
        const title = typeof args.title === 'string' ? args.title.trim() : '';
        if (!title) {
          result = { status: 400, data: { ok: false, error: 'VALIDATION_ERROR', message: 'memory_save requires a non-empty title — state the claim as a sentence.' } };
          return result;
        }
        result = await callAPI(fetcher, 'POST', '/v1/tasks', authHeader, {
          project_id: args.project_id,
          title,
          description: args.body,
          type: (typeof args.type === 'string' && args.type.trim()) ? args.type.trim() : 'learning',
          area: args.area,
          labels: args.labels,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'memory_search',
    description: "Search the org's memory before building, when unsure about a past call, or when the founder references something not in context.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "The org-memory project (UUID, subdomain, slug, or 'default'). Resolved server-side." },
        q: { type: 'string', description: 'Text to search over title + description. Omit to list the whole memory.' },
        type: { type: 'string', description: 'Narrow to one knowledge type (e.g. "directive"). Omit to search across the durable knowledge types (philosophy, directive, spec, learning, principle, sop, supplier, vision, content, roadmap, epic).' },
        include_archived: { type: 'boolean', description: 'Default false — superseded/archived rows are hidden. Pass true to include them.' },
        limit: { type: 'number', description: 'Max rows to return (default 100, cap 500).' },
      },
      required: ['project_id'],
    },
  },
    annotations: { readOnlyHint: true, idempotentHint: true },
    group: 'tasks',
    core: true,
    coreRank: 46,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        // Thin wrapper on tasks_list — search the durable memory. Filtered to
        // the knowledge types and active-by-default (archived excluded unless
        // include_archived). An explicit `type` narrows to one type. The
        // knowledge-type set is memory_search's default SCOPE, not a server-enforced
        // taxonomy (the spine stays generic) — pass `type` to override.
        const KNOWLEDGE_TYPES = ['philosophy', 'directive', 'spec', 'learning', 'principle', 'sop', 'supplier', 'vision', 'content', 'roadmap', 'epic'];
        const q = new URLSearchParams({ project_id: String(args.project_id) });
        const typeArg = typeof args.type === 'string' && args.type.trim() ? args.type.trim() : '';
        q.set('type', typeArg || KNOWLEDGE_TYPES.join(','));
        if (args.q) q.set('q', String(args.q));
        if (args.include_archived === true) q.set('include_archived', 'true');
        if (args.limit !== undefined) q.set('limit', String(args.limit));
        result = await callAPI(fetcher, 'GET', `/v1/tasks?${q.toString()}`, authHeader);
        return result;

      }
    },
  },
  // ── artifacts ─────────────────────────────────────────────
  {
    definition: {
    name: 'artifact_publish',
    description: `Publish a project file as an immutable ARTIFACT — a durable, addressable snapshot with typed metadata, so another agent (or a human) can consume exactly these bytes later without you re-describing the file through a context window.

A file path is mutable: a later write replaces the bytes and old versions get trimmed. Publishing freezes "the file at /specs/plan.md right now" into a fact — the bytes are copied to the artifact's own storage and the row records who produced it. It never changes; a new version is a new artifact whose \`supersedes\` points at the old one.

Returns \`{ id, uri, ... }\` where \`uri\` is \`sw://{project}/artifact/{id}\` — hand THAT to the next agent. They call \`artifact_get\` on it and see the title + summary + schema (enough to decide read-or-skip) and, on request, the exact frozen bytes.

Publishes an EXISTING file — write it first (fs_write / fs_upload), then publish.

**Example:**
\`\`\`json
{
  "project_id": "acme",
  "path": "/specs/checkout.md",
  "title": "Checkout redesign spec",
  "summary": "Final 2-step checkout spec; supersedes the v1 draft; ready to implement.",
  "schema": "sw.design-doc@1",
  "agent": "cursor"
}
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Project that owns the file — UUID, subdomain, or slug. Resolved server-side.' },
        path: { type: 'string', description: 'Path of the existing project file to publish, e.g. "/specs/checkout.md".' },
        title: { type: 'string', description: 'Short human/agent-legible name for the artifact. Required.' },
        summary: { type: 'string', description: 'Up to ~1024 chars. THE anti-context-burn field — a consumer decides whether to read the full bytes from this alone. Say what it is and whether it is ready to act on.' },
        schema: { type: 'string', description: "Typed contract id, e.g. 'sw.design-doc@1', 'sw.review-findings@1'. Lets the consumer parse/validate without conversation. Free-form tag; unknown ids are allowed." },
        agent: { type: 'string', description: "The producer's self-declared label — 'cursor', 'claude-code', 'chatgpt', 'human', etc. Travels with the artifact as provenance. Required. (The authenticated account is recorded separately, server-set.)" },
        media_type: { type: 'string', description: "Override the stored media type; defaults to the file's own content type." },
        derived_from: { type: 'array', items: { type: 'string' }, description: 'Artifact ids this was produced from — builds the provenance DAG. Each must be an existing artifact id.' },
        supersedes: { type: 'string', description: 'Artifact id in THIS project that this new version replaces. The old artifact is left untouched.' },
      },
      required: ['project_id', 'path', 'title', 'agent'],
    },
  },
    annotations: { title: 'Publish a file as an artifact', readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    group: 'artifacts',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', '/v1/artifacts', authHeader, {
          project: args.project_id,
          path: args.path,
          title: args.title,
          summary: args.summary,
          schema: args.schema,
          agent: args.agent,
          media_type: args.media_type,
          derived_from: args.derived_from,
          supersedes: args.supersedes,
        });
        return result;

      }
    },
  },
  {
    definition: {
    name: 'artifact_get',
    description: `Fetch a published artifact by its id or \`sw://…\` URI — metadata + provenance by default, or the exact immutable bytes with \`include_content: true\`.

This is the consume side of a handoff: another agent published a file and handed you \`sw://{project}/artifact/{id}\`. You get the title, summary, schema, size, and who produced it (\`agent\` + \`derived_from\`/\`supersedes\`) — enough to decide read-or-skip WITHOUT the producer re-describing it. Pass \`include_content: true\` to also pull the frozen bytes (text is inlined; the bytes are the exact ones from publish time, even if the source file has since changed).

Resolves across projects: any principal with access to the artifact's OWN project can fetch it, which raw file paths can never do.

**Example:** \`{ "id": "sw://acme/artifact/art_9f2c…" }\` or \`{ "id": "art_9f2c…", "include_content": true }\``,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Artifact id (art_…) or a full sw://{project}/artifact/{id} URI.' },
        include_content: { type: 'boolean', description: 'Default false (metadata + provenance only — cheap). Pass true to also fetch the frozen bytes; text content is inlined (truncated past ~50k chars).' },
      },
      required: ['id'],
    },
  },
    annotations: { title: 'Fetch a published artifact', readOnlyHint: true, idempotentHint: true },
    group: 'artifacts',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, env, authHeader, ctx, toolName } = runtime;
      let result: ToolUpstreamResult;
      {
        const raw = typeof args.id === 'string' ? args.id.trim() : '';
        if (!raw) {
          return badArgsToolResult(
            env, authHeader, ctx, toolName, args,
            'artifact_get requires an artifact id.\nExample:\nartifact_get({ "id": "art_abc123" })  — or a full sw://project/artifact/art_… URI.',
          );
        }
        const metaPath = raw.startsWith('sw://')
          ? `/v1/artifacts/resolve?uri=${encodeURIComponent(raw)}`
          : `/v1/artifacts/${encodeURIComponent(raw)}`;
        result = await callAPI(fetcher, 'GET', metaPath, authHeader);

        // Optionally inline the frozen bytes. Metadata carries the media type,
        // so we only pull + inline text; binary is reported, never dumped into
        // context (the fs_upload philosophy). The bytes come from the immutable
        // artifacts/{id} copy, so they are what was published, not the current
        // source file.
        if (args.include_content === true && result.status === 200
            && result.data && typeof result.data === 'object' && 'data' in result.data) {
          const meta = (result.data as { data: Record<string, unknown> }).data;
          const artId = typeof meta.id === 'string' ? meta.id : null;
          if (artId) {
            const mediaType = typeof meta.media_type === 'string' ? meta.media_type : '';
            const isText = /^text\//i.test(mediaType)
              || /(json|markdown|xml|javascript|typescript|yaml|csv|html|svg)/i.test(mediaType);
            const cresp = await fetcher.fetch(
              `https://api-internal/v1/artifacts/${encodeURIComponent(artId)}/content`,
              { method: 'GET', headers: { 'Authorization': authHeader } },
            );
            if (!cresp.ok) {
              meta.content_error = `Could not fetch content (status ${cresp.status}).`;
            } else if (isText) {
              // Bound the read (finding 6): pull at most CAP bytes off the
              // stream, then cancel — never buffer a whole large text artifact
              // into the worker just to slice it down to 50k chars. CAP is the
              // byte upper bound for 50k UTF-8 chars.
              const CAP = 200_000;
              let text = '';
              let truncated = false;
              const reader = cresp.body?.getReader();
              if (reader) {
                const decoder = new TextDecoder();
                let got = 0;
                for (;;) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  // Decode only up to the remaining budget from THIS chunk — a
                  // producer can hand back the whole artifact in one giant chunk,
                  // so appending all of `value` before the cap check would buffer
                  // the entire body (finding 6/r6). Slice, then cancel.
                  const remaining = CAP - got;
                  const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
                  if (value.byteLength > remaining) truncated = true;
                  got += chunk.byteLength;
                  text += decoder.decode(chunk, { stream: true });
                  if (got >= CAP) { truncated = true; await reader.cancel(); break; }
                }
                text += decoder.decode();
              }
              meta.content = text.slice(0, 50000);
              meta.content_truncated = truncated || text.length > 50000;
            } else {
              meta.content_note = `Binary content (${mediaType || 'unknown type'}, ${meta.size_bytes ?? '?'} bytes) is not inlined.`;
            }
          }
        }
        return result;

      }
    },
  },
  // ── smoke ─────────────────────────────────────────────
  {
    definition: {
    name: 'site_check_status',
    description: `Get the latest smoke-test run for a project plus a short history. Smoke runs are auto-wired — homepage and any attached custom domains are probed every ~20 min and after every deploy. Status is "pass" / "fail" / "partial". Each run includes per-target details (URL, HTTP code, duration).`,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
      },
      required: ['project_id'],
    },
  },
    annotations: { title: 'Show latest site-check status', readOnlyHint: true, idempotentHint: true },
    group: 'smoke',
    core: true,
    coreRank: 77,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","chatgpt","connector"],
    protocol: { surfaceDescriptions: { connector: "Read a project’s site-check configuration and latest results." }, surfaceAnnotations: { connector: {"title":"Site Check Status","readOnlyHint":true} },  oauthScopes: ['mcp'] },
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'GET', `/v1/smoke/${encodeURIComponent(String(args.project_id))}`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'site_check',
    description: `Trigger an on-demand site check for a project. Usually returns the finished run with per-target details within ~10s; if probes are still executing it returns { run: { id, status: "running" } } — re-read with site_check_status a moment later. Use for "is it back yet" after a fix, or for a post-deploy check.`,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
      },
      required: ['project_id'],
    },
  },
    annotations: { title: 'Run a site check now', readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    group: 'smoke',
    core: true,
    coreRank: 76,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","chatgpt","connector"],
    protocol: { surfaceDescriptions: { connector: "Run a site check for a project and record its results." }, surfaceAnnotations: { chatgpt: { openWorldHint: true }, connector: {"title":"Site Check","readOnlyHint":false,"destructiveHint":true} },  oauthScopes: ['mcp'] },
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'POST', `/v1/smoke/${encodeURIComponent(String(args.project_id))}/run`, authHeader, {});
        return result;

      }
    },
  },
  {
    definition: {
    name: 'smoke_config_get',
    description: `Read the per-project smoke configuration. Returns enabled (false if opted out), test_auth_flow (auto-detected), test_user_email (the designated test user for authed checks), alert_cooldown_seconds, last_alert_at, and any developer-defined extra checks.`,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
      },
      required: ['project_id'],
    },
  },
    annotations: { readOnlyHint: true, idempotentHint: true },
    group: 'smoke',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        result = await callAPI(fetcher, 'GET', `/v1/smoke/${encodeURIComponent(String(args.project_id))}/config`, authHeader);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'smoke_config_update',
    description: `Update the per-project smoke configuration. Set enabled=false to opt the project out of probes entirely. Set extra_checks to a JSON-stringified array of checks to probe specific paths in addition to the homepage — each check supports {name, path, method?, expect_status?, headers?, body?, auth?, expect_json_path?, expect_contains?, expect_not_contains?}: body (object→JSON or raw string) and headers ride the request; auth:"test_user" makes the platform mint a session for the project's designated test user at probe time (no credentials stored — set test_user_email first); expect_json_path (dot-path like "data.reply", must resolve non-null), expect_contains / expect_not_contains (substrings of the response) assert on CONTENT, not just status. The same fields work in a deployed /_smoke_tests.json.`,
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, no UUID lookup needed. 'default' also works when the account has exactly one project; multi-project accounts must name one (the error lists them)." },
        enabled: { type: 'boolean', description: 'Master switch. Default true.' },
        test_auth_flow: { type: 'boolean', description: 'Run the auth round-trip when sw.auth is detected. Default true.' },
        test_user_email: { type: 'string', description: 'Designated test user for auth:"test_user" checks — must be an existing app user of this project (validated on write). Empty string clears it.' },
        canary_enabled: { type: 'boolean', description: 'Opt into the 15-minute synthetic health canary: the full check set (including authed probes + content/latency assertions, expect_max_ms) runs every 15 min and alerts the owner on regression. Default false (the fleet sweep still covers the project every couple of hours).' },
        alert_cooldown_seconds: { type: 'number', description: 'Minimum seconds between alerts during a sustained outage. Clamped to [60, 86400]. Default 3600.' },
        extra_checks: { type: 'string', description: 'JSON-stringified array of additional checks: [{name,path,method?,expect_status?,headers?,body?,auth?,expect_json_path?,expect_contains?,expect_not_contains?,expect_max_ms?},...]' },
      },
      required: ['project_id'],
    },
  },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    group: 'smoke',
    core: false,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { fetcher, authHeader } = runtime;
      let result: ToolUpstreamResult;
      {
        const cfg: Record<string, unknown> = {};
        if (args.enabled !== undefined) cfg.enabled = args.enabled;
        if (args.test_auth_flow !== undefined) cfg.test_auth_flow = args.test_auth_flow;
        if (args.test_user_email !== undefined) cfg.test_user_email = args.test_user_email;
        if (args.canary_enabled !== undefined) cfg.canary_enabled = args.canary_enabled;
        if (args.alert_cooldown_seconds !== undefined) cfg.alert_cooldown_seconds = args.alert_cooldown_seconds;
        if (args.extra_checks !== undefined) {
          cfg.extra_checks = parseJsonArg(args.extra_checks, 'extra_checks');
        }
        result = await callAPI(fetcher, 'PATCH', `/v1/smoke/${encodeURIComponent(String(args.project_id))}/config`, authHeader, cfg);
        return result;

      }
    },
  },
  // ── other ─────────────────────────────────────────────
  {
    definition: {
    name: 'debug_site',
    description: `Debug a somewhere.site (the AI website builder) user or site. Returns user info, recent sites, generation jobs with status/error, file presence, error logs, and prompt history.

Identifier can be an email, user_id, site_id, or subdomain slug.

**Note:** This is for the somewhere.site product, NOT somewhere.tech projects. Use debug_project for somewhere.tech.

**Example:**

\`\`\`json
{ "identifier": "alice@example.com" }
// or
{ "identifier": "my-portfolio" }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        identifier: {
          type: 'string',
          description: 'email, user_id, site_id (32-hex), or subdomain slug',
        },
      },
      required: ['identifier'],
    },
  },
    annotations: { readOnlyHint: true, idempotentHint: true },
    group: 'other',
    core: false,
    visibility: 'admin',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { env } = runtime;
      let result: ToolUpstreamResult;
      {
        const id = encodeURIComponent((args.identifier as string) || '');
        result = await callSomewhereSiteAdmin(env, `/api/sys/site-debug/${id}`);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'somewhere_site_stats',
    description:
      'Get the somewhere.site generation health snapshot — total jobs, failure rate, top errors, provider breakdown, and p50/p95 duration over a trailing window. Useful for spotting whether failures are systemic before drilling into a single user with debug_site.',
    inputSchema: {
      type: 'object',
      properties: {
        window: {
          type: 'string',
          description: 'Trailing window — "1h", "24h", or "7d". Defaults to "24h".',
        },
      },
      required: [],
    },
  },
    annotations: { readOnlyHint: true, idempotentHint: true },
    group: 'other',
    core: false,
    visibility: 'admin',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { env } = runtime;
      let result: ToolUpstreamResult;
      {
        const window = (args.window as string) || '24h';
        result = await callSomewhereSiteAdmin(
          env,
          `/api/sys/generation-stats?window=${encodeURIComponent(window)}`
        );
        return result;

      }
    },
  },
  {
    definition: {
    name: 'debug_project',
    description: `Debug a somewhere.tech project. Resolves any of: an API-key prefix (e.g. \`"smt_FVa..."\`), a project_id (UUID), a subdomain (e.g. \`"myapp"\`), or a platform-user email. Returns the owner, all their projects, recent error logs, env-var key names, and a 7-day usage rollup. Optionally pass a catalog-discovered \`symptom\` id to return every registered, already-project-scoped signal and its honest instrumentation gaps in the same call.

**Note:** This is for somewhere.tech projects, NOT somewhere.site sites — use debug_site for those.

**Example:**

\`\`\`json
{ "identifier": "smt_FVa..." }
// or
{ "identifier": "myapp" }
// or
{ "identifier": "dev@example.com" }
\`\`\``,
    inputSchema: {
      type: 'object',
      properties: {
        identifier: {
          type: 'string',
          description: 'api-key prefix, project_id (UUID), subdomain, or platform-user email',
        },
        symptom: {
          type: 'string',
          description: 'Optional symptom id from catalog, e.g. unexpected_logout, deploy_failed, database_write_failure, domain_not_resolving, email_not_arriving, project_stuck_deleting, app_slow, or end_user_login_broken.',
        },
        since: {
          type: 'string',
          description: 'Optional symptom lookback as an ISO timestamp or duration such as 24h or 7d. Defaults to 7d.',
        },
      },
      required: ['identifier'],
    },
  },
    annotations: { readOnlyHint: true, idempotentHint: true },
    group: 'other',
    core: false,
    visibility: 'admin',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { env } = runtime;
      let result: ToolUpstreamResult;
      {
        const id = encodeURIComponent((args.identifier as string) || '');
        const params = new URLSearchParams();
        if (typeof args.symptom === 'string' && args.symptom) params.set('symptom', args.symptom);
        if (typeof args.since === 'string' && args.since) params.set('since', args.since);
        const suffix = params.toString() ? `?${params.toString()}` : '';
        result = await callSomewhereTechAdmin(env, `/v1/sys/project-debug/${id}${suffix}`);
        return result;

      }
    },
  },
  {
    definition: {
    name: 'somewhere_tech_stats',
    description:
      'Get the somewhere.tech platform truth surface. With no metric_id, preserves the existing health snapshot. With a catalog-discovered metric_id, evaluates that named/versioned metric and returns value, exact SQL, source table, authority note, computed_at, and durable-history status.',
    inputSchema: {
      type: 'object',
      properties: {
        window: {
          type: 'string',
          description: 'Trailing window — "1h", "24h", or "7d". Defaults to "24h".',
        },
        metric_id: {
          type: 'string',
          description: 'Optional stable metric id from catalog, e.g. platform.users.by_billing_tier.v1 or platform.projects.binding_database_prod.v1.',
        },
      },
      required: [],
    },
  },
    annotations: { readOnlyHint: true, idempotentHint: true },
    group: 'other',
    core: false,
    visibility: 'admin',
    paid: false,
    surfaces: ["full"],
    execute: async (runtime, args) => {
      const { env } = runtime;
      let result: ToolUpstreamResult;
      {
        const window = (args.window as string) || '24h';
        const metricId = typeof args.metric_id === 'string' ? args.metric_id.trim() : '';
        const params = new URLSearchParams();
        if (metricId) params.set('metric_id', metricId); else params.set('window', window);
        result = await callSomewhereTechAdmin(
          env,
          `/v1/sys/stats?${params.toString()}`
        );
        return result;

      }
    },
  },
] as const);

const TOOL_SPECS: readonly CanonicalToolSpec[] = [
  ...MIGRATED_TOOL_SPECS,
  ...connectorApiToolSpecs(validateApiToolPath),
  ...ACCOUNT_TOOL_SPECS,
  ...GROUP_TOOL_SPECS,
];

function constructCanonicalToolRegistry(specs: readonly CanonicalToolSpec[]): {
  byName: Map<string, CanonicalToolSpec>;
  definitions: MCPTool[];
} {
  const byName = new Map<string, CanonicalToolSpec>();
  const coreRanks = new Set<number>();
  for (const spec of specs) {
    const name = spec.definition.name;
    const annotationSurfaces = Object.keys(spec.protocol?.surfaceAnnotations ?? {});
    const coreRankValid = spec.core
      ? Number.isInteger(spec.coreRank) && !coreRanks.has(spec.coreRank!)
      : spec.coreRank === undefined;
    const valid = name.length > 0
      && !byName.has(name)
      && spec.group.length > 0
      && typeof spec.execute === 'function'
      && spec.surfaces.length > 0
      && new Set(spec.surfaces).size === spec.surfaces.length
      && spec.surfaces.includes('full')
      && (spec.visibility !== 'admin' || spec.surfaces.every((surface) => surface === 'full'))
      && coreRankValid
      && (!spec.surfaces.includes('chatgpt') || (spec.protocol?.oauthScopes?.length ?? 0) > 0)
      && annotationSurfaces.every((surface) => spec.surfaces.includes(surface as ToolSurface));
    if (!valid) throw new Error(`Invalid canonical ToolSpec: ${name || '(unnamed)'}`);
    if (spec.coreRank !== undefined) coreRanks.add(spec.coreRank);
    byName.set(name, spec);
  }
  return { byName, definitions: publicToolDefinitions(specs) };
}

const CANONICAL_TOOL_REGISTRY = constructCanonicalToolRegistry(TOOL_SPECS);
const TOOL_SPEC_BY_NAME = CANONICAL_TOOL_REGISTRY.byName;
const TOOL_DEFINITIONS = CANONICAL_TOOL_REGISTRY.definitions;

function toolVisibility(toolName: string): 'authenticated' | 'public' | 'admin' {
  return TOOL_SPEC_BY_NAME.get(toolName)?.visibility ?? 'authenticated';
}

function toolUsesMcpNativePaidResource(toolName: string): boolean {
  return TOOL_SPEC_BY_NAME.get(toolName)?.paid ?? false;
}

// --- Catalog ---
// Categories for the `catalog` meta-tool. Matchers run over the TOOL_DEFINITIONS
// array at call time so the catalog auto-syncs when new tools land.
// Each entry includes search-friendly aliases — these are the words
// an agent would naturally type when looking for that surface.

const CATALOG_CATEGORIES: Array<{
  key: string;
  summary: string;
  aliases: string[];
  searchAliases?: string[];
}> = [
  { key: 'project', summary: 'Projects, tags, deploys, source maps, collaborators, version history, rollback, transfer, isolated dev environments', aliases: ['apps', 'sites', 'workspaces', 'tags', 'labels', 'organize', 'deployment', 'dev environment', 'sandbox', 'dev database', 'docs query', 'source map'] },
  { key: 'account', summary: 'Your own developer/connector account — save an anonymous MCP-connector session to a real, email-verified account', aliases: ['connector', 'session', 'save session', 'claim account', 'anonymous'] },
  { key: 'groups', summary: 'Project groups — organize projects under one group with shared members and a shared design theme; create/list/inspect groups, move projects in and out', aliases: ['group', 'team', 'teams', 'organize', 'folders', 'collections'] },
  { key: 'github', summary: 'GitHub push-to-deploy — connect a repo + branch so every push auto-deploys, check connection status, list your repos, disconnect', aliases: ['git', 'repo', 'repository', 'push to deploy', 'push-to-deploy', 'auto deploy', 'webhook', 'ci', 'continuous deployment'] },
  { key: 'db', summary: 'Database — run SQL, migrations, CSV import/export, browse tables, point-in-time restore', aliases: ['sql', 'database', 'tables', 'schema', 'queries', 'migrations', 'backup', 'restore'] },
  { key: 'webhooks', summary: 'Project outbound webhooks — inspect durable delivery attempts and redrive the exact original event', aliases: ['outbound webhook', 'delivery history', 'redrive', 'retry', 'dedupe'] },
  { key: 'fs', summary: 'Files — write inline text, upload native files, read/list/move/copy/delete storage, versions, signed URLs, glob search', aliases: ['files', 'storage', 'blob', 'upload', 'download', 'attachment'] },
  { key: 'auth', summary: 'End-user auth — signup, login, sessions, MFA, magic links, password reset, email templates', aliases: ['authentication', 'users', 'login', 'signup', 'sessions', 'mfa', 'oauth', 'password'] },
  { key: 'env', summary: 'Environment variables — get/set/delete project env vars', aliases: ['secrets', 'config', 'settings'] },
  { key: 'email', summary: 'Outbound email — send transactional or managed batch mail, manage sender domains, view bounces/events', aliases: ['mail', 'send', 'smtp', 'transactional', 'marketing', 'segments', 'bounces'] },
  { key: 'inbox', summary: 'Inbound email — receive mail, parse, threads, reply/send, routing rules', aliases: ['receive', 'inbound', 'incoming', 'parse', 'threads'] },
  { key: 'ai', summary: 'AI — chat completion, embeddings, transcription, TTS, image generation, background removal', aliases: ['llm', 'claude', 'gpt', 'whisper', 'speech', 'embeddings', 'vision', 'image'] },
  { key: 'jobs', summary: 'Background jobs — fire-and-forget tasks with retries and status polling', aliases: ['async', 'background', 'task', 'worker'] },
  { key: 'cron', summary: 'Scheduled tasks — recurring cron jobs that hit your functions on a timer', aliases: ['schedule', 'recurring', 'timer', 'periodic'] },
  { key: 'queue', summary: 'Queue — send messages for async processing', aliases: ['pubsub', 'messaging', 'async'] },
  { key: 'logs', summary: 'Logs and errors — recent runtime logs and the last 24h of errors', aliases: ['observability', 'monitoring', 'debugging', 'traces'] },
  { key: 'smoke', summary: 'Site checks — health probes for your deployed app: latest status + history, on-demand run, per-project config and extra checks. Auto-run after every deploy and every ~20 min.', aliases: ['health', 'healthcheck', 'monitor', 'uptime', 'probe', 'smoke test', 'post-deploy check', 'is it up'] },
  { key: 'usage', summary: 'Usage summary — current-month AI/storage/email consumption and quota', aliases: ['billing', 'quota', 'limits', 'consumption', 'metering'] },
  { key: 'feedback', summary: 'User feedback (project) and support tickets (developer → somewhere.tech team)', aliases: ['support', 'tickets', 'bugs', 'reports'] },
  { key: 'tasks', summary: 'Tasks — per-project ticket/issue tracker: create, list, get one by ID with comments/activity (tasks_get), update, comment, bulk-update, templates, settings. Also the org spine: memory_save/memory_search = the durable memory layer (principles, specs, decisions). The most-used surface; how chat coordinates with code.', aliases: ['tickets', 'issues', 'todos', 'task tracker', 'kanban', 'project tasks', 'backlog', 'memory', 'knowledge', 'org memory'] },
  { key: 'artifacts', summary: 'Artifacts — publish a project file as an immutable, addressable snapshot with typed metadata (title/summary/schema/provenance), then fetch it by id or sw:// URI. The durable, replayable handoff between agents (Cursor → Claude → human) without re-describing files through a context window.', aliases: ['artifact', 'handoff', 'interchange', 'snapshot', 'publish', 'provenance', 'cross-agent', 'sw uri'] },
  { key: 'domains', summary: 'Custom domains — attach, verify DNS, buy/claim/transfer, single-tenant + multi-tenant', aliases: ['dns', 'hostnames', 'cname', 'apex', 'custom domain', 'register'] },
  { key: 'search', summary: 'Semantic search — vector indexes, upsert documents, query, delete', aliases: ['embeddings', 'vector', 'index', 'similarity', 'rag'] },
  { key: 'stock_photos', summary: 'Royalty-free stock photo search', aliases: ['photos', 'images', 'unsplash', 'pexels'] },
  { key: 'render', summary: 'Render — generate PDFs and image assets from a URL or HTML snippet (to SEE or TEST your live app, use `browser`)', aliases: ['pdf', 'headless', 'puppeteer', 'capture', 'og image', 'invoice pdf'] },
  { key: 'browser', summary: 'Browser — see, inspect, and drive your live app in a real headless browser (screenshot + console/network signals + a network table + redirect chain + rendered text + clickable-element map + a11y snapshot; add steps to click/fill/assert and wait on real conditions). Also captures any third-party url and renders a raw html snippet to an image (the render_screenshot fold). Your app\'s eyes, ears, and hands.', aliases: ['screenshot', 'see app', 'e2e', 'playwright', 'ui test', 'verify frontend', 'click test', 'inspect dom', 'render html', 'og image', 'third party screenshot', 'wait for', 'wait for selector', 'network idle', 'settled', 'dom settled', 'wait streaming', 'iframe', 'frame', 'streaming into iframe', 'accessibility tree', 'a11y', 'snapshot', 'aria', 'redirect chain', 'rendered text', 'page text', 'eval', 'run js in page', 'assert text', 'flaky wait'] },
  { key: 'code', summary: 'Run code — execute an async script against your project\'s live sw.* bindings (db, files, ai, logs, …) without deploying. The universal hand: query or seed the database, check a file, reproduce or verify a backend change.', aliases: ['run', 'run_code', 'script', 'execute', 'eval', 'repl', 'sandbox', 'backend test', 'sw bindings', 'sql script', 'run a script'] },
  { key: 'runtime', summary: 'Function runtime capabilities — fetch outbound HTTP APIs from server-side code with sw.fetch', aliases: ['function', 'functions', 'outbound', 'request', 'api call'], searchAliases: ['http', 'https'] },
  { key: 'web', summary: 'Web fetch — scrape a URL or run a web search', aliases: ['scrape', 'fetch', 'crawl', 'http', 'google search'] },
  { key: 'push', summary: 'Web push notifications — VAPID keys, subscribe browsers, send to subscribers', aliases: ['notifications', 'browser push', 'service worker', 'vapid'] },
  { key: 'rate_limit', summary: 'Atomic rate-limit counter — per-key check-and-increment', aliases: ['throttle', 'quota', 'counter', 'limiter'] },
  { key: 'telegram', summary: 'Link a Telegram account to the developer for bot notifications', aliases: ['bot', 'messaging', 'chat notification'] },
  { key: 'analytics', summary: 'Product analytics — track events, query funnels/retention/breakdowns', aliases: ['mixpanel', 'amplitude', 'events', 'metrics', 'funnel'] },
  { key: 'security', summary: 'CAPTCHA — invisible bot challenge for forms', aliases: ['captcha', 'bot protection', 'recaptcha'] },
  { key: 'payments', summary: 'Payments (Stripe Connect) — onboard, checkout, refund, transactions, subscription portal', aliases: ['stripe', 'checkout', 'subscription', 'invoice', 'billing customer'] },
  { key: 'connect', summary: 'Connected accounts — a customer\'s linked Stripe account: connect link, status, subscribers, disconnect', aliases: ['stripe connect', 'oauth connections', 'linked accounts', 'connected account'] },
  { key: 'realtime', summary: 'Realtime WebSockets — publish/broadcast, channel metadata, subscribe tokens', aliases: ['websocket', 'pubsub', 'live', 'pusher', 'ably'] },
  { key: 'video', summary: 'Video streaming — upload videos, list, get playback info, delete', aliases: ['stream', 'mux', 'hls', 'playback'] },
  { key: 'calls', summary: 'Voice/video calls — WebRTC SFU session tokens for Zoom/Twilio-style calls', aliases: ['webrtc', 'sfu', 'voip', 'twilio', 'zoom', 'meet'] },
  { key: 'api', summary: 'Generic platform API calls — use /v1 endpoints that do not have a dedicated MCP tool yet', aliases: ['rest', 'endpoint', 'long tail', 'generic api', 'v1'] },
  { key: 'help', summary: 'Discovery + reference — catalog (this tool), docs (topic prose), advisor (open-ended Q&A)', aliases: ['docs', 'reference', 'manual', 'faq', 'guide'] },
];

const CATALOG_RUNTIME_CAPABILITIES = [{
  name: 'sw.fetch',
  group: 'runtime',
  title: 'sw.fetch — outbound HTTP fetch from a function',
  description: 'Fetch a public outbound HTTP or HTTPS URL from server-side function code with timeout, retry, redirect safety, structured errors, and telemetry.',
  docs_topic: 'sw.fetch',
  usage: 'await sw.fetch(url, options)',
}] as const;

function runtimeCapability(name: string): (typeof CATALOG_RUNTIME_CAPABILITIES)[number] | undefined {
  return CATALOG_RUNTIME_CAPABILITIES.find((capability) => capability.name === name);
}

function registeredProductToolNames(): string[] {
  return TOOL_DEFINITIONS.filter((tool) => toolVisibility(tool.name) !== 'admin').map((tool) => tool.name);
}

function advertisedNamesForSurface(surface: ToolSurface): Set<string> {
  return new Set(TOOL_SPECS
    // A deprecated alias (spec.aliasOf) or hidden spec (spec.hidden) is
    // CALLABLE but not advertised — see executableNamesForSurface. Hiding the
    // surface must never break a caller that already uses the name (rule 9).
    .filter((spec) => spec.visibility !== 'admin' && !spec.aliasOf && !spec.hidden && spec.surfaces.includes(surface))
    .map((spec) => spec.definition.name));
}

function availableNamesForSurface(surface: ToolSurface, includeAdmin = false): Set<string> {
  const names = advertisedNamesForSurface(surface);
  if (includeAdmin && surface === 'full') {
    for (const spec of TOOL_SPECS) {
      if (spec.visibility === 'admin' && spec.surfaces.includes(surface)) names.add(spec.definition.name);
    }
  }
  return names;
}

function executableNamesForSurface(surface: ToolSurface): Set<string> {
  const names = advertisedNamesForSurface(surface);
  // Deprecated aliases and hidden specs stay executable so already-deployed
  // callers keep working.
  for (const spec of TOOL_SPECS) {
    if ((spec.aliasOf || spec.hidden) && spec.visibility !== 'admin' && spec.surfaces.includes(surface)) {
      names.add(spec.definition.name);
    }
  }
  return names;
}

function surfaceAllowsCanonicalTool(surface: ToolSurface, toolName: string): boolean {
  return executableNamesForSurface(surface).has(toolName);
}

function constrainCanonicalText(text: string, surface: ToolSurface): string {
  return constrainTextToSurface(
    text,
    surface,
    registeredProductToolNames(),
    executableNamesForSurface(surface),
  );
}

function toolBelongsToCatalogCategory(toolName: string, category: CatalogCategory): boolean {
  return TOOL_SPEC_BY_NAME.get(toolName)?.group === category.key;
}

function buildCatalog(surface: ToolSurface, advertised = advertisedNamesForSurface(surface)): {
  categories: Record<string, { summary: string; aliases: string[]; tools: string[]; capabilities?: string[] }>;
  total_tools: number;
  total_runtime_capabilities: number;
} {
  const categories: Record<string, { summary: string; aliases: string[]; tools: string[]; capabilities?: string[] }> = {};
  const seen = new Set<string>();
  for (const cat of CATALOG_CATEGORIES) {
    const tools = TOOL_DEFINITIONS.filter((t) => advertised.has(t.name) && toolBelongsToCatalogCategory(t.name, cat)).map((t) => t.name);
    const capabilities = CATALOG_RUNTIME_CAPABILITIES.filter((capability) => capability.group === cat.key).map((capability) => capability.name);
    if (tools.length === 0 && capabilities.length === 0) continue;
    for (const name of tools) seen.add(name);
    categories[cat.key] = {
      summary: cat.summary,
      aliases: cat.aliases,
      tools,
      ...(capabilities.length > 0 ? { capabilities } : {}),
    };
  }
  const uncategorized = [...advertised].filter((name) => !seen.has(name));
  if (uncategorized.length > 0) {
    categories.other = { summary: 'Uncategorized (debug/admin)', aliases: [], tools: uncategorized };
  }
  return {
    categories,
    total_tools: advertised.size,
    total_runtime_capabilities: CATALOG_RUNTIME_CAPABILITIES.length,
  };
}

function buildCatalogSummaryForMiss(surface: ToolSurface): string {
  const advertised = advertisedNamesForSurface(surface);
  return CATALOG_CATEGORIES
    .map((cat) => {
      const tools = TOOL_DEFINITIONS.filter((t) => advertised.has(t.name) && toolBelongsToCatalogCategory(t.name, cat)).map((t) => t.name);
      return `${cat.key}: ${cat.summary}; tools=${tools.slice(0, 40).join(', ')}`;
    })
    .join('\n')
    .slice(0, 12000);
}

// --- Lazy-load tool groups (tsk_1184d9ef) ---
// The catalog already groups tools; these helpers let a client load only
// the groups a session needs instead of all 230+ definitions — via
// catalog({ load }) for the schemas, and a `?groups=` / `Mcp-Tool-Groups`
// scoped tools/list for the live surface. Both go through the same
// group-resolution so they can never drift.

type CatalogCategory = (typeof CATALOG_CATEGORIES)[number];

// Always included when a client scopes to groups, so discovery + expansion
// (catalog / docs / advisor — the 'help' group) is never
// stranded behind a group the agent hasn't loaded.
const LAZY_CORE_GROUP_KEYS = ['help'];

/** Resolve a group key OR alias (case-insensitive) to its category. */
function resolveCatalogGroup(keyOrAlias: string): CatalogCategory | undefined {
  const k = keyOrAlias.trim().toLowerCase();
  if (!k) return undefined;
  return CATALOG_CATEGORIES.find((c) => c.key === k || c.aliases.includes(k));
}

/** Tool names belonging to any of the named groups (deduped). Unknown
 *  group keys are ignored here — callers that need to report them resolve
 *  separately. */
function toolNamesForGroups(keys: string[]): Set<string> {
  const cats = keys.map(resolveCatalogGroup).filter((c): c is CatalogCategory => !!c);
  const out = new Set<string>();
  for (const t of TOOL_DEFINITIONS) {
    if (cats.some((c) => toolBelongsToCatalogCategory(t.name, c))) out.add(t.name);
  }
  return out;
}

/** The exact registered names returned by tools/list for a surface + group scope. */
function listedNamesForSurface(
  surface: ToolSurface,
  groupKeys: string[],
  includeAdmin = false,
): Set<string> {
  const available = availableNamesForSurface(surface, includeAdmin);
  if (surface === 'connector' || surface === 'chatgpt' || groupKeys.includes('all')) {
    return available;
  }

  const allow = groupKeys.length === 0
    ? new Set(TOOL_SPECS.filter((spec) => spec.core).map((spec) => spec.definition.name))
    : toolNamesForGroups([...LAZY_CORE_GROUP_KEYS, ...groupKeys]);
  if (groupKeys.includes('other')) {
    for (const tool of TOOL_DEFINITIONS) {
      if (!CATALOG_CATEGORIES.some((category) => toolBelongsToCatalogCategory(tool.name, category))) allow.add(tool.name);
    }
  }
  return new Set([...available].filter((name) => allow.has(name)));
}

/** Parse a comma/space-separated group string (from a `load` arg, a
 *  `?groups=` query param, or the `Mcp-Tool-Groups` header) into keys. */
function parseGroupList(raw: string): string[] {
  return raw.split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** Explicit tools/list groups, or null when the caller did not request any. */
function requestedToolGroups(url: URL, request: Request): string[] | null {
  const raw = url.searchParams.get('groups') ?? request.headers.get('Mcp-Tool-Groups') ?? '';
  const keys = parseGroupList(raw);
  return keys.length > 0 ? keys : null;
}

/** Merge the MCP annotation onto a tool def (same decoration tools/list
 *  applies), so catalog({ load }) hands back identical definitions. */
function withToolAnnotations(t: MCPTool, surface: ToolSurface = 'full'): MCPTool & { annotations?: McpToolAnnotations } {
  const spec = TOOL_SPEC_BY_NAME.get(t.name);
  const annotations = spec ? { ...spec.annotations, ...spec.protocol?.surfaceAnnotations?.[surface] } : undefined;
  return annotations && Object.keys(annotations).length > 0 ? { ...t, annotations } : t;
}

function withChatgptToolMetadata(t: MCPTool): MCPTool & {
  annotations?: McpToolAnnotations;
  securitySchemes: ToolSecurityScheme[];
  _meta: MCPToolMeta & { securitySchemes: ToolSecurityScheme[] };
} {
  const annotated = withToolAnnotations(t);
  const spec = TOOL_SPEC_BY_NAME.get(t.name);
  const override = spec?.protocol?.surfaceAnnotations?.chatgpt;
  const mergedAnnotations = override
    ? { ...(annotated.annotations ?? {}), ...override }
    : annotated.annotations;
  // OpenAI's app review requires these three hints to be present rather than
  // relying on MCP defaults. Most Somewhere tools operate only on the user's
  // closed Somewhere workspace; the few tools that publish or contact an
  // outside party carry an explicit openWorldHint:true on their ToolSpec.
  const annotations: McpToolAnnotations = {
    ...(mergedAnnotations ?? {}),
    readOnlyHint: mergedAnnotations?.readOnlyHint ?? false,
    destructiveHint: mergedAnnotations?.destructiveHint ?? false,
    openWorldHint: mergedAnnotations?.openWorldHint ?? false,
  };
  const securitySchemes = [{
    type: 'oauth2' as const,
    scopes: [...(spec?.protocol?.oauthScopes ?? [])],
  }];

  return {
    ...annotated,
    annotations,
    securitySchemes,
    _meta: {
      ...(t._meta ?? {}),
      securitySchemes,
    },
  };
}

function constrainToolDefinitionToSurface(t: MCPTool, surface: ToolSurface): MCPTool {
  return {
    ...t,
    description: constrainCanonicalText(TOOL_SPEC_BY_NAME.get(t.name)?.protocol?.surfaceDescriptions?.[surface] ?? t.description, surface),
  };
}

/** What kind of agent is calling us, so getting-started / cli / setup help
 *  can lead with the path that actually works for them:
 *    'cli'       — runs in a shell (Claude Code, Cursor, Codex, any CLI).
 *                  `somewhere init/deploy/run` is the fast path.
 *    'connector' — no shell (Claude.ai connector, ChatGPT). MCP tools
 *                  (project_create / project_deploy / db_query) are the
 *                  ONLY path — there is no terminal to run a CLI in.
 *    'unknown'   — can't tell; show both, note the CLI is faster if you
 *                  have a shell.
 *
 * IMPORTANT (transport reality): the MCP Streamable-HTTP transport here is
 * STATELESS — every JSON-RPC call is an independent POST with no shared
 * session. The `clientInfo` an agent sends on `initialize` does NOT reach a
 * later `docs` tools/call (there's no session map to stash it in).
 * So the load-bearing per-request signal is the headers that ARE present on
 * every POST: the User-Agent, plus the endpoint the caller hit
 * (/mcp/connector + /mcp/chatgpt are shell-less by construction). The
 * optional `clientInfoName` arg lets the `initialize` handler tailor its own
 * response using the name the client just sent — it can't help later calls,
 * but it costs nothing and future-proofs a stateful transport. */
type CallerKind = 'cli' | 'connector' | 'unknown';

function detectCallerKind(opts: {
  userAgent?: string | null;
  isConnectorMode?: boolean;
  isChatgptMode?: boolean;
  clientInfoName?: string | null;
}): CallerKind {
  // Endpoint is the strongest signal: the connector + chatgpt surfaces are
  // shell-less directory clients by construction. No UA can override that.
  if (opts.isConnectorMode || opts.isChatgptMode) return 'connector';

  const hay = `${opts.userAgent ?? ''} ${opts.clientInfoName ?? ''}`.toLowerCase();
  if (!hay.trim()) return 'unknown';

  // Shell-less assistant clients (no terminal to run a CLI in) → tool-first.
  // Check these FIRST: "claude-ai" contains "claude" but is NOT the CLI.
  if (/claude-ai|claude\.ai|chatgpt|openai|connector|gpt-/.test(hay)) return 'connector';

  // Shell-having coding agents (have a terminal) → CLI-first.
  if (/claude-code|cursor|codex|cline|windsurf|aider|continue|\bcli\b|\bcode\b/.test(hay)) return 'cli';

  return 'unknown';
}

function detectToolSurface(opts: {
  pathname: string;
  userAgent?: string | null;
  clientInfoName?: string | null;
}): ToolSurface {
  if (opts.pathname === '/mcp/chatgpt') return 'chatgpt';
  if (opts.pathname === '/mcp/connector') return 'connector';
  return 'full';
}

/** One-block guidance banner prepended to the getting-started / setup / cli /
 *  local-dev help topics, tailored to the caller. Pure presentation — the
 *  topic body underneath is unchanged, so nothing existing breaks (rule 9).
 *  Returns '' for topics that aren't path-sensitive. */
const CALLER_TAILORED_TOPICS = new Set([
  'getting-started', 'setup', 'cli', 'local-dev', 'dev-prod', 'deploy',
]);

function callerHelpBanner(topic: string, kind: CallerKind): string {
  // Normalize the same way platformHelp() does so 'ctx.deploy' etc. still match.
  const t = (topic || '').trim().toLowerCase().replace(/^(?:sw|ctx)\./, '');
  if (!CALLER_TAILORED_TOPICS.has(t)) return '';
  if (kind === 'cli') {
    return `> **You're calling from a shell-having agent — use the CLI as the primary platform surface.**\n`
      + `> Install once (\`npm i -g @somewhere-tech/cli\`), then \`somewhere init\` in a\n`
      + `> project folder, write source, and \`somewhere deploy\`. \`somewhere run\` executes\n`
      + `> a script against your live project bindings without deploying. Use first-class\n`
      + `> commands for routine work and \`somewhere call <tool> '<json>'\` for the complete\n`
      + `> tool catalog. Use MCP when its in-context delivery is materially useful.\n\n`;
  }
  if (kind === 'connector') {
    return `> **This connection exposes MCP tools directly; no CLI setup is required.**\n`
      + `> Build entirely through tool calls: \`project_create\` to make an app,\n`
      + `> \`project_deploy\` to ship raw source, \`db_query\` / \`db_migrate\` for the\n`
      + `> database, and \`project_patch\` for a single-file change.\n`
      + (t === 'getting-started'
        ? `> The guide below is the connector-specific tool-call path.\n\n`
        : `> If the reference also shows shell commands, use the MCP tool with the matching job.\n\n`);
  }
  // Unknown caller — make the surface choice explicit without assuming a shell.
  return `> **Choose by execution environment:** if you have a shell, use the CLI as\n`
    + `> the primary platform surface. First-class commands cover routine work and\n`
    + `> \`somewhere call <tool> '<json>'\` reaches the complete tool catalog. If you\n`
    + `> don't have a shell (connector / web assistant), use the MCP tools directly.\n\n`;
}

// --- JSON-RPC Types ---

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function rpcResult(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

/** Tools whose arguments carry customer data into a project's database, or
 *  relay a platform API body verbatim. A whole number in one of these that the
 *  JSON parse already rounded is refused before it is forwarded. */
const EXACT_NUMBER_TOOLS = new Set(['db_query', 'db_batch', 'db_migrate', 'api']);

function rpcError(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } };
}

// --- somewhere.site admin bridge (separate worker, plain HTTPS + shared admin key) ---
//
// The existing somewhere.tech tools call api.somewhere.tech via service binding.
// somewhere.site is a different worker (fhp-api) on the same account, but
// there's no service binding to it from this MCP — using public HTTPS keeps
// the deployment surface small. Auth is the X-Admin-Key shared secret that
// fhp-api's /api/sys/* endpoints accept.

async function callSomewhereSiteAdmin(
  env: Env,
  path: string
): Promise<{ status: number; data: unknown }> {
  if (!env.SOMEWHERE_SITE_ADMIN_KEY) {
    return {
      status: 500,
      data: {
        error: 'SOMEWHERE_SITE_ADMIN_KEY not set on the MCP worker',
        fix: "Set SOMEWHERE_SITE_ADMIN_KEY in the MCP deployment secrets (docs/OPERATIONS.md).",
      },
    };
  }
  try {
    const res = await fetch(`${SOMEWHERE_SITE_API_BASE}${path}`, {
      method: 'GET',
      headers: { 'X-Admin-Key': env.SOMEWHERE_SITE_ADMIN_KEY },
    });
    const ct = res.headers.get('Content-Type') || '';
    if (!ct.includes('application/json')) {
      const text = await res.text();
      return { status: res.status, data: { ok: false, error: 'NON_JSON', body: text.slice(0, 500) } };
    }
    return { status: res.status, data: await res.json() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return { status: 502, data: { ok: false, error: 'FETCH_FAILED', message: msg } };
  }
}

// --- somewhere.tech admin bridge (same worker, service binding + admin key) ---
//
// /v1/sys/* lives on somewhere-tech-api alongside the regular routes, so we
// reuse the existing API_SERVICE service binding instead of going over the
// public internet. We just swap the Authorization header for X-Admin-Key.

async function callSomewhereTechAdmin(
  env: Env,
  path: string
): Promise<{ status: number; data: unknown }> {
  if (!env.SOMEWHERE_TECH_ADMIN_KEY) {
    return {
      status: 500,
      data: {
        error: 'SOMEWHERE_TECH_ADMIN_KEY not set on the MCP worker',
        fix: "Set SOMEWHERE_TECH_ADMIN_KEY in the MCP deployment secrets (docs/OPERATIONS.md).",
      },
    };
  }
  const req = new Request(`https://api-internal${path}`, {
    method: 'GET',
    headers: { 'X-Admin-Key': env.SOMEWHERE_TECH_ADMIN_KEY },
  });
  const resp = await env.API_SERVICE.fetch(req);
  const ct = resp.headers.get('Content-Type') || '';
  if (!ct.includes('application/json')) {
    const text = await resp.text();
    return { status: resp.status, data: { ok: false, error: 'NON_JSON', body: text.slice(0, 500) } };
  }
  return { status: resp.status, data: await resp.json() };
}

// --- API Call Helper (uses Service Binding to avoid CF error 1042) ---

/**
 * Thrown when the upstream API rejects the caller's OAuth JWT (expired,
 * revoked, malformed signature). The /mcp POST handler catches this and
 * returns HTTP 401 + WWW-Authenticate so Claude.ai triggers its OAuth
 * refresh-token flow. Without this, an expired token returns a normal
 * JSON-RPC error (HTTP 200) and Claude never refreshes — the connector
 * appears to die silently until the user disconnects/reconnects.
 *
 * Only thrown when the bearer looks like a JWT (3-part token, not
 * smt_-prefixed). smt_ caller rejection uses the sibling API-key error
 * below; both reach the same transport-level refresh boundary.
 */
class UpstreamOAuthRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpstreamOAuthRejectedError';
  }
}

/** The upstream rejected the caller's own smt_ credential, rather than an
 *  app-user credential supplied as a tool argument. This distinction matters:
 *  app auth tools legitimately return AUTH_INVALID_CREDS while the developer
 *  bearer is still healthy, and those must remain normal tool results. */
class UpstreamApiKeyRejectedError extends Error {
  constructor(
    message: string,
    readonly code: 'API_KEY_EXPIRED' | 'INVALID_API_KEY',
  ) {
    super(message);
    this.name = 'UpstreamApiKeyRejectedError';
  }
}

function bearerLooksLikeOAuthJwt(authHeader: string): boolean {
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token || token.startsWith('smt_') || token.startsWith('support_')) return false;
  return token.split('.').length === 3 && token.length > 40;
}

function bearerLooksLikeApiKey(authHeader: string): boolean {
  return authHeader.startsWith('Bearer smt_');
}

/** Wrap raw service-binding calls made by individual tool handlers so they
 *  obey the same caller-auth rejection contract as callAPI. Several tools need
 *  response headers or bytes and therefore cannot use callAPI; without this
 *  wrapper an access key expiring after initialize could still surface as a
 *  normal tool result instead of the transport-level 401 that triggers renewal. */
function authAwareFetcher(fetcher: Fetcher, authHeader: string): Fetcher {
  return authAwareFetcherWithObserver(fetcher, authHeader);
}

/** Carry MCP 2026 trace metadata into every downstream service call made by
 * the tool. The API worker then adopts this W3C parent and returns the same
 * trace id on its response. Invalid fields were already discarded by the
 * protocol chokepoint, so this wrapper only copies bounded values. */
function traceContextFetcher(fetcher: Fetcher, trace: ModernTraceContext | undefined): Fetcher {
  if (!trace || (!trace.traceparent && !trace.tracestate && !trace.baggage)) return fetcher;
  const fetchWithTrace = async (...args: Parameters<Fetcher['fetch']>): Promise<Response> => {
    const request = new Request(args[0], args[1] as RequestInit | undefined);
    const headers = new Headers(request.headers);
    if (trace.traceparent) headers.set('traceparent', trace.traceparent);
    if (trace.tracestate) headers.set('tracestate', trace.tracestate);
    if (trace.baggage) headers.set('baggage', trace.baggage);
    return fetcher.fetch(new Request(request, { headers }));
  };
  return { fetch: fetchWithTrace } as Fetcher;
}

function authAwareFetcherWithObserver(
  fetcher: Fetcher,
  authHeader: string,
  onRejected?: (error: UpstreamOAuthRejectedError | UpstreamApiKeyRejectedError) => void,
): Fetcher {
  const reject = (
    error: UpstreamOAuthRejectedError | UpstreamApiKeyRejectedError,
  ): never => {
    onRejected?.(error);
    throw error;
  };
  const fetchWithAuthRejection = async (
    ...args: Parameters<Fetcher['fetch']>
  ): Promise<Response> => {
    const input = args[0];
    const init = args[1] as RequestInit | undefined;
    const requestAuthorization = init?.headers
      ? new Headers(init.headers).get('Authorization')
      : input instanceof Request
        ? input.headers.get('Authorization')
        : null;
    const response = await fetcher.fetch(...args);
    if (response.status !== 401) return response;
    // Some auth tools intentionally replace Authorization with an app-user
    // credential supplied in the tool arguments. Its 401 is a normal tool
    // result, not a rejection of the MCP caller's bearer.
    if (requestAuthorization !== authHeader) return response;
    if (bearerLooksLikeOAuthJwt(authHeader)) {
      return reject(new UpstreamOAuthRejectedError('Upstream rejected the OAuth token.'));
    }
    if (!bearerLooksLikeApiKey(authHeader)) return response;

    const contentType = response.headers.get('Content-Type') || '';
    if (!contentType.includes('application/json')) {
      return reject(new UpstreamApiKeyRejectedError(
        'Upstream rejected the API key.',
        'INVALID_API_KEY',
      ));
    }
    const payload = await response.clone().json().catch(() => null);
    const code = callerApiKeyRejectionCode(payload);
    if (code) {
      const message = payload && typeof payload === 'object'
        && 'message' in payload
        && typeof (payload as { message?: unknown }).message === 'string'
        ? (payload as { message: string }).message
        : 'Upstream rejected the API key.';
      return reject(new UpstreamApiKeyRejectedError(message, code));
    }
    return response;
  };
  return { fetch: fetchWithAuthRejection } as Fetcher;
}

function isCallerAuthRejection(
  error: unknown,
): error is UpstreamOAuthRejectedError | UpstreamApiKeyRejectedError {
  return error instanceof UpstreamOAuthRejectedError
    || error instanceof UpstreamApiKeyRejectedError;
}

/** Request-scoped enforcement boundary for authenticated tools/call.
 *
 * Tool handlers intentionally translate most upstream failures into normal
 * tool results, and several best-effort helpers catch errors. Caller auth is
 * different: once any caller-authorized upstream reports expiry/revocation,
 * the HTTP response must be 401 so the client can refresh. Latch that signal
 * before inner code can translate it, then assert it once at the outer
 * tools/call boundary. Wrapping the Env also prevents a handler from bypassing
 * enforcement by using a service binding directly instead of runtime.fetcher.
 */
class CallerAuthBoundary {
  private rejection: UpstreamOAuthRejectedError | UpstreamApiKeyRejectedError | null = null;

  constructor(private readonly authHeader: string) {}

  wrap(fetcher: Fetcher): Fetcher {
    return authAwareFetcherWithObserver(fetcher, this.authHeader, (error) => {
      this.rejection ??= error;
    });
  }

  wrapEnv(env: Env): Env {
    return {
      ...env,
      API_SERVICE: this.wrap(env.API_SERVICE),
      ...(env.RUNNER_SERVICE
        ? { RUNNER_SERVICE: this.wrap(env.RUNNER_SERVICE) }
        : {}),
    };
  }

  assertAccepted(): void {
    if (this.rejection) throw this.rejection;
  }
}

/**
 * Published protected-resource URLs → the surface each names. Must stay in step
 * with the metadata documents served below and with the worker's
 * utils/mcp-token-audience.ts. Exact match only — an audience is an identity,
 * never a prefix.
 */
const RESOURCE_SURFACES: Readonly<Record<string, 'full' | 'connector' | 'chatgpt'>> = Object.freeze({
  'https://mcp.somewhere.tech/mcp': 'full',
  'https://mcp.somewhere.tech/mcp/connector': 'connector',
  'https://mcp.somewhere.tech/mcp/chatgpt': 'chatgpt',
});

/**
 * Read the `aud` claim off a connector bearer WITHOUT verifying the signature.
 *
 * Unverified is sound here, and deliberately so. Widening the claim buys an
 * attacker nothing: the signature is still checked upstream on every REST call
 * this worker makes, so reaching the full surface requires a token that BOTH
 * claims `aud: <full surface>` AND verifies — which only the authorization
 * server can produce. Narrowing it only costs the holder access. So this check
 * can never be the sole thing standing between a forged token and authority; it
 * exists to stop a GENUINE curated-surface token from being spent on a surface
 * the user never approved.
 *
 * Returns null for absent, malformed, or unrecognized audiences — i.e. a
 * pre-cutover token, which is accepted everywhere exactly as before (rule 9).
 */
function tokenAudienceSurface(authHeader: string): 'full' | 'connector' | 'chatgpt' | null {
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
    const payload = JSON.parse(json) as { aud?: unknown };
    if (typeof payload.aud !== 'string') return null;
    return RESOURCE_SURFACES[payload.aud] ?? null;
  } catch {
    return null;
  }
}

/**
 * Call the dedicated run_code runner worker (somewhere-tech-runner) rather than
 * the API worker. run_code MUST be rooted at the runner: the runner invokes the
 * sandbox, the sandbox fetches the API worker as a LEAF — no self-loop (522).
 * Prefers the RUNNER_SERVICE binding; falls back to the public runner route.
 */
async function callRunner(
  env: Env,
  method: string,
  path: string,
  authHeader: string,
  body?: unknown
): Promise<{ status: number; data: unknown }> {
  const runEnvironment = path === '/run'
    ? { environment: 'live', environment_message: 'run_code uses the live project bindings.' }
    : {};
  const headers = new Headers({ 'Authorization': authHeader, 'Content-Type': 'application/json' });
  const init: RequestInit = { method, headers };
  if (body && method !== 'GET') init.body = JSON.stringify(body);

  // The runner is reached via the RUNNER_SERVICE binding (no HTTP, no self-loop)
  // or, if that binding is absent, the public runner URL as a fallback. Warn on
  // the fallback so a misconfigured deploy (binding dropped) shows up in logs
  // instead of silently degrading to a slower public round-trip.
  const usingBinding = !!env.RUNNER_SERVICE;
  if (!usingBinding) {
    console.warn(JSON.stringify({ at: 'callRunner', warn: 'RUNNER_SERVICE binding absent — using public runner URL fallback' }));
  }

  let resp: Response;
  try {
    if (env.RUNNER_SERVICE) {
      const guardedRunner = authAwareFetcher(env.RUNNER_SERVICE, authHeader);
      resp = await guardedRunner.fetch(new Request(`https://runner-internal${path}`, init));
    } else {
      const base = env.RUNNER_BASE_URL || 'https://runner.somewhere.tech';
      const publicRunner = {
        fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
      } as Fetcher;
      const guardedRunner = authAwareFetcher(publicRunner, authHeader);
      resp = await guardedRunner.fetch(new Request(`${base}${path}`, init));
    }
  } catch (err) {
    if (isCallerAuthRejection(err)) throw err;
    // Network throw reaching the runner (connect/DNS/timeout/binding failure).
    // Fail LOUD + CLEAR — never surface this to run_code as an opaque 500.
    console.error(JSON.stringify({ at: 'callRunner', error: 'RUNNER_UNREACHABLE', via: usingBinding ? 'binding' : 'public-url', message: err instanceof Error ? err.message : String(err) }));
    return { status: 503, data: { ...runEnvironment, ok: false, error: 'UPSTREAM_DOWN', message: 'The code runner is temporarily unreachable. This is a transient platform issue — retry in a moment.' } };
  }

  const ct = resp.headers.get('Content-Type') || '';
  if (!ct.includes('application/json')) {
    const text = await resp.text();
    // A non-JSON body is an edge/infra error page, not a run_code result. A 5xx
    // (incl. CF 52x) means the runner is down → UPSTREAM_DOWN (retryable) so the
    // agent retries rather than treating a transient outage as permanent.
    if (resp.status >= 502 && resp.status <= 526) {
      console.error(JSON.stringify({ at: 'callRunner', error: 'RUNNER_UNREACHABLE', status: resp.status, via: usingBinding ? 'binding' : 'public-url' }));
      return { status: 503, data: { ...runEnvironment, ok: false, error: 'UPSTREAM_DOWN', message: 'The code runner is temporarily unreachable. This is a transient platform issue — retry in a moment.' } };
    }
    return { status: resp.status, data: { ...runEnvironment, ok: false, error: 'UPSTREAM_ERROR', message: text.slice(0, 500) } };
  }
  return { status: resp.status, data: await resp.json() };
}

async function callAPI(
  fetcher: Fetcher,
  method: string,
  path: string,
  authHeader: string,
  body?: unknown,
  extraHeaders?: Record<string, string>
): Promise<{ status: number; data: unknown }> {
  const headers = new Headers({
    'Authorization': authHeader,
    'Content-Type': 'application/json',
    'X-Somewhere-Agent-Origin': 'mcp',
  });
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
  }

  const init: RequestInit = { method, headers };
  if (body && method !== 'GET' && method !== 'HEAD') init.body = JSON.stringify(body);

  const req = new Request(`https://api-internal${path}`, init);
  const resp = await fetcher.fetch(req);

  if (method === 'HEAD' || resp.status === 204 || resp.status === 205) {
    if (resp.status === 401 && bearerLooksLikeOAuthJwt(authHeader)) {
      throw new UpstreamOAuthRejectedError('Upstream rejected the OAuth token.');
    }
    if (resp.status === 401 && bearerLooksLikeApiKey(authHeader)) {
      throw new UpstreamApiKeyRejectedError('Upstream rejected the API key.', 'INVALID_API_KEY');
    }
    return { status: resp.status, data: null };
  }

  // Handle non-JSON responses (CF error pages)
  const ct = resp.headers.get('Content-Type') || '';
  if (!ct.includes('application/json')) {
    const text = await resp.text();
    if (resp.status === 401 && bearerLooksLikeOAuthJwt(authHeader)) {
      throw new UpstreamOAuthRejectedError(text.slice(0, 200));
    }
    if (resp.status === 401 && bearerLooksLikeApiKey(authHeader)) {
      throw new UpstreamApiKeyRejectedError('Upstream rejected the API key.', 'INVALID_API_KEY');
    }
    return { status: resp.status, data: { ok: false, error: 'UPSTREAM_ERROR', message: text.slice(0, 500) } };
  }

  const data = await resp.json();
  if (resp.status === 401 && bearerLooksLikeOAuthJwt(authHeader)) {
    const msg = (data && typeof data === 'object' && 'message' in data && typeof (data as { message?: unknown }).message === 'string')
      ? (data as { message: string }).message
      : 'Upstream rejected the OAuth token.';
    throw new UpstreamOAuthRejectedError(msg);
  }
  const apiKeyRejection = resp.status === 401 && bearerLooksLikeApiKey(authHeader)
    ? callerApiKeyRejectionCode(data)
    : null;
  if (apiKeyRejection) {
    const msg = (data && typeof data === 'object' && 'message' in data && typeof (data as { message?: unknown }).message === 'string')
      ? (data as { message: string }).message
      : 'Upstream rejected the API key.';
    throw new UpstreamApiKeyRejectedError(msg, apiKeyRejection);
  }
  return { status: resp.status, data };
}

type ApiToolMethod = 'GET' | 'HEAD' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

const API_TOOL_INTERNAL_ORIGIN = 'https://api-internal';
const API_TOOL_INTERNAL_HOST = 'api-internal';
const API_TOOL_MAX_CALLS = 10;
const API_TOOL_ALLOWED_METHODS = ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE'] as const;
// Intentionally EMPTY: every write (non-GET/HEAD) through the generic api
// tool requires confirm:true — fully fail-safe. The two candidates we
// considered both failed the "read-shaped, no money/state" bar (/v1/ai/complete
// bills balance + records usage; /v1/ai/embed didn't even match the real
// /v1/ai/embeddings). Rather than adjudicate "is this route safe?" per entry —
// the exact judgment that leaks money routes — we route ALL writes through the
// confirm gate. High-frequency safe writes have dedicated tools; the api tool
// is the long-tail escape hatch, so a confirm on generic writes is cheap.
const API_TOOL_SAFE_WRITE_ALLOWLIST = new Set<string>([]);

interface ApiToolCall {
  method: ApiToolMethod;
  path: string;
  body?: Record<string, unknown>;
}

interface ApiToolConfirmRequiredCall {
  index: number;
  method: ApiToolMethod;
  path: string;
  reasons: string[];
}

interface ApiToolCallResult {
  status: number;
  ok: boolean;
  data: unknown;
}

type ApiToolPathValidation =
  | { ok: true; path: string }
  | { ok: false; error: string };

type ApiToolArgsValidation =
  | { ok: true; calls: ApiToolCall[]; confirmRequiredCalls: ApiToolConfirmRequiredCall[] }
  | { ok: false; error: string; details?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isApiToolMethod(value: string): value is ApiToolMethod {
  return (API_TOOL_ALLOWED_METHODS as readonly string[]).includes(value);
}

export function validateApiToolPath(path: unknown): ApiToolPathValidation {
  if (typeof path !== 'string' || path.length === 0) {
    return { ok: false, error: 'path must be a non-empty string.' };
  }
  if (/[\s\u0000-\u001F\u007F]/.test(path)) {
    return { ok: false, error: 'path must not contain whitespace or control characters.' };
  }
  if (path.includes('\\') || path.includes('#')) {
    return { ok: false, error: 'path must not contain backslashes or fragments.' };
  }
  const lowerRawPath = path.toLowerCase();
  if (lowerRawPath.includes('http:') || lowerRawPath.includes('https:') || path.includes('//')) {
    return { ok: false, error: 'path must not contain a URL scheme or //.' };
  }
  if (!path.startsWith('/v1/')) {
    return { ok: false, error: 'path must start with /v1/.' };
  }
  if (path.includes('..')) {
    return { ok: false, error: 'path must not contain .. path traversal.' };
  }
  const rawPathname = path.split('?', 1)[0];
  if (/%(?:2f|5c)/i.test(rawPathname)) {
    return { ok: false, error: 'path must not contain encoded path separators.' };
  }

  let url: URL;
  try {
    url = new URL(path, API_TOOL_INTERNAL_ORIGIN);
  } catch {
    return { ok: false, error: 'path could not be parsed as a platform API path.' };
  }
  if (url.protocol !== 'https:' || url.host !== API_TOOL_INTERNAL_HOST) {
    return { ok: false, error: 'path must stay on the platform API host.' };
  }

  const normalizedPathname = url.pathname;
  const lowerNormalizedPathname = normalizedPathname.toLowerCase();
  if (!normalizedPathname.startsWith('/v1/')) {
    return { ok: false, error: 'normalized path must start with /v1/.' };
  }
  if (lowerNormalizedPathname.startsWith('/v1/admin') || lowerNormalizedPathname.startsWith('/v1/internal')) {
    return { ok: false, error: 'normalized path may not target /v1/admin or /v1/internal.' };
  }

  return { ok: true, path: `${normalizedPathname}${url.search}` };
}

function confirmRequiredReasonsForApiToolCall(call: ApiToolCall): string[] {
  const reasons: string[] = [];
  if (call.method === 'GET' || call.method === 'HEAD') return reasons;
  const pathname = new URL(call.path, API_TOOL_INTERNAL_ORIGIN).pathname;
  if (API_TOOL_SAFE_WRITE_ALLOWLIST.has(pathname)) return reasons;

  // Fail-safe by design: this generic long-tail tool will see new write routes
  // before we have reviewed them. Dedicated high-frequency safe writes already
  // have first-class tools, so requiring confirm for unknown writes is acceptable
  // friction and prevents money/state mutations from bypassing review.
  reasons.push(`${call.method} ${pathname} is not in the safe write allowlist`);
  if (call.method === 'DELETE') {
    reasons.push('method is DELETE');
  }
  return reasons;
}

function validateApiToolArgs(args: Record<string, unknown>): ApiToolArgsValidation {
  if (args.confirm !== undefined && typeof args.confirm !== 'boolean') {
    return { ok: false, error: 'confirm must be a boolean when provided.' };
  }
  const rawCalls = args.calls;
  if (!Array.isArray(rawCalls)) {
    return { ok: false, error: 'calls must be an array.' };
  }
  if (rawCalls.length > API_TOOL_MAX_CALLS) {
    return { ok: false, error: `calls is capped at ${API_TOOL_MAX_CALLS} items. Split the batch into separate api tool calls.` };
  }

  const calls: ApiToolCall[] = [];
  const invalid: Array<{ index: number; error: string }> = [];

  rawCalls.forEach((rawCall, zeroIndex) => {
    const index = zeroIndex + 1;
    if (!isRecord(rawCall)) {
      invalid.push({ index, error: 'call must be an object.' });
      return;
    }

    const rawMethod = rawCall.method;
    if (typeof rawMethod !== 'string') {
      invalid.push({ index, error: 'method must be one of GET, HEAD, POST, PATCH, PUT, DELETE.' });
      return;
    }
    const method = rawMethod.toUpperCase();
    if (!isApiToolMethod(method)) {
      invalid.push({ index, error: 'method must be one of GET, HEAD, POST, PATCH, PUT, DELETE.' });
      return;
    }

    const pathValidation = validateApiToolPath(rawCall.path);
    if (!pathValidation.ok) {
      invalid.push({ index, error: pathValidation.error });
      return;
    }

    const rawBody = rawCall.body;
    if (rawBody !== undefined && !isRecord(rawBody)) {
      invalid.push({ index, error: 'body must be a JSON object when provided.' });
      return;
    }

    const call: ApiToolCall = { method, path: pathValidation.path };
    if (rawBody !== undefined) call.body = rawBody;
    calls.push(call);
  });

  if (invalid.length > 0) {
    return { ok: false, error: 'Invalid api call batch.', details: invalid };
  }

  const confirmRequiredCalls = calls
    .map((call, zeroIndex) => ({
      index: zeroIndex + 1,
      method: call.method,
      path: call.path,
      reasons: confirmRequiredReasonsForApiToolCall(call),
    }))
    .filter((call) => call.reasons.length > 0);

  return { ok: true, calls, confirmRequiredCalls };
}

function apiToolError(error: string, message: string, details?: unknown): {
  content: McpContentBlock[];
  isError: true;
} {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        ok: false,
        error,
        message,
        ...(details === undefined ? {} : { details }),
      }, null, 2),
    }],
    isError: true,
  };
}

/** Parse a tool arg that may arrive as a JSON string; an already-parsed
 *  value passes through unchanged. Throws a descriptive error (the outer
 *  tools/call catch surfaces the message verbatim) instead of an opaque
 *  SyntaxError when the string isn't valid JSON. */
function parseJsonArg(value: unknown, argName: string): any {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch {
    throw new Error(`Invalid JSON in '${argName}' — pass valid JSON (or the raw object/array).`);
  }
}

function normalizeToolArgAliases(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  const args = { ...input };
  if (args.project_id === undefined) {
    const projectRef = args.projectId ?? args.project ?? args.app_id ?? args.site_id;
    if (typeof projectRef === 'string') args.project_id = projectRef;
  }
  if ((toolName === 'tasks_get' || toolName === 'tasks_list' || toolName === 'tasks_update') && args.task_id === undefined && typeof args.id === 'string') {
    args.task_id = args.id;
  }
  if (toolName === 'db_query' && args.sql === undefined) {
    const sql = args.query ?? args.statement;
    if (typeof sql === 'string') args.sql = sql;
  }
  if (toolName === 'project_patch' && args.path === undefined && typeof args.file === 'string') {
    args.path = args.file;
  }
  if (toolName === 'project_create' && args.subdomain === undefined && typeof args.slug === 'string') {
    args.subdomain = args.slug;
  }
  if (toolName === 'email_send') {
    if (args.text === undefined && args.html === undefined && typeof args.body === 'string') {
      args[args.body.trim().startsWith('<') ? 'html' : 'text'] = args.body;
    }
    if (Array.isArray(args.to) && args.to.length === 1 && typeof args.to[0] === 'string') {
      args.to = args.to[0];
    }
  }
  if (toolName === 'payments_checkout' && args.line_items === undefined && args.items !== undefined) {
    args.line_items = args.items;
  }
  if (toolName === 'browser') {
    if (typeof args.include === 'string') {
      args.include = args.include.split(',').map((s) => s.trim()).filter(Boolean);
    }
    for (const boolKey of ['inline', 'continue_on_failure'] as const) {
      if (args[boolKey] === 'true') args[boolKey] = true;
      if (args[boolKey] === 'false') args[boolKey] = false;
    }
    if (typeof args.steps === 'string') {
      try { args.steps = JSON.parse(args.steps); } catch { /* validated later */ }
    }
    if (isRecord(args.steps)) args.steps = [args.steps];
    if (typeof args.screenshot === 'string') {
      try { args.screenshot = JSON.parse(args.screenshot); } catch { /* validated later */ }
    }
    if (args.screenshot === true) args.screenshot = {};
    if (args.screenshot === false) {
      if (args.inline === undefined) args.inline = false;
      delete args.screenshot;
    }
    if ((typeof args.width === 'number' || typeof args.height === 'number') && typeof args.html !== 'string') {
      const shot = isRecord(args.screenshot) ? { ...args.screenshot } : {};
      if (typeof args.width === 'number') shot.width = args.width;
      args.screenshot = shot;
    }
  }
  return args;
}

type CoerceResult<T> = { ok: true; value: T } | { ok: false; message: string };

function coerceStringMap(raw: unknown, argName: string): CoerceResult<Record<string, string>> {
  if (isRecord(raw)) {
    const out: Record<string, string> = {};
    for (const [path, content] of Object.entries(raw)) {
      if (typeof content !== 'string') {
        return { ok: false, message: `${argName}.${path} must be a string of file content.` };
      }
      out[path] = content;
    }
    return { ok: true, value: out };
  }
  if (Array.isArray(raw)) {
    const out: Record<string, string> = {};
    for (let i = 0; i < raw.length; i++) {
      const item = raw[i];
      if (!isRecord(item) || typeof item.path !== 'string' || typeof item.content !== 'string') {
        return { ok: false, message: `${argName}[${i}] must be { path: string, content: string }.` };
      }
      out[item.path] = item.content;
    }
    return { ok: true, value: out };
  }
  return { ok: false, message: `${argName} must be an object map of path -> string content, or an array of { path, content } objects.` };
}

function coerceStringArray(raw: unknown, argName: string): CoerceResult<string[]> {
  if (typeof raw === 'string') return { ok: true, value: [raw] };
  if (Array.isArray(raw) && raw.every((v) => typeof v === 'string')) return { ok: true, value: raw };
  return { ok: false, message: `${argName} must be a string path or an array of string paths.` };
}

function coerceBaseVersionArg(raw: unknown): CoerceResult<number | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    return { ok: false, message: 'base_version must be an integer number. Omit it, pass null, or pass 0 when the base version is unknown.' };
  }
  return { ok: true, value: raw };
}

function coercePromoteBaseLiveVersionArg(raw: unknown): number | undefined {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw) || raw < 1) {
    return undefined;
  }
  return raw;
}

/** Verify the caller's bearer against the REAL auth layer before an
 *  MCP-native paid tool spends anything. Makes one cheap authenticated
 *  call (GET /v1/projects) through the API service binding: the API
 *  worker's apiKeyAuth/mcp_oauth verifier returns 200 only for a
 *  genuinely valid smt_ key or mcp_oauth JWT, and 401/403 for a forged
 *  or shape-only bearer. Returns true ONLY on 200.
 *
 *  Fail closed: callAPI throws UpstreamOAuthRejectedError on a 401 for
 *  JWT-shaped bearers (caught → false), a forged smt_ returns status
 *  401 (→ false), and any network/parse error → false. The shape-only
 *  `isAuthed` check in the /mcp handler cannot do this — it never
 *  contacts the verifier. tsk_f9c77079. */
async function verifyBearerUpstream(env: Env, authHeader: string): Promise<boolean> {
  try {
    const res = await callAPI(env.API_SERVICE, 'GET', '/v1/projects', authHeader);
    return res.status === 200;
  } catch {
    return false;
  }
}

/** Classify an mcp_oauth JWT or smt_ bearer at the HANDSHAKE (initialize /
 *  tools/list), reusing the SAME upstream verifier that a tools/call
 *  already triggers (callAPI → GET /v1/projects → the API worker's auth
 *  verifier). This is the fail-closed counterpart to the shape-only
 *  bearer checks in the /mcp handler.
 *
 *  Returns:
 *   - 'valid'    → upstream returned 200; the token is live + unexpired.
 *                  Handshake proceeds; a working connector is NOT broken.
 *   - 'rejected' → upstream returned 401 for this JWT (expired / revoked /
 *                  wrong type / bad signature). callAPI raises
 *                  UpstreamOAuthRejectedError on exactly that case. The
 *                  handshake must answer 401 + WWW-Authenticate so Claude.ai
 *                  re-auths BEFORE the user sees a connected-but-dead state.
 *   - 'transient'→ any other failure (non-401 status, network/parse error).
 *                  Do NOT fail the handshake closed on a transient upstream
 *                  blip — a momentary outage must not log a working user out.
 *
 *  Caller is responsible for only invoking this on JWT-shaped or smt_
 *  bearers. tsk_e2781883 / connector handshake asymmetry. */
async function classifyHandshakeBearer(
  env: Env,
  authHeader: string,
): Promise<'valid' | 'rejected' | 'transient'> {
  try {
    const res = await callAPI(env.API_SERVICE, 'GET', '/v1/projects', authHeader);
    if (res.status === 200) return 'valid';
    // A non-401 (5xx, 403, etc.) on a JWT-shaped bearer is not a clean
    // token rejection — treat as transient so we don't bounce a valid
    // session on an upstream hiccup.
    return 'transient';
  } catch (err) {
    // callAPI throws these only when the caller's own bearer was rejected,
    // never for an app-user credential supplied inside a tool call.
    if (err instanceof UpstreamOAuthRejectedError || err instanceof UpstreamApiKeyRejectedError) {
      return 'rejected';
    }
    return 'transient';
  }
}

// Per-IP + per-verified-bearer soft rate limit for MCP-native paid
// tools. Fixed 60s window (Cloudflare KV's minimum expirationTtl floor
// — see worker rate-limit.ts). Verification already blocks unauthed
// spend; this bounds how fast a *valid* caller can run up OpenAI cost.
const ADVISOR_RL_LIMIT = 20;        // calls per window, per scope
const ADVISOR_RL_WINDOW_S = 60;     // window length == KV TTL (>= 60s)

/** Hex SHA-256 so a raw bearer is never written to KV as a key. */
async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256Hex(secret: string, input: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(input));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Soft fixed-window limiter keyed by both client IP and a hash of the
 *  bearer. Returns allowed:false once either scope passes the limit.
 *  No-ops (allowed) when ADVISOR_RL_KV is unbound — verifyBearerUpstream
 *  is the hard spend gate; this is defense-in-depth on top. The small
 *  read-modify-write race at the window boundary is acceptable for soft
 *  throttling (same trade-off as the worker KV limiter). tsk_f9c77079. */
async function checkAdvisorRateLimit(
  env: Env,
  request: Request,
  authHeader: string,
): Promise<{ allowed: boolean; retryAfterS: number }> {
  const kv = env.ADVISOR_RL_KV;
  if (!kv) return { allowed: true, retryAfterS: 0 };
  const ip = request.headers.get('CF-Connecting-IP') || 'noip';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  const scopes = [`advisor:ip:${ip}`, `advisor:id:${await sha256Hex(bearer)}`];
  // Read all scopes first; deny if any is already at the limit.
  const counts = await Promise.all(scopes.map(async (key) => {
    const raw = await kv.get(key);
    return { key, count: raw ? (parseInt(raw, 10) || 0) : 0 };
  }));
  if (counts.some((s) => s.count >= ADVISOR_RL_LIMIT)) {
    return { allowed: false, retryAfterS: ADVISOR_RL_WINDOW_S };
  }
  // Increment every scope. TTL refreshes the window from first call.
  await Promise.all(counts.map((s) =>
    kv.put(s.key, String(s.count + 1), { expirationTtl: ADVISOR_RL_WINDOW_S })));
  return { allowed: true, retryAfterS: 0 };
}

// --- Project ID resolver ---
//
// Claude Code rarely knows the user's project UUID. The MCP tools
// should accept any of: a UUID, a subdomain, or the literal "default"
// (which resolves to the user's only/first project — the common case
// for free-tier users with one app).
//
// This runs once at the top of executeTool, mutating args.project_id
// in place to a resolved UUID before the switch dispatch. Every tool
// that takes a project_id automatically benefits — no per-case
// changes required.
//
// Security: the smt_ API key already scopes /v1/projects to the key
// owner's projects. The resolver can ONLY return UUIDs that belong
// to the caller, so this is purely a UX shortcut, not a permissions
// bypass. Even if Claude Code lies about the project_id, the
// downstream API call still verifies ownership.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ProjectListItem { id: string; subdomain: string; name?: string }

function formatProjectSuggestions(projects: ProjectListItem[]): string {
  const listed = projects.slice(0, 10).map((p) => `  ${p.subdomain} → ${p.id}`).join('\n') || '  (none)';
  const remaining = projects.length - 10;
  return remaining > 0
    ? `${listed}\n  …and ${remaining} more; call project_list for the rest.`
    : listed;
}

async function resolveProjectId(
  rawId: string,
  fetcher: Fetcher,
  authHeader: string
): Promise<string> {
  // 1. Already a UUID — return as-is.
  if (UUID_RE.test(rawId)) return rawId;

  // 2. Look up the user's projects. The smt_ key naturally scopes
  //    this to the caller — we never see other users' projects.
  const list = await callAPI(fetcher, 'GET', '/v1/projects', authHeader);
  if (list.status !== 200) {
    throw new Error(`Could not list projects to resolve "${rawId}" (HTTP ${list.status}).`);
  }
  const payload = list.data as { ok?: boolean; data?: { projects?: ProjectListItem[] } };
  const projects: ProjectListItem[] = payload?.data?.projects ?? [];

  // 3. "default" or empty — return the only project, OR error if there
  //    are zero or multiple.
  if (!rawId || rawId === 'default') {
    if (projects.length === 0) {
      throw new Error('No projects found on this account. Create one first using the create_project tool or POST /v1/projects.');
    }
    if (projects.length === 1) return projects[0].id;
    const listed = formatProjectSuggestions(projects);
    throw new Error(`Multiple projects on this account — pass a specific subdomain or UUID instead of "default":\n${listed}`);
  }

  // 4. Subdomain match.
  const match = projects.find((p) => p.subdomain === rawId);
  if (match) return match.id;

  // 5. Nothing matched — error with the available list so Claude can
  //    correct itself on the next call.
  const listed = formatProjectSuggestions(projects);
  throw new Error(`Project "${rawId}" not found. Your projects:\n${listed}`);
}

const TASK_NOTICE_SENTINEL_TOOLS = new Set([
  'tasks_get', 'tasks_list', 'tasks_create', 'tasks_update', 'tasks_summary',
  'tasks_delete', 'tasks_bulk_update', 'tasks_settings_get', 'tasks_reconcile',
  'tasks_settings_update', 'tasks_comment_edit', 'tasks_comment_delete',
  'memory_save', 'memory_search', 'record', 'recall',
]);

async function fetchProjectNoticePayload(
  fetcher: Fetcher,
  authHeader: string,
  projectRef: string,
): Promise<ProjectNoticePayload | null> {
  let resolvedRef = projectRef;
  if (projectRef === 'default') {
    resolvedRef = await resolveProjectId(projectRef, fetcher, authHeader);
  }
  const response = await callAPI(
    fetcher,
    'GET',
    `/v1/projects/${encodeURIComponent(resolvedRef)}/notices?delivery=mcp`,
    authHeader,
  );
  if (response.status < 200 || response.status >= 300) return null;
  const envelope = response.data as { ok?: boolean; data?: ProjectNoticePayload } | undefined;
  if (!envelope?.ok || !envelope.data || !Array.isArray(envelope.data.notices)) return null;
  return envelope.data;
}

async function fetchConnectNoticeInstructions(
  fetcher: Fetcher,
  authHeader: string,
): Promise<string> {
  try {
    const response = await callAPI(fetcher, 'GET', '/v1/projects/notices', authHeader);
    if (response.status < 200 || response.status >= 300) return '';
    const envelope = response.data as { ok?: boolean; data?: ProjectNoticePayload } | undefined;
    if (!envelope?.ok || !envelope.data || !Array.isArray(envelope.data.notices)) return '';
    return projectNoticeConnectInstructions(envelope.data);
  } catch {
    // Connect notices are advisory context. They must never prevent an MCP
    // session from initializing or alter the caller's authorization boundary.
    return '';
  }
}

async function maybeInjectProjectNoticeContext(
  result: ProjectNoticeToolResult,
  toolName: string,
  rawArgs: Record<string, unknown>,
  fetcher: Fetcher,
  authHeader: string,
): Promise<ProjectNoticeToolResult> {
  const args = normalizeToolArgAliases(toolName, rawArgs);
  const projectRef = typeof args.project_id === 'string' ? args.project_id.trim() : '';
  if (!projectRef) return result;
  if ((projectRef === 'default' || projectRef === 'spine') && TASK_NOTICE_SENTINEL_TOOLS.has(toolName)) {
    return result;
  }
  try {
    const payload = await fetchProjectNoticePayload(fetcher, authHeader, projectRef);
    return payload ? injectProjectNotices(result, toolName, payload) : result;
  } catch {
    // Notice delivery is context-only. A lookup failure must never change the
    // underlying tool result or become a new capability/error surface.
    return result;
  }
}

// --- advisor helpers ────────────────────────────────────────────────
//
interface AdvisorAnswer {
  text: string;
  model: string;
  cost_cents: number;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  latency_ms: number;
  service_tier: 'flex' | 'default';
  diagnostics?: AdvisorDiagnostics;
  /** A typed fallback records an incomplete or failed upstream answer. */
  failure_code: 'ADVISOR_TIMEOUT' | 'ADVISOR_EMPTY_RESPONSE' | 'ADVISOR_UPSTREAM_FAILURE' | 'ADVISOR_INCOMPLETE_RESPONSE' | 'ADVISOR_INCORRECT_ANSWER' | null;
}

type AdvisorAuthMode = 'anonymous' | 'authenticated';
type AdvisorSource = 'mcp' | 'cli' | 'http' | 'docs-warm';

interface AdvisorAccess {
  mode: AdvisorAuthMode;
  serviceTier: 'flex' | 'default';
  retryAfterS: number;
}

/** Atomic anonymous gate in the API worker. The raw address never crosses the
 * service boundary; only a server-keyed HMAC is persisted for the one-minute
 * D1 counter and aggregate funnel events. Fails closed when the gate cannot be
 * reached so an outage cannot turn into unbounded anonymous model spend. */
async function checkAnonymousAdvisorRateLimit(
  env: Env,
  request: Request,
  source: AdvisorSource,
): Promise<{ allowed: boolean; retryAfterS: number }> {
  if (!env.SOMEWHERE_TECH_ADMIN_KEY) {
    throw new Error('anonymous advisor gate is not configured');
  }
  const ip = request.headers.get('CF-Connecting-IP')
    || request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim()
    || 'unknown';
  const req = new Request('https://api-internal/v1/sys/advisor-gate', {
    method: 'POST',
    headers: {
      'X-Admin-Key': env.SOMEWHERE_TECH_ADMIN_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ip_hash: await hmacSha256Hex(env.SOMEWHERE_TECH_ADMIN_KEY, ip), source }),
  });
  const res = await env.API_SERVICE.fetch(req);
  const payload = await res.json<{ ok?: boolean; data?: { allowed?: boolean; retry_after_seconds?: number } }>().catch(() => null);
  if (!res.ok || !payload?.ok || typeof payload.data?.allowed !== 'boolean') {
    throw new Error(`anonymous advisor gate failed (HTTP ${res.status})`);
  }
  return {
    allowed: payload.data.allowed,
    retryAfterS: Math.max(1, payload.data.retry_after_seconds ?? 60),
  };
}

async function authorizeAdvisorCall(
  env: Env,
  request: Request,
  authHeader: string,
  source: AdvisorSource,
): Promise<AdvisorAccess | null> {
  if (!authHeader) {
    const gate = await checkAnonymousAdvisorRateLimit(env, request, source);
    return gate.allowed
      ? { mode: 'anonymous', serviceTier: 'flex', retryAfterS: 0 }
      : { mode: 'anonymous', serviceTier: 'flex', retryAfterS: gate.retryAfterS };
  }
  if (!(await verifyBearerUpstream(env, authHeader))) return null;
  const rate = await checkAdvisorRateLimit(env, request, authHeader);
  return rate.allowed
    ? { mode: 'authenticated', serviceTier: 'default', retryAfterS: 0 }
    : { mode: 'authenticated', serviceTier: 'default', retryAfterS: rate.retryAfterS };
}

/** Load authorized project facts under a shared deadline. Failed reads are
 * unknown facts, never evidence that a feature is absent or broken. */
async function loadProjectContextForAdvisor(
  env: Env,
  authHeader: string,
  projectIdArg: string,
  diagnostics: AdvisorDiagnostics,
): Promise<string | null> {
  const fetcher = advisorContextFetcher(env.API_SERVICE, diagnostics);
  let projectId = projectIdArg;
  try {
    projectId = await resolveProjectId(projectIdArg, fetcher, authHeader);
  } catch {
    return `## PROJECT CONTEXT (requested but unresolvable)\n\nThe developer passed \`project_id: ${JSON.stringify(projectIdArg)}\`, but this developer key cannot resolve it to an owned or shared project. Project-specific guidance is unavailable until a valid accessible id or subdomain is supplied. A generic project must not be inferred.`;
  }

  // Unwrap the `{ ok, data }` envelope returned by callAPI. Returns the
  // inner `data` object on 2xx, or null on any non-2xx / parse failure.
  const factStatuses: AdvisorFactRead[] = [];
  const fetchData = async <T,>(path: string): Promise<T | null> => {
    const fact = { source: path.split('?')[0], scope: (path === '/v1/payments/status' || path === '/v1/hosted/status' || path === '/v1/domains/owned' ? 'caller' : 'project') as 'caller' | 'project', status: 'unavailable' as 'available' | 'denied' | 'unavailable', observed_at: new Date().toISOString() };
    factStatuses.push(fact);
    try {
      const res = await callAPI(fetcher, 'GET', path, authHeader);
      if (res.status === 401 || res.status === 403) fact.status = 'denied';
      if (res.status < 200 || res.status >= 300) return null;
      const env = res.data as { ok?: boolean; data?: unknown };
      if (env && env.ok && env.data !== undefined && env.data !== null) { fact.status = 'available'; return env.data as T; }
      return null;
    } catch {
      return null;
    }
  };

  const [
    project,
    customDomainsResp,
    ownedDomainsResp,
    envResp,
    deployResp,
    paymentsResp,
    errorsResp,
    authUsersResp,
    dbTablesResp,
    cronsResp,
    inboxResp,
    searchResp,
    hostedResp,
  ] = await Promise.all([
    fetchData<Record<string, unknown>>(`/v1/projects/${encodeURIComponent(projectId)}`),
    fetchData<{ domains: Array<Record<string, unknown>> }>(`/v1/domains?project_id=${encodeURIComponent(projectId)}`),
    fetchData<{ domains: Array<Record<string, unknown>> }>(`/v1/domains/owned`),
    fetchData<{ keys: Array<{ key: string }> }>(`/v1/env?project_id=${encodeURIComponent(projectId)}`),
    fetchData<{
      dev_updated_at: string | null;
      prod_updated_at: string | null;
      in_sync: boolean;
      dev_ahead: boolean;
      files_changed: number;
    }>(`/v1/deploy/status?project_id=${encodeURIComponent(projectId)}`),
    fetchData<{
      connected: boolean;
      onboarded: boolean;
      charges_enabled: boolean;
      payouts_enabled?: boolean;
      country?: string | null;
    }>(`/v1/payments/status`),
    fetchData<{ total: number; by_code: Array<{ error_code: string; count: number }> }>(
      `/v1/errors/stats?project_id=${encodeURIComponent(projectId)}&period=24h`,
    ),
    fetchData<{ users: Array<unknown>; next_cursor: string | null; count: number }>(
      `/v1/auth/users?project_id=${encodeURIComponent(projectId)}&limit=1`,
    ),
    fetchData<{ tables: string[] }>(`/v1/db/tables?project_id=${encodeURIComponent(projectId)}`),
    fetchData<{ crons: Array<{ id: string; schedule: string; handler: string; enabled: boolean; name?: string | null }> }>(
      `/v1/cron?project_id=${encodeURIComponent(projectId)}`,
    ),
    fetchData<{ addresses: Array<{ address: string; label: string | null }> }>(
      `/v1/inbox/addresses?project_id=${encodeURIComponent(projectId)}`,
    ),
    fetchData<{ indexes: Array<{ name: string; item_count: number }> }>(
      `/v1/search/index?project_id=${encodeURIComponent(projectId)}`,
    ),
    fetchData<{ status: string; instance_id: string | null }>(`/v1/hosted/status`),
  ]);

  if (!project || typeof project !== 'object') {
    return `## PROJECT CONTEXT (requested but project record not returned)\n\nproject_id ${JSON.stringify(projectIdArg)} resolved to ${JSON.stringify(projectId)}, but the project record could not be loaded. Only general guidance is supported until a readable project record is available.`;
  }

  const read = (source: string): AdvisorFactRead => factStatuses.find(fact => fact.source === source)
    ?? { source, scope: 'project', status: 'unavailable', observed_at: new Date().toISOString() };
  return formatAdvisorProjectFacts(projectId, {
    project: { read: read(`/v1/projects/${encodeURIComponent(projectId)}`), data: project, fields: ['id', 'subdomain', 'name', 'description', 'plan', 'tier', 'status'] },
    custom_domains: { read: read('/v1/domains'), data: customDomainsResp, list: { field: 'domains', fields: ['domain', 'verified', 'purchased', 'ssl_active'] } },
    owned_domains: { read: read('/v1/domains/owned'), data: ownedDomainsResp, list: { field: 'domains', fields: ['domain', 'attached_host', 'claim_status'], projectId } },
    environment: { read: read('/v1/env'), data: envResp, list: { field: 'keys', fields: ['key'] } },
    deploy: { read: read('/v1/deploy/status'), data: deployResp, fields: ['dev_updated_at', 'prod_updated_at', 'in_sync', 'dev_ahead', 'files_changed'] },
    payments: { read: read('/v1/payments/status'), data: paymentsResp, fields: ['connected', 'onboarded', 'charges_enabled', 'payouts_enabled', 'country'] },
    errors: { read: read('/v1/errors/stats'), data: errorsResp, fields: ['total'], list: { field: 'by_code', fields: ['error_code', 'count'] } },
    auth: { read: read('/v1/auth/users'), data: authUsersResp ? { count: authUsersResp.count, returned_count: Array.isArray(authUsersResp.users) ? authUsersResp.users.length : undefined, has_more: typeof authUsersResp.next_cursor === 'string' ? true : authUsersResp.next_cursor === null ? false : undefined } : null, fields: ['count', 'returned_count', 'has_more'] },
    database: { read: read('/v1/db/tables'), data: dbTablesResp, list: { field: 'tables' } },
    cron: { read: read('/v1/cron'), data: cronsResp, list: { field: 'crons', fields: ['id', 'schedule', 'handler', 'enabled', 'name'] } },
    inbox: { read: read('/v1/inbox/addresses'), data: inboxResp, list: { field: 'addresses', fields: ['address', 'label'] } },
    search: { read: read('/v1/search/index'), data: searchResp, list: { field: 'indexes', fields: ['name', 'item_count'] } },
    workspace: { read: read('/v1/hosted/status'), data: hostedResp, fields: ['status', 'instance_id'] },
  });
}

/** Shared evidence and output policy. Relevant canonical documentation and
 * caller-visible tool schemas are selected per question. */
const __cachedStaticSystems = new Map<ToolSurface, string>();
function buildStaticSystemPrompt(surface: ToolSurface): string {
  const cached = __cachedStaticSystems.get(surface);
  if (cached !== undefined) return cached;

  const philosophy = ADVISOR_SYSTEM_POLICY;

  const system = constrainCanonicalText([
    philosophy,
    '',
    ADVISOR_CONTEXT_SECURITY_POLICY,
    '',
    '---',
    '',
    '# PLATFORM DOCUMENTATION',
    '',
    'Relevant documentation is supplied below. A missing excerpt means unknown, not unsupported. Use docs for the full named topic.',
    '',
    '---',
    '',
    '# MCP TOOL_DEFINITIONS (agent-callable names)',
    '',
    'Use only names in the following allowlist, with arguments grounded in the selected documentation.',
    '',
    '---',
    '',
    'The relevant tool entries below supply exact names and argument schemas.',
  ].join('\n'), surface);
  __cachedStaticSystems.set(surface, system);
  return system;
}

/** Context-only, bounded advice using the configured model and caller authority. */
async function callPlatformAdvisor(
  env: Env,
  authHeader: string,
  question: string,
  projectIdArg: string | null,
  surface: ToolSurface,
  caller: CallerKind = 'unknown',
  authMode: AdvisorAuthMode = 'authenticated',
  serviceTier: 'flex' | 'default' = 'default',
  clientContext: string | null = null,
): Promise<AdvisorAnswer> {
  const startedAt = Date.now();
  const diagnostics: AdvisorDiagnostics = { context_ms: 0, context_reads: [], prompt_chars: 0, topics: [], attempts: [] };
  const contractAnswer = advisorWebhookContractAnswer(question) ?? (!projectIdArg && !clientContext ? advisorContractAnswer(question) : null);
  if (contractAnswer) {
    if (projectIdArg && authMode === 'authenticated') {
      await loadProjectContextForAdvisor(env, authHeader, projectIdArg, diagnostics);
      diagnostics.context_ms = Date.now() - startedAt;
    }
    return {
      text: contractAnswer,
      model: 'static-contract',
      cost_cents: 0,
      input_tokens: 0,
      output_tokens: 0,
      cached_input_tokens: 0,
      latency_ms: Date.now() - startedAt,
      service_tier: serviceTier,
      failure_code: null,
      diagnostics,
    };
  }
  if (!env.OPENAI_API_KEY) {
    diagnostics.attempts.push({ duration_ms: 0, status: null, outcome: 'not_configured', request_id: null });
    return { text: advisorFallbackText('ADVISOR_UPSTREAM_FAILURE', [], 'not_configured'), model: 'unavailable',
      cost_cents: 0, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, latency_ms: Date.now() - startedAt,
      service_tier: serviceTier, failure_code: 'ADVISOR_UPSTREAM_FAILURE', diagnostics };
  }

  const systemParts = [buildStaticSystemPrompt(surface)];
  let projectContext: string | null = null;
  systemParts.push('');
  systemParts.push(authMode === 'anonymous'
    ? 'AUTH CONTEXT: This is an anonymous top-of-funnel question. Give a useful docs-grounded answer, but clearly mark any account-scoped tool or live-project step as requiring login. You have no live project state.'
    : 'AUTH CONTEXT: This caller is verified. Account-scoped tools are available, and a live project snapshot follows only when project_id was supplied.');
  // State which execution surfaces the caller actually has.
  if (caller === 'cli') {
    systemParts.push('');
    systemParts.push("CALLER CONTEXT: This caller has a shell. Use `somewhere call <tool> '<json>'` with the provided tool argument schemas for operations. Do not invent subcommands or flags. `somewhere docs <topic>`, `somewhere dev`, and `somewhere deploy` are also valid. Cron handler is a /api URL path or full HTTPS URL, never a source filename.");
  } else if (caller === 'connector') {
    systemParts.push('');
    systemParts.push('CALLER CONTEXT: This is a connector client. Describe actions using the tools advertised on this connection. Do not assume a terminal is available; if the caller states that it has one, CLI commands are an alternative.');
  }
  if (authMode === 'authenticated' && projectIdArg) {
    const contextStartedAt = Date.now();
    projectContext = await loadProjectContextForAdvisor(env, authHeader, projectIdArg, diagnostics);
    diagnostics.context_ms = Date.now() - contextStartedAt;
  }
  const advertised = advertisedNamesForSurface(surface);
  const advertisedTools = TOOL_DEFINITIONS.filter((tool) => advertised.has(tool.name));
  const knowledge = selectAdvisorKnowledge(question, PLATFORM_HELP_TOPICS, advertisedTools, { caller });
  diagnostics.topics = knowledge.topics;
  diagnostics.knowledge = knowledge.selection;
  systemParts.push(constrainCanonicalText(knowledge.text, surface), advisorIntegrationContext(question));
  systemParts.push('Use only runtime methods present in the supplied canonical contracts. A missing method is unknown, not an invitation to invent a convenience helper. Code snippets must execute under the documented runtime, including valid absolute redirect URLs. Where required command values are missing, explain the missing values without emitting placeholder executable commands.');
  systemParts.push('Give one concise bullet per requested decision, including unsupported/manual steps. State each constraint once. Include only commands or signatures needed for the requested next steps; put optional implementation detail behind the named docs topics. Give exact signatures and commands. When the request asks for file shapes or implementation, provide the minimal complete handlers and browser bridge needed for those requested components. Label proposed app schema and design choices as proposals, not existing project facts; complete independent components even when one external decision is missing. Keep optional elaboration behind named docs topics. Never guess missing amounts, credentials or existing project state. When the amount is missing, omit every checkout code block AND checkout command and say which value is needed. This also forbids inline backtick invocations, parenthesized signatures, and object or variable placeholders: do not write sw.payments.checkout(...) or payments_checkout(...). You may name the API without parentheses, ask for the exact amount, and explain the other supported setup steps. Never emit pseudo-JSON such as AMOUNT_CENTS inside a CLI argument. Zero is NOT a placeholder price. Code must parse: never leave a blank assignment, comment in place of an expression, or ellipsis.');
  systemParts.push(ADVISOR_COMPOSITION_PROMPT);
  const system = systemParts.join('\n');
  diagnostics.prompt_chars = system.length;
  const untrustedContext = [
    projectContext ? `LIVE PROJECT SNAPSHOT:\n${projectContext}` : null,
    clientContext ? `CLIENT-SUPPLIED DIAGNOSTIC CONTEXT:\n${clientContext}` : null,
  ].filter((part): part is string => part !== null).join('\n\n') || null;

  const model = advisorModel(env.ADVISOR_MODEL);
  diagnostics.requested_model = model;
  if (!advisorModelSupported(model)) {
    diagnostics.attempts.push({ duration_ms: 0, status: null, outcome: 'invalid_parameter', request_id: null });
    return { text: advisorFallbackText('ADVISOR_UPSTREAM_FAILURE', diagnostics.topics, 'invalid_parameter'), model, cost_cents: 0, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, latency_ms: Date.now() - startedAt, service_tier: serviceTier, failure_code: 'ADVISOR_UPSTREAM_FAILURE', diagnostics };
  }
  const promptCacheKey = `advisor:${surface}:${(await sha256Hex(system)).slice(0, 32)}`;
  const requestBody = JSON.stringify({
    model,
    reasoning: { effort: 'none' },
    text: { verbosity: 'low', format: ADVISOR_COMPOSITION_FORMAT },
    input: buildAdvisorInput(system, question, untrustedContext),
    prompt_cache_key: promptCacheKey,
    service_tier: serviceTier,
    store: false,
    max_output_tokens: ADVISOR_MAX_OUTPUT_TOKENS,
  });
  let failureCode: AdvisorAnswer['failure_code'] = null;
  let usage = { model, cost_cents: 0, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, service_tier: serviceTier };
  diagnostics.usage_status = 'unconfirmed';

  // One end-to-end budget includes context and a single final inference.
  // Preserve an upstream failure instead of concealing it with a second call.
  for (let attempt = 0; attempt < 1; attempt += 1) {
    const elapsed = Date.now() - startedAt;
    const timeoutMs = ADVISOR_RESPONSE_BUDGET_MS - elapsed;
    if (timeoutMs < 500) {
      failureCode = 'ADVISOR_TIMEOUT';
      break;
    }
    const attemptStartedAt = Date.now();
    const diagnostic: AdvisorDiagnostics['attempts'][number] = { duration_ms: 0, status: null, outcome: 'upstream_failure', request_id: null };
    diagnostics.attempts.push(diagnostic);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
          'content-type': 'application/json',
        },
        body: requestBody,
        signal: controller.signal,
      });
      diagnostic.status = resp.status;
      diagnostic.request_id = resp.headers.get('x-request-id');
      const ct = resp.headers.get('Content-Type') || '';
      if (!ct.includes('application/json')) {
        failureCode = 'ADVISOR_UPSTREAM_FAILURE';
        continue;
      }
      const payload = await resp.json<{
        error?: { message?: string; code?: string };
        status?: string;
        incomplete_details?: { reason?: string };
        output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>;
        model?: string;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
          output_tokens_details?: { reasoning_tokens?: number };
        };
        service_tier?: string;
      }>();
      diagnostics.served_model = payload.model;
      diagnostics.served_tier = payload.service_tier;
      if (payload.usage && Number.isSafeInteger(payload.usage.input_tokens) && payload.usage.input_tokens! >= 0
          && Number.isSafeInteger(payload.usage.output_tokens) && payload.usage.output_tokens! >= 0
          && Number.isSafeInteger(payload.usage.input_tokens_details?.cached_tokens ?? 0)
          && (payload.usage.input_tokens_details?.cached_tokens ?? 0) >= 0
          && Number.isSafeInteger(payload.usage.input_tokens_details?.cache_write_tokens ?? 0)
          && (payload.usage.input_tokens_details?.cache_write_tokens ?? 0) >= 0
          && (payload.usage.input_tokens_details?.cached_tokens ?? 0) + (payload.usage.input_tokens_details?.cache_write_tokens ?? 0) <= payload.usage.input_tokens!) {
        const inTok = payload.usage.input_tokens ?? 0;
        const cachedTok = payload.usage.input_tokens_details?.cached_tokens ?? 0;
        const cacheWriteTok = payload.usage.input_tokens_details?.cache_write_tokens ?? 0;
        const outTok = payload.usage.output_tokens ?? 0;
        const servedTier = payload.service_tier === 'flex' || payload.service_tier === 'default' ? payload.service_tier : null;
        const servedModel = payload.model || model;
        diagnostics.usage = { input_tokens: inTok, cached_input_tokens: cachedTok, cache_write_input_tokens: cacheWriteTok, output_tokens: outTok };
        const cost = payload.model && servedTier
          ? advisorTokenCostCents(payload.model, inTok, cachedTok, cacheWriteTok, outTok, servedTier)
          : null;
        usage = { model: servedModel, cost_cents: cost ?? 0, input_tokens: inTok, output_tokens: outTok, cached_input_tokens: cachedTok, service_tier: servedTier ?? serviceTier };
        diagnostics.usage_status = cost !== null
          ? 'token_estimate'
          : (!payload.model || !servedTier ? 'unconfirmed' : 'unpriced_model');
      }
      if (!resp.ok) {
        failureCode = 'ADVISOR_UPSTREAM_FAILURE';
        diagnostic.outcome = payload.error?.code ?? 'upstream_failure';
        if (resp.status < 500 && resp.status !== 429) break;
        continue;
      }
      if (payload.status === 'incomplete' || payload.status === 'failed') {
        failureCode = 'ADVISOR_INCOMPLETE_RESPONSE';
        diagnostic.outcome = payload.incomplete_details?.reason ?? payload.status;
        break;
      }
      let text = '';
      for (const item of payload.output || []) {
        if (item.type === 'message') {
          for (const c of item.content || []) {
            if (c.type === 'output_text' && typeof c.text === 'string') text += c.text;
          }
        }
      }
      if (!text.trim()) { failureCode = 'ADVISOR_EMPTY_RESPONSE'; diagnostic.outcome = 'empty_response'; break; }
      const composition = parseAdvisorComposition(text);
      if (!composition) { failureCode = 'ADVISOR_INCORRECT_ANSWER'; diagnostic.outcome = 'composition_invalid'; break; }
      const rendered = renderAdvisorComposition(composition, { tools: advertisedTools, projectId: advisorAuthorizedProjectId(projectContext), caller });
      const constrainedText = constrainCanonicalText(rendered.text, surface);
      if (!constrainedText.trim()) {
        failureCode = 'ADVISOR_EMPTY_RESPONSE';
        diagnostic.outcome = 'empty_response';
        continue;
      }
      const commands = checkAdvisorCommands(rendered.text, advertisedTools);
      const commandFailure = commands.ok ? null : 'ADVISOR_INCORRECT_ANSWER';
      diagnostic.outcome = commands.ok ? (rendered.omissions.length ? 'completed_with_omissions' : commands.unvalidated ? 'completed_commands_unvalidated' : 'completed') : commands.reason;
      return {
        text: commandFailure ? advisorFallbackText(commandFailure, diagnostics.topics) : constrainedText,
        ...usage,
        latency_ms: Date.now() - startedAt,
        failure_code: commandFailure,
        diagnostics,
      };
    } catch (err) {
      failureCode = controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')
        ? 'ADVISOR_TIMEOUT'
        : 'ADVISOR_UPSTREAM_FAILURE';
      diagnostic.outcome = failureCode;
    } finally {
      diagnostic.duration_ms = Date.now() - attemptStartedAt;
      clearTimeout(timer);
    }
  }

  const finalFailure = failureCode || 'ADVISOR_UPSTREAM_FAILURE';
  return {
    text: advisorFallbackText(finalFailure, diagnostics.topics, diagnostics.attempts.at(-1)?.outcome),
    ...usage,
    latency_ms: Date.now() - startedAt,
    failure_code: finalFailure,
    diagnostics,
  };
}

interface HelpCallRecord {
  kind: 'docs' | 'advisor';
  requestText: string;
  answerText: string;
  surface: string;
  sessionId: string | null;
  projectId: string | null;
  latencyMs: number;
  contextAttached?: boolean;
  contextText?: string | null;
  diagnostics?: AdvisorDiagnostics;
}

function queueHelpCall(
  env: Env,
  ctx: ExecutionContext | undefined,
  authHeader: string,
  record: HelpCallRecord,
): void {
  const promise = logHelpCall(env, authHeader, record);
  if (ctx) ctx.waitUntil(promise); else void promise;
}

/** The audit log is intentionally one row per call. It stores the exact
 * request and response for a human or agent to read; it never aggregates or
 * compares calls beyond the exact-repeat bit calculated by the API. */
async function logHelpCall(env: Env, authHeader: string, record: HelpCallRecord): Promise<void> {
  if (!env.SOMEWHERE_TECH_ADMIN_KEY) return;
  try {
    const req = new Request('https://api-internal/v1/sys/help-call', {
      method: 'POST',
      headers: {
        'X-Admin-Key': env.SOMEWHERE_TECH_ADMIN_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        kind: record.kind,
        request: record.requestText,
        answer: record.answerText,
        surface: record.surface,
        session_id: record.sessionId,
        project_id: record.projectId,
        latency_ms: record.latencyMs,
        context_attached: record.contextAttached === true,
        context_text: record.contextText ?? null,
        diagnostics: record.diagnostics ?? null,
      }),
    });
    await env.API_SERVICE.fetch(req);
  } catch (err) {
    console.error('[help-call] audit insert failed:', err);
  }
}

/** Keep the existing advisor cost ledger while writing the canonical per-call
 * audit row used to review both docs and advisor responses. */
async function logAdvisorQuery(
  env: Env,
  authHeader: string,
  question: string,
  answer: AdvisorAnswer,
  authMode: AdvisorAuthMode = 'authenticated',
  source: AdvisorSource = 'mcp',
  audit: Omit<HelpCallRecord, 'kind' | 'requestText' | 'answerText'> = {
    surface: 'mcp:full',
    sessionId: null,
    projectId: null,
    latencyMs: 0,
    contextAttached: false,
    contextText: null,
  },
): Promise<void> {
  if (!env.SOMEWHERE_TECH_ADMIN_KEY) return;
  const auditPromise = logHelpCall(env, authHeader, {
    kind: 'advisor',
    requestText: question,
    answerText: answer.text,
    ...audit,
    diagnostics: answer.diagnostics,
  });
  const callerKeyPrefix = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7, 7 + 12)
    : '';
  try {
    const req = new Request('https://api-internal/v1/sys/advisor-log', {
      method: 'POST',
      headers: {
        'X-Admin-Key': env.SOMEWHERE_TECH_ADMIN_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        question,
        answer: answer.text,
        model: answer.model,
        cost_cents: answer.cost_cents,
        input_tokens: answer.input_tokens,
        output_tokens: answer.output_tokens,
        cached_input_tokens: answer.cached_input_tokens,
        latency_ms: answer.latency_ms,
        caller_key_prefix: callerKeyPrefix || null,
        auth_mode: authMode,
        source,
        service_tier: answer.service_tier,
      }),
    });
    await env.API_SERVICE.fetch(req);
  } catch (err) {
    console.error('[advisor] advisor-log insert failed:', err);
  }
  await auditPromise;
}

function advisorSourceForRequest(request: Request): AdvisorSource {
  const explicit = request.headers.get('X-Somewhere-Advisor-Source');
  if (explicit === 'docs-warm') return 'docs-warm';
  const ua = request.headers.get('User-Agent') || '';
  return /somewhere-cli/i.test(ua) ? 'cli' : 'http';
}

/** A fallback stays a normal, verbatim call row; its surface makes the recorded
 * failure visible without adding an aggregate or dropping the returned text. */
function advisorAuditSurface(surface: string, answer: AdvisorAnswer): string {
  return answer.failure_code ? `${surface}:${answer.failure_code.replace('ADVISOR_', '').toLowerCase()}` : surface;
}

/** This transport has no server-issued MCP session. Preserve a client/session
 * correlation id when the transport provides one, fall back to the W3C trace
 * id when present, and leave it null rather than inventing a false session. */
function helpSessionIdForRequest(request: Request, traceContext?: ModernTraceContext): string | null {
  const transportSession = request.headers.get('Mcp-Session-Id')
    ?? request.headers.get('X-Somewhere-Session-Id');
  if (transportSession && /^[a-z0-9._:-]{1,128}$/i.test(transportSession)) {
    return transportSession;
  }
  const traceId = traceContext?.traceparent?.split('-')[1];
  return traceId && /^[a-f0-9]{32}$/i.test(traceId) ? `trace:${traceId}` : null;
}

async function handlePublicAdvisor(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  authHeader: string,
): Promise<Response> {
  let body: { question?: unknown; project_id?: unknown; context?: unknown };
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ ok: false, error: 'VALIDATION_ERROR', message: 'Body must be JSON.' }, 400);
  }
  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (!question || question.length > 6000) {
    return jsonResponse({
      ok: false,
      error: 'VALIDATION_ERROR',
      message: 'question is required and must be at most 6000 characters.',
    }, 400);
  }
  const clientContext = sanitizeAdvisorContext(body.context);
  const contextText = formatAdvisorContext(clientContext);
  const projectId = typeof body.project_id === 'string' && body.project_id.trim()
    ? body.project_id.trim()
    : clientContext?.project_ref ?? null;
  const source = advisorSourceForRequest(request);
  let access: AdvisorAccess | null;
  try {
    access = await authorizeAdvisorCall(env, request, authHeader, source);
  } catch (err) {
    console.error('[advisor] access gate failed:', err);
    return jsonResponse({
      ok: false,
      error: 'ADVISOR_GATE_UNAVAILABLE',
      message: 'The advisor is temporarily unavailable. Try again shortly.',
    }, 503);
  }
  if (!access) {
    return jsonResponse({
      ok: false,
      error: 'UNAUTHORIZED',
      message: 'The supplied session is invalid. Run `somewhere login`, or omit it to ask anonymously.',
    }, 401);
  }
  if (access.retryAfterS > 0) {
    return jsonResponse({
      ok: false,
      error: 'RATE_LIMITED',
      message: `Advisor rate limit reached. Try again in ${access.retryAfterS}s.`,
      retry_after_seconds: access.retryAfterS,
    }, 429);
  }
  if (access.mode === 'anonymous' && projectId) {
    return jsonResponse({
      ok: false,
      error: 'AUTH_REQUIRED_FOR_PROJECT_CONTEXT',
      message: 'Live project context requires login. Omit --project to ask anonymously, or run `somewhere login`.',
    }, 401);
  }

  const caller: CallerKind = source === 'cli' || source === 'docs-warm' ? 'cli' : 'unknown';
  try {
    const answer = await callPlatformAdvisor(
      env,
      authHeader,
      question,
      projectId,
      'full',
      caller,
      access.mode,
      access.serviceTier,
      contextText,
    );
    const constrainedText = constrainCanonicalText(answer.text, 'full');
    const finalText = access.mode === 'anonymous'
      ? `${constrainedText}\n\n---\nLog in for faster answers.`
      : constrainedText;
    const loggedAnswer = { ...answer, text: finalText };
    if (loggedAnswer.failure_code) {
      console.error('[advisor] returning typed fallback:', loggedAnswer.failure_code);
    }
    ctx.waitUntil(logAdvisorQuery(env, authHeader, question, loggedAnswer, access.mode, source, {
      surface: advisorAuditSurface(`advisor:${source}`, loggedAnswer),
      sessionId: helpSessionIdForRequest(request),
      projectId,
      latencyMs: answer.latency_ms,
      contextAttached: contextText !== null,
      contextText,
    }));
    return jsonResponse({
      ok: true,
      data: {
        answer: finalText,
        model: answer.model,
        service_tier: answer.service_tier,
        authenticated: access.mode === 'authenticated',
        live_project_context: !!answer.diagnostics?.context_reads.some((read) => read.path.startsWith('/v1/projects/') && read.outcome === 'loaded'),
      },
    });
  } catch (err) {
    console.error('[advisor] completion failed:', err);
    return jsonResponse({
      ok: false,
      error: 'ADVISOR_UNAVAILABLE',
      message: 'The advisor could not answer right now. Try again shortly.',
    }, 503);
  }
}

// --- Tool Execution ---

// MCP content block — either a text response or an inline image
// (e.g. ai_generate_image, render_screenshot). Used to be text-only
// in the return type, which made the image-push branch at the bottom
// of the function fail typecheck (audit §"MCP Server Type Errors").
type McpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

interface ToolExecutionResult {
  content: McpContentBlock[];
  structuredContent?: unknown;
  isError?: boolean;
}

/**
 * Keep every failed tool call machine-readable at the one response boundary.
 *
 * MCP represents an ordinary tool failure as a successful JSON-RPC response
 * whose result has `isError: true`. A few early-return paths historically put
 * bare prose in that result's text block, while most handlers returned JSON.
 * Strict clients therefore could not consume one stable result envelope. Keep
 * already-structured failures byte-for-byte, and wrap only bare-text failures.
 */
function jsonSafeToolError(result: ToolExecutionResult): ToolExecutionResult {
  if (!result.isError) return result;
  const textBlocks = result.content.filter(
    (block): block is Extract<McpContentBlock, { type: 'text' }> => block.type === 'text',
  );
  if (textBlocks.length === 1) {
    try {
      JSON.parse(textBlocks[0].text);
      return result;
    } catch { /* wrap the bare-text failure below */ }
  }
  const message = textBlocks.map((block) => block.text.trim()).filter(Boolean).join('\n')
    || 'The tool call failed.';
  return {
    ...result,
    content: [
      {
        type: 'text',
        text: JSON.stringify({ ok: false, error: 'TOOL_ERROR', message }, null, 2),
      },
      ...result.content.filter((block) => block.type !== 'text'),
    ],
  };
}

interface UploadMintRecord {
  url: string;
  path: string;
  expires_at: string;
  max_size: number;
  content_type: string;
  public?: boolean;
}

function envelopeDataObject(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object') return null;
  const envelope = payload as Record<string, unknown>;
  return envelope.data && typeof envelope.data === 'object'
    ? envelope.data as Record<string, unknown>
    : envelope;
}

function uploadErrorMessage(payload: unknown, fallback: string): string {
  const data = envelopeDataObject(payload);
  return typeof data?.message === 'string' && data.message.trim() ? data.message : fallback;
}

async function mintUploadRelay(
  fetcher: Fetcher,
  authHeader: string,
  projectId: unknown,
  path: unknown,
  contentType: string,
  makePublic: boolean,
): Promise<UploadMintRecord> {
  const response = await callAPI(fetcher, 'POST', '/v1/fs/upload-url', authHeader, {
    project_id: projectId,
    path,
    content_type: contentType,
    public: makePublic,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new FileUploadError(
      'FS_UPLOAD_MINT_FAILED',
      uploadErrorMessage(response.data, `Could not authorize the file upload (HTTP ${response.status}).`),
      response.status,
      response.data,
    );
  }
  const data = envelopeDataObject(response.data);
  if (
    typeof data?.url !== 'string'
    || typeof data.path !== 'string'
    || typeof data.expires_at !== 'string'
    || typeof data.max_size !== 'number'
    || typeof data.content_type !== 'string'
  ) {
    throw new FileUploadError(
      'FS_UPLOAD_MINT_BAD_RESPONSE',
      'The upload relay did not return a valid one-time upload URL.',
      502,
    );
  }
  return {
    url: data.url,
    path: data.path,
    expires_at: data.expires_at,
    max_size: data.max_size,
    content_type: data.content_type,
    public: data.public === true,
  };
}

function fileUploadToolError(error: FileUploadError): ToolExecutionResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({
      ok: false,
      error: error.code,
      message: error.message,
      ...(error.status ? { status: error.status } : {}),
      ...(error.detail !== undefined ? { detail: error.detail } : {}),
    }, null, 2) }],
    isError: true,
  };
}

function attachSavedUploadResult(
  payload: unknown,
  paths: string[],
  records: StorageRecord[],
): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: true, data: { saved_attachment_paths: paths, saved_attachments: records } };
  }
  const envelope = payload as Record<string, unknown>;
  const data = envelope.data && typeof envelope.data === 'object' && !Array.isArray(envelope.data)
    ? envelope.data as Record<string, unknown>
    : {};
  return {
    ...envelope,
    data: {
      ...data,
      saved_attachment_paths: paths,
      saved_attachments: records,
    },
  };
}

interface NextCallRecommendation {
  tool: string;
  args_skeleton: Record<string, unknown>;
  one_line_why: string;
}

function sanitizeAgentText(value: string, maxLength: number): string {
  return value
    .replace(/[\x00-\x1f\x7f-\x9f\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/**
 * One-line human summary for ChatGPT mode. The full JSON payload
 * goes into `structuredContent` so the model has the structured
 * data to reason over; this string is what ChatGPT shows in the
 * chat bubble — keep it short and headline-y.
 *
 * Defensive: handles error envelopes, common success fields, and
 * falls back to "Done" when nothing maps. Truncates long values so
 * a giant project name doesn't blow up the bubble. */
function projectSiteDomain(flag?: string): string {
  return flag === '1' ? 'somewhere.site' : 'somewhere.tech';
}

function summarizeForChatgpt(payload: unknown, isError: boolean, projectDomain: string): string {
  if (!payload || typeof payload !== 'object') {
    return isError ? '✗ Error.' : '✓ Done.';
  }
  const p = payload as Record<string, unknown>;
  if (p.ok === false || p.error) {
    const code = canonicalErrorCode(payload);
    const e = p.error as { message?: string } | string | undefined;
    const msg = typeof p.message === 'string' ? p.message
      : typeof e === 'string' ? e
      : (typeof e === 'object' && e && typeof e.message === 'string') ? e.message
      : 'Tool returned an error.';
    return `✗ ${code ? `${code}: ` : ''}${String(msg).slice(0, 200)}`;
  }
  const dRaw = (p.data && typeof p.data === 'object') ? p.data : p;
  const d = dRaw as Record<string, unknown>;
  const cap = (s: unknown, n = 80): string => String(s).slice(0, n);
  const frag: string[] = [];
  if (typeof d.name === 'string' && typeof d.project_id === 'string') {
    frag.push(`Project ${cap(d.name)} (${cap(d.project_id, 36)})`);
  } else if (typeof d.name === 'string') {
    frag.push(cap(d.name));
  }
  if (typeof d.url === 'string')      frag.push(`URL: ${cap(d.url, 120)}`);
  if (typeof d.live_url === 'string') frag.push(`Live: ${cap(d.live_url, 120)}`);
  if (typeof d.subdomain === 'string' && !d.url && !d.live_url) {
    frag.push(`https://${cap(d.subdomain, 80)}.${projectDomain}`);
  }
  if (typeof d.version === 'number')  frag.push(`v${d.version}`);
  if (Array.isArray(d.files))         frag.push(`${d.files.length} file(s)`);
  if (Array.isArray(d.results))       frag.push(`${d.results.length} result(s)`);
  if (typeof d.count === 'number')    frag.push(`${d.count} row(s)`);
  if (Array.isArray(d.warnings) && d.warnings.length > 0) {
    frag.push(`⚠ ${d.warnings.length} warning(s)`);
  }
  if (frag.length === 0) return '✓ Done.';
  return `✓ ${frag.join(' · ')}`;
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

function nearestToolName(name: string): string | null {
  let best: string | null = null, bestD = Infinity;
  for (const t of TOOL_DEFINITIONS) {
    const d = levenshtein(name, t.name);
    if (d < bestD) { bestD = d; best = t.name; }
  }
  // Only suggest if it reads like a typo, not a wild guess.
  return best !== null && bestD <= Math.max(2, Math.floor(name.length / 3)) ? best : null;
}

/** Deterministic correction for an unknown tool name, with its source for
 *  the miss log. Returns null when we have no confident deterministic guess. */
function toolSkeleton(toolName: string): Record<string, unknown> {
  const tool = TOOL_DEFINITIONS.find((t) => t.name === toolName);
  if (!tool) return {};
  const skeleton: Record<string, unknown> = {};
  for (const key of tool.inputSchema.required) {
    const prop = tool.inputSchema.properties[key];
    const type = Array.isArray(prop?.type) ? prop?.type[0] : prop?.type;
    skeleton[key] = type === 'number' ? 0
      : type === 'boolean' ? false
      : type === 'array' ? []
      : type === 'object' ? {}
      : `<${key}>`;
  }
  return skeleton;
}

function formatNextCall(nextCall: NextCallRecommendation): string {
  return `${nextCall.tool}(${JSON.stringify(nextCall.args_skeleton)}) — ${nextCall.one_line_why}`;
}

function catalogNextCall(search: string): NextCallRecommendation {
  const safeSearch = sanitizeAgentText(search, 120);
  return {
    tool: 'catalog',
    args_skeleton: safeSearch ? { search: safeSearch } : {},
    one_line_why: 'No exact replacement is known; catalog searches the live tool list.',
  };
}

const SAFETY_ARGUMENT_NAMES = [
  'expected_version',
  'base_version',
  'base_live_version',
  'confirm',
  'code',
  'confirm_token',
  'purge',
  'draft_id',
  'force',
  'dry_run',
  'preview',
  'draft',
  'scope',
  'replace_functions',
] as const;

function canonicalErrorCode(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const out = payload as Record<string, unknown>;
  if (typeof out.error === 'string') return out.error;
  if (out.error && typeof out.error === 'object' && !Array.isArray(out.error)) {
    const nested = out.error as Record<string, unknown>;
    if (typeof nested.code === 'string') return nested.code;
  }
  if (typeof out.code === 'string') return out.code;
  if (out.data && typeof out.data === 'object' && !Array.isArray(out.data)) {
    return canonicalErrorCode(out.data);
  }
  return null;
}

function currentVersionFromError(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const out = payload as Record<string, unknown>;
  if (typeof out.current_version === 'number') return out.current_version;
  if (out.data && typeof out.data === 'object' && !Array.isArray(out.data)) {
    return currentVersionFromError(out.data);
  }
  return null;
}

function activeReleaseIdFromError(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const out = payload as Record<string, unknown>;
  if (typeof out.active_release_id === 'string' && out.active_release_id) {
    return out.active_release_id;
  }
  if (out.data && typeof out.data === 'object' && !Array.isArray(out.data)) {
    return activeReleaseIdFromError(out.data);
  }
  return null;
}

function confirmationCodeFromError(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const out = payload as Record<string, unknown>;
  if (typeof out.code === 'string' && /^\d{6}$/.test(out.code)) return out.code;
  if (out.data && typeof out.data === 'object' && !Array.isArray(out.data)) {
    return confirmationCodeFromError(out.data);
  }
  return null;
}

/** STALE_BASE / STALE_RELEASE_BASE recovery is diff-then-decide, never a blind
 *  same-tool retry: the base the agent deployed/patched/promoted from is stale,
 *  so re-reading the remote changes must come first. Route to the surface's diff
 *  tool where it exists (full), else to a re-read that IS on the surface
 *  (project_export on chatgpt/connector), never a same-tool deploy/patch/promote
 *  skeleton carrying the stale base. Mirrors the deterministic recovery TEXT. */
function staleBaseRecoveryNextCall(
  attemptedArgs: Record<string, unknown>,
  payload: unknown,
  surface: ToolSurface,
): NextCallRecommendation {
  const project_id = projectRefForSkeleton(attemptedArgs);
  if (surfaceAllowsCanonicalTool(surface, 'project_diff_versions')) {
    const from = typeof attemptedArgs.base_version === 'number'
      ? attemptedArgs.base_version
      : (typeof attemptedArgs.base_live_version === 'number' ? attemptedArgs.base_live_version : undefined);
    const to = currentVersionFromError(payload);
    const args_skeleton: Record<string, unknown> = { project_id };
    if (from !== undefined) args_skeleton.from = from;
    if (to !== null) args_skeleton.to = to;
    return {
      tool: 'project_diff_versions',
      args_skeleton,
      one_line_why: 'Your base is stale. Diff base→current to see what changed remotely, then retry with the current base — pass force only if overwriting is intentional.',
    };
  }
  if (surfaceAllowsCanonicalTool(surface, 'project_export')) {
    return {
      tool: 'project_export',
      args_skeleton: { project_id },
      one_line_why: 'Your base is stale. Re-read the current source with project_export, then retry with the new base — pass force only if overwriting is intentional.',
    };
  }
  return catalogNextCall('project_diff_versions');
}

function constrainNextCallToSurface(
  nextCall: NextCallRecommendation,
  attemptedTool: string,
  attemptedArgs: Record<string, unknown>,
  payload: unknown,
  surface: ToolSurface,
): NextCallRecommendation {
  if (!surfaceAllowsCanonicalTool(surface, nextCall.tool)) {
    return catalogNextCall(nextCall.tool);
  }
  // STALE_BASE / STALE_RELEASE_BASE: a same-tool retry is the WRONG recovery
  // (tsk_735b9239). The SAFETY_ARGUMENT copy below would carry the stale
  // base_version / base_live_version / force into the skeleton, so an agent
  // replaying next_call re-deploys/patches against the same stale base — often
  // with placeholder file content. Redirect a same-tool retry to diff/re-read.
  const staleBaseCode = canonicalErrorCode(payload);
  if (nextCall.tool === attemptedTool
    && (staleBaseCode === 'STALE_BASE' || staleBaseCode === 'STALE_RELEASE_BASE')) {
    return staleBaseRecoveryNextCall(attemptedArgs, payload, surface);
  }
  const argsSkeleton = { ...nextCall.args_skeleton };
  const nextTool = TOOL_DEFINITIONS.find((tool) => tool.name === nextCall.tool);
  for (const key of SAFETY_ARGUMENT_NAMES) {
    if (attemptedArgs[key] !== undefined && nextTool?.inputSchema.properties[key] !== undefined) {
      argsSkeleton[key] = attemptedArgs[key];
    }
  }
  if (nextCall.tool === attemptedTool && canonicalErrorCode(payload) === 'VERSION_CONFLICT') {
    const currentVersion = currentVersionFromError(payload);
    if (currentVersion !== null) argsSkeleton.expected_version = currentVersion;
  }
  if (nextCall.tool === attemptedTool && canonicalErrorCode(payload) === 'BASE_RELEASE_REQUIRED') {
    const activeReleaseId = activeReleaseIdFromError(payload);
    if (activeReleaseId !== null) argsSkeleton.base_release_id = activeReleaseId;
  }
  return { ...nextCall, args_skeleton: argsSkeleton };
}

function constrainResponseGuidance(
  payload: unknown,
  attemptedTool: string,
  attemptedArgs: Record<string, unknown>,
  surface: ToolSurface,
  httpStatus: number,
): void {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
  const out = payload as Record<string, unknown>;
  // Error fields belong ONLY on an actual failure (tsk_bc73ace6). canonicalErrorCode
  // reads a top-level/nested `code` as a last resort, and a SUCCESS payload can carry
  // a `code` that means something else entirely — project_delete step 1 returns the
  // 6-digit confirmation code it just minted. Stamping error_code / canonical_error
  // there made `if (result.error_code)` true on a successful call, so every wrapper
  // that branches on it treated the two-step delete request as a failure. Gate on the
  // transport status plus the envelope's own ok:false so a 200-with-ok:false error
  // still self-reports.
  const isFailure = httpStatus >= 400 || out.ok === false;
  const code = isFailure ? canonicalErrorCode(payload) : null;
  if (code) {
    out.error_code = code;
    out.http_status = httpStatus;
    out.canonical_error = { code, http_status: httpStatus };
  }
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const record = value as Record<string, unknown>;
    // Response records are runtime data, not the curated guidance corpus.
    // Their message/hint fields can contain customer logs, database values,
    // user content, or echoed input (including ordinary paths like /api/*),
    // so they must remain byte-for-byte intact. Only the structured next_call
    // recommendation below is projected onto the active tool surface.
    if (record.next_call && typeof record.next_call === 'object' && !Array.isArray(record.next_call)) {
      const candidate = record.next_call as Partial<NextCallRecommendation>;
      if (typeof candidate.tool === 'string') {
        record.next_call = constrainNextCallToSurface({
          tool: candidate.tool,
          args_skeleton: candidate.args_skeleton && typeof candidate.args_skeleton === 'object'
            ? candidate.args_skeleton as Record<string, unknown>
            : {},
          one_line_why: typeof candidate.one_line_why === 'string'
            ? candidate.one_line_why
            : 'Use the surface-supported corrective call.',
        }, attemptedTool, attemptedArgs, payload, surface);
      }
    }
    for (const nested of Object.values(record)) visit(nested);
  };
  visit(out);
}

function deterministicUnknownToolNextCall(name: string): NextCallRecommendation | null {
  const near = nearestToolName(name);
  if (near) {
    const safeName = sanitizeAgentText(name, 80);
    return {
      tool: near,
      args_skeleton: toolSkeleton(near),
      one_line_why: `Closest real tool name to "${safeName}".`,
    };
  }
  return null;
}

function deterministicSuggestion(name: string): { text: string; source: 'deterministic'; next_call: NextCallRecommendation } | null {
  const nextCall = deterministicUnknownToolNextCall(name);
  if (!nextCall) return null;
  const safeName = sanitizeAgentText(name, 120);
  return { text: `Unknown tool "${safeName}". Use ${formatNextCall(nextCall)}.`, source: 'deterministic', next_call: nextCall };
}

/** Actionable replacement for a bare "Unknown tool: X". */
function unknownToolMessage(name: string): string {
  const nextCall = deterministicUnknownToolNextCall(name) ?? catalogNextCall(name);
  const safeName = sanitizeAgentText(name, 120);
  return deterministicSuggestion(name)?.text ?? `Unknown tool "${safeName}". Use ${formatNextCall(nextCall)}.`;
}

/** Deterministic agent-facing correction for a known error code — the right
 *  tool-call FIX (distinct from the user-facing `hint`). Free + instant; covers
 *  the highest-volume codes. A nano fallback for fuzzy cases is the follow-up.
 *  (tsk_add37e9d) */
function deterministicErrorCorrection(code: string | undefined, surface: ToolSurface = 'full'): string | null {
  switch (code) {
    case 'ROUTE_FORBIDDEN':
      return "This endpoint is developer-only, or your principal can't call it. From a deployed function use the matching sw.* method instead of the REST route; for a developer action use your smt_ developer key.";
    case 'SCOPE_VIOLATION':
      return "A scoped query used an unsupported shape. Use the structured builder (sw.db.from / count / insert / update / remove) on the scoped table — the platform scopes it to the signed-in user. Raw sw.db.query is never auto-scoped; passing { user } to it throws RAW_SQL_CANNOT_BE_PLATFORM_SCOPED, so write the ownership filter (WHERE user_id = ?) into your raw SQL yourself.";
    case 'BUNDLED_DEPLOY_REJECTED':
      return "Deploy raw source, not built output. Drop the `npm run build` / `vite build` step and deploy src/, index.html, and package.json directly — the platform compiles on deploy.";
    case 'DEPLOY_BLANK_PAGE':
      return "The deployed page rendered blank — data.bundle_error (or the message) names the root cause, usually a compile error or bad import in your source. Fix that file and redeploy the same raw source. Do NOT switch to deploying compiled/bundled output; the platform builds from raw source.";
    case 'DEPLOY_INCOMPLETE_UPLOAD':
      return "Some compiled chunks didn't finish uploading — almost always transient. Redeploy the exact same raw source files. Do NOT hand-author files under /_compiled; the platform generates those.";
    case 'JSX_COMPILE_ERROR':
      return "Fix the compile error at the file:line named in the message, then redeploy the raw source file. Don't pre-compile locally to work around it — the platform compiles on deploy.";
    case 'BUNDLE_VERIFICATION_FAILED':
      return "The build failed a final sanity check — data.issues lists each problem with the source pattern that caused it. Fix the named source files and redeploy raw source.";
    case 'PAID_API_NOT_ACTIVATED':
      return "Enable this paid API for the project owner first at the dashboard billing/AI page (see activation_url in this response), then retry.";
    case 'VERSION_CONFLICT':
      return "Another deploy landed since your last read. Re-read the current version with project_get, review the new state, then retry with expected_version set to that version. Never omit the concurrency guard when recovering from this conflict.";
    case 'STALE_BASE':
      return surfaceAllowsCanonicalTool(surface, 'project_diff_versions')
        ? "The project changed elsewhere since your base version. Call project_diff_versions({ project_id, from: base_version, to: data.current_version }) (or use base_live_version as from when this came from project_promote), review data.changed_files and the diff, then retry with force:true only if overwriting is intentional."
        : "The project changed elsewhere since your base version. Re-read the current source with project_export, review data.changed_files from this response, then retry with the new base_version. Use force:true only after verifying that overwriting is intentional.";
    case 'CONFIRMATION_REQUIRED':
      return "Two-step action: call the matching *_confirm tool with the 6-digit code returned in this response.";
    case 'PURCHASE_CONFIRMATION_REQUIRED':
      // Checkout handoff — deterministic so the nano fallback cannot invent a
      // dead direct-confirmation step (audit 2026-06-16 #12 / tsk_418fb446).
      return "This response is a checkout handoff. Show the user the price and get their explicit approval before sharing dashboard_checkout_url so they can complete secure payment. Never auto-confirm a purchase or attempt to finalize it through another MCP tool; registration begins only after checkout reports settled payment.";
    case 'UNSUPPORTED_SQL':
      return "The message already names the supported form — rewrite the statement that way (e.g. datetime() for INTERVAL, sw.db.batch for BEGIN/COMMIT, JSON text + json_each for arrays).";
    case 'INVALID_API_KEY':
      return "Your developer key was rejected. If this is a long-running `somewhere mcp` stdio session, the most common cause is an expired 24h cli_pair key — run `somewhere login` in the terminal (persists a refresh token so future sessions auto-renew) or `auth_cli_pair` again for a fresh key. If you're on the Claude.ai/ChatGPT web connector, just reconnect via /mcp. Otherwise the key may be wrong or revoked — verify it in the dashboard.";
    default:
      return null;
  }
}

function enrichScopedKeyForbidden(payload: unknown, toolName: string): void {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
  const out = payload as Record<string, unknown>;
  if (out.error !== 'FORBIDDEN') return;
  const data = out.data && typeof out.data === 'object' && !Array.isArray(out.data)
    ? out.data as Record<string, unknown>
    : null;
  const requiredScope = typeof data?.required_scope === 'string' ? data.required_scope : null;
  const keyScopes = Array.isArray(data?.key_scopes)
    ? data.key_scopes.filter((s): s is string => typeof s === 'string')
    : null;
  if (!requiredScope || !keyScopes) return;

  const action = `Mint a key with scope "${requiredScope}" or a parent scope such as "${requiredScope.split(':', 1)[0]}", then retry ${toolName}.`;
  out.scope_required = requiredScope;
  out.current_key_scopes = keyScopes;
  out._readable_error = `Scoped API key blocked ${toolName}: required scope "${requiredScope}". Current key scopes: [${keyScopes.join(', ')}].`;
  out._scope_denial = {
    tool: toolName,
    required_scope: requiredScope,
    current_key_scopes: keyScopes,
    action,
  };
  if (!('_correction' in out)) out._correction = action;
}

/** Record an incorrect tool call to /v1/mcp-miss (the doc-gap log). This is
 *  only safe on a detached/waitUntil path: payload.want_ai may spend a nano
 *  call in the worker, and miss reporting must never sit on the tool error
 *  response path. Best-effort — never throws. Only authed misses are recorded
 *  (the endpoint is apiKeyAuth, so authHeader must be present). */
async function reportMiss(
  env: Env,
  authHeader: string,
  payload: {
    miss_type: 'unknown_tool' | 'bad_args' | 'catalog_search' | 'docs_topic';
    tool_attempted: string;
    arg_keys: string[];
    project_id?: string | null;
    suggestion?: string | null;
    suggestion_source?: string | null;
    next_call?: NextCallRecommendation | null;
    want_ai?: boolean;
    candidates?: string[];
    catalog_summary?: string | null;
    raw_message?: string | null;
  },
  timeoutMs = 4500,
): Promise<{ ai_suggestion?: string | null; next_call?: NextCallRecommendation | null; suggestion_source?: string | null } | null> {
  if (!authHeader) return null;
  try {
    const call = callAPI(env.API_SERVICE, 'POST', '/v1/mcp-miss', authHeader, payload);
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), timeoutMs));
    const res = await Promise.race([call, timeout]);
    if (!res) return null;
    const envelope = (res as { status: number; data: unknown }).data as
      | { ok?: boolean; data?: { ai_suggestion?: string | null; next_call?: NextCallRecommendation | null; suggestion_source?: string | null } }
      | undefined;
    return envelope?.ok ? {
      ai_suggestion: envelope.data?.ai_suggestion ?? null,
      next_call: envelope.data?.next_call ?? null,
      suggestion_source: envelope.data?.suggestion_source ?? null,
    } : null;
  } catch {
    return null;
  }
}

function projectRefForSkeleton(args: Record<string, unknown>): string {
  return typeof args.project_id === 'string' && args.project_id ? args.project_id : '<project_id>';
}

const DETERMINISTIC_BAD_ARGS_TOOLS = new Set([
  'browser',
  'project_patch',
  'project_deploy',
  'tasks_list',
  'tasks_get',
  'db_query',
  'db_batch',
  'project_undeploy',
  'project_create',
  'email_send',
  'payments_checkout',
]);

function deterministicBadArgsNextCall(attemptedTool: string, args: Record<string, unknown>): NextCallRecommendation {
  const project_id = projectRefForSkeleton(args);
  switch (attemptedTool) {
    case 'browser':
      return {
        tool: 'browser',
        args_skeleton: args.html
          ? { html: '<html>...</html>', width: 1280, height: 800, inline: true }
          : { project_id, steps: [{ action: 'goto', path: '/' }], include: ['network', 'dom'], viewport: 'desktop' },
        one_line_why: 'browser accepts project_id or url or html; steps is an array of { action, ... } objects.',
      };
    case 'project_patch':
      return {
        tool: 'project_patch',
        args_skeleton: { project_id, path: 'index.html', find: 'exact text to replace', replace: 'new text' },
        one_line_why: 'project_patch edits one file per call with path+content or path+find+replace.',
      };
    case 'project_deploy':
      return {
        tool: 'project_deploy',
        args_skeleton: { project_id, files: { 'index.html': '<!doctype html><html></html>' }, functions: { 'api/hello.ts': 'export default async function (req, sw) { return Response.json({ ok: true }); }' } },
        one_line_why: 'project_deploy needs files/functions as maps of path to source string.',
      };
    case 'tasks_get':
    case 'tasks_list':
      return {
        tool: 'tasks_get',
        args_skeleton: { project_id, task_id: typeof args.task_id === 'string' ? args.task_id : 'tsk_...' },
        one_line_why: 'Use tasks_get for one task; use tasks_list without task_id for a queue.',
      };
    case 'db_query':
      return {
        tool: 'db_query',
        args_skeleton: { project_id, sql: 'SELECT * FROM table_name WHERE id = ?', params: ['<id>'] },
        one_line_why: 'db_query uses sql plus an optional params array.',
      };
    case 'db_batch':
      return {
        tool: 'db_batch',
        args_skeleton: { project_id, statements: [{ sql: 'INSERT INTO table_name (name) VALUES (?)', params: ['Alice'] }] },
        one_line_why: 'db_batch uses statements as an array of { sql, params? } and runs them atomically.',
      };
    case 'project_undeploy':
      return {
        tool: 'project_undeploy',
        args_skeleton: { project_id },
        one_line_why: 'project_undeploy only needs project_id.',
      };
    case 'project_create':
      return {
        tool: 'project_create',
        args_skeleton: { name: 'My App', subdomain: 'my-app', description: 'Optional short description' },
        one_line_why: 'project_create needs name; subdomain is optional and must be lowercase letters, digits, and hyphens.',
      };
    case 'email_send':
      return {
        tool: 'email_send',
        args_skeleton: { project_id, to: 'user@example.com', subject: 'Subject', text: 'Plain text body' },
        one_line_why: 'email_send sends one message immediately; omit from for the managed transactional sender.',
      };
    case 'payments_checkout':
      return {
        tool: 'payments_checkout',
        args_skeleton: { project_id, mode: 'payment', line_items: [{ amount: 1000, currency: 'usd', name: 'Pro plan', quantity: 1 }], success_url: 'https://example.com/success', cancel_url: 'https://example.com/cancel' },
        one_line_why: 'payments_checkout needs project_id, success_url, cancel_url, and a payment basis (line_items, quote_id, or plan).',
      };
    default:
      return {
        tool: attemptedTool,
        args_skeleton: toolSkeleton(attemptedTool),
        one_line_why: 'The tool exists; fix the argument shape to match its schema.',
      };
  }
}

function queueMissReport(
  env: Env,
  authHeader: string,
  ctx: ExecutionContext | undefined,
  payload: Parameters<typeof reportMiss>[2],
): void {
  const promise = reportMiss(env, authHeader, payload).then(() => {}, () => {});
  if (ctx) ctx.waitUntil(promise);
  else void promise;
}

/** Error codes that refuse a call because one specific argument was absent,
 *  mapped to the argument they demand. Every entry here is a field the server
 *  requires but an OLDER advertised schema did not declare, so a client holding
 *  a pre-deploy tool list cannot see it and may strip it from an outgoing call.
 *  Add a row when a newly-required field starts gating an existing tool. */
const REQUIRED_FIELD_BY_ERROR_CODE: Record<string, string> = {
  BASE_RELEASE_REQUIRED: 'base_release_id',
};

/**
 * Tell a mid-session agent, in the failing error itself, that its cached tool
 * list may predate this server (pfb_ab210b5e7ebd).
 *
 * The MCP transport here is stateless POST-only: `initialize` issues no session
 * id, `GET /mcp` is 405, and no client holds a stream. There is therefore no
 * channel on which to deliver `notifications/tools/list_changed`, and declaring
 * `capabilities.tools.listChanged` would promise a notification that can never
 * arrive. The error is the only place left to say it, so it has to say it well:
 * name the field, name the refresh, and state that the field is accepted even
 * when the caller's cached schema omits it — otherwise an agent whose schema
 * has no such property cannot tell whether sending it is legal.
 *
 * Two independent signals, either of which is worth reporting:
 *   - a required field the current schema declares and the caller omitted;
 *   - an argument the caller sent that the current schema does not declare,
 *     which is positive evidence the two schemas differ.
 */
function staleToolListAdvice(
  toolName: string,
  args: Record<string, unknown>,
  errorCode: string | null,
): { missing_field?: string; unknown_fields?: string[]; message: string; refresh: string } | null {
  const tool = TOOL_DEFINITIONS.find((candidate) => candidate.name === toolName);
  if (!tool) return null;
  const properties = tool.inputSchema.properties ?? {};
  const requiredField = errorCode ? REQUIRED_FIELD_BY_ERROR_CODE[errorCode] : undefined;
  const missingField = requiredField
    && properties[requiredField] !== undefined
    && args[requiredField] === undefined
    ? requiredField
    : undefined;
  const unknownFields = Object.keys(args).filter((key) => properties[key] === undefined);
  if (!missingField && unknownFields.length === 0) return null;

  const refresh = `Re-list tools (tools/list), or call catalog({ load: 'project' }), to refresh your copy of the ${toolName} schema.`;
  const parts: string[] = [];
  if (missingField) {
    parts.push(
      `\`${missingField}\` is required by the current ${toolName} schema. If your tool list was fetched before this server's last deploy, your copy of the schema does not declare it — send it anyway; the field is accepted whether or not your cached schema shows it.`,
    );
  }
  if (unknownFields.length > 0) {
    parts.push(
      `The current ${toolName} schema does not declare ${unknownFields.map((field) => `\`${field}\``).join(', ')}; ${unknownFields.length === 1 ? 'it was' : 'they were'} ignored. That usually means your tool list is stale or the field was renamed.`,
    );
  }
  parts.push(refresh);
  return {
    ...(missingField ? { missing_field: missingField } : {}),
    ...(unknownFields.length > 0 ? { unknown_fields: unknownFields } : {}),
    message: parts.join(' '),
    refresh,
  };
}

function badArgsToolResult(
  env: Env,
  authHeader: string,
  ctx: ExecutionContext | undefined,
  toolName: string,
  args: Record<string, unknown>,
  message: string,
  nextCall = deterministicBadArgsNextCall(toolName, args),
): { content: McpContentBlock[]; isError: true } {
  queueMissReport(env, authHeader, ctx, {
    miss_type: 'bad_args',
    tool_attempted: toolName,
    arg_keys: Object.keys(args),
    suggestion: formatNextCall(nextCall),
    suggestion_source: 'deterministic',
    next_call: nextCall,
    raw_message: message,
    want_ai: false,
  });
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        ok: false,
        error: 'VALIDATION_ERROR',
        message,
        next_call: nextCall,
        next_call_source: 'deterministic',
        _correction: nextCall.one_line_why,
      }, null, 2),
    }],
    isError: true,
  };
}

/** Per-tool invocation counter (tsk_5cc21f58) — the success-side companion
 *  to reportMiss. Counts buffer in this isolate's memory and flush to
 *  POST /v1/mcp-usage in batches (time- or size-triggered) via
 *  ctx.waitUntil, so the hot path never waits on a write and the database
 *  sees one aggregated UPSERT batch instead of a row per call. Counts carry
 *  only aggregate day/tool plus a coarse project ref for internal/test
 *  segmentation. Best-effort by design: an evicted isolate
 *  loses at most one unflushed window; a failed flush logs loudly and
 *  drops its batch rather than retrying into a stampede. */
const TOOL_USAGE_FLUSH_MS = 30_000;
const TOOL_USAGE_MAX_BUFFERED = 200;
const toolUsageBuffer = new Map<string, number>(); // `${day}|${tool}` → count
let toolUsageBuffered = 0;
let toolUsageLastFlush = 0;

function projectRefFromToolArgs(args: Record<string, unknown>): string | null {
  for (const key of ['project_id', 'project', 'identifier', 'subdomain', 'slug']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 200);
  }
  return null;
}

function projectIdFromToolArgs(args: Record<string, unknown>): string | null {
  const value = args.project_id;
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : null;
}

function normalizeDocsTopic(topic: string): string {
  const normalized = topic.trim().toLowerCase();
  return (normalized || '(index)').slice(0, 120);
}

function normalizeClientInfoValue(value: unknown, fallback: string, lowercase: boolean, maxChars: number): string | null {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  const normalized = trimmed
    .slice(0, maxChars)
    .replace(/[^a-z0-9._+-]+/gi, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, '');
  if (!normalized) return fallback;
  return lowercase ? normalized.toLowerCase() : normalized;
}

function mcpTelemetryHeaders(env: Env, client: string): Record<string, string> {
  return {
    'X-Somewhere-Client': client,
    ...(env.SOMEWHERE_TECH_ADMIN_KEY ? { 'X-Admin-Key': env.SOMEWHERE_TECH_ADMIN_KEY } : {}),
  };
}

/** Record the privacy-limited initialize signal exactly once per accepted
 *  MCP connection. The caller owns the idempotency id and retries the awaited
 *  service-binding write with that same id, so an ambiguous response cannot
 *  duplicate the durable event. */
async function recordClientSession(
  env: Env,
  authHeader: string,
  clientInfo: { name?: unknown; version?: unknown } | undefined,
  surface: ToolSurface,
): Promise<void> {
  if (!authHeader) return;
  if (!env.SOMEWHERE_TECH_ADMIN_KEY) {
    throw new Error('MCP telemetry service credential is not configured.');
  }
  const clientName = normalizeClientInfoValue(clientInfo?.name, 'unknown', true, 64) ?? 'unknown';
  const clientVersion = normalizeClientInfoValue(clientInfo?.version, 'unknown', false, 80) ?? 'unknown';
  const connectionEventId = crypto.randomUUID();
  await deliverClientSession(
    () => callAPI(
      env.API_SERVICE,
      'POST',
      '/v1/mcp-usage/client-session',
      authHeader,
      { connection_event_id: connectionEventId, client_name: clientName, client_version: clientVersion, surface },
      mcpTelemetryHeaders(env, `${clientName}/${clientVersion}`),
    ),
  );
}

function recordToolUsage(env: Env, ctx: ExecutionContext, authHeader: string, toolName: string, args: Record<string, unknown>): void {
  if (!authHeader) return; // the flush endpoint is authed; unauthed public-tool calls aren't counted
  const now = Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  const projectRef = projectRefFromToolArgs(args) ?? '';
  const key = `${day}|${toolName}|${projectRef}`;
  toolUsageBuffer.set(key, (toolUsageBuffer.get(key) ?? 0) + 1);
  toolUsageBuffered += 1;
  if (now - toolUsageLastFlush < TOOL_USAGE_FLUSH_MS && toolUsageBuffered < TOOL_USAGE_MAX_BUFFERED) return;

  const entries = Array.from(toolUsageBuffer.entries(), ([k, count]) => {
    const parts = k.split('|');
    const entryDay = parts[0] ?? '';
    const tool = parts[1] ?? '';
    const ref = parts.slice(2).join('|');
    return { day: entryDay, tool, count, ...(ref ? { project_ref: ref } : {}) };
  });
  toolUsageBuffer.clear();
  toolUsageBuffered = 0;
  toolUsageLastFlush = now;
  ctx.waitUntil(
    callAPI(env.API_SERVICE, 'POST', '/v1/mcp-usage', authHeader, { entries }, mcpTelemetryHeaders(env, 'mcp-tool-usage')).then(
      (res) => {
        if (res.status !== 200) {
          console.error(`[tool-usage] flush rejected status=${res.status} — ${entries.length} aggregate rows dropped`);
        }
      },
      (err) => console.error('[tool-usage] flush failed:', err instanceof Error ? err.message : err),
    ),
  );
}

async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  env: Env,
  authHeader: string,
  authBoundary: CallerAuthBoundary,
  ctx?: ExecutionContext,
  emitMode: 'standard' | 'chatgpt' = 'standard',
  caller: CallerKind = 'unknown',
  surface: ToolSurface = 'full',
  traceContext?: ModernTraceContext,
  helpSessionId: string | null = null,
): Promise<ToolExecutionResult> {
  const guardedEnv = authBoundary.wrapEnv(env);
  guardedEnv.API_SERVICE = traceContextFetcher(guardedEnv.API_SERVICE, traceContext);
  if (guardedEnv.RUNNER_SERVICE) {
    guardedEnv.RUNNER_SERVICE = traceContextFetcher(guardedEnv.RUNNER_SERVICE, traceContext);
  }
  const fetcher = guardedEnv.API_SERVICE;
  try {
    args = normalizeToolArgAliases(toolName, args);
    // Resolve project_id BEFORE the switch dispatch so every tool
    // case gets the canonical UUID without per-case wiring. Tools
    // that don't take a project_id are unaffected. Tools that take
    // an OPTIONAL project_id (job_list, cron_list, usage_summary)
    // skip resolution when the field is omitted.
    //
    // Exception — the tasks tools' spine sentinel: `project_id` of
    // `'default'` / `'spine'` for a tasks_* tool means "the org spine",
    // which the worker resolves
    // server-side from SPINE_PROJECT_ID. We must NOT pre-resolve it here:
    // this MCP resolver only knows the CALLER's own projects, so it would
    // error on an account with 0 or >1 projects ("No projects found" /
    // "Multiple projects") and could never reach the platform-owned spine.
    // Pass the sentinel through untouched; the worker maps it and still
    // runs assertProjectAccess on the resolved id, so auth is unchanged.
    const spineSentinel = (args.project_id === 'default' || args.project_id === 'spine')
      && (toolName === 'tasks_get' || toolName === 'tasks_list' || toolName === 'tasks_create' || toolName === 'tasks_update'
        || toolName === 'tasks_summary' || toolName === 'tasks_delete' || toolName === 'tasks_bulk_update'
        || toolName === 'tasks_reconcile'
        || toolName === 'tasks_settings_get' || toolName === 'tasks_settings_update'
        || toolName === 'tasks_comment_edit' || toolName === 'tasks_comment_delete');
    if (!spineSentinel && typeof args.project_id === 'string' && args.project_id.length > 0) {
      try {
        args.project_id = await resolveProjectId(args.project_id, fetcher, authHeader);
      } catch (err) {
        return {
          content: [{ type: 'text', text: err instanceof Error ? err.message : 'Project resolution failed' }],
          isError: true,
        };
      }
    }
    const spec = TOOL_SPEC_BY_NAME.get(toolName);
    if (!spec) {
      return { content: [{ type: 'text', text: unknownToolMessage(toolName) }], isError: true };
    }
    const outcome = await spec.execute({
      callApi: (method, path, body) => callAPI(fetcher, method, path, authHeader, body),
      fetcher,
      env: guardedEnv,
      authHeader,
      ctx,
      emitMode,
      caller,
      surface,
      helpSessionId,
      toolName,
    }, args);
    if ('content' in outcome) return outcome;
    const result = outcome;

    const isError = result.status >= 400;
    // Piggyback unread platform notifications (tsk_6d0f) — trial
    // expiry, smoke fails, feedback responses, etc. Reads from
    // /v1/notifications/inbox-pull which de-dupes via read_at, so
    // each non-critical alert surfaces exactly once across the
    // user's tool calls. Critical stays until dismissed.
    let enriched = await maybePiggybackNotifications(fetcher, authHeader, result.data, isError);
    const claimPrompt = !isError
      ? await maybeAttachAnonymousClaimPrompt(fetcher, authHeader, toolName)
      : null;
    if (claimPrompt && enriched && typeof enriched === 'object' && !Array.isArray(enriched)) {
      enriched = { ...(enriched as Record<string, unknown>), _claim_account: claimPrompt };
    }
    if (isError) {
      enrichScopedKeyForbidden(enriched, toolName);
    }
    // Agent-facing correction (tsk_add37e9d): on a known error code attach
    // `_correction` — the right tool-call fix — without overwriting `hint`.
    if (isError && enriched && typeof enriched === 'object' && !('_correction' in enriched)) {
      const correction = deterministicErrorCorrection(canonicalErrorCode(enriched) ?? undefined, surface);
      if (correction) {
        (enriched as Record<string, unknown>)._correction = correction;
      }
    }
    if (isError && enriched && typeof enriched === 'object' && [400, 409, 422].includes(result.status)
      && canonicalErrorCode(enriched) !== 'SCOPE_ACTIVATION_STALE'
      // A terminal draft session must NOT get a same-tool retry skeleton that
      // preserves the dead draft_id (tsk_74dbe16f): the response message
      // already teaches the only valid recovery — a FRESH draft_id with a
      // complete snapshot — and any machine next_call reusing the old
      // identity contradicts it.
      && canonicalErrorCode(enriched) !== 'DRAFT_SESSION_TERMINAL') {
      const out = enriched as Record<string, unknown>;
      const missProjectId = projectIdFromToolArgs(args);
      const errorCode = canonicalErrorCode(enriched);
      const confirmationCode = confirmationCodeFromError(enriched);
      const deterministicNextCall = errorCode === 'CONFIRMATION_REQUIRED'
        && toolName === 'project_delete'
        && confirmationCode
        ? {
            tool: 'project_delete_confirm',
            args_skeleton: {
              project_id: projectRefForSkeleton(args),
              code: confirmationCode,
            },
            one_line_why: 'Confirm the requested project deletion with the returned 6-digit code.',
          }
        : deterministicBadArgsNextCall(toolName, args);
      const nextCall = constrainNextCallToSurface(
        deterministicNextCall,
        toolName,
        args,
        enriched,
        surface,
      );
      const nextCallSource: 'deterministic' = 'deterministic';
      let missReported = false;
      if (!DETERMINISTIC_BAD_ARGS_TOOLS.has(toolName)) {
        queueMissReport(env, authHeader, ctx, {
          miss_type: 'bad_args',
          tool_attempted: toolName,
          arg_keys: Object.keys(args),
          ...(missProjectId ? { project_id: missProjectId } : {}),
          suggestion: null,
          suggestion_source: null,
          next_call: null,
          want_ai: true,
          candidates: [...advertisedNamesForSurface(surface)],
          catalog_summary: buildCatalogSummaryForMiss(surface),
          raw_message: typeof out.message === 'string' ? out.message : null,
        });
        missReported = true;
      }
      if (!('next_call' in out)) out.next_call = nextCall;
      if (!('next_call_source' in out)) out.next_call_source = nextCallSource;
      if (!('_correction' in out)) out._correction = nextCall.one_line_why;
      // A stateless transport cannot push notifications/tools/list_changed, so
      // a stale client tool list has to be diagnosed in the error it causes.
      if (!('_tool_list_may_be_stale' in out)) {
        const staleAdvice = staleToolListAdvice(toolName, args, errorCode);
        if (staleAdvice) out._tool_list_may_be_stale = staleAdvice;
      }
      if (!missReported) {
        queueMissReport(env, authHeader, ctx, {
          miss_type: 'bad_args',
          tool_attempted: toolName,
          arg_keys: Object.keys(args),
          ...(missProjectId ? { project_id: missProjectId } : {}),
          suggestion: formatNextCall(nextCall),
          suggestion_source: 'deterministic',
          next_call: nextCall,
          want_ai: false,
          raw_message: typeof out.message === 'string' ? out.message : null,
        });
      }
    }
    constrainResponseGuidance(enriched, toolName, args, surface, result.status);
    // Control-your-app link (tsk_0db88d0d) — a user who launches an app via
    // the connector otherwise gets NO path to log in and manage it. On a
    // successful project_create / project_deploy, surface a plain dashboard
    // URL they open and sign into WITH THEIR OWN ACCOUNT. SECURE BY DESIGN:
    // no auto-login token, no magic link — just the dashboard route, gated by
    // the user's normal session. The project-specific route is included when
    // an identifier is resolvable from the response or the call args.
    let controlLinkSuffix = claimPrompt
      ? `\n\n💾 Account recovery is available: connector_link_email requires an email supplied by the user and sends a verification link. The work stays in this guest session until the human verifies that email.`
      : '';
    if (!isError && (toolName === 'project_create' || toolName === 'project_deploy')) {
      const DASH = 'https://somewhere.tech/dashboard';
      // Resolve a project identifier without trusting any single field name:
      // prefer the response, fall back to the caller's args, finally the
      // deploy URL's subdomain. Never a token — only a public route segment.
      const d = (enriched && typeof enriched === 'object' ? enriched : {}) as Record<string, unknown>;
      const fromUrl = typeof d.url === 'string'
        ? (d.url.match(/^https?:\/\/([^.]+)\.somewhere\.(?:tech|site)/)?.[1])
        : undefined;
      const ident =
        (typeof d.id === 'string' && d.id) ||
        (typeof d.project_id === 'string' && d.project_id) ||
        (typeof d.subdomain === 'string' && d.subdomain) ||
        (typeof args?.project_id === 'string' && (args.project_id as string)) ||
        (typeof args?.subdomain === 'string' && (args.subdomain as string)) ||
        fromUrl ||
        '';
      const appLink = ident
        ? `${DASH}/projects/${encodeURIComponent(ident)}`
        : DASH;
      // Attach to the structured payload (shows in the standard JSON output)…
      if (enriched && typeof enriched === 'object' && !('_control_app_link' in d)) {
        d._control_app_link = appLink;
      }
      // …and as a prominent trailing line in the ChatGPT-facing text. The
      // standard MCP text block stays one JSON value for strict clients.
      controlLinkSuffix += `\n\n🔧 Control your app: ${appLink}\n(Log in with your account to manage, edit, and view your app.)`;
    }
    // Inline-image fast path (tsk_937972) — ai_generate_image /
    // ai_remove_background with inline:true stash the image bytes
    // on result._inlineImage. Emit an MCP image content block so
    // Claude.ai and any other client that supports image blocks
    // renders the image directly in the conversation.
    const inlineImage = (result as { _inlineImage?: { mimeType: string; data: string } })._inlineImage;
    // ChatGPT mode (mounted at /mcp/chatgpt) emits a clean
    // structuredContent payload alongside a SHORT text bubble. The
    // ChatGPT picker handles structured tool output natively;
    // dumping JSON-as-text confuses the assistant and clutters the
    // conversation. Standard mode (Claude Code / power users / the
    // /mcp endpoint) keeps the legacy JSON-as-text format for
    // back-compat — those clients render it inline as a code block.
    if (emitMode === 'chatgpt') {
      const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
        { type: 'text', text: summarizeForChatgpt(
          enriched,
          isError,
          projectSiteDomain(env.NEW_PROJECT_SITE_DOMAIN),
        ) + controlLinkSuffix },
      ];
      if (inlineImage && !isError) {
        content.push({ type: 'image', data: inlineImage.data, mimeType: inlineImage.mimeType });
      }
      return { content, structuredContent: enriched, isError };
    }
    const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
      { type: 'text', text: JSON.stringify(enriched, null, 2) },
    ];
    if (inlineImage && !isError) {
      content.push({ type: 'image', data: inlineImage.data, mimeType: inlineImage.mimeType });
    }
    const structuredContent = !isError && TOOL_SPEC_BY_NAME.get(toolName)?.definition.outputSchema
      ? enriched && typeof enriched === 'object' && !Array.isArray(enriched)
        ? enriched
        : { value: enriched }
      : undefined;
    return {
      content,
      ...(structuredContent !== undefined ? { structuredContent } : {}),
      isError,
    };
  } catch (err) {
    // Bubble caller-bearer rejection up to the /mcp HTTP layer so it can
    // respond with 401 + WWW-Authenticate (triggers OAuth or CLI refresh).
    if (isCallerAuthRejection(err)) throw err;
    const msg = err instanceof Error ? err.message : 'Unknown error';
    if (msg.startsWith('Invalid JSON in ')) {
      return badArgsToolResult(env, authHeader, ctx, toolName, args, msg);
    }
    return { content: [{ type: 'text', text: `Error calling API: ${msg}` }], isError: true };
  }
}

// Pull unread platform_notifications and append to the tool response
// under `_notifications`. Best-effort — a fetch error returns the
// original payload unchanged so a notification-system blip never
// breaks the tool call itself.
async function maybePiggybackNotifications(
  fetcher: Fetcher,
  authHeader: string,
  data: unknown,
  isError: boolean,
): Promise<unknown> {
  // Never enrich a non-object response (e.g. tool returned a raw
  // string). Caller wouldn't know where to splice _notifications in.
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  // Errors get a chance too — the user might be wondering "why is
  // this 403" and the answer might be "your trial ended".
  void isError;
  try {
    const res = await callAPI(fetcher, 'GET', '/v1/notifications/inbox-pull', authHeader);
    const env = res.data as { notifications?: unknown[] } | undefined;
    const list = Array.isArray(env?.notifications) ? env.notifications : [];
    if (list.length === 0) return data;
    return { ...(data as Record<string, unknown>), _notifications: list };
  } catch {
    return data;
  }
}

async function maybeAttachAnonymousClaimPrompt(
  fetcher: Fetcher,
  authHeader: string,
  toolName: string,
) {
  if (!isAnonymousClaimPromptCandidate(toolName)) return null;
  try {
    const res = await callAPI(fetcher, 'GET', '/v1/auth/platform-me', authHeader);
    if (res.status >= 400) return null;
    return anonymousClaimPrompt(toolName, res.data);
  } catch {
    // Claim prompting is additive UX. The work response must still succeed if
    // account-state lookup is temporarily unavailable.
    return null;
  }
}

// --- Public brand assets (logo / favicon) ---
// Square (1:1) variant of dashboard/src/assets/logo.svg. The source mark
// is viewBox "0 0 755 804" (not square); this pads the canvas to 804x804
// and centers the glyph horizontally (translate 24.5). The mark itself is
// byte-for-byte identical — no redraw, no distortion. Served at /logo.svg
// for the Anthropic MCP-directory listing (needs a square logo URL).
const LOGO_SQUARE_SVG = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.0//EN" "http://www.w3.org/TR/2001/REC-SVG-20010904/DTD/svg10.dtd">
<!-- Square (1:1) variant of dashboard/src/assets/logo.svg.
     The source mark is viewBox "0 0 755 804" (not square). This file pads
     the canvas to 804x804 and centers the glyph horizontally with a
     translate of (804-755)/2 = 24.5 — the mark itself is byte-for-byte
     identical (no redraw, no distortion). Used as the public brand asset
     served at https://mcp.somewhere.tech/logo.svg for the Anthropic
     MCP-directory listing (needs a square logo URL). -->
<svg version="1.0" xmlns="http://www.w3.org/2000/svg" width="804px" height="804px" viewBox="0 0 804 804" preserveAspectRatio="xMidYMid meet">
 <g transform="translate(24.5,0)">
  <g fill="#16afad">
   <path d="M124.44 643.42 c-4.19 -1.45 -8.30 -5.02 -10.88 -9.29 l-2.05 -3.58 -0.23 -59.97 c-0.15 -59.75 -0.15 -59.90 1.45 -63.70 0.91 -2.05 3.12 -5.10 4.87 -6.77 6.01 -5.56 3.88 -5.40 71.24 -5.40 58.53 0 60.13 0.08 64.16 1.52 5.40 2.05 9.89 6.85 11.49 12.41 1.07 3.65 1.14 11.19 0.99 63.02 -0.23 55.71 -0.30 59.06 -1.67 61.57 -2.28 4.41 -6.62 8.30 -10.88 9.89 -3.96 1.45 -5.94 1.52 -64.77 1.45 -50.61 0 -61.19 -0.23 -63.70 -1.14z"/>
   <path d="M315.62 643.58 c-6.16 -2.28 -10.50 -6.55 -12.56 -12.56 -0.68 -1.90 -0.91 -18.65 -0.91 -62.10 l0 -59.44 1.98 -3.96 c1.07 -2.21 3.20 -4.95 4.72 -6.24 5.78 -4.72 3.65 -4.64 71.39 -4.41 61.42 0.23 61.57 0.23 64.62 1.90 4.03 2.13 6.77 5.18 8.90 9.74 l1.75 3.81 0.23 57.46 c0.15 39.58 -0.08 58.68 -0.68 61.42 -0.99 5.02 -4.49 9.74 -9.44 12.79 l-3.65 2.28 -61.72 0.15 c-50.46 0.15 -62.26 0 -64.62 -0.84z"/>
   <path d="M314.94 457.87 c-1.60 -0.61 -3.73 -1.60 -4.79 -2.28 -2.66 -1.75 -6.32 -7 -7.23 -10.43 -0.53 -1.90 -0.76 -23.82 -0.61 -62.87 l0.23 -59.97 1.90 -3.42 c2.21 -3.96 7.23 -7.99 11.26 -9.13 1.83 -0.46 24.20 -0.76 64.01 -0.76 60.20 0 61.27 0 64.46 1.52 1.75 0.91 4.64 3.12 6.32 4.95 5.63 6.09 5.48 4.03 5.25 70.48 l-0.23 58.98 -1.98 3.73 c-2.13 4.26 -6.93 8.30 -11.19 9.51 -4.57 1.22 -123.83 0.99 -127.41 -0.30z"/>
   <path d="M314.94 272.17 c-4.03 -1.45 -6.24 -3.04 -8.68 -6.16 -4.19 -5.48 -4.03 -3.73 -4.11 -67.51 0 -52.29 0.15 -59.59 1.22 -62.79 1.67 -5.10 4.03 -7.92 8.75 -10.50 l4.11 -2.28 61.88 -0.23 c61.65 -0.15 61.80 -0.15 65.61 1.45 2.05 0.91 5.10 3.12 6.77 4.87 5.63 6.09 5.48 4.03 5.25 70.86 l-0.23 59.29 -2.21 4.03 c-2.36 4.19 -5.63 7.15 -9.97 8.98 -3.73 1.52 -124.06 1.52 -128.40 0z"/>
   <path d="M504.83 272.01 c-3.81 -1.37 -8.52 -5.71 -10.50 -9.82 -1.45 -2.97 -1.52 -5.18 -1.75 -62.33 -0.23 -68.04 -0.46 -65.15 5.86 -71.31 6.55 -6.32 2.97 -6.01 71.62 -6.01 66.60 0 64.46 -0.15 70.17 4.57 1.52 1.29 3.73 4.26 4.95 6.70 l2.13 4.34 0 60.13 c0 66.52 0.30 62.41 -4.95 68.42 -1.37 1.52 -3.96 3.58 -5.63 4.49 l-3.12 1.67 -62.79 0.15 c-54.11 0.08 -63.25 0 -65.99 -0.99z"/>
  </g>
  <g fill="#0a4444">
   <path d="M126.87 648.37 c-7.76 -1.83 -14.31 -7 -17.81 -14.31 l-2.13 -4.26 0 -60.51 0 -60.51 2.05 -3.81 c2.74 -5.18 7.69 -9.74 13.17 -12.33 l4.57 -2.13 60.05 -0.23 c58.76 -0.23 60.20 -0.15 65.23 1.37 6.47 1.98 12.56 7.23 15.68 13.55 l2.13 4.34 0.23 58.60 c0.23 65 0.38 62.33 -4.79 70.02 -1.45 2.13 -4.26 4.87 -6.24 6.24 -7.23 4.87 -6.62 4.79 -71.01 4.72 -32.04 -0.08 -59.52 -0.38 -61.12 -0.76z m123.75 -7.53 c4.26 -1.60 8.60 -5.48 10.88 -9.89 1.37 -2.51 1.45 -5.78 1.67 -59.29 0.15 -49.78 0.08 -57.08 -0.99 -60.73 -1.60 -5.56 -6.09 -10.35 -11.49 -12.41 -4.03 -1.45 -5.71 -1.52 -61.88 -1.52 -64.77 0 -62.94 -0.15 -68.95 5.40 -1.75 1.67 -3.96 4.72 -4.87 6.77 -1.60 3.81 -1.60 4.03 -1.45 61.42 l0.23 57.69 2.05 3.58 c1.22 1.90 3.42 4.57 4.95 5.86 5.63 4.64 3.50 4.49 67.36 4.57 56.55 0.08 58.53 0 62.49 -1.45z"/>
   <path d="M316.46 648.07 c-7.92 -2.13 -13.70 -7.15 -17.28 -14.84 l-1.98 -4.19 0 -59.36 0 -59.36 2.21 -4.72 c2.59 -5.63 7.15 -10.20 12.86 -12.86 l3.96 -1.83 62.79 0 c60.28 0 62.94 0.08 65.99 1.52 4.72 2.05 10.58 7.92 12.94 12.86 l2.13 4.26 0 60.13 0 60.13 -2.21 4.49 c-2.74 5.56 -7.15 9.97 -12.63 12.56 l-4.19 1.98 -60.51 0.15 c-48.02 0.08 -61.27 -0.08 -64.08 -0.91z m126.87 -8.37 c4.95 -3.04 8.45 -7.76 9.51 -12.79 0.53 -2.74 0.76 -21.16 0.61 -59.14 l-0.23 -55.18 -1.75 -3.81 c-2.13 -4.57 -4.87 -7.61 -8.90 -9.74 -3.04 -1.67 -3.27 -1.67 -62.33 -1.90 -65.23 -0.23 -63.32 -0.30 -69.11 4.41 -1.52 1.29 -3.65 4.03 -4.72 6.24 l-1.98 3.96 0 57.16 c0 41.71 0.23 57.92 0.91 59.82 1.29 3.88 4.11 7.69 7.08 9.74 5.86 3.96 4.03 3.88 67.81 3.65 l59.44 -0.15 3.65 -2.28z"/>
   <path d="M125.50 462.06 c-8.07 -2.59 -12.86 -7.08 -16.82 -15.68 l-1.75 -3.81 0 -58.98 0 -58.98 2.51 -5.18 c2.97 -6.01 8.30 -10.73 14.84 -13.17 3.81 -1.37 6.39 -1.45 64.84 -1.45 l60.89 0 4.26 1.98 c6.01 2.82 10.12 6.85 13.01 12.71 l2.51 5.10 0 59.36 0 59.36 -2.05 4.34 c-2.59 5.56 -7.84 10.81 -13.40 13.40 l-4.34 2.05 -60.13 0.15 c-56.09 0.15 -60.43 0.08 -64.39 -1.22z"/>
   <path d="M314.41 461.90 c-6.39 -2.05 -12.63 -8.07 -15.37 -14.77 l-1.83 -4.57 0 -58.98 0 -58.98 2.21 -4.72 c2.51 -5.56 7.84 -10.88 13.17 -13.40 l3.65 -1.67 62.41 0 62.41 0 4.26 1.98 c5.48 2.59 10.20 7.31 12.79 12.79 l1.98 4.26 0.23 59.44 c0.15 58.83 0.15 59.59 -1.37 63.78 -2.13 5.63 -7.92 11.87 -13.09 14.23 l-4.03 1.83 -61.27 0.15 c-59.82 0.15 -61.42 0.15 -66.14 -1.37z m125.66 -6.01 c4.26 -1.22 9.06 -5.25 11.19 -9.51 l1.98 -3.73 0.23 -56.70 c0.23 -63.93 0.38 -62.10 -5.25 -68.19 -1.67 -1.83 -4.57 -4.03 -6.32 -4.95 -3.20 -1.52 -4.26 -1.52 -62.18 -1.52 -38.21 0 -59.90 0.30 -61.72 0.76 -4.03 1.14 -9.06 5.18 -11.26 9.13 l-1.90 3.42 -0.23 57.69 c-0.15 37.52 0.08 58.68 0.61 60.58 0.91 3.42 4.57 8.68 7.23 10.43 5.02 3.27 4.79 3.27 66.21 3.35 38.13 0 59.59 -0.30 61.42 -0.76z"/>
   <path d="M506.89 462.06 c-7.84 -2.51 -13.40 -7.46 -16.97 -15.07 l-1.67 -3.65 0 -59.36 0 -59.36 2.51 -5.10 c3.81 -7.84 10.35 -12.71 19.33 -14.31 2.66 -0.53 25.12 -0.76 62.71 -0.61 l58.53 0.23 4.26 1.98 c6.01 2.82 10.12 6.85 13.01 12.71 l2.51 5.10 0 59.36 0 59.36 -1.98 4.26 c-2.74 5.78 -6.55 9.82 -12.25 12.94 l-4.79 2.59 -60.51 0.15 c-56.17 0.15 -60.81 0.08 -64.69 -1.22z"/>
   <path d="M314.18 276.20 c-8.30 -2.97 -14.77 -10.81 -16.59 -20.09 -0.61 -3.27 -0.76 -20.70 -0.61 -60.89 l0.23 -56.32 1.75 -4.26 c2.59 -6.39 6.62 -10.58 13.24 -13.70 l5.56 -2.59 61.65 0 61.65 0 4.26 1.98 c5.48 2.59 10.20 7.31 12.79 12.79 l1.98 4.26 0 60.89 c0 60.81 0 60.89 -1.67 64.46 -2.28 5.02 -7 9.82 -12.18 12.48 l-4.41 2.21 -61.65 0.15 c-59.97 0.15 -61.80 0.08 -65.99 -1.37z m126.87 -6.32 c4.34 -1.83 7.61 -4.79 9.97 -8.98 l2.21 -4.03 0.23 -57.01 c0.23 -64.24 0.38 -62.49 -5.25 -68.57 -1.67 -1.75 -4.72 -3.96 -6.77 -4.87 -3.81 -1.60 -3.96 -1.60 -63.32 -1.45 l-59.59 0.23 -4.11 2.28 c-4.72 2.59 -7.08 5.40 -8.75 10.50 -1.07 3.20 -1.22 10.27 -1.22 60.51 0.08 61.34 0 59.75 4.11 65.23 2.44 3.12 4.64 4.72 8.68 6.16 4.34 1.52 120.10 1.52 123.83 0z"/>
   <path d="M505.36 276.50 c-7.08 -2.44 -11.80 -6.70 -14.99 -13.55 l-2.13 -4.57 0 -60.51 c0 -60.43 0 -60.51 1.67 -64.08 2.21 -4.79 7.38 -10.20 11.80 -12.48 2.13 -1.07 6.24 -2.21 9.59 -2.66 3.65 -0.46 27.32 -0.68 63.32 -0.53 l57.46 0.23 4.26 1.98 c6.01 2.82 10.12 6.85 13.01 12.71 l2.51 5.10 0 60.13 0 60.13 -2.05 4.34 c-2.51 5.40 -7.23 10.12 -12.71 12.71 l-4.26 1.98 -62.03 0.15 c-54.95 0.15 -62.41 0 -65.45 -1.07z m129.08 -7.61 c1.67 -0.91 4.26 -2.97 5.63 -4.49 5.25 -6.01 4.95 -2.13 4.95 -66.14 l0 -57.84 -2.13 -4.34 c-1.22 -2.44 -3.42 -5.40 -4.95 -6.70 -5.71 -4.72 -3.81 -4.57 -67.89 -4.57 -66.06 0 -62.79 -0.30 -69.34 6.01 -6.32 6.09 -6.09 3.58 -5.86 69.03 0.23 54.87 0.30 57.08 1.75 60.05 0.76 1.60 2.82 4.26 4.41 5.78 5.48 5.40 2.51 5.18 69.79 5.02 l60.51 -0.15 3.12 -1.67z"/>
  </g>
 </g>
</svg>`;

// 128x128 PNG raster of LOGO_SQUARE_SVG (transparent background), base64.
// Served at /favicon.ico and /favicon.png so www.google.com/s2/favicons
// (the directory's logo fetcher) resolves. ~2.6KB — kept intentionally
// small (a 128px icon, not the full 178KB logo.png).
const LOGO_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAACXBIWXMAADsOAAA7DgHMtqGDAAAKHUlEQVR42u2deWxc1RXGx12IPatn7LitutF9b1FTJIRajTxvGTtO6iV1jJeQFkJaUyCuCSTB8Ro7q2MgBMdpK5oECqQk9I+qaqtSpZVKF0GhUKm0LEIFB8cOjmN7Fu/Tc4YkhPfevBmLuZ5n+fuko0jxm3fnvfubu5x7zr02GwRBEARBEARBEARBEARBEARBEARBEARBEARBkOVl9/s/uEySPpkusymKI9Wys1X1o4nuY1fVFSmZolwVvz4Y/BBqcx5y+v35jmDwcXqBU/QiIwmtqChkLykZNraVw5rrp3IUZTQ7ELjOpOgsum4rVdigXZZjFz4XvmBv34vvnby8tz6nKBN0r7kcVT3uKSnxonaTiX6lDlV93b3xpkjBow/HCn55Mm3m271zzh5UJ7Mlqcqo6JxgsNtRWhrO6z0YKzj5WNrKzT92NOa68YYogfW0ze9/HyrZRDmy3OH4zprRgsdPpLXyL5p3754YtQQj2u7Aqaqfp1/qTP6xI0LKXf7Y8Zi9rGycnm8Tatms35ekv7pvbxwRUQlxO/5IjJvkKyTpsxrwvm0vL31TWLlkua0tE/R8J1HLZgDI8t9zW5qjIiuC+uVpLQDcLTir1p4RCkB7GwBIoQV4ytvZMS0YgCkdADQ4dF5XNQgAMg/A096uTtEATOgAkOVqR031EADI/CDwH97OHTMiK4JG+1EtAA5ZrnHWVKMFsAAAz/i6OmeFtgA0T9cBIEm1ztoaAJBxACTpWd/OLtEAhHUAKEqds64Wg0ALAPBPAmBOKADkQdQCQLOPda7a2gEAkPku4DnhAASD4zoAJOl617p1bwCApdECjBkAsJ4AOA0ArDAIFA/A+DJV/fSCA9DWGgEAqfgBBE8DuQtYVlj4KR0AdbViAWhpDgOAFFzBwj2BNAiMxwdoAHDWigXA09IcAgDJAfhLbkf7lHAAFOUTOgBqasS2ANubxgFA8i7gzzRYmhTtB1gWDF6pB6BaLABNd40BgOQA/En4aiABkF1Y+HEdAFVVYgHYtnUUACSfBZzKbW2OCB4ERmjx52MGAAj1A3i2bT0PAJL7AZ7wbG8Ki14L4KBPPQBrxTqCttw5AgCStwC/8dy5eUzoaqCqRsn3X6ADoKJC6GKQ50cN5wBA8llAEwVmCAsJ8/Xs55jAsDY40x4IfJ3iBCZFxQRyjKOjouI8PV8ratlEvqIityOoDng23TbF8XvprIS8e+/mKWCUWpl6w9ZHUR52rKkI5f/kcFqjgvk53Bs2RGjs8bLtmmtyUMtJxHN0Ctp4Mh6b/3Z8fsQg/v+co6Rk5KLp/l5cPBr/HOcX8H0UJUpN8MaEBVPl0HV9ZNMXyp41zUtI1SgGkSr/D0gQmae4n+ZFm5QzcZKYS5LyUiqYQMgJBD5MUUJfSUe5Tln+AmoTgiAIWmyK98GSdAONnBtoULTl3RolYDRqnTBGYlctXb85HWVeskCgOIVHziIv4Td5sMjGqVyJ7kd/20GOq930764k5d64GEf/WfTl99NLmL00Gk+T0Qsb4yhcE2/gGnLWRMg1O+haf/1p13fXn4nbTRtOuzZu7Gdz139/0F3/g7Oem+uH3JtuG4jbrbec4f8zMkrOHKApYNgeVE6QDyA70aCTF6PS/bzxZ5akF+j+X148I3BZvl3Ei7jMpuilXK0t1xkIfJETN3zd+9KfoPnzB2OOysoQ3f9AIje00GeWpBfns0dB5kS/EHoZ5wQDwL+KJww8gSc8DZtCojyB+T/ui8/vHYHAB94BfCBQKPp52bgLtHz983x5IV4G2X+NsoNpOVjcaiB5+BgAV2Hh57RRwQv0zD0AIBkAbS2is4OnAICVAWhvEw3AJG8IAQAsC0DrhOjsYK17FgBYCoD2SdHxADzbAABWBaBDLAAcEuYoLPwSALAoAF7RYeEUFKp1ygAAKwGwo0N4XgAv9QIAqwLQKRyAcXL8fBUALNUuoLhojLqBrwEA6w4CJ9ACwBEkNDsYACzVtYCLg0AAYF0APM3bw5gFLOUWgNKohfsBAICFAbhrGwBY0gBQGrVwVzAAsPAYYOsW4QBgMchMq1bZ6YtGhYeE0Y5gBnF5v3U3NAgDYPkvHo0HhGjTtDgQdSEAoHI6bYskS7dH9MvgDZoNEjTLqXKiorJ03T+8OUp5h88YxUFSK/Cq4Gce125NY7Py2T28YZPACNm7E8KnKL32lSvDns2NodyOtjAtDoW9e3aFfPv2zPi698ZSst27YrTd3FtGi0vkXg476+rGCLBhbTjYZa3A1dQqvSnomaOJziqyriorr6AvvoFezAP0Yn5F9vt3bZL0az6eJVnRlJxZRtcd5S4h4b1U5RQFd/zxMjtlVjY9y2FO+kx2VB3n8FO5D5qWPQ/jSGft2gMEQRAEQZBl5SwqWk6DmCNkIzR6Ph83WR41NEXhEfZ4/N9E16jqCE3xXuCsWvY1mAw+30uzhDvoXi/RjOA1PkmUjpLtT8VoW5j/0GLPvy9ZMPgvNvrbs1T+I9oNIqEE4vkqvbhhyqyN+Hq64zl1Ojvys1j+0XkYbb6Ud09PzFldHaJ7P2+YKNna+h6ap/+Okzi9e3fH8vp6E5T9gP7+/H2MriXLO3BvjDaemmBIE00DIds7DlF+ipwmEVH5ebQpIx+jusdgn8B6x+rVoXSfG3zJEdTYOEEtwfMMGqo5yVrA8oeOCfPH+3btZOfIywYeyCe97W1zQo+O5ZNDZfkzqGlzAISe2sFNMlXEqwaLQX8jOOZEZwZpj4yB9AAIPbotr+8Qr8r9LxMAGJ0bCOkBmBELQC8D8FpGAKDlYABgBQAU5fUMtQBhAGANAPoBgFUBoJGyUAAOH+KKOJ0RAAxODoUyAAA5Zd4AAEsbgIHMAKA/OhZaYADyD/fxfPxMhlqAMQCQ6UEguoCl7ggymQWIPjsYswALANB7v5kfYBau4IwDIIldC+g9yL9EY1fwzs5Z0dvEAYBMLwbdfzDxYlBX54zonUIBQArLwUIBOHgftwCvGAHg7doxLRiAaQCQaQDuO8CzgJcMARB9fDzNcABApgE4cA8Pxl40AkD44dGSNAcAMgyAb383A/CcEQCUHSzu6Fg6wZOfDQDYzFPCqHLOcTCowHN0Jyn+7yGbPibwp8662vPCwNu3lwGIePz+XFS0zTQ7+HsUODHBo/W0n6Ld1jLLUzGyq3QA+P0f4dByzx2bp9N6fCt3O4fI91BcHKWcv1tRw7aUTvK+JX7cajAYtq9ePewoLz+rs4qKIUdVVb+5re2PX1tWNkQVEKLWZZD26g2YlPsNuuYVmiVM2UtLuZwhw7LnYxXlZ+0q7Qugqk1URBZqN0XlXXutiyuETvmStRbP4FWUykRG/fkq7Wfi+/SvWPH+FIrO4m1csgOBb1FrtNKsnKQmyxVc9uLJzYcgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgCIIgaKno/18TZku3+hOLAAAAAElFTkSuQmCC';

// --- Request Handler ---

async function handleMCPRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  const url = new URL(request.url);
  const authHeader = request.headers.get('Authorization') || '';

  // Service liveness only; advisor quality is reviewed from actual query records.
  if (url.pathname === '/health') {
    return jsonResponse({ ok: true, service: 'somewhere-tech-mcp', version: '1.0.0' });
  }

  // Public top-of-funnel advisor. Credentials are optional: anonymous calls
  // use Flex + the atomic per-IP gate; verified calls use standard processing
  // and may inject live project context. The model receives context only — no
  // tools are declared or executable on this route.
  if (url.pathname === '/advisor' && request.method === 'POST') {
    return handlePublicAdvisor(request, env, ctx, authHeader);
  }

  // Public brand assets — no auth (these are NOT MCP endpoints).
  // The Anthropic MCP-directory listing resolves the server's logo via
  //   https://www.google.com/s2/favicons?domain=mcp.somewhere.tech&sz=64
  // which only works if the domain serves a favicon, and the listing also
  // wants a square (1:1) SVG logo URL. We serve both here.
  //   GET /logo.svg                  → square 1:1 SVG (real two-color mark)
  //   GET /favicon.ico, /favicon.png → 128px raster of the same mark
  // tsk: mcp-directory-logo.
  if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/logo.svg') {
    return new Response(request.method === 'HEAD' ? null : LOGO_SQUARE_SVG, {
      headers: {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
  if ((request.method === 'GET' || request.method === 'HEAD')
      && (url.pathname === '/favicon.ico' || url.pathname === '/favicon.png')) {
    const png = Uint8Array.from(atob(LOGO_PNG_BASE64), (c) => c.charCodeAt(0));
    return new Response(request.method === 'HEAD' ? null : png, {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  if ((request.method === 'GET' || request.method === 'HEAD')
      && url.pathname === '/.well-known/openai-apps-challenge') {
    return new Response(
      request.method === 'HEAD' ? null : 'A3C78TSNxkWGdXV4tvW3j3Fzp9EhKRr4CsOggJ5Kl6o',
      {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
        },
      },
    );
  }

  // OAuth 2.1 Protected Resource Metadata (RFC 9728). MCP clients
  // fetch this on the first 401 to discover the authorization server.
  // The `resource` field MUST exactly match the canonical URL the
  // client talks to — anything else and the client refuses to walk
  // the flow.
  //
  // We expose two protected resources today:
  //   /mcp         — full 220+ tool surface (Claude Code, power users)
  //   /mcp/chatgpt — curated app-builder surface (ChatGPT Apps)
  //
  // Per RFC 9728 each protected resource has its own metadata doc, so
  // we serve three discovery paths:
  //   /.well-known/oauth-protected-resource          → /mcp (legacy)
  //   /.well-known/oauth-protected-resource/mcp      → /mcp
  //   /.well-known/oauth-protected-resource/mcp/chatgpt → /mcp/chatgpt
  // The WWW-Authenticate header inside each 401 points at the matching
  // path-suffix variant so the client lands on the right resource doc.
  if (url.pathname === '/.well-known/oauth-protected-resource'
      || url.pathname === '/.well-known/oauth-protected-resource/mcp') {
    return jsonResponse({
      resource: 'https://mcp.somewhere.tech/mcp',
      authorization_servers: ['https://mcp.somewhere.tech'],
    });
  }
  if (url.pathname === '/.well-known/oauth-protected-resource/mcp/chatgpt') {
    return jsonResponse({
      resource: 'https://mcp.somewhere.tech/mcp/chatgpt',
      authorization_servers: ['https://mcp.somewhere.tech'],
    });
  }
  // Connector resource doc (tsk_7e6100a5). A fresh client discovers this from
  // the connector 401's WWW-Authenticate and echoes resource=.../mcp/connector
  // on the authorize request, which the authorize handler treats as
  // anonymous-eligible (frictionless: no full login). Distinct resource from
  // /mcp so the MAIN surface keeps its full-login default.
  if (url.pathname === '/.well-known/oauth-protected-resource/mcp/connector') {
    return jsonResponse({
      resource: 'https://mcp.somewhere.tech/mcp/connector',
      authorization_servers: ['https://mcp.somewhere.tech'],
    });
  }

  // OAuth 2.1 Authorization Server Metadata (RFC 8414). The actual
  // endpoints live on api.somewhere.tech — this document tells the
  // client where to find them.
  if (url.pathname === '/.well-known/oauth-authorization-server') {
    return jsonResponse({
      issuer: 'https://mcp.somewhere.tech',
      authorization_endpoint: 'https://api.somewhere.tech/v1/oauth/authorize',
      token_endpoint: 'https://api.somewhere.tech/v1/oauth/token',
      registration_endpoint: 'https://api.somewhere.tech/v1/oauth/register',
      scopes_supported: ['mcp'],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      // CIMD + RFC 9207 iss (MCP spec 2026-07-28). DCR above stays for the
      // 12-month backcompat window; these are purely additive.
      //
      // ORDERING, LEARNED THE HARD WAY (tsk_bb2aa521): this metadata document
      // is served by the MCP worker, but the capability it claims is
      // implemented in the API WORKER. Advertising it while the API worker was
      // still rolled back told Claude.ai to send an https client_id that the
      // live API worker rejected 400 — connect outage. These flags were only
      // re-enabled after verifying the LIVE API worker answers a real CIMD
      // authorize with 302 (not 400). Never flip them on before that check.
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
  }

  // MCP endpoint — handles JSON-RPC 2.0
  // Connector mode — same handler, restricted tool surface. Mounted
  // separately so the Anthropic connector directory can point its
  // listing at /mcp/connector (≤40 curated tools with annotations)
  // while CLI / Claude Code users keep hitting /mcp with the full
  // 200+ surface. Same OAuth, same auth contract — only tools/list
  // differs (see surface-manifest.mjs below).
  // tsk_caf896b3.
  if ((url.pathname === '/mcp' || url.pathname === '/mcp/connector' || url.pathname === '/mcp/chatgpt') && request.method === 'POST') {
    const isConnectorMode = url.pathname === '/mcp/connector';
    const isChatgptMode = url.pathname === '/mcp/chatgpt';
    const activeSurface = detectToolSurface({
      pathname: url.pathname,
      userAgent: request.headers.get('User-Agent'),
    });
    // Two auth modes:
    //   1. `Bearer smt_...`            — developer key (Claude Code config)
    //   2. `Bearer ey<JWT>` (mcp_oauth) — Claude.ai custom connector flow
    // Unauthenticated callers get 401 + WWW-Authenticate so the client
    // discovers our OAuth metadata and walks the authorization code flow.
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const hasSmtKey = bearer.startsWith('smt_');
    const hasOAuthJwt = !hasSmtKey && bearer.split('.').length === 3 && bearer.length > 40;
    const isAuthed = hasSmtKey || hasOAuthJwt;

    // Pick the resource-specific discovery URL so the client lands on
    // the right protected-resource doc (/mcp vs /mcp/chatgpt). RFC 9728
    // metadata is per-resource; pointing all 401s at the generic
    // discovery doc would break OAuth for the /mcp/chatgpt endpoint.
    const resourceMetadataUrl = isChatgptMode
      ? 'https://mcp.somewhere.tech/.well-known/oauth-protected-resource/mcp/chatgpt'
      : isConnectorMode
      ? 'https://mcp.somewhere.tech/.well-known/oauth-protected-resource/mcp/connector'
      : 'https://mcp.somewhere.tech/.well-known/oauth-protected-resource/mcp';

    if (!isAuthed) {
      return new Response(
        JSON.stringify(rpcError(null, -32000, 'Unauthorized. This MCP server requires OAuth — discover the metadata at /.well-known/oauth-protected-resource.')),
        {
          status: 401,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'WWW-Authenticate': `Bearer realm="somewhere.tech", resource_metadata="${resourceMetadataUrl}"`,
          },
        },
      );
    }

    // AUDIENCE. A token minted while authorizing ONE surface must not be
    // spendable on another. The curated surfaces advertise a few dozen tools;
    // the full surface advertises hundreds, including project deletion,
    // database restore, impersonation and refunds. Without this, a user who
    // approved the curated connector had in fact handed over everything.
    //
    // A pre-cutover token carries no `aud` and is accepted on every surface
    // exactly as before, so nothing already connected breaks (rule 9). There is
    // no legitimate cross-surface use of an audience-bound token: a client
    // discovers one resource from the 401 it received and authorizes against
    // that one, so this is on by default rather than warn-first.
    const tokenSurface = tokenAudienceSurface(authHeader);
    if (tokenSurface !== null && tokenSurface !== activeSurface) {
      console.error(JSON.stringify({
        at: 'mcp.audience',
        error: 'TOKEN_SURFACE_MISMATCH',
        endpoint: url.pathname,
        token_surface: tokenSurface,
        requested_surface: activeSurface,
      }));
      return new Response(
        JSON.stringify(rpcError(
          null,
          -32000,
          'This connection was authorized for a different toolset. Reconnect from this endpoint to authorize it.',
        )),
        {
          status: 403,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        },
      );
    }

    // Parse the JSON-RPC body. A malformed body used to crash the
    // worker (uncaught exception → CF error 1101 HTML page) which is
    // both ugly and impossible to debug from a JSON-RPC client. Wrap
    // it and return the spec's -32700 Parse Error instead.
    let body: JsonRpcRequest;
    // Read the body as TEXT and parse it here. Identical result, but it keeps
    // the exact bytes the caller sent, which is the only place a whole number
    // wider than a JSON number still exists — `JSON.parse` rounds it, and this
    // server would then relay the rounded value to the platform as if it were
    // the one asked for (tsk_d741c40b).
    let rawBody = '';
    try {
      rawBody = await request.text();
      body = JSON.parse(rawBody) as JsonRpcRequest;
    } catch (err) {
      return jsonResponse(
        rpcError(null, -32700, 'Parse error: request body is not valid JSON', err instanceof Error ? err.message : undefined),
        400
      );
    }
    const { id, method, params } = body;

    // Era chokepoint (tsk_68b7c8c5). A request carrying modern per-request
    // `_meta` (spec 2026-07-28) is served statelessly under that revision; an
    // initialize-negotiated request flows through the legacy path UNTOUCHED —
    // every currently-shipping Claude/ChatGPT client is legacy. All modern
    // header/version validation happens inside detectEra; a rejection here is
    // the spec's mandated 400 + HeaderMismatch (-32020) / Unsupported-
    // ProtocolVersion (-32022) shape, which is also how dual-era CLIENTS
    // probe: a recognized modern error means "modern server, retry", so
    // these rejections are load-bearing for interop, not just hygiene.
    const eraDecision = detectEra(request.headers, body);
    if (eraDecision.era === 'rejected') {
      return jsonResponse(rpcError(id ?? null, eraDecision.code, eraDecision.message, eraDecision.data), eraDecision.status);
    }
    const modern: ModernContext | null = eraDecision.era === 'modern' ? eraDecision : null;

    // A tool call that carries customer data into the platform's database is
    // refused here if a whole number in it was already rounded by the parse.
    // The digits are still in `rawBody`, so the caller is told exactly which
    // value was lost and the exact form that survives — a string, the same
    // form a read returns (tsk_d741c40b). Every call with nothing out of range
    // is untouched.
    if (method === 'tools/call') {
      const calledTool = (params as { name?: unknown } | undefined)?.name;
      if (typeof calledTool === 'string' && EXACT_NUMBER_TOOLS.has(calledTool)) {
        const lostPrecision = scanLostPrecisionIntegers(rawBody);
        if (lostPrecision.length > 0) {
          return jsonResponse(rpcError(id ?? null, -32602, lostPrecisionMessage(lostPrecision)));
        }
      }
    }

    // Handshake fail-closed (tsk_e2781883). The `isAuthed` gate above is
    // SHAPE-ONLY for mcp_oauth bearers (hasOAuthJwt = 3 dot-parts + length) —
    // it never checks signature, expiry, or token type. That asymmetry let a
    // dead/expired/wrong token sail through initialize + tools/list (200, full
    // tool list → Claude.ai shows "connected") while every real tools/call
    // 401'd, and reconnect never recovered. Close it: for a JWT-shaped
    // (mcp_oauth, non-smt_) bearer, run the SAME upstream verification a
    // tools/call already triggers (callAPI → GET /v1/projects → the API
    // worker's mcp_oauth verifier) at the handshake too. A rejected token
    // returns 401 + WWW-Authenticate error="invalid_token" HERE, so Claude.ai
    // re-auths before the user ever sees a connected-but-broken state. A
    // valid, unexpired token verifies and the handshake proceeds unchanged —
    // working connectors are not broken. A transient upstream failure does NOT
    // fail closed (a momentary outage must not log a working session out).
    // smt_ keys use the same upstream check so an already-expired CLI pair
    // renews before the first tool list is accepted.
    if (
      (method === 'initialize' || method === 'tools/list' || method === 'server/discover')
      && (bearerLooksLikeOAuthJwt(authHeader) || bearerLooksLikeApiKey(authHeader))
    ) {
      const verdict = await classifyHandshakeBearer(env, authHeader);
      if (verdict === 'rejected') {
        // Operator-visible classified log — no auth-failure path is silent
        // (founder directive tsk_e2781883). Same structured-JSON console
        // primitive the rest of this worker uses (callRunner / tool-usage),
        // surfaced via wrangler tail. No token material is logged.
        console.error(JSON.stringify({
          at: 'mcp.handshake',
          error: bearerLooksLikeOAuthJwt(authHeader)
            ? 'HANDSHAKE_OAUTH_REJECTED'
            : 'HANDSHAKE_API_KEY_REJECTED',
          method,
          endpoint: url.pathname,
          reason: bearerLooksLikeOAuthJwt(authHeader)
            ? 'mcp_oauth bearer rejected by upstream verifier'
            : 'smt_ bearer rejected by upstream verifier',
        }));
        const rejection = bearerLooksLikeOAuthJwt(authHeader)
          ? new UpstreamOAuthRejectedError('Upstream rejected the OAuth token.')
          : new UpstreamApiKeyRejectedError('Upstream rejected the API key.', 'INVALID_API_KEY');
        return upstreamAuthRejectedResponse({
          id: id ?? null,
          kind: rejection instanceof UpstreamOAuthRejectedError ? 'oauth' : 'api_key',
          code: rejection instanceof UpstreamApiKeyRejectedError ? rejection.code : undefined,
          resourceMetadataUrl,
        });
      }
    }

    switch (method) {
      case 'server/discover': {
        // Modern-era discovery (spec 2026-07-28: servers MUST implement).
        // Serves the SAME surface-aware instructions initialize serves — one
        // source of truth for what an agent reads first. clientInfo arrives
        // per-request in `_meta` in the modern era, so caller detection uses
        // it exactly the way initialize uses its handshake clientInfo.
        const discClientInfo = modern?.clientInfo ?? undefined;
        const discClientName = discClientInfo && typeof discClientInfo.name === 'string'
          ? discClientInfo.name
          : null;
        const discCaller = detectCallerKind({
          userAgent: request.headers.get('User-Agent'),
          isConnectorMode,
          isChatgptMode,
          clientInfoName: discClientName,
        });
        const discSurface = detectToolSurface({
          pathname: url.pathname,
          userAgent: request.headers.get('User-Agent'),
          clientInfoName: discClientName,
        });
        await recordClientSession(env, authHeader, discClientInfo, discSurface);
        const discSurfaceTools = advertisedNamesForSurface(discSurface);
        const discHelpPush = discSurfaceTools.has('advisor')
          ? '> **Reference surfaces:** `catalog` lists which tools exist, `docs({ topic })` returns one static surface contract, and `advisor({ question })` can inspect an authorized live project.\n\n'
          : '> **Reference surfaces:** `catalog` lists which tools exist and `docs({ topic })` returns one static surface contract.\n\n';
        const discCallerHint = discSurface === 'connector'
          ? 'This connector creates projects, reads source, publishes source changes, and verifies live apps. Database schemas are declared in deployed source; table ownership is managed with db_scope_set.\n\n'
          : discCaller === 'cli'
          ? "> Shell-capable client detected: use the `somewhere` CLI as the primary platform surface. Use first-class commands for routine work and `somewhere call <tool> '<json>'` for the complete tool catalog. MCP remains appropriate when its in-context delivery is useful.\n\n"
          : discCaller === 'connector'
            ? '> Shell-less client detected: MCP tools (`project_create` / `project_deploy` / `db_query` / `fs_write`) are the executable path; CLI commands cannot run here.\n\n'
            : '';
        const discNoticeInstructions = isAuthed
          ? await fetchConnectNoticeInstructions(env.API_SERVICE, authHeader)
          : '';
        return jsonResponse(rpcResult(id, discoverResult(
          discNoticeInstructions + discHelpPush + discCallerHint + initializeInstructionsForSurface(discSurface),
        )));
      }

      case 'initialize': {
        // The `instructions` field on InitializeResult is part of the MCP
        // 2024-11-05 spec. Clients keep it in context for the entire MCP
        // connection, so keep it short: floor-setting rules plus pointers,
        // not the manual.
        //
        // Caller-aware lead-in (tsk_8b3422b3): `initialize` is the ONE
        // request that carries the client's `clientInfo` ({name, version}).
        // The transport is stateless so we can't stash it for later calls —
        // but we CAN tailor THIS response. We prepend a one-line path hint
        // (CLI-first for shell-having agents, tool-first for shell-less
        // connectors) computed from clientInfo + the endpoint + UA, so the
        // very first thing the agent reads is the right path for its shape.
        const initClientInfo = (params as { clientInfo?: { name?: unknown; version?: unknown } } | undefined)?.clientInfo;
        const initClientName = initClientInfo && typeof initClientInfo.name === 'string'
          ? initClientInfo.name
          : null;
        const initCaller = detectCallerKind({
          userAgent: request.headers.get('User-Agent'),
          isConnectorMode,
          isChatgptMode,
          clientInfoName: initClientName,
        });
        const initSurface = detectToolSurface({
          pathname: url.pathname,
          userAgent: request.headers.get('User-Agent'),
          clientInfoName: initClientName,
        });
        await recordClientSession(env, authHeader, initClientInfo, initSurface);
        // Lead with the reference-surface facts because some clients truncate
        // the initialize field. `docs` is the primary name; the older
        const initSurfaceTools = advertisedNamesForSurface(initSurface);
        const helpPush = initSurfaceTools.has('advisor')
          ? '> **Reference surfaces:** `catalog` lists which tools exist, `docs({ topic })` returns one static surface contract, and `advisor({ question })` can inspect an authorized live project.\n\n'
          : '> **Reference surfaces:** `catalog` lists which tools exist and `docs({ topic })` returns one static surface contract.\n\n';
        const callerHint = initSurface === 'connector'
          ? 'This connector creates projects, reads source, publishes source changes, and verifies live apps. Database schemas are declared in deployed source; table ownership is managed with db_scope_set.\n\n'
          : initCaller === 'cli'
          ? "> Shell-capable client detected: use the `somewhere` CLI as the primary platform surface. Use first-class commands for routine work and `somewhere call <tool> '<json>'` for the complete tool catalog. MCP remains appropriate when its in-context delivery is useful.\n\n"
          : initCaller === 'connector'
            ? '> Shell-less client detected: MCP tools (`project_create` / `project_deploy` / `db_query` / `fs_write`) are the executable path; CLI commands cannot run here.\n\n'
            : '';
        const initNoticeInstructions = isAuthed
          ? await fetchConnectNoticeInstructions(env.API_SERVICE, authHeader)
          : '';
        return jsonResponse(rpcResult(id, {
          protocolVersion: negotiateLegacyProtocolVersion(params?.protocolVersion),
          capabilities: { tools: {} },
          serverInfo: {
            name: 'somewhere-tech',
            version: '1.0.0',
          },
          // These lines are assembled from the active surface above. Do not
          // pass them through generic prose filtering: code paths such as
          // `api/` are not references to the `api` MCP tool.
          instructions: initNoticeInstructions + helpPush + callerHint + initializeInstructionsForSurface(initSurface),
        }));
      }

      case 'notifications/initialized':
        return jsonResponse(rpcResult(id, {}));

      case 'tools/list': {
        // Authentication decides whether admin tools can enter the candidate
        // registry. The active surface + group scope below then decides the
        // exact tools/list advertisement from that same registry.
        let visible: MCPTool[];
        if (!isAuthed) {
          visible = TOOL_DEFINITIONS.filter((t) => toolVisibility(t.name) === 'public');
        } else if (isAdminCaller(env, authHeader)) {
          visible = TOOL_DEFINITIONS;
        } else {
          visible = TOOL_DEFINITIONS.filter((t) => toolVisibility(t.name) !== 'admin');
        }
        // Plain /mcp scoping (connector/chatgpt keep curated projections):
        // no groups → CORE; named groups → help + those groups; all → full.
        let groupKeys: string[] = [];
        if (!isConnectorMode && !isChatgptMode) {
          const groupsRaw = (url.searchParams.get('groups') ?? request.headers.get('Mcp-Tool-Groups') ?? '').trim().toLowerCase();
          groupKeys = parseGroupList(groupsRaw);
          const unknownGroups = groupKeys.filter((key) => key !== 'all' && key !== 'other' && !resolveCatalogGroup(key));
          if (unknownGroups.length > 0) {
            const validGroups = [...CATALOG_CATEGORIES.map((category) => category.key), 'other', 'all'];
            return jsonResponse(rpcError(id, -32602, `Unknown tool group(s): ${unknownGroups.join(', ')}.`, {
              error: 'UNKNOWN_GROUP',
              valid_groups: validGroups,
            }));
          }
        }
        // 2026-07-09 founder re-slim: bare /mcp advertises the usage-evidenced
        // CORE set; named groups advertise help + those groups; all reveals the
        // full registered surface. Catalog availability uses this same helper.
        const surfaceNames = listedNamesForSurface(
          activeSurface,
          groupKeys,
          isAdminCaller(env, authHeader),
        );
        visible = visible.filter((tool) => surfaceNames.has(tool.name));
        // Decorate with MCP spec annotations (title / readOnlyHint /
        // destructiveHint / idempotentHint / openWorldHint) so the
        // client UI can render the right safety colour + confirm
        // step on destructive tools. Only annotated tools get the
        // field; others are returned unchanged.
        // Emit in curated agent-value order (CORE insertion order) instead of
        // tool-registration order, so an agent reading the list top-down meets
        // discovery + the build-loop heroes first and management/dangerous tools
        // later. Non-CORE tools (full/group surfaces) sort stably after CORE in
        // their existing order. Presentational only — registrations unchanged.
        // (founder: agent-experience is the guiding principle; the order should
        // help the agent.)
        const coreRank = new Map(TOOL_SPECS
          .filter((spec) => spec.core)
          .map((spec) => [spec.definition.name, spec.coreRank ?? Number.MAX_SAFE_INTEGER]));
        const decorateTool = (tool: MCPTool) => {
          const constrained = constrainToolDefinitionToSurface(tool, activeSurface);
          return isChatgptMode ? withChatgptToolMetadata(constrained) : withToolAnnotations(constrained, activeSurface);
        };
        const annotated = visible
          .map(decorateTool)
          .sort((a, b) => (coreRank.get(a.name) ?? Number.MAX_SAFE_INTEGER) - (coreRank.get(b.name) ?? Number.MAX_SAFE_INTEGER));
        // Cursor paging is the default for current-era requests and the
        // Streamable HTTP legacy revisions. Pre-header clients retain the
        // historical one-shot response; supplying a cursor opts any client
        // into paging. The cursor is bound to this ordered surface projection.
        const cursorSupplied = Object.prototype.hasOwnProperty.call(params ?? {}, 'cursor');
        const usePagination = shouldPaginateToolList(
          modern !== null,
          request.headers.get('MCP-Protocol-Version'),
          cursorSupplied,
        );
        let listResult: { tools: MCPTool[]; nextCursor?: string };
        try {
          listResult = usePagination
            ? paginateToolList(annotated, cursorSupplied ? params?.cursor : undefined)
            : { tools: annotated };
        } catch (error) {
          if (error instanceof InvalidToolListCursorError) {
            return jsonResponse(rpcError(id, -32602, 'Invalid tools/list cursor.'));
          }
          throw error;
        }

        // Modern era: CacheableResult hints + required resultType/serverInfo.
        // The sort above already gives the deterministic order the spec asks
        // for. Legacy result envelopes remain unchanged apart from the
        // spec-defined optional nextCursor when paging is active.
        if (modern) {
          return jsonResponse(rpcResult(id, modernizeResult({ ...listResult, ...LIST_CACHE_HINTS })));
        }
        return jsonResponse(rpcResult(id, listResult));
      }

      case 'tools/call': {
        const requestedToolName = (params?.name as string) || '';
        const toolName = requestedToolName;
        let toolArgs = (params?.arguments as Record<string, unknown>) || {};

        // MRTR retry (modern era): the client answered a confirmation we
        // asked for below. Accepted → merge the server-minted args (confirm
        // flag / delete code) and run the call for real. Declined → a
        // complete "cancelled" result; the tool never runs. The state is
        // tamper-exempt per MRTR rule 4: everything it carries is upstream-
        // minted, TTL'd, and bound to the project it was minted for, so a
        // forged state can only produce an upstream rejection.
        const confirmationRetry = modern ? readConfirmationRetry(params, toolName) : null;
        if (confirmationRetry) {
          if (!confirmationRetry.accepted) {
            return jsonResponse(rpcResult(id, modernizeResult({
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  ok: false,
                  error: 'CONFIRMATION_DECLINED',
                  message: 'The user declined the confirmation. No action was taken.',
                }, null, 2),
              }],
              isError: true,
            })));
          }
          toolArgs = { ...toolArgs, ...confirmationRetry.state.merge };
        }

        const respondWithToolResult = (result: ToolExecutionResult) => {
          const safeResult = jsonSafeToolError(result);
          if (!modern) return jsonResponse(rpcResult(id, safeResult));
          // Modern era: convert the legacy CONFIRMATION_REQUIRED error dance
          // into a first-class MRTR round-trip — but ONLY when the client
          // declared the elicitation capability (spec: servers MUST NOT send
          // inputRequests the client has not declared support for). Everyone
          // else keeps the self-describing error payload, which remains a
          // valid complete result.
          //
          // Scoped to `api`, whose confirmation is a single-tool re-call with
          // `confirm:true` — the retry re-runs THIS tool with the flag merged
          // and it proceeds. `project_delete` is deliberately NOT here: its
          // confirmation is a two-tool dance (project_delete mints a code,
          // project_delete_confirm spends it), so re-running project_delete
          // with a merged code would just mint another code and loop. It
          // keeps the self-describing code payload, which the agent drives via
          // project_delete_confirm exactly as in the legacy era.
          if (clientSupportsElicitation(modern.clientCapabilities) && toolName === 'api') {
            const firstText = safeResult.content?.[0]?.type === 'text' ? safeResult.content[0].text : null;
            let payload: Record<string, unknown> | null = null;
            if (firstText) {
              try {
                const parsed = JSON.parse(firstText) as unknown;
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                  payload = parsed as Record<string, unknown>;
                }
              } catch { /* not JSON — never a confirmation payload */ }
            }
            if (payload?.error === 'CONFIRMATION_REQUIRED') {
              const message = typeof payload.message === 'string' && payload.message.trim()
                ? payload.message
                : 'This action requires explicit confirmation before it runs.';
              return jsonResponse(rpcResult(id, confirmationInputRequired(message, { tool: toolName, merge: { confirm: true } })));
            }
          }
          return jsonResponse(rpcResult(id, modernizeResult(safeResult as unknown as Record<string, unknown>)));
        };

        // Retired calls have a deterministic remedy, never a paid miss lookup
        // or a fuzzy suggestion of another schema mutation operation.
        if (toolName === 'db_schema_apply') {
          return jsonResponse(rpcError(id, -32602,
            'Standalone schema apply is retired. Edit db/schema.ts in the complete app source, then use project_deploy (or project_patch for an existing app) to deploy or preview the app. Schema changes are applied with that release. Nothing was changed.',
            { error_code: 'SCHEMA_APPLY_RETIRED' },
          ));
        }

        const tool = TOOL_DEFINITIONS.find(t => t.name === toolName);
        if (!tool) {
          // A wrong tool call is a documentation failure on our side. Record
          // it (doc-gap signal) and hand back the correct call instead of a
          // dead end.
          const argKeys = Object.keys(toolArgs);
          const det = deterministicSuggestion(toolName);
          let message: string;
          let nextCall: NextCallRecommendation | null = det?.next_call ?? null;
          let nextCallSource: 'deterministic' | 'nano' = 'deterministic';
          if (det) {
            nextCall = constrainNextCallToSurface(
              det.next_call,
              toolName,
              toolArgs,
              null,
              activeSurface,
            );
            message = nextCall.tool === det.next_call.tool
              ? det.text
              : `Unknown tool "${sanitizeAgentText(toolName, 120)}". Use ${formatNextCall(nextCall)}.`;
            // Have a deterministic answer — log without a model call.
            const projectId = projectIdFromToolArgs(toolArgs);
            ctx.waitUntil(
              reportMiss(env, authHeader, {
                miss_type: 'unknown_tool', tool_attempted: toolName, arg_keys: argKeys,
                ...(projectId ? { project_id: projectId } : {}),
                suggestion: formatNextCall(nextCall), suggestion_source: det.source,
                next_call: nextCall, want_ai: false,
              }).then(() => {}, () => {}),
            );
          } else if (isAuthed) {
            // No deterministic answer + authed → log + ask nano in the
            // background. The miss response itself stays deterministic and
            // never waits on the model or logging path.
            nextCall = catalogNextCall(toolName);
            nextCallSource = 'deterministic';
            message = `Unknown tool "${sanitizeAgentText(toolName, 120)}". Use ${formatNextCall(nextCall)}.`;
            const projectId2 = projectIdFromToolArgs(toolArgs);
            queueMissReport(env, authHeader, ctx, {
              miss_type: 'unknown_tool', tool_attempted: toolName, arg_keys: argKeys,
              ...(projectId2 ? { project_id: projectId2 } : {}),
              want_ai: true,
              candidates: [...advertisedNamesForSurface(activeSurface)],
              catalog_summary: buildCatalogSummaryForMiss(activeSurface),
            });
          } else {
            // Unauthed caller — can't attribute or bill a correction; just guide.
            nextCall = deterministicUnknownToolNextCall(toolName) ?? catalogNextCall(toolName);
            nextCallSource = 'deterministic';
            message = unknownToolMessage(toolName);
          }
          return jsonResponse(rpcError(id, -32602, message, {
            next_call: nextCall ?? catalogNextCall(toolName),
            next_call_source: nextCallSource,
          }));
        }

        // Anonymous callers can only invoke entries whose ToolSpec is public.
        // Auth'd callers (smt_ OR mcp_oauth JWT) reach the full surface. NOTE:
        // `isAuthed` here is shape-only — for REST-backed tools that's
        // fine because the API worker re-validates the bearer on the
        // upstream call and fails a forged token closed there. It is
        // NOT sufficient for MCP-NATIVE paid tools (no upstream call to
        // re-validate against) — those are gated separately by
        // verifyBearerUpstream below. tsk_f9c77079.
        if (!isAuthed && toolVisibility(toolName) !== 'public') {
          return respondWithToolResult({
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: 'UNAUTHORIZED',
                message: `Tool "${requestedToolName}" requires authentication. Sign in via the OAuth flow or set an smt_ API key.`,
              }, null, 2),
            }],
            isError: true,
          });
        }

        // Admin tool gate. Without this, anyone with a valid smt_ key
        // could hit debug_project / debug_site / somewhere_*_stats
        // because the MCP worker forwards requests using its own
        // server-side admin secret regardless of the calling key.
        // Returns the standard error envelope as the tool result so
        // the client doesn't have to special-case admin failures.
        if (toolVisibility(toolName) === 'admin' && !isAdminCaller(env, authHeader)) {
          return respondWithToolResult({
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: 'FORBIDDEN',
                message: `Tool "${requestedToolName}" requires admin scope. Your API key is not on the admin allowlist.`,
              }, null, 2),
            }],
            isError: true,
          });
        }

        // Curated-surface gate (tsk_f34dfd55). The connector and chatgpt
        // surfaces are sandboxed by curation (§3): tools/list only SHOWS
        // their curated set, but tools/call resolves from the FULL registry
        // above — so without this a connector/chatgpt caller could invoke a
        // deliberately-hidden destructive tool (project_delete, db_restore,
        // payments_refund, auth_impersonate, ...) within their own account.
        // Enforce the SAME filter at call that tools/list applies, so the
        // curation is real containment, not just visibility.
        const adminToolAllowed = toolVisibility(toolName) === 'admin' && isAdminCaller(env, authHeader)
          && activeSurface === 'full';
        if (!adminToolAllowed && !surfaceAllowsCanonicalTool(activeSurface, requestedToolName)) {
          return respondWithToolResult({
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: 'TOOL_NOT_AVAILABLE',
                message: `Tool "${requestedToolName}" is not available on the ${activeSurface} surface.`,
              }, null, 2),
            }],
            isError: true,
          });
        }

        // MCP-NATIVE paid tools (advisor) spend an upstream
        // paid resource INSIDE this worker, so — unlike REST-backed
        // tools — no downstream API call re-validates the bearer. The
        // shape-only isAuthed flag above lets a forged bearer through.
        // Verify it for real against the auth layer BEFORE spending, and
        // rate-limit verified callers so a valid key can't run up
        // unbounded cost. tsk_f9c77079.
        if (toolUsesMcpNativePaidResource(toolName)) {
          const authVerdict = await classifyHandshakeBearer(env, authHeader);
          if (authVerdict === 'rejected') {
            const rejection = bearerLooksLikeOAuthJwt(authHeader)
              ? new UpstreamOAuthRejectedError('Upstream rejected the OAuth token.')
              : new UpstreamApiKeyRejectedError('Upstream rejected the API key.', 'INVALID_API_KEY');
            return upstreamAuthRejectedResponse({
              id,
              kind: rejection instanceof UpstreamOAuthRejectedError ? 'oauth' : 'api_key',
              code: rejection instanceof UpstreamApiKeyRejectedError ? rejection.code : undefined,
              resourceMetadataUrl,
            });
          }
          if (authVerdict !== 'valid') {
            return respondWithToolResult({
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  ok: false,
                  error: 'UNAUTHORIZED',
                  message: `Tool "${requestedToolName}" requires a verified API key or signed-in session — your bearer did not authenticate.`,
                }, null, 2),
              }],
              isError: true,
            });
          }
          const rl = await checkAdvisorRateLimit(env, request, authHeader);
          if (!rl.allowed) {
            return respondWithToolResult({
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  ok: false,
                  error: 'RATE_LIMITED',
                  message: `Rate limit reached for "${requestedToolName}". Try again in ${rl.retryAfterS}s.`,
                }, null, 2),
              }],
              isError: true,
            });
          }
        }

        // Caller-aware help (tsk_8b3422b3): classify the calling agent from
        // per-request signals — the endpoint it hit (connector/chatgpt are
        // shell-less) and its User-Agent (claude-code/cursor/cli → shell).
        // The transport is stateless, so the clientInfo sent on `initialize`
        // is NOT available here; the UA + endpoint are. docs and advisor use
        // this to lead with CLI-first vs tool-first.
        const callerKind = detectCallerKind({
          userAgent: request.headers.get('User-Agent'),
          isConnectorMode,
          isChatgptMode,
        });
        // Catch uncaught exceptions from executeTool so the client
        // gets a JSON-RPC error envelope instead of CF 1101.
        const callerAuthBoundary = new CallerAuthBoundary(authHeader);
        try {
          const result = await executeTool(
            toolName,
            toolArgs,
            env,
            authHeader,
            callerAuthBoundary,
            ctx,
            isChatgptMode ? 'chatgpt' : 'standard',
            callerKind,
            activeSurface,
            modern?.traceContext,
            helpSessionIdForRequest(request, modern?.traceContext),
          );
          // This is the single authenticated tool-response boundary. Inner
          // handlers may catch/translate ordinary upstream failures, but a
          // caller-bearer rejection latched by any wrapped binding always wins.
          callerAuthBoundary.assertAccepted();
          const resultWithNotices = isAuthed
            ? await maybeInjectProjectNoticeContext(
                result,
                toolName,
                toolArgs,
                traceContextFetcher(callerAuthBoundary.wrap(env.API_SERVICE), modern?.traceContext),
                authHeader,
              )
            : result;
          callerAuthBoundary.assertAccepted();
          // Count the successful call (catalog usage data, tsk_5cc21f58).
          // isError results are excluded — wrong calls are reportMiss's
          // signal; this table answers "which tools do agents reach for
          // and succeed with".
          if (isAuthed && !resultWithNotices.isError) recordToolUsage(env, ctx, authHeader, requestedToolName, toolArgs);
          return respondWithToolResult(resultWithNotices);
        } catch (err) {
          // OAuth token rejected upstream (expired/revoked/malformed).
          // Return HTTP 401 + WWW-Authenticate so Claude.ai's MCP
          // connector triggers its refresh-token flow instead of
          // surfacing a normal tool error.
          if (isCallerAuthRejection(err)) {
            return upstreamAuthRejectedResponse({
              id,
              kind: err instanceof UpstreamOAuthRejectedError ? 'oauth' : 'api_key',
              code: err instanceof UpstreamApiKeyRejectedError ? err.code : undefined,
              resourceMetadataUrl,
            });
          }
          console.error(`tools/call ${requestedToolName} threw:`, err);
          return jsonResponse(rpcError(
            id,
            -32603,
            'Internal error in tool execution',
            err instanceof Error ? err.message : String(err)
          ));
        }
      }

      default:
        // Modern era: the spec mandates 404 + -32601 for an unimplemented
        // RPC (the JSON-RPC body is what distinguishes us from a legacy
        // HTTP+SSE server's 404). Legacy keeps the 200 it always got.
        return jsonResponse(rpcError(id, -32601, `Method not found: ${method}`), modern ? 404 : 200);
    }
  }

  // Spec 2026-07-28: GET and DELETE on the MCP endpoint (legacy SSE streams /
  // session teardown) are answered with 405 — there are no sessions to
  // delete and no GET stream to open here, and never were.
  if ((url.pathname === '/mcp' || url.pathname === '/mcp/connector' || url.pathname === '/mcp/chatgpt')
    && (request.method === 'GET' || request.method === 'DELETE')) {
    return jsonResponse(rpcError(null, -32000, 'Method not allowed. The MCP endpoint accepts POST only.'), 405);
  }

  // Fallback 404
  return jsonResponse({ error: 'Not found. MCP endpoint is POST /mcp' }, 404);
}

function jsonResponse(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

/**
 * Top-level catch-all so any uncaught exception from inside
 * handleMCPRequest produces a proper JSON-RPC error envelope instead
 * of letting the runtime return a raw HTML error page. The MCP
 * spec says servers MUST return JSON-RPC even for errors.
 */
async function safeFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    return await handleMCPRequest(request, env, ctx);
  } catch (err) {
    console.error('Top-level handler threw:', err);
    return new Response(
      JSON.stringify(rpcError(null, -32603, 'Internal server error', err instanceof Error ? err.message : String(err))),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      }
    );
  }
}

export default {
  fetch: safeFetch,
};
