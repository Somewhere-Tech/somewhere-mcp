import { dumpSha256, parseDumpCapture } from '../../shared/database-dump-capture';
import { validateExportedPolicies, type ExportedTableAccessPolicy } from '../../worker/src/utils/db-dump-policy';
import type { ToolUpstreamResult } from './tool-registry/types';

function countHeader(response: Response, name: string): number {
  const text = response.headers.get(name) ?? '0';
  if (!/^(0|[1-9]\d*)$/.test(text) || !Number.isSafeInteger(Number(text))) throw new Error('Invalid dump count');
  return Number(text);
}

function policyLabels(sql: string, count: number): { policies: ExportedTableAccessPolicy[]; warning?: string } {
  // Restrict parsing to the generated preamble. Saved SQL/string contents may
  // themselves contain comment-looking lines and must not become declarations.
  const preamble = sql.split('\nPRAGMA foreign_keys = OFF;\nBEGIN TRANSACTION;\n', 1)[0];
  const start = '-- somewhere.tech table-access-policy export v1 (informational; not applied by SQL restore)\n';
  const end = '-- end somewhere.tech table-access-policy export v1';
  if (count === 0) {
    if (preamble.includes(start)) throw new Error('Missing dump policy count');
    return { policies: [] };
  }
  const startAt = preamble.indexOf(start), endAt = preamble.indexOf(end, startAt + start.length);
  if (startAt < 0 || endAt < 0) throw new Error('Missing dump policy');
  const rows = preamble.slice(startAt + start.length, endAt).trimEnd().split('\n').map(line => {
    if (!line.startsWith('-- policy: ')) throw new Error('Invalid dump policy');
    const value: unknown = JSON.parse(line.slice('-- policy: '.length));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid dump policy');
    const row = value as Record<string, unknown>;
    const keys = ['version', 'table', 'intent', 'owner_column', 'sensitive_columns'];
    if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))
      || row.version !== 1 || !Array.isArray(row.sensitive_columns)) throw new Error('Invalid dump policy');
    return { table_name: row.table, owner_column: row.owner_column === null && row.intent !== 'scoped' ? '' : row.owner_column,
      sensitive_columns: JSON.stringify(row.sensitive_columns), intent: row.intent };
  });
  const policies = validateExportedPolicies(rows);
  if (policies.length !== count) throw new Error('Incomplete dump policy');
  const warning = preamble.match(/^-- (WARNING: Restoring this SQL[^\n]+)$/m)?.[1];
  if (!warning) throw new Error('Missing dump warning');
  return { policies, warning };
}

/** Older API deployments have no capture header. Preserve their original
 * response shape without inventing integrity evidence during rolling release. */
export async function databaseDumpResult(response: Response, projectRef: unknown): Promise<ToolUpstreamResult> {
  const body = await response.text();
  if (!(response.headers.get('Content-Type') ?? '').includes('application/sql')) {
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { parsed = { ok: false, error: 'UPSTREAM_ERROR', message: body.slice(0, 500) }; }
    return { status: response.status, data: parsed };
  }
  try {
    if (!response.ok) throw new Error('Unsuccessful dump');
    const count = countHeader(response, 'X-Security-Policy-Count');
    const { policies, warning } = policyLabels(body, count);
    const header = response.headers.get('X-Dump-Capture');
    if (header !== null && header.length > 2048) throw new Error('Invalid dump capture');
    const capture = header === null ? null : parseDumpCapture(JSON.parse(header));
    if (capture && (capture.sql_sha256 !== await dumpSha256(body)
      || capture.policy_sha256 !== await dumpSha256(JSON.stringify(policies)))) throw new Error('Dump integrity mismatch');
    const truncated = response.headers.get('X-Truncated-Tables');
    return { status: response.status, data: { ok: true, data: {
      project_id: projectRef, sql: body,
      tables: countHeader(response, 'X-Tables'), rows: countHeader(response, 'X-Rows'),
      ...(truncated ? { truncated_tables: truncated.split(',') } : {}),
      ...(warning ? { warning } : {}),
      ...(count > 0 || capture ? { excluded_security_policy: {
        version: 1, count, policies, ...(capture ? { capture } : {}),
      } } : {}),
    } } };
  } catch {
    return { status: 502, data: { ok: false, error: 'DUMP_INTEGRITY_UNCONFIRMED',
      message: 'Database export integrity could not be confirmed. No SQL download was returned.' } };
  }
}
