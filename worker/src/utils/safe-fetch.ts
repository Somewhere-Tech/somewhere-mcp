/**
 * Shared safe egress fetch — wraps every user-controlled outbound
 * call so SSRF/metadata exfil/DNS-rebinding can't reach private
 * infrastructure.
 *
 * Centralised here because we have at least 8 user-URL surfaces:
 *   - /v1/render (browser page.goto)
 *   - /v1/ai/transcribe (audio_url)
 *   - /v1/webhooks (project webhook delivery)
 *   - /v1/db/webhook (DB change webhooks)
 *   - /v1/inbox (inbox-message webhooks)
 *   - /v1/auth (auth webhooks)
 *   - /v1/jobs, /v1/queue, /v1/cron handlers + completion webhooks
 *
 * Each path used its own ad-hoc validator before. The audit
 * (2026-05-25) found that each was missing at least one of:
 *   - inet_aton-aware IPv4 parsing (so 2130706433 → 127.0.0.1 was
 *     never blocked)
 *   - DNS resolve + IP check (so attacker.example → 169.254.169.254
 *     slipped through)
 *   - redirect target revalidation
 *   - hard byte cap
 *   - hard timeout
 *   - IPv6 metadata / link-local / ULA blocks
 *
 * This module is the Worker's transport. The POLICY it applies —
 * hostname blocklist, URL rules, resolved-address classification, and the
 * customer-visible reason for every denial — lives in `utils/egress-policy.ts`,
 * because the job container (`containers/job-executor`) has to apply the same
 * one and a second copy is how tier 3 drifted into following redirects nobody
 * checked (tsk_f91e7d4a). Patch the policy there; patch the transport here.
 *
 * Callers MUST use `safeFetch()` instead of bare `fetch()` for any URL
 * that came in from a user, project setting, deploy file, or app-user
 * JWT body.
 *
 * Why one helper instead of per-surface:
 *   1. Easier to keep blocklists in sync across surfaces.
 *   2. One place to test against (worker/scripts/test-safe-fetch.mjs).
 *   3. When CF adds a new metadata IP we patch one file, not eight.
 */

import {
  DEFAULT_EGRESS_TIMEOUT_MS,
  DEFAULT_MAX_REDIRECTS,
  EgressPolicyError,
  assertSafeRemoteUrlWith,
  dnsQueryUrl,
  headersForCrossOriginHop,
  isSameOrigin,
  type DnsAnswer,
  type EgressPolicyOptions,
} from './egress-policy';

export { assertSafeUrl, isBlockedHost, EgressPolicyError as SafeFetchError } from './egress-policy';

const DEFAULT_TIMEOUT_MS = DEFAULT_EGRESS_TIMEOUT_MS;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

export interface SafeFetchOptions extends EgressPolicyOptions {
  /** Default 15s. */
  timeoutMs?: number;
  /** Default 3. Set to 0 to disable redirect following. */
  maxRedirects?: number;
  /** Default 25 MB. */
  maxBytes?: number;
  /** Headers + method + body forwarded to underlying fetch. */
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
}

interface DnsJsonResponse {
  Answer?: DnsAnswer[];
}

// Pin the REAL fetch at module load, before any per-request guard or customer
// module can replace globalThis.fetch. Generated runtime guards now restore the
// shared global in finally blocks, but safeFetch may still run while a guard is
// active and customer code is intentionally allowed to override its own global
// fetch. Platform safe-fetch does its own SSRF checks, so its DoH lookup and
// target request must stay on this out-of-band transport.
const SAFE_FETCH_REAL_FETCH: typeof fetch = globalThis.fetch.bind(globalThis);

async function fetchDnsAnswers(host: string, type: 'A' | 'AAAA', timeoutMs: number): Promise<DnsAnswer[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 3_000));
  try {
    const response = await SAFE_FETCH_REAL_FETCH(dnsQueryUrl(host, type), {
      headers: { Accept: 'application/dns-json' },
      // Workers do not implement redirect: 'error' (throws TypeError at the
      // edge). Use 'manual'; a DoH endpoint never redirects, and a 3xx would
      // fail the !response.ok check below anyway.
      redirect: 'manual',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new EgressPolicyError('SAFE_FETCH_DNS_FAILED', `Could not resolve host ${host}.`);
    }
    const body = await response.json<DnsJsonResponse>().catch(() => null);
    if (!body) throw new EgressPolicyError('SAFE_FETCH_DNS_FAILED', `Could not resolve host ${host}.`);
    return Array.isArray(body.Answer) ? body.Answer : [];
  } catch (err) {
    if (err instanceof EgressPolicyError) throw err;
    throw new EgressPolicyError('SAFE_FETCH_DNS_FAILED', `Could not resolve host ${host}.`);
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve A and AAAA through DNS-over-HTTPS. The container tier resolves the
 * same names through the same endpoint (see containers/job-executor). */
async function resolveDnsAnswers(host: string, timeoutMs: number): Promise<DnsAnswer[]> {
  return (await Promise.all([
    fetchDnsAnswers(host, 'A', timeoutMs),
    fetchDnsAnswers(host, 'AAAA', timeoutMs),
  ])).flat();
}

/** Validate both the URL syntax/literal host and its current A/AAAA answers.
 * Use this when a downstream provider will fetch the URL on our behalf. */
export async function assertSafeRemoteUrl(rawUrl: string, opts: SafeFetchOptions = {}): Promise<URL> {
  return assertSafeRemoteUrlWith(rawUrl, resolveDnsAnswers, opts);
}

/**
 * Fetch with manual redirect handling so we revalidate every hop.
 * Returns a Response whose body is bounded to maxBytes; bodies that
 * exceed the cap throw SAFE_FETCH_BODY_TOO_LARGE during read.
 *
 * Before the target request, resolve A and AAAA records through DNS-over-
 * HTTPS and reject the hostname if any answer is non-public. Repeat that
 * check for every redirect target. Literal-host validation still runs
 * first so obvious numeric loopback, metadata, and IPv6 ULA attempts are
 * rejected without contacting the target.
 *
 * WHAT CROSSES AN ORIGIN CHANGE (tsk_17632cb8)
 * --------------------------------------------
 * The address check answers "may we connect there". It does not answer "may
 * that party read what we were carrying". Every hop used to re-send the caller's
 * headers and body verbatim, so a handler that answered `302 -> some third
 * party` handed that party the platform's signed invocation envelope — a
 * credential replayable for its whole validity window — plus any Authorization
 * or Cookie and the request body.
 *
 * So, on a hop whose ORIGIN differs from the original request's:
 *   - the invocation envelope, every other `X-Somewhere-*` header, and
 *     Authorization / Proxy-Authorization / Cookie are dropped
 *     (`headersForCrossOriginHop` in utils/egress-policy.ts owns the list, so
 *      the job container drops exactly the same set);
 *   - the body is not re-sent, and Content-Type / Content-Length go with it.
 *
 * The METHOD is deliberately NOT downgraded on 301/302/303 the way a browser
 * downgrades it — see the redirect method rule in utils/egress-policy.ts: the
 * downgrade is what laundered 8,164 never-run jobs into successes
 * (tsk_baf2d1df), and dropping the body outright already gives us the
 * protection the browser rule exists for.
 *
 * Once a chain has left the original origin it never regains the envelope, even
 * if a later hop points back: by then the `Location` chain has been chosen by a
 * third party, and the path it names is not the path the signature covers.
 * A SAME-ORIGIN hop is unchanged — same headers, same method, same body — which
 * is what keeps the tsk_baf2d1df dead-handler case failing instead of being
 * laundered into a success.
 */
export async function safeFetch(
  rawUrl: string,
  opts: SafeFetchOptions = {},
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  let currentUrl = (await assertSafeRemoteUrl(rawUrl, opts)).toString();
  const originalUrl = currentUrl;
  const method = opts.method ?? 'GET';
  let headers = new Headers(opts.headers);
  let body = opts.body ?? null;
  // Sticky: set the first time a hop changes origin and never cleared.
  let leftOriginalOrigin = false;
  let redirects = 0;

  while (true) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let resp: Response;
    try {
      resp = await SAFE_FETCH_REAL_FETCH(currentUrl, {
        method,
        headers,
        body,
        redirect: 'manual',
        signal: ctrl.signal,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new EgressPolicyError('SAFE_FETCH_TIMEOUT', `Timed out after ${timeoutMs}ms.`);
      }
      throw new EgressPolicyError('SAFE_FETCH_NETWORK', (err as Error).message);
    } finally {
      clearTimeout(timer);
    }

    if (resp.status >= 300 && resp.status < 400 && resp.headers.get('location')) {
      if (redirects >= maxRedirects) {
        throw new EgressPolicyError('SAFE_FETCH_TOO_MANY_REDIRECTS', `Exceeded ${maxRedirects} redirects.`);
      }
      const next = new URL(resp.headers.get('location') as string, currentUrl);
      const validated = (await assertSafeRemoteUrl(next.toString(), opts)).toString();
      if (!isSameOrigin(originalUrl, validated)) leftOriginalOrigin = true;
      if (leftOriginalOrigin) {
        headers = new Headers(headersForCrossOriginHop(headers));
        body = null;
      }
      currentUrl = validated;
      redirects++;
      continue;
    }

    const contentLength = parseInt(resp.headers.get('content-length') || '0', 10);
    if (contentLength > 0 && contentLength > maxBytes) {
      throw new EgressPolicyError(
        'SAFE_FETCH_BODY_TOO_LARGE',
        `Response declared ${contentLength} bytes, cap is ${maxBytes}.`,
      );
    }

    // Wrap the body in a ReadableStream that aborts once we read past
    // maxBytes. This is the only enforcement that works when the
    // server omits Content-Length (chunked transfer).
    if (resp.body) {
      const reader = resp.body.getReader();
      let received = 0;
      const stream = new ReadableStream({
        async pull(controller) {
          const { done, value } = await reader.read();
          if (done) { controller.close(); return; }
          received += value.byteLength;
          if (received > maxBytes) {
            controller.error(new EgressPolicyError(
              'SAFE_FETCH_BODY_TOO_LARGE',
              `Response exceeded ${maxBytes} bytes.`,
            ));
            return;
          }
          controller.enqueue(value);
        },
      });
      return new Response(stream, {
        status: resp.status,
        headers: resp.headers,
      });
    }

    return resp;
  }
}
