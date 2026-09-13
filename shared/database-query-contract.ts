/** Raw query result carried inside the platform's success envelope.
 * `count` counts returned rows; `changes` counts affected rows, independently.
 * Additional transport metadata may accompany these canonical fields.
 */
export interface DatabaseQueryResult<Row = unknown> {
  data: Row[];
  count: number;
  changes: number;
  /** IDs outside the safe integer range are preserved as decimal strings. */
  last_row_id: number | `${bigint}` | null;
}

const resultProperties = {
  data: { type: 'array', items: {} },
  count: { type: 'number' },
  changes: { type: 'number' },
  last_row_id: {
    type: ['number', 'string', 'null'],
    // Require end of input; a dollar anchor alone also permits a final newline.
    pattern: '^(?:0|-?[1-9][0-9]*)(?![\\s\\S])',
  },
} satisfies Record<keyof DatabaseQueryResult, object>;

/** Shared with MCP's advertised output schema; does not constrain SQL values. */
export const DATABASE_QUERY_RESULT_SCHEMA = {
  type: 'object' as const,
  properties: resultProperties,
  required: Object.keys(resultProperties),
  additionalProperties: true,
};
