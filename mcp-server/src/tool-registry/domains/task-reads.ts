import { defineDomainToolSpecs, type JsonSchemaProperty } from '../types';

const READ_PROPERTIES: Record<string, JsonSchemaProperty> = {
  view: { type: 'string', enum: ['current', 'history', 'field', 'full'], description: 'Task view; current by default. full is explicitly unbounded.' },
  kind: { type: 'string', enum: ['comments', 'activity'], description: 'History kind; defaults to comments.' },
  field: { type: 'string', description: 'Top-level field to expand with view=field.' },
  event_id: { type: 'string', description: 'History event ID for a field expansion; repeat kind.' },
  cursor: { type: 'string', description: 'Opaque next_cursor from the previous page; repeat the original filters/view. Never combine with offset.' },
  limit: { type: 'number', description: 'History rows per page (default 5, cap 20); response budget can return fewer.' },
  offset: { type: 'number', description: 'Fresh row offset, or UTF-16 character offset for field expansion. Prefer cursor.' },
};

export function taskQueryParams(args: Record<string, unknown>): URLSearchParams {
  const query = new URLSearchParams();
  for (const key of ['project_id', 'status', 'type', 'include_archived', 'review_for_closure', 'assignee', 'area', 'parent_id', 'q', 'active', 'stale', 'stale_days', 'sort', 'detail', 'limit', 'offset', 'view', 'kind', 'field', 'event_id', 'cursor']) {
    if (args[key] !== undefined) query.set(key, String(args[key]));
  }
  return query;
}

export const TASK_READ_TOOL_SPECS = defineDomainToolSpecs([
  {
    definition: {
    name: 'tasks_list',
    description: 'Read a small task page (default 10, bounded response). Repeat the same filters with page.next_cursor as cursor; never concatenate pages automatically. Task ordering is live keyset: edits to sort/filter fields may skip or repeat rows; restart for a fresh queue. Fields in omitted are partial: expand with tasks_get view=field. detail=full explicitly permits unbounded descriptions. task_id reads one current task; prefer tasks_get for history/field options. review_for_closure reports its source candidate limit. Use tasks_summary for counts, memory_search for durable guidance.',
    inputSchema: {
      type: 'object',
      properties: {
        ...READ_PROPERTIES,
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side, you don't need to look up the UUID. Use 'default' (or 'spine') to target the org's shared atomic task board; this is the right value for the platform's own dogfood/resolution-note workflow." },
        task_id: { type: 'string', description: 'Optional. Pass a task ID (starts with tsk_) to read its bounded current state instead of listing. Comments and activity are retrieved separately through tasks_get. The short/prefix form resolves when unique within the project; an ambiguous prefix returns the candidates.' },
        status: { type: 'string', enum: ['backlog', 'open', 'in_progress', 'blocked', 'needs_review', 'done', 'archived'] },
        type: { type: 'string', description: 'Filter by spine type. A single value (e.g. "report") or a comma list (e.g. "philosophy,directive,spec"). House vocab: philosophy, roadmap, epic, task, bug, directive, report, spec — or whatever fits; type is a filter, not a taxonomy.' },
        include_archived: { type: 'boolean', description: 'Default false. Only affects results when a type filter is present: archived rows are hidden unless this is true.' },
        review_for_closure: { type: 'boolean', description: 'Surface-only review queue: returns report rows whose parent task carries a shipped_in version, annotated with resolved_by_version ("did the fix that shipped resolve this report?"). Never changes status. Ignores the other filters.' },
        assignee: { type: 'string', description: 'Filter to tasks assigned to this person.' },
        area: { type: 'string', description: 'Filter to tasks in this subsystem.' },
        parent_id: { type: 'string', description: 'Filter to sub-tasks of this parent. Pass "null" to fetch only top-level (no parent) tasks.' },
        q: { type: 'string', description: 'Case-insensitive text search over title and description.' },
        active: { type: 'boolean', description: 'Shortcut for "what is on my plate" — status open + in_progress. Ignored if an explicit status is given.' },
        stale: { type: 'boolean', description: 'Only in_progress tasks untouched for more than stale_days.' },
        stale_days: { type: 'number', description: 'Staleness threshold in days (default 7). Also controls the per-row `stale` flag.' },
        sort: { type: 'string', enum: ['priority', 'updated', 'created'], description: 'Sort order. Default (omitted) is the smart order: open before done, by priority, newest first.' },
        detail: { type: 'string', enum: ['full'], description: 'Pass "full" to include complete descriptions instead of the compact excerpt.' },
        limit: { type: 'number', description: 'Max rows to return (default 10, cap 500); payload budget may return fewer.' },
        offset: { type: 'number', description: 'Optional fresh offset traversal. Prefer cursor for checked continuation; do not combine them.' },
      },
      required: ['project_id'],
    },
  },
    annotations: { title: 'List tasks, or read one', readOnlyHint: true, idempotentHint: true },
    group: 'tasks',
    core: true,
    coreRank: 40,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","chatgpt","connector"],
    protocol: { surfaceDescriptions: { connector: "Read a bounded page of project tasks. Repeat filters with next_cursor to continue. Omitted fields can be retrieved separately; sorting and filters reflect live edits." }, surfaceAnnotations: { connector: {"title":"Tasks List","readOnlyHint":true} },  oauthScopes: ['mcp'] },
    execute: async (runtime, args) => {
      const q = taskQueryParams(args);
      const id = typeof args.task_id === 'string' && args.task_id ? args.task_id : null;
      if (id && args.detail === 'full') q.set('view', 'full');
      if (id) return runtime.callApi('GET', `/v1/tasks/${encodeURIComponent(id)}?${q}`);
      return runtime.callApi('GET', `/v1/tasks?${q}`);
    },
  },
  {
    definition: {
    name: 'tasks_get',
    description: 'Read current task state by default, bounded to about 12,000 JSON characters, with history counts and expansion instructions. view=history pages comments or activity (kind), newest first with stable ID ties; default 5. view=field expands an omitted top-level field as bounded JSON-text chunks; for a history field also pass kind and event_id. Repeat the same read options with next_cursor as cursor. History uses a keyset and initial rowid/time upper bounds; appends do not restart it, deletions disappear, and edited bodies are live. Membership is not frozen: deletion followed by a same-timestamp insert can admit a new event on a later page. Field chunks reject changed content with CURSOR_STALE; restart that field read. view=full explicitly requests the unbounded compatibility response with all comments/activity ordered oldest first (created_at ASC, id ASC). Prefix task IDs work when unique.',
    inputSchema: {
      type: 'object',
      properties: {
        ...READ_PROPERTIES,
        project_id: { type: 'string', description: "Project ID (UUID), subdomain, or slug — resolved server-side. Use 'default' (or 'spine') to target the org's shared atomic task board." },
        task_id: { type: 'string', description: 'Task ID (starts with tsk_). Prefixes are accepted when unique inside the project.' },
      },
      required: ['project_id', 'task_id'],
    },
  },
    annotations: { title: 'Read one task', readOnlyHint: true, idempotentHint: true },
    group: 'tasks',
    core: true,
    coreRank: 39,
    visibility: 'authenticated',
    paid: false,
    surfaces: ["full","chatgpt","connector"],
    protocol: { surfaceDescriptions: { connector: "Read one task’s current state, a page of history, or a selected field. Continuation and omitted content are explicit; full view requests unbounded history." }, surfaceAnnotations: { connector: {"title":"Tasks Get","readOnlyHint":true} },  oauthScopes: ['mcp'] },
    execute: async (runtime, args) => {
      if (typeof args.task_id !== 'string' || !args.task_id) {
        return { status: 400, data: { ok: false, error: 'VALIDATION_ERROR', message: 'tasks_get requires task_id. Use tasks_list to discover IDs.' } };
      }
      return runtime.callApi('GET', `/v1/tasks/${encodeURIComponent(args.task_id)}?${taskQueryParams(args)}`);
    },
  },
]);
