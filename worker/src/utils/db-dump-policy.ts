export type ExportedTableAccessIntent = 'scoped' | 'shared' | 'server_only' | 'member' | 'policy';

export interface TableAccessPolicyRow {
  table_name: string;
  owner_column: string | null;
  sensitive_columns: string | null;
  intent: string | null;
}

export interface ExportedTableAccessPolicy {
  version: 1;
  table: string;
  intent: ExportedTableAccessIntent;
  owner_column: string | null;
  sensitive_columns: string[];
}

export interface DatabasePolicyExportWarning {
  warning: string;
  policies: ExportedTableAccessPolicy[];
  sqlLines: string[];
}

const EXPORTED_INTENTS = new Set<ExportedTableAccessIntent>([
  'scoped',
  'shared',
  'server_only',
  'member',
]);

export class DumpPolicyValidationError extends Error {
  readonly code = 'DUMP_POLICY_INVALID';
  readonly status = 422;
  constructor() {
    super('Table access declarations could not be exported completely. No SQL download was produced.');
  }
}

const SAFE_IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
function identifier(value: unknown): value is string {
  return typeof value === 'string' && SAFE_IDENT.test(value);
}
function invalid(): never { throw new DumpPolicyValidationError(); }

/** Validate all stored declarations before emitting any of them. No inferred
 * declaration is added for a table absent from these rows. */
export function validateExportedPolicies(rows: unknown): ExportedTableAccessPolicy[] {
  if (!Array.isArray(rows)) invalid();
  const tables = new Set<string>();
  return rows.map((value: unknown): ExportedTableAccessPolicy => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
    const row = value as Record<string, unknown>;
    if (!identifier(row.table_name) || tables.has(row.table_name.toLowerCase())) invalid();
    tables.add(row.table_name.toLowerCase());
    if (typeof row.intent !== 'string' || !EXPORTED_INTENTS.has(row.intent as ExportedTableAccessIntent)) invalid();
    const intent = row.intent as ExportedTableAccessIntent;
    // The scope writer deliberately stores '' for non-owner declarations.
    // Retain the established export representation of that valid sentinel.
    if (!identifier(row.owner_column) && !(row.owner_column === '' && intent !== 'scoped')) invalid();
    if (typeof row.sensitive_columns !== 'string') invalid();
    let sensitive: unknown;
    try { sensitive = JSON.parse(row.sensitive_columns); } catch { invalid(); }
    if (!Array.isArray(sensitive) || !sensitive.every(identifier)
      || new Set(sensitive.map(column => column.toLowerCase())).size !== sensitive.length) invalid();
    return {
      version: 1,
      table: row.table_name,
      intent,
      owner_column: row.owner_column === '' ? null : row.owner_column as string,
      sensitive_columns: [...sensitive],
    };
  });
}

function describePolicy(policy: ExportedTableAccessPolicy): string {
  const access = policy.intent === 'scoped'
    ? `scoped by ${policy.owner_column || 'an unspecified owner column'}`
    : policy.intent.replace('_', '-');
  const sensitive = policy.sensitive_columns.length > 0
    ? `; sensitive columns: ${policy.sensitive_columns.join(', ')}`
    : '';
  return `${policy.table} (${access}${sensitive})`;
}

/**
 * A SQL database restore can recreate schema and rows, but it cannot apply the
 * platform's table-access declarations. Keep valid declarations portable and self-describing; refuse malformed
 * declarations rather than silently producing an incomplete warning.
 */
export function databasePolicyExportWarning(
  rows: TableAccessPolicyRow[],
): DatabasePolicyExportWarning | null {
  const policies = validateExportedPolicies(rows);

  if (policies.length === 0) return null;

  const warning =
    `WARNING: Restoring this SQL does not apply these table access declarations: ${policies.map(describePolicy).join('; ')}. ` +
    'Before using the restored database, re-declare each table with db_scope_set or redeploy its db/schema.ts, then verify every declaration with db_scope_list.';

  return {
    warning,
    policies,
    sqlLines: [
      `-- ${warning}`,
      '-- somewhere.tech table-access-policy export v1 (informational; not applied by SQL restore)',
      ...policies.map((policy) => `-- policy: ${JSON.stringify(policy)}`),
      '-- end somewhere.tech table-access-policy export v1',
    ],
  };
}
