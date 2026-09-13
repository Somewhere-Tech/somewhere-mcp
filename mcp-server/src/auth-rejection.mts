export type CallerApiKeyRejectionCode = 'API_KEY_EXPIRED' | 'INVALID_API_KEY';
export type UpstreamAuthRejectionKind = 'oauth' | 'api_key';

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

/** Only the two auth-layer codes that identify the caller's own smt_ bearer.
 *  AUTH_INVALID_CREDS and other 401s belong to app-user credentials supplied
 *  as tool arguments and must remain ordinary tool results. */
export function callerApiKeyRejectionCode(payload: unknown): CallerApiKeyRejectionCode | null {
  const code = canonicalErrorCode(payload);
  return code === 'API_KEY_EXPIRED' || code === 'INVALID_API_KEY' ? code : null;
}

export function upstreamAuthRejectedResponse(options: {
  id: string | number | null;
  kind: UpstreamAuthRejectionKind;
  code?: CallerApiKeyRejectionCode;
  resourceMetadataUrl: string;
}): Response {
  const message = options.kind === 'oauth'
    ? 'OAuth token expired or invalid — please refresh.'
    : options.code === 'API_KEY_EXPIRED'
      ? 'API key expired — refresh the session and retry.'
      : 'API key invalid or revoked — re-authenticate and retry.';
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: options.id,
      error: { code: -32000, message },
    }),
    {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'WWW-Authenticate': `Bearer realm="somewhere.tech", error="invalid_token", resource_metadata="${options.resourceMetadataUrl}"`,
      },
    },
  );
}
