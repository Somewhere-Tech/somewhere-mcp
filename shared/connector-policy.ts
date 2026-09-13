/** Restrictions of the directory connector, shared by direct calls and code runs. */
export const CONNECTOR_RUNTIME_RESTRICTION = 'restriction:directory-connector';
export const CONNECTOR_OPERATION_UNAVAILABLE = 'CONNECTOR_OPERATION_UNAVAILABLE';

const MEDIA_PATHS = [
  '/v1/ai/generate-image', '/v1/ai/tts',
  '/v1/ai/remove-background',
];
const TRANSFER_PATHS = [
  '/v1/payments/capture', '/v1/payments/release', '/v1/payments/refund',
];

export function connectorOperationDenial(method: string, rawPath: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(rawPath.split('?', 1)[0]);
  } catch {
    return 'The API path contains invalid encoding.';
  }
  // Decode once only. Encoded separators or a second decoding pass must never
  // select a different route after the policy decision.
  if (path.includes('%') || path.includes('\\') || path.includes('..') || path.includes('//')) {
    return 'The API path is not canonical.';
  }
  const under = (prefix: string) => path === prefix || path.startsWith(prefix + '/');
  const writes = !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
  if (writes && MEDIA_PATHS.some(under)) return 'AI image, audio, and video generation is unavailable through this connector.';
  if (writes && TRANSFER_PATHS.some(under)) return 'Financial asset transfers are unavailable through this connector.';
  if (under('/v1/domains/buy')) return 'Domain purchases are completed in the dashboard.';
  // Generic API calls cannot mint another credential or invoke an unclassified
  // code runner to escape the connector boundary. run_code has its own entry.
  if (['/v1/keys', '/v1/oauth', '/v1/cli', '/v1/code', '/v1/code-egress', '/v1/admin', '/v1/internal', '/v1/sys'].some(under)) {
    return 'This endpoint is not available through generic connector API access.';
  }
  return null;
}
