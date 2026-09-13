/**
 * egress-policy — THE outbound-address policy. One implementation, two
 * runtimes.
 *
 * Everything in this file is pure: URL syntax rules, the hostname blocklist,
 * the IANA special-purpose range classification of a resolved address, and the
 * customer-visible reason each denial produces. It has no transport of its own,
 * so it can run unchanged in the Worker (via `utils/safe-fetch.ts`) and inside
 * a Cloudflare Container (via the generated `egress-policy.cjs` that
 * `worker/scripts/build-container-egress-policy.mjs` bundles from this exact
 * file).
 *
 * WHY IT EXISTS (tsk_f91e7d4a)
 * ---------------------------
 * The jobs escalation chain has three tiers. Tiers 1 and 2 run in the Worker
 * and fetch the customer's handler through `safeFetch`, which re-validated
 * every redirect hop. Tier 3 runs in `containers/job-executor` and fetched the
 * handler with plain Node `fetch`; after tsk_baf2d1df it followed up to 3 hops
 * itself, still with no address check on any hop. So the platform's answer to
 * "can this job reach the metadata endpoint" depended on which tier ran: a
 * handler that 302'd to 169.254.169.254 was refused on tiers 1 and 2 and
 * followed on tier 3, and reaching tier 3 only takes a handler that hangs.
 *
 * The fix is not a second copy of the blocklist in the container — that is the
 * drift that produced the hole. The container consumes a build of THIS file,
 * and `containers/job-executor/egress-policy.test.mjs` fails if the committed
 * build is not byte-identical to a fresh one.
 *
 * WHAT IS DELIBERATELY NOT HERE
 * -----------------------------
 * The platform's own control-plane hosts (api.somewhere.tech and the project
 * subdomains) are NOT denied, because they are not denied on tiers 1 and 2
 * either: a customer handler URL normally IS a platform host
 * (`https://<project>.somewhere.site/api/...`), so denying them would refuse
 * nearly every legitimate job. Tier parity — not a new denial — is the goal
 * (rule 9). The container fixture pins that both tiers allow them identically.
 */

import { classifyAddressForFetch, isIpLiteral } from './ip-address';

export const DEFAULT_EGRESS_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_REDIRECTS = 3;

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
  'instance-data',
  'instance-data.ec2.internal',
]);

const BLOCKED_HOSTNAME_SUFFIXES = ['.localhost', '.local', '.internal'];

/** Error thrown by every policy denial. `code` is the stable identifier that
 * routes and workflows branch on; `message` is what the customer reads. */
export class EgressPolicyError extends Error {
  code: string;
  status?: number;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface EgressPolicyOptions {
  /** Allowed protocols. Default ['https:']. */
  allowedProtocols?: string[];
  /** Optional allowlist of literal hostnames. When set, only these pass. */
  allowedHostnames?: string[];
  /** Budget for the address resolution step. Default 15s. */
  timeoutMs?: number;
}

/**
 * True when a hostname (or IP literal in any inet_aton/IPv6 form) must never
 * be an egress target. Shared by safeFetch, the handler-URL validator
 * (utils/handler-url.ts) and the job container, so the blocklist exists
 * exactly once.
 */
export function isBlockedHost(host: string): boolean {
  // Strip the DNS root label before comparing. `https://localhost./` parses to
  // the hostname `localhost.`, which is neither in the set nor a match for any
  // suffix, so the dotted form of every blocked NAME used to walk past this
  // check — and `utils/handler-url.ts` runs this check with no resolution step
  // behind it, so a cron could be CREATED pointing at `https://localhost./`
  // (tsk_8cbbcf3e, found adversarially while closing tsk_f91e7d4a). WHATWG URL
  // already normalizes the dot away for IPv4 literals, so only names were
  // affected. An empty host after the strip fails closed.
  const lowered = host.toLowerCase().replace(/\.$/, '');
  if (!lowered) return true;
  if (BLOCKED_HOSTNAMES.has(lowered)) return true;
  for (const suffix of BLOCKED_HOSTNAME_SUFFIXES) {
    if (lowered.endsWith(suffix)) return true;
  }
  const address = classifyAddressForFetch(lowered);
  if (address && !address.globallyReachable) return true;
  if (lowered.includes(':')) {
    // A hostname containing ':' can only be an IPv6 literal. Fail closed if
    // it did not parse as one.
    if (!address) return true;
  }
  return false;
}

/**
 * Validate a single URL against the SSRF policy. Throws EgressPolicyError
 * on rejection, returns the parsed URL on accept.
 */
export function assertSafeUrl(rawUrl: string, opts: EgressPolicyOptions = {}): URL {
  const allowedProtocols = opts.allowedProtocols ?? ['https:'];
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new EgressPolicyError('SAFE_FETCH_BAD_URL', `Not a valid URL: ${rawUrl}`);
  }
  if (!allowedProtocols.includes(url.protocol)) {
    throw new EgressPolicyError(
      'SAFE_FETCH_PROTOCOL_BLOCKED',
      `Protocol ${url.protocol} not allowed (need ${allowedProtocols.join(' or ')}).`,
    );
  }
  if (url.username || url.password) {
    throw new EgressPolicyError('SAFE_FETCH_CREDENTIALS', 'URL must not include user:pass credentials.');
  }
  if (!url.hostname) {
    throw new EgressPolicyError('SAFE_FETCH_BAD_URL', 'URL is missing a hostname.');
  }
  if (opts.allowedHostnames && opts.allowedHostnames.length > 0) {
    if (!opts.allowedHostnames.includes(url.hostname.toLowerCase())) {
      throw new EgressPolicyError(
        'SAFE_FETCH_HOST_NOT_ALLOWED',
        `Host ${url.hostname} is not in the allow-list.`,
      );
    }
  }
  if (isBlockedHost(url.hostname)) {
    throw new EgressPolicyError(
      'SAFE_FETCH_HOST_BLOCKED',
      `Host ${url.hostname} is in a blocked range (loopback, private, link-local, metadata, or rfc).`,
    );
  }
  if (url.port && url.port !== '443' && url.port !== '80') {
    const port = parseInt(url.port, 10);
    if (!Number.isFinite(port) || port < 1024) {
      throw new EgressPolicyError(
        'SAFE_FETCH_PORT_BLOCKED',
        `Port ${url.port} not allowed (must be 80/443 or >=1024).`,
      );
    }
  }
  return url;
}

/** One DNS answer in the DNS-JSON shape (RFC 8427): type 1 = A, 28 = AAAA. */
export interface DnsAnswer {
  type?: number;
  data?: string;
}

/** The DNS-over-HTTPS query URL both runtimes use. Same resolver, same
 * answers, so the two tiers cannot disagree about where a host points. */
export function dnsQueryUrl(host: string, type: 'A' | 'AAAA'): string {
  return `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`;
}

/**
 * Reject if ANY returned address is non-public, or if nothing resolved.
 * Pure — the caller supplies the answers, from DoH or from a system resolver.
 */
export function assertPublicDnsAnswers(host: string, answers: readonly DnsAnswer[]): void {
  let addressCount = 0;
  for (const answer of answers) {
    if ((answer.type !== 1 && answer.type !== 28) || typeof answer.data !== 'string') continue;
    const address = classifyAddressForFetch(answer.data.trim());
    if (!address || (answer.type === 1 && address.version !== 4) || (answer.type === 28 && address.version !== 6)) {
      throw new EgressPolicyError('SAFE_FETCH_DNS_FAILED', `Host ${host} returned an invalid IP address.`);
    }
    addressCount++;
    if (!address.globallyReachable) {
      throw new EgressPolicyError(
        'SAFE_FETCH_DNS_BLOCKED',
        `Host ${host} resolves to a blocked private, link-local, loopback, or metadata address.`,
      );
    }
  }
  if (addressCount === 0) {
    throw new EgressPolicyError('SAFE_FETCH_DNS_FAILED', `Could not resolve host ${host} to a public address.`);
  }
}

/** Resolves a hostname to DNS-JSON answers. Injected because the Worker
 * reaches the resolver over `fetch` and the container may fall back to its
 * own stub resolver; the POLICY applied to the answers is the same either way. */
export type DnsAnswerResolver = (host: string, timeoutMs: number) => Promise<DnsAnswer[]>;

/**
 * Validate the URL syntax/literal host AND the addresses the hostname
 * currently resolves to. Call this before EVERY request and before EVERY
 * redirect hop: re-resolving each hop is what makes a host that flips from a
 * public address to a private one between hops fail rather than connect.
 */
export async function assertSafeRemoteUrlWith(
  rawUrl: string,
  resolve: DnsAnswerResolver,
  opts: EgressPolicyOptions = {},
): Promise<URL> {
  const url = assertSafeUrl(rawUrl, opts);
  // Literal IPs were already classified by assertSafeUrl and skip the lookup.
  if (!isIpLiteral(url.hostname)) {
    const answers = await resolve(url.hostname, opts.timeoutMs ?? DEFAULT_EGRESS_TIMEOUT_MS);
    assertPublicDnsAnswers(url.hostname, answers);
  }
  return url;
}

/** Customer-visible reason when a job handler's redirect target is refused.
 * Product language, no infrastructure terms — the customer needs to know their
 * handler bounced somewhere the platform will not follow, and why. */
export function handlerRedirectDeniedMessage(reason: string): string {
  return `The handler redirected to an address this platform does not allow: ${reason}`;
}

/* ─────────────────────────────────────────────────────────────────────────
 * THE INVOCATION ENVELOPE, AND WHAT SURVIVES AN ORIGIN CHANGE (tsk_17632cb8)
 * ────────────────────────────────────────────────────────────────────────*/

/**
 * The headers the PLATFORM adds when it invokes a customer handler for a job,
 * a cron run, a queue message, or an agent turn. Together they are a signed,
 * replayable credential for that project: the signature authenticates the
 * whole set for its five-minute validity window, and `/v1/jobs/verify-invocation`
 * accepts it from whoever presents it.
 *
 * They are therefore bound to the address they were minted for. When a handler
 * answers with a redirect to a DIFFERENT origin, that origin is not the party
 * the envelope was addressed to — it is whoever happens to control the host in
 * the `Location` header. A handler host that has been taken over, or any host
 * that can serve one 302, used to receive the project's live invocation
 * signature. Browsers strip `Authorization` across an origin change for exactly
 * this reason; we stripped nothing.
 *
 * The list lives HERE, not at the dispatch sites, so the Worker transport
 * (`utils/safe-fetch.ts`) and the job container (`containers/job-executor`,
 * which consumes a build of this file) drop the same set. A new envelope
 * header added at a dispatch site is covered even if nobody updates this list,
 * because `isOriginBoundRequestHeader` also matches the whole
 * `X-Somewhere-*` prefix; the enumeration is what the fixtures assert against.
 */
export const PLATFORM_INVOCATION_ENVELOPE_HEADERS: readonly string[] = [
  'x-somewhere-signature',
  'x-somewhere-body-sha256',
  'x-somewhere-invocation-timestamp',
  'x-somewhere-invocation-source',
  'x-somewhere-source',
  'x-somewhere-job-id',
  'x-somewhere-message-id',
  'x-somewhere-project-id',
  'x-somewhere-tier',
  'x-somewhere-agent-invocation',
  'x-somewhere-agent-turn',
];

/** Every platform-added request header starts with this. Prefix-matched so an
 * envelope header introduced later cannot leak just because the enumeration
 * above went stale. */
export const PLATFORM_REQUEST_HEADER_PREFIX = 'x-somewhere-';

/** Generic credentials that are equally bound to the origin they were sent to.
 * Same rule browsers apply on a cross-origin redirect. */
export const CREDENTIAL_REQUEST_HEADERS: readonly string[] = [
  'authorization',
  'proxy-authorization',
  'cookie',
];

/** Headers that only describe a body. Dropped alongside the body itself when a
 * hop changes origin, so the next request does not announce content it is not
 * sending. */
const ENTITY_REQUEST_HEADERS: readonly string[] = ['content-type', 'content-length'];

/** True when this request header must not survive a redirect that changes
 * origin: the signed invocation envelope, anything else the platform adds, or
 * a generic credential. */
export function isOriginBoundRequestHeader(name: string): boolean {
  const lowered = name.trim().toLowerCase();
  if (lowered.startsWith(PLATFORM_REQUEST_HEADER_PREFIX)) return true;
  return CREDENTIAL_REQUEST_HEADERS.includes(lowered);
}

/**
 * The header set to send on a redirect hop that changes origin: everything
 * except the origin-bound headers above and the entity headers describing the
 * body, which is not re-sent either.
 *
 * Pure and shape-free — takes and returns name/value pairs — so the Worker can
 * feed it a `Headers` iterator and the container a plain object's entries.
 */
export function headersForCrossOriginHop(
  entries: Iterable<readonly [string, string]>,
): [string, string][] {
  const kept: [string, string][] = [];
  for (const [name, value] of entries) {
    const lowered = name.trim().toLowerCase();
    if (isOriginBoundRequestHeader(lowered)) continue;
    if (ENTITY_REQUEST_HEADERS.includes(lowered)) continue;
    kept.push([name, value]);
  }
  return kept;
}

/** Same scheme, host and port. `URL.origin` normalizes the default port, so
 * `https://a.example` and `https://a.example:443` are one origin and
 * `https://a.example:8443` is not. A different scheme is a different origin
 * even on the same host. */
export function isSameOrigin(a: string | URL, b: string | URL): boolean {
  try {
    const left = a instanceof URL ? a : new URL(a);
    const right = b instanceof URL ? b : new URL(b);
    // Opaque origins ("null") must never compare equal to each other.
    if (left.origin === 'null' || right.origin === 'null') return false;
    return left.origin === right.origin;
  } catch {
    return false;
  }
}

/**
 * THE REDIRECT METHOD RULE — and why it is not the browser's.
 *
 * A browser turns 301/302/303 into a GET and keeps the method on 307/308. We
 * keep the ORIGINAL METHOD on every hop, same-origin or not, and the reason is
 * a production incident on each side of the trade:
 *
 *  - Downgrading to GET is what laundered a failed job into a successful one
 *    (tsk_baf2d1df). A handler behind an auth gateway answers the POST with a
 *    302 to a sign-in page ON A DIFFERENT HOST. That page answers GET with 200
 *    HTML and POST with 404. Tiers 1 and 2 re-POSTed and correctly recorded a
 *    failure; the container downgraded to GET, got the 200 interstitial, and
 *    8,164 jobs that never ran were recorded complete. The gateway is
 *    cross-origin, so scoping method preservation to same-origin hops would
 *    hand that bug straight back — `scripts/test-job-permanent-handler-answer.mjs`
 *    pins it.
 *
 *  - The reason browsers downgrade is to avoid re-submitting a payload to an
 *    endpoint the user never aimed at. We get that protection a different and
 *    stricter way: on a hop that changes origin the body is not re-sent AT ALL,
 *    on any status code (see `headersForCrossOriginHop`, which drops the entity
 *    headers with it). A cross-origin hop is therefore a bodyless, envelope-less,
 *    credential-less request in the original method — nothing of the invocation
 *    crosses the boundary, and nothing that never ran can look like it did.
 */
