import { defineDomainToolSpecs, type ToolExecutionRuntime, type ToolUpstreamResult } from '../types';
import { connectorOperationDenial, CONNECTOR_OPERATION_UNAVAILABLE } from '../../../../shared/connector-policy';

type PathValidator = (path: unknown) => { ok: true; path: string } | { ok: false; error: string };
const readMethods = ['GET', 'HEAD'] as const;
const writeMethods = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

export function connectorApiToolSpecs(validatePath: PathValidator) {
  async function execute(runtime: ToolExecutionRuntime, args: Record<string, unknown>, allowed: readonly string[]): Promise<ToolUpstreamResult> {
    const fail = (message: string, code = 'INVALID_ARGUMENTS', status = 400): ToolUpstreamResult => ({ status, data: { ok: false, error: code, message } });
    if (!Array.isArray(args.calls) || args.calls.length === 0 || args.calls.length > 10) return fail('calls must contain 1–10 independent requests.');
    const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
    // Validate the entire batch before executing any item.
    for (const item of args.calls) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return fail('Every call must be an object.');
      const call = item as Record<string, unknown>;
      if (typeof call.method !== 'string' || !allowed.includes(call.method)) return fail(`method must be one of ${allowed.join(', ')}.`);
      const path = validatePath(call.path);
      if (!path.ok) return fail(path.error);
      if (call.body !== undefined && (!call.body || typeof call.body !== 'object' || Array.isArray(call.body))) return fail('body must be a JSON object.');
      if (allowed === readMethods && call.body !== undefined) return fail('Read requests do not accept a body.');
      const denial = connectorOperationDenial(call.method, path.path);
      if (denial) return fail(denial, CONNECTOR_OPERATION_UNAVAILABLE, 403);
      calls.push({ method: call.method, path: path.path, ...(call.body === undefined ? {} : { body: call.body as Record<string, unknown> }) });
    }
    const results = await Promise.all(calls.map(async call => {
      try {
        return await runtime.callApi(call.method, call.path, call.body);
      } catch {
        return { status: 502, data: {
          ok: false, error: 'REQUEST_OUTCOME_UNKNOWN',
          message: 'No response was received for this request. A write may have completed; inspect its state before retrying.',
        } };
      }
    }));
    let remainingBytes = 256 * 1024;
    const bounded = results.map(result => {
      const bytes = new TextEncoder().encode(JSON.stringify(result.data)).byteLength;
      if (bytes <= remainingBytes) {
        remainingBytes -= bytes;
        return result;
      }
      return { status: result.status, data: {
        omitted: true, response_bytes: bytes,
        message: 'Response content exceeds the batch output budget. The HTTP status above is the operation result; do not repeat a successful write. Retrieve fewer fields or a smaller page with a read request.',
      } };
    });
    return { status: 200, data: { ok: results.every(result => result.status < 400), results: bounded } };
  }
  return defineDomainToolSpecs([
    {
      definition: {
        name: 'api_read',
        description: 'Read Somewhere platform API endpoints in a batch of up to 10 independent GET/HEAD requests. Paths and response shapes follow the Somewhere REST API reference: https://somewhere.tech/docs.txt. Returns one result per request in input order. No write methods or request bodies are accepted.',
        inputSchema: { type: 'object', properties: { calls: { type: 'array', maxItems: 10, items: { type: 'object', properties: { method: { type: 'string', enum: ['GET', 'HEAD'] }, path: { type: 'string', description: 'Platform /v1/ path, optionally including query parameters.' } }, required: ['method', 'path'] } } }, required: ['calls'] },
      },
      annotations: { title: 'Read platform API data', readOnlyHint: true, idempotentHint: true },
      group: 'api', core: false, visibility: 'authenticated', paid: false,
      surfaces: ['full', 'connector'],
      execute: (runtime, args) => execute(runtime, args, readMethods),
    },
    {
      definition: {
        name: 'api_write',
        description: 'Create, update, or delete platform data through up to 10 independent POST/PUT/PATCH/DELETE requests. Requests are not a transaction; some may succeed when others fail. Paths and request bodies follow the Somewhere REST API reference: https://somewhere.tech/docs.txt. AI media generation, financial transfers, credential creation, and domain purchases are unavailable.',
        inputSchema: { type: 'object', properties: { calls: { type: 'array', maxItems: 10, items: { type: 'object', properties: { method: { type: 'string', enum: ['POST', 'PUT', 'PATCH', 'DELETE'] }, path: { type: 'string', description: 'Platform /v1/ path, optionally including query parameters.' }, body: { type: 'object', additionalProperties: true } }, required: ['method', 'path'] } } }, required: ['calls'] },
      },
      annotations: { title: 'Change platform API data', readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      group: 'api', core: false, visibility: 'authenticated', paid: false,
      surfaces: ['full', 'connector'],
      execute: (runtime, args) => execute(runtime, args, writeMethods),
    },
  ] as const);
}
