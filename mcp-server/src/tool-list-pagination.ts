/** Cursor pagination for tools/list.
 *
 * Cursors are opaque to clients and bound to the ordered tool-name projection
 * that produced them. That prevents a cursor from one surface or group scope
 * from silently skipping tools on another.
 */

export const TOOL_LIST_PAGE_SIZE = 64;

interface NamedTool {
  name: string;
}

interface CursorPayload {
  v: 1;
  offset: number;
  projection: string;
}

export interface ToolListPage<T> {
  tools: T[];
  nextCursor?: string;
}

export class InvalidToolListCursorError extends Error {
  constructor() {
    super('Invalid tools/list cursor');
    this.name = 'InvalidToolListCursorError';
  }
}

function projectionFingerprint(tools: readonly NamedTool[]): string {
  // FNV-1a is sufficient here: this is a stale/scope guard, not a security
  // boundary. The cursor contains no authority and cannot reveal hidden tools.
  let hash = 0x811c9dc5;
  for (const tool of tools) {
    for (const char of `${tool.name}\0`) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function encodeCursor(payload: CursorPayload): string {
  return btoa(JSON.stringify(payload))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function decodeCursor(cursor: unknown): CursorPayload {
  if (typeof cursor !== 'string' || cursor.length === 0) {
    throw new InvalidToolListCursorError();
  }
  try {
    const base64 = cursor.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const parsed = JSON.parse(atob(padded)) as Partial<CursorPayload>;
    if (
      parsed.v !== 1
      || !Number.isSafeInteger(parsed.offset)
      || (parsed.offset ?? 0) <= 0
      || typeof parsed.projection !== 'string'
    ) {
      throw new InvalidToolListCursorError();
    }
    return parsed as CursorPayload;
  } catch (error) {
    if (error instanceof InvalidToolListCursorError) throw error;
    throw new InvalidToolListCursorError();
  }
}

/**
 * Preserve the historical one-shot response for pre-header legacy clients.
 * Modern requests and the Streamable HTTP legacy revisions page by default;
 * any client can opt in or continue by supplying a cursor field.
 */
export function shouldPaginateToolList(
  modern: boolean,
  protocolHeader: string | null,
  cursorSupplied: boolean,
): boolean {
  return modern
    || cursorSupplied
    || protocolHeader === '2025-06-18'
    || protocolHeader === '2025-11-25';
}

export function paginateToolList<T extends NamedTool>(
  tools: readonly T[],
  cursor: unknown,
  pageSize = TOOL_LIST_PAGE_SIZE,
): ToolListPage<T> {
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) {
    throw new RangeError('pageSize must be a positive integer');
  }

  const projection = projectionFingerprint(tools);
  let offset = 0;
  if (cursor !== undefined) {
    const decoded = decodeCursor(cursor);
    if (decoded.projection !== projection || decoded.offset >= tools.length) {
      throw new InvalidToolListCursorError();
    }
    offset = decoded.offset;
  }

  const pageTools = tools.slice(offset, offset + pageSize);
  const nextOffset = offset + pageTools.length;
  return {
    tools: pageTools,
    ...(nextOffset < tools.length
      ? { nextCursor: encodeCursor({ v: 1, offset: nextOffset, projection }) }
      : {}),
  };
}
