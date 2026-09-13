/**
 * protocol-2026.ts — MCP spec 2026-07-28 "modern era" support (tsk_68b7c8c5).
 *
 * The 2026-07-28 revision removed the initialize handshake: every request
 * carries its protocol version, client identity, and capabilities in `_meta`,
 * and the server answers each request independently. This server is DUAL-ERA
 * per the spec's versioning page: a request carrying modern per-request
 * `_meta` is served statelessly under this revision; an `initialize` request
 * selects negotiated legacy semantics for clients that still use the
 * handshake.
 *
 * Everything here is a pure function over (headers, parsed body) so the gate
 * script can exercise the full matrix directly in node — no worker spin-up.
 * index.ts owns transport and dispatch; this module owns era detection,
 * header/version validation, the modern result envelope, and the MRTR
 * confirmation flow.
 */

// The modern versions we implement. Order matters: newest first, and this
// exact array is advertised in UnsupportedProtocolVersionError.data.supported
// and in DiscoverResult.supportedVersions.
export const SUPPORTED_MODERN_VERSIONS = ['2026-07-28'] as const;

// Initialization-based revisions this dual-era server implements. Order
// matters: newest first, because the legacy negotiation rule says the server
// returns its latest supported revision when the client's requested revision
// is absent or unsupported.
export const LATEST_SUPPORTED_LEGACY_VERSION = '2025-11-25' as const;
export const SUPPORTED_LEGACY_VERSIONS = [
  LATEST_SUPPORTED_LEGACY_VERSION,
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;

/** Negotiate an initialization-based protocol revision. Legacy MCP requires
 *  the server to echo a supported client request and otherwise select the
 *  server's latest supported revision. Treat non-string/empty input as an
 *  unsupported request so malformed handshakes still get a valid result. */
export function negotiateLegacyProtocolVersion(requested: unknown): string {
  return typeof requested === 'string'
    && (SUPPORTED_LEGACY_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : LATEST_SUPPORTED_LEGACY_VERSION;
}

export const SERVER_INFO = { name: 'somewhere-tech', version: '1.0.0' } as const;

// _meta keys, verbatim from the spec. The prefix is load-bearing.
const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo';
const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

// Distributed tracing keys are deliberately un-namespaced in MCP 2026. They
// mirror the W3C HTTP header names so an MCP transport can carry one context
// across non-HTTP hops without inventing another correlation format.
const META_TRACEPARENT = 'traceparent';
const META_TRACESTATE = 'tracestate';
const META_BAGGAGE = 'baggage';

// Spec error codes (2026-07-28 allocation: -32020..-32099 reserved for MCP).
export const ERROR_HEADER_MISMATCH = -32020;
export const ERROR_UNSUPPORTED_PROTOCOL_VERSION = -32022;

export interface ModernContext {
  era: 'modern';
  protocolVersion: string;
  clientInfo: { name?: string; version?: string } | null;
  clientCapabilities: Record<string, unknown>;
  traceContext: ModernTraceContext;
}

export interface ModernTraceContext {
  traceparent?: string;
  tracestate?: string;
  baggage?: string;
}

export interface LegacyContext {
  era: 'legacy';
}

export interface EraRejection {
  era: 'rejected';
  /** HTTP status — the spec mandates 400 for both mismatch and version errors. */
  status: number;
  code: number;
  message: string;
  data?: unknown;
}

export type EraDecision = ModernContext | LegacyContext | EraRejection;

interface HeaderReader {
  get(name: string): string | null;
}

interface ParsedRequestBody {
  method?: unknown;
  params?: Record<string, unknown> | undefined;
}

function metaOf(body: ParsedRequestBody): Record<string, unknown> | null {
  const meta = body.params?.['_meta'];
  return meta && typeof meta === 'object' && !Array.isArray(meta)
    ? meta as Record<string, unknown>
    : null;
}

function boundedMetaString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) return undefined;
  if (value.includes('\r') || value.includes('\n')) return undefined;
  return value;
}

/** Extract only valid, bounded trace fields. Bad telemetry is ignored rather
 * than rejecting the tool call: trace propagation is observability, never a
 * new guardrail on working MCP clients. */
export function traceContextFromMeta(meta: Record<string, unknown> | null): ModernTraceContext {
  const traceparent = boundedMetaString(meta?.[META_TRACEPARENT], 512);
  const tracestate = boundedMetaString(meta?.[META_TRACESTATE], 512);
  const baggage = boundedMetaString(meta?.[META_BAGGAGE], 8_192);
  const validTraceparent = traceparent
    && /^(?!ff)[0-9a-f]{2}-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}(?:-.*)?$/.test(traceparent)
    && (traceparent.slice(0, 2) !== '00' || traceparent.length === 55)
    ? traceparent
    : undefined;
  return {
    ...(validTraceparent ? { traceparent: validTraceparent } : {}),
    ...(validTraceparent && tracestate ? { tracestate } : {}),
    ...(baggage ? { baggage } : {}),
  };
}

/**
 * Decode the spec's Base64 sentinel format (`=?base64?<data>?=`) used when a
 * header value cannot ride as plain ASCII. Non-sentinel values pass through.
 * A malformed sentinel returns null — the caller treats that as a mismatch,
 * which is what the spec's "invalid characters" rejection amounts to.
 */
export function decodeSentinelHeaderValue(value: string): string | null {
  if (!(value.startsWith('=?base64?') && value.endsWith('?='))) return value;
  const b64 = value.slice('=?base64?'.length, -'?='.length);
  try {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

function reject(code: number, message: string, data?: unknown): EraRejection {
  return { era: 'rejected', status: code === ERROR_UNSUPPORTED_PROTOCOL_VERSION ? 400 : 400, code, message, data };
}

/**
 * The one era chokepoint. Decides, for a parsed POST body plus its headers,
 * whether this request is legacy (initialize-negotiated semantics — leave it
 * alone), modern (2026-07-28 stateless semantics), or rejected with a spec
 * error. All header-vs-body validation for the modern era lives HERE so the
 * dispatch below it never re-checks anything.
 */
export function detectEra(headers: HeaderReader, body: ParsedRequestBody): EraDecision {
  const meta = metaOf(body);
  const metaVersionRaw = meta?.[META_PROTOCOL_VERSION];
  const metaVersion = typeof metaVersionRaw === 'string' ? metaVersionRaw : null;
  const headerVersion = headers.get('MCP-Protocol-Version');

  // The modern era is entered ONLY on the positive `_meta` protocolVersion
  // signal — the field that first exists in 2026-07-28. A request with no
  // such field is legacy, FULL STOP, whatever its MCP-Protocol-Version header
  // says. This is deliberate: keying era off the header would let an
  // unrecognized or future header value (a later initialize-based revision, a
  // proxy that rewrote the header) hard-reject a genuine handshake request
  // with a 400 — the exact "legacy silently breaks" failure the dual-era
  // design exists to prevent. A legacy client is never promoted by a header
  // we didn't foresee; it flows to the initialize path untouched.
  if (metaVersion === null) return { era: 'legacy' };

  // From here the request carries a modern protocolVersion in `_meta`, so the
  // modern validation rules apply in full. A modern client MUST also mirror
  // the version into the header (Streamable HTTP transport), so a missing or
  // mismatched header is a real protocol violation, not a legacy request.
  if (headerVersion === null) {
    return reject(
      ERROR_HEADER_MISMATCH,
      'Header mismatch: required MCP-Protocol-Version header is missing',
    );
  }
  if (headerVersion !== metaVersion) {
    return reject(
      ERROR_HEADER_MISMATCH,
      `Header mismatch: MCP-Protocol-Version header value '${headerVersion}' does not match body value '${metaVersion}'`,
    );
  }
  if (!(SUPPORTED_MODERN_VERSIONS as readonly string[]).includes(metaVersion)) {
    return reject(
      ERROR_UNSUPPORTED_PROTOCOL_VERSION,
      'Unsupported protocol version',
      { supported: [...SUPPORTED_MODERN_VERSIONS], requested: metaVersion },
    );
  }

  // Mcp-Method / Mcp-Name mirror validation. Required for compliance; a
  // mismatch means an intermediary routed on a different value than we would
  // execute — reject rather than pick a source of truth.
  const method = typeof body.method === 'string' ? body.method : '';
  const headerMethod = headers.get('Mcp-Method');
  if (headerMethod === null) {
    return reject(ERROR_HEADER_MISMATCH, 'Header mismatch: required Mcp-Method header is missing');
  }
  if (headerMethod !== method) {
    return reject(
      ERROR_HEADER_MISMATCH,
      `Header mismatch: Mcp-Method header value '${headerMethod}' does not match body method '${method}'`,
    );
  }
  if (method === 'tools/call' || method === 'resources/read' || method === 'prompts/get') {
    const bodyName = method === 'tools/call' || method === 'prompts/get'
      ? body.params?.['name']
      : body.params?.['uri'];
    const headerNameRaw = headers.get('Mcp-Name');
    if (headerNameRaw === null) {
      return reject(ERROR_HEADER_MISMATCH, `Header mismatch: required Mcp-Name header is missing for ${method}`);
    }
    const headerName = decodeSentinelHeaderValue(headerNameRaw);
    if (headerName === null || headerName !== (typeof bodyName === 'string' ? bodyName : '')) {
      return reject(
        ERROR_HEADER_MISMATCH,
        `Header mismatch: Mcp-Name header does not match the request body`,
      );
    }
  }

  const clientInfoRaw = meta?.[META_CLIENT_INFO];
  const capsRaw = meta?.[META_CLIENT_CAPABILITIES];
  return {
    era: 'modern',
    protocolVersion: metaVersion,
    clientInfo: clientInfoRaw && typeof clientInfoRaw === 'object' && !Array.isArray(clientInfoRaw)
      ? clientInfoRaw as { name?: string; version?: string }
      : null,
    clientCapabilities: capsRaw && typeof capsRaw === 'object' && !Array.isArray(capsRaw)
      ? capsRaw as Record<string, unknown>
      : {},
    traceContext: traceContextFromMeta(meta),
  };
}

/**
 * Modern result envelope: every 2026-07-28 result carries a required
 * `resultType` ("complete" unless the payload is an MRTR interim result that
 * already set "input_required") and SHOULD carry serverInfo in `_meta`.
 * Legacy results never pass through here.
 */
export function modernizeResult(payload: Record<string, unknown>): Record<string, unknown> {
  const existingMeta = payload['_meta'] && typeof payload['_meta'] === 'object'
    ? payload['_meta'] as Record<string, unknown>
    : {};
  return {
    ...payload,
    resultType: payload['resultType'] === 'input_required' ? 'input_required' : 'complete',
    _meta: { ...existingMeta, [META_SERVER_INFO]: SERVER_INFO },
  };
}

/** Cache hints for list-shaped results (CacheableResult). Tool schemas change
 *  on deploy, while `catalog({ load })` is evaluated live from the same
 *  registry. A positive client TTL would let the advertised callable schema
 *  lag behind that catalog after a deploy, so list results expire immediately.
 *  The scope remains private because visibility still varies by caller. */
export const LIST_CACHE_HINTS = { ttlMs: 0, cacheScope: 'private' } as const;

/** Discovery metadata contains no callable schemas, so it can retain the
 * longer private cache without creating a schema-freshness split. */
const DISCOVER_CACHE_HINTS = { ttlMs: 3_600_000, cacheScope: 'private' } as const;

/**
 * DiscoverResult for `server/discover` (a spec MUST). `instructions` is the
 * same surface-aware text the legacy initialize serves — one source of truth
 * for what an agent reads first.
 */
export function discoverResult(instructions: string): Record<string, unknown> {
  return modernizeResult({
    supportedVersions: [...SUPPORTED_MODERN_VERSIONS],
    capabilities: { tools: {} },
    instructions,
    ...DISCOVER_CACHE_HINTS,
  });
}

// ── MRTR: confirmation round-trips ──────────────────────────────────────────
//
// The legacy confirmation contract returns an error-shaped payload
// (CONFIRMATION_REQUIRED) that tells the agent to re-call with a code or
// confirm flag. Under 2026-07-28 that dance is a first-class
// InputRequiredResult carrying an elicitation request; the client answers and
// retries the SAME tool call with `inputResponses` + our `requestState`.
//
// requestState here is base64 JSON with NO integrity protection, which the
// MRTR spec explicitly permits when tampering can cause nothing worse than
// request failure: the values it carries (a 6-digit delete code, a purchase
// confirm token) are server-minted upstream, TTL'd, single-use, and bound to
// the project they were minted for — a tampered state yields an upstream
// rejection, never a different action.

export const MRTR_CONFIRMATION_KEY = 'confirmation';

/** Servers MUST NOT send inputRequests a client has not declared capability
 *  for. Elicitation declaration is the gate for every confirmation we emit. */
export function clientSupportsElicitation(caps: Record<string, unknown>): boolean {
  return caps['elicitation'] !== undefined && caps['elicitation'] !== null && caps['elicitation'] !== false;
}

export interface ConfirmationState {
  /** Tool this state was minted for; the retry must name the same tool. */
  tool: string;
  /** Arguments to merge into the retried call once the user accepts. */
  merge: Record<string, unknown>;
}

export function encodeRequestState(state: ConfirmationState): string {
  return btoa(JSON.stringify(state));
}

export function decodeRequestState(raw: unknown): ConfirmationState | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(atob(raw)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.tool !== 'string') return null;
    if (!obj.merge || typeof obj.merge !== 'object' || Array.isArray(obj.merge)) return null;
    return { tool: obj.tool, merge: obj.merge as Record<string, unknown> };
  } catch {
    return null;
  }
}

/** Build the InputRequiredResult for a yes/no confirmation. */
export function confirmationInputRequired(message: string, state: ConfirmationState): Record<string, unknown> {
  return modernizeResult({
    resultType: 'input_required',
    inputRequests: {
      [MRTR_CONFIRMATION_KEY]: {
        method: 'elicitation/create',
        params: {
          mode: 'form',
          message,
          requestedSchema: {
            type: 'object',
            properties: {
              confirm: { type: 'boolean', description: 'true to proceed, false to cancel' },
            },
            required: ['confirm'],
          },
        },
      },
    },
    requestState: encodeRequestState(state),
  });
}

export interface ConfirmationRetry {
  /** The user accepted; merge `state.merge` into the tool arguments. */
  accepted: boolean;
  state: ConfirmationState;
}

/**
 * Read a modern retry: params.inputResponses + params.requestState. Returns
 * null when this is not a confirmation retry (no state present). A malformed
 * or mismatched state also returns null — the call then runs as a fresh
 * request and, if confirmation is still required, the server simply asks
 * again (the spec's prescribed recovery).
 */
export function readConfirmationRetry(
  params: Record<string, unknown> | undefined,
  toolName: string,
): ConfirmationRetry | null {
  const state = decodeRequestState(params?.['requestState']);
  if (!state || state.tool !== toolName) return null;
  const responses = params?.['inputResponses'];
  if (!responses || typeof responses !== 'object' || Array.isArray(responses)) return null;
  const answer = (responses as Record<string, unknown>)[MRTR_CONFIRMATION_KEY];
  if (!answer || typeof answer !== 'object') return null;
  const elicit = answer as { action?: unknown; content?: unknown };
  const content = elicit.content && typeof elicit.content === 'object'
    ? elicit.content as Record<string, unknown>
    : {};
  return {
    accepted: elicit.action === 'accept' && content['confirm'] === true,
    state,
  };
}
