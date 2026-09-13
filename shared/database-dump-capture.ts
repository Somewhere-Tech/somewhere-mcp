/** Integrity of the exported SQL/schema and table-access labels. This is not
 * signed provenance, a cross-store snapshot, or a complete member-join policy. */
export interface DatabaseDumpCapture {
  version: 1;
  project_id: string;
  database_id: string;
  sql_sha256: string;
  schema_sha256: string;
  policy_sha256: string;
  policy_observed_at: string;
  data_observation_started_at: string;
  data_observation_completed_at: string;
  binding_checked_at: string;
}

export async function dumpSha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** The same normalization owns emitted CREATE statements and their digest. */
export function dumpSchemaStatement(sql: string): string {
  return `${sql.trim().replace(/;?\s*$/, '')};`;
}

export function parseDumpCapture(value: unknown): DatabaseDumpCapture {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid dump capture');
  const row = value as Record<string, unknown>;
  const identity = (key: string) => typeof row[key] === 'string' && /^[^\u0000-\u0020]{1,128}$/.test(row[key]);
  const digest = (key: string) => typeof row[key] === 'string' && /^[0-9a-f]{64}$/.test(row[key]);
  const timestamp = (key: string) => {
    const time = row[key];
    return typeof time === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(time)
      && Number.isFinite(Date.parse(time)) && new Date(time).toISOString() === time;
  };
  if (row.version !== 1 || !identity('project_id') || !identity('database_id')
    || !['sql_sha256', 'schema_sha256', 'policy_sha256'].every(digest)
    || !['policy_observed_at', 'data_observation_started_at', 'data_observation_completed_at', 'binding_checked_at'].every(timestamp)) {
    throw new Error('Invalid dump capture');
  }
  // Only the fixed reviewed fields can cross the response boundary.
  return {
    version: 1, project_id: row.project_id as string, database_id: row.database_id as string,
    sql_sha256: row.sql_sha256 as string, schema_sha256: row.schema_sha256 as string, policy_sha256: row.policy_sha256 as string,
    policy_observed_at: row.policy_observed_at as string, data_observation_started_at: row.data_observation_started_at as string,
    data_observation_completed_at: row.data_observation_completed_at as string, binding_checked_at: row.binding_checked_at as string,
  };
}
