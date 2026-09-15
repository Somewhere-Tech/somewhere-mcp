/**
 * Per-topic platform documentation, returned by the docs MCP tool.
 *
 * The agent-facing AGENT.md is kept short so it always loads in full. The
 * detailed references live here and are fetched on demand — one topic per
 * call. Add a topic by adding a key. Keep each entry self-contained: the
 * agent may read this topic in isolation with no other context.
 */

import {
  SDK_VERSION,
  WORKERS_AI_DEFAULT_FREE_MODEL,
  WORKERS_AI_NON_REASONING_MODELS_INLINE,
  WORKERS_AI_REASONING_MODELS_INLINE,
  WORKERS_AI_REASONING_MODELS_SLASH,
  TEMP_ACCOUNT_KEY_SCOPES_INLINE,
  TEMP_ACCOUNT_TTL_HOURS,
  TEMP_RUNTIME_CAPABILITIES_INLINE,
  DISCOVERED_API_SURFACE_TOPIC,
  RECIPE_CHECKOUT_FULFILLMENT,
  RECIPE_MAGIC_LINK_BROWSER,
} from './platform-help-derived';

export const PLATFORM_HELP_TOPICS: Record<string, string> = {
  'api-surface': DISCOVERED_API_SURFACE_TOPIC,
  'declared-data': `# Declared data — the schema file is the contract

Your app's database is described in one file, \`db/schema.ts\`. Every table
declares who may reach it. The platform reads the declaration and enforces it
on every path: the generated browser client, direct HTTP to the data endpoint,
and the default path inside your functions. There is no policy language and no
separate migration step: the declaration deploys with your source, and every
release path (deploy, patch, preview, promote, rollback) applies it.

## One table, fully declared

\`\`\`ts
import { schema, table, id, text, integer, boolean, owner, shared, serverOnly } from 'somewhere/db';

export default schema({
  notes: table(
    { id: id(), title: text(), body: text(), pinned: integer({ default: 0 }) },
    {
      scope: owner(),
      client: {
        read: ['id', 'title', 'body', 'pinned'],
        create: ['title', 'body'],
        update: ['title', 'body', 'pinned'],
        delete: true,
        publicRead: false,
        identity: 'authenticated',
      },
    },
  ),
  posts: table(
    { id: id(), message: text() },
    { scope: shared(), client: { read: ['id', 'message'], create: ['message'] } },
  ),
  articles: table(
    { id: id(), title: text(), published: boolean({ default: false }) },
    {
      scope: owner(),
      client: {
        read: ['id', 'title'],
        publicRead: { where: { published: true } },
        create: ['title'],
        update: ['title'],
      },
    },
  ),
  ledger: table({ id: id(), amount: integer() }, { scope: serverOnly() }),
});
\`\`\`

**scope** says who may access rows:

- \`owner()\` — a signed-in member reads and writes only their own rows. The
  default ownership.
- \`shared()\` — every signed-in member reads every row; a row is written only
  by the member who created it. The platform records the author in a managed
  column that is never exposed to the browser. Rows that predate the
  declaration have no author and cannot be edited from the browser.
- \`member({ group, membership, member_user, member_group })\` — rows carry a
  group key; members of that group, resolved through the named membership
  table, can read, create, update, and delete them. Use \`operations: ['read']\`
  inside the member options for read-only membership. The membership table
  itself is never written from the browser.
- \`anyOf(owner(), member({ ... }))\` — the row's owner or a member of its
  group can read, update, and delete it. To let the team read while only the
  owner edits or deletes, use \`member({ ..., operations: ['read'] })\` inside
  \`anyOf\`. The platform sets and protects the owner column.
  Creating a row requires membership in its explicitly supplied group;
  becoming the owner does not authorize assigning a row to another group.
- \`parent({ via: 'project_id' })\` — access follows the referenced parent's
  private scope. Declare \`project_id\` with \`references: 'projects'\`.
  A foreign key or relationship alone never grants this access.
- \`serverOnly()\` — the browser never reaches it; only your functions do.

**client** says what the browser may do, and nothing is exposed until you say
so. A table without a \`client\` block is server-only from the browser's point
of view even when its scope is \`owner()\`.

- \`read\`: the columns the browser may see (\`true\` for all of them).
- \`create\` / \`update\`: the columns the browser may set; \`null\` disables the
  operation. Owner and author columns and platform columns are set by the
  platform, never by the browser. A group-key column is supplied on create and
  checked against the caller's membership; it cannot be changed on update.
  Binary columns are never browser-writable.
- \`delete\`: whether the browser may delete.
- \`publicRead\`: visitors who are not signed in may read the explicit \`read\`
  columns, and only those. \`true\` publishes every row; \`{ where: {
  published: true } }\` publishes only rows matching 1-8 literal equality
  fields. Public access adds to ordinary access: signed-in authors still see
  their own drafts, members see their group rows, and shared-table readers keep
  their signed-in view. List/get filters and cursors narrow that combined view;
  the same explicit read columns apply throughout. Publication
  fields cannot be generic browser create/update fields, and a browser-created
  row must default private. Public never means writable: an authorized server
  handler publishes a row with \`sw.db.server.update\`. Public live views are unavailable; public list/get calls refresh normally.
- \`identity\`: \`'authenticated'\`, or \`'visitor'\` on a table that allows
  visitors (below).

## Visitors

A table can let visitors own rows before they sign in:

\`\`\`ts
cart: table({ id: id(), sku: text() }, {
  scope: owner({ visitors: true }),
  client: { read: true, create: ['sku'], delete: true, identity: 'visitor' },
}),
\`\`\`

The platform gives each visitor a signed session cookie that lasts 30 days.
Rows the visitor creates belong to that session. When the visitor signs in,
the platform moves those rows to the account in one step, and that visitor
session can never hand rows over again, so a later account can never take an earlier
account's rows. A retry or a second tab is a no-op; logging out issues a fresh
visitor session. If visitor rows conflict with rows the account already has,
sign-in still completes and the account's existing data is unaffected; the visitor data stays stored under the retired visitor session and is not merged automatically — the browser cannot reach it again. There is no
anonymous-session call and no migration step to write.

## The generated client

The platform generates a typed client from the declaration at deploy time and
binds it to that release. Import it in browser code:

\`\`\`ts
import { data, DataError } from 'somewhere:data';

const page = await data.notes.list({ limit: 20, where: { pinned: 1 } });
// page.data: rows; page.next: cursor or null; page.has_more
const one = await data.notes.get(id);          // { data: row | null }
await data.notes.create({ title: 'Hi', body: '' });
await data.notes.update(id, { pinned: 1 });
await data.notes.delete(id);
\`\`\`

Only the operations you enabled exist on the client; a disabled one is absent,
not a runtime error. Every call carries the digest of the whole declaration it was generated
from. After a deploy that changes any table declaration, calls from pages
loaded before it are refused with \`DATA_CONTRACT_MISMATCH\` (409, "Reload
the app") until the page reloads; the client does not retry or negotiate.
Deploys that leave the declaration unchanged keep serving open pages. Every request to
\`/__sw/data\` is a POST and must include the app's own \`Origin\` header,
including list/get reads and calls with an app-user Bearer token. Browser
fetch sends it automatically; a script must set it explicitly. Missing or
wrong Origin returns \`ORIGIN_REQUIRED\` or \`DATA_ORIGIN_FORBIDDEN\`. Errors are thrown as
\`DataError\` with \`status\` and \`code\`:
\`AUTH_REQUIRED\`, \`DATA_ACCESS_DENIED\`, \`DATA_CONTRACT_MISMATCH\`,
\`DATA_IDENTITY_MISMATCH\`, \`DATA_INPUT_INVALID\`, \`DATA_INPUT_TOO_LARGE\`,
\`DATA_OPERATION_INVALID\`, \`DATA_VALUE_INVALID\`, \`DATA_CONFLICT\`.
An update or delete by ID that matches no accessible record throws
\`DataError\` with status 404 and code \`DATA_NOT_FOUND\` ("Record not found.").
Missing records and records outside your write permissions return the same error.
Successful writes report \`changes\`; a same-value update to your own record succeeds.
Lower-level bulk \`sw.db\` operations still return a zero change count when nothing matches.

A create or update that conflicts with a declared unique value returns
\`DataError\` with status 409 and code \`DATA_CONFLICT\`. Map that code to your
app's duplicate-value message; retrying the same values will not fix it.
The error does not identify the existing row or disclose its fields.

Direct HTTP to the data endpoint has exactly the same restrictions; the client
is convenience, not the boundary.

### Related records

Declare a relationship alongside the table, for example
\`relations: { tasks: hasMany('tasks', 'project_id') }\` on \`projects\`.
The child \`project_id\` column must declare \`references: 'projects'\`.
When both tables grant client reads, the generated client exposes:

\`\`\`ts
const page = await data.projects.relations.tasks.list(projectId, { limit: 20 });
// page.data, page.next, page.has_more — same page shape as an ordinary list.
\`\`\`

Each side keeps its own permissions. Reading a project does not grant access
to its tasks: inaccessible children are omitted, and an inaccessible or missing
parent produces an empty page. Sign-in requirements still apply. Each returned
child contains only its declared readable fields; a hidden linking column is
not added to the result. Filters use readable child fields, and \`after\` is a
child-row cursor. This is one relationship at a time, with up to 100 rows per
page. Parent and child reads are separate, so the result is not an atomic
snapshot. Relation writes, nested relationships and automatic inheritance of
parent permissions are not part of this operation.

Local \`somewhere typecheck\` and \`somewhere dev\` resolve \`somewhere:data\` with
the current CLI (\`npm i -g @somewhere-tech/cli@latest\` if yours predates this
contract); \`somewhere deploy-check\` compiles on the platform regardless.

## Inside functions

- Default: \`sw.db.from / insert / update / remove\` run as the calling member
  and the same ownership rule applies. \`owner()\` tables need no auth guard.
- Intentional cross-user reads (admin screens, aggregates, background jobs):
  pass \`{ asServer: true }\` to \`sw.db.from\` or \`sw.db.count\`.
- Intentional cross-user writes: authorize the caller yourself, then use
  \`sw.db.server.insert / update / remove\`, or \`sw.db.server.tx\` for a closed
  batch applied atomically. Batches (\`sw.db.tx\` and \`sw.db.server.tx\`) do not
  accept membership-scoped tables, and inserts into membership-scoped tables
  do not accept \`onConflict\`; write those rows one at a time. Every
  server-mode call is recorded in the query log with authority \`server\`.
- Ordinary raw SQL (\`sw.db.query\` / \`sw.db.batch\`) is refused on
  declared-schema projects. For a raw read that structured calls cannot
  express, authorize the caller yourself and use \`sw.db.server.query\` or
  \`sw.db.server.batch\`. These explicit server-authority calls do not apply
  declared row permissions. Managed raw writes remain refused.

## Restore and existing databases

Restoring a project database in place is not available: the request is
refused with \`DATABASE_RESTORE_UNAVAILABLE\` before anything changes. Downloads
and exports work as documented.

A project created now starts in managed mode: its database is shaped only
by the schema file you deploy, and you can add that file on any later deploy.
A project from before managed mode (one whose database was built with SQL
migrations) keeps working as it does today; moving it onto a declaration is
an explicit migration step you request, not something the platform performs
on your next deploy.
`,
  'sdk': `# @somewhere-tech/sdk — optional adapter, one auth path

There is one auth map:

- **Browser app:** httpOnly cookie sessions. The browser holds no access token,
  refresh token, or developer key. Auth and data writes go through same-origin
  \`api/*\` functions that call \`sw.auth\`, \`sw.db\`, and \`sw.fs\`.
- **Non-browser client:** bearer token mode, because a script/CLI/native client
  has no browser cookie boundary.

This is the one JS/TS package. Its root client plus tree-shakeable
\`@somewhere-tech/sdk/auth\`, \`@somewhere-tech/sdk/react\`, and
\`@somewhere-tech/sdk/server\` entry points adapt that contract without
defining a second transport.

\`\`\`bash
npm i @somewhere-tech/sdk
\`\`\`

## createClient

\`\`\`js
import { createClient } from '@somewhere-tech/sdk'

// Browser: no credential. auth.* and functions.invoke() ride httpOnly cookies.
const browserClient = createClient(SOMEWHERE_URL)

// Script/CLI/server: explicit bearer compatibility mode.
const scriptClient = createClient(SOMEWHERE_URL, APP_USER_TOKEN)
\`\`\`

- SOMEWHERE_URL — your project URL, https://<project>.somewhere.site. It's the
  functions.invoke host and how the client infers your project id. On a custom
  domain pass \`{ projectId }\`.
- The second argument is optional in a browser. In non-browser/header mode it
  is an app-user bearer token or a developer \`smt_\` key restricted to a
  deployed function or trusted server process. Do not invent a placeholder
  credential.
- \`new Somewhere({ key, projectId })\` remains the explicit compatibility
  constructor for existing bearer-based integrations.

## Database — declared client and server functions

For ordinary browser reads and writes, declare client grants in \`db/schema.ts\`
and import the generated \`data\` client from \`somewhere:data\`. See
\`docs({ topic: 'declared-data' })\` for its named, typed operations.
The SDK's generic database interface is not this generated client: direct
app-user SQL/database API access is refused (\`BROWSER_DB_ACCESS_REMOVED\`).
For custom logic, call an \`api/\` function that uses \`sw.db\`.

\`\`\`js
// api/todos.js — server function; declared access is scoped automatically.
export default async function (req, sw) {
  const r = await sw.db.from('todos', { order: [['created_at', 'desc']] })
  return Response.json({ todos: r.data })
}

// Browser — call your function, never the database:
const { data } = await client.functions.invoke('todos')
\`\`\`

On managed projects, ordinary \`sw.db.query\` / \`sw.db.batch\` calls are
refused with \`MANAGED_RAW_SQL_REQUIRES_SERVER_AUTHORITY\`. Use the structured
calls for declared access. When a read truly requires raw SQL, authorize the
caller first and use \`sw.db.server.query\` or \`sw.db.server.batch\`; those
calls run exactly as written and do not apply declared row permissions. Raw
writes remain refused in managed mode. SQL-mode projects retain ordinary raw
SQL behavior.

### Structured queries — the platform composes and scopes

For platform-proven per-user scoping, use the structured builder. You describe
the query; the platform renders the SQL (identifiers validated, every value
bound) and scopes it automatically to the request's signed-in user. It never
parses a string it did not write. This ships together with the browser-DB
removal — one release.

\`\`\`js
export default async function (req, sw) {
  // user-owned table → owner filter appended automatically; no scope argument
  const { data } = await sw.db.from('notes', { where: { done: false }, order: ['created_at','desc'], limit: 20 })
  const { data: remaining } = await sw.db.count('notes', { where: { done: false } })
  const made = await sw.db.insert('notes', { title: 'Hello' })   // owner column set by the platform
  await sw.db.update('notes', { set: { done: true }, where: { id: 5 } })
  await sw.db.remove('notes', { where: { id: 5 } })              // sw.db.delete is an alias
  return Response.json({ notes: data, remaining, made: made.data[0] })
}
\`\`\`

\`where\`: \`{ col: value }\` (=), \`{ col: { gt|gte|lt|lte|ne|like: v } }\`,
\`{ col: { in: [...] } }\` (empty array matches nothing), \`{ col: null }\`
(IS NULL), \`{ col: { not: null } }\` (IS NOT NULL), a per-column array of
conditions ANDed (\`{ created_at: [{ gte: a }, { lte: b }] }\`). A shallow
\`$or\` group accepts 2-8 single-column leaf branches, for example
\`{ $or: [{ status: 'draft' }, { status: 'published' }] }\`; the whole group
remains inside the platform's owner/member scope. Nested OR, relation-filter OR,
and named-live OR are refused. Every structured table needs an
explicit declared intent (scoped / shared / server-only). Scoping is automatic
and mandatory: on a declared user-owned table every structured query is scoped
to the request's verified user (resolved like sw.auth.fromRequest, so it
carries the same ≤60s per-isolate revocation lag as any sw.auth check) — no
signed-in user throws \`AUTH_REQUIRED\` before the database is touched;
shared/server-only tables run
unscoped. The platform owns the ownership column and refuses to let
insert/update set or reassign it (\`OWNER_COLUMN_NOT_ASSIGNABLE\`). A table
with NO declared intent cannot be structured-queried at all — it fails the
deploy and throws \`TABLE_INTENT_REQUIRED\` (403) at runtime; declare it or,
for an intentional raw read, authorize the caller and use
\`sw.db.server.query\`. Cross-user raw reads and reads from undeclared tables
use that explicit server-authority path. Passing the retired
third scope argument throws \`SCOPE_ARGUMENT_REMOVED\`. Responses match
\`sw.db.query\` (\`{ data, error, count, last_row_id, changes }\`; \`count()\`
returns exactly \`{ data, error }\`); mutations \`RETURNING *\` and publish
the \`db:<table>\` realtime event. The \`last_row_id\` result field is always
null; read an inserted ID from its returned row in \`data\`.

The release records the DECLARED shape, never a reconstruction from
reading code: each deploy pins the project's table intents (scoped/shared,
owner column) and a schema snapshot captured from the live database
(\`SCHEMA_CAPTURE_FAILED\` if the snapshot cannot be taken). Explicit
\`sw.db.server.query\`/\`batch\` reads run as written and are never analyzed —
the deliberate server-authority escape hatch. \`POST /v1/db/migrate\` is the same
trust class: a production target takes a named restore point BEFORE any
statement runs (a recorded marker: restoring a database in place is not
available, so it is not an undo), then runs your SQL atomically, exactly as written. A preview
target runs against the disposable clone and takes no production restore
point. It does NOT analyze the SQL and cannot warn about or refuse what a
statement drops or breaks. If a production restore point cannot be taken,
nothing applies (\`RESTORE_POINT_FAILED\`, retryable). A managed
\`db/schema.ts\` instead runs through the schema planner on production deploy;
its table access intents are declared
by the file. \`GET
/v1/db/access-map\` (developer key) returns the release's data-access map
at per-table granularity: declared intents with ownership scope, the schema
snapshot, and a plain note that explicit server-authority SQL is not analyzed.

## Auth — sw.auth

\`\`\`js
await client.auth.signUp({ email, password })
await client.auth.signIn({ email, password })               // preferred name
await client.auth.signInWithPassword({ email, password })
await client.auth.sendMagicLink({ email })
await client.auth.verifyMagicLink({ token })
await client.auth.signInWithOAuth({ provider: 'google' })   // one call → data.url
const { data: { user } } = await client.auth.getUser()
client.auth.onAuthStateChange((event, session) => { /* SIGNED_IN / SIGNED_OUT / ... */ })
await client.auth.signOut()
\`\`\`

In a browser these auth methods run in **cookie mode** by default
(${SDK_VERSION}): the SDK posts to your app's own auth routes
(\`/api/auth/*\` — one pasteable backend file, see
\`docs({ topic: 'auth-client' })\`) and the session is set as httpOnly cookies.
No tokens land in JS or localStorage; \`error.message\` carries the real cause
("Wrong email or password."). \`getSession()\` returns
\`{ cookie_session: true, user }\`.

Scope boundary: \`functions.invoke()\` also rides that cookie. Direct
\`from()\`, storage, and realtime calls go to the platform API. Legacy
bearer-based browser calls remain operational and warn before any future
enforcement; cookie sign-in deliberately does not credential those surfaces.
Node/CLI keep header mode (tokens in SDK memory); pass
\`{ authMode: 'header' }\` only when the client is meant to hold tokens.

Name/result alignment for new code:

| Intent | Preferred method | Compatibility alias | Result |
| --- | --- | --- | --- |
| Password sign-in | \`signIn\` | \`signInWithPassword\` | \`{ data: { user, session }, error }\` |
| Send passwordless link | \`sendMagicLink\` | — | \`{ data, error }\` |
| Complete passwordless link | \`verifyMagicLink\` | — | \`{ data: { user, session }, error }\` |
| Complete password reset | \`verifyPasswordReset\` | \`verifyOtp\` (deprecated) | \`{ data, error }\` |

No compatibility alias is removed here. A future removal or result-shape break
requires a major version and explicit founder sign-off.

## Storage — client.storage.from(bucket)

Like \`from()\`, direct browser storage is deprecated compatibility mode:
existing bearer calls continue with a warning; new browser code calls a
same-origin function that uses \`sw.fs\`.

\`\`\`js
await client.storage.from('avatars').upload('me.png', file)
client.storage.from('avatars').getPublicUrl('me.png')         // { data: { publicUrl } }
await client.storage.from('avatars').createSignedUrl('me.png', 3600)
await client.storage.from('avatars').download('me.png')
await client.storage.from('avatars').remove(['me.png'])
\`\`\`

## Live updates — not client.channel

The adapter exposes \`client.channel(name)\`, but realtime channels refuse
app-user and visitor sessions (\`CHANNEL_FORBIDDEN\`, 403), so it cannot
work from a browser. The live path a browser can use is a declared live view:
the function returns rows plus a subscription URL, and \`watchLive\` re-reads
through your function on every invalidation.

\`\`\`js
import { watchLive } from '/__sw/live/client.js'

watchLive(
  () => fetch('/api/open-notes', { credentials: 'include' }).then(r => r.json()),
  (rows) => render(rows),
)
\`\`\`

Declare the view server-side with \`sw.db.live(name, sw.db.from(...))\` →
docs({ topic: 'realtime' }).

## Functions — client.functions.invoke

\`\`\`js
const { data, error } = await client.functions.invoke('checkout', { body: { plan: 'pro' } })
\`\`\`

Other languages → docs({ topic: 'sdks' }). Porting an existing app → the
migration guide via docs({ topic: 'migration-supabase' }).
`,

  'sdks': `# Client SDKs — languages and status

One supported SDK. We'd rather ship one we maintain than a pile we don't.

| Language | Package | Install | Status |
| --- | --- | --- | --- |
| JavaScript / TypeScript | @somewhere-tech/sdk | npm i @somewhere-tech/sdk | Stable — supported (v${SDK_VERSION}) |

Its shape: createClient → from().select() → { data, error }, plus auth,
storage, and functions (createClient, functions.invoke, onAuthStateChange,
realtime channel subscribe) — reach for it first, especially when porting an
app. → docs({ topic: 'sdk' }). For the command line, → docs({ topic: 'cli' }).
Every other language talks to the platform through the ordinary HTTP API
(docs({ topic: 'api-surface' })) or the CLI; no other language SDK is offered.
`,

  'cli': `# @somewhere-tech/cli — full command reference

When a shell is available, the CLI is the primary platform surface. It has
first-class commands for routine operator work,
\`somewhere call <tool> '<json>'\` for every platform tool, and
\`somewhere run <script>\` to execute code against your live project without
deploying. Nothing else needs installing: no MCP setup is required to use the
CLI, and on a persistent machine you install and log in once. MCP is for
connected clients without a shell (Claude.ai, ChatGPT and other MCP hosts).
The CLI and its local MCP bridge share one login; a Claude.ai or ChatGPT
connection uses its own OAuth session and reaches the same platform tool
implementations. \`run_code\` is the same code-execution capability on MCP,
with one difference: through the Claude directory connector, code runs cannot
generate AI media or move money, while the CLI runs unrestricted. Use MCP from
a shell only when its in-context delivery is materially useful. The advisor is
optional on both surfaces, never a required step.

No account yet? Deploy the current directory immediately:

\`\`\`bash
npx @somewhere-tech/cli deploy
\`\`\`

The anonymous command returns a live URL and claim link; login is optional until
you decide to keep the project.

\`\`\`bash
npm i -g @somewhere-tech/cli
somewhere signup          # no account yet — opens the sign-up page (from 0.30.1)
somewhere login           # opens a browser; session lands in ~/.somewhere/config.json
\`\`\`

\`somewhere login\` prints a short device code and opens a page where you
approve this machine by name. If you are not signed in yet, that page signs you
in first. It has no way to create an account, so \`somewhere signup\` is the
front door for a stranger: it prints the sign-up URL as plain text before it
opens anything, so a headless agent can relay a link it can read, then tells you
to run \`somewhere login\` (from 0.30.1 — before that, \`login\` was the only
entry point and a new user had nowhere to go).

The same session powers the CLI, the MCP bridge, and \`somewhere deploy\`.
Do not pass an API key for a human setup flow; the \`smt_\` key is for CI/CD.

\`somewhere deploy\` ships raw source (\`src/\`, \`index.html\`, \`public/\`,
\`package.json\`, \`api/\`) unless you explicitly opt into \`--prebuilt\`. The
normal path has no local build step. → docs({ topic: 'deploy' }).

## Global commands and flags

| Command | Flags | What it does |
|---|---|---|
| \`somewhere --version\` | \`-V\`, \`--version\` | Print the CLI version. |
| \`somewhere --help\` | \`-h\`, \`--help\` | Print top-level help. |
| \`somewhere help [command]\` | none | Print help for one command. |

## Auth

| Command | Flags | What it does |
|---|---|---|
| \`somewhere signup\` | none | Create an account — prints the sign-up URL and opens it. (from 0.30.1) |
| \`somewhere login\` | \`--signup\`, \`--legacy\` | Authenticate with the device-code browser flow. \`--signup\` opens account creation instead; \`--legacy\` uses the localhost-callback flow. (from 0.30.1) |
| \`somewhere logout\` | none | Revoke and remove stored credentials. |
| \`somewhere whoami\` | \`--json\` | Show current user info; \`--json\` prints the raw account response. |
| \`somewhere auth\` | none | Credential command group. |
| \`somewhere auth login\` | none | Authenticate with the browser flow. |
| \`somewhere auth set <token>\` | none | Save an \`smt_\` token directly without a browser flow. |
| \`somewhere auth status\` | none | Show current login state, device ID, and key name. |
| \`somewhere auth print-token\` | none | Print the current \`smt_\` token to stdout for shell scripts. |

## Projects

| Command | Flags | What it does |
|---|---|---|
| \`somewhere init\` | \`--name <name>\`, \`--link\` | Initialize a project in the current directory. \`--name\` skips the prompt; \`--link\` links to an existing project instead of creating one. |
| \`somewhere project\` | none | Project command group. |
| \`somewhere project create <name>\` | \`--subdomain <subdomain>\`, \`--json\` | Create a new project. |
| \`somewhere project list\` | \`--json\` | List all projects. |
| \`somewhere project view [name-or-id]\` | \`--json\` | View project details. |
| \`somewhere project delete <name-or-id>\` | \`--json\` | Tombstone a project, take its hosts offline, and start the 30-day recovery period. |
| \`somewhere call project_allowed_origins_get '<json>'\` | \`--json\` | Show the project's exact cross-origin allowlist. There is no somewhere project allowed-origins subcommand; the platform tool is reached through \`somewhere call\`. |
| \`somewhere call project_allowed_origins_set '<json>'\` | \`--json\` | Replace the project's cross-origin allowlist, which is for THIRD-PARTY origins only (owner or platform admin only). Pass \`"allowed_origins": []\` to clear it. → docs({ topic: 'cors' }). |
| \`somewhere status [project]\` | \`--json\` | Show project, active release, and workspace status, including whether your plan lets the local loop reach the project database (\`local_dev_db\` in \`--json\`). A plan answer is an answer: the command exits 0. |
| \`somewhere open [project]\` | \`--dashboard\` | Open the project URL in your browser; \`--dashboard\` opens the dashboard. |

## Advisor

| Command | Flags | What it does |
|---|---|---|
| \`somewhere advisor "<question>"\` | \`--json\` | Ask the broad platform advisor. Works without login; anonymous calls use economy processing and end with “Log in for faster answers.” Signed-in calls are faster. |
| \`somewhere advisor "<question>"\` | \`--json\` | Ask the platform advisor directly; \`--json\` wraps the question and answer in JSON. |

## Platform tools and operator workflows

| Command | Flags | What it does |
|---|---|---|
| \`somewhere catalog\` | \`--json\` | Browse the live platform tool catalog. |
| \`somewhere call <tool> '<json>'\` | \`--json\` | Invoke any platform tool by name through the same tool implementation used by MCP. Run \`somewhere call --list --json\` to enumerate names and input schemas. |
| \`somewhere tasks list\` | filters, \`--json\` | List tasks. Use \`somewhere tasks get/create/update\` to read and maintain the task system without an editor. |
| \`somewhere feedback list\` | \`--project <ref>\`, \`--json\` | List project feedback. Use \`somewhere feedback submit <message>\` to send app feedback. |
| \`somewhere grep <pattern>\` | \`--project <ref>\`, \`--glob <glob>\`, \`--json\` | Regex-search deployed source and print stable \`file:line\` matches. |
| \`somewhere usage [project]\` | \`--period <period>\`, \`--json\` | Show account or project usage through \`usage_summary\`. |

## Deploy and pull

| Command | Flags | What it does |
|---|---|---|
| \`somewhere deploy [dir]\` | \`--project <ref>\`, \`--scope <scope>\`, \`--dry-run\`, \`--include <paths>\`, \`--replace-functions\`, \`--prebuilt\`, \`--temporary\`, \`--force\`, \`--yes\`, \`--json\` | Deploy a directory to the linked or specified project. \`--include\` publishes a root file the deploy would otherwise hold back. \`--scope functions\` deploys backend only; \`--scope static\` deploys site files only. \`--dry-run\` prints the diff without deploying. \`--replace-functions\` removes deployed functions missing locally. \`--prebuilt\` opts into bundled output. \`--temporary\` creates a temporary workspace without an account. \`--force --yes\` overwrites remote changes without prompting. |
| \`somewhere pull [project]\` | \`--out <dir>\`, \`--force\`, \`--json\` | Download the live deployed source files and scaffold local typecheck files when absent. \`--out\` defaults to the current directory. |
| \`somewhere typecheck [dir]\` | \`--json\` | Run local \`tsc --noEmit\` over a pulled project. |
| \`somewhere rollback [project]\` | \`-y, --yes\`, \`--json\` | Select the previous retained production release. |
| \`somewhere deploy-check [dir]\` | \`--project <ref>\`, \`--json\` | Upload source for a server-side dry compile without deploying. |

## Project file storage

| Command | Flags | What it does |
|---|---|---|
| \`somewhere fs put <local> <remote>\` | \`--project <slug>\`, \`--content-type <type>\`, \`--json\` | Stream a local file into project storage. |
| \`somewhere fs get <remote> <local>\` | \`--project <slug>\`, \`--json\` | Stream a stored file to disk. |
| \`somewhere fs ls <remote>\` | \`--project <slug>\`, \`--json\` | List a directory in project storage. |
| \`somewhere fs rm <remote>\` | \`--project <slug>\`, \`--json\` | Remove a file or directory from project storage. |

## Database

| Command | Flags | What it does |
|---|---|---|
| \`somewhere db\` | none | Database command group. |
| \`somewhere db query <sql>\` | \`--project <id>\`, \`--json\` | Run SQL against the project database. |
| \`somewhere db dump\` | \`--project <id>\`, \`-o, --output <file>\`, \`--json\` | Export the full database as SQL. |
| \`somewhere db tables\` | \`--project <id>\`, \`--json\` | List tables in the project database. |

## Environment, logs, and errors

| Command | Flags | What it does |
|---|---|---|
| \`somewhere env\` | none | Environment variable command group. |
| \`somewhere env list\` | \`--project <id>\`, \`--json\` | List environment variable names. Values are not returned. |
| \`somewhere env pull\` | \`--project <id>\`, \`--out <file>\`, \`--force\`, \`--json\` | Write a local env template for the local-dev loop. Values are not included. |
| \`somewhere env set <key> <value>\` | \`--project <id>\`, \`--json\` | Set an environment variable. |
| \`somewhere env delete <key>\` | \`--project <id>\`, \`--json\` | Delete an environment variable. |
| \`somewhere logs [project]\` | \`--level <level>\`, \`--source <source>\`, \`--function <route>\`, \`--endpoint <path>\`, \`--since <duration>\`, \`--tail <n>\`, \`--follow\`, \`--json\` | Show recent logs. \`--tail\` defaults to 20; \`--follow\` keeps polling. |
| \`somewhere errors [project]\` | \`--limit <n>\`, \`--exceptions\`, \`--json\` | Show recent failures with a \`kind\` column: **refused** for a 4xx your own handler returned on purpose, **exception** for an uncaught throw or a 5xx. The summary line splits the two counts, and \`--exceptions\` shows only what actually broke. Nothing is hidden by default. \`--limit\` defaults to 20 and caps at 100. |

## Local execution and inspection

| Command | Flags | What it does |
|---|---|---|
| \`somewhere dev\` | \`--project <id>\`, \`--port <port>\`, \`--open\`, \`--check\`, \`--local\` | Serve the app on localhost, compiled by the platform's own compiler; \`api/\` functions run in local Node against the real project. \`--port\` defaults to 8787. \`--check\` makes the pre-start typecheck a hard gate, and needs a real \`npm install\` because the typechecker reads package types out of \`node_modules\`. \`--local\` is accepted for compatibility and is the default behavior. The loop reaches the project's database and files on every plan. |
| \`somewhere preview\` | \`--project <id>\` | Run the app on the platform instead of your machine: every save goes to a private URL, and production keeps serving what was last promoted. Pro and Scale. \`somewhere dev --cloud\` is an alias. The preview's database is an isolated, populated copy of production taken when the session is created (or the create refuses); explicitly preview-targeted \`db_migrate\` DDL changes only that preview copy. |
| \`somewhere dev <cmd...>\` | none | Run your own command with the project's environment variables injected, e.g. \`somewhere dev npm run dev\`. |
| \`somewhere run <script>\` | \`--project <id>\`, \`--timeout <ms>\`, \`--include-env\`, \`--json\` | Run a one-off ES module script once against the live project bindings. \`--timeout\` defaults to 10000 and caps at 30000. |
| \`somewhere browser [target]\` | \`--project <ref>\`, \`--url <url>\`, \`--path <path>\`, \`--wait <selector>\`, \`--eval <js>\`, \`--screenshot\`, \`--snapshot\`, \`--viewport <size>\`, \`--store\`, \`--include <sections>\`, \`--extract\`, \`--session <id>\`, \`--json\` | Inspect and drive a web page. Without \`--project\`, works against any public URL; with \`--project\`, verifies a deployed app. \`--viewport\` accepts \`desktop\` or \`mobile\`; \`--include\` accepts \`network\`, \`dom\`, and/or \`markdown\`; \`--session\` keeps one live browser page across calls for about 3 minutes. |
| \`somewhere verify [target]\` | \`--project <ref>\`, \`--url <url>\`, \`--flow <file.json>\`, \`--json\` | Run one action flow across desktop and phone viewports and return named steps, page/console/network health, and both screenshots. Omit the flow for a default page-health check. |
| \`somewhere api <method> <path>\` | \`-d, --data <json>\`, \`--raw\` | Make a raw API call with auth attached. \`--raw\` prints non-JSON responses as-is. |

## Docs and MCP

| Command | Flags | What it does |
|---|---|---|
| \`somewhere docs [topic]\` | \`--list\`, \`--json\` | Print platform docs as plain text. The bundle topics are \`start\`, \`docs\`, \`guides\`, \`security\`, \`migration\` and \`llms\`; any single capability topic from the index — \`somewhere docs cli\`, \`somewhere docs sw.db\` — prints that page. From 0.30.1 every topic is answered from the public corpus with no login; before that, anything outside the six bundles needed one. |
| \`somewhere mcp\` | none | Run the somewhere.tech MCP server over stdio. |
| \`somewhere mcp install <host>\` | none | Configure an MCP host to use somewhere.tech. Supported hosts are \`codex\`, \`claude-code\`, and \`cursor\`. |
| \`somewhere mcp doctor\` | none | Check MCP setup: login, token validity, server reachability, and host configs. |

## Keeping the CLI current

| Command | Flags | What it does |
|---|---|---|
| \`somewhere update\` | \`--check\` | Update the CLI to the latest published version through npm. \`--check\` only reports whether an update is available. |

## deploy — what gets published, and what is held back

A project root usually holds more than the app. Coding agents keep notes,
TODOs, transcripts and scratch logs next to the code, and publishing one of
those to a live URL is a privacy incident, not a cosmetic mistake.

So the root is filtered by publish surface, not by "everything that is not a
dotfile" (from 0.30.1). A root file is published when it is a known app-surface
name or extension, when something in the published source references it by
name, or when you opted it in. Everything else is held back — and named, never
dropped silently:

\`\`\`
Not published (2): NOTES.md, transcript.log
\`\`\`

\`somewhere deploy\`, \`somewhere deploy --dry-run\` and
\`somewhere deploy-check\` all print that line, so you can see the decision
before it is live. Directories such as \`src/\`, \`public/\` and \`api/\`
are unaffected — this is about loose files at the root.

To publish one on purpose:

\`\`\`bash
somewhere deploy --include NOTES.md          # once; comma-separate or repeat for several
\`\`\`

or make it permanent with a \`!\` line in \`.somewhereignore\`:

\`\`\`
!NOTES.md
\`\`\`

\`.somewhereignore\` is read alongside \`.gitignore\`: plain patterns exclude
files from the deploy, and a leading \`!\` publishes one the filter would
otherwise hold back.

## deploy-check — the server-side compile oracle

\`deploy-check\` uploads source to the exact compiler used by deploy, but writes
nothing and makes nothing live. It catches server-only bundling and import
resolution failures that a local typecheck cannot see.

\`\`\`bash
somewhere deploy-check
somewhere deploy-check --run /api/hello -X POST -d '{"name":"Ada"}'
somewhere deploy-check --json
\`\`\`

Use the second form when compilation is not enough: it compiles and invokes one
handler against the supplied method, body, and query string.

## browser — verify the live app, not just the deploy response

\`\`\`bash
somewhere browser https://my-app.somewhere.site
somewhere browser --project my-app --path /login --wait '#email' --snapshot
somewhere browser https://example.com --include network,dom --json
\`\`\`

It exits non-zero when a step fails, a request fails, or page JavaScript throws.
Use EYES mode (a public URL, no project) for any page; use \`--project\` for an
owned app and optional stored screenshots.

**Local and hosted are two halves of one command.** A \`localhost\` or
\`127.0.0.1\` target — the app \`somewhere dev\` is serving — is driven by the
browser already installed on your machine, because a browser running on the
platform can never reach an address only your machine serves (from 0.30.0). Each
local run gets an empty throwaway profile, so it never reads or writes your real
one, and if there is no browser at all the command says so and names the
environment variable that points at one. The flags only the hosted half can
honour — \`--store\`, \`--session\`, \`--extract\`, and any \`--include\`
section other than \`dom\` — are refused by name rather than silently dropped
from a report that would still look complete. Everything else, including
\`--screenshot\`, \`--wait\`, \`--eval\`, \`--snapshot\` and
\`--viewport\`, behaves the same on both halves; \`--snapshot\` requests the
interactive-element outline it prints. So the same command checks the app before
it is deployed and after.

## api — authenticated REST escape hatch

\`\`\`bash
somewhere api GET /v1/projects
somewhere api POST /v1/db/query -d '{"project_id":"my-app","sql":"SELECT 1"}'
somewhere api GET /v1/db/dump --raw
\`\`\`

The CLI attaches auth automatically. JSON parsing is the default; use \`--raw\`
only for a successful non-JSON response.

## update

\`\`\`bash
somewhere update --check
somewhere update
\`\`\`

The first command only compares the installed version with npm; the second
installs the current \`@somewhere-tech/cli\` globally.

## Exact anonymous \`deploy --json\` contract

The anonymous response has exactly these fields. \`next_step\` appears only in
human-readable output and is not part of JSON.

<!-- CLI_DEPLOY_JSON_SCHEMA_BEGIN -->
\`\`\`json
{
  "url": "https://<subdomain>.somewhere.site",
  "claim_url": "https://somewhere.tech/claim?token=swtc_…",
  "expires_at": "<ISO-8601 timestamp>"
}
\`\`\`
<!-- CLI_DEPLOY_JSON_SCHEMA_END -->

For an authenticated deploy, \`--json\` prints the raw deploy API result instead
(including fields such as \`url\`, \`version\`, build output, and warnings).

To talk to the platform from app code (browser / Node), use the client SDK
instead → docs({ topic: 'sdk' }). To serve the app on localhost while you build
it, and to typecheck before you ship — see docs({ topic: 'local-dev' }).
`,

  'verify-before-deploy': `# Verify before deploy

Pick the narrowest check that answers the question. These tools are
complementary; a green local typecheck is not a live browser health check.

| Question | Command | Runs where | Changes live state? |
|---|---|---|---|
| Are TypeScript types and imports coherent? | \`somewhere typecheck\` | Local \`tsc --noEmit\` | No |
| Will the real deploy compiler accept this source? | \`somewhere deploy-check\` | Platform compile pipeline | No |
| Does a seed/backfill/check script work against real bindings? | \`somewhere run <script>\` | One-off local module + real bindings | No deploy; may mutate project data |
| Is the deployed page healthy for a real browser? | \`somewhere browser <url>\` | Live browser | Read/drive only unless your steps submit actions |

Recommended sequence for a TypeScript app: \`typecheck\` → \`deploy-check\` →
deploy → \`browser\`. Add \`run\` only when you need a one-off operation against
the live project. For a tiny JavaScript app with no
\`package.json\`, skip local typecheck and start at \`deploy-check\`.
`,

  'local-dev': `# Local dev — \`somewhere dev\`
# somewhere dev — the frontend loop

\`somewhere dev\` serves your browser application on localhost with hot
reload while you shape the UI. The backend you rely on is the deployed one:
\`api/\` functions, \`sw.*\` calls, the database and files are reached
through your project's live URL. Deploying is how you see the real app —
the platform compiles raw source on deploy — so for anything behind an API
call the loop is \`somewhere deploy\` then \`somewhere verify\`.

  somewhere dev              # serve the frontend on http://localhost:8787
  somewhere deploy           # publish; the platform compiles
  somewhere verify           # prove the live app in a real browser

Do not run a build step before \`somewhere dev\` or \`somewhere deploy\`;
the platform compiles raw source. Local dev never needs a developer key or
a browser database client.

For an app that already has users, \`somewhere preview\` runs the whole app
hosted on a private URL against an isolated, populated copy of your production
database; nothing your users see changes until you promote that preview. See
docs({ topic: 'preview' }).
`,

  'migration-supabase': `# Migrating a Supabase app

Somewhere is not a drop-in Supabase replacement. Migrate the app's data and
access contract; changing an import does not migrate queries, permissions,
authentication, files, or realtime behavior.

## Declare the data contract

Declare tables, fields, access scopes, relations, and browser operation grants
in \`db/schema.ts\`. The platform generates the typed \`somewhere:data\` client
for permitted browser operations. Use \`sw.db\` inside functions for business
logic. A foreign key describes a relationship; it does not grant access.

An existing \`from().select()\` call is not the new browser data API. Rewrite
ordinary browser reads and writes against the generated operations. See
docs({ topic: 'declared-data' }) and docs({ topic: 'sw.db' }) for exact syntax,
supported relations, and the rules for adopting existing tables.

## Keep authentication and files explicit

Use same-origin cookie sessions for browser authentication. The optional
\`@somewhere-tech/sdk\` auth and function helpers do not make an existing
Supabase app source-compatible. Never put a developer key in browser code.
See docs({ topic: 'auth-client' }) for setup and docs({ topic: 'sw.auth' })
for user import and session behavior.

Copy files with their intended visibility; private files need authenticated
access or signed URLs. Review old public URLs rather than assuming they keep
working. See docs({ topic: 'sw.fs' }).

## Move data before switching traffic

Keep a verified export before modifying the source app. Map old user IDs,
row ownership, and foreign keys explicitly. Test the imported app with two
users and a signed-out visitor, including denied access and writes, before
switching traffic. A column named \`user_id\` does not declare its policy.
See docs({ topic: 'portability' }) for export and import capabilities.

Supabase channels are not the browser live-data contract. Use the supported
named live-view path described in docs({ topic: 'realtime' }); its scope
limits apply. Do not assume every declared table supports subscriptions.
`,

  'sw.db': `# sw.db — Database (inside deployed functions)

Available inside any deployed function via the \`sw\` argument.

sw.db uses the function's project binding — no developer API key or
application-level HTTP call. Each project has its own isolated database.
End-to-end time can still include first-use activation, placement, transport,
database scheduling, and engine execution. Use sw.db inside functions; the
REST surface is for code running outside the platform.

## Start with the schema file — db/schema.ts

Declare your tables in one file, \`db/schema.ts\`, deployed with the rest of
your source. On every live deploy the platform reads the file (it is a
declaration the platform reads — never code that runs), compares it with the
real database, creates whatever is missing, and records each table's access
scope in the same step. No migration calls, no separate scope declarations,
no schema SQL.

**On a new project, deploy the file before you test the database.** A
managed schema changes only with a release: \`somewhere deploy\` applies
\`db/schema.ts\` to production, and a preview release applies it to the
preview's isolated copy, with the same planner and safety rules. Additive
changes apply; removing or renaming a table or column is refused on
production (explore it on a preview). A later deploy with the same file is a
no-op. There
is no separate schema-apply command. Until a deploy runs,
\`sw.db.from('your_table')\` fails with \`TABLE_INTENT_REQUIRED\` because a file
on disk cannot declare the table to the platform by itself.

The file is parsed as a declaration, not executed: use literal values and
supported declaration helpers. Imports from \`somewhere/db\` are recommended
for editor tooling, but the schema reader does not resolve imports. A missing
\`owner\` import alone does not invalidate an otherwise valid declaration.
Trailing commas are accepted, inside option objects and after the final
argument of a call. Computed values, spreads and unknown helper calls are
refused with a message that names the line.

  import { schema, table, id, text, integer, boolean, timestamp, json, owner, member, shared, serverOnly } from 'somewhere/db';

  export default schema({
    todos: table({
      id: id(),                                  // integer primary key (id({ uuid: true }) for a text UUID key)
      title: text(),                             // required by default
      done: boolean({ default: false }),
      created_at: timestamp({ default: 'now' }), // stamped on insert
      meta: json({ nullable: true }),
    }, {
      scope: owner(),                            // per-user rows; owner column is platform-managed
      indexes: [['done']],
    }),
    org_invites: table({
      id: id(), org_id: integer(), email: text(),
    }, {
      scope: serverOnly(),
      unique: [['org_id', 'email']],             // composite uniqueness (junction-table idiom)
    }),
    catalog: table({ id: id(), name: text() }, { scope: shared() }),
  });

Column types (a closed set): \`id\`, \`text\`, \`number\`, \`integer\`,
\`boolean\`, \`timestamp\`, \`json\`, \`blob\`. Column options: \`nullable\`
(default false — columns are required unless declared otherwise), \`default\`
(literal values only; \`timestamp({ default: 'now' })\` is the one keyword —
the column is stamped on insert), \`unique\`, \`references: 'other_table'\`
(+ \`onDelete: 'cascade' | 'restrict'\`). Table options: \`scope\`
(required), \`indexes\` (a list of column lists), and \`unique\`
(multi-column uniqueness groups). Everything in the file is literal —
variables, computed values, spreads, or any other code fail the deploy with
the offending construct and its line named.

Scope shapes — each table declares who can reach it, at birth:

- \`owner()\` — per-user rows. The platform creates and manages the owner
  column (\`user_id\` by default; \`owner({ column: 'other_name' })\` names
  it differently at creation), sets it on insert, and scopes every structured
  query to the request's VERIFIED SIGNED-IN USER. A request with no verified
  user is refused before transport: \`AUTH_REQUIRED\` (401). Send the request
  signed in — a session cookie or \`Authorization: Bearer <app-user token>\`.
  For signed-out ownership, explicitly declare \`owner({ visitors: true })\`;
  the platform can then use a verified visitor cookie. This is per browser,
  not protection against someone discarding their cookie. For an intentional
  cross-user operation, authorize the caller in your function before using
  \`sw.db.server\`; it is not a remedy for a missing user session.
- \`shared()\` — cross-user rows with a recorded author. Structured calls need
  a verified app user: reads return every row to any signed-in user, writes
  stamp the platform's managed author column (\`_sw_author_id\`, added on
  deploy, never returned) with the caller; a request with no signed-in user is
  refused \`401 AUTH_REQUIRED\` ("Shared tables require a signed-in user."). For
  anonymous browser reads declare \`client: { read: true, publicRead: true }\`;
  for a trusted server read pass \`{ asServer: true }\`; server writes on
  behalf of the app use \`sw.db.server.insert\` with an explicit author.
- \`serverOnly()\` — trusted server and developer access only; direct
  app-user access is rejected.
- \`member()\` — per-group rows, shared through a membership table. Declare
  \`member({ group, membership, member_user, member_group })\`: \`group\` is the
  group-key column(s) on this table, \`membership\` names a sibling managed
  table that lists who belongs to which group, \`member_user\` is that table's
  user column, and \`member_group\` is its matching group-key column(s). A group
  key can be a single column or a same-arity list (a composite or polymorphic
  key). The platform scopes every structured query to the groups the signed-in
  user belongs to; an \`insert\` lands only if the user belongs to the group the
  row names, otherwise \`403 MEMBERSHIP_REQUIRED\`. A request with no verified
  user is refused with \`401 AUTH_REQUIRED\`. Declare both the scoped table
  and its membership table.

What happens on deploy:

- **First deploy**: tables are created, scoping is armed, and
  \`sw.db.insert\` / \`sw.db.from\` on an \`owner()\` table are user-scoped
  immediately — zero \`db_migrate\` or \`db_scope_set\` calls. The deploy
  response's \`warnings\` list what was created.
- **Additive changes apply**: a new table, a new nullable-or-defaulted
  column, a new index, a new unique group. Unchanged schema is a no-op.
- **Unmarked removals and shape changes refuse** with \`409
  SCHEMA_DEPLOY_REFUSED\` and a message naming the change.
- **Removals and renames do not apply to a live database**: \`removed()\`,
  \`removedTable()\` and \`renamedFrom\` are accepted by the schema file and can
  be explored on a preview copy, but a production deploy or a promotion that
  would remove or rename a table or column is refused before anything
  changes, so a running release never loses an object it uses. Keep the
  column or table declared and leave its data in place, or export it. Your
  data download and export are unaffected.
- **Leaving schema management** is \`old_table: exported()\`: the declaration
  is removed and the table + data stay untouched (structured queries on it then
  need a declared scope again).
- Declaring a table that **already exists** brings it under schema management
  (**adoption**) when the declared entry matches the live table and the table
  is eligible — a base table, no triggers, and (for \`owner()\`) the owner
  column present. A clean match applies zero DDL, arms scoping, and locks the
  table to the file; an ineligible or mismatched declaration is refused with the
  reason. Use \`db_import\` to generate the matching entry from a table you
  already have, review it, and deploy. Tables not named in the file are
  untouched.
- A \`db/schema.ts\` that isn't a somewhere schema declaration (another
  tool's file) deploys as plain source with a warning, as long as the
  project has no managed tables.
- A preview release applies managed \`db/schema.ts\` to the preview's own
  isolated copy; a production deploy applies it to production. Both use the
  same planner. SQL-world
  \`db_migrate\` can explicitly target an open preview clone.

## Owner-or-member and parent access

Import the policy helpers explicitly in \`db/schema.ts\`:
\`import { anyOf, parent } from 'somewhere/db';\`.

Use \`anyOf(owner(), member({ group: 'team_id', membership: 'team_members',
member_user: 'user_id', member_group: 'team_id' }))\` when both a row's
creator and its team members should be able to read, update, and delete the
row. This is collaborative editing, including deletion by other team members.
The membership table is declared separately. Ownership is set by the platform
on create.

For **team reading with owner-only editing and deletion**, restrict the member
branch:

\`\`\`ts
scope: anyOf(
  owner(),
  member({
    group: 'team_id',
    membership: 'team_members',
    member_user: 'user_id',
    member_group: 'team_id',
    operations: ['read'],
  }),
)
\`\`\`

\`operations\` restricts what membership grants: \`read\`, \`create\`,
\`update\`, and \`delete\`. Omit it for all four. Reading includes list,
get, counts, and related-row reads. The owner's authority remains independent;
a read-only teammate cannot edit or delete someone else's row. A standalone
\`member({ ..., operations: ['read'] })\` table is also read-only for members.
An empty list grants members nothing. Create-only membership is supported;
update or delete must also include \`read\`, because those operations return
row data. Upserts remain unsupported for member and policy scopes.
Browser \`client\` grants still control exposed operations and fields; they
cannot grant authority that the scope denies. Choose these permissions when
declaring the table: changing an existing managed table's scope is refused.

Creating a row requires an explicitly supplied, complete, non-null group key
and membership in that group. Ownership alone cannot authorize placing new
content in someone else's team. The membership check and insert are one
database statement. Group keys cannot be changed or incremented on update.
Creating a new group together with its initial memberships is application
logic in an authenticated function; it is not bootstrapped through an
owner-or-member browser insert.

For existing rows, owner-or-member access remains an OR: removing the
creator's membership does not remove their ownership or their permission to
read, edit ordinary fields, or delete their own row, subject to client grants.

For a task that follows its project, declare
\`project_id: integer({ references: 'projects' })\` and
\`scope: parent({ via: 'project_id' })\`. Use \`text\` instead of \`integer\`
when the parent has a UUID key. Access is checked against the referenced
parent's private owner, member, or owner-or-member scope. A parent's public
read grant does not propagate to its tasks. A policy-scoped child declares its
own browser operations and readable fields, and cannot declare \`publicRead\`.

A create supplies the parent ID explicitly and requires the parent scope to
authorize that operation. A parent granting only read authority cannot grant
child mutations.
A move requires access to both the current and proposed parent, checked in the same database statement;
browser moves also require the linking field in \`client.update\`. An ordinary
field update keeps the current parent. Use \`set\` to change the parent ID;
incrementing that linking field is refused. Each child operation checks the
parent's authority for that operation. Browser operation grants can narrow it
further.

This contract supports one parent hop through one scalar foreign key to an
\`id()\` column. It does not support parent chains, arbitrary policy expressions,
visitor policies, or arbitrary per-operation policy expressions. Live subscriptions,
composed transactions, and \`onConflict\` inserts over these policy scopes are
refused. A relationship
declaration alone never inherits access; \`parent({ via })\` is the explicit
authorization declaration.

## Two worlds: your database and the SQL database

Every table lives in exactly one world.

Tables declared in \`db/schema.ts\` are **your database** — managed. The
schema file is the only schema writer: schema ships with your code, scoping
is armed the moment a table exists, and destructive surprises are refused at
deploy. Managed tables are locked to the file — \`db_migrate\` and
\`db_scope_set\` on them return \`409 SCHEMA_MANAGED\`, and raw DDL on them
is refused at query time (\`SCHEMA_LOCKED\`) — edit \`db/schema.ts\` and
deploy instead.

A managed table's access scope is fixed at the deploy that created it.
Changing \`scope\` on an existing managed table is refused at deploy today —
\`409 SCHEMA_DEPLOY_REFUSED\`, the message naming the table and its current
scope, nothing applied, the previous version kept serving — whether or not
the table holds rows, and no amount of waiting changes that. The supported
path is to declare a NEW table name with the scope you want and move the
rows yourself (an export/import, or a function that copies them). A scope
declaration is keyed by table name. \`409 SCOPE_CHANGE_BLOCKED_BY_RELEASE\`
exists only for the pre-existing hand-declared scopes that \`db/schema.ts\`
takes over on a legacy project while a retained release still queries them.

Everything else is the **SQL database** — you write the SQL. \`db_migrate\`
applies schema changes (a production target is bookmarked first — a marker
in the database's 30-day history, not an undo, since restoring in place is
not available; keep dumps and exports for recovery),
\`db_scope_set\` declares access intent. On a SQL-mode project, ordinary
\`sw.db.query\` / \`sw.db.batch\` run whatever you write. This is a sibling,
not a legacy path: it is the right world for hand-tuned schemas and external
identity models. A managed project instead uses declared structured operations
by default; a raw read that they cannot express requires the explicit
\`sw.db.server.query\` / \`sw.db.server.batch\` namespace.

Where raw SQL is available, it stays trusted-as-written and unscoped. Managed
projects make that choice explicit through the \`sw.db.server\` read namespace.

## Managed mode — what a db/schema.ts does to raw SQL

Deploying a \`db/schema.ts\` that declares at least one table puts the whole
PROJECT into managed mode, not just the declared tables. From that deploy on,
inside deployed function code:

- Ordinary \`sw.db.query\` and \`sw.db.batch\` calls are refused before
  transport with \`MANAGED_RAW_SQL_REQUIRES_SERVER_AUTHORITY\` (403), even
  when passed \`{ unscoped: true }\` or \`{ asServer: true }\`.
- For a deliberate raw read, authorize the caller first and use
  \`sw.db.server.query(sql, params?)\` or
  \`sw.db.server.batch(statements)\`. These calls run as explicit server
  authority, read as written, and do not apply declared row permissions.
- Raw SQL cannot WRITE anything in managed mode. Every write vector — INSERT, UPDATE, DELETE,
  REPLACE, upsert, a mutating CTE, \`RETURNING\` on a write, DDL — is refused
  with \`MANAGED_RAW_WRITE_FORBIDDEN\` (403), on unmanaged tables too,
  including a table you create with \`db_migrate\` afterwards. The refusal is
  a capability boundary rather than SQL inspection, so no rephrasing gets a
  write through.
- Writes go through the composed builder: \`sw.db.insert\`,
  \`sw.db.update\`, \`sw.db.remove\`. A composed write needs a declared
  intent, so a table your functions write must be in \`db/schema.ts\` (or
  carry a \`db_scope_set\` intent).
- It applies to EVERY function, including job, queue, and cron handlers. A
  background handler whose body is a raw INSERT starts returning 403 the
  moment the schema file lands, and on the cron surface the only visible
  symptom is \`last_run_status: "failed"\` — read the failed run with
  \`job_get\` to see the code.

Developer authority is untouched: \`db_query\`, \`db_batch\`,
\`db_migrate\`, \`db_dump\`, the CLI, and the dashboard keep
full raw SQL against the same database.

The latch is one-way. There is no tool, flag, or setting that returns a
project to SQL mode. If functions need raw SQL writes, keep the project in SQL
mode. A managed project uses structured writes, including
\`sw.db.server.insert / update / remove / tx\` after application authorization
for deliberate server-authority writes.

## Managed-schema error codes

- \`SCHEMA_READ_FAILED\` (503, retryable, at deploy) — the platform could not
  read the project’s prior managed-schema state. Nothing was applied; retry.
- \`SCHEMA_APPLY_FAILED\` (503, retryable, at deploy) — the declaration was
  valid but its plan could not be applied safely. Nothing changed; retry after
  the message’s rollout or availability condition clears.
- \`SCHEMA_DEPLOY_REFUSED\` (409, at deploy) — \`db/schema.ts\` asked for
  something the deploy will not do silently: removing a column or table that
  still holds data, or changing a column's shape. Nothing was applied; the
  message names the exact fix.
- \`SCHEMA_DECLARATION_INVALID\` (400) — on every deploy path (fresh, full,
  patch, deploy-check, preview) the upload's \`db/schema.ts\` must read as a
  valid declaration and be sent in \`files\` as text: a syntax error, or the
  file sent under \`functions\` or as a binary file, is refused before
  anything is published. A full schema application additionally refuses a
  declaration of a platform-reserved table. The message explains the
  problem, with the line for syntax errors. A deploy with no \`db/schema.ts\`
  is unaffected.
- \`SCHEMA_MANAGED\` (409) — \`db_migrate\` or \`db_scope_set\` targeted a
  managed table. The schema file is that table's only schema writer: edit
  \`db/schema.ts\` and deploy. Nothing was changed.
- \`SCHEMA_LOCKED\` (409, at query time) — raw DDL (ALTER / DROP / …)
  targeted a managed table. Same rule, enforced at the query boundary: edit
  \`db/schema.ts\` and deploy.
- \`MANAGED_RAW_SQL_REQUIRES_SERVER_AUTHORITY\` (403, before transport) —
  ordinary \`sw.db.query\` / \`sw.db.batch\` ran in managed mode. Use declared
  structured operations, or authorize the caller and use the matching
  \`sw.db.server.query\` / \`sw.db.server.batch\` read.
- \`MANAGED_RAW_WRITE_FORBIDDEN\` (403, at query time) — raw SQL attempted a
  write in managed mode, including through \`sw.db.server.query\` /
  \`sw.db.server.batch\`. Use structured writes, or run the statement with
  developer authority (\`db_query\` / \`db_batch\`).

## What you get out of the box (the industry-standard checklist)

- **Multi-tenant isolation** — one database per project, bindings
  baked at deploy time, no shared schema.
- **Per-user scoping** — the structured builder
  (\`sw.db.from/count/insert/update/remove\`) auto-scopes a table declared
  user-owned to the request's verified user, with no user argument.
  Explicit \`sw.db.server\` calls bypass that scope only when chosen. See
  "Per-user scoping" below.
- **ACID transactions** — \`sw.db.tx([…])\` runs declared operations
  atomically. If statement 3 fails, 1 and 2 roll back. Same shape
  as Postgres \`BEGIN; …; COMMIT;\`.
- **A documented Postgres-flavored syntax subset is accepted** — \`$1, $2\` placeholders,
  \`ILIKE\`, \`NOW()\`, \`TRUE\`/\`FALSE\`, \`col->>'key'\`,
  \`RETURNING *\`, \`SERIAL\`, and \`BOOLEAN\` are translated
  automatically. Translation is literal- and comment-aware (so a column
  value of \`'ILIKE'\` is preserved). If you outgrow the default database,
  \`db_dump\` your data, perform the documented database-file-to-Postgres
  conversion, and replace \`sw.db\` with the destination client. A managed
  Postgres adapter is not a selectable backend or migration service.
- **Direct writes** — ordinary writes go straight to the project's database.
  The database schedules writes to one project one at a time; the platform does
  not add another write queue. Use \`sw.db.tx\` for related declared operations;
  SQL-mode projects can use \`sw.db.batch\` for raw statements. Transient
  backpressure can still be retried.
- **Recovery evidence and exports** — \`db_bookmark_create({ label })\` records
  a named marker around a production migration. It is
  operational evidence, not a customer undo point: \`db_restore\` is refused
  with \`DATABASE_RESTORE_UNAVAILABLE\` before anything changes. Use
  \`db_dump\` or \`db_export\` to create a recoverable copy outside the live
  database.
- **Schema introspection** — \`db_describe\` returns tables +
  columns + row counts + foreign keys in one call.
- **Runaway-query detection** — a query that monopolizes
  database resources is detected and surfaced automatically.

Full reviewer-facing depth: <https://somewhere.tech/llms.txt>.

## sw.db.query(sql, params?, options?)
Run raw SQL from a deployed function in a SQL-mode project. In managed mode,
ordinary \`sw.db.query\` is refused with
\`MANAGED_RAW_SQL_REQUIRES_SERVER_AUTHORITY\`; use declared structured calls
for ordinary access. The result shape is:

  {
    data: rows[],              // array of row objects (READ + RETURNING)
    error: null,               // never thrown; errors propagate as exceptions
    count: number,             // rows.length
    last_row_id: null,         // use the inserted row in data for its ID
    changes: number,           // rows touched (INSERT/UPDATE/DELETE)
  }

Use \`r.data\` for the rows. The MCP \`db_query\` tool returns a different
shape (\`{ data: { columns, rows, meta } }\`) because it surfaces the
raw platform response — don't confuse them. Inside functions it's
always \`r.data\`.

// SQL-mode project: raw read
const users = await sw.db.query(
  'SELECT id, email FROM users WHERE active = ? ORDER BY created_at DESC LIMIT ?',
  [1, 20]
)
// users.data = [{ id: 1, email: "alice@test.com" }, ...]
// users.count = users.data.length

// SQL-mode project: raw write
const result = await sw.db.query(
  'INSERT INTO users (email, name) VALUES (?, ?) RETURNING *',
  ['bob@test.com', 'Bob']
)
// result.data = [{ id: 3, email: "bob@test.com", name: "Bob" }]
// result.data[0].id = 3, result.changes = 1; result.last_row_id = null

## sw.db.server.query(sql, params?) / sw.db.server.batch(statements)

These are the explicit raw-read escape hatch for managed functions. Authorize
the caller before invoking them: the platform does not apply declared owner or
member permissions to the SQL and does not infer your business rule.

  const actor = await sw.auth.fromRequest(req);
  if (actor.role !== 'admin') return new Response('Forbidden', { status: 403 });
  const report = await sw.db.server.query(
    'SELECT owner_id, COUNT(*) AS n FROM emails GROUP BY owner_id'
  );

Signatures:

  sw.db.server.query(sql: string, params?: readonly unknown[]): Promise<SomewhereDbResult>
  sw.db.server.batch(statements: readonly SomewhereRawDbStatement[]): Promise<SomewhereRawBatchResult[]>
  type SomewhereRawDbStatement = { sql: string; params?: readonly unknown[] }

Server raw calls accept no options. They use the managed runtime's read-only raw
capability: reads run as written; writes and DDL are still refused. Use
\`sw.db.server.insert / update / remove / tx\` for deliberate server-authority
writes against declared tables.

## Whole numbers wider than JavaScript

Snowflake and Discord ids, and any \`bigint\` column imported from Postgres, are
64-bit whole numbers — wider than a JavaScript number is exact to. The platform
returns those columns as an exact decimal STRING rather than a rounded number,
so compare and re-write them as strings:

const r = await sw.db.from('events', { where: { id: '1804000000000000000' } })
// r.data[0].snowflake_id === "1804000000000000000"   (a string, exactly)

The same is true of the row a structured write returns: \`sw.db.insert\`,
\`sw.db.update\` and \`sw.db.remove\` project their affected row through that cast
themselves, so a write that touches a row holding a 64-bit id returns normally
with the id intact (changed 2026-09-02 — before that it applied the write and
then reported \`DATABASE_VALUE_TOO_LARGE\`).

On a SQL-mode project, raw \`sw.db.query\` runs exactly as written and is never
rewritten, so cast the column yourself in your own RETURNING clause:

// RETURNING * over a 64-bit column: applies the change, then reports
// DATABASE_VALUE_TOO_LARGE. The write DID happen — do not retry it.
await sw.db.query('UPDATE events SET seen = 1 WHERE id = ? RETURNING id, CAST(snowflake_id AS TEXT) AS snowflake_id', [id])

A structured write of a number outside the whole-number range the database
stores — below \`-9223372036854775808\` or above \`9223372036854775807\` — is
refused before the row is written, naming the column and the range, because the
database cannot hold it as a whole number at all. Store such a value as text.
A whole number past that range bound into a batch statement is refused the same
way, before the batch runs.

That is reading one. WRITING one back has the mirror constraint: a whole number
that wide cannot travel as a JSON number at all, because JSON parsing rounds it
before any platform code runs. A request body
carrying \`"params": [9223372036854775807]\` used to store 9223372036854776000
instead — a different number, with no error anywhere. Send it as a STRING, the
same form a read returns, and the round trip is lossless:

// exact, on every surface
await sw.db.query('INSERT INTO events (snowflake_id) VALUES (?)', ['1804000000000000000'])
await sw.db.insert('events', { snowflake_id: '1804000000000000000' })
db_query({ project_id, sql: 'UPDATE events SET snowflake_id = ? WHERE id = ?', params: ['1804000000000000000', 7] })

The column converts the digits on the way in because it is an integer column, so
the row holds a whole number, not text. A column declared with no type at all
has no affinity to convert it and would keep the text — declare such a column
\`INTEGER\`, or write it as \`CAST(? AS INTEGER)\`. A declared \`integer\` column in
\`db/schema.ts\` accepts that string too; text that is not a whole number is
still a \`TYPE_MISMATCH\`, and digits past the storable range are still
\`DATABASE_VALUE_TOO_LARGE\`.

A request that sends such a value as a bare JSON number is refused before
anything is written, with \`NUMBER_PRECISION_LOST\` naming the field, the
digits sent and the number that arrived (changed 2026-09-02 — before that it was
stored rounded, silently). Whole numbers up to 9007199254740991, decimals, and
larger whole numbers a JSON number happens to carry exactly are all unaffected.

In JavaScript itself — a deployed function, an SDK call, your own client — the
same limit is the language's: a numeric literal like \`9223372036854775807\` in
your source is already rounded before any platform code runs, and nothing can
recover it from there. That is why the refusal above can only catch a value
written as JSON text; keep ids of that size in strings end to end.

A database dump writes a value the database stores as a whole number as a bare
numeric literal, so restoring it produces a whole number again whatever the
destination column is declared as — including a column with no declared type.
A text column holding digits stays quoted (changed 2026-09-02 — before that
every wide whole number was quoted, and restored as text into a column with no
type to convert it).

A batch — \`db_batch\`, \`sw.db.batch\`, or statements sent together — returns
64-bit whole numbers in the same exact string form as a single query, so the two
paths agree on the same row (changed 2026-09-02: a batch used to return a
silently rounded number, 9223372036854776000 in place of 9223372036854775807).

One case a batch cannot return exactly: a batch that WRITES has already
committed every statement by the time its rows are read, so a \`RETURNING\` row
holding a 64-bit whole number is reported as \`DATABASE_VALUE_TOO_LARGE\` rather
than rounded. The message says the changes were applied — do not retry the
batch. Cast the column in that statement's own RETURNING list, or read the row
back afterwards:

// exact, in a batch that writes
{ sql: 'INSERT INTO events (name, snowflake_id) VALUES (?, ?) RETURNING id, CAST(snowflake_id AS TEXT) AS snowflake_id', params: [name, id] }

## Size boundaries

- SQL text is limited to 100,000 bytes per statement. A larger statement
  returns \`STATEMENT_TOO_LARGE\`; split bulk statements into batches.
- Treat 2,000,000 bytes as the documented portable maximum for a single string,
  binary value, or complete resulting row. The database may accept some larger
  values depending on the encoded row, but behavior above that supported
  maximum is not guaranteed; a rejection returns
  \`DATABASE_VALUE_TOO_LARGE\`.
- Large TEXT/BLOB values belong in \`sw.fs\`, with a path or URL stored in the
  row, before they approach the supported maximum.
- One project's database holds at most 10 GB. A write that would take it past
  that returns \`DATABASE_FULL\`. This ceiling is the same on every plan — it is
  not the plan allowance, which is your total database storage summed across
  all of your projects and does scale with the plan. So an account with room
  left in its total can still fill one project's database; the fix is to free
  space in that database (delete rows, or move large values into \`sw.fs\`) or
  to move part of the workload into a separate project.
- Database usage reporting is warning-only. Successful writes through the
  public database API and deployed functions refresh the byte snapshot when
  post-write size metadata is available. Some internal maintenance writes do
  not refresh usage in the same operation; a complete paginated database
  inventory reconciles every attached project database and remains
  authoritative. An accounting refresh failure never changes an
  already-committed write into an error.

## Per-user scoping — the structured builder, not raw SQL

Per-user scoping lives on the structured builder, never on raw SQL. There is
no \`{ user }\` option — the platform derives the user from the request's
verified credential and scopes automatically.

On a managed project, ordinary \`sw.db.query\` / \`sw.db.batch\` are refused.
If a raw read is truly required, choose server authority explicitly and enforce
the caller policy in the function:

  const me = await sw.auth.fromRequest(req);
  const emails = await sw.db.server.query(
    'SELECT * FROM emails WHERE user_id = ? ORDER BY created_at DESC LIMIT 20',
    [me.id],
  );

Passing \`{ user }\` to ordinary raw SQL is an error
(\`RAW_SQL_CANNOT_BE_PLATFORM_SCOPED\`, 403 before transport). Passing
\`{ unscoped: true }\` or \`{ asServer: true }\` does not opt an ordinary raw
call into server authority; use the \`sw.db.server\` namespace.

For automatic scoping, use the structured builder on a table declared
user-owned (an \`owner()\` table in \`db/schema.ts\`, or \`intent: 'scoped'\`
via \`db_scope_set\`):

  // auto-scoped to the request's verified user — no user argument
  const mine = await sw.db.from('emails', { order: [['created_at', 'desc']], limit: 20 });
  await sw.db.insert('emails', { subject: 'hi' }); // owner column set by the platform

The builder composes the SQL, binds every value, and injects the owner filter
from the verified request identity. Fail-closed:

- A structured query on a table with no declared intent throws
  \`TABLE_INTENT_REQUIRED\` before transport — declare it \`scoped\` (owner
  column), \`shared\`, or \`server_only\` first.
- A scoped INSERT/UPSERT sets the owner column to the request user; a scoped
  UPDATE cannot reassign it.
- Browser app-user database access uses the structured table API. Raw SQL at
  \`/v1/db/query\` and \`/v1/db/batch\` is refused for browser sessions.
- There is no grace interval. Once a serving bundle carries the scope,
  violations are blocked.

\`intent: 'server_only'\` marks a table for trusted server and developer access
only. Use \`{ asServer: true }\` for structured reads and \`sw.db.server.*\` for
structured writes or deliberate raw reads; direct app-user access is rejected.
Platform-managed tables such as \`auth_users\` are always treated as
\`server_only\` and cannot be declared \`scoped\` or \`shared\`.

### Builder verbs and where-shapes

Every verb takes plain objects, never a fluent chain. \`from(table, options?)\`
and \`count(table, options?)\` take one options object; \`update(table, { set?,
increment?, where? })\` and \`remove(table, { where })\` take their whole request as the
second argument; \`insert(table, values, options?)\` takes the row values, then
an optional \`{ onConflict: 'ignore' | 'update' }\`.
\`sw.db.update(...).set(...).where(...)\` does not exist and throws.

  // reads — a bare value in where is equals, so a numeric id is { id: 42 }
  const one  = await sw.db.from('notes', { where: { id: 42 }, limit: 1 });
  const open = await sw.db.from('notes', {
    where: { done: false, title: { contains: 'launch' } },
    order: [['created_at', 'desc']], limit: 20,
  });
  const { data: remaining } = await sw.db.count('notes', { where: { done: false } }); // Result<number>: the count is .data

  // date/number ranges — an array of single-operator conditions, AND-ed
  const week = await sw.db.from('events', {
    where: { starts_at: [{ gte: fromIso }, { lte: toIso }] },
  });

  // idempotent writes — upsert
  await sw.db.insert('signups', { email }, { onConflict: 'ignore' });   // keep the existing row
  await sw.db.insert('profiles', { handle, bio }, { onConflict: 'update' }); // update it with these values

  // update — set values, atomically add signed numeric deltas, or both
  await sw.db.update('notes', { where: { id: 1 }, set: { title: 'renamed' } });
  const bumped = await sw.db.update('counters', { increment: { count: 1 }, where: { id: 1 } });
  const reserved = await sw.db.update('inventory', {
    increment: { stock: -qty }, where: { id: itemId, stock: { gte: qty } },
  });
  if (reserved.changes === 0) return Response.json({ error: 'not available' }, { status: 409 });

  // remove — ONE options object: { where }
  await sw.db.remove('notes', { where: { done: true } });
  // → { data: [], count: 0, changes: 2 }

At least one of \`set\` or \`increment\` is required. Increment deltas are
finite non-zero signed numbers on declared numeric columns; a column cannot be
in both objects. The database performs the addition in the same scoped UPDATE,
so do not read then write or retry an unknown outcome. NULL and an integer result outside the exact supported range match zero rows
rather than being changed or approximated. Check \`changes\`: zero means the
caller scope, \`where\` guard, NULL, or overflow guard matched no row. \`where\` takes the
same operators as \`from\` and is OPTIONAL: omitting it matches every row the query is scoped
to, so on a \`shared()\` table \`sw.db.update('catalog', { set })\` updates
all rows authored by the signed-in caller. Both verbs return the same envelope as \`sw.db.query\`
(\`data\` carries the touched rows, \`changes\` counts them). On a
user-owned table both are scoped to the signed-in user automatically and
the owner column is not assignable.

Two argument mistakes are worth naming, because the errors read differently
than the mistake:

- A THIRD argument — the \`update(table, values, { where })\` shape other
  query builders use — throws \`SCOPE_ARGUMENT_REMOVED\` (400). Despite the
  wording, it does not mean you passed a scope: it means the verb takes
  exactly two arguments now. Merge your values into \`set\` and your filter
  into \`where\` in the ONE options object; do not just delete the extra
  argument, which would leave a table-wide update.
- A wrong option NAME throws \`VALIDATION_ERROR\` naming the accepted set,
  e.g. \`sw.db.update: unknown option "values". Allowed: set, increment, where.\`

Where operators, per column: a bare value (equals), \`null\` (IS NULL),
\`{ not: null }\` (IS NOT NULL), or a single-operator object — \`eq\`,
\`ne\`, \`lt\`, \`lte\`, \`gt\`, \`gte\`, \`like\`, \`in\`, \`contains\`,
\`startsWith\`, \`endsWith\`. One operator per condition object; an array of
condition objects on one column AND-s them (the range form above).

\`contains\` / \`startsWith\` / \`endsWith\` compose the search pattern for
you: the value is data, so \`%\` and \`_\` inside it match literally — a
user-typed search string is safe to pass as-is. \`like\` takes a
caller-authored pattern instead (its wildcards are your own); the value is
still bound, never spliced into the SQL.

### Related rows in server functions

Declare \`relations: { tasks: hasMany('tasks', 'project_id') }\` on the parent
table and \`references: 'projects'\` on the child's linking column. Then:

  const projects = await sw.db.from('projects', { include: ['tasks'], limit: 20 });
  // Each project in projects.data has a tasks array.
  const withOpenTasks = await sw.db.from('projects', { has: { tasks: { done: false } }, limit: 20 });
  // Only projects with at least one accessible matching task.

The platform composes the relationship and separately applies each table's
scope, including membership. A child the caller cannot access cannot make
\`has\` match. \`include\` fetches children separately after reading parents;
it does not promise a single snapshot. There is no caller-authored join
condition. In a browser use the paginated
\`data.projects.relations.tasks.list(projectId)\` operation instead.

### Named live views — sw.db.live(name, read)

A live query is declared in a server function. The browser calls that function,
receives the initial rows plus an opaque subscription URL, and listens for
invalidation. It never sends SQL, a table name, a predicate, an owner, a channel,
or a query plan to the database or the live transport.

  // api/open-notes.ts — the declaration and SELECT stay server-side
  export default async function (_req, sw) {
    return Response.json(await sw.db.live('notes.open', sw.db.from('notes', {
      where: { done: false },
      columns: ['id', 'title', 'done'],
      order: [['created_at', 'desc'], ['id', 'asc']],
      limit: 20,
    })))
  }

\`live\` is deliberately one verb with two arguments. There is no option bag.
The declaration must directly wrap one \`sw.db.from(...)\` call on a managed
table. Predicate values may be dynamic; the shape must be statically visible so
the deploy can pin it to the release and precompute \`dependencies[]\` plus the
table/column invalidation map. A live view is bounded and deterministic:

- \`limit\` must be a positive integer literal and \`order\` is required; the
  order must end with the table's primary-key column(s).
- \`offset\` and \`asServer\` are not allowed. Explicit \`columns\` must include
  the identity and order columns.
- Slice 1 supports \`owner()\` and \`shared()\` tables. A \`member()\` live
  declaration fails deploy with \`LIVE_VIEW_MEMBER_SCOPE_UNSUPPORTED\`; it is
  never degraded to a writer-only or mixed-member channel. \`anyOf(...)\` and
  \`parent(...)\` live declarations fail with \`LIVE_VIEW_POLICY_SCOPE_UNSUPPORTED\`.
- The name is unique in one release. An ordinary builder call is not live, and
  raw \`sw.db.query\` / \`batch\` can never feed a named live view.

The function result keeps the normal \`data\`, \`count\`, and write metadata and
adds \`live\`:

  {
    data: [{ id: 1, title: 'Ship', done: 0 }],
    live: {
      state: 'ready',
      name: 'notes.open',
      release_id: '...',
      fingerprint: '...',
      subscribe_url: 'wss://your-app.somewhere.site/__sw/live/subscribe?...',
      expires_at: 1780000000000,
    },
  }

The subscription URL contains a short-lived signed capability. Treat it as a
bearer capability and do not log it. The channel is derived by the platform from
the pinned release, declaration fingerprint, and an HMAC of the composed read's
subject; the raw subject id is not in the URL or channel. For \`owner()\`, the
same-origin WebSocket request must also carry the exact app-user or anonymous
cookie that executed the composed read. A copied ticket alone is insufficient.

  // browser — the loader re-calls a function, never the database
  import { watchLive } from '/__sw/live/client.js'

  const stop = watchLive(
    () => fetch('/api/open-notes', { credentials: 'include' }).then(r => r.json()),
    (rows) => render(rows),
  )

Every WebSocket frame is control only: \`live_control / resync_required\` means
"this declared view may now be stale." It never means "apply this row," and no
changed row is carried on the named-live wire. The fixed \`watchLive(load,
render)\` policy single-flights function refreshes, debounces invalidations for
100ms, obtains a fresh signed capability on reconnect, refreshes when the page
becomes visible, and refreshes at least every 30 seconds. The server also sends
\`resync_required\` immediately when the socket connects, closing the initial
query/connect race. These repairs are mandatory because a database commit and
WebSocket publication are not atomic; a failed publish must not leave the
browser stale indefinitely. There is no options bag for this policy.

Promotion and rollback send \`event: 'release_changed'\` and close the old
socket. Re-call the server function: subscriptions are never translated across
releases. Owner visibility is established from the same composed SELECT scope
and immutable request identity before the signed capability is minted. Shared
views use a release/view-wide channel because \`shared()\` declares every row
cross-user-readable. There is no mixed-owner channel and no egress filter.

A live view over an \`owner()\` table therefore needs a signed-in request:
the composed read runs first, under the same \`AUTH_REQUIRED\` rule as any
other structured query, and the capability is minted only for the identity
that executed it. There is no anonymous live view today.

\`insert(table, values, { onConflict: 'ignore' | 'update' })\` makes the
write idempotent against the table's declared primary-key/unique
constraints: \`'ignore'\` keeps the existing row untouched, \`'update'\`
updates it with exactly the values you passed. On a user-owned table the
owner column is platform-set and never part of the update, and the
conflict-update applies only when the existing row belongs to the signed-in
user — a unique-key collision with another user's row is a no-op, never a
cross-user overwrite.

### Cross-user reads — explicit server authority

\`sw.db.from(table, { asServer: true })\` and \`sw.db.count(table,
{ asServer: true })\` are the sanctioned way for trusted server code to read
across users on a user-owned table — admin screens, aggregates, background
jobs. Server mode never impersonates a request user. It deliberately bypasses
per-row ownership but does not bypass the intent requirement (an undeclared
table still refuses). It exists only on the read verbs and is not a browser
operation. Without it, an owner-table read with no verified
signed-in user fails \`AUTH_REQUIRED\` (401) with an error naming
\`{ asServer: true }\` as the sanctioned server-mode path.

For an admin report, leaderboard, JOIN, or other raw read that the structured
grammar cannot express, authorize the caller and select the server namespace:

  // Admin endpoint: see every project's email count.
  const allCounts = await sw.db.server.query(
    'SELECT owner_id, COUNT(*) AS n FROM emails GROUP BY owner_id',
  );

The platform never scopes or rewrites server-authority SQL. Ordinary raw calls
cannot be upgraded with an option; \`{ unscoped: true }\` and
\`{ asServer: true }\` are refused in managed mode. Raw SQL is also refused for
app-user browser requests; place it in an authorized server function.

## Declaring and removing a scope (SQL-world tables)

Tables declared in \`db/schema.ts\` carry their scope in the file — nothing
to declare here, and \`db_scope_set\` on them returns \`SCHEMA_MANAGED\`.
For tables you manage by hand, declare a table as user-scoped with the \`db_scope_set\` MCP tool,
\`POST /v1/db/scopes\` (developer key), or in-band from a function or
run_code as \`await sw.db.scope('notes', { owner_column: 'user_id' })\`:

  db_scope_set({ project_id: 'my-saas', table: 'notes', owner_column: 'user_id' })

- Re-call \`db_scope_set\` with \`intent: 'shared'\` (\`owner_column\` not
  required) to record that the table is intentionally cross-user.
- Re-call \`db_scope_set\` with \`intent: 'server_only'\` (\`owner_column\` not
  required) to reject direct app-user access while preserving trusted server
  and developer access.
- \`DELETE /v1/db/scopes/:table?project_id=…\` (developer key, direct
  REST) deletes the declaration entirely. No MCP tool wraps this route.

Scope declarations are baked into each function bundle. A changed declaration
must be baked before it changes live function behavior; the next deploy always
applies it. The scope-change API also attempts to rebake the current live
bundles and verifies activation against those bundles. If activation is not
confirmed, redeploy to apply the saved declaration.

## Placeholders: ? (positional) or $1, $2, ... (numbered)
Both styles work — pick one per statement, don't mix them.

// Numbered placeholders — params are reordered to match the $N indexes.
// Useful when the same value appears in multiple positions.
await sw.db.query(
  'UPDATE users SET name = $2, updated_by = $2 WHERE id = $1',
  ['u_123', 'Alice']
)

// Mixing ? and $N in one statement is rejected with VALIDATION_ERROR.

## sw.db.tx(intents) — all-or-nothing composed writes

One call, one to one hundred closed write intents, applied as a single atomic
batch: every intent is validated and rendered before anything is written, and
either all of them commit or none do. Each intent is exactly one of the
existing composed writes with the same table, value and \`where\` rules, and
the same ownership binding from the request:

\`\`\`ts
// Caller-supplied ids: nothing inside a batch can read another intent's result.
const orderId = crypto.randomUUID();
const r = await sw.db.tx([
  { op: 'insert', table: 'orders',      values: { id: orderId, status: 'pending', amount_cents: 4200 } },
  { op: 'insert', table: 'order_items', values: { id: crypto.randomUUID(), order_id: orderId, sku: 'tee-m', qty: 1 } },
  { op: 'update', table: 'carts',       set: { status: 'converted' }, where: { id: cartId, status: 'open' } },
  { op: 'remove', table: 'cart_items',  where: { cart_id: cartId } },
]);
// r is index-aligned with the intents; each entry is the ordinary write result:
// { data, error: null, count, changes, last_row_id } (+ live_delivery when a live view is affected)
\`\`\`

What it is not:

- **Not conditional fulfilment.** A zero-match \`update\` or \`remove\` is a
  successful no-op and the rest of the batch still commits. Read the returned
  rows per entry afterwards if you need to know (\`data\` / \`count\` are the
  matched-row receipt; \`changes\` is the execution-wide count and can exceed
  the matched rows when a trigger fires, so use it as diagnostic only). A
  batch never guarantees that a guarded transition matched. For "move the order to paid only if it is
  still pending, and record that", use the single guarded statement on the
  order row (docs({ topic: 'payments' })) — not a batch that would commit the
  record even when the transition matched nothing.
- **No reads, no result references.** Intents cannot read, and a later intent
  cannot use an earlier one's generated id. Supply stable ids yourself, as
  above; defaults and returned rows are still the database's.
- **Closed shapes only.** \`insert\` takes \`values\` and optional
  \`options: { onConflict: 'ignore' | 'update' }\`; \`update\` takes \`set\` and
  \`where\`; \`remove\` takes \`where\`. No raw SQL, no callback, no
  \`asServer\`, no project id inside an intent, no expected-change assertions.
  Anything else is a \`VALIDATION_ERROR\` before any write.
- **Membership-scoped tables are refused** in a batch (single writes to them
  still work): a post-execution membership denial could not roll back its
  siblings, so the batch refuses up front.
- **Ownership binds the same way as single writes.** Plain \`owner()\`
  requires a verified signed-in user; without one, the batch refuses with
  \`AUTH_REQUIRED\` before any write. Only a table declaring
  \`owner({ visitors: true })\` also accepts a verified visitor identity.
  Each intent checks its own table's declaration: enabling visitors on one
  table does not grant anonymous access to another. Project creation or
  claiming does not opt tables into visitor access. Tables your server writes
  on its own behalf must be declared \`serverOnly()\`.

Outcomes, four distinguishable cases:

- **Refused before execution — nothing written.** Shape or value validation
  (\`VALIDATION_ERROR\`), and isolation or readiness refusals
  (\`DRAFT_DB_NOT_ISOLATED\`, \`DEV_DB_NOT_ISOLATED\`, \`DB_CONNECTION_NOT_READY\`)
  happen before the batch is sent. Fix the cause and send again.
- **Rolled back — nothing kept.** A confirmed \`CONSTRAINT_VIOLATION\` inside
  the batch rolls every intent back; the error names the constraint.
- **Committed, then refused on the way back — do not replay.**
  \`DATABASE_VALUE_TOO_LARGE\` can also arrive AFTER the batch committed: a
  returned row holds an integer wider than JavaScript can carry exactly. Its
  message says the changes were applied. Honour it: never send the batch
  again; read the column back as text (\`CAST(... AS TEXT)\`) instead.
- **Unknown — not a rollback.** If the platform cannot confirm what happened,
  it answers \`DB_BATCH_OUTCOME_UNKNOWN\`. That is neither a rollback receipt
  nor an invitation to replay; check state before deciding.

A batch is reported successful only with a complete receipt for every
intent; zero-match writes are legitimate successes, missing or partial
provider results never are.

## sw.db.batch(statements)
Run multiple statements as one atomic transaction.
If ANY statement fails, ALL roll back. All-or-nothing.

This ordinary raw batch is for SQL-mode projects. In managed mode it is refused
with \`MANAGED_RAW_SQL_REQUIRES_SERVER_AUTHORITY\`. Use \`sw.db.tx\` or
\`sw.db.server.tx\` for declared operations. \`sw.db.server.batch\` is the
explicit managed raw-read batch; any write in it remains refused with
\`MANAGED_RAW_WRITE_FORBIDDEN\`.

const results = await sw.db.batch([
  { sql: 'DELETE FROM sessions WHERE user_id = ?', params: ['u_123'] },
  { sql: 'DELETE FROM posts WHERE author_id = ?', params: ['u_123'] },
  { sql: 'DELETE FROM users WHERE id = ?', params: ['u_123'] }
])
// results = [{ data: [], changes: 3 }, { data: [], changes: 12 }, { data: [], changes: 1 }]
// If the third DELETE failed, the first two would also roll back.

## sw.db.migrate — removed from functions; migrate as the developer
Run DDL (CREATE TABLE, ALTER TABLE, CREATE INDEX) with DEVELOPER credentials —
NOT from inside a deployed function. \`sw.db.migrate(...)\` was removed from the
function runtime (2026-05-21): a handler that calls it gets an error. Runtime
DDL is banned for three reasons: it runs on EVERY request instead of once;
it's un-versioned (no migration history, nothing to diff or roll back); and a
new table with an \`owner_id\`/\`user_id\` column is invisible to the platform's
per-user data protections — cross-user readable until it's declared scoped.
Migrate the schema ONCE, from outside the request path, with
\`somewhere call db_migrate '<json>'\` from a shell, the \`db_migrate\` MCP
tool without a shell, or the dashboard
Database tab. Functions then read/write rows with \`sw.db.query\`.

For tables declared in \`db/schema.ts\` there is no migration step at all —
edit the file and deploy; \`db_migrate\` on a managed table returns
\`SCHEMA_MANAGED\` (migrations on tables not declared in the file are
unaffected).

// developer-side — db_migrate MCP tool (NOT inside a function):
db_migrate({ project_id, sql: \`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    name TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
\` })

To rehearse SQL-world DDL without touching production, target one exact open
preview clone:

db_migrate({ project_id, target: "preview",
  preview_session_id: "draft_...", preview_id: "rel_...", sql: \`
  CREATE TABLE IF NOT EXISTS rehearsal (id INTEGER PRIMARY KEY);
\` })

Omit target fields to use production. A preview target requires
\`preview_session_id\`; \`preview_id\` is an optional exact-candidate guard.
Conflicting target names return \`DATABASE_TARGET_AMBIGUOUS\`; an unknown,
closed, expired, or mismatched preview returns \`PREVIEW_TARGET_INVALID\`.
Neither case falls back to production. Preview-targeted DDL persists across
candidates in that preview session, never merges into production, and is
discarded when the session is closed, promoted, or expires.

## sw.db.tables()
List all tables in the database. Returns string[].

const tables = await sw.db.tables()
// ['users', 'posts', 'sessions']

## SQL dialect
The default database keeps its own documented engine semantics. A documented
Postgres-flavored syntax subset is auto-translated:
NOW() → datetime('now')
TRUE/FALSE → 1/0
ILIKE → LIKE (case-insensitive by default)
SERIAL → INTEGER PRIMARY KEY AUTOINCREMENT
BOOLEAN → INTEGER
RETURNING * → supported

Translation changes syntax, not engine semantics. In particular:

- \`SELECT 1 / 0\` returns \`NULL\` rather than a division-by-zero error.
- Ascending order places \`NULL\` first unless \`NULLS LAST\` is explicit.
- \`LIKE\` is case-insensitive for ASCII by default.
- \`UPDATE … RETURNING\` and \`DELETE … RETURNING\` are supported.

## Common patterns

// Paginated list
const page = await sw.db.query(
  'SELECT * FROM posts ORDER BY created_at DESC LIMIT ? OFFSET ?',
  [pageSize, (pageNum - 1) * pageSize]
)

// Count
const total = await sw.db.query('SELECT COUNT(*) as count FROM posts')
// total.data[0].count = 42

// Upsert
await sw.db.query(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?',
  ['theme', 'dark', 'dark']
)

// Join
const postsWithAuthors = await sw.db.query(\`
  SELECT p.*, u.name as author_name
  FROM posts p JOIN users u ON p.author_id = u.id
  WHERE p.published = 1
  ORDER BY p.created_at DESC
\`)

## After a successful write — fan out instead of hand-rolling infrastructure

The database is the durable source of truth. Once a write commits, reach for
the built-in that matches the next moment:

- A composed, bounded page should update while users are watching → declare it
  server-side with \`sw.db.live(name, sw.db.from(...))\`. The browser calls the
  function and subscribes to its opaque URL; raw SQL is not subscribable.
- The action is a product event you will want to count →
  \`sw.analytics.track(...)\` or \`analytics_track(...)\`.
- Searchable content was created or edited → \`sw.search.upsert(...)\`
  or \`search_upsert(...)\`; the platform generates embeddings. Use
  \`ai_embed\` only when you need custom vectors for clustering or your own
  similarity math.
- Follow-up work needs retries or a status → \`sw.jobs.create(...)\` or
  \`job_create(...)\`. A side effect needs no status/result →
  \`sw.queue.push(...)\` or \`queue_send(...)\`.

Keep the database commit separate from these downstream calls and make the
downstream handler idempotent. Related topics: \`realtime\`, \`analytics\`,
\`search\`, \`sw.jobs\`, and \`sw.queue\`.

## Performance and query duration
Per-query latency is not fixed. Total time can include first-touch
activation, placement/transport, database scheduling, elapsed retry backoff, and SQL
engine time. Slow-query logs separate \`total_ms\`, provider-reported
\`engine_ms\`, residual \`non_engine_ms\`, execution path, placement, and retry
evidence. Engine and residual fields stay null when provider duration evidence
is missing or partial, and logs contain only a bounded statement kind rather
than SQL text or values. Requested retry backoff is identified as configured,
not measured wait; residual time is not proof that the SQL itself was slow.

The database enforces a 30-second hard query ceiling. \`sw.db.query\` does not
offer a shorter cancellation option. The external \`db_query timeout_ms\`
stops the caller waiting and returns \`QUERY_TIMEOUT\`, but does not promise
that work already accepted by the database was cancelled. Bound recursive
queries in SQL and use \`LIMIT\`; batch write bursts to reduce round trips.

## Change webhooks — developer-side registration

Get notified after every successful INSERT / UPDATE / UPSERT / DELETE.
One webhook per project. Payload is small and predictable; no row
contents are sent, so your webhook handler can't accidentally leak
sensitive data:

  { project_id, table, op, rows_affected, ts }

Register, read, or remove the webhook with developer credentials through
\`db_webhook_set\`, \`db_webhook_get\`, and \`db_webhook_delete\`, or the REST
surface below. \`sw.db.onchange\` is not available inside a deployed function.

Every POST carries:

  X-Somewhere-Signature: t={ms},v1={hmac-sha256-hex}

where the signed string is \`\${ms}.\${rawBody}\`. Verify with a
constant-time compare and reject requests where \`Math.abs(Date.now() - ms)\`
is over your replay tolerance (5 minutes is typical).

The webhook fires from waitUntil after the write commits, so your
handler's latency never blocks the developer's query. There is no
automatic retry — keep your endpoint idempotent and fast. The
registration row tracks last_status / last_error so you can see the
most recent delivery outcome via \`db_webhook_get\`.

Equivalent REST surface (developer key only):

  PUT    /v1/db/webhook                 { project_id, url, events? }
  GET    /v1/db/webhook?project_id=…
  DELETE /v1/db/webhook?project_id=…
`,

  'sw.fetch': `# sw.fetch — outbound HTTP fetch from a function

Use \`sw.fetch\` inside a deployed function or \`run_code\` when server-side code
needs to call a public HTTP or HTTPS API. This is the platform's structured
outbound-fetch helper; it is not an MCP tool and it is not the browser's
\`fetch('/api/...')\` call.

\`\`\`js
// api/weather.ts
export default async function (_req, sw) {
  const { data, error, response } = await sw.fetch(
    'https://api.example.com/weather?city=Oakland',
    {
      headers: { Authorization: \`Bearer \${sw.env.WEATHER_API_KEY}\` },
      timeout_ms: 8_000,
    },
  )

  if (error) {
    sw.logs.warn('Weather provider failed', {
      code: error.code,
      status: error.status,
    })
    return Response.json({ error: 'Weather is temporarily unavailable' }, { status: 502 })
  }

  return Response.json({ weather: data, upstream_status: response.status })
}
\`\`\`

## Signature and result

\`\`\`ts
const result = await sw.fetch(url, options)
// result = { data, error, response }
\`\`\`

- \`url\` is a public \`http:\` or \`https:\` URL.
- \`options\` accepts normal fetch options such as \`method\`, \`headers\`,
  and \`body\`, plus \`timeout_ms\`, \`retry\`, \`idempotent\`, and
  \`max_redirects\`.
- \`data\` is parsed JSON when the response Content-Type is JSON; otherwise
  it is text. A 4xx/5xx response can still have parsed \`data\`.
- \`error\` is \`null\` on a 2xx response. Otherwise it is a structured
  \`{ code, message, status? }\` value. Check it before using \`data\`.
- \`response\` is the raw Response when the request reached the upstream.
  It is \`null\` when validation, DNS, or connection setup failed.

## Plain \`fetch()\` in a deployed function

Plain \`fetch()\` reaches public HTTP and HTTPS hosts. Before sending, the
runtime refuses a destination in a private, loopback, link-local or
cloud-metadata range — written as a literal (\`SSRF_BLOCKED\`) or reached by
resolution (\`DNS_LOOKUP_FAILED\`) — and re-checks each redirect it follows,
up to its redirect limit. Resolution is checked at request time, not
continuously. A preview function cannot make outbound requests at all
(\`DRAFT_EGRESS_DENIED\`).

Behind the runtime, the platform's outbound guard refuses a request that
reaches it with a literal blocked target — a non-public address or internal
hostname, a URL with embedded \`user:password\`, a scheme other than
\`http:\`/\`https:\`, or a port other than 80, 443 or 1024 and above — with
a 403 carrying \`x-sw-outbound-error\`, before it leaves the platform. A
request the guard allows passes through unchanged. The guard classifies the
URL as written; it does not resolve names. Put credentials in an
\`Authorization\` header, never in the URL.

## Timeouts, retries, redirects, and safety

- Default timeout: 10 seconds per DNS lookup or outbound attempt. Maximum: 60
  seconds per attempt. Retries and redirects can make total wall time longer.
- GET and HEAD calls may retry transient network failures and 429/502/503/504
  responses up to two times. All other methods do not retry unless you
  explicitly pass \`idempotent: true\` or an idempotent retry object.
- Redirects are followed up to five times by default, and every redirect target
  is validated again.
- Private, loopback, link-local, and cloud-metadata destinations are blocked,
  including hostnames that resolve to those addresses.
- Each call makes a best-effort write of outbound-call telemetry to project
  logs without recording the full URL or request secrets.

For a non-idempotent POST, keep retries off:

\`\`\`js
const result = await sw.fetch('https://api.example.com/orders', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(order),
  retry: false,
})
\`\`\`

For a POST that the upstream explicitly makes idempotent, opt in:

\`\`\`js
const result = await sw.fetch('https://api.example.com/events', {
  method: 'POST',
  headers: { 'Idempotency-Key': event.id, 'Content-Type': 'application/json' },
  body: JSON.stringify(event),
  retry: { idempotent: true, retries: 2 },
})
\`\`\`

Plain global \`fetch()\` also exists in the function Web runtime. Use global
\`fetch('/api/...')\` in browser code for calls to your own app. For external
server-side HTTP, prefer \`sw.fetch\` for the structured result, timeout,
bounded retry, redirect validation, and project telemetry.
`,

  'typed-functions': `# Typed functions — one contract, both sides

Opt in per function. Declare the contract next to the handler; the browser gets
a typed client generated from what you actually deployed, not from a router you
maintain separately.

## Server — \`api/tasks/create.ts\`

\`\`\`ts
export const typed = 'somewhere:v1' as const
export type Contract = { input: { text: string }; output: { id: number; text: string } }
export default (async (req, sw) => {
  const { text } = await req.json()
  const r = await sw.db.query('INSERT INTO tasks (text) VALUES (?) RETURNING id, text', [text])
  return r.data[0]
}) satisfies ServerFunction<Contract>
\`\`\`

Three parts, all required: the \`typed\` sentinel, an exported \`Contract\` type
with \`input\` and \`output\`, and \`satisfies ServerFunction<Contract>\` on the
default export. A function without the sentinel is a normal function and keeps
working exactly as before — this is additive, never required.

## Browser — \`src/main.tsx\`

\`\`\`ts
import { api } from 'somewhere:api'
const task = await api.tasks.create({ text: 'ship' })
\`\`\`

\`somewhere:api\` is a virtual module the platform generates at deploy. The file
path determines the client path and the route: \`api/tasks/create.ts\` becomes
\`api.tasks.create(...)\` calling \`POST /api/tasks/create\`.

## What the platform does with it

Each deploy writes a manifest — one entry per procedure with its file, client
path, route, input type and output type — plus a \`contract_digest\` over the
whole surface. Because the digest is versioned with the release, the platform
compares the contract you are shipping against the one currently live and warns
when a change would break existing callers. That check is only possible because
the platform holds both the previous and the incoming contract.

## Portability — what you take with you

The contract is plain data at \`_internal/typed-functions.json\` inside the
release, and your handlers are ordinary async functions with no framework
imports. Porting means keeping the handler bodies and replacing the generated
client with any HTTP client — the routes are the same paths you already see.
There is no adapter to reimplement and no runtime to replace.

Related: \`functions\`, \`deploy\`, \`portability\`, \`sw.db\`.
`,

  'functions': `# Deployed Functions

<!--layer:contract-->
Server-side code that runs on the platform. Deploy via project_deploy.
File path = route path. api/hello.ts → /api/hello

## Compilation: ship .ts, not pre-built .mjs

You write \`api/chat.ts\` (with whatever imports it needs); the platform
compiles it to a self-contained function the runtime executes. You ship
the same files you write. **Do not pre-bundle.** No \`esbuild api/chat.ts
-o api/chat.mjs\`, no \`tsc\`, no \`vite build\` — \`/v1/deploy\` HARD-REJECTS
pre-built output (\`BUNDLED_DEPLOY_REJECTED\`) unless you explicitly pass
\`--prebuilt\`, enable the project setting, or send \`allow_bundled: true\`.

What works inside a function source file — **all natively, no
restructuring**:
- TypeScript syntax (type annotations, interfaces) — stripped.
- Type-only imports (\`import { type X } from './types'\`) — stripped.
- Imports from ANY folder, not just \`_lib/\` —
  \`import { foo } from '../utils/helpers'\`,
  \`import { z } from './schemas'\`, etc.
- **No extension required** — \`'./helper'\` resolves to
  \`./helper.ts\`/\`.tsx\`/\`.js\`/\`.mjs\`/\`.json\` automatically.
- **JSON imports** — \`import data from './seed.json'\` works ONLY when the
  \`.json\` is part of your function source set (uploaded alongside your
  handlers, not as a separate static asset). A \`.json\` that lives in your
  static \`files\` — or a blob in a parent folder — is NOT a bundler module
  and fails to compile with \`No such module\`. For data you deploy as a
  static file, read it at runtime with \`sw.fs.read()\`; inline small
  constants directly in code.
- Runtime built-ins — \`node:*\` standard-library compatibility modules and
  \`cloudflare:workers\` pass through. Common examples are \`node:crypto\`,
  \`node:buffer\`, \`node:events\`, \`node:path\`, \`node:stream\`,
  \`node:string_decoder\`, \`node:util\`, and \`node:url\`.
  \`node:fs\` also loads, but it is temporary scratch space, not storage:
  only \`/tmp\` is writable, and everything written there is gone after the
  response. Use \`sw.fs\` for any file that must persist.

**npm packages resolve at deploy, with three limits you will meet** — declare
them in \`package.json\` and the platform bundles them (no npm install).
Pure-JS packages that keep to web-standard APIs work (\`nanoid\`, \`date-fns\`).
A package that needs Node built-ins the bundler does not provide (\`stripe\`
imports \`crypto\`/\`http\`/\`https\`) is refused at deploy with
\`FUNCTION_BUILD_ERROR\` naming the file; a native module (\`sharp\`) is refused
the same way. A package that assigns over an inherited built-in prototype
property while it loads (\`zod\` and \`lodash\` do) currently deploys green and
then fails on the first request with \`FUNCTION_MODULE_LOAD_FAILED\` — the
function runtime freezes the core prototypes on purpose, and a fix that keeps
that protection is in flight. Prefer web-standard APIs where they suffice, and
check \`errors\` after the first request. Declare versions in \`package.json\`;
\`zod@^3.22\` is a range, and a range resolves at deploy time. To pin
exactly, ship a \`package-lock.json\` (version 2 or 3) — see docs({ topic:
'deploy' }) → "Dependencies and lockfiles". A compiled release records the
package versions and relationships it selected or bundled and never
re-resolves. No build step on your side — you deploy raw source and the
platform handles it.

<!--layer:surface-->
## Format
Every function file has one default export:

// api/hello.ts
export default async function(req, sw) {
  return Response.json({ hello: 'world' })
}

req = standard Request object (method, headers, json(), text(), etc.)
sw = project-scoped platform context with all services

## Runtime and outbound networking

Functions run in a Workers-compatible Web runtime, not a Node server process.
Available Web APIs include \`Request\`, \`Response\`, \`Headers\`, \`URL\`,
\`URLSearchParams\`, \`fetch\`, \`WebSocket\`, \`crypto\`, \`TextEncoder\`,
\`TextDecoder\`, \`ReadableStream\`, \`WritableStream\`, \`TransformStream\`,
\`Blob\`, \`FormData\`, timers, and \`AbortController\`.

Plain \`fetch()\` can call any public HTTPS endpoint. Prefer \`sw.fetch()\` for
URLs influenced by users: it adds private/metadata-address blocking, DNS and
redirect validation, a default 10-second timeout (60-second maximum), bounded
redirects, structured results, logging, and safe retries for idempotent calls.
Raw TCP sockets and listening ports are not part of the customer runtime
contract; use HTTPS or an outbound WebSocket.

## sw.endpoint — auth + validation + rate-limit (usually what you want)

The bare \`export default async function(req, sw)\` above always works, but
most endpoints need auth, body validation, or a rate limit. \`sw.endpoint\`
folds all of that in so you only write business logic. It is optional —
reach for it when you want auth, validation, and rate-limiting handled
for you; the bare function form above always works too:

// api/signup.ts
export default sw.endpoint({
  auth: 'none',                                  // 'required' | 'optional' | 'none'
  body: { email: 'email', password: 'string' },  // validated → 400 on mismatch
  rateLimit: '5/minute',                         // → 429 + Retry-After
  handler: async ({ body, user }, sw) => {
    const u = await sw.auth.signup(body.email, body.password);
    return { ok: true, user_id: u.id };           // plain object → Response.json
  },
});

Full reference (schema types, handler args { body, user, headers, params,
request }, error formatting, CORS): \`docs({ topic: 'sw.endpoint' })\`.

## sw services available
sw.db      — database (query, batch, from/insert/update/remove, live, tables)
sw.fs      — file storage (read, write, delete, move, stat, list, glob, diff, search, replace)
sw.email   — send email (send)
sw.ai      — AI models (complete, embed, transcribe, tts, generateImage, catalog)
sw.agent   — inline/durable model-tool loops (run, start, status, cancel)
sw.env     — environment variables (sw.env.STRIPE_KEY etc.)
sw.jobs    — background jobs (create)
sw.queue   — fire-and-forget work (push)
sw.logs    — application logging (write)

## Routing
File path becomes the URL path:
  api/hello.ts           → /api/hello
  api/users/list.ts      → /api/users/list
  api/auth/login.ts      → /api/auth/login

Parametric segments use square brackets and become req.params:
  api/sites/[id].ts          → /api/sites/123   → req.params.id === '123'
  api/users/[userId]/posts.ts → /api/users/42/posts → req.params.userId === '42'
  api/files/[...path].ts     → /api/files/a/b/c  → req.params.path === 'a/b/c'

[name]     — single-segment placeholder
[...name]  — catch-all, must be the last segment, matches one or more segments

Specific routes beat dynamic ones. api/sites/new.ts wins over api/sites/[id].ts
for /api/sites/new. [...rest] only matches when nothing more specific does.

A function fetching its OWN origin (https://<project>.somewhere.site/...) hits
the function router, NOT your static files — an unmatched path returns
FUNCTION_NOT_FOUND (404), even for a path that serves fine to an external
browser. Don't self-fetch your own static URLs: read static assets with
sw.fs.read() or inline them. (External clients still get the static file — only
the function's own same-origin subrequest skips the static fallback.)

All HTTP methods hit the same function. Check req.method inside:

export default async function(req, sw) {
  if (req.method === 'GET') {
    const users = await sw.db.query('SELECT * FROM users')
    return Response.json(users.data)
  }
  if (req.method === 'POST') {
    const body = await req.json()
    await sw.db.query('INSERT INTO users (email) VALUES (?)', [body.email])
    return Response.json({ ok: true })
  }
  return new Response('Method not allowed', { status: 405 })
}

## Reading route params

For parametric routes, req.params holds the decoded segment values:

// api/sites/[id].ts
export default async function(req, sw) {
  const site = await sw.db.query(
    'SELECT * FROM sites WHERE id = ?',
    [req.params.id]
  )
  if (!site.data.length) return new Response('Not found', { status: 404 })
  return Response.json(site.data[0])
}

// api/files/[...path].ts
export default async function(req, sw) {
  const file = await sw.fs.read(req.params.path)
  return new Response(file)
}

## Outbound WebSocket client
A function can open an OUTBOUND WebSocket to another server — a
server-to-server realtime bridge — with a fetch upgrade:

export default async function(req, sw) {
  const resp = await fetch('https://example.com/stream', {
    headers: { Upgrade: 'websocket' }
  })
  const ws = resp.webSocket
  ws.accept()
  ws.send('hello')
  ws.addEventListener('message', (e) => { /* handle e.data */ })
  return new Response('bridged')
}

This is for connecting OUT to someone else's socket. To push updates to your
OWN app's browser clients, declare a live view over the data they are
watching — realtime channels do not accept app-user sessions. See
docs({ topic: 'realtime' }).

## Secrets / env vars
Set via dashboard Settings or env MCP tool.
Access inside functions as sw.env.KEY_NAME:

export default async function(req, sw) {
  const apiKey = sw.env.STRIPE_SECRET_KEY
  const response = await fetch('https://api.stripe.com/v1/charges', {
    headers: { 'Authorization': 'Bearer ' + apiKey }
  })
  return new Response(response.body)
}

## Binary files in deploy
Static files go in the files parameter.
Binary files (images, fonts) go in binary_files as base64:

project_deploy({
  project_id: "my-app",
  files: {
    "index.html": "<html>...</html>",
    "api/hello.ts": "export default async (req, sw) => Response.json({ ok: true })"
  },
  binary_files: {
    "images/logo.png": "iVBORw0KGgo..."
  }
})

## Redirects

There is no \`sw.redirect\`. Return a standard redirect response with an
ABSOLUTE URL: \`return Response.redirect(new URL('/billing', req.url).toString(), 302)\`.
A relative location is not a valid redirect target inside a deployed function.

## What NOT to do
- NEVER deploy a separate backend, Express server, or external BFF — the platform IS your backend
- NEVER put secrets in the files parameter (use env vars)
- NEVER call api.somewhere.tech from inside a function (use sw directly)
- NEVER install or import @somewhere-tech/sdk inside functions (use sw)
`,

  'sw.fs': `# sw.fs — File Storage (inside deployed functions)

Read, write, delete, and manage files in the project's storage.
Direct access, no HTTP. Files are PRIVATE by default — pass
\`visibility: 'public'\` on the write (or call the make-public action)
to serve a file at its public \`/storage\` URL.

There are two file surfaces: deployed source is read with
\`project_files_list\` / \`project_file_read\`; \`sw.fs\` is runtime
storage for uploads and generated files. If you want \`src/App.tsx\`
or \`api/foo.ts\`, use \`project_file_read\`, not \`sw.fs.read\`.

## What you get out of the box (the industry-standard checklist)

- **File-level ACL (visibility).** Every file row carries a
  \`visibility\` flag (\`public\` | \`private\`); the platform checks
  it before bytes go out the door. Bucket-level ACLs alone can't
  give you private-by-row.
- **Object versioning + content-addressed writes.** Every write
  generates a new immutable object with a content-hash suffix and
  swaps the metadata pointer atomically. A half-written file never
  becomes visible.
- **Safe-delete pattern.** Metadata is marked deleted first; byte
  cleanup is deferred and reconciled by an integrity-check cron.
  Files never vanish before the metadata says they did.
- **Versions + retention** by tier (3 / 10 / 50 / unlimited prior
  versions kept).
- **Signed URLs with TTL** via \`sw.fs.signedUrl(path, { expiresIn })\`.
- **SSRF protection on every platform-side fetch** (render, scrape,
  webhooks, AI ingest) — private and metadata IPs blocked before
  the request leaves.
- **Full-text + path-glob search** via \`fs_search\`.

Full reviewer-facing depth: <https://somewhere.tech/llms.txt>.

## sw.fs.write(path, content, options?)
const result = await sw.fs.write('/uploads/avatar.png', binaryData, {
  content_type: 'image/png'
})
// result = { ok: true, data: { path: '/uploads/avatar.png',
//            size_bytes: 12400, content_type: 'image/png', version: 1 } }
// Read fields off result.data — e.g. result.data.path, result.data.size_bytes
// (size_bytes, NOT size). result.path is undefined.

## sw.fs.read(path, options?)
const file = await sw.fs.read('/uploads/avatar.png')
// Success: Response object — file.arrayBuffer() / file.text() / file.json()
// Failure: throws an error with code, status, and message. Missing files throw
// NOT_FOUND (404); an error response body is never returned as file content.
// This also applies to line-range reads. Catch the error to handle absence.
// Apps deployed before this behavior shipped need a new deploy to receive it.

// Directory listing
const files = await sw.fs.read('/uploads/')

// Read a line range from a stored text file (returns parsed JSON)
const slice = await sw.fs.read('/logs/import-run.txt', { lines: [50, 75] })
// slice = { content: '...', lines: [50, 75], total_lines: 420 }

## sw.fs.list(path, options?)
// Directory listing. Pass { recursive: true } for the full subtree,
// or { recursive: true, depth: 2 } to cap the walk.
const all = await sw.fs.list('/uploads/', { recursive: true })
// all = { path: '/uploads/', type: 'directory', entries: [...] }

## sw.fs.dev — project-wide file view (run_code only)
// sw.fs.dev.* operates with PROJECT authority over every file in the project,
// not a single user's. It is available ONLY in run_code — the developer-
// authenticated context. It is ABSENT in every deployed-function handler:
// request, cron, queue, and job handlers alike (a cron/job reaches your code as
// an HTTP call, so it does not carry project authority). In a handler, sw.fs.dev
// is undefined; the default sw.fs.search / sw.fs.diff / sw.fs.glob throw
// FS_DEV_ONLY naming run_code. A cron/job's DEFAULT sw.fs writes have no acting
// user, so they land project-owned and keep working — only the project-wide
// scanners are run_code-only. Those three have no per-user form; model per-user
// data in sw.db.

## sw.fs.dev.glob(pattern, options?)
// Match file paths against a glob. Metadata only — no content reads.
// Supported: *, **, ?, {a,b,c}.
const cachedJson = await sw.fs.dev.glob('/cache/**/*.json')
// cachedJson = {
//   pattern: '/cache/**/*.json',
//   matches: [{ path, size_bytes, content_type, version, updated_at }, ...]
// }

## sw.fs.dev.diff(path, options?)
// Unified diff between the current file and an archived version.
// Defaults to the most recent previous version.
const d = await sw.fs.dev.diff('/config/runtime.json')
// d = { path, from_version: 3, to_version: 4, changed_lines: 5, diff: '@@ ...' }
//
// Or diff against a specific version:
await sw.fs.dev.diff('/config/runtime.json', { version: 2 })

## sw.fs.delete(path)
await sw.fs.delete('/uploads/old-file.txt')
// Directory deletes are recursive

## sw.fs.move(from, to, opts?)
await sw.fs.move('/uploads/temp/photo.jpg', '/uploads/users/alice/photo.jpg')
// Instant regardless of file size.
//
// To replace an existing destination, pass { overwrite: true } —
// this is an atomic-enough swap (destination row dropped before the
// source rename, blob cleanup deferred to waitUntil). Use it instead of
// the delete-then-move pattern, which can race and leave metadata
// pointing at bytes that no longer exist:
//
//   // ❌ Don't do this — racy across concurrent invocations:
//   await sw.fs.delete('/avatars/alice.jpg').catch(() => {})
//   await sw.fs.move('/avatars/alice.upload', '/avatars/alice.jpg')
//
//   // ✅ Do this — single atomic operation:
//   await sw.fs.move(
//     '/avatars/alice.upload',
//     '/avatars/alice.jpg',
//     { overwrite: true }
//   )
//
// Without overwrite, a destination collision returns
// VALIDATION_ERROR ("Destination ... already exists").

## sw.fs.copy(from, to)
await sw.fs.copy('/templates/welcome.html', '/users/alice/welcome.html')
// Server-side copy. Instant — no bytes flow through your function.

## sw.fs.versions(path)
const versions = await sw.fs.versions('/config/runtime.json')
// Each write creates a new version. Returns most-recent first:
// [{ version: 7, size, content_type, created_at }, ...]

## sw.fs.restore(path, version)
await sw.fs.restore('/config/runtime.json', 5)
// Restores a previous version (from sw.fs.versions) as the latest.
// Original versions stay in history.

## sw.fs.stat(path)
const info = await sw.fs.stat('/uploads/avatar.png')
// { path, type: 'file', size, content_type, version, created_at, updated_at }

## sw.fs.dev.search({ path?, query, limit?, max_files? })
// Full-text search across text files under a directory. A per-project
// search index is maintained automatically on every fs write/delete/
// move/replace, so searches stay fast as the project grows.
const hits = await sw.fs.dev.search({ path: '/logs/', query: 'TODO' })
// hits = {
//   query: 'TODO', path: '/logs/', mode: 'fts5', total_matches: 7,
//   results: [
//     { path: '/logs/import-run.txt', snippet: 'TODO: retry row 42' },
//     ...
//   ]
// }
// mode is 'fts5' once the index is built (typical), or 'scan' on the
// first-ever search (fallback walks storage line-by-line and returns
// { path, line, snippet, before, after }; the index backfills in the
// background, so the next query is fast).
// Defaults: path '/', limit 50, max_files 500. Binaries and files
// over 1 MB are skipped by the indexer (large files truncated to
// first 1 MB). Case-sensitive.

## sw.fs.replace({ path, find, replace })
// Find-and-replace on a single file, server-side — no read-modify-write
// cycle. Archives the current version before writing (rollback via fs.restore).
const result = await sw.fs.replace({
  path: '/src/config.ts',
  find: "API_URL = 'https://staging.example.com'",
  replace: "API_URL = 'https://api.example.com'",
})
// result = { ok: true, replacements: 1, path: '/src/config.ts', version: 4 }
// Literal match (not regex). Text files only.

## sw.fs.uploadFromRequest(req, { path, maxBytes?, allowedTypes?, fieldName?, public? })
// One-call upload handler for browser <input type="file"> forms. Parses
// multipart/form-data from the request, validates size + type, writes to
// storage, returns a short-lived signed URL for the private file by default.
// Pass public: true only for a world-readable file; then url is its permanent
// /storage URL. The result includes visibility so the caller can tell which.
//
// The whole point: the developer chooses the path, the helper handles
// every failure mode. Three lines instead of fifteen, and you never
// JSON-stringify raw bytes (which is what corrupts images on project_patch
// — use binary_files for asset deploys, sw.fs.uploadFromRequest for
// runtime uploads).
//
// In api/upload.ts:
export default async function handler(req, sw) {
  const user = await sw.auth.fromRequest(req)
  if (!user) return new Response('unauthorized', { status: 401 })
  const { url, path, size, contentType } = await sw.fs.uploadFromRequest(req, {
    path: \`/uploads/\${user.id}/\${crypto.randomUUID()}.bin\`,
    maxBytes: 5 * 1024 * 1024,                     // optional, 5 MB cap
    allowedTypes: ['image/png', 'image/jpeg'],     // optional whitelist
    fieldName: 'file',                             // optional, default 'file'
  })
  return Response.json({ url, path, size, contentType })
}
// On the browser: const fd = new FormData(); fd.append('file', input.files[0])
//                 const r = await fetch('/api/upload', { method: 'POST', body: fd })
//                 const { url } = await r.json(); img.src = url
//
// Throws on every failure with a stable code in the message:
//   UPLOAD_PATH_REQUIRED, UPLOAD_NOT_MULTIPART, UPLOAD_PARSE_FAILED,
//   UPLOAD_FIELD_MISSING, UPLOAD_TYPE_NOT_ALLOWED, UPLOAD_FILE_EMPTY,
//   UPLOAD_TOO_LARGE
// Wrap in try/catch and map to the HTTP status you want.
//
// For files larger than ~25 MB, mint a signed URL with sw.fs.uploadUrl
// instead and have the browser PUT direct — keeps the bytes off your
// function CPU.

## sw.fs.uploadUrl({ path, maxSize?, contentType?, expiresIn? })
// Mints a short-lived signed URL the browser can PUT bytes to directly
// — without ever seeing your platform key. Use this for big uploads
// (videos, large images, archives) so the bytes don't round-trip through
// your function.
const { url } = await sw.fs.uploadUrl({
  path: '/uploads/users/alice/photo.jpg',
  maxSize: 10 * 1024 * 1024,         // optional, defaults to tier max
  contentType: 'image/jpeg',         // optional, '*' if omitted
  expiresIn: 300,                    // optional, seconds (default 300, max 3600)
})
// Browser side:
//   await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: file })
// Returns { path, size_bytes, content_type, version }.

## sw.fs.signedUrl(path, { expiresIn? })
// Mints a short-lived URL anyone can GET to download the file — no
// platform key, no app-user JWT. Use for email attachments, image
// previews, share links, "download once" handoffs. Default 1h, max 7d.
const { url, expires_at } = await sw.fs.signedUrl('/uploads/invoice-42.pdf', {
  expiresIn: 3600,                   // optional, seconds (60..604800)
})
// → url: 'https://api.somewhere.tech/v1/fs-signed/<token>'
// → expires_at: ISO 8601 string
// Send the url in an email body, embed it in <img src=...>, etc.
// The URL stops working at expires_at; rotating JWT_SECRET invalidates
// every outstanding signed URL (bulk revocation lever).

## sw.fs.public_url(path, { makePublic? })
// Returns a file's permanent, unauthenticated public URL. Asking for the
// URL does NOT silently expose a private file:
//   - already-public file        → returns the URL, visibility unchanged.
//   - private file + makePublic   → publishes it, returns the URL.
//   - private file, no opt-in     → throws FILE_PRIVATE (file stays private).
// For a time-limited link to a private file WITHOUT making it world-readable,
// use sw.fs.signedUrl(path) instead.
const { public_url } = await sw.fs.public_url('/uploads/avatar.png', {
  makePublic: true,                  // required to publish a private file
})
// → public_url: 'https://myapp.somewhere.site/storage/uploads/avatar.png'

## Public URL
Files written with \`visibility: 'public'\` are served (no auth) at:
https://{subdomain}.somewhere.site/storage/{path}
Private files (the default) return 404 here — they're reachable only from
your authenticated code (sw.fs.read) or a signed URL.

const url = 'https://myapp.somewhere.site/storage/uploads/avatar.png'
// Use this URL in HTML: <img src="\${url}" />

## Integrity check (developer key only)
// POST /v1/fs/:project_id/integrity-check  { auto_clean?: bool, limit?: int, cursor?: string }
// Scans file metadata for rows pointing at missing blobs — the "ghost
// file" failure mode (fs.stat says exists, fs.read 404s). Returns the
// list of orphans; pass auto_clean:true to delete the stale rows.
//
// fs.read already self-heals one row at a time on 404. This is the
// proactive sweep for post-incident cleanup or mass-delete recovery.
// Paginate via { cursor: <next_cursor> } for large projects (default
// 1000 rows / call, max 5000).
`,

  'sw.auth': `# Auth — End-User Authentication

Built-in user management for the people who USE your app. They sign up,
log in, reset passwords, verify email — and inside deployed functions
you call all of it through \`sw.auth.*\` without managing API keys or
URLs. \`sw.auth\` is the same shape as \`sw.email\` or \`sw.ai\`:
the platform's REST surface wrapped, scoped to your project, ready to
go.

## Security model (the industry-standard checklist)

- **Tenant-scoped signing keys (per-project HKDF derivation).** Each
  project's JWT signing key is derived from a master secret +
  project ID via HKDF-SHA256. A leaked token in project A can't
  forge anything in project B.
- **Immediate revocation via \`token_version\`.** Bump the column on
  \`platform_users\` and every existing JWT for that user fails the
  next verify — no separate revocation store needed.
- **Atomic single-use tokens** for password reset / magic link /
  refresh / MFA. Consumption uses
  \`UPDATE … WHERE token = ? AND consumed_at IS NULL\` so two
  parallel uses can't both succeed.
- **MFA (TOTP)** built in: enroll / verify / unenroll / challenge
  + recovery codes.
- **OAuth (Google, GitHub, Discord)** as first-class flows — the platform owns the
  callback, sets the cookie, no \`passport\` boilerplate.
- **Header-based auto-refresh.** If the access token is in its last
  10% of TTL and a refresh token rides along, the platform mints a
  new pair, runs the request under the refreshed identity, and
  returns the new pair on \`X-New-Access-Token\` /
  \`X-New-Refresh-Token\`. No 401-loop in your client code.
- **Built-in per-user scoping** — covered in the \`sw.db\` topic. The
  structured builder (\`sw.db.from/insert/update/remove\`) auto-scopes a
  declared owner table to the request's verified identity. In managed mode,
  ordinary \`sw.db.query\` / \`sw.db.batch\` calls are refused; adding a
  handwritten \`WHERE user_id = ?\` does not authorize them. An intentional
  raw read requires \`sw.db.server.query\` / \`sw.db.server.batch\` after
  your function authorizes its caller. Those explicit server calls run as
  written, without automatic ownership filtering. See \`sw.db\` for the
  managed-mode write limits and the separate SQL-mode contract.
- **Role-based access control (RBAC) — platform layers.** Platform
  admin (\`platform_users.is_admin\`), project membership
  (\`project_collaborators\`), API-key authority
  (\`developer | admin | cli_pair\` via \`api_key_authority\`), and
  subscription tier all gate what an actor can do. Your app's own
  end-users have a platform-owned \`user | admin\` role. Enforce it
  server-side with \`sw.auth.requireUser(req, { role: 'admin' })\`.
  Signup always creates \`user\`; only owner tooling authenticated by a
  developer key can grant \`admin\` through \`auth_user_update\`, so a
  public signup or app-user profile request cannot self-promote.

Full reviewer-facing depth: <https://somewhere.tech/llms.txt>.

For agent-driven flows from your tools, the same surface is exposed as
MCP (auth_signup, auth_login, auth_me, auth_refresh, auth_users_list,
auth_user_delete, auth_user_update, auth_google_url) and as REST under
/v1/auth/*.

## Token types

Every signup/login returns three tokens:
  token          — short-lived JWT (1 hour). Used as Bearer on protected
                   endpoints. Sent by the browser on every API call.
  refresh_token  — 30 days. Single-use; rotates on every refresh. Use it
                   to mint a fresh access token without making the user
                   log in again.
  session_token  — opaque server-side session. Pass to logout to revoke.

The smt_ developer key is for YOUR backend. App-user JWTs are for the
end user's browser. \`sw.auth\` holds the developer key for you — you
never type \`smt_\` inside a function.

## Scoped developer keys

Developer keys can be limited to specific API areas at mint time —
right for CI jobs and single-purpose automations that shouldn't hold
full account authority:

  POST /v1/keys
  { "name": "ci-embeddings", "scopes": ["ai:complete", "db"] }
  → { id, key: "smt_…", prefix, name, scopes }

A scope is the \`/v1/…\` path with \`:\` separators — \`"db"\` covers
\`/v1/db/*\`, \`"ai:complete"\` covers \`/v1/ai/complete\`. Max 32
scopes per key. A scoped key calling outside its scopes gets 403
FORBIDDEN with a message naming the key's scopes and the blocked path.
Keys minted without \`scopes\` have full access. The same \`scopes\`
field works on \`POST /v1/keys/cli-pair\` for ephemeral 24h keys.

## Sign up

  const { user, token, refresh_token, session_token } = await sw.auth.signup({
    email,
    password,
    display_name,    // optional
    locale,          // optional, BCP-47 like "en-US"
    timezone,        // optional, IANA like "America/Los_Angeles"
  });

REST: POST /v1/auth/signup  ·  MCP: auth_signup

## Log in

  const { user, token, refresh_token, session_token } = await sw.auth.login({
    email,
    password,
  });

REST: POST /v1/auth/login  ·  MCP: auth_login

## Get the user from a request — start here

\`\`\`typescript
export default async function (req, sw) {
  const user = await sw.auth.fromRequest(req)
  if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 })

  // user.id, user.email, etc. — go straight to your query
  const { data } = await sw.db.query('SELECT * FROM posts WHERE author_id = ?', [user.id])
  return Response.json(data)
}
\`\`\`

\`fromRequest(req)\` reads the token in this order:
1. Cookie named \`token\`, then \`auth_token\`, then \`session\`
2. \`Authorization: Bearer <jwt>\` header

Then validates with \`sw.auth.me\` under the hood (token cache included)
and returns the user object — or \`null\` if no token, the token is
expired, or the token is invalid. Never throws. This is the single
call you should reach for from every protected function.

## Lower-level: validate a token you already pulled

  const { user } = await sw.auth.me(jwt);

Use this only when you already extracted the JWT yourself (e.g. from a
non-standard header, a query param, a WebSocket subprotocol). For 99 %
of routes, prefer \`fromRequest\` — it does the extraction + validation
in one call.

\`me\` throws \`AUTH_INVALID_CREDS\` if the token is bad. Returns
\`{ user: { id, email, email_verified, display_name, locale?, timezone?, plan, plan_status } }\`.

\`plan\` is always populated (defaults to the string \`'free'\` for users
who have never checked out). \`plan_status\` is \`null\` for free users,
and \`'active' | 'past_due' | 'canceled'\` once they've subscribed via
\`sw.payments.checkoutForUser({ plan, ... })\` (the app-user is derived
from the request — no user id argument). Gate
features off these two fields directly — no separate subscription
table needed. See the \`payments\` topic for the full flow.

REST: GET /v1/auth/me with the user JWT in Authorization  ·  MCP: auth_me

## Browser sessions — use httpOnly cookies, not tokens

Browser apps should hold NO tokens at all: the happy path is cookie
sessions — your backend calls \`sw.auth.loginWithCookie\` and the platform
sets the session as httpOnly cookies the browser owns. Zero client auth
code, nothing in localStorage, XSS can't steal what JS can't read, and
the session refreshes server-side automatically.
\`docs({ topic: 'auth-client' })\` has the exact code to paste.

The full cookie-session surface (all on the runtime):

  // Sign in/up AND set the session cookies on the response. Both resolve
  // to a WRAPPER, { user }, never the bare user: destructure it. user has
  // id, email, role and display_name (null until set). Signup accepts
  // either (req, email, password), (req, email, password, { display_name }),
  // (req, { email, password, display_name }), or just ({ email, password,
  // display_name }) with req omitted. Expected failures (wrong password,
  // duplicate email) surface as structured 4xx with the real message —
  // no try/catch needed.
  const { user } = await sw.auth.loginWithCookie(req, email, password);
  const { user: created } = await sw.auth.signupWithCookie(req, { email, password, display_name });
  // (req, email, password) and ({ email, password }) are accepted by signup too.
  // \`user.email\` is defined; \`(await sw.auth.loginWithCookie(...)).email\` is
  // undefined — the eval that shipped "Signed in as undefined" wrote the latter.

  // Your OAuth callback route in one call: reads ?code,
  // exchanges it, sets the cookies, returns a 302 to redirectTo.
  return sw.auth.googleCallbackWithCookie(req, '/');

  // Revoke the session server-side and clear the cookies; resolves to { ok: true }.
  await sw.auth.logoutWithCookie(req);

  // Lower-level primitives the helpers wrap — for backends that
  // already hold a token pair (e.g. after verifyOtp or mfa.challenge)
  // and want THAT session as cookies.
  sw.auth.setSessionCookies(access, refresh);
  sw.auth.clearSessionCookies();

Cookie-authed requests are origin-checked server-side: a cross-origin
page can't ride the cookies into your API (blocked attempts log
loudly). \`fromRequest\` auto-refreshes expired cookie sessions and
re-issues the cookies, so users stay signed in across browser restarts.

The generated data endpoint \`/__sw/data\` has its own Origin requirement:
every call is a POST and must name the app's own Origin, including list/get
reads authenticated with an app-user Bearer token. Browsers send it
automatically; scripts must set the \`Origin\` header explicitly.

## Header-based auto-refresh (manual token mode)

For clients that DO hold tokens — native apps, CLIs, non-browser
runtimes, or a browser app that explicitly opted out of cookie
sessions — tell the client to send both tokens on every request:

  Authorization: Bearer <access>
  X-Refresh-Token:  <refresh>

When the access token has expired the platform mints a fresh pair,
runs the request under the refreshed identity, and returns the new
pair on the response:

  X-New-Access-Token:  <new-access>
  X-New-Refresh-Token: <new-refresh>

The client persists the new pair and moves on — no 401-handling loop.
Inside deployed functions \`sw.auth.fromRequest(req)\` does the same
dance automatically and the platform attaches the X-New-* headers to
your function's response. Per-request opt-out: \`X-No-Auto-Refresh: 1\`.

Two flavors for guarded handlers:

  // Returns the user OR null — use when the route works for anonymous
  // visitors too (e.g. a feed that personalizes when signed in).
  const user = await sw.auth.fromRequest(req);

  // Throws 401 if not signed in — use when the route requires auth.
  // The handler shim converts the thrown error into a 401 response.
  const user = await sw.auth.requireUser(req);

  // Throws 403 unless the platform-owned app-user role is admin.
  const admin = await sw.auth.requireUser(req, { role: 'admin' });

Enrichment (optional 2nd arg) — most apps follow up fromRequest with
a SELECT against their own user-table to pull role/metadata/etc.
Pass enrichFrom and the join happens for you, one DB call total:

  const me = await sw.auth.requireUser(req, {
    enrichFrom: 'members',         // your table
    fields: ['role', 'metadata'],  // optional, default *
    on: 'id',                      // optional, default 'id' (matches user.id)
  })
  // me = { id, email, ...platform fields..., role, metadata }

Platform fields always win on a name collision (id/email/etc), and a
missing table or column logs server-side without throwing — your
handler still gets the unenriched user back.

Manual-token browser snippet (advanced — browser apps should prefer the
cookie sessions above; use this only when you must hold tokens in JS):

  // auth.ts
  const ACCESS = 'sw_access_token';
  const REFRESH = 'sw_refresh_token';

  export function setTokens(t: { access: string; refresh: string }) {
    localStorage.setItem(ACCESS, t.access);
    localStorage.setItem(REFRESH, t.refresh);
  }
  export function clearTokens() {
    localStorage.removeItem(ACCESS);
    localStorage.removeItem(REFRESH);
  }

  export async function swFetch(input: RequestInfo | URL, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    const access = localStorage.getItem(ACCESS);
    const refresh = localStorage.getItem(REFRESH);
    if (access && !headers.has('Authorization')) headers.set('Authorization', 'Bearer ' + access);
    if (refresh && !headers.has('X-Refresh-Token')) headers.set('X-Refresh-Token', refresh);
    const res = await fetch(input, { ...init, headers });
    const newA = res.headers.get('X-New-Access-Token');
    const newR = res.headers.get('X-New-Refresh-Token');
    if (newA && newR) {
      localStorage.setItem(ACCESS, newA);
      localStorage.setItem(REFRESH, newR);
    }
    return res;
  }

Use it:

  // After signup/login:
  setTokens({ access: result.access_token, refresh: result.refresh_token });

  // From now on, every call rotates the pair silently:
  const r = await swFetch('https://api.somewhere.tech/v1/db/query', { method: 'POST', body });

## Refresh expired token

  const { access_token, refresh_token, expires_in } = await sw.auth.refresh({
    refresh_token,
  });

Old refresh tokens stop working immediately on use. Store the new pair.
Prefer the header-based flow above for browser apps — explicit
\`/v1/auth/refresh\` is for non-browser SDKs or clients that want to
control rotation manually.

REST: POST /v1/auth/refresh

## Password reset flow

  // Step 1 — request a reset email. Always succeeds (no enumeration).
  await sw.auth.forgot({ email });

  // Step 2 — user clicks the email link, your form posts the token + new pw.
  await sw.auth.reset({ token, new_password });

REST: POST /v1/auth/forgot, POST /v1/auth/reset

## Email verification

\`sw.auth.signup\` auto-sends a 6-digit code to the user's email on
success — they're prompted to verify on first visit. The full surface:

  // Re-send a 6-digit code (15 min expiry).
  await sw.auth.requestEmailVerification(jwt);

  // User types the code into your form; you verify it.
  await sw.auth.verifyEmail(jwt, { code });

  // Or — resend the email if it didn't arrive.
  await sw.auth.resendVerification(jwt);

Which code works: **the most recently requested one.** Requesting again does
not withdraw the previous code by itself; the newer code replaces it once the
newer send is accepted and installed, so an email that arrives late may carry
a code that no longer works. Do not assume any particular received code is
still valid. A new request never extends the expiry of an earlier code, and
the platform never re-sends on its own after an uncertain delivery — request
again. A request made from a signed-in session is bound to that session while
it is still pending: if that session is revoked or ends before the code has
been installed, that request never installs its code, and a current session
has to request a new one. A code that has already been installed is not
affected by a later session change and can be verified from any current
session of the same user.

## Magic links (passwordless sign-in)

For users who don't want a password (or forgot it). \`signInWithOtp\`
emails a one-click link; \`verifyOtp\` exchanges the token for a session
the same shape as \`login\`.

  // Step 1 — your form posts the email; we email a 15-min single-use
  // sign-in link. Always succeeds (no enumeration). Auto-creates the
  // user if they're new.
  await sw.auth.signInWithOtp({ email });

  // Step 2 — the link lands on your /auth/magic page. The two files under
  // "The callback bridge" below are the shared recipe: the page POSTs the
  // token once, the API function verifies it, queues the session cookies
  // and answers with the destination. Do not re-derive them.

REST: POST /v1/auth/magic-link, POST /v1/auth/magic-link/verify
MCP: auth_send_magic_link, auth_verify_magic_link

How the link works (contract, verified against the route): \`sw.auth.signInWithOtp({ email, redirect_uri? })\`
emails a single-use link, valid 15 minutes, that points at YOUR app:
\`https://<your-subdomain>.somewhere.site/auth/magic?token=…\` (plus
\`&redirect_uri=…\` when you passed one). Your app must serve that
\`/auth/magic\` page: it reads \`token\` from the query and POSTs it to your
server handler, which calls \`sw.auth.verifyOtp\` (REST
\`POST /v1/auth/magic-link/verify\`), queues the cookies and answers the
destination; the page then navigates. The verify response returns the normal
login shape plus the
\`redirect_uri\` you originally passed, or null — there is no platform
default destination: with no \`redirect_uri\` the app decides where to go
after \`/auth/magic\`. \`redirect_uri\` is validated when the link is
requested: its origin must be the project's somewhere.site address, its legacy
somewhere.tech address, the project's owner-gated \`-dev\` host, a verified
custom domain attached to the project, or a localhost dev origin
(\`http://localhost:5173\`, \`:5174\`, \`:3000\`, \`http://127.0.0.1:5173\`);
anything else is refused with \`VALIDATION_ERROR\`. A first-time address has
its app user created as PENDING when the link is REQUESTED; signing in with a
magic link requires a successful redemption, which verifies the address and
signs the user in. Redemption consumes the exact issued identity and commits
the proof and the session as one authoritative database write; mirrors are
best effort and an already committed sign-in is never retroactively undone. A
link is bound to the email it was issued for; if the account's email changes
before redemption, the link is no longer valid. If redemption cannot determine
its outcome, the response is \`AUTH_SIGN_IN_OUTCOME_UNKNOWN\` (503,
\`retry: false\`): do not resubmit the same token, request a new link.

**Cookies are queued, not returned.** \`sw.auth.setSessionCookies(token,
refresh_token)\` returns \`undefined\`: it queues the \`Set-Cookie\` headers
and the platform attaches them to whatever Response your function returns.
Do not build cookie headers by hand and do not expect a value back. The
canonical access field on a sign-in result is \`token\` (the runtime also
tolerates \`access_token\` from older bundles); the refresh field is
\`refresh_token\`.

**The callback bridge, complete — both halves.** The emailed link lands on
YOUR route \`/auth/magic?token=…\`, always on the project's somewhere.site
origin. That page posts the token once to your API function; the function
verifies, queues the session cookies on its response, and answers with the
destination; the page then navigates the document. The two files below are the
shared, tested recipe (\`magic-link-browser\`); the advisor renders the same
bytes and the platform's fixtures run them. Use them as they are.

${RECIPE_MAGIC_LINK_BROWSER}

Contract and pitfalls the recipe encodes:

- **Response contract:** \`200\` with JSON \`{ redirect }\` and the session
  cookies on that response. A non-2xx does not by itself say why: the link may
  be invalid or expired, or the platform may have been unable to complete the
  sign-in (\`503 AUTH_SIGN_IN_OUTCOME_UNKNOWN\`, or an ordinary provider or
  database failure). Never send the same token again — it is single-use and
  may already be consumed; the page makes one request and offers a new link.
- **The destination is never a body value.** Only the \`redirect_uri\` the
  platform validated when the link was requested, or the site root — and only
  within the app's own origin, never back to \`/auth/magic\`. A body-supplied
  URL is an open redirect.
- **Same origin only, and custom domains land on the subdomain.** The link is
  built on the somewhere.site origin even when your app also serves a custom
  domain, and session cookies are host-scoped. A validated destination on the
  custom domain would arrive without the session. Keep the destination on the
  origin that verified the token.
- **Read the incoming token under a different name than the result's
  \`token\`** — \`const { token } = await sw.auth.verifyOtp({ token })\` is a
  temporal-dead-zone error. \`setSessionCookies\` returns nothing; the cookies
  ride on the Response you return.
- **Testing consumes links.** Redeeming a link through the CLI or MCP
  (\`auth_verify_magic_link\`) uses it up, so the browser flow can no longer be
  proven with it. Prove the browser flow with the emailed link; use a
  separately requested link for any API-only check.

The send
response text is the same whether or not the address already existed
(\`If that email exists or can be created, a sign-in link has been sent.\`);
delivery itself is asynchronous and its outcome is reported separately, so
this response does not tell you whether the mail was delivered.

## MFA / TOTP

RFC 6238 TOTP — Google Authenticator, 1Password, Authy all work. Once
enrolled, the user's normal \`login\` returns \`{ mfa_required: true,
mfa_token }\` instead of a session; complete the challenge with the
6-digit code to get the session.

  // Enrollment — pass the user's JWT.
  const { secret, otpauth_uri } = await sw.auth.mfa.enroll({ token: jwt });
  // Show otpauth_uri as a QR code; user scans it, types the first code.
  const { backup_codes } = await sw.auth.mfa.verify({ token: jwt, code });
  // backup_codes is returned ONCE on first verify — show it to the
  // user now (null on re-verify; existing codes are preserved).

  // On login, if MFA is enrolled:
  const login = await sw.auth.login({ email, password });
  if (login.mfa_required) {
    // Prompt the user for their TOTP code (or a backup code), then complete:
    const session = await sw.auth.mfa.challenge({
      mfa_token: login.mfa_token,
      code,
    });
  }

  // Remove MFA — requires a fresh TOTP or backup code, so a stolen
  // JWT alone can't turn it off.
  await sw.auth.mfa.unenroll({ token: jwt, code });

REST: POST /v1/auth/mfa/{enroll,verify,challenge,unenroll}
MCP: auth_mfa_{enroll,verify,challenge,unenroll}

## Update password (logged-in user)

  await sw.auth.updatePassword(jwt, {
    current_password,
    new_password,
  });

Wipes ALL active sessions and refresh tokens on success — the user has
to log in again everywhere. For OAuth-only users setting their first
password, omit \`current_password\`.

## Update profile (logged-in user)

  await sw.auth.updateProfile(jwt, {
    display_name,    // optional, set to null to clear
    metadata,        // optional, replaces any existing metadata blob
  });

## Self-service account deletion

  await sw.auth.deleteUser(jwt);

Cascade-deletes the user's sessions, reset tokens, verification codes,
and \`app_users\` row. Project data (your own tables) is the
developer's concern — wipe it before calling.

## Admin / test-harness deletion (developer key)

  await auth_user_delete({ project_id, user_id });   // MCP tool
  // or REST: DELETE /v1/auth/users/:id?project_id=... with smt_ key

For wiping throwaway test users from your own tooling, when you don't
have the user's JWT. Same cascade as the self-service variant. The
project must be one you own.

## Admin / test-harness edit (developer key)

  await auth_user_update({ project_id, user_id, display_name, metadata, role: 'admin' });
  // or REST: PATCH /v1/auth/users/:id?project_id=... with smt_ key

For admin tooling: edit \`display_name\`, \`metadata\`, and/or the
platform-owned \`user | admin\` role on any end-user in a project you
own. Signup always creates \`user\`; granting the first \`admin\` here is
safe because this control-plane call requires the project owner's
developer key and the app-user self-profile route does not accept
\`role\`. Role changes are audited and invalidate existing access tokens. Email and
password are intentionally NOT here — those have their own verification
and reset flows. \`metadata\` is REPLACED, not merged; max 16 KB.

Also accepts \`banned\` and \`banned_reason\` — see "Ban / suspend" below.

## Admin operations are NOT on the runtime

\`sw.auth.admin.*\` is not callable inside deployed functions — any
call throws \`AUTH_ADMIN_REMOVED_FROM_RUNTIME\`. A public handler that
accepted a user id from the request body would be an account-takeover
primitive, so admin actions on app users run only from your own
tooling with a developer \`smt_\` key (MCP tools or REST), never from
a request handler. The sections below are that surface.

## Ban / suspend (developer key)

Block a user from signing in without deleting their data. Bans are
reversible — the row stays put, sessions are wiped, future \`login\`
returns AUTH_INVALID_CREDS (no enumeration), and any active JWT bounces
with 403 AUTH_BANNED on \`/me\` so your SPA can log them out.

  await auth_user_update({ project_id, user_id, banned: true, banned_reason: 'spam' });
  await auth_user_update({ project_id, user_id, banned: false });  // unban; clears reason+timestamp

The \`banned_reason\` is staff-only — never returned to the banned
user. Banning a user invalidates every active session + refresh token.

REST: PATCH /v1/auth/users/:id?project_id=… with \`banned\` /
\`banned_reason\` fields  ·  MCP: auth_user_update

## Impersonation (developer key)

Mint a 1-hour JWT for an end-user as YOU — useful for support tickets,
test harnesses, and debugging customer reports. The token carries
\`impersonating: true\` and \`impersonator_id\` claims so audit logs
can distinguish impersonated traffic from genuine user traffic.

  const { access_token, user } = await auth_impersonate({ project_id, user_id });
  // access_token is 1h, no refresh — re-mint when it expires.

Banned users cannot be impersonated (returns 403 AUTH_BANNED).

REST: POST /v1/auth/users/:id/impersonate  ·  MCP: auth_impersonate

## Session management (developer key)

List + revoke a user's active sessions. Tokens themselves are never
returned — only session IDs, creation timestamps, and expiries.

  const sessions = await auth_list_sessions({ project_id, user_id });
  // [{ id, created_at, expires_at }, ...] — non-expired only, max 100

  await auth_revoke_session({ project_id, session_id });    // log this device out
  await auth_revoke_all_sessions({ project_id, user_id });  // log every device out

REST: GET /v1/auth/users/:id/sessions, DELETE /v1/auth/sessions/:id,
DELETE /v1/auth/users/:id/sessions
MCP: auth_list_sessions, auth_revoke_session, auth_revoke_all_sessions

## Hosted auth pages — advanced manual-token compatibility

This is not the browser default. It exists for apps intentionally implementing
manual token mode:

  https://auth.somewhere.tech/login?project_id=...&redirect=https://yourapp.somewhere.site/

Pages: \`/login\`, \`/signup\`, \`/forgot-password\`, \`/reset\`,
\`/verify-email\`, \`/magic-link\`, \`/mfa\`.

On success the page redirects to \`redirect\` with
\`#access_token=...&refresh_token=...\` in the URL hash. Your SPA reads
\`location.hash\`, stores the tokens in localStorage, and replaces
history. This deliberately puts credentials in page JavaScript. Browser apps
should use the httpOnly cookie-session path in
\`docs({ topic: 'auth-client' })\` instead. The pages POST directly to
\`api.somewhere.tech\` — no business logic lives on the auth subdomain.

## Lifecycle webhook (clean up your own tables on user delete)

The platform's user-delete cascade only touches platform-owned tables
(sessions, password resets, email verifications, the \`app_users\` row).
Anything you wrote that references the user_id — \`posts.author_id\`,
\`comments.user_id\`, files in \`/avatars/\`, etc. — is your concern.
Without a hook, those rows orphan silently and your app starts
returning rows pointing at users that no longer exist.

Configure a project-scoped webhook to clean them up transactionally:

  // one-time setup (developer key)
  const { secret } = await auth_webhook_set({
    project_id: 'default',
    url: 'https://yourapp.somewhere.site/api/auth/webhook',
  });
  // store \`secret\` server-side — we don't surface it again.
  // re-call with rotate_secret: true to rotate.

Inside your webhook handler, verify the signature and run cleanup:

  // POST handler in your deployed function
  const sig = req.headers.get('X-Somewhere-Signature') ?? '';
  const m = sig.match(/^t=(\\d+),v1=([0-9a-f]+)$/);
  if (!m) return new Response('bad sig', { status: 401 });
  const [, t, hex] = m;
  if (Math.abs(Date.now() - Number(t)) > 5 * 60 * 1000) {
    return new Response('stale sig', { status: 401 });
  }
  const raw = await req.text();
  const expected = await sw.crypto.hmacSha256Hex(\`\${t}.\${raw}\`, secret);
  if (!sw.crypto.timingSafeEqual(expected, hex)) {
    return new Response('bad sig', { status: 401 });
  }
  const evt = JSON.parse(raw);
  if (evt.type === 'auth.user.created') {
    // The classic "signup trigger → profiles row" pattern: mirror the
    // new user into your own table.
    await sw.db.query(
      \`INSERT INTO profiles (id, email, display_name) VALUES (?, ?, ?)
         ON CONFLICT(id) DO NOTHING\`,
      [evt.user.id, evt.user.email, evt.user.display_name],
    );
  }
  if (evt.type === 'auth.user.deleted') {
    await sw.db.query(
      \`DELETE FROM posts WHERE author_id = ?\`,
      [evt.user.id],
    );
    // ...etc. for every table that references user_id
  }
  return new Response('ok');

Fired events: \`auth.user.created\`, \`auth.user.updated\`, \`auth.user.deleted\`.
- \`created\` fires on password signup, Google-created, and magic-link-created
  users. Payload: \`{ id, email, display_name, project_id, created_at }\`.
- \`updated\` fires when a user edits their profile (display_name / metadata).
- \`deleted\` fires on account deletion.
Same HMAC scheme as inbox webhooks — one verifier covers both.

## Joining users from your app data — the \`auth_users\` table

You don't have to mirror users by hand. The platform keeps a read-only
\`auth_users\` table inside your project database, kept in sync on signup,
profile change, and deletion. JOIN it straight from your app tables:

  SELECT p.id, p.body, u.display_name AS author, u.email
    FROM posts p
    JOIN auth_users u ON u.id = p.user_id;

Columns: \`id, email, display_name, email_verified, metadata, created_at,
last_login_at, plan, plan_status, updated_at\`. Treat it as read-only — it's
maintained for you; write your own tables, JOIN against this one. The mirror is
best-effort and never blocks signup. If you'd already defined your own
incompatible \`auth_users\` table, the sync simply no-ops and leaves your table
untouched — use the \`auth.user.*\` webhooks above instead.

To stop firing webhooks for the project:

  await auth_webhook_delete({ project_id: 'default' });

## Logout

  // Cookie sessions (browser default): revoke + clear the cookies.
  await sw.auth.logoutWithCookie(req);

  // Token mode: pass the session_token and/or refresh_token.
  await sw.auth.logout({ session_token });

Revokes the session. The current JWT keeps working until it expires
(max 1 hour) — JWTs are stateless. To force immediate logout, also
rotate the user's password.

## Visitors (before sign-in)

Lots of apps let a visitor do something useful before signing up (fill a
cart, send a message, save a draft). Declare it on the table instead of
tracking it by hand:

\`\`\`ts
cart: table({ id: id(), sku: text() }, {
  scope: owner({ visitors: true }),
  client: { read: true, create: ['sku'], delete: true, identity: 'visitor' },
}),
\`\`\`

The platform gives each visitor a signed session cookie that lasts 30 days.
Rows the visitor creates belong to that session. When the visitor signs in,
the platform moves those rows to the account in one step, and that visitor
session can never hand rows over again, so a later account can never take an earlier
account's rows. A retry or a second tab is a no-op; logging out issues a fresh
visitor session. If visitor rows conflict with rows the account already has,
sign-in still completes and the account's existing data is unaffected; the visitor data stays stored under the retired visitor session and is not merged automatically — the browser cannot reach it again. No helper and no
manual migration step is needed for the declared browser
flow. Server code can still read the visitor with \`sw.auth.anonSession(req)\`
(it resolves the signed visitor session); the old \`sw.auth.migrateAnon\`
refuses with \`MIGRATE_ANON_REMOVED\` (400) because the hand-over is automatic on sign-in. Full contract: the
\`declared-data\` topic.

## Social OAuth

**The platform owns the Google OAuth client.** You do NOT create a
Google Cloud Console project. You do NOT register your own OAuth
2.0 credentials. You do NOT add authorized redirect URIs in any
Google console. The platform's single OAuth client handles every
project on the platform — you just call \`sw.auth.googleUrl({ redirect_uri })\`
and the platform accepts \`redirect_uri\` for any verified project
subdomain or claimed custom domain attached to your project. If a
\`redirect_uri\` is rejected, the answer is either (a) the host
doesn't belong to your project yet (run \`domain_attach\`) or (b) the
project subdomain is wrong — never "go set up Google credentials".

GitHub and Discord use the same project-scoped flow:

- \`githubUrl({ redirect_uri })\` / \`githubExchange({ code })\` /
  \`githubCallbackWithCookie(req, redirectTo)\`. Identity-only scopes:
  \`read:user user:email\`.
- \`discordUrl({ redirect_uri })\` / \`discordExchange({ code })\` /
  \`discordCallbackWithCookie(req, redirectTo)\`. Identity-only scopes:
  \`identify email\`.

All three providers return to the customer app with the same one-time
\`?code=\` shape and exchange into the same project-scoped session.

  // Build the URL to send the user's browser to:
  const url = sw.auth.googleUrl({ redirect_uri: 'https://myapp.somewhere.site/auth/callback' });
  // ...redirect the user there.

After the user approves, the platform handles the Google code
exchange and then bounces them back to your \`redirect_uri\` with a
short-lived authorization code in the query string:

  https://your-app.somewhere.site/auth/callback?code=...

The JWT is never put in the URL. To get the JWT, your callback
function exchanges the code:

  const { token, user } = await sw.auth.googleExchange({ code });

Codes are single-use and expire after 60 seconds.

Typical callback function — one line with the cookie helper:

  // api/auth-callback.ts
  export default async function(req, sw) {
    // Reads ?code, exchanges it, sets the httpOnly session cookies,
    // and 302s home. Tokens never touch client JS.
    return sw.auth.googleCallbackWithCookie(req, '/');
  }

Call \`googleExchange\` directly only when you manage tokens yourself
(native apps / non-browser clients) — it returns the same
\`{ user, token, refresh_token, session_token }\` shape as \`login\`.

REST uses \`GET /v1/auth/{google|github|discord}\` for the URL and
\`POST /v1/auth/{provider}/exchange\` for the code. MCP currently exposes
\`auth_google_url\`; deployed functions use the \`sw.auth\` helpers above.

## Common pattern: protected endpoint inside a deployed function

  export default async function(req, sw) {
    const user = await sw.auth.fromRequest(req);
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const posts = await sw.db.query(
      'SELECT * FROM posts WHERE author_id = ?', [user.id]
    );
    return Response.json(posts.data);
  }

That's it. No cookie parsing, no header slicing, no try/catch on
expired tokens — all of that lives inside \`fromRequest\`. If you find
yourself writing \`req.headers.get('cookie')\` inside a function, you
re-implemented something that already exists.

## Auth emails

Password reset, email verification, and welcome emails are platform
email — they're sent from a platform-owned address (noreply@somewhere.tech)
on every project's behalf. No setup required: every project gets working
auth out of the box.

Customize the subject + HTML in dashboard Settings → Email Templates
(or via the email-templates API). The from-address is platform-owned and
not configurable per project — that's by design, so deliverability isn't
gated on each user verifying their own domain.

Your app's transactional mail can use the same zero-setup platform sender
through sw.email.send. Add a verified sender domain when you need your own
From address or marketing mail. Auth emails always use the platform sender.
`,

  'auth-md': `# auth.md — letting AI agents register as end-users

A REST protocol surface that lets an AI agent register itself as an
end-user of your app, get a human to claim it, and hold its own access
token — separate from the human's own login.

**Off by default, per project.** Turn it on with:

\`\`\`
PATCH /v1/projects/:id
{ "auth_md_enabled": true }
\`\`\`

Optionally narrow what an agent can do before vs. after a human claims
it with \`auth_md_pre_claim_scopes\` / \`auth_md_post_claim_scopes\`
(both string arrays; sensible defaults apply if omitted). While the
project has this off, every endpoint below returns 404
\`AUTH_MD_DISABLED\`. This is REST-only today — there's no MCP tool for
managing these fields yet; use the project update endpoint or the
dashboard.

## Discovery

- \`GET /v1/auth/auth.md\` — a machine-readable description of this
  project's agent-auth surface, meant to be fetched by an agent
  deciding how to authenticate.
- \`GET /v1/auth/.well-known/oauth-protected-resource\` /
  \`GET /v1/auth/.well-known/oauth-authorization-server\` — standard
  OAuth discovery metadata scoped to this project.

## Registration and claiming

\`POST /v1/auth/agent/identity\` — an agent self-registers. Body:
\`{ project_id, type?, scopes?, agent_platform?, agent_name? }\`.
\`type\` is \`"anonymous"\` (default) or \`"service_auth"\` (starts in a
pending-claim state); \`type: "identity_assertion"\` is not accepted and
returns 501. Response includes:

- \`identity_assertion\` — a short-lived signed JWT the agent holds.
- \`claim_token\` / \`user_code\` — hand these to a human to approve the
  registration.
- \`verification_uri\` / \`verification_uri_complete\` — where the human
  goes to claim it.

\`POST /v1/auth/agent/identity/claim\` — called as a signed-in human
app-user. Body: \`{ project_id, claim_token, user_code, scopes? }\`.
Moves the registration from anonymous/pending into \`claimed\` and
re-scopes it to \`auth_md_post_claim_scopes\`. Requesting a scope
outside the configured catalog is silently narrowed, not rejected.

## Tokens

\`POST /v1/auth/oauth2/token\` — exchange for an access token. Two grant
types:

- \`urn:ietf:params:oauth:grant-type:jwt-bearer\` with \`assertion\` — trade
  the \`identity_assertion\` from registration for a token.
- \`urn:somewhere:auth-md:grant-type:claim-token\` with \`claim_token\` —
  trade a claimed registration's claim token for a token. Single-use:
  the claim token is cleared once redeemed. Returns 428
  \`AUTHORIZATION_PENDING\` if the human hasn't claimed it yet.

\`POST /v1/auth/oauth2/revoke\` — revoke an agent's token and end its
session (body: \`{ token }\`).

## Not available

\`POST /v1/auth/agent/event/notify\` is not available and returns 501 —
signed provider-event revocation is not part of the surface. Use
\`oauth2/revoke\` for revoking a token.

Related: \`sw.auth\`, \`groups\`.
`,

  'auth-client': `# Auth on the client — the correct session code

The platform owns the hard part server-side: social OAuth clients, JWT
validation (\`sw.auth.fromRequest\`), and session refresh. The happy path puts
ZERO token/session machinery in the browser: **httpOnly cookie sessions**. No tokens in JS,
nothing in localStorage, nothing for XSS to steal — and expected failures
(wrong password, duplicate email, weak password) come back as structured 4xx
with the real message, never an opaque 500.

The whole contract is: **browser → cookie session; non-browser/script/native
client → bearer token**. Packages are optional adapters to that contract.
Direct bearer-backed database/file access from a browser is compatibility mode,
not another recommended path.

## 1. The backend — one file (paste exactly this)

\`login\` / \`signup\` are developer-key-gated (the browser can't call them), so
this one server function mediates and sets the session cookies:

\`\`\`js
// functions/api/auth/[...path].js
export default async function (req, sw) {
  const url = new URL(req.url);
  const sub = url.pathname.replace(/.*\\/auth/, '') || '/';
  const json = (d, s) => Response.json(d, { status: s || 200 });
  const body = async () => { try { return await req.json(); } catch (e) { return {}; } };
  if (req.method === 'POST' && sub === '/login')  { const b = await body(); return json(await sw.auth.loginWithCookie(req, b.email, b.password)); }
  if (req.method === 'POST' && sub === '/signup') { const b = await body(); return json(await sw.auth.signupWithCookie(req, b)); }
  if (req.method === 'POST' && sub === '/magic-link') {
    const b = await body();
    return json(await sw.auth.signInWithOtp({ email: b.email, redirect_uri: b.redirect_uri }));
  }
  if (req.method === 'POST' && sub === '/magic-link/verify') {
    const raw = await sw.auth.verifyOtp(await body());
    const d = raw.data || raw;
    sw.auth.setSessionCookies(d.token || d.access_token, d.refresh_token);
    return json({ user: d.user || null, cookie_session: true });
  }
  if (req.method === 'GET'  && sub === '/callback') return sw.auth.googleCallbackWithCookie(req, '/');  // returns a 302
  if (req.method === 'POST' && sub === '/logout')   return json(await sw.auth.logoutWithCookie(req));
  if (req.method === 'GET'  && sub === '/me')       return json({ user: await sw.auth.fromRequest(req) });
  return json({ error: 'NOT_FOUND' }, 404);
}
\`\`\`

No try/catch needed: expected auth failures surface automatically as
structured 4xx — \`{ error: 'INVALID_CREDENTIALS', message: 'Wrong email or
password.' }\` and friends — so your UI can show \`body.message\` directly.
Real bugs still return opaque 500s. (The cookie helpers also accept an
options object: \`loginWithCookie(req, { email, password })\` works too, and
\`signupWithCookie\` additionally accepts \`{ email, password, display_name?,
locale?, timezone?, turnstile_token? }\` — or pass those fields as the fourth
argument after positional email/password, or call it with just that object
and no \`req\` at all. Update a signed-in user's profile
the same way with
\`sw.auth.updateProfileWithCookie(req, { display_name?, metadata? })\`, which
refreshes the session cookies on the response just like the other cookie
helpers.)

## Response shapes — one contract

Every auth success that carries a user wraps it: \`{ "user": { ... } }\`.
Success is never a bare user object and never \`null\` — if the platform
ever failed to produce a user on sign-in, the helper throws
\`AUTH_RESPONSE_MALFORMED\` instead of returning an ambiguous 200. Errors are
always structured \`{ error, message }\` 4xx.

- \`POST /api/auth/login\` and \`/signup\` →
  \`{ "user": { "id", "email", "role", "display_name" } }\` — the compact
  session identity. The session rides on httpOnly \`Set-Cookie\` headers; the
  cookie helpers put no token material in the body.
- \`GET /api/auth/me\` → \`{ "user": { ... } }\` — the signed-in user. The
  zero-dependency handler above returns the verified session identity; the
  SDK \`somewhereAuth\` handler returns the full stored profile
  (\`email_verified\`, \`created_at\`, \`last_login_at\`, \`metadata\`,
  \`locale\`, \`timezone\`, \`plan\`, \`plan_status\`, …) — a superset of
  the sign-in shape. Read \`data.user\` either way.
- \`POST /api/auth/logout\` → \`{ "ok": true }\`.
- Developer-key token mode (\`sw.auth.login\` / \`signup\` called
  server-side, and the SDK handler's sign-in responses) additionally carries
  the token envelope:
  \`{ user, token, access_token, refresh_token, session_token, expires_in }\`.
  \`token\` is a legacy alias, byte-identical to \`access_token\` — prefer
  \`access_token\` in new code.

## 2. Optional SDK adapter

\`\`\`js
import { createClient } from '@somewhere-tech/sdk'   // ${SDK_VERSION}+
const client = createClient('https://<project>.somewhere.site')

// Posts to your /api/auth routes above; the session is httpOnly cookies.
const { error } = await client.auth.signIn({ email, password })
if (error) showMessage(error.message)        // "Wrong email or password."

await client.auth.signUp({ email, password })
await client.auth.sendMagicLink({ email })
await client.auth.verifyMagicLink({ token })
const { data: { user } } = await client.auth.getUser()   // probes /api/auth/me
await client.auth.signOut()

// Google — zero token-handoff code: the platform redirects back through
// your /callback route, which sets the cookies and 302s home.
const { data } = await client.auth.signInWithOAuth({ provider: 'google' })
window.location.href = data.url
\`\`\`

In cookie mode the SDK holds no tokens: \`getSession()\` returns
\`{ cookie_session: true, user }\`, a network blip never reads as a logout
(only a definitive 401 does), and \`functions.invoke\` rides the cookie
automatically.

The browser constructor needs no bearer or developer key. Do not ship an
\`smt_\` key or invent a placeholder browser credential. Cookie sign-in does
not credential the SDK's direct \`from()\`, storage, or realtime calls.
Use the generated \`somewhere:data\` client for declared browser database
operations. File access and business logic go through same-origin functions.

## 3. Browser happy path — zero dependencies

Nothing to install — the cookie does the work:

\`\`\`js
// Sign in (sign up is the same against /api/auth/signup):
const res = await fetch('/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }), credentials: 'include',
});
if (!res.ok) showMessage((await res.json()).message);   // "Wrong email or password."

// Who is signed in? (any page load)
const me = await (await fetch('/api/auth/me', { credentials: 'include' })).json();

// Every authed request — just include credentials:
const r = await fetch('/api/whatever', { credentials: 'include' });

// Sign out:
await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
\`\`\`

## 4. React — one hook

\`\`\`jsx
import { useState, useEffect } from 'react';
export function useUser() {
  const [user, setUser] = useState(null);
  useEffect(() => {
    let on = true;
    fetch('/api/auth/me', { credentials: 'include' })
      .then((r) => r.json()).then((d) => { if (on) setUser(d.user || null); })
      .catch(() => {});   // network blip — never treat as logged out
    return () => { on = false; };
  }, []);
  return user;
}
\`\`\`

## Package status: one SDK, one version

Install \`@somewhere-tech/sdk\`. Its tree-shakeable \`/auth\`, \`/react\`, and
\`/server\` subpaths contain the framework-agnostic cookie client, React
hooks/gates, OAuth callback UI, billing components, and the handler for the
same \`/api/auth\` contract above. The contract matrix verifies every
SDK-exported client method against that handler, including
\`sendMagicLink\` / \`verifyMagicLink\` delegation to
\`sw.auth.signInWithOtp\` / \`sw.auth.verifyOtp\`.

\`@somewhere-tech/auth\` 0.4.2+ remains operational and is not deprecated. It
is a thin re-export shim for the SDK subpaths so existing importers keep
working unchanged under rule 9. New applications install only the SDK.
Standalone-package deprecation is deferred until usage proves safe. Header mode
remains only for non-browser and older integrations.

The cookies are HttpOnly + Secure (invisible to JS — XSS can't steal them),
SameSite=Lax, Path=/, 30-day lifetime. \`sw.auth.fromRequest\` auto-refreshes
the session on every call and re-issues the cookie, so users stay logged in
across browser restarts and you never write a line of refresh logic.

A cookie-session write (POST/PUT/PATCH/DELETE) must carry a normal browser
\`Origin\` header — a plain \`fetch()\` from a page already sends one, so
there's nothing to add. A write with no \`Origin\` at all (not a real
browser request) gets a 400 \`ORIGIN_REQUIRED\`. Reads and Bearer-token
requests are unaffected — don't hand-write CORS headers to work around
this.

A non-browser caller (a script, an agent, a server-side caller) doing a
cookie-authenticated write has two supported paths: send the \`Origin\`
header yourself naming your app's own origin, or stop sending the session
cookie and pass the user's token in an \`Authorization: Bearer <token>\`
header instead. For custom functions using \`sw.auth.fromRequest\`, the
bearer path is not origin-checked and fits non-browser callers. The generated
data endpoint \`/__sw/data\` has a separate rule: every call, including
Bearer-authenticated list/get reads, requires \`Origin\` set to the app's
own origin. There is no CSRF-token alternative.

## Advanced — manual token mode (native apps / non-browser clients)

Browser apps should use the cookie sessions above. Hold tokens yourself ONLY
when there is no httpOnly cookie jar (native apps, CLIs). The session layer
below is correct — paste it, don't hand-roll it: a hand-rolled layer is where
every auth bug lives (logged out on a network blip, the
rotating-refresh-token desync, a half-written token pair). It encodes three
rules that are easy to get wrong (called out at the bottom).

### The session client — \`src/auth.js\`

\`\`\`js
const KEY = 'sw_auth';
const UKEY = 'sw_auth_user';   // cached user for optimistic restore — never flash logged-out on a network blip
function load() {
  try { const r = localStorage.getItem(KEY); const s = r && JSON.parse(r);
    return (s && s.accessToken && s.refreshToken) ? s : null; } catch (e) { return null; }
}
let session = load();
// Optimistic: restore the last-known user so a page refresh shows the signed-in
// UI instantly, and a transient /me failure keeps the user instead of logging
// out. Only trust the cache when a session exists (no tokens = no user).
function loadUser() {
  try { const r = localStorage.getItem(UKEY); const u = r && JSON.parse(r);
    return (session && u && typeof u === 'object') ? u : null; } catch (e) { return null; }
}
let cachedUser = loadUser();
export function getCachedUser() { return cachedUser; }
function setUser(u) {                              // persist/clear the cached user
  cachedUser = u;
  if (u) localStorage.setItem(UKEY, JSON.stringify(u));
  else localStorage.removeItem(UKEY);
}
const subs = new Set();
function setSession(next) {                       // ATOMIC: one value — both tokens or none
  session = next;
  if (next) localStorage.setItem(KEY, JSON.stringify(next));
  else { localStorage.removeItem(KEY); setUser(null); }   // logging out clears the cached user too
  subs.forEach(function (fn) { fn(session); });
}
export function getSession() { return session; }
export function onAuthChange(fn) { subs.add(fn); fn(session); return function () { subs.delete(fn); }; }

// Use this for EVERY request to your backend that needs the user.
export async function authFetch(input, init) {
  init = init || {};
  const headers = new Headers(init.headers);
  if (session) {
    headers.set('Authorization', 'Bearer ' + session.accessToken);
    headers.set('X-Refresh-Token', session.refreshToken);   // ride-along: lets the server auto-refresh
  }
  let res;
  try {
    res = await fetch(input, Object.assign({}, init, { headers }));
  } catch (err) {
    throw err;                 // NETWORK BLIP: keep the session, just re-throw. NEVER log out here.
  }
  const na = res.headers.get('X-New-Access-Token');
  const nr = res.headers.get('X-New-Refresh-Token');
  if (na && nr) setSession({ accessToken: na, refreshToken: nr });   // rotation: both or neither
  if (res.status === 401) setSession(null);      // server already tried refresh — session is dead
  return res;
}

async function exchange(path, payload) {
  const res = await fetch('/api/auth-token' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const data = await res.json().catch(function () { return {}; });
  if (!res.ok) throw new Error(data.message || data.error || 'Auth failed');
  setSession({ accessToken: data.token || data.access_token, refreshToken: data.refresh_token });
  return data.user || null;
}
export const signIn = function (email, password) { return exchange('/login', { email: email, password: password }); };
export const signUp = function (email, password) { return exchange('/signup', { email: email, password: password }); };
export async function signOut() { setSession(null); try { await fetch('/api/auth-token/logout', { method: 'POST' }); } catch (e) {} }
export async function googleSignIn() { window.location.href = (await (await fetch('/api/auth-token/google-url')).json()).url; }
export async function getUser() {
  if (!session) return null;
  let res;
  try { res = await authFetch('/api/auth-token/me'); }
  catch (e) { return cachedUser; }            // network blip — keep the cached user, never log out
  if (res.status === 401) return null;        // authFetch already cleared the dead session
  if (!res.ok) return cachedUser;             // 5xx / transient — keep the cached user
  const u = (await res.json()).user || null;
  setUser(u);                                 // refresh + persist
  return u;
}
\`\`\`

### The backend — one function that wires it to \`sw.auth\`

A thin server function mediates the developer-key-gated calls and returns
the token pair to the client (this is the manual-mode sibling of the cookie
handler above, mounted at a different path so the examples are not pasted over
each other):

\`\`\`js
// functions/api/auth-token/[...path].js
export default async function (req, sw) {
  const url = new URL(req.url);
  const parts = url.pathname.split('/auth-token');
  const sub = parts.length > 1 ? (parts[parts.length - 1] || '/') : '/';
  const json = function (d, s) { return Response.json(d, { status: s || 200 }); };
  const body = async function () { try { return await req.json(); } catch (e) { return {}; } };
  try {
    if (req.method === 'POST' && sub === '/login')      return json(await sw.auth.login(await body()));
    if (req.method === 'POST' && sub === '/signup')     return json(await sw.auth.signup(await body()));
    if (req.method === 'POST' && sub === '/logout')   { try { await sw.auth.logout({}); } catch (e) {} return json({ ok: true }); }
    if (req.method === 'GET'  && sub === '/me')         return json({ user: await sw.auth.fromRequest(req) });
    if (req.method === 'GET'  && sub === '/google-url') return json(await sw.auth.googleUrl({ redirect_uri: url.origin + '/auth/callback' }));
    if (req.method === 'POST' && sub === '/google')     return json(await sw.auth.googleExchange(await body()));
    return json({ error: 'NOT_FOUND' }, 404);
  } catch (e) { return json({ error: 'AUTH_ERROR', message: e.message }, 400); }
}
\`\`\`

### React — one hook (manual token mode)

\`\`\`jsx
import { useState, useEffect } from 'react';
import { onAuthChange, getUser, getCachedUser } from './auth';
export function useUser() {
  const [user, setUser] = useState(getCachedUser);   // paint the cached user immediately — no logged-out flash
  useEffect(function () { return onAuthChange(function () { getUser().then(setUser); }); }, []);
  return user;
}
\`\`\`

Now \`const user = useUser()\` anywhere, and \`authFetch('/api/...')\` for authed
calls. Google callback page: read \`?code\` from the URL and POST it to
\`/api/auth-token/google\`, then redirect home.

Gating by paid plan? The same provider exposes \`useEntitlements()\` and a
\`<Gate feature="export">\` component — the user's feature list rides the
session, so the check is instant. See \`docs({ topic: 'sw.billing' })\`.

### The three rules (don't "simplify" these away — each is a real bug)

- **Persist the pair ATOMICALLY** — write both tokens as ONE value. A code path
  that writes the access token without the refresh token (or vice-versa)
  desyncs the session and logs the user out unpredictably.
- **A network error must NEVER clear the session** — the \`catch\` re-throws and
  leaves the tokens alone. Wiping the session because \`fetch\` rejected is the #1
  cause of "I got logged out for no reason" (a wifi blip should not sign you out).
- **Rotate only when BOTH \`X-New-*\` headers are present** — a partial header set
  means no rotation happened; don't half-apply it.

## The package does not create another path

The cookie path is one pasted backend file plus plain \`fetch\` and needs no
package. \`@somewhere-tech/sdk\` is the single optional adapter to that exact
\`/api/auth\` contract. The legacy \`@somewhere-tech/auth\` name only re-exports
its SDK subpaths. Use the SDK for API shape or UI helpers, never to introduce
browser-held credentials.
`,

  'projects': `# Projects — Full Lifecycle

Every app on the platform is a project. A project owns:
  - a subdomain (https://{subdomain}.somewhere.site)
  - a database
  - a file store
  - environment variables
  - deployed functions and static files

## project_create({ name, subdomain?, description? })
Creates an empty project. If subdomain is omitted, one is generated
from the name. Subdomains must be globally unique, 3–32 chars,
[a-z0-9-]. Returns { project_id }.

## project_list()
Returns every project on your account, newest first. Each row:
  { id, name, subdomain, status, created_at, last_deployed_at,
    latest_screenshot_url, favicon_url }

The list fields are ready to render without per-project metadata calls.
\`latest_screenshot_url\` and \`favicon_url\` are null until the project has the
corresponding live-release asset. The screenshot URL is a temporary signed
capability that an image element can render; the favicon URL is public.

## project_get({ project_id })
Single project record + tier + deploy state.

The dashboard's project Monitoring view also shows Page views: 7/30-day totals, top paths, and referrer hosts.

## project_view_urls({ project_id })
Returns the project's URLs and current version. The bare subdomain
and every attached custom domain serve the immutable release named by
\`active_release_id\`. Browser verification uses that public live URL.

## project_deploy({ project_id, files, functions?, binary_files? })
Full replacement from authored source. The platform compiles the source
into one immutable release and moves \`active_release_id\` to that exact
release only after publication succeeds. See the deploy topic for the
exact semantics and when to choose project_patch instead.

## project_patch({ project_id, path, content? | find?+replace?, delete_files?, expected_version? })
Single-file edit, served live. Two modes — \`content\` rewrites the
whole file; \`find\`+\`replace\` does a server-side substring substitute
(~200 bytes on the wire, preferred for tweaks). Unchanged files are
preserved. \`delete_files\` removes paths. See the deploy topic for
the full shape.

## project_rollback({ project_id })
Move \`active_release_id\` to the previous retained release. This changes
the serving pointer; it does not rebuild or mutate either release.

## project_deploys({ project_id })
Deploy history, successes and rejections interleaved by time (up to 30
entries), each tagged with \`status\`:
  { deploys: [
    { status: "success", version, message, promoted_at, is_live, deployed_by, commit_sha, ... },
    { status: "rejected", version, reason, message, at, is_live: false },
  ] }
A rejected entry's \`version\` is the version it would have become
(may be \`null\`); it never went live.

## project_restore_version({ project_id, version })
Restore a specific past version as the live version.

## project_undeploy({ project_id })
Take the project off the public subdomain. Files and database stay.
Reverse with project_deploy.

## project_archive({ project_id }) / project_unarchive({ project_id })
Hide from the project list and revoke the subdomain. Data preserved.
Use for old projects you don't want cluttering project_list but might
revive later.

## project_rename({ project_id, name?, description? })
Changes the display name and/or description. The project slug and
\`*.somewhere.site\` subdomain are immutable.

## project_export({ project_id })
Pull every file in a project (static + functions) in one call — works
from any MCP client. Pair with project_deploy to write back. (CLI:
somewhere pull <id> does the same to disk.)

## project_transfer({ project_id, to_email })
Transfer ownership. If the target email isn't a platform account yet,
they get an invite email. Includes the project's data, files,
functions, and env vars.

## project_delete({ project_id })  →  project_delete_confirm({ project_id, code })
Two-step. The first call SUCCEEDS with { ok: true, status:
"needs_confirmation", confirmation_code } — minting the code is that
step's whole job, so it is never an error, and the response carries no
error_code and no canonical_error. (\`code\` carries the same value for
callers already reading it.) Pass that code to project_delete_confirm
within 10 minutes only after human authorization. Before confirmation,
nothing changes. Confirmation immediately takes the project and its
hostnames offline, blocks new project effects, retains its database,
files, functions, environment variables, and domain bindings for 30 days,
then permanently erases them. Recovery during the retention period
requires support.

## deploy_status({ project_id })
Returns deploy metadata including the active release, current version,
last-deploy timestamp, and file counts. Use it to verify the intended
immutable release is the serving authority.

## What NOT to do
- Don't call project_deploy when you only want to change one file —
  use project_patch. project_deploy fully replaces static files (any
  file you omit is deleted), but functions you omit are merge-preserved,
  NOT deleted — and the deploy warns you, naming each preserved function.
  Pass replace_functions:true only when you actually intend to drop them.
- Don't call project_delete in a script without surfacing the
  confirmation code to a human first.

## Outbound webhook subscriptions — the raw-body signature

Subscribe a URL to one event with \`PUT /v1/webhooks/<event>\` (developer
key; body \`{ project_id, url, enabled?, secret? }\`); list with \`GET
/v1/webhooks?project_id=…\`. Events are the vocabulary in the platform's
webhook registry (auth, email, deploy, ingest and function_error events; the
payment names in that registry have no emitter today — see docs({ topic:
'payments' })). Deliveries and redrives: \`webhook_deliveries_list\`,
\`webhook_delivery_redrive\`.

Wire format (from the sender): the JSON body is
\`{ event, project_id, timestamp, source, data }\` — \`timestamp\` is an ISO
string, \`source\` is \`"live"\` or \`"test"\`, \`data\` is the event
payload. Headers: \`X-Somewhere-Event\`, \`X-Somewhere-Project\`,
\`X-Somewhere-Event-Id\`, \`X-Somewhere-Delivery-Id\`, \`X-Somewhere-Attempt\`
(and \`X-Somewhere-Retry: 1\` on retries). When the subscription has a secret,
\`X-Somewhere-Signature\` is the hex HMAC-SHA256 of the RAW body bytes with
that secret — no timestamp, no \`t=\`/\`v1=\` prefix. Only the body is signed:
the headers, including the event id, are NOT covered by the MAC, so treat
\`X-Somewhere-Event-Id\` as a delivery hint you accept once the body verifies,
not as authenticated data. This differs from the project auth-webhook drain
(\`auth_webhook_set\`), which signs \`t={ms},v1={hex}\` over
\`\${ms}.\${rawBody}\` — verify each surface with its own scheme.

Setup: store the same secret you passed to \`PUT /v1/webhooks/<event>\` with
\`somewhere env set WEBHOOK_SECRET <secret>\` and read it as
\`sw.env.WEBHOOK_SECRET\`. Verification only — what you do after is your
app's contract:

\`\`\`ts
export default async function (req, sw) {
  const raw = await req.text();
  const expected = await sw.crypto.hmacSha256Hex(raw, sw.env.WEBHOOK_SECRET);
  const received = req.headers.get('X-Somewhere-Signature') ?? '';
  if (!sw.crypto.timingSafeEqual(expected, received)) return new Response('bad signature', { status: 401 });
  const { event, project_id, timestamp, source, data } = JSON.parse(raw);
  // Verified. Retries re-deliver the same event id (header) and the same body;
  // make whatever you do next idempotent on that id in your own storage.
  return new Response('ok');
}
\`\`\`
`,

  'groups': `# Project groups

A group is a developer-owned collection of projects that share members and a
design theme — organize related apps and widen access in one grant instead of
adding collaborators to each project separately.

## The model

- One group per project. Adding a project already in another group returns
  409 GROUP_CONFLICT — remove it from the old group first.
- Effective access = union of project owner, direct collaborator, and group
  member. When the same user appears at more than one level, the most
  permissive role wins.
- Groups do not transfer ownership or affect billing. Work always bills the
  project's owner; projects.user_id stays put.

## Roles

owner — creator; can delete the group, manage membership (invite/revoke),
manage the project roster, and write the shared design theme.
editor — can add/remove projects and write the theme; cannot manage
membership and cannot delete the group.

## Effective role on member projects

A group member's role grants access to ALL of the group's projects —
effective role on a project = MAX(direct collaborator role, group role).
Every group member is at least an editor: read + write, including deploy,
promote, restore, and database writes. Project OWNERSHIP never comes from a
group — billing and delete stay with the project owner regardless of
group membership.

## Membership invites

Membership management is OWNER-ONLY. The owner invites by email; the
platform sends the invite automatically and the invitee accepts with the
token from that email (or the emailed link).

  group_invite_create({ group_id, email, role? })
    → { invited: true, email, expires_at }
    Role defaults to editor. Invite expires in 7 days. Re-inviting the
    same email replaces the prior open invite. Errors: VALIDATION_ERROR
    (bad email/role, self-invite), FORBIDDEN (not owner).

  group_invite_list({ group_id }) → { invites: [{ email, role,
    invited_at, expires_at }] }  — pending invites only.

  group_invite_accept({ group_id, token })
    → { accepted: true, group_id }
    The caller must be signed in as the invited email with a verified
    email. Errors: EMAIL_NOT_VERIFIED, INVITE_INVALID, INVITE_USED,
    INVITE_EXPIRED, INVITE_WRONG_ACCOUNT, GROUP_NOT_FOUND.

  group_invite_revoke({ group_id, email }) → { revoked: true }
    Revokes a PENDING invite only — an accepted invite is membership,
    not an invite. 404 NOT_FOUND if there's no pending invite for that
    email.

## Removing an accepted member

REST/dashboard-only — no MCP verb for this yet.

  DELETE /v1/groups/:id/members/:user_id → { removed: true, group_id,
    user_id }
    Owner-only, same authority as invite management. The group owner
    can't be removed through this route — delete the group instead.
    404 NOT_FOUND if that user isn't an accepted member.

## Create and organize

  group_create({ name, description? })
    → { id, owner_id, name, description, created_at, updated_at,
        role: 'owner', project_count: 0 }

  group_add_project({ group_id, project_id }) → 409 GROUP_CONFLICT if taken

  group_get({ group_id })
    → { ...group, projects: [{id,name,subdomain,status}],
        members: [{user_id,role}], design_tokens: {} }

The project_id must be a UUID — slug resolution is not available on these
endpoints; use project_list or project_get to find it. group_list() returns
all groups you own or belong to (with role and project_count).
group_remove_project({ group_id, project_id }) detaches a project without
deleting it.

Example flow:
  1. group_create({ name: "Acme Suite" }) — save the returned id
  2. project_list() — find the UUID for each project to add
  3. group_add_project({ group_id, project_id })
  4. group_get({ group_id }) — verify the roster and token shape

## The shared theme

A group carries design_tokens (a JSON object, 64 KB max) merged into member
projects' styling at serve time — font stacks, color palettes, and spacing
scales flow from one place to all projects in the group.

  GET /v1/groups/:id/tokens → { tokens, updated_at }
  PUT /v1/groups/:id/tokens  body: { tokens: { ... } }  (owner or editor)

## Deleting a group

group_delete({ group_id }) is owner-only. It detaches all member projects —
the projects themselves are never deleted.
REST: DELETE /v1/groups/:id

`,

  'search': `# Search — Two Surfaces

The platform has two search systems for two different jobs.

## Managed file search — point it at a file (inside functions)

\`\`\`js
await sw.search.add('/uploads/manual.pdf')
const hits = await sw.search.query('How do I rotate the signing key?')
\`\`\`

\`add(path)\` takes a file path and nothing else. The platform extracts the
text, splits it into passages, indexes them, and resolves only once the file is
actually searchable — you never choose a chunk size, batch anything, or write
embedding code. Results carry the source file and its location, so a hit can
cite where it came from.

Ownership is derived from the signed-in user on the request; it is never passed
as an argument and therefore cannot be forged. Each user searches only what they
added. The index tracks the file, so rewriting a file replaces its passages and
deleting it removes them — there is nothing to re-index.

The string form of \`query()\` searches this managed corpus. The object forms
\`sw.search.upsert({ index, items })\` and \`sw.search.query({ index, query })\`
are unchanged and remain the manual path for content you compose yourself.

## File search — sw.fs.search (inside functions only)

Full-text search across the project's text files. Used by code agents
to grep code, search docs, find TODOs.

const hits = await sw.fs.dev.search({ path: '/src/', query: 'TODO', limit: 50 })

This is documented in the sw.fs topic. Per-project full-text index,
kept in sync automatically on every fs write/delete/move/replace.

## Semantic search — search_index_* MCP tools

Vector search for product features (FAQ search, semantic
recommendations, RAG retrieval). Embeddings are 768-dim
(cosine distance). Each project can hold many named indexes.

Indexes can be managed from MCP (search_index_create / upsert / query
etc.) and from inside your deployed function via sw.search.* — same
operations, no API key juggling. See "From inside a function" below.

## search_index_create({ project_id, name })
Idempotent — returns the existing index if name already exists.
Returns { name, project_id, dimensions, distance_metric, created_at }.

## search_index_list({ project_id })
Lists every index on the project: [{ name, item_count, created_at }].

## search_delete({ project_id, index, ids? })
Delete from a search index. Pass ids (a JSON array of item id
strings) to remove specific items; omit ids to drop the entire
index AND all items in it (irreversible).

## search_upsert({ project_id, index, items })
Insert or replace items. items is a JSON array of:
  { id, content, metadata? }

  search_upsert({
    project_id: "my-app",
    index: "faqs",
    items: JSON.stringify([
      { id: "faq-1", content: "How do I reset my password?", metadata: { category: "account" } },
      { id: "faq-2", content: "Where can I see my billing history?", metadata: { category: "billing" } }
    ])
  })

content is embedded server-side — you never compute embeddings
yourself. metadata is returned alongside results but NOT searched.
Max 100 items per call.

## search_query({ project_id, index, query, limit? })
Returns top N matches by cosine similarity:
  { results: [{ id, score, content, metadata }] }

  search_query({
    project_id: "my-app",
    index: "faqs",
    query: "I forgot my login",
    limit: 5
  })

Score is 0–1. Higher is closer. Limit defaults to 10, max 100.

## From inside a function — sw.search.*

Same surface, same args, no API key. Use sw.search inside a deployed
function — the platform binding handles auth and project scope.

  // Index management
  await sw.search.createIndex('faqs')
  const idxs = await sw.search.listIndexes()
  await sw.search.deleteIndex('faqs')

  // Upsert
  await sw.search.upsert({
    index: 'faqs',
    items: [
      { id: 'faq-1', content: 'How do I reset my password?', metadata: { category: 'account' } },
    ],
  })

  // Query
  const { results } = await sw.search.query({
    index: 'faqs',
    query: 'I forgot my login',
    limit: 5,
  })

  // Remove specific items
  await sw.search.remove({ index: 'faqs', ids: ['faq-1'] })

## When to use which
- Searching files (code, markdown, configs in your project) → sw.fs.search
- Semantic / "find similar meaning" over your app's content → sw.search.* (or search_index_* MCP)
- Searching log bodies or analytics → use sw.logs / sw.analytics.query

## What NOT to do
- Don't put PII in metadata if you don't have to — it's stored with
  the embeddings.
- Don't reindex a whole catalog on every write; batch upserts of 100.
- Don't expect exact-match — semantic search ranks by meaning, not
  keyword overlap.
`,

  'render': `# Render — PDFs

Use \`browser\` for screenshots and interactive visual verification. Use
\`render_pdf\` or \`sw.render.pdf\` for invoices, tickets, reports, and other
PDF output.

## render_pdf({ url? | html?, format?, landscape?, print_background?, wait_for?, project_id?, storage? })

  render_pdf({
    html: "<h1>Invoice #123</h1>...",
    format: "Letter",
    print_background: true
  })
  // → { format: "pdf", bytes: "JVBERi0...", size_bytes: 14821 }

Defaults: Letter, portrait, backgrounds rendered.
format: "A4" | "A3" | "Letter" | "Legal" | "Tabloid".
landscape: true rotates the page.

Same storage option as screenshot — pass project_id + storage to write
straight to the file store.

## Common pattern

Generate a PDF invoice on demand inside a deployed function:
  export default async function(req, sw) {
    const { invoiceId } = await req.json()
    const html = await renderInvoiceHTML(invoiceId, sw)
    // sw.render.pdf returns a raw Response when no storage path is set —
    // pipe it straight to the client.
    return sw.render.pdf({ html, format: 'Letter' })
  }

Or write the PDF to file storage and return its URL:
  export default async function(req, sw) {
    const { invoiceId } = await req.json()
    const html = await renderInvoiceHTML(invoiceId, sw)
    const result = await sw.render.pdf({
      html,
      format: 'Letter',
      storage: \`/invoices/\${invoiceId}.pdf\`,
    })
    // result = { storage_path: '/invoices/...', size_bytes, content_type }
    return Response.json({ url: \`https://\${sw.subdomain}.somewhere.site/storage\${result.storage_path}\` })
  }

## Limits
- 30 second hard timeout per render. Pages that take longer fail.
- Inline returns hit JSON size limits — use storage for >5MB outputs.
- One render at a time per project (no concurrent burst).

## What NOT to do
- Don't pass user-controlled URLs without a domain allowlist — the
  renderer will fetch any URL you give it.
- Don't render on every page load — cache to /storage and reuse.
`,

  'browser': `# Browser — your live app's eyes, ears, and hands

\`browser\` opens your DEPLOYED app in a real headless browser so you can
SEE it, INSPECT it, and DRIVE it — one tool for the whole loop of "what
does my app look like, is it healthy, and does it actually work?"

For the complete verification loop, run \`somewhere verify --url <live-or-local-url> --flow flow.json\` or MCP \`site_verify\`. The exact flow object is \`{ "actions": [{ "fill": "#name", "value": "Potluck" }, { "click": "#save" }, { "expect": { "selector": "#status", "text": "Saved" } }], "expect_requests": [{ "path": "/api/private", "status": 401 }], "visible_only": true, "viewports": ["desktop", "mobile"] }\`; omit it for a page load, health report, and both screenshots. Every viewport gets a fresh browser that closes inside the call, including when a step fails.

- **Eyes** — a screenshot of the page.
- **Ears** — console errors, page errors, and failed network requests
  (a backend 500 shows here even when the page looks fine).
- **Hands** — click / fill / assert your way through a real flow.

\`run_code\` proves a function's backend; \`browser\` proves the rendered
UI. The report is SIGNALS-FIRST: signals come before the screenshot, and
\`passed\` reflects step outcomes only — ALWAYS read failed_requests too.

The principle: **act by selector, verify by signals, screenshot small +
last.** You wrote the DOM, so target elements directly — don't guess at
pixel coordinates like a computer-use agent staring at a stranger's
screen.

## Just look (omit steps)

Omit \`steps\` and you get a small screenshot, the console/network
signals, AND the data-testid map + an interactive-element outline (tag,
id, testid, text, selector) — the handles you can act on, instead of
reverse-engineering selectors from scraped HTML. Every entry also carries
\`visible\` (false for hidden/display:none/visibility:hidden/aria-hidden,
or a zero-size box) and, when true, \`disabled\` — so a control that a
signed-out visitor cannot actually operate reads that way in the outline
itself, no follow-up probing required:

  browser({ project_id: 'my-saas' })
  // → { console_errors, page_errors, failed_requests,
  //     screenshots: [{ label: 'page', fs_path: '/_browser_tests/.../00-page.jpg' }],
  //     dom_outline: [{ tag:'button', testid:'submit', text:'Log in', selector:'[data-testid="submit"]', visible: true },
  //                    { tag:'button', testid:'delete-user', text:'Delete', selector:'[data-testid="delete-user"]', visible: false }, ...],
  //     testid_map: { submit: '[data-testid="submit"]', ... }, final_url, passed }

For a quick screenshot of your app, this IS the call — a url or
project_id with no steps.

## Capture any page, or render raw HTML

Use \`browser\` to capture a public page or render raw HTML:

  // Any public third-party page — pass a url with NO project_id:
  browser({ url: 'https://example.com' })

  // Render a raw HTML snippet straight to an image (e.g. an OG card):
  browser({ html: '<h1 style="color:red">Hello</h1>', width: 1200, height: 630 })
  // → { content_type: 'image/png', size_bytes, base64 }

  // …or save the snippet straight to the project file store:
  browser({ html: '<div>…</div>', project_id: 'my-app', storage: '/og/card.png' })
  // → { storage_path: '/og/card.png', size_bytes }

\`html\` mode skips navigation/steps/DOM-map — it just returns the picture.
\`width\` / \`height\` / \`wait_for\` tune it. When you pass \`project_id\`, a
\`url\` is scoped to that project's origin; omit \`project_id\` to hit an
arbitrary url. (PDFs have no browser equivalent — use \`render_pdf\`.)

## Drive a flow (add actions)

\`actions\` is the one shared action shape used by the MCP tool, a CLI
\`--actions\` JSON file, and \`verify --flow\`'s \`actions\` field. Each item
has exactly one action key; selector-taking actions put the selector directly
under that key:

\`\`\`json
[
  { "fill": "#email", "value": "a@b.co" },
  { "select": "#plan", "value": "pro" },
  { "click": "button[type=submit]" },
  { "wait": ".dashboard" },
  { "expect": { "selector": ".welcome", "text": "Hi", "visible": true, "count": 1 } },
  { "eval": "document.title" }
]
\`\`\`

\`wait\` is a CSS selector or non-negative milliseconds. \`expect\` requires
\`selector\` plus at least one of \`text\`, \`value\`, \`visible\`, or \`count\`. Actions
stop on the first failure. Expanded \`steps\` remain accepted for existing
callers, but new flows use \`actions\`.

## Logged-in flows

  browser({ project_id: 'my-saas', auth: { user_id: 'usr_123' }, actions: [...] })

Mints a 1-hour session for that app user (audited) and injects it before
navigation, so authed pages work. Requires a project.

## Reading the result

\`{ console_errors, page_errors, failed_requests, steps:[{step, ok,
error?, duration_ms}], screenshots:[{label, fs_path}], final_url, passed }\`

\`passed\` reflects step outcomes only — ALWAYS read failed_requests too:
a backend 500 shows there even when every step visually "passed". A
failed step aborts the run but the state at failure is still returned;
pass \`continue_on_failure: true\` to run them all.

## Screenshots — small by default

Screenshots are tuned for cheap vision tokens: ~800px wide JPEG at
quality 70, stored as a file path (never inlined). Need pixel precision?
Override per run:

  browser({ project_id: 'my-saas', screenshot: { width: 1280, format: 'png' } })

Fields: width (default 800, never upscaled past the viewport), format
('jpeg' default | 'png'), quality (1–100, jpeg only, default 70). The
override applies to the no-steps page shot and every screenshot step.

## Limits
- 30 actions, ~60s total budget, one run at a time per project.
- A screenshot needs a project to store the image — pass project_id, or
  a *.somewhere.site url that resolves to a project you own.
- Look at / test your OWN projects only.
`,

  'github': `# GitHub push-to-deploy

Connect a repository to a project and every push to the tracked branch
deploys automatically — the same raw-source pipeline as \`somewhere deploy\`.
Live for every project; no tier gate.

## Preferred path: GitHub App

The dashboard's Import from GitHub flow and \`somewhere git connect\` use the
GitHub App. A human grants an account/repository on GitHub once; the platform
stores the installation identity, mints short-lived tokens when needed, and
receives signed App-level push events. No PAT paste and no manual repository
webhook are required.

CLI:

  somewhere git connect owner/name [--project my-app] [--branch main] [--root web]
  somewhere git status [--project my-app]
  somewhere git disconnect [--project my-app]

\`git connect\` opens GitHub only when consent is missing, resumes
automatically, deploys the selected branch's current HEAD immediately, waits
for that exact commit, and prints commit, status, logs, and live URL. All
three commands support \`--json\`, and \`git disconnect\` stops future pushes
from deploying while leaving the currently deployed site live.

MCP / REST App flow:

  github_app_install({ return_to? })
  → { install_url }                 // give this link to the human

  github_installations({})
  → { app_configured, installations: [{ installation_id, account_login }] }

  github_list_repos({ installation_id: 123 })
  → [{ name, private, default_branch, ... }]

  github_connect({
    project_id: "my-app",
    repo: "owner/name",
    installation_id: 123,
    branch: "main",
    deploy_head: true
  })
  → { repo, branch, via_app: true,
      initial_deploy: { status: "deploying", commit_sha, commit_message } }

Poll \`github_status\` for that exact commit until \`last_status\` is
\`deployed\` or \`failed\`. Dashboard import and the CLI perform this wait;
\`connected\` alone is not proof of a deploy.

## REST connect shape

  POST /v1/github/connect
  {
    "project_id": "my-app",
    "repo": "owner/name",
    "branch": "main",          // optional, default "main"
    "root_dir": "web",         // optional — deploy one subfolder (monorepos)
    "installation_id": 123,    // preferred — caller-owned App installation
    "deploy_head": true         // resolve + deploy branch HEAD immediately
  }
  → { repo, branch, root_dir, hook_installed, via_app, initial_deploy }

For compatibility, \`github_token\` still installs a per-repository webhook
and supports private repositories without an App installation. With neither
App installation nor token, public repositories can use the returned
\`manual_setup\` URL + secret. Both webhook forms verify the raw GitHub HMAC
before dispatching a deploy.

Dashboard: New project → Import from GitHub creates the project, connects the
App installation, deploys HEAD, and only reports success after that commit
deploys. Project Settings → GitHub manages an existing connection.

## Status + disconnect

  GET /v1/github/connection?project_id=…
  → { connected, repo, branch, root_dir, hook_installed, via_app,
      last_commit_sha, last_commit_message,
      last_status: "deploying" | "deployed" | "failed", last_error }

  DELETE /v1/github/connection?project_id=…   // current site stays live

## What deploys

A push to the tracked branch deploys the repo (or \`root_dir\` subfolder) as
raw source. Pushes to other branches are ignored. GitHub-driven versions record
deploy source \`github\` plus the GitHub commit SHA and first-line message.

- Vite/React SPAs deploy unchanged.
- Monorepos: set \`root_dir\` to the app folder.
- Env vars are baked at deploy time. Push again after changing env vars.
- Next.js SSR is not supported; use a Vite SPA plus functions.
- Very large repos can fail; trim with \`root_dir\` or deploy from disk.
`,

  'video': `# Video — Upload, Stream, Manage

Upload video files, get HLS + DASH playback URLs, list and delete.
The platform stores videos on a streaming service and gives you direct
upload URLs the client uses without ever touching your worker.

## Plan feature

Starting a NEW video upload is included on **Pro** and **Scale**. On **Free**
and **Builder**, \`video_upload_url\` (and \`sw.video.uploadUrl\`) returns
\`VIDEO_NOT_IN_PLAN\` with a 403 before anything is charged or reserved — the
error names the plans that include it and the plan the account is on.
Retrying does not change this answer.

Video already uploaded is NOT gated on any plan: \`video_list\`, \`video_get\`,
\`video_delete\` and playback keep working everywhere, so moving between plans
never costs an account reach to video it owns.

The live per-plan answer is published as \`limits.video_enabled\` on
\`GET /v1/pricing\`; this page states it, it does not decide it.

## video_upload_url({ project_id, title?, max_duration_seconds?, require_signed_urls? })

Get a one-time upload URL. The client POSTs the video bytes directly
to this URL using the TUS resumable upload protocol — your function
never sees the bytes.

  video_upload_url({
    project_id: "my-app",
    title: "Demo walkthrough",
    max_duration_seconds: 600
  })
  // → { upload_url: "https://<direct-upload-url>/...", video_id: "vid_abc",
  //     max_duration_seconds: 600, expires_at: "2026-09-02T11:22:33.000Z" }

max_duration_seconds: 30–21600 (6 hours), defaults to 600 (10 minutes).
Uploads exceeding the limit are rejected at ingest. The ceiling you name
is held against video storage from the moment the link is issued and is
released when the upload lands or the link expires, so ask for a longer
window only when the source really is longer.

expires_at: when the link stops working. Mint it when the user is ready
to upload, not ahead of time.

require_signed_urls: true means playback requires a short-lived signed
token. Use for paid content. Default false (public playback).

## video_list({ project_id, limit? })
Returns videos on the project, newest first.
limit defaults to 50, max 200.

  [
    {
      id: "vid_abc",
      status: "ready" | "queued" | "inprogress" | "error",
      duration_seconds: 184,
      size_bytes: 24310291,
      thumbnail: "https://...thumbnails/thumb.jpg",
      preview: "https://...preview.mp4",
      hls_url: "https://...manifest/video.m3u8",
      dash_url: "https://...manifest/video.mpd",
      created_at: "2026-04-25T...",
      ready: true
    }
  ]

## video_get({ id })
Same shape as a list item. Useful for polling status after upload —
ready: false → ready: true once encoding finishes (typically within
minutes).

## video_delete({ id })
Permanently delete the video and all derived files. Irreversible.

## Common patterns

Browser upload flow:
  // 1. Backend mints the upload URL
  const { upload_url, video_id } = await video_upload_url({ project_id })

  // 2. Frontend uploads via TUS (use the tus-js-client library)
  const upload = new tus.Upload(file, {
    endpoint: upload_url,
    onSuccess: () => savedVideoId(video_id)
  })
  upload.start()

  // 3. Backend polls video_get until ready, then shows the player
  const v = await video_get({ id: video_id })
  if (v.ready) renderPlayer(v.hls_url)

Embed in a page:
  <video controls>
    <source src="\${video.hls_url}" type="application/x-mpegURL">
  </video>
  // Use hls.js for cross-browser HLS playback.

## What NOT to do
- Don't proxy video bytes through your worker — the upload_url accepts
  the bytes directly from the client. That's the whole point.
- Don't poll video_get every 100ms; once a second is plenty.
- Don't issue the same upload_url to multiple clients — each URL is
  single-use.
`,

  'analytics': `# Analytics — Track Events, Query Aggregates

Per-project event tracking. Write events from anywhere (function,
browser, MCP), then aggregate them by hour / day / event / user.

Backed by an append-only event store. No per-user PII sanitization —
treat what you write as eventually visible to anyone with project
access.

## analytics_track({ project_id, event, user_id?, properties?, page?, referrer?, user_agent? })

  analytics_track({
    project_id: "my-app",
    event: "signup",
    user_id: "u_alice",
    properties: JSON.stringify({ plan: "builder", referrer: "blog" })
  })

event: required, max 128 chars. Pick a stable name — you'll filter on
this. Convention: snake_case verbs (signup, post_published, checkout_started).

properties: JSON object, max 8KB total. Up to 20 numeric values are
auto-aggregatable in queries (sum / avg). String values are kept as
labels for grouping but not summed.

page, referrer, user_agent are convenience fields for browser-side
tracking; treat them as optional metadata.

Returns { ok: true }. Track is fire-and-forget — there is no per-event
read API. Aggregate via analytics_query.

## analytics_query({ project_id, event?, from?, to?, group_by?, limit? })

  analytics_query({
    project_id: "my-app",
    event: "signup",
    from: "2026-04-01",
    to: "2026-04-25",
    group_by: "day"
  })
  // → [
  //     { day: "2026-04-01", count: 12, signup_count: 12 },
  //     { day: "2026-04-02", count: 18, signup_count: 18 },
  //     ...
  //   ]

event: omit to query across all events.
from, to: ISO-8601 string ("2026-04-01") or unix-ms integer.
group_by: "hour" | "day" | "event" | "user". Omit to get raw rows
(most recent first).
limit: defaults to 1000, max 10000.

When group_by includes a numeric property in the events, the query
returns sum_<prop> and avg_<prop> columns alongside count.

## Common patterns

Funnel:
  // Track stages
  analytics_track({ project_id, event: "checkout_started", user_id })
  analytics_track({ project_id, event: "checkout_completed", user_id })

  // Daily conversion
  const started = await analytics_query({ event: "checkout_started", group_by: "day" })
  const completed = await analytics_query({ event: "checkout_completed", group_by: "day" })

Per-user activity:
  analytics_query({ project_id, group_by: "user", limit: 100 })
  // → top 100 users by event volume

Browser-side tracking from your app (inside a deployed function).
Derive user identity from the signed app-user JWT — never trust an
ID sent by the browser.
  export default async function(req, sw) {
    const user = await sw.auth.fromRequest(req)   // null if signed out
    const body = await req.json()
    await sw.analytics.track(body.event, {
      user_id: user?.id,                          // server-derived, signed
      properties: body.properties,
      page: req.headers.get('referer'),
      user_agent: req.headers.get('user-agent'),
    })
    return Response.json({ ok: true })
  }

Query inside a function the same way:
  const today = await sw.analytics.query({ event: 'checkout_completed', group_by: 'day' })

## What NOT to do
- Don't write log lines through analytics — use sw.logs. Analytics
  is for things you want to count and aggregate, not narrative logs.
- Don't put PII in the event NAME (it goes into every grouping). Put
  it in properties if you must.
- Don't expect millisecond-level read-after-write — events are
  queryable within seconds, not instantly.
`,

  'inbox': `# Inbox — Inbound Email

Inbound email is domain-bound. Create addresses on a custom domain that
has been added to the project and has inbound email routing enabled
(enable it with \`domain_enable_email\`).
This prevents shared-platform-address confusion and stops users from
claiming mailboxes on domains they don't own.

## inbox_create_address({ project_id, address, label?, kind?, webhook_url?, forward_to? })
Create an inbox address, for example support@example.com. address must
be on a verified project custom domain with inbound email enabled.

kind defaults to "admin" — the address is shown in the project's Email
tab in the dashboard. Pass kind:"app" when minting per-user mailboxes
at runtime from your deployed app, so they don't flood the admin view.
sw.inbox.createAddress() from a deployed function defaults to "app"
for the same reason.

If webhook_url is provided, it must be https://. The create response
returns webhook_secret once; store it and verify X-Somewhere-Signature
on incoming webhooks.

Each POST body is \`{ schema_version: 2, type: "inbox.message.received",
message: {...} }\`. The same body also carries \`event:
"inbox.message.received"\` and \`data: {...}\` (identical to \`message\`) so
handlers written against the original payload shape keep working —
read \`message\` in new code.

forward_to wires forwarding in the same call — see inbox_forward_set.

## inbox_forward_set({ address_id, forward_to })
Forward a copy of every inbound message to an external mailbox — the
inbox the user already reads (you@gmail.com). The project inbox ALWAYS
keeps its copy; forwarding is additive, never a redirect.

Returns status "active" (live now) or "pending_verification" — the
destination mailbox just received a one-time confirmation email.
Surface the returned message to the user ("check your inbox and click
the confirmation link"); forwarding starts automatically once clicked,
no further call needed. Poll inbox_forward_set again or list
inbox_addresses (rows carry forward_to + forward_status) to see the
status flip. Spam-suspect messages are stored but never forwarded.
Idempotent — call again to change the destination.

## inbox_forward_remove({ address_id })
Stop forwarding. Inbound mail keeps landing in the project inbox.

## inbox_addresses({ project_id, kind? })
List inbox addresses on the project. Defaults to kind="admin"
(dashboard-managed). Pass kind="app" to enumerate runtime-minted ones,
kind="all" to see both. webhook_secret is never echoed back after
creation. Rows include forward_to + forward_status ("active" |
"pending_verification" | null) when forwarding is configured.

## inbox_delete_address({ id })
Remove the address. New mail to it bounces. Existing messages stay
queryable.

## inbox_list({ project_id, address_id?, unread?, q?, limit? })
Most recent messages first. limit defaults to 50, max 200. Pass
address_id to scope to one inbox, unread:true to skip messages already
marked read, or q to free-text search across subject, body preview, and
sender (tokens match as prefixes — "ord" matches "order").

  [
    {
      id: "msg_abc",
      mail_from: "alice@example.com",
      mail_to: "support@example.com",
      subject: "Re: order #123",
      text_preview: "Just confirming this shipped...",
      has_html: true,
      attachment_count: 2,
      read_at: null,
      received_at: "2026-04-25T...",
      size_bytes: 4218
    }
  ]

## inbox_get({ id, include_html? })
Single message + raw MIME URL. Pass include_html:true to include the
stored html_preview field (capped at ~50KB). Attachment metadata is
always returned when present — each entry includes filename,
content_type, and size_bytes. Use inbox_attachment to download.

## inbox_mark_read({ id, read? })
Toggle the read flag. read defaults to true. Idempotent. Use to drive
"unread badge" UIs and to gate webhook-fanout retries.

## inbox_attachment({ id, index })
Stream one attachment by zero-based index from inbox_get.attachments.
Returns binary bytes with original content-type and filename.

## inbox_delete({ id })
Delete the message, raw MIME object, and stored attachment objects.
Irreversible.

## inbox_reply({ id, body? | text? | html?, subject? })
Send a threaded reply to an inbound message. Sends from the same
address that received the message and sets In-Reply-To / References
so Gmail / Outlook / Apple Mail render it inline with the original
thread. Subject is auto-prefixed with "Re:" if it isn't already.

Requires the receiving domain to be verified as a sender domain on
the project (otherwise replies would be unsigned and bounce). Same
sender-domain verification as /v1/email/send.

  await sw.inbox.reply(messageId, { body: 'Thanks, refunding now.' })

The primary use case: an agent that watches the inbox, drafts replies
via \`sw.ai.chat\`, and ships them with one call.

## inbox_send({ address_id, to, subject, body? | text? | html? })
Start a NEW conversation from one of your inbox addresses
(e.g. hello@yourdomain.com). Same sender-domain check as inbox_reply.
The platform issues a Message-ID with the outbound so the recipient's
reply lands back in the same thread automatically — viewable via
inbox_threads / sw.inbox.threads().

  await sw.inbox.send(addressId, {
    to: 'newcustomer@example.com',
    subject: 'Welcome to our beta',
    body: 'Thanks for signing up — here\\'s your login.'
  })

Use inbox_reply for replies and inbox_send for new threads. Both log
to the same conversation view.

## inbox_threads({ project_id, address_id?, include_spam?, limit? })
List conversation threads — one entry per unique thread_root, with
counts and last-message metadata aggregated across inbound + outbound
rows. Default-hides threads whose latest inbound is spam_suspect.

  [
    {
      thread_root: "<abc@example.com>",
      last_at: "2026-05-11T14:22:18Z",
      first_at: "2026-05-09T09:11:02Z",
      message_count: 4,
      unread_count: 1,
      last_subject: "Re: refund #1421",
      last_counterparty: "alice@example.com",
      last_direction: "in"
    }
  ]

## inbox_thread_get({ project_id, root })
Full conversation by thread_root — all inbound + outbound messages
sorted by time. Use this to render the conversation view in an admin
UI or to feed prior context into \`sw.ai.chat\` before drafting a reply.

  const { messages } = await sw.inbox.thread(threadRoot)
  for (const m of messages) {
    if (m.direction === 'in')  console.log('←', m.mail_from, m.text_preview)
    else                       console.log('→', m.to,        m.subject)
  }

## Spam handling

Every inbound message is checked against the Authentication-Results
header (SPF/DKIM/DMARC verdicts from the receiving relay) and against
your project's allow/deny rules. The result is stored on the message
as spf_result / dkim_result / dmarc_result / spam_suspect.

Default flag logic:
  - Allow rule match → never spam_suspect (allow wins)
  - Deny rule match  → spam_suspect = true
  - DMARC fail       → spam_suspect = true
  - SPF fail AND DKIM fail → spam_suspect = true
  - Otherwise → spam_suspect = false

inbox_list and inbox_threads hide spam_suspect by default. Pass
include_spam:true to include them (e.g. a "Show spam" view in an
admin UI). The flag is also visible on inbox_get so you can render
a "Failed authentication" badge.

## inbox_rule_list({ project_id, address_id? })
List allow/deny rules. Returns project-wide rules + rules scoped to
the address_id (when provided).

## inbox_rule_create({ project_id, address_id?, pattern, action })
Create an allow or deny rule. pattern:
  - "alice@example.com"  → exact mailbox
  - "example.com"        → domain (and subdomains)

action: "allow" or "deny". Omit address_id to apply project-wide.

  // Whitelist a sender whose DMARC keeps failing
  await sw.inbox.rules.create({ pattern: 'newsletter@partner.com', action: 'allow' })

  // Blacklist a domain
  await sw.inbox.rules.create({ pattern: 'evil.example', action: 'deny' })

## inbox_rule_delete({ id })
Remove a rule. Future inbound mail re-evaluates without it.

## From inside a deployed function

sw.inbox mirrors the REST surface — all calls scoped to this project:

  await sw.inbox.list({ unread: true, limit: 25 })
  await sw.inbox.list({ q: 'refund' })           // search subject/body/sender
  await sw.inbox.list({ include_spam: true })    // include flagged messages
  await sw.inbox.get(id, { include_html: true })
  await sw.inbox.reply(id, { body: 'Thanks.' })  // threaded reply
  await sw.inbox.send(addressId, {               // new thread
    to: 'alice@x.com', subject: 'Hi', body: '...'
  })
  await sw.inbox.threads({ limit: 25 })          // grouped conversations
  await sw.inbox.thread(rootId)                  // single conversation
  await sw.inbox.markRead(id)               // or sw.inbox.markRead(id, false)
  const res = await sw.inbox.attachment(id, 0)   // Response — stream/download
  const raw = await sw.inbox.raw(id)             // Response — RFC-822 source
  await sw.inbox.delete(id)                      // remove message + attachments
  await sw.inbox.createAddress({ address, webhook_url })
  await sw.inbox.deleteAddress(addressId)
  await sw.inbox.rules.list()
  await sw.inbox.rules.create({ pattern: 'evil.com', action: 'deny' })
  await sw.inbox.rules.delete(ruleId)

## Common pattern: webhook-first support inbox

  // 1. Create once during setup
  await inbox_create_address({
    project_id,
    address: 'support@yourdomain.com',
    label: 'Support',
    webhook_url: 'https://yourdomain.com/api/inbox-webhook'
  })

  // 2. In your webhook handler, verify X-Somewhere-Signature using the
  //    webhook_secret returned at creation, then persist/route the event.
  //    The platform retries failed/stale webhook deliveries from cron.

  // 3. Poll as a fallback/admin view
  const { messages } = await inbox_list({ project_id, unread: true })
  for (const m of messages) {
    await processSupportTicket(m)
    await inbox_mark_read({ id: m.id })
  }

## Limits

| Tier    | Addresses | Stored msgs | Retention |
|---------|-----------|-------------|-----------|
| Free    | 1/project | 100/project | 30 days   |
| Builder | 10/project| 10,000      | 90 days   |

Past the message cap, FIFO eviction happens at insert time. A daily
retention sweep deletes anything older than the window. Both the cap
and retention apply per-project, not per-address.

## What NOT to do
- Don't create inbox addresses on platform domains like somewhere.tech
  or somewhere.site — use a custom domain owned by the project.
- Don't skip webhook signature verification for sensitive workflows.
- Don't delete messages until you've fully processed them; deletion is
  irreversible.
- Don't expect retention beyond the tier window — schedule processing
  promptly or copy the raw .eml to your own storage.
`,

  'calls': `# Calls — Real-Time Audio/Video Sessions

Build video calling, screen sharing, or live audio rooms. The platform
provides session creation; the heavy lifting (SFU mixing, NAT traversal,
SDP negotiation) runs on the platform's media backend. Your code only
deals with session IDs and SDP payloads — opaque blobs you pass through.

## calls_new_session({ project_id, thirdparty? })

  calls_new_session({ project_id: "my-app" })
  // → { session_id: "sess_xyz", project_id: "my-app" }

session_id: pass to subsequent track operations from the browser.
thirdparty: true → the media backend treats the session as pure data
(no platform-originated tracks). Default false. Most apps don't need this.

Sessions are ephemeral — the platform doesn't persist session_id.
Once both peers leave, the session is gone.

## Track operations (REST only — call directly from the browser)

After session creation the browser drives the call lifecycle by
calling these endpoints with its peer connection's SDP:

  POST /v1/calls/sessions/:session_id/tracks
    Body: { sessionDescription: { type, sdp }, tracks: [...] }
    Add local tracks to the SFU. Returns SDP answer.

  PUT /v1/calls/sessions/:session_id/renegotiate
    Body: { sessionDescription: { type, sdp } }
    Renegotiate when adding/removing tracks mid-call.

  PUT /v1/calls/sessions/:session_id/tracks/close
    Body: { tracks: [...], sessionDescription: { type, sdp } }
    Close specific tracks (mute camera, stop screen share).

These are called from the browser with an app-user JWT (the same JWT you
use for db_query / fs_read from a logged-in user). The smt_ developer key
is never required for the browser path — keep it server-side. SDP payloads
are passed straight through to the media backend.

## Common pattern: 1:1 video call

  // 1. Backend mints a session for each call
  const session = await calls_new_session({ project_id })
  // Hand session.session_id to BOTH peers through your own endpoints
  // (a polled/live-view read of a sessions row); realtime channels are
  // not reachable from a browser session.

  // 2. Each browser:
  const pc = new RTCPeerConnection()
  pc.addTrack(localVideo)
  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)

  // 3. Push the offer to the SFU
  const r = await fetch(\`/v1/calls/sessions/\${sessionId}/tracks\`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + jwt },
    body: JSON.stringify({
      sessionDescription: { type: 'offer', sdp: offer.sdp },
      tracks: [{ location: 'local', mid: '0', trackName: 'video' }]
    })
  })
  const { sessionDescription } = await r.json()
  await pc.setRemoteDescription(sessionDescription)

The wire protocol mirrors a standard WebRTC + SFU exchange — any client
that speaks the offer/answer SDP dance works.

## When to use calls vs realtime

- realtime — database-driven live updates a browser can subscribe to
  (declared live views); channels themselves are developer-authority only,
  so signalling has to travel through your own endpoints
- calls   — actual audio/video bytes (1:1 calls, group rooms, broadcasts)

## What NOT to do
- Don't try to inspect or modify SDP payloads on the server — they're
  passed through verbatim and are very specific to the peer's hardware.
- Don't store session_ids long-term — they're not durable, the SFU
  drops them as peers leave.
- Don't run the call's signaling through your function on every track
  add — the browser talks to /v1/calls/sessions/* directly, your
  worker just hands out fresh session_ids.
`,

  'sw.ai': `# sw.ai — AI Models (inside deployed functions)

## Default model recommendation

Omit both \`provider\` and \`model\` to start with free
\`gpt-5.6-luna\`. No API key or balance is needed. The allowance is
10 requests/minute and 200/day per project owner, across their projects,
on every plan. Each call accepts at most 8,192 estimated input tokens
(including system text, tools and retained history) and 1,024 output tokens.

The free path uses standard service with reasoning disabled, a 20-second
provider deadline including the response body, and no paid fallback.
A limit returns a structured error; it never silently charges your balance.
Use \`r.text\` for text, \`r.content\` for content blocks, and
\`r.parsed\` when requesting \`response_schema\`.

For larger requests or a different model, choose an explicit provider/model
from \`ai_catalog\`. Explicit \`provider: 'openai'\` or
\`model: 'gpt-5.6-luna'\` selects the paid path even for the same model.
Explicit \`provider: 'workers-ai'\` retains its separate included-model
limits. Free responses use platform credentials even if you configured BYOK.

## Provider credentials (optional BYOK)

Platform-managed credentials work without setup. To bill Anthropic or OpenAI
directly, a developer or project editor can store a dedicated control-plane
credential with \`POST /v1/ai/provider-keys\` and remove it with
\`DELETE /v1/ai/provider-keys/:project_id/:provider\`. Supported providers are
\`anthropic\` and \`openai\`. Dedicated credentials are never returned,
listed through \`sw.env\`, or injected into deployed code; matching calls
report \`external_billing: true\` and skip platform AI balance billing.

Ordinary project environment variables such as \`OPENAI_API_KEY\` and
\`ANTHROPIC_API_KEY\` remain available to the project's own functions through
\`sw.env\`. Setting either one does not enable platform BYOK routing.

## sw.ai.chat(options)

Return shape contract: \`result.content\` is always the normalized
content-block array (text blocks and, when supported, tool_use blocks).
\`result.text\` is the flattened text convenience for callers that only need
prose. Do not treat \`content\` as a string.

// Free default — no activation, no user billing. Rate-limited and capped.
const result = await sw.ai.chat({
  messages: [{ role: 'user', content: 'Write a haiku' }]
})
// result.content is the normalized content-block array (text + tool_use
// blocks). result.text is a flattened text convenience.

// provider:'workers-ai' opt-in — still available for existing callers and smoke tests.
const dev = await sw.ai.chat({
  provider: 'workers-ai',
  model: '${WORKERS_AI_DEFAULT_FREE_MODEL}',
  messages: [{ role: 'user', content: 'Summarize this: ...' }],
  max_tokens: 1024
})
// dev.content = [{ type: 'text', text: '...' }]
// dev.text is the flattened reply; free model → no charge

// (Avoid ${WORKERS_AI_REASONING_MODELS_SLASH} at low max_tokens — they
// burn 2k+ tokens on chain-of-thought before producing output. See "Free
// models" section below.)

// Paid Sonnet for user-visible quality:
const sonnet = await sw.ai.chat({
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  messages: [{ role: 'user', content: 'Write a haiku' }]
})
// result.content is the normalized content-block array (text + tool_use
// blocks). result.text is a flattened text convenience.
// result.stop_reason is 'end_turn' | 'tool_use' | 'max_tokens' | ...

// Paid premium model — same activation gate, billed per token at the rate
// shown in /v1/pricing.
// Models: grok-4 (top quality), grok-4-fast (cheap+fast),
//         grok-3-mini, grok-code-fast-1.
const grokResult = await sw.ai.chat({
  provider: 'xai',
  model: 'grok-4-fast',
  messages: [{ role: 'user', content: 'Explain quicksort in two sentences.' }],
  max_tokens: 256
})
// grokResult.text is the reply; grokResult.content is reshaped into the
// same normalized content-block array shape so client code is uniform.

// Paid model — same activation gate, billed per token at the rate shown
// in /v1/pricing. Call ai_catalog for the live model list and categories.
const gptResult = await sw.ai.chat({
  provider: 'openai',
  model: 'gpt-5.6-luna',
  messages: [{ role: 'user', content: 'Explain quicksort in two sentences.' }],
  max_tokens: 256
})
// gptResult.text is the reply; gptResult.content is reshaped into the
// same normalized content-block array shape so client code is uniform.
// conversation_id works on every provider — pass it and the platform
// replays prior turns from the per-project database. stream is the only
// field still gated to anthropic.

## Flex service tier (~50% discount)

The flex service tier serves your request from spare capacity. Trade-offs:

  • Cost: ~half the standard per-token rate (see /v1/pricing).
  • Latency: noticeably slower than standard.
  • Reliability: may return 429 resource_unavailable when capacity is tight.

Good fit: cron jobs, queue workers, batch enrichment, summarization,
nightly reports — anything where a 2–5s delay or a retry is fine.
Bad fit: live chat UX, anything a human is waiting on.

Opt in by passing service_tier: 'flex'. Default is 'standard'. The
field is only valid on provider: 'openai' — sending it on anthropic /
xai / workers-ai returns a VALIDATION_ERROR.

const flexResult = await sw.ai.chat({
  provider: 'openai',
  model: 'gpt-5.6-luna',
  service_tier: 'flex',
  messages: [{ role: 'user', content: 'Summarize this article…' }],
  max_tokens: 512
})
// On provider: 'openai', flexResult.service_tier and flexResult.model
// report what the provider says it served: 'flex', or 'standard' (also
// after the platform retried a flex capacity refusal on standard). When
// the provider response carries no served tier or model the field is null
// and the call's cost is pending (see "Cost on the result"). Cost is
// priced from the served tier when it is known.

When flex capacity returns 429, the platform first retries the same
request on standard, and the result's service_tier then reads
'standard'. When it cannot, the response carries the 429 with an
explicit hint to retry or fall back to service_tier:'standard':

try {
  return await sw.ai.chat({ provider:'openai', model:'gpt-5.6-luna', service_tier:'flex', messages })
} catch (err) {
  // err.code === 'UPSTREAM_ERROR', status 429 — capacity unavailable.
  return await sw.ai.chat({ provider:'openai', model:'gpt-5.6-luna', messages })
}

Per-model token rates are not hardcoded here — call \`ai_catalog\` (or
\`GET /v1/pricing\`) for the live per-model input/output rates and which
models your tier can use. Flex calls run at roughly half the standard rate.

To know which tier a call actually ran on, read \`result.service_tier\`
on the response.

## Cost on the result: settled or pending (OpenAI and Anthropic completions)

This contract applies to \`provider: 'openai'\` and \`provider: 'anthropic'\`
completions; xai, deepseek, deepinfra and workers-ai keep their existing
all-in \`cost\` shape and are not migrated. Every such completion carries a
\`cost\` object. When the platform has settled the
call, \`cost.total_cents\` is the all-in amount taken from your balance and
\`cost.total\` is the same amount as a dollar string. When the platform has
not yet been able to price the call — the provider response did not carry a
usable served model, tier, or token counts, or the accounting record could
not be completed — the result is still delivered and \`cost\` is
\`{ status: 'pending', total_cents: null, total: null }\`: null means
unknown, never zero and never an estimate. \`model\`, \`service_tier\` and
the \`usage\` token counts are null on that result when the provider did
not report them. The platform reconciles pending accounting itself; you do
not need to retry the call or replay the model. Your balance may already
reflect the call while its cost reads pending, and it is corrected when the
accounting completes. This describes cost reporting only; model
availability and catalog coverage are separate.

**Direct Anthropic completions.** \`provider: 'anthropic'\` calls go
straight to the provider, one accounting record per model invocation. The
platform does not substitute another provider behind a Claude call: there is
no automatic fallback, \`fallback_used\` is always false and
\`fallback_provider\` null. Requests run on the standard service tier. A
project-owned provider key keeps your exact model selection and takes no
platform debit. When the provider refuses admission with a documented
refusal (HTTP 400, 401, 402, 403, 404, 413 or 429) the balance hold is
released automatically; a native 400 returns \`VALIDATION_ERROR\`, or
\`CONV_HISTORY_REJECTED\` when a conversation is involved, and the other
refusals surface as \`UPSTREAM_AUTH_FAILED\`, \`UPSTREAM_BILLING\`,
\`UPSTREAM_RATE_LIMITED\` or \`UPSTREAM_ERROR\`. A provider 5xx returns
\`UPSTREAM_DOWN\`, a deadline \`AI_UPSTREAM_TIMEOUT\`, and those, transport
failures and malformed responses keep the accounting record open and
reconcile with \`retry: false\` rather than being assumed unbilled. An empty
paid response settles the usage it did consume and then returns
\`MODEL_EMPTY_RESPONSE\` carrying the \`cost\` object (pending when unknown).
A streamed call carries the same \`cost\` object on its final
\`message_delta\` event. A tool call the model left incomplete — missing id
or name, non-object input, or no \`tool_use\` stop — is never returned as
executable; the text and the accounting are kept.

**Current Claude models on provider: 'anthropic'.** \`claude-opus-5\` and
\`claude-sonnet-5\` are served with the provider's native reasoning on:
each carries a 1,000,000-token context window and a 128,000-token output
cap, and the reasoning the model emits is part of the output you are billed
for, counted once. A streamed call carries the thinking, signature and
redacted blocks in native order alongside the text, and a following turn in
the same conversation replays them unchanged with the matching tool result.
Structured output (\`response_schema\`) works on both. Existing defaults and
the previously supported models are unchanged. When the provider reports it
served the request from a US-region inference path, the regional rate
applies (1.1× across all token classes); the platform never overrides your
workspace geography. Prompt caching is billed at the provider's read and
write classes when the response reports them. \`claude-fable-5-1\` is
listed by the provider but is not available for platform-funded selection:
its documented rejection of forced tool choices is incompatible with how
structured output is requested here, so a request for it returns
\`VALIDATION_ERROR\` pointing at the catalog. Rates for every model come
from \`/v1/pricing\` and \`ai_catalog\`; the deadline for a single call
remains 120 seconds, and a very large output can still time out into the
pending-cost state described above.

// Tool use (anthropic AND openai)
// Pass tool definitions in the standard tool-use shape via \`tools\`; the platform
// translates them to the provider's native format. tool_use blocks come
// back in result.content the same way for either provider; stop_reason
// is normalized to 'tool_use'. Drive multi-turn loops by appending the
// assistant message and a user message with tool_result blocks.
const r = await sw.ai.chat({
  provider: 'anthropic',   // or 'openai' — same tool definition shape
  model: 'claude-sonnet-4-6',
  messages: [{ role: 'user', content: 'Find files containing TODO.' }],
  tools: [{
    name: 'fs_search',
    description: 'Search files for a literal substring.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  }],
})
// If r.stop_reason === 'tool_use', iterate r.content for tool_use blocks.
// xai and workers-ai do not yet support tool use through this path.

// Streaming — provider 'anthropic' only
const stream = await sw.ai.chat({
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  messages: [...],
  stream: true
})
return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })

// What comes back is an SSE body in the Anthropic event shape:
// message_start, content_block_start / content_block_delta /
// content_block_stop, message_delta (cumulative output_tokens),
// message_stop. Today the answer is generated first and then sent as one
// complete SSE payload, so the frames arrive together rather than token by
// token — parse it as a stream, but don't build a UI that depends on
// incremental arrival yet.
//
// On every other provider stream is NOT honoured:
//   xai / openai / deepseek / deepinfra — and the free default
//     (gpt-5.6-luna, what you get when you omit provider/model) — reject
//     it with VALIDATION_ERROR "stream=true is not supported on the
//     <provider> provider yet." Uncaught in a handler that surfaces as a
//     500, so branch on the provider before you set the flag.
//   workers-ai IGNORES the flag and returns the ordinary JSON result
//     object. Wrapping that in a text/event-stream Response ships a JSON
//     blob mislabelled as SSE, and the caller has no way to tell.
//
// stream: true is also mutually exclusive with conversation_id and with
// response_schema (both VALIDATION_ERROR).

## Conversation history (all providers)

Pass conversation_id and the platform stores+replays the chat for you.
Prior turns are loaded from this project's database, prepended to your
messages, and sent to the model. After the response, your new user
message(s) and the assistant reply are saved under the same id. Next
call: send only the new user turn.

In app functions, sw.ai.chat derives the verified request user when one is
available; the scoped AI view below also supports session-owned conversations.
Through MCP, ai_complete requires subject_type and subject_id whenever you
supply conversation_id. Use the same pair to list, read, delete, or fork that
conversation. A conversation id alone does not identify its owner.

Works on every provider — anthropic, openai, xai, workers-ai. You can
even mix providers under the same conversation_id; whichever model you
call next sees the retained history. Compaction configuration and billing
are described below. The only field still pinned to anthropic is stream: \`stream: true\` produces
an SSE body only on \`provider: 'anthropic'\`. xai, openai, deepseek and
deepinfra, workers-ai and the free default reject it with VALIDATION_ERROR.
Do not label an ordinary JSON result as a text/event-stream Response.
\`stream: true\` cannot be combined with conversation_id or response_schema.
The anthropic stream is generated first and replayed as one complete SSE
payload today, so the frames arrive together rather than token by token.

// First call — pick any id (uuid or your own scheme), up to 128 chars
await sw.ai.chat({
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  conversation_id: 'c_abc123',
  messages: [{ role: 'user', content: "What's the capital of France?" }]
})
// → { content: [...], text: 'Paris.', conversation_id: 'c_abc123', ... }

// Second call — server loads the prior turn, you only send the new one
await sw.ai.chat({
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  conversation_id: 'c_abc123',
  messages: [{ role: 'user', content: 'And of Spain?' }]
})

If the combined input would exceed the model's 200K context window, the
oldest history messages are dropped automatically — the response carries
conversation_truncated: true. If the conversation_id doesn't exist, it's
created on first save.

## History caps (per call)

Trim what's loaded with two optional fields. Oldest user/assistant
messages drop first; the new turn in messages and your system prompt
are never dropped. The smaller cap wins.

await sw.ai.chat({
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  conversation_id: 'c_abc',
  history_max_messages: 20,    // default 50
  history_max_tokens: 4000,    // default 32000 (char/4 estimate)
  messages: [{ role: 'user', content: 'next question' }]
})

Use these to keep a long-running chat cheap and predictable. The
model's 200K window still applies on top.

## Compaction (preserve context across overflow)

By default, messages that overflow the caps above are omitted from that
model request. The stored transcript remains intact. Set \`compaction:
'summarize'\` to maintain a rolling summary. The object form selects an
explicit compactor; \`provider\` defaults to the primary call's provider and
\`model\` is required.

await sw.ai.chat({
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  conversation_id: 'c_abc',
  history_max_messages: 10,
  compaction: {
    mode: 'summarize',
    provider: 'openai',        // optional; defaults to primary provider
    model: 'gpt-5.6-luna',     // required in object form
  },
  messages: [{ role: 'user', content: 'continue' }]
})

The response carries conversation_summarized: true on calls where
summarization actually ran. The compactor uses the normal provider-key,
metering, and billing path. If that call fails, the primary call continues
with request-only truncation. The free/default model path is truncate-only.
Inspect the rolling summary via ai_conversation_list (pass a
conversation_id); it shows in the conversation row's summary field.

Manage conversations from outside functions via the MCP tools
ai_conversation_list (pass a conversation_id to fetch one) /
ai_conversation_delete, or
the matching REST endpoints (GET /v1/ai/conversations,
GET /v1/ai/conversations/:id, DELETE /v1/ai/conversations/:id — all take
?project_id=, subject_type, and subject_id). Use the same subject_type and
subject_id supplied to ai_complete when the conversation was created.
For MCP and REST history operations, list first and use the returned record
id to read, delete, or fork. Keep your original caller-chosen conversation_id
for subsequent ai_complete turns; it is a different identifier from the stored
record id. The scoped runtime client handles that translation for you.
Pass include_summarized=1 on the get endpoint to also see messages already
folded into the summary.

Summarized rows remain stored. Conversation reads exclude them by default;
pass include_summarized=1 to retrieve the complete retained transcript.

Compaction is not supported with stream: true.

## System prompt — pass either way

You can supply the system prompt as a top-level field OR as an inline
\`role: 'system'\` message; the platform normalizes both shapes before
dispatch, so the same code works on every provider.

  // Top-level \`system\` field
  await sw.ai.chat({ provider: 'anthropic', system: 'Be terse.', messages: [...] })

  // Inline \`role: 'system'\` message
  await sw.ai.chat({ provider: 'anthropic', messages: [
    { role: 'system', content: 'Be terse.' },
    { role: 'user', content: 'Hi' }
  ] })

Both produce identical behavior — no need to branch on provider.

## Multi-chat — letting end users keep a list of conversations

For chat apps that want a Claude.ai-style sidebar of prior threads,
list / fetch / delete via \`sw.ai.conversations.*\`:

  // Inside a deployed function, scoped to the signed-in user:
  const user = await sw.auth.requireUser(req);
  const scoped = sw.ai.scoped(user.id);    // also: sw.ai.forUser(user.id)

  // Sidebar payload — most recent first.
  const { conversations } = await scoped.conversations.list({ limit: 50 });
  // conversations[i] = { id, client_conversation_id, subject_type,
  //                      subject_id, created_at, updated_at,
  //                      summary_updated_at, message_count, last_message_preview }

  // Full transcript for one selected thread.
  const full = await scoped.conversations.get('weather-chat-7');
  // full.messages = [{ role, content, created_at }, ...]

  // \"Delete this chat\" button.
  await scoped.conversations.delete('weather-chat-7');

  // \"New chat\" is just a fresh conversation_id passed to .chat():
  await scoped.chat({
    provider: 'anthropic',
    messages: [{ role: 'user', content: text }],
    conversation_id: 'weather-chat-' + Date.now(),
  });

  // \"Regenerate from this point\" — fork the conversation under a
  // new id (optionally truncated to message N) so the original stays
  // intact and the dev can let the user try a different prompt.
  await scoped.conversations.fork('weather-chat-7', 'weather-chat-7-alt', {
    upToMessageId: 42,  // optional; omit to copy full history
  });

Pattern: store the active \`conversation_id\` in app state (URL query
param, useState, etc), pass it on every \`.chat()\` call, render the
list from \`.conversations.list()\`. Apps that only need a single
chat (RailTime-style) skip the list and pick one stable id.

## Error codes

Every \`sw.ai.*\` failure rejects with an \`Error\` whose \`.code\` and
\`.status\` fields are stable — branch on those instead of regex-matching
\`.message\`. The contract:

  CONV_HISTORY_UNAVAILABLE  503  conversation persistence load failed.
                                 retry without conversation_id to start
                                 a fresh thread, or pass a different id.
                                 (.retryable: true)
  SCHEMA_DRIFT              503  conversation table is missing columns
                                 the platform expects. Same recovery
                                 as CONV_HISTORY_UNAVAILABLE — our team
                                 alerted, no caller action.

  PAID_API_NOT_ACTIVATED    402  caller needs to enable AI completions
                                 in the dashboard. .data.activation_url
                                 carries the link.
  INSUFFICIENT_BALANCE      402  monthly cap or pre-paid balance hit.
                                 .data has available_dollars +
                                 required_dollars + load_url.
  AI_SPEND_CAP_EXCEEDED     402  sw.agent crossed opts.maxSpendCents after
                                 a billed step. .metrics has partial
                                 accounting.

  AI_PREPARE_STEP_FAILED    422  prepareStep callback failed.
  AI_STEP_HOOK_FAILED       422  onStepFinish callback failed.
  AI_STOP_CONDITION_FAILED  422  stopWhen callback failed.

  AI_REQUIRED               401  thrown by sw.auth.requireUser when no
                                 valid session is on the request.

  RATE_LIMITED              429  free-tier rate envelope hit or per-IP
                                 anonymous-create cap. (.retryable: true)
  UPSTREAM_ERROR            502/503  the upstream provider rejected.
                                 .message is the platform-authored
                                 friendly string; raw provider details
                                 are server-side only.

  VALIDATION_ERROR          400  inputs failed shape/range check.
  PROJECT_NOT_FOUND         404  unknown project or no access.
  NOT_FOUND                 404  resource (conversation, etc) missing.
  CONFLICT                  409  destination id already exists
                                 (e.g. conversations.fork to an id
                                 that's taken).
  INTERNAL_ERROR            500  unexpected platform failure — message
                                 stays generic, server logs have detail.

Database-layer errors that surface through sw.db.* keep their own set
documented in docs({ topic: 'sw.db' }):
SCHEMA_ERROR · SYNTAX_ERROR · TABLE_NOT_FOUND · CONSTRAINT_VIOLATION ·
STATEMENT_TOO_LARGE · DATABASE_VALUE_TOO_LARGE · DATABASE_INPUT_TOO_LARGE ·
DATABASE_FULL · WRITE_CONFLICT · DB_BUSY · QUERY_TIMEOUT.

Anything marked retryable: true is safe to attempt again after a short
backoff. Everything else is a programming/state error — fix the input
or wait for the platform team.

## Catalog search tool — \`sw.ai.catalogTool\`

Every chat app with a content catalog (restaurants, products, stations,
articles) ends up writing the same SQL-LIKE-over-N-columns tool by
hand. \`sw.ai.catalogTool\` builds the tool definition AND the
executor from a small config:

  const restaurants = sw.ai.catalogTool({
    table: 'restaurants',
    searchColumns: ['name', 'cuisine', 'neighborhood'],
    resultColumns: ['id', 'name', 'cuisine', 'rating', 'image_url'],
    urlTemplate: '/restaurant/{id}',   // optional; each result gets .url
    limit: 10,                          // optional, default 10, capped 50
    // optional tool-definition overrides:
    name: 'search_restaurants',
    description: 'Search restaurants by name, cuisine, or area.',
    // optional WHERE constraint (parameterized — never interpolated):
    where: { sql: 'is_published = ?', params: [1] },
  });

  // Use it in the canonical agent loop:
  const r = await sw.agent.run({
    model: 'claude-haiku-4-5',
    messages: [{ role: 'user', content: q }],
    tools: [{ ...restaurants.tool, execute: restaurants.execute }],
  });

\`tool\` is a standard tool definition (works on every
provider supported by the agent loop). \`execute({query, limit?})\` runs
the SELECT and returns \`{ count, query, limit, results: [...] }\`
with \`.url\` filled from the template when set.

Identifier safety: table / column / tool names are validated
against \`[a-zA-Z0-9_]+\` so the assembled SQL is injection-safe.
The user's query string is bound as a parameter — never interpolated.

## Agent execution

\`sw.agent\` is a separate callable runtime capability, not a method on
\`sw.ai\`. It supports inline execution, durable execution, status, and
cancellation. Read the complete signatures and return shapes in
\`docs({ topic: 'sw.agent' })\`.

## Per-user memory — \`sw.ai.userMemory\`

Every chat app rolls its own \`user_memory\` table — Nibble has
\`nibble_memory\`, RailTime would have \`railtime_memory\`. The
platform now provides one:

  const m = await sw.ai.userMemory.get(user.id);
  // → {} on first read, or your stored blob

  await sw.ai.userMemory.update(user.id, { preferred_line: 'Northern' });
  // → merges patch into the blob (shallow merge)

  await sw.ai.userMemory.clear(user.id);

Storage lives in the project's own database as \`_ai_user_memory\` —
\`_\`-prefixed so it's hidden from \`db_browse\` / \`db_describe\`. One
row per user, free + unlimited.

## Auto-compaction — \`sw.ai.userMemory.compact\`

After N conversation turns, fold the recent history into the
structured blob via a single cheap-model call. Pass a JSON Schema and
the platform uses \`response_schema\` to extract the structured
output, then merges the result into the blob:

  await sw.ai.userMemory.compact(user.id, {
    type: 'object',
    properties: {
      preferred_line: { type: 'string' },
      commute_time:   { type: 'string' },
      last_seen_disruptions: { type: 'array', items: { type: 'string' } },
    },
  }, {
    conversation_id: 'railtime:' + user.id,  // pulls last N turns
    windowMessages: 20,                       // optional, default 20
    model: 'claude-haiku-4-5',                // optional, default Haiku
    maxTokens: 1024,                          // optional, default 1024
  });

The compaction prompt carries forward existing memory unless the
transcript contradicts it — so the call is safe to repeat. One
\`ai.chat\` call's worth of cost per compact; run it on a cron or
after every N user turns rather than per-turn.

## Structured output — \`response_schema\`

Pass a JSON Schema object as \`response_schema\` to get a validated, parsed
response. The platform injects a synthetic tool with that schema as its
\`input_schema\` and forces the model to call it — works on both
\`provider: 'anthropic'\` and \`provider: 'openai'\`. Mutually exclusive with
caller-provided \`tools\` and with \`stream\`.

  const r = await sw.ai.chat({
    provider: 'anthropic',
    messages: [{ role: 'user', content: \`Extract order: \${text}\` }],
    response_schema: {
      type: 'object',
      properties: {
        order_id: { type: 'string' },
        customer: { type: 'string' },
        amount:   { type: 'number' },
      },
      required: ['order_id', 'customer', 'amount'],
    },
  })

  if (r.parsed) {
    console.log(r.parsed.order_id, r.parsed.customer, r.parsed.amount)
  } else {
    console.warn('parse failed:', r.parse_error)
  }

The response gains two fields: \`parsed\` (the validated object, or null
on failure) and \`parse_error\` (null on success, otherwise a short reason
string). The free default makes one request and reports parse failure
without a repair call. Other supported paths may retry once before giving up — no exceptions are thrown so your handler can branch. On
\`provider: 'anthropic'\` that retry is one separate model invocation with
its own balance reservation, started only after the first call's cost has
settled: if the first cost is pending there is no retry; if the balance
cannot cover the retry you get the original content with \`parse_error\`
set; if the retry's outcome is ambiguous you get the original content with
\`cost\` pending; a successful retry reports both invocations' bills added
together, with no second markup.

## Free chat

Default pick — omit both provider/model and the platform serves
\`gpt-5.6-luna\` from the account's included managed-AI allowance: $0.50 per
month on Free and $5 per billing period on paid plans. Every plan also has the
same owner-level request envelope: 10 requests/minute, 200/day, 8,192 estimated
input tokens including system/tools/history, and 1,024 output tokens per call.
No prepaid fallback or automatic paid repair request. Set \`max_tokens\` to
1,024 or less.

The \`provider: 'workers-ai'\` path remains an explicit opt-in.
Current non-reasoning chat models from that provider are
${WORKERS_AI_NON_REASONING_MODELS_INLINE}. Start with
\`${WORKERS_AI_DEFAULT_FREE_MODEL}\` only when you specifically want
that provider. Call ai_catalog for the live list of models
and their categories — don't hardcode a separate model list.

⚠️ Reasoning models — read this before picking one. Current reasoning
free chat models from the catalog are ${WORKERS_AI_REASONING_MODELS_INLINE}.

These models emit a private chain-of-thought before the final answer,
which routinely consumes 2000–6000 output tokens BEFORE the visible
reply even starts. With the typical 800–1024 max_tokens budget, they
exhaust the budget mid-thought and return \`MODEL_EMPTY_RESPONSE\` at
HTTP 422 with \`data.cause: "budget_exhausted"\`, the stop reason, and
the token counts. 422 and \`retry: false\` are deliberate: this is your
budget, not a provider outage, so retrying the same call hits the same
wall and switching model does not help. Raise max_tokens instead.

\`data.cause\` names which fixable case it was: \`budget_exhausted\` (the
reasoning-budget case above), \`model_declined\`, \`tool_only_not_allowed\`,
or \`content_filtered\`. \`data\` also carries the stop reason and the
input/output token counts.

CHANGED 2026-09-01: that answer used to be HTTP 502 (and, on the
workers-ai path, \`UPSTREAM_ERROR\`). The error CODE is unchanged, so
code matching on \`MODEL_EMPTY_RESPONSE\` keeps working; only the status,
the \`retry\` flag, and the message changed. A genuine provider failure —
a 5xx, a timeout, an unreadable body — still answers 502 with
\`retry: true\`. If you branch on status, treat 5xx as "theirs, retry"
and 4xx as "yours, change the request". The builder's own budget
failure, \`BUILDER_MODEL_OUTPUT_TRUNCATED\`, moved from 502 to 422 for
the same reason.

If you use a reasoning model, set max_tokens: 4000 or higher.
For simple tasks (summaries, classification, short Q&A, chat replies),
do NOT use a reasoning model — pick one of the non-reasoning catalog
models above. They're faster, cheaper on tokens, and don't burn budget
on chain-of-thought you can't read anyway.

Reach for reasoning models only on multi-step problems (math, code
generation with planning, complex tool-use loops) where the extra
thinking measurably improves the answer.

Free default limits on every plan: 10 req/min, 200 req/day per owner.
Explicit \`provider: 'workers-ai'\` limits remain: Free tier 10 req/min,
200 req/day; paid tiers 200 req/min, 10,000 req/day. These paths share the
owner's free-usage counter; switching providers does not reset usage.

## Other AI surfaces — also on sw.ai

Embeddings, transcription, text-to-speech, and image generation are
first-class on sw.ai inside a deployed function.
No API key, no fetch, no project_id juggling — same pattern as
sw.ai.chat.

  // Embeddings — workers-ai (free tier eligible) or a premium model (paid)
  const r = await sw.ai.embeddings({
    provider: 'workers-ai',
    model: '@cf/baai/bge-base-en-v1.5',
    text: ['How do I reset my password', 'Billing FAQ'],
  })
  // r.embeddings = [[...], [...]], r.dimensions = 768

  // Premium embeddings — text-embedding-3 family (paid; rates at /v1/pricing)
  // Models: text-embedding-3-large (3072d),
  //         text-embedding-3-small (1536d)
  // Optional dimensions param truncates the vector.
  const r2 = await sw.ai.embeddings({
    provider: 'openai',
    model: 'text-embedding-3-large',
    text: ['...'],
    dimensions: 1024,  // optional, must be <= model native
  })

  // Transcribe (Whisper) — pass base64 audio or a public audio_url
  const t = await sw.ai.transcribe({
    audio_url: 'https://example.com/clip.mp3',
  })
  // t.text, t.duration_seconds

  // Generate an image — returns a raw Response unless you set storage
  const img = await sw.ai.generateImage({
    provider: 'workers-ai',
    model: '@cf/black-forest-labs/flux-1-schnell',
    prompt: 'A serene mountain lake at dawn',
  })
  return img  // streams the PNG straight to the browser

  // …or store it in the project's files and return the path:
  const stored = await sw.ai.generateImage({
    prompt: '...',
    storage: '/renders/cover.png',
  })
  // stored = { storage_path, size_bytes, content_type }

  // Browse the live model catalog
  const catalog = await sw.ai.catalog()

## Image generation models

- @cf/black-forest-labs/flux-1-schnell — provider: 'workers-ai', fast and
  low-cost; billed from balance per 512×512 tile plus per diffusion step at
  the rate in /v1/pricing (4 steps by default, up to 8)
- Bring your own image provider for anything else: store the vendor's key
  as a project secret (sw.env) and call the vendor's API from your function
  with fetch. There is no managed AI charge on that path — the vendor bills
  you directly; your function's ordinary platform usage still applies. The earlier premium managed image model is retired:
  a request for it is refused with a message naming the default model.

## Background removal

Background removal is not offered as a managed capability. A call to
POST /v1/ai/remove-background (or sw.ai.removeBackground) is refused with a
typed error; nothing is charged. To remove backgrounds, bring your own
provider: store its key as a project secret and call it from your function.
A generative image model is not a substitute for background removal, so the
platform does not silently swap one in.

## Text-to-speech

- hexgrad/Kokoro-82M — the free DEFAULT voice. Never billed. English voices
  (American + British); pass the voice param (see ai_catalog for the list),
  default af_bella. Up to 8,000 chars per call. Fair-use limits apply
  (per-minute, per-day, and monthly-character); exceeding one returns 429
  RATE_LIMITED with retry_after_ms, reset_at, and the applicable limit/remaining.
- grok-tts — premium voice (pricing at /v1/pricing).
  Voice options (voice param): eve, ara, rex, sal, leo. language
  defaults to 'en'. Max 15,000 chars per call.

A per-request character overflow returns 400; a provider failure returns 503
UPSTREAM_DOWN with retry guidance (no silent model substitution).

  // Stream the audio straight to the browser
  const audio = await sw.ai.tts({
    model: 'grok-tts',
    voice: 'eve',
    text: 'Hello world.',
  })
  return audio  // raw audio Response — Content-Type set to the right MIME

  // Or save to file storage and return its path
  const stored = await sw.ai.tts({
    model: 'grok-tts',
    voice: 'eve',
    text: 'Hello world.',
    storage: '/audio/greeting.mp3',
  })
  // stored = { storage_path, size_bytes, content_type, ... }

## Content moderation

sw.ai.moderate(text) classifies text against a safety taxonomy
(violence, sexual content, hate, self-harm, illegal advice, etc.).
Free — uses the platform's content-safety model, with a secondary
moderation fallback if the primary provider is down.

const result = await sw.ai.moderate(userMessage)
// {
//   flagged: true,
//   categories: ['violent_crimes', 'hate'],
//   scores: { violent_crimes: 1, hate: 1 },
//   model: '@cf/meta/llama-guard-3-8b',
//   provider: 'workers-ai',
// }

if (result.flagged) {
  return Response.json({ error: 'Message blocked' }, { status: 422 })
}

Categories returned: violent_crimes, non_violent_crimes,
sex_crimes, child_exploitation, defamation, specialized_advice,
privacy, intellectual_property, indiscriminate_weapons, hate,
self_harm, sexual_content, elections, code_interpreter_abuse.

Max input: 50,000 chars. Subject to the free-tier AI rate limits above.

## Catalog discovery

sw.ai.catalog() (or the ai_catalog MCP tool / GET /v1/ai/catalog
externally) returns every model the platform exposes — provider, family
(chat / embeddings / tts / image / background-removal), pricing, and
default + max steps. Paid-model rates are in /v1/pricing.
Use it to render a picker or audit costs without hard-coding model lists.

Use sw.ai.* inside any deployed function — the platform binding handles
auth and project scoping. The smt_ developer key is only for external
clients (CI/CD, server-to-server jobs, webhooks).

## Error envelope (typed catalogue)

Every \`sw.ai.chat\` and \`sw.agent.*\` failure surfaces as a
structured envelope:

\`\`\`json
{
  "ok": false,
  "error": "<CODE>",
  "message": "<human-readable>",
  "retry": true | false,
  "retry_after_ms": <number, optional>
}
\`\`\`

## Astra (gpt-6-astra) on provider: 'openai'

\`model: 'gpt-6-astra'\` is served through a dedicated request path with the
same completion contract, receipt, reservation and settlement as the other
\`provider: 'openai'\` models; existing models, defaults and aliases are
unchanged. Tool calling works. The platform fixes the reasoning effort for
this model; there is no request field to change it, and conversation replay
carries the visible text and tool blocks, never hidden reasoning. Flex is
supported (\`service_tier: 'flex'\`). Context: a 1,050,000-token window with
input capped at 922,000 tokens and output at 128,000 tokens. Rates come from
\`/v1/pricing\` and \`ai_catalog\`; a request above 272,000 input tokens is
billed at the long-context rate (input and cache 2×, output 1.5×). The
Pro models stay withheld from platform-funded completions.

\`retry: true\` means the SAME request shape can be sent again after
\`retry_after_ms\` (or immediately when omitted). \`retry: false\` means
something about the request itself has to change before retrying.
Match on \`error\` — the codes below are stable; the \`message\` text is
not.

| Code                         | retry  | When you see it |
|------------------------------|--------|-----------------|
| VALIDATION_ERROR             | false  | bad input shape (missing project_id, bad messages array, unknown model, mutually-exclusive flags) |
| PROJECT_NOT_FOUND            | false  | project_id doesn't exist or your key can't see it |
| PAID_API_NOT_ACTIVATED       | false  | the paid model requires activation in dashboard settings |
| CONV_HISTORY_UNAVAILABLE     | true   | the project DB couldn't replay prior turns. Retry without conversation_id to start a fresh thread |
| CONV_HISTORY_REJECTED        | true   | the upstream provider rejected the replayed history for this conversation_id. The conversation is poisoned until cleared — call \`ai.conversations.delete(id)\` then retry, or drop conversation_id on the retry to start fresh |
| RATE_LIMITED                 | true   | per-user or per-model rate limit. Honour \`retry_after_ms\` |
| UPSTREAM_RATE_LIMITED        | true   | upstream provider rate-limited us. Honour \`retry_after_ms\` |
| UPSTREAM_AUTH_FAILED         | false  | platform credentials with the provider are bad — our team rotates them |
| UPSTREAM_BILLING             | false  | platform has a billing problem with the provider — our team is notified |
| UPSTREAM_DOWN                | true   | provider 5xx. Retry with backoff |
| UPSTREAM_ERROR               | false  | provider 4xx (request rejected) — change your messages/tools |
| INTERNAL_ERROR               | true   | platform glitch — retry once, then escalate via support_ticket |

Default retry behaviour for new codes follows the same rule: 4xx ⇒
\`retry: false\`, 5xx + 429 + 504 ⇒ \`retry: true\`. Always read \`retry\`
instead of inferring from \`error\` — a future code may flip retryability
without renaming.
`,

  'sw.agent': `# sw.agent — inline and durable model/tool loops

\`sw.agent\` is both a callable function and an object with four methods. All
five forms are supported:

\`\`\`js
await sw.agent(options)          // durable compatibility form
await sw.agent.run(options)      // inline: wait for the terminal result
await sw.agent.start(options)    // durable: return after creating the run
await sw.agent.status(agentId)   // read durable status/result
await sw.agent.cancel(agentId)   // request durable cancellation
\`\`\`

The direct call and \`.start\` both create durable work. They use the same step
engine but intentionally return different limit-field names:

\`\`\`js
const legacy = await sw.agent(options)
// { agent_id: string, status: string, max_turns: number }

const started = await sw.agent.start(options)
// { agent_id: string, status: string, max_steps: number }
\`\`\`

## Known inconsistencies

- The direct \`sw.agent(options)\` form returns \`max_turns\`, while
  \`sw.agent.start(options)\` returns \`max_steps\`. Read the field that matches
  the form you called; they are not aliases in the returned object.
- \`steps\` and \`total_cost_cents\` exist on inline results and partial error
  metrics but are non-enumerable. Direct property access works; object spread,
  \`Object.keys\`, and \`JSON.stringify\` omit them.

These are the supported runtime shapes today, not documentation aliases.

Both durable forms require \`options.model\`. Use the returned \`agent_id\` with
\`.status\` and \`.cancel\`. \`sw.agent.run\` may omit a model and use the same
model default as \`sw.ai.chat\`.

## Inline execution: sw.agent.run(options)

\`run\` performs model calls and tool calls in the current function invocation,
then returns the terminal model response plus agent metrics:

\`\`\`js
const result = await sw.agent.run({
  model: 'claude-haiku-4-5',
  prompt: 'Find order 42 and summarize its status.',
  tools: {
    lookup_order: {
      description: 'Read one order.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      execute: async ({ id }, { agentId, turn, toolCallId }) => {
        const row = await sw.db.query('SELECT * FROM orders WHERE id = ?', [id])
        return row.data[0] ?? null
      },
    },
  },
  maxSteps: 8,
  maxSpendCents: 50,
})

// Enumerable fields added by sw.agent:
result.iterations
result.tool_calls_made
result.total_input_tokens
result.total_output_tokens
result.completion_reason

// Present but deliberately non-enumerable:
result.steps
result.total_cost_cents
\`\`\`

The rest of the terminal object is the final \`sw.ai.chat\` response, including
fields such as \`text\`, \`content\`, \`provider\`, \`model\`, \`usage\`, and
\`stop_reason\` when the model response supplies them. Because \`steps\` and
\`total_cost_cents\` are non-enumerable, object spread, \`Object.keys\`, and
\`JSON.stringify\` omit them even though direct property access works.

Completion reasons are \`model_done\`, \`output_truncated\`, \`max_steps\`,
\`max_turns\` when only that limit name was supplied, \`stop_when\`,
\`cost_pending\`, or the non-empty string returned by \`stopWhen\`.
\`cost_pending\` fires when a spend cap is configured and a delivered step's
cost is still pending: the loop returns that step and issues no further
model request against an unknown total. A pending step makes
\`total_cost_cents\` null — unknown, not zero — and without a spend cap the
loop may continue with a null aggregate. A partial tool call in truncated model
output is not executed. Reaching an agent step limit returns a terminal result;
it does not throw.

## Durable execution: sw.agent(options) and sw.agent.start(options)

A durable call stores the initial messages, creates background work, and returns
immediately. The platform invokes the same deployed function for each signed
step callback. Call the same durable form from that handler; the runtime detects
the callback envelope and advances exactly one step instead of creating another
run.

\`\`\`js
const config = {
  model: 'claude-haiku-4-5',
  prompt: 'Reconcile yesterday’s orders.',
  tools: [
    {
      name: 'mark_reconciled',
      description: 'Mark one order reconciled.',
      input_schema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      execute: async ({ id }, { agentId, turn, toolCallId }) => {
        // Use toolCallId as the idempotency identity for external side effects.
        return { id, agentId, turn, toolCallId }
      },
    },
  ],
}

const { agent_id, status, max_steps } = await sw.agent.start(config)
\`\`\`

Tools, callbacks, and credentials are not serialized into the durable
checkpoint; the callback re-enters the deployed function and recreates them.
The tool context carries stable \`agentId\`, \`turn\`, and \`toolCallId\` values
for retry-safe deduplication. Inline runs set \`agentId\` to \`null\`; durable runs
use the durable id. A durable run can cross a deploy because callbacks execute
the then-current function code; checkpoint state records every observed
deployment version.

## Status and cancellation

\`sw.agent.status(agentId)\` reads the durable job and returns its complete job
status payload with a normalized \`agent_id\` field added:

\`\`\`js
const state = await sw.agent.status(agent_id)
// { ...jobStatus, agent_id: jobStatus.job_id || agent_id }
\`\`\`

The job payload carries the durable status, checkpoint/result or terminal error
when present, and the persisted agent state. See \`docs({ topic: 'sw.jobs' })\`
for the job status fields.

\`sw.agent.cancel(agentId)\` requests cancellation and returns the cancellation
job payload with the same normalized \`agent_id\` field:

\`\`\`js
const cancelled = await sw.agent.cancel(agent_id)
// { ...cancelJobResult, agent_id: cancelJobResult.job_id || agent_id }
\`\`\`

Cancellation prevents later steps. It cannot undo a tool side effect that
already completed or is already running. Both methods require a non-empty
string id; otherwise they throw \`VALIDATION_ERROR\` with status 400.

## Shared options

Every execution needs one input source: a non-empty \`messages\` array, a
\`prompt\` string, or an \`input\` string. Messages must be JSON-serializable and
are capped at 128 KiB of serialized text.

- \`provider\`, \`model\`, \`system\`, \`systemPrompt\`, \`serviceTier\`, and
  \`maxTokens\` select the model call. Camel-case \`systemPrompt\`,
  \`serviceTier\`, and \`maxTokens\` map to \`system\`, \`service_tier\`, and
  \`max_tokens\` unless the snake-case field is already present.
- \`conversation_id\` and other \`sw.ai.chat\` history options pass through to
  each model call. A conversation may span multiple inline or durable runs;
  \`agent_id\` identifies one durable run only.
- \`maxSteps\`, \`maxIterations\`, and \`maxTurns\` are accepted limit names.
  The first defined name in that order wins. The value must be an integer from
  1 through 20; the default is 8.
- \`maxSpendCents\`, when it is a positive number, is checked before each model
  call and again after each billed step: a run whose accumulated cost has
  already reached the cap makes no further call, and a completed call that
  takes the accumulated cost over the cap stops the run. Either throws
  \`AI_SPEND_CAP_EXCEEDED\` with status 402 and partial metrics on
  \`error.metrics\`. The cap bounds the run, not the price of any single call.

## Tools

\`tools\` accepts a keyed object or an array. Array entries have this shape:

\`\`\`js
{
  name: string,                 // starts with a letter; letters/numbers/_/-
  description?: string,
  inputSchema?: object,         // input_schema is also accepted
  input_schema?: object,
  execute: async (input, context) => any,
}
\`\`\`

Tool names must be unique and no longer than 64 characters. Missing schemas
default to an empty object schema. A thrown tool error becomes an
\`is_error: true\` tool result so the next model step can recover. A missing
tool result and a non-serializable result also become error results. Serialized
tool-result content is truncated after 24,000 characters.

## Step callbacks

- \`prepareStep(context)\` runs before the model call. It may return an object
  overriding \`messages\`, \`provider\`, \`model\`, \`system\`, \`tools\`,
  \`toolChoice\`, or \`maxTokens\` for that step; \`null\` and \`undefined\`
  mean no override.
- \`onStepFinish({ step, steps })\` runs after the step trace is recorded.
- \`stopWhen({ step, steps })\` may return false, true, or a non-empty
  completion-reason string.
- \`onStep(event)\` is also supported. It receives
  \`{ agentId, turn, maxTurns, output, toolCalls, done, stopReason }\`; its
  JSON-serializable return value is stored as \`step.on_step\`.

Callback failures throw \`AI_PREPARE_STEP_FAILED\`, \`AI_STEP_HOOK_FAILED\`, or
\`AI_STOP_CONDITION_FAILED\` with status 422. Their \`error.metrics\` contains
the partial token/tool counts; \`steps\` and \`total_cost_cents\` on that metrics
object are non-enumerable.
`,

  'sw.email': `# sw.email — Send Email (inside deployed functions)

Outbound transactional email is available on Free, Builder, Pro, Scale, and
Enterprise. No sender setup is required for transactional email.

## sw.email.send(message)

await sw.email.send({
  to: 'alice@example.com',
  subject: 'Your order shipped',
  html: '<p>Tracking: ABC123</p>',
  reply_to: 'support@yourapp.com' // optional
})

With no \`from\`, the message uses the platform-managed transactional sender
and the project name as its sender label. The response names the sender mode
and address. It can only email people registered with this project (including
pending magic-link sign-ins) or the project's owner. Other recipients return
\`MANAGED_SENDER_RECIPIENT_NOT_A_USER\`; verify your own sender domain for
outreach. Pass \`from\` to use your own verified sender domain:

await sw.email.send({
  to: 'alice@example.com',
  from: 'notifications@yourapp.com',
  subject: 'Your order shipped',
  text: 'Tracking: ABC123'
})

An explicit \`from\` must match a verified sender domain on this project.
Callers cannot explicitly name a platform domain. The managed default is for
transactional email; add a verified sender domain for your own branding and
marketing email. The plan's email allowance and send rate limit apply to both.
Limit: the Free tier has a daily + monthly send cap; paid tiers are metered
monthly. Read the current per-tier caps from /v1/pricing instead of copying
them into project policy or application code.

For auth emails (password reset, verification, welcome), the
platform sends them automatically — you don't call sw.email
for those. Customize templates in Settings → Email Templates.

## Delivery health (scrub bounces before sending)

The email provider posts bounce + complaint webhooks; the platform records
every event on the project automatically. Two MCP tools expose them:

- email_events_list({ project_id, limit?, offset? }) — recent sends
  with their latest event (sent | delivered | opened | clicked |
  bounced | complained | delivery_delayed). Build an audit view or
  spot a bounce spike after a blast.

- email_bounces_list({ project_id, days?, limit? }) — deduplicated
  recipients that bounced or complained inside the window
  (default 30 days, max 365). One row per address with last_status,
  last_at, occurrences.

From INSIDE a function, scrub before you send (no MCP round-trip):
- \`sw.email.checkSuppression(address)\` → \`{ address, suppressed, status, last_at, occurrences }\` — is this ONE recipient dead (bounced or complained)? Check it before \`sw.email.send\`.
- \`sw.email.bounces({ days?, limit? })\` → \`{ bounces, window_days, limit }\`.
  The \`bounces\` array contains the dead-address rows; the other fields report
  the effective query window and cap.

For a single message's full timeline use email_status({ id }).

## Delivery and engagement events

Every message sent through sw.email records delivery, open, and click events
when the recipient's inbox reports them. Recent-message lists include sent,
delivered, opened, and clicked counts; email_status returns the full timeline
for one tracking id. Opens are approximate because some inboxes block images.

**Before every send loop, scrub against email_bounces_list.**
Mailing a dead address repeatedly is the single fastest way to land
your verified domain in a spam folder. Pattern:

const bounced = new Set(
  (await sw.email.bounces({ days: 60 })).bounces.map(r => r.address)
)
for (const u of users) {
  if (bounced.has(u.email)) continue
  await sw.email.send({ to: u.email, ... })
}
`,

  'sw.env': `# sw.env — Environment Variables (inside deployed functions)

Set env vars via the env MCP tool or the dashboard Settings page.
They are baked into the deployed function bundle at deploy time.

## Access
export default async function(req, sw) {
  const key = sw.env.STRIPE_SECRET_KEY
  // ...
}

## Timing
Setting an env var does NOT hot-reload running functions.
After env_set, the next project_deploy bakes the new value in.
Until you redeploy, old functions continue using the previous value.

## Secrets
Env vars are server-side by default: the value is readable through \`sw.env\`
inside a function and is never returned by any API. Put API keys, database
URLs, and third-party secrets here.

ONE EXCEPTION, and it matters. A variable whose name starts with \`VITE_\` or
\`REACT_APP_\` is compiled into your BROWSER JavaScript as plain text — that is
what those framework prefixes mean, since \`import.meta.env.VITE_API_URL\` has
to become a real value for the browser to read it. Anyone who opens your site
can read those values. Mark them explicitly so the intent is on the record:

\`\`\`js
env_set({ project_id, key: 'VITE_API_URL', value: 'https://api.example.com', public: true })
\`\`\`

So never give a real secret a \`VITE_\`/\`REACT_APP_\` name. A key called
\`VITE_STRIPE_SECRET\` is a published secret, not a protected one — drop the
prefix and read it as \`sw.env.STRIPE_SECRET\` inside a function instead.

Marking a value public records that the exposure is intended. It does not hold
the value back. The name alone decides what reaches the browser, so an unmarked
\`VITE_*\`/\`REACT_APP_*\` value is compiled in exactly the same way — the
difference is that you are warned about it, when you set it and again on every
deploy. Dropping the prefix is the only thing that keeps a value out of the
browser.

Listing the project's variables returns \`browser_exposed\` (the name publishes
this value) and \`visibility\` (\`public\` once you have confirmed that is
intended) for every key.

Rotate secrets by calling env_set with the new value, then project_deploy.
`,

  'sw.jobs': `# sw.jobs — Background Jobs (inside deployed functions)

Queue work that shouldn't block a user request.
Platform retries a failed run (up to 5 attempts); a handler may therefore run
more than once and must be idempotent — see Recovery status below.
Make handlers idempotent — they may run more than once.

## Create a job
const job = await sw.jobs.create({
  handler: '/api/jobs/process-upload',
  payload: { upload_id: 'u123', user_id: 'u_alice' },
  timeout_seconds: 600
})
// job = { job_id: 'j_abc', status: 'queued' }

The handler must be a deployed function path.
Platform POSTs the payload to your function when the job runs.

## Idempotency key — safe retries

Pass an optional \`idempotency_key\` (1–200 characters, no surrounding
whitespace) in the body, or the \`Idempotency-Key\` header; if both are sent
they must match. Inside a deployed function, \`sw.jobs.create\` and
\`sw.agent.run\` generate one key per invocation when you do not supply one,
and the CLI and MCP forward one per call — so a lost response on a single
call is safe to retry with the same key. A separate invocation is new work
unless you reuse your explicit key.

- Same key + same effective arguments, within the same project and caller →
  the same job handle comes back; current authorization is always checked
  first, and a sequential replay does not consume a new concurrent job slot.
- Same key + different arguments → \`409 IDEMPOTENCY_KEY_REUSED\`.
- Concurrent equal requests admit one job. Each request may still hit the
  per-request rate limiter before admission deduplicates; rate accounting is
  not part of admission.
- Unkeyed equal requests are independent jobs. A key lives as long as its
  job and receipt, not beyond project or job deletion.
- If admission cannot be confirmed you get \`503 JOB_ADMISSION_UNCONFIRMED\`:
  retry only with the same key. Concurrency caps return
  \`429 JOB_QUOTA_EXCEEDED\`.

## Recovery status — what a job handle can tell you

A job handle is durable. Your handler may run more than once for one job and
must be idempotent; there is no exactly-once guarantee, and there is also no
promise that every admitted job is invoked (see the fenced crash below). A
response may carry \`status: 'indeterminate'\` with
\`recovery\` diagnostics instead of a final answer — read them, do not blindly
replay:

- \`JOB_RESULT_UNCONFIRMED\` — the provider reports complete but no product
  result was stored: unconfirmed, not success.
- \`JOB_EXECUTION_STOPPED\` — the run errored or was terminated without a
  product result; partial effects may exist.
- \`JOB_STATUS_UNCONFIRMED\` — the job was admitted (the id is real) but its
  status could not be read; poll it.
- A crash between the dispatch fence and invocation stays \`unknown\`; the
  platform does not create a second run on your behalf. Decide with your own
  records whether to submit new work.

The same rules apply to ingest jobs, which share this admission path.

## Job handler function
A job handler is an ordinary deployed function, so the database rules are the
ordinary ones: on a project with a \`db/schema.ts\`, use declared operations.
Ordinary \`sw.db.query\` / \`sw.db.batch\` are refused there before transport;
managed raw writes remain refused even through the explicit server namespace.

// api/jobs/process-upload.ts
export default async function(req, sw) {
  if (!(await sw.jobs.verifyInvocation(req))) {
    return Response.json({ error: 'forbidden' }, { status: 403 })
  }
  const { upload_id, user_id } = await req.json()
  // do the heavy work
  await processUpload(upload_id, sw)
  return Response.json({ ok: true })
}

The platform signs each job delivery with X-Somewhere-Signature,
X-Somewhere-Invocation-Timestamp, and X-Somewhere-Body-SHA256.
Always verify before trusting the payload on public /api/jobs/*
handlers. This blocks a browser from calling the job handler directly
with forged payloads.

## Look up a job's status
const j = await sw.jobs.status('j_abc')
// j = { job_id, status: 'queued' | 'running' | 'succeeded' | 'failed',
//       attempts, last_error?, started_at?, finished_at? }

Use this to poll a long-running job from another request — for example,
the browser polls /api/job-status?id=j_abc and your function calls
sw.jobs.status to forward the current state.
`,

  'sw.queue': `# sw.queue — Fire-and-Forget Background Work

For fire-and-forget tasks where you don't need to inspect status later.
Use sw.jobs if you DO need to look up the result.

## Push a message
await sw.queue.push({
  handler: '/api/queue/log-event',
  payload: { event: 'signup', user_id: 'u_123' },
  delay_seconds: 0    // optional, max 43200 (12 hours)
})

## Handler function
// api/queue/log-event.ts
export default async function(req, sw) {
  if (!(await sw.queue.verifyInvocation(req))) {
    return Response.json({ error: 'forbidden' }, { status: 403 })
  }
  const { event, user_id } = await req.json()
  // Composed write — works on every project, and the only write that works
  // once a db/schema.ts has been deployed. 'events' needs a declared intent
  // (db/schema.ts, or db_scope_set) for this call.
  await sw.db.insert('events', { type: event, user_id })
  // On a project with NO db/schema.ts you can equally write raw SQL:
  //   await sw.db.query('INSERT INTO events (type, user_id) VALUES (?, ?)', [event, user_id])
  // On a project that HAS one, that same line returns 403
  // MANAGED_RAW_SQL_REQUIRES_SERVER_AUTHORITY. Moving the INSERT to
  // sw.db.server.query still returns MANAGED_RAW_WRITE_FORBIDDEN.
  return Response.json({ ok: true })
}

Queue deliveries are signed the same way as jobs. Verify the signature
before side effects so public queue handler URLs cannot be used as
unauthenticated admin endpoints.

## Delivery semantics
At-least-once — a consumer MAY receive the same payload twice.
Make handlers idempotent (e.g. dedupe key on a unique column).
No per-message read API — if you need to look up a job by id, use sw.jobs.
`,

  'sw.logs': `# sw.logs — Application Logging (inside deployed functions)

Structured logs written to the project's log stream.
Readable via the \`project_logs\` MCP tool or dashboard Logs page.

## Write logs
sw.logs.debug('loaded config', { keys: Object.keys(config) })
sw.logs.info('user signed up', { user_id: 'u_123' })
sw.logs.warn('slow query', { ms: 812, sql: 'SELECT ...' })
sw.logs.error('payment failed', { error: err.message, user_id: 'u_123' })

All four levels accept (message: string, data?: object).
data is JSON-serialized, so keep it under a few KB per call.

## Retention
Free: 7 days.
Builder: 30 days.
A daily cron prunes older entries — there is no archive.

## Reading logs
Call the project_logs MCP tool with project_id + optional level + limit.
No full-text search across log bodies — log retrieval is sequential
(newest first, optionally filtered by level).
`,

  'dev-environments': `# Preview — \`somewhere preview\` (Pro and Scale)

Every project has ONE production environment. On the Pro and Scale plans you
can additionally create **previews**: immutable builds with their own database
clone and environment variables, reachable behind a login gate and promoted
to production only when you say so. Preview saves never change production —
only a production deploy, a promote, or a rollback does.

## When to use this — not by default

**Default to shipping to production.** \`somewhere deploy\` deploys straight to
production and is the right path for almost all work: iterating on a new
project, building something that has no users yet, fixing your own site.
Every deploy reaches production the moment it finishes — that immediacy is the point.

Reach for a preview only when you have a **concrete reason to
protect production**: real users on the site, a risky change you want to
preview against production-shaped data before promotion, or a migration you
want to rehearse. If you don't have users yet, don't add the preview → promote
loop — just deploy.

## Who has this

Available on the **Pro and Scale plans**, with preview enabled for the
account. Free and Builder plans are excluded — every preview-only entry point
returns \`CLOUD_DEV_NOT_ENABLED\` with upgrade guidance. The upgrade path: move
the account to Pro or Scale, then ask for preview to be enabled if your account
does not already have it. Production deploys are never affected by this gate,
and \`somewhere dev\` runs the app on your machine on every plan.

## The mental model

- **Production** — what visitors see. Served at your project URL. Changed
  only by a production deploy, a promote, or a rollback.
- **Preview** — an immutable build created from a complete snapshot of your
  source. Each save mints a NEW preview in the same preview session. Previews
  run against an isolated, populated copy of your production database, taken
  when the preview session is created, and see the dev-scoped environment
  variables, so nothing a preview does can touch production data or read
  production-only secrets. A preview function cannot make outbound requests
  (\`DRAFT_EGRESS_DENIED\`).
  A preview function resolves the signed-in user of the preview's own copy
  read-only: no refresh, no session minting, and the public sign-in API is not
  available from a preview. If that identity lookup cannot be completed, or
  returns something that is not a valid identity, the request fails with
  \`AUTH_VERIFY_UNAVAILABLE\` (503) — it never falls back to a visitor.

## Choose production or the preview clone explicitly for schema changes

A preview's database is an **isolated exact copy of your production database,
data included, taken when the preview session is created**: tables, rows,
hidden row identities, generated fields, exact values, sequence positions,
indexes, views and triggers. The copy is verified by a complete readback
before the preview is ready; a copy that cannot be completed or confirmed is
refused, never handed to you partial or schema-only. On a brand new project
that has never run a \`CREATE TABLE\`, production has no tables and **the
preview database starts empty**. Preview writes stay in the copy and never
merge into production.

Copy limits and refusals (\`retry\` is on every refusal):

- Bounds: 50,000 rows per table, 100 captured columns per table (a hidden row
  id counts), 100,000 bytes per generated statement, 16 MiB of replay SQL.
  A larger database, or a shape the copy cannot reproduce, is refused with
  \`DATABASE_COPY_UNSUPPORTED\` (409, \`retry: false\`). Provider limits can
  refuse a smaller case; nothing is split or partially copied.
- Full-text (FTS5) tables with internally stored content are copied,
  including their declared options (\`tokenize\`, \`prefix\`, \`columnsize\`,
  \`detail\`, \`UNINDEXED\`) and persisted configuration. External-content and
  contentless full-text tables, other virtual-table modules and unknown
  configuration refuse. The SQL dump captures the same full-text shapes
  and refuses the same ones.
- \`DATABASE_COPY_UNCONFIRMED\` (503, \`retry: true\`): the platform could not
  confirm the outcome of the copy. Retry the same create; a retry may still
  refuse until the unconfirmed attempt has been cleaned up — the platform
  never starts a blind second copy on top of an unknown one.
- \`DRAFT_NEW_COPY_REQUIRED\` (409, \`retry: false\`): a preview created before
  populated copies existed, with a schema-only database, is no longer served;
  its data is kept but its URLs fail readiness. Start a new preview session.

\`db_migrate\` defaults to production. To apply SQL-world DDL only to the
preview copy, send \`target:"preview"\`, \`preview_session_id\`, and optionally
the exact \`preview_id\`. The DDL persists across candidates in that preview
session, never merges into production, and is discarded when the session is
closed, promoted, or expires. Conflicting target fields return
\`DATABASE_TARGET_AMBIGUOUS\`; an unknown, closed, expired, or mismatched
preview returns \`PREVIEW_TARGET_INVALID\`. Neither ever falls back to
production.

Both workflows are valid:

1. Create SQL-world tables with production-targeted \`db_migrate\`, then start
   the preview; it copies that schema together with the rows production holds
   at that moment. A managed \`db/schema.ts\` needs no such step: the preview
   release applies it to the copy.
2. Or start the preview, then call \`db_migrate\` with its exact preview target
   to rehearse SQL-world DDL only in the copy.

A running preview holds the copy taken when its session was created: either
target that preview with \`db_migrate\`, or change production and start a new
preview session to take a fresh copy. A preview created before populated
copies existed answers \`DRAFT_NEW_COPY_REQUIRED\`; it cannot be migrated
forward, only replaced by a new session.

## Create a preview

A preview save is one **complete snapshot** — the full files/functions maps,
never a partial patch:

\`\`\`
POST /v1/deploy
{
  "project_id": "...",
  "preview": true,
  "scope": "all",
  "files": { ...complete static map... },
  "binary_files": { },
  "functions": { ...complete functions map... },
  "replace_functions": true,
  "preview_session_id": "draft_<uuid>", // existing wire-format value, stable per session
  "preview_operation_id": "<fresh-id>",   // NEW id for every snapshot
  "expected_preview_id": null,             // null for the FIRST preview
  "base_release_id": "<current production release id>"
}
\`\`\`

The response returns \`preview_session_id\`, \`preview_id\`, and a
\`preview_url\`. Sending preview-only fields WITHOUT \`preview: true\` fails
closed (legacy wire code \`DRAFT_FIELDS_REQUIRE_DRAFT\`) — it never silently deploys to
production.

## Iterate

Send another complete snapshot with the SAME \`preview_session_id\`, a **fresh**
\`preview_operation_id\`, and \`expected_preview_id\` set to the current
preview. Each save advances the preview pointer under
optimistic concurrency:

- Stale \`expected_preview_id\` → legacy wire code \`DRAFT_CANDIDATE_CONFLICT\`
  (re-read the preview session, retry from its exact current preview).
- A reused operation id → \`DRAFT_OPERATION_REUSED\` (use a fresh id per
  snapshot).
- Retrying the SAME operation with the SAME snapshot is idempotent — it
  returns the same preview.

## Run a preview function

Invoke one function against the session's latest preview — it executes with
the preview's isolated database and dev-scoped environment:

\`\`\`
POST https://runner.somewhere.tech/v1/deploy/preview/invoke
{ "project_id": "...", "preview_session_id": "draft_<uuid>",
  "preview_id": "<optional exact-preview pin>",
  "method": "GET", "path": "/api/hello" }
\`\`\`

Same Authorization header as the API. Omit the preview pin to run the latest;
pin it to refuse if the preview session moved (legacy wire code \`DRAFT_VERSION_MISMATCH\`).

## Preview in a browser

Mint a one-time capability URL for the exact preview you want to
preview:

\`\`\`
POST /v1/projects/:id/preview/mint
{ "preview_session_id": "draft_<uuid>",
  "preview_id": "<exact preview_id>" }
→ { "preview_url": "https://<subdomain>-dev.somewhere.site/__sw_cap?t=..." }
\`\`\`

Open the returned \`preview_url\` in the browser. The \`/__sw_cap\` exchange is
single-use: it consumes the token, sets a host-only preview cookie, and
redirects to the clean \`-dev\` URL. The dev hostname is never public: missing,
replayed, forged, expired, revoked, stale, or closed capabilities fail closed,
and the production hostname is untouched.

## Environment variables and secrets per environment

Every env var has a scope: \`all\` (both), \`dev\` (previews only), or \`prod\`
(production only) — set via \`POST /v1/env\` with \`scope\`. Previews see
dev + all and can NEVER read prod-only values; production sees prod + all
and never dev-only values. Use distinct names per environment (for example
\`STRIPE_KEY_TEST\` with scope dev and \`STRIPE_KEY\` with scope prod).

Env values are captured per preview at snapshot time: adding or changing a var
does NOT reach an existing preview — it takes effect on the NEXT preview (and
on production at the next promote/deploy). Create a new preview snapshot to
pick up a new value.

## Promote

When the preview is right, promote that exact build:

\`\`\`
POST /v1/promote
{ "project_id": "...", "preview_session_id": "draft_<uuid>",
  "preview_id": "<the preview you reviewed>",
  "message": "why this ship" }
\`\`\`

Promotion is atomic: it makes the exact source you reviewed the new production
release, or nothing changes. If production moved since the preview was created,
the promote conflicts instead of replacing it. A promoted preview session is
finished — further changes start a NEW preview session.

## Roll back

\`POST /v1/promote/rollback\` restores the previous production version. Preview
data never merges into production: the preview database clone is discarded
with the preview session.

## When a preview session can't continue

A promoted, closed, or expired preview session returns the legacy wire code
\`DRAFT_SESSION_TERMINAL\` (non-retryable) naming its state — the recovery is
always a NEW preview session with a fresh \`preview_session_id\` from the current
production release. A preview still provisioning returns the legacy wire code
\`DRAFT_SANDBOX_NOT_READY\` (retry the exact same operation).

Compatibility: existing callers may continue sending \`draft:true\`,
\`draft_id\`, \`draft_operation_id\`, \`candidate_release_id\`, and
\`expected_candidate_release_id\`, and may continue calling the legacy
\`/v1/deploy/draft/*\` routes. New callers should use the preview names above.

Building on localhost, without a preview → docs({ topic: 'local-dev' }).
Production deploys and their guarantees → docs({ topic: 'deploy' }).
Env var scopes → docs({ topic: 'sw.env' }).
`,

  'deploy': `# Deploy

Deploys go straight to production — that is the
default and the right path for most work. Only if you have real users to
protect: on the Pro and Scale plans (with preview enabled)
you can instead create an isolated preview and promote when
ready → docs({ topic: 'dev-environments' }).

One deploy may contain at most 20 MiB of decoded source and assets combined.
The JSON request envelope has a separate roughly 40 MB intake limit because
base64 expands binary data in transit. Large images and other bulky media
belong in file storage: make them public and reference their public URLs from
the app instead of embedding them in the deploy tree.

<!--layer:contract-->
## Analytics & privacy — nothing is injected

The platform injects NO analytics, beacons, or third-party scripts into
served pages — no Cloudflare RUM, no \`static.cloudflareinsights.com\`
loader, no \`/cdn-cgi/rum\` calls. Pages ship exactly the bytes you deploy
(collection default: OFF, platform-wide, tsk_2802aa2c).

Opting in is explicit and yours: add any analytics snippet to your own HTML
(e.g. Cloudflare Web Analytics' \`<script defer
src="https://static.cloudflareinsights.com/beacon.min.js"
data-cf-beacon='{"token": "YOUR_TOKEN"}'></script>\`, or any provider) and
deploy — it serves verbatim. The platform's own \`analytics/pageviews\`
feature is server-side (no browser beacon, no third parties) and works
regardless of this choice.

## Dependencies and lockfiles

Declare dependencies in \`package.json\`; the platform installs and bundles
them on deploy. You never run \`npm install\` and never upload \`node_modules\`.

- **With a lockfile** — \`package-lock.json\` (lockfile version 2 or 3) or
  \`npm-shrinkwrap.json\`, which wins when both are present — the deploy uses
  exactly the versions and integrity hashes the lock selects for the selected
  packages: every declared runtime dependency (only platform-provided compile
  tooling is excepted; runtime dependencies are not tree-shaken before lock
  selection), plus dev dependencies your source actually imports and declared
  \`@types\` packages, and their required transitive closure. Supported lock
  entries are exact packages from
  the public npm registry with integrity. A lock the platform cannot honour
  is refused with \`DEPENDENCY_LOCK_INVALID\` and there is no unlocked
  fallback: aliases, linked, workspace, file or git packages, custom
  registries, version-1 or malformed locks, and locks whose selected graph is
  incomplete or inconsistent all refuse.
- **Without a lockfile** — ranges in \`package.json\` resolve at deploy. This
  is supported, but it is not verified reproducible: two deploys of the same
  source can pick different versions. Ship a lock when that matters.
- **What a lock does not promise** — unused dev and tooling entries are not
  installed, and the platform's own build tooling is pinned separately.
  Pre-installed common packages are reused only when they match your lock's
  full dependency graph and integrity; otherwise the deploy installs fresh.
  When the current compiler compiles your source, the release records the
  package versions and dependency relationships selected or bundled for that
  compilation and binds that record to the release; a release never
  re-resolves. A static release, or a release served from an accepted
  earlier build, may carry no new compilation record. Without a supported
  lockfile the record is observational — versions, manifest hashes and
  relationships as resolved, with any dependency target it could not resolve
  left explicitly unresolved — and it does not claim a lock-verified
  dependency graph. It covers what that compilation selected or bundled, not
  packages your code loads dynamically at runtime, not the platform's own
  tooling, and it is not an assertion that every installed file byte was
  independently verified or that every dependency runs correctly.

## Developer-file protection + .somewhereignore

Deploys never accidentally publish local/dev/control files. The platform
strips these from the static payload on EVERY deploy path (CLI, MCP
\`project_deploy\`, REST, GitHub import) and lists each exclusion in the
deploy warnings: root \`README.md\`, \`CLAUDE.md\`, \`AGENTS.md\`,
\`AGENT.md\`, \`.env\` / \`.env.*\` / \`.envrc\` / \`.npmrc\`,
\`.git*\` metadata, \`.somewhere.json\`, \`.mcp.json\`, ignore files
themselves, editor/system dirs (\`.claude/\`, \`.cursor/\`, \`.vscode/\`,
\`.idea/\`, \`.wrangler/\`), \`node_modules/\`, and \`.DS_Store\` /
\`Thumbs.db\` anywhere. \`package.json\`, tsconfigs, and vite configs still
ship — the platform compiles from them.

To ship a protected file ON PURPOSE, add a \`!\` line to a
\`.somewhereignore\` file in your project root:

\`\`\`
# .somewhereignore — gitignore syntax; ! re-includes a protected path
!README.md
\`\`\`

\`.somewhereignore\` is the one ignore-file name: the CLI collector honors it,
and it carries the \`!\` re-includes this chokepoint reads. Plain (non-\`!\`)
ignore rules work there or in \`.gitignore\`. Over MCP \`project_deploy\` or
REST \`/v1/deploy\`, include \`.somewhereignore\` in the files map.

## Reliability guarantees on every deploy (the industry-standard checklist)

- **Deploy health check (synthetic smoke test).** After every live deploy
  the platform screenshots the live root URL; if the screenshot is
  blank / under threshold the deploy is REJECTED, not published. No
  "two-second white screen" outage.
- **Version history + rollback.** Every deploy writes a versioned
  snapshot. \`project_rollback\` selects the previous retained release.
  The platform evaluates managed-schema rollback safety before activation and
  refuses restoration when the prior schema is unsafe; inspect the returned schema plan.
- **Canary deploys** for the platform itself: every new platform
  version rolls out to a small slice of traffic first, our team
  watches for 5–15 minutes, then promotes. Roll-back to the previous
  version is one command.
- **Continuous code review.** Deterministic security checks run during
  compilation on every tier. Paid plans add AI review: Builder and Pro run
  daily after a deploy, while Scale and Enterprise also run it on promote.
  Findings land in the dashboard's Security tab.
- **Failure alerting** on deploy / patch / blank-page /
  health checks. Our team is alerted to any regression within
  minutes.

Full reviewer-facing depth: <https://somewhere.tech/llms.txt>.

---

**Ship raw source. The platform compiles JSX/TSX/TS automatically — for
both the frontend AND the backend.** \`/v1/deploy\` compiles
your sources at deploy time:

- Frontend: \`.jsx\` / \`.tsx\` / \`.css\` are bundled into hashed chunks
  under \`/_compiled/\`, and \`index.html\` is rewritten to point at them.
- Functions: each \`api/*.ts\` (or \`.tsx\`, \`.js\`) is compiled to JS the
  runtime can execute — no client-side \`tsc\`, no \`esbuild api/chat.ts\`,
  no pre-bundled \`.mjs\`. You ship the same files you write.

Do not run \`npm run build\`, \`vite build\`, \`esbuild\`, \`tsc\`, or
similar first — \`/v1/deploy\` HARD-REJECTS pre-bundled output with
HTTP 400 \`BUNDLED_DEPLOY_REJECTED\`. This includes pre-bundled
\`api/*.mjs\` functions, not just \`dist/\` static output. Escape hatch:
\`somewhere deploy --prebuilt\`, the project setting, or \`allow_bundled: true\`.

### Put large binary assets in file storage

Deploy trees are for code. Large binary assets such as images, fonts,
and video belong in file storage: upload them with \`fs_upload\` and
\`public: true\`, then call \`fs_public_url\` and reference the returned
URL from your app. \`fs_write\` is for text and small inline content, not
real binary files. Assets in the deploy tree are re-processed on every
release, so a big asset folder makes every deploy slower and can fail
the deploy outright.

\`\`\`text
fs_upload({
  project_id: "my-app", path: "/assets/badge.png",
  file: attachedFile, public: true
})
fs_public_url({ project_id: "my-app", path: "/assets/badge.png" })
// Put the returned public_url in <img src="…"> or CSS.
\`\`\`

Why the functions side matters: pre-bundling your functions yourself
defeats the read-source-back features (export, find/replace, the visual
editor) and often fails at runtime. Ship the \`.ts\` source and the
platform compiles it — cross-imports resolve correctly.

Escape hatch (specialized prebuilt pipeline, native binary, etc):
  - CLI, one-off: \`somewhere deploy --prebuilt\`.
  - CLI, whole project: turn on "Allow prebuilt deploys" in the
    project's Settings.
  - REST/MCP equivalent: pass \`{ allow_bundled: true }\` in the deploy
    body.

**Have a shell? Lead with the CLI: \`somewhere deploy\` from the project
root.** It reads your files straight from disk in one trip. The MCP
\`project_deploy\` / \`project_patch\` tools below re-serialize every file
to JSON through the conversation (far more tokens) — reach for them in a
pure-MCP environment with no shell, or for in-context edits. Same compile
pipeline, same result either way.

Two ways to ship code (the MCP tools — CLI maps onto the same pipeline):

project_deploy — replaces static files (omitted files deleted), preserves omitted functions unless replace_functions:true; use for the initial deploy or a major rebuild
project_patch  — incremental, use for small edits, single-file changes, adding one endpoint

**Deploys go live immediately by default.** A normal \`project_deploy\`
or \`project_patch\` writes the live serving slot in one step — the
result is instantly at \`https://{subdomain}.somewhere.site\` and on any
verified custom domain. No extra step to publish.

## Temporary deploys (\`somewhere deploy --temporary\`)

\`--temporary\` is the no-account deploy path. The first temporary deploy
solves proof-of-work once, creates a real Free-tier temporary account with an
email like \`temp-xxxx@temp.somewhere.tech\`, and caches that credential in
\`~/.somewhere/config.json\`. Later deploys silently reuse the cached
credential; they do not solve proof-of-work again unless the credential is
missing or expired.

The expiry is account-level and absolute: the account's
\`temporary_expires_at\` is set when the temporary account is created
(${TEMP_ACCOUNT_TTL_HOURS} hours today), and more deploys do **not** extend
it. One temporary account can own many projects. If it is unclaimed, the
cleanup job purges the account, every project it owns, project data/files, and
deployed function bundles at that timestamp.

The first deploy writes the normal local project link. Redeploying from the same
directory reuses that project and therefore the same live URL; it also reprints
the original claim URL and absolute expiry. Redeploying never resets the clock.
Temporary projects are Free-tier projects, so served HTML carries the small
"Built on Somewhere" badge while temporary; uploaded source is not modified.

Default anonymous abuse limits come directly from the worker constants: 60
proof-of-work challenges per IP per hour, 5 temporary accounts per IP per hour,
and 60 direct outbound fetches per temporary project per minute. A global
account-creation cap and emergency kill switch may also refuse new sessions.

The claim link is account-level too. Opening the claim URL in a browser and
signing in converts the temporary account into a normal account and keeps
every project that account created. There is no headless claim flow; the link
is the human sign-off.

Temporary deploy developer-key scopes are derived from the worker constants:
${TEMP_ACCOUNT_KEY_SCOPES_INLINE}. Temporary runtime capabilities are:
${TEMP_RUNTIME_CAPABILITIES_INLINE}. In product terms, a temporary project has
hosting, database, files, logs, smoke/browser checks, and live deploy. Owner
features such as env vars/secrets, email, payments, AI activation, cron, and
custom domains turn on after claim.

Deploy to the public live URL, verify it there, and use
\`project_rollback\` if you need the previous live version.

## project_deploy — replaces files; preserves omitted functions by default

project_deploy fully replaces static files — a file you omit is DELETED —
but a function you omit is KEPT LIVE (merge-preserved), NOT deleted, and the
deploy WARNS you, naming each preserved function. To actually drop a function
pass replace_functions: true (then omitted functions ARE deleted) or use
project_patch with delete_files. There is no partial / incremental file
update through this tool — use project_patch for that.

If you deploy this:
  { files: { "index.html": "..." } }
...then deploy this next:
  { files: { "about.html": "..." } }
...index.html is GONE. Only about.html exists.

To update one file through project_deploy you must include EVERY file
you want live in the same call. For small edits, reach for project_patch
instead.

**Partial deploys (\`scope\`).** Pass \`scope: 'functions'\` to deploy ONLY
your functions and leave the static frontend untouched — so a backend-only
deploy can't wipe the frontend — or \`scope: 'static'\` for the inverse.
The default touches both (static files replaced, omitted functions preserved unless replace_functions:true).

**Every deploy response carries** a \`build_log\` (entry detected, chunks +
sizes, function-bundle sizes, warnings — the compile runs server-side, so
this is how you SEE what it did) and a \`rollback\` hint (\`project_rollback\`
undoes this deploy instantly; \`project_restore_version\` targets a specific
older version). \`project_deploy_log({ project_id, version? })\` returns the
build log for any past deploy without re-running it — and also carries
\`last_failed_build\` (the most recent build that failed to compile),
\`last_rejected\` (the most recent deploy rejected before compile, e.g.
bundled-output detection), and \`recent_failures\` (up to 5 safe rows with
\`failure_id\`, \`classification\`, \`message\`, \`remediation\`, and version/time).
Resolve one exact reference with
\`somewhere api GET /v1/deploy/failure/<failure_id>\`; it requires project
access and never returns the private diagnostic or stack. A project whose first deploy
ever failed has no successful build to show — the call returns
\`version: null\` with an empty \`build_log\` and whatever failure context
exists, which IS the answer to "why did my deploy fail."

## project_patch — incremental

One file per call. Two modes, same tool — pick the cheaper one each
time. Unchanged files are always preserved server-side. Static-file
changes go live in ~1 second; function changes in 2–4 seconds.

**Find / replace (~200 bytes on the wire — preferred for small edits):**

  project_patch({
    project_id: "my-app",
    path: "index.html",
    find: "<h1>Pricing</h1>",
    replace: "<h1>Plans &amp; pricing</h1>"
  })

Replaces every occurrence of \`find\` with \`replace\`. If \`find\` doesn't
match anywhere in the file, you get a 400 \`FIND_NOT_FOUND\` with a
snippet of what the file currently says — retry with the right
substring. This is the token-optimal path for visual-editor
iteration (Claude Design, Cursor).

**Full content (rewriting the file):**

  project_patch({
    project_id: "my-app",
    path: "api/hello.ts",
    content: "export default async (req, sw) => Response.json({ v: 2 })"
  })

Paths are auto-routed: anything under \`api/\` or \`_lib/\` (or a root
\`[id].ts\`-style parametric route) is a function; everything else is
a static file.

**Binary assets** (images, fonts) — \`content\` and \`find\`/\`replace\`
operate on text. Use the binary write surface (\`update_binary_files\`)
for raw bytes; trying to ship them through this tool's text fields
corrupts them via UTF-8.

**Delete:** \`delete_files\` is an array of paths. Works for both
static files and functions; missing paths are silently ignored.

**Conflict check (optional, recommended for shared projects):** pass
\`expected_version\` from your last deploy/patch response. If another
deployer landed changes since, returns 409 \`VERSION_CONFLICT\` with
\`data.current_version\` instead of overwriting. Omit to skip.

Everything you don't name stays untouched.

What is NOT affected by a deploy:
  - Env vars (managed by env_set)
  - Database contents (managed by db_query, db_migrate)
  - Uploaded files written via fs_write / sw.fs (separate storage)

## Automatic sitemap and robots files

If a project does not ship its own \`sitemap.xml\` or \`robots.txt\`, the
platform serves both automatically. The sitemap lists deployed HTML pages and
uses their upload times for \`<lastmod>\`; robots points crawlers at that
sitemap. Shipping either file overrides only that generated fallback. Routes
that exist only inside a client-side router are not separate deployed HTML
pages, so the generated sitemap cannot discover them. Ship crawlable HTML for
those routes or provide your own \`sitemap.xml\`.

## Example

project_deploy({
  project_id: "my-app",
  files: {
    "index.html": "<html>...</html>",
    "styles.css": "body { color: red }"
  },
  functions: {
    "api/hello.ts": "export default async (req, sw) => Response.json({ ok: true })"
  },
  binary_files: {
    "images/logo.png": "iVBORw0KGgo..."
  }
})

files = static assets (stored source is unchanged; served HTML can receive the
plan badge or a development/review overlay)
functions = server-side code with sw access, routed by file path
binary_files = images/fonts/PDFs as base64, decoded on the server

## Rollback

\`project_rollback\` reverts the last deploy — customers immediately
see the previous working version. Use it when a deploy broke something.
\`project_deploys\` lists prior numbered versions; \`project_restore_version\`
restores a specific one. The last 10 are kept.

## After every deploy, the platform automatically:

1. **LLM security review** (premium, Builder+) — an LLM pass
   over your deployed source returns
   structured findings against 9 risk categories (auth bypass, raw
   SQL, unsafe payment metadata, env leaks, privilege escalation,
   RCE, email spoofing, conversation hijack, CSRF). On-demand:
   → \`security_review({ project_id })\` or
   \`POST /v1/security/review\` after deploy.
2. **Screenshots the live site** — desktop + mobile, captured per
   version. The dashboard uses these as previews.
   → \`project_screenshots({ project_id })\` or
   \`GET /v1/deploy/screenshots\`.
3. **Generates a Mermaid architecture diagram** — rendered inline on
   the project Overview.
   → \`GET /v1/deploy/architecture\`.
4. **Writes a plain-English description of what your app does** —
   shown under the project name on the dashboard.
   → \`GET /v1/deploy/description\`.

Screenshots, architecture, and description run after the deploy
response returns. The LLM security review runs on demand — call
\`security_review\` after a deploy; on paid plans it also runs on promote
and in a daily pass.
Separately, a quick regex scanner
also runs during compile and surfaces obvious footguns as advisory
\`warnings\` in the deploy response — cheap synchronous gate, every
tier. Full reference: \`docs({ topic: 'deploy-intelligence' })\`.

## Check BEFORE you deploy (no deploy required)

The default check gives a fast green/red without shipping, so you fix everything
before deploying once instead of deploy → error → fix → redeploy:

- **\`project_check({ project_id, files?, functions? })\`** — run this after
  editing source and before every deploy. It typechecks / compiles / lints
  the changed files with the SAME compile gate a
  real deploy runs (syntax, undefined symbols / dropped imports,
  JSX-in-.js, Vite-only \`import.meta.glob\`) and returns
  \`{ ok, errors: [{ file, line, column, message, kind }], error_count,
  reference_checked, syntax_checked, notes }\` — writing nothing, no
  version change. A green here means the deploy's compile step passes too.
  (\`POST /v1/deploy/check\`.)
`,

  'deploy-intelligence': `# Deploy intelligence — what happens after every deploy

Every \`project_deploy\`, \`project_patch\`, and \`project_rollback\`
gets four post-deploy outputs:

1. **LLM security review** — an LLM pass over
   your deployed function source that returns structured findings.
   Premium feature (Builder+). Run via the \`security_review\` MCP
   tool or \`POST /v1/security/review\` after deploy.
2. **Screenshots** — desktop + mobile PNGs of the live homepage,
   captured automatically.
3. **Architecture diagram** — Mermaid flowchart of the project.
4. **Plain-English description** — one-paragraph summary of what
   the app does.

Screenshots, architecture, and description fire automatically in a
post-deploy async block — they're ready a few seconds after the
deploy response returns. The LLM security review runs on demand —
call it after a deploy; on paid plans it also runs on promote and in a
daily pass.

Separately, every deploy also runs a quick regex scanner during
compilation. It may flag recognizable raw SQL and authorization footguns and
surfaces hits as advisory \`warnings\` in the deploy response. It does not
analyze every query or prove a function safe. It is
NOT the security review — it's the cheap synchronous gate that ships
to every project at every tier. Suppress per-file with a
\`somewhere-security-allow\` comment.

## 1. LLM security review (premium)

An LLM pass reads up to 40 of
your deployed function files (8 KB each) and returns Markdown
findings against 9 risk categories:

1. **Auth bypass** — public routes trusting caller-supplied
   user_id / session / role instead of \`sw.auth.fromRequest(req)\`.
2. **Raw SQL exposure** — functions concatenating user input into
   query strings.
3. **Unsafe payment metadata** — \`sw.payments.checkout\` called
   with caller-controlled metadata or userId.
4. **Env leakage** — handlers returning \`sw.env.*\` values in
   responses.
5. **Privilege escalation** — \`sw.auth.admin\`, \`sw.keys\`,
   \`sw.deploy\`, \`sw.db.migrate\` called from public handlers.
6. **RCE risk** — \`eval\`, \`new Function\`, dynamic import of
   user-controlled strings.
7. **Email spoofing** — \`sw.email.send\` with \`from:\` derived
   from request input.
8. **Conversation hijack** — \`sw.ai.chat\` with
   \`conversation_id\` from caller-controlled input without an
   ownership check.
9. **CSRF / origin checks** — destructive POSTs without origin or
   token verification.

Each finding: WHAT (one line) · WHERE (file + region) · IMPACT (one
line) · FIX (snippet or one sentence). Plus a "Risk summary"
paragraph at the end.

  // MCP
  security_review({ project_id: "my-app", focus: "the new payments flow" })
  // → { findings, model, version, files_shown, files_total, usage, tier_unlocks_deep_review }

  // REST
  POST /v1/security/review
  { "project_id": "my-app", "focus": "..." }

Tier behavior (\`features.llm_security_review\`):

- **Free** — locked out (the value is \`false\` on Free; the
  response cap is 1024 tokens, which won't fit a deep review). The
  tier is "screenshots-only intel" by design.
- **Builder / Pro / Scale / Enterprise** — full review at 2048
  output tokens. Same model across tiers; only depth differs.

Advisory only — never blocks anything. Standalone feature, not a
deploy gate.

## 2. Screenshots

After the deploy commits, the platform launches a headless browser
and screenshots the live homepage at two viewports in one browser
launch:

- desktop: 1280 × 800
- mobile: 375 × 667 (iPhone SE class)

Captured from the project's custom domain if one is attached,
otherwise the \`*.somewhere.site\` subdomain.

  // MCP
  project_screenshots({ project_id: "my-app" })

  // REST
  GET /v1/deploy/screenshots?project_id=my-app[&version=42]

The screenshot also backs the blank-page gate — a PNG below 10 KB
suggests the page isn't rendering, which surfaces as a deploy alert
(see \`docs({ topic: 'deploy' })\` for the gate).

## 3. Architecture diagram

A Sonnet 4.5 pass writes a Mermaid flowchart of the project from the
function source. The dashboard fetches it and renders client-side
with the \`mermaid\` package.

  GET /v1/deploy/architecture?project_id=my-app[&version=42]
  // → { project_id, version, mermaid, generated_at }

  // Force a regenerate without redeploying:
  POST /v1/deploy/architecture/regenerate
  { "project_id": "my-app" }

An empty \`mermaid\` string means no diagram has been generated yet —
clients should hide the tile in that case.

## 4. Auto-description

A Haiku call reads the project's source and structure, then writes a
short plain-English summary of what the app does:

> "Restaurant discovery and booking app with AI chatbot. 89 users
>  browse 24 restaurants and book tables."

The dashboard renders it under the project name on the overview card
so a founder skimming "what is this project again?" gets a real
answer instead of just a subdomain.

  GET /v1/deploy/description?project_id=my-app[&version=42]
  // → { project_id, version, text, generated_at }

An empty \`text\` means no description yet (newly-created project,
never deployed, or the AI call failed). Clients should fall back to
the user's type-it-yourself description.

## Surface coverage

| Output                | MCP tool                | REST endpoint                      |
| --------------------- | ----------------------- | ---------------------------------- |
| LLM security review   | \`security_review\`       | \`POST /v1/security/review\`         |
| Regex deploy scanner  | (in deploy warnings)    | (in deploy response)               |
| Screenshots           | \`project_screenshots\`   | \`GET /v1/deploy/screenshots\`        |
| Architecture/docs     | \`project_docs\`          | \`GET /v1/project-docs\`               |
| Description           | \`project_description\`   | \`GET /v1/deploy/description\`        |

These outputs are callable from MCP. Agents can read
\`project_description\` before editing an unfamiliar project.

## What this is for

- **Customers see their site in the dashboard** without setting up a
  third-party screenshot job — it's already there per version.
- **Founders skim 30 projects** and the auto-description gives each
  one a one-liner.
- **Reviewers see the architecture** when asked "what does this app
  do?" without reading source.
- **Deploy responses surface security footguns** the moment the code
  changes, instead of waiting for an external review.
`,

  'inspect': `# Inspect — Read live state before writing

You open a session and the user says "fix the auth bug in adapted-co"
or "add a /pricing page to my-saas". The local workspace may be
stale, empty, or out-of-date — and another agent (or the user
themselves on another machine) may be editing the same project
right now. Inspecting before writing is the difference between a
clean patch and overwriting someone else's work.

## The default inspect-first order

  1. project_get { project_id }
     → Confirms the project exists. Returns subdomain, current code
       \`version\`, custom domain, owner. Save the version — it is
       your \`expected_version\` floor.

  2. project_export { project_id }
     → Pulls the live deployed source (static + functions) in one
       call. The platform is the authoritative copy. (CLI equivalent:
       \`somewhere pull <id>\` writes it to ./<slug>/.)

  3. project_deploys { project_id }
     → Last 20 versions with timestamps and deploy messages. Look
       for: deploys in the last hour (someone is active), gaps
       between versions (interrupted shipping), unfamiliar messages.

  4. deploy_status { project_id }
     → Confirms which immutable release is named by
       \`active_release_id\` and served on every project hostname.

For runtime symptoms, layer on:

  errors { project_id }
     → Last 50 runtime errors with stack and request path. Run this
       BEFORE assuming the bug is wherever the user pointed you.

  project_logs { project_id, function_path?, since? }
     → console.log output from deployed functions. Filter by
       function path or time window when investigating a specific
       endpoint.

  project_diff_versions { project_id, from, to }
     → Per-file delta between two preserved versions: added,
       removed, changed (with truncated text previews), plus
       function source. Use after a VERSION_CONFLICT to see what
       the other agent shipped before merging and retrying.

  fs_versions { project_id, path }
     → History for a single user-uploaded file (anything written
       under /v1/fs/*). NOT for project code — see below.

## Two version namespaces, never confused

There are TWO independent histories. Picking the wrong one is a
common mistake.

  Code history:    project_deploys / project_restore_version
                   Covers files + functions shipped by
                   project_deploy or project_patch.

  Upload history:  fs_versions / fs_restore
                   Covers user-uploaded files under /v1/fs/* —
                   uploads, generated PDFs, cached blobs. Each
                   path has its own version chain.

\`project_restore_version\` rolls back code but leaves uploaded
data alone. \`fs_restore\` rewinds one uploaded file without
touching code. Pick the right tool for what is broken.

## Editing what you pulled

After \`project_export\`, the response includes the current deploy
\`version\` on each pulled project. Hold that number. Pass it as
\`expected_version\` on every subsequent \`project_deploy\` /
\`project_patch\` against this project.

  const exported = await project_export({ project_id: "adapted-co" });
  // exported.version === 47

  // ...edit files locally...

  await project_patch({
    project_id: "adapted-co",
    path: "api/auth.ts",
    content: "...",
    expected_version: 47,
  });

If another agent deployed between your clone and your patch, the
platform returns:

  { ok: false, error: "VERSION_CONFLICT",
    data: { current_version: 48, expected_version: 47 } }

To see what they changed BEFORE retrying:

  await project_diff_versions({
    project_id: "adapted-co",
    from: 47,    // your expected_version
    to: 48,      // current_version from the 409
  });

Merge their changes into your local copy, then retry with
\`expected_version: 48\`.

## Subscribe to deploys in real time

Every successful \`project_deploy\` / \`project_patch\` /
\`project_restore_version\` publishes a message on the
\`system:project\` realtime channel for that project. Subscribe with a
developer key to be notified the instant another agent ships — there is no
in-function subscribe (\`sw.realtime.*\` throws \`REALTIME_UNAVAILABLE\`):

  realtime_subscribe_project({ project_id: "my-app" })
  // → { channel: "system:project", websocket_url, event_types: [...] }
  // open websocket_url; each frame is the envelope below

Event shape:

  {
    event: "deployed" | "patched" | "restored" | "rolled_back",
    data: {
      version: 49,
      by: "user_…",          // actor user_id
      message: null,         // optional deploy message
      has_functions: true,
      at: "2026-05-12T18:04:11.000Z",
    }
  }

A long-running editing agent should subscribe to this channel and
treat any \`event: "deployed"\` with a higher version than its
held \`expected_version\` as "stop, re-clone or diff, then retry."

## Who deployed v13?

\`project_deploys\` now returns each row with a \`deployed_by\`
object containing the actor's \`user_id\` and \`email\`. NULL means
the row was written before actor tracking was added (the project
owner is the safe fallback in that case).

## When you can skip the inspect-first dance

  - You just created the project in this session.
  - The user says "I'm the only person editing this."
  - You are only reading (db_query, project_logs, errors).

Inspect before writing whenever:

  - The user mentions another machine, another agent, or a
    collaborator.
  - \`project_deploys\` shows multiple deploys today.
  - You see "I have local edits" or "I cloned this last week".
  - The last \`project_deploy\` response is more than ~10 minutes
    old in your conversation — assume someone else may have
    shipped since.

## Remaining limits (be honest with the user)

  - \`project_deploy\` is full-replacement for static files (every file
    in \`files\` replaces the live set). Functions are merge-preserved
    by default — pass \`replace_functions:true\` to delete omitted
    functions. \`dry_run:true\` previews the diff before anything writes.
  - Single-file optimistic concurrency for \`fs_write\` does not
    exist yet — \`expected_version\` is a project-code check, not
    a per-file CAS for uploads under /v1/fs/*.

When either of those limits matters, surface it to the user
instead of pretending the platform has the feature.
`,

  'domains': `# Custom Domains

Projects can serve one ordinary custom-domain contract through three setup
paths:

  Claimed domain — RECOMMENDED for any domain the user already owns.
                   They delegate nameservers to us once; the domain can
                   then be attached to (and detached from) any project,
                   plus it unlocks inbox routing on the same domain.

  DNS-record setup — one project, one hostname. Apex requires ALIAS support
                     at the registrar. This is the path when nameserver
                     delegation is unavailable.

  Bought domain — registered through the platform. After purchase the
                  platform also wires DNS + SSL, so the
                  domain comes online without a separate domain_add call.

## Recommended: claim by delegating nameservers

This path covers apex (\`example.com\`), \`www\`, and any subdomain in
one move. Once active, the domain can be re-attached to a different
project without re-verifying ownership.

  // 1. Claim — returns the nameserver pair to paste at the registrar.
  domain_claim({ domain: "example.com" })
  // → { id: "dom_...", claim_status: "pending_ns",
  //     nameservers: ["<ns1>", "<ns2>"],  // the pair to paste at your registrar
  //     instructions: [...] }

  // 2. User updates nameservers at registrar (Namecheap, GoDaddy, ...).

  // 3. Either wait for the hourly poll, or check on demand:
  domain_check_ns({ id: "dom_..." })
  // → { claim_status: "active" } once propagation is complete.

  // 4. Attach to a project. host = "apex" (default), "www", or a
  //    single subdomain label like "app".
  domain_attach({ id: "dom_...", project_id: "my-app", host: "apex" })

  // To move the domain to a different project later — no re-verify:
  domain_detach({ id: "dom_..." })
  domain_attach({ id: "dom_...", project_id: "other-app", host: "apex" })

  // To list every domain the user has claimed (regardless of attachment):
  domain_owned({})

## Claim lifetime + cleanup

A claim belongs to the user's account, not to a project. \`project_delete\`
is not the cleanup path for an unattached or pending claim, including one
created before a project is attached.

To remove an account-level claim from \`domain_owned\` — including a pending
claim created during a temporary test — remove it by domain name before
deleting the throwaway project:

  domain_remove({ domain: "example.com" })

Use \`domain_detach({ id })\` instead when the user only wants to free the
project binding and keep the claim for later.

## Inbox on a claimed domain (opt-in)

\`domain_claim\` deliberately leaves MX records alone — the user might
already receive email at the domain via Gmail, Workspace, or their own
server. Turn on inbox routing only when the user explicitly wants it:

  domain_enable_email({ id: "dom_..." })
  // ⚠ Replaces existing MX records on the domain.
  // After this, inbox_create_address works on this domain.

If the user already has email working, skip this and keep their MX
intact.

Want mail to ALSO land in the inbox the user already reads (Gmail,
Outlook)? After creating the address, wire forwarding with
\`inbox_forward_set({ address_id, forward_to: "you@gmail.com" })\` —
the project inbox keeps a copy and a copy is delivered externally.
See docs({ topic: 'inbox' }) for the confirmation flow.

## Ownership

When a user buys a domain through somewhere.tech, the buyer is the
registrant of record from the moment of purchase. Privacy protection is
on by default, and the domain can be moved to their own registrar account
or transferred out any time. Full details: https://somewhere.tech/docs/domain-ownership

## Stuck domain recovery

If a claimed domain shows \`claim_status: active\` and
\`zone_status: active\` in \`domain_owned\` but \`dig <domain>\`
returns NXDOMAIN or empty answers, the platform-wiring step had a
partial failure during claim. Recover with:

  domain_publish({ id: "dom_..." })

This re-asserts the apex + www records and the routing. Idempotent —
safe to call any time. Inbox routing is only re-asserted if it was
already enabled, so this never silently overwrites MX records.

## DNS-record setup

For the rare user who can't change nameservers (e.g. corporate domain
they don't own). Apex needs ALIAS / ANAME support at the registrar.

  domain_add({ project_id: "my-app", domain: "app.yourcompany.com" })
  // Returns the CNAME + verification TXT to set at the registrar.

  domain_verify({ project_id: "my-app", domain: "app.yourcompany.com" })
  // Polls DNS + SSL. Once verified, the domain serves prod immediately.

A verified custom domain and the project's \`*.somewhere.site\` subdomain
serve the same immutable release named by \`active_release_id\`.

## Buy a domain through checkout

Check availability, then request the purchase preview:

  domain_check({ domain: "acmedash.com" })
  // → { available: true, price: "<amount>/year" }

  domain_buy({ project_id: "my-app", domain: "acmedash.com" })
  // → { ok: false, error: "PURCHASE_CONFIRMATION_REQUIRED",
  //     domain: "acmedash.com", price: "<amount>/year",
  //     dashboard_checkout_url: "https://somewhere.tech/dashboard/..." }

Show the user the price and \`dashboard_checkout_url\`. The USER opens that
link, logs in (or creates an account when prompted), and pays in checkout.
There is no agent-side purchase-finalization step. Registration and automatic
DNS/SSL setup begin only after checkout reports settled payment. The first
paid domain on a Free account also unlocks 30 days of Builder for free.

## Domain search

  // Search for available domains across many TLDs at once
  // (rate-limited to 10/min and 100/day per user; results are cached
  // for 5 minutes so the same keyword is instant after first hit)
  // → returned by the /v1/domains/search REST endpoint or the
  //   somewhere.site /search page.

## Listing + removal

  domain_list({ project_id: "my-app" })          // custom domains
  domain_remove({ domain: "app.yourcompany.com" }) // remove or release a claim
`,

  'domain-ownership': `# You own your domain

When you buy a domain through somewhere.tech, it is registered in **your name** from the moment of purchase. The owner of record is you — not us.

## What that means

- **You are the legal owner.** The registration lists your name and email as the registrant. Somewhere HQ, Inc. appears only as the operational contact, which is what lets us handle DNS, SSL, and renewals for you.
- **Privacy is on by default, free.** Public domain lookups don't show your name or email — privacy protection is enabled automatically on every purchase.
- **Your address stays private too.** We don't ask for a postal address when you buy; the record uses our company address on your behalf, and privacy protection hides it anyway.

## Taking your domain elsewhere

It's your domain, so you can leave with it at any time:

1. **Keep it here (default).** We manage DNS, SSL, and renewal. Nothing to do.
2. **Move it to your own account.** We can hand the domain to an account you control at the registrar — free and instant.
3. **Transfer to any other registrar.** Standard transfer with an authorization code. Note: registries worldwide enforce a 60-day transfer lock after a new registration — a rule that applies everywhere, not something we impose.

To start either move, email support@somewhere.tech from your account email and name the domain. No exit fees, no retention hoops.

## Renewals

Domains renew annually at the price shown when you bought them. Renewal is handled automatically through your account so your site never lapses.

## Domains you bought elsewhere

Connecting a domain you already own (from any registrar) never changes its ownership — it stays in your account at your registrar; we only serve traffic for it.
`,

  'realtime': `# Realtime — live updates driven by database writes

Live updates are driven by the database, not by a channel API you call.
Your function writes a row; the platform publishes the change; a browser
that subscribed to a declared live view re-reads through your own
function. That is the whole supported shape today.

## Not available inside a deployed function

\`sw.realtime.publish\`, \`sw.realtime.subscribe\`, \`sw.realtime.channels\`,
\`sw.realtime.broadcast\`, and \`sw.realtime.meta\` all throw
\`REALTIME_UNAVAILABLE\` (400). Standalone customer channels — chat rooms,
presence, per-user notification channels driven from your own handler code —
are deferred. There is no in-function pub/sub. If you need it, file it with
\`feedback({ ... })\` so the demand is counted.

## The browser path that works — a declared live view

\`sw.db.live(name, sw.db.from(...))\` is the live path a signed-in browser
can subscribe to. The function returns the first rows plus an opaque
subscription URL; the browser listens for invalidation and re-calls your
function for fresh rows. No SQL, table name, predicate, owner, or channel
is ever sent from the browser.

  // api/open-notes.ts — the declaration and the SELECT stay server-side
  export default async function (_req, sw) {
    return Response.json(await sw.db.live('notes.open', sw.db.from('notes', {
      where: { done: false },
      columns: ['id', 'title', 'done'],
      order: [['created_at', 'desc'], ['id', 'asc']],
      limit: 20,
    })))
  }

  // browser — the loader re-calls the function, never the database
  import { watchLive } from '/__sw/live/client.js'

  const stop = watchLive(
    () => fetch('/api/open-notes', { credentials: 'include' }).then(r => r.json()),
    (rows) => render(rows),
  )

Declaration rules (bounded \`limit\`, required \`order\`, owner/shared tables
only), the invalidation contract, and release/rollback behavior are in
\`docs({ topic: 'sw.db' })\` under "Named live views".

## Database-change events — db:<table>

Every successful \`sw.db\` write also publishes on the channel
\`db:<table>\` (table name lowercased), event \`insert\` / \`update\` /
\`delete\`, payload:

  { event, table, timestamp, row, rows, row_count, truncated }

\`rows\` carries the changed row(s) the statement returned (the new row on
insert/update, the old row on delete) and \`row\` is a convenience alias for
\`rows[0]\`; a statement that returned nothing still fires the event with
\`rows: []\`. The payload is bounded — 25 rows, 1 KB per field, 32 KB total,
with \`truncated: true\` when it was trimmed.

These channels are reachable with a DEVELOPER key: server-to-server
consumers, CI, and operator tooling you run yourself. A browser cannot
subscribe to them — see "What app-user sessions cannot reach" below. For a
browser, declare a live view.

## Publish and subscribe from outside — developer key

From CI, a server you run, or an agent, publish on any channel name:

  realtime_publish({
    project_id: "my-app",
    channel: "ops:deploys",
    event: "shipped",
    data: JSON.stringify({ version: 12 })
  })

  // → { channel, event, delivered }   delivered = sockets that received it

Channel names match [a-zA-Z0-9][a-zA-Z0-9_\\-:.]{0,127}; \`event\` defaults
to 'message'; payload cap 64 KB. Subscribe with the same authority by
opening a WebSocket:

  wss://api.somewhere.tech/v1/realtime/subscribe?project_id=<id>&channel=<name>&token=<developer key>

  // envelope: { type, event, data, from, at }

The key on that URL is a developer credential. Keep it in server-side code
you control; never ship it to a browser. On reconnect the platform does not
replay buffered events — refetch state over REST when you connect.
\`realtime_channels({ project_id })\` lists channels touched in the last 10
minutes with their subscriber counts.

## What app-user sessions cannot reach

An app-user session or JWT is refused on every realtime channel, for both
publish and subscribe (\`CHANNEL_FORBIDDEN\`, 403). This is the whole
standalone-channel surface being closed, not a per-channel rule: there is
no browser chat channel, no presence, and no \`private:USERID:\` namespace
in service today. What does reach a signed-in browser is a declared live
view plus ordinary requests to your own functions.

## Platform-emitted system events (developer key, subscribe-only)

The platform publishes its own lifecycle events on two reserved channels.
You don't publish to these — subscribe with a developer key and let the
platform push.

  realtime_subscribe_project({ project_id: 'my-app' })
  // → { channel: 'system:project', websocket_url, event_types: [...] }

  realtime_subscribe_user({})
  // → { channel: 'system:user', websocket_url, event_types: ['feedback_resolved'] }

The 'system:project' channel emits:
  - 'deployed' | 'patched' | 'restored' | 'rolled_back'
      { version, by, message, has_functions } — multi-editor conflict
      prevention. See a version bump, pull before pushing.
  - 'db_health'
      { event: 'cpu_exhaust_recovered' | 'cpu_exhaust_failed',
        query_fingerprint } — fires when the platform retried a slow
      query for the user.
  - 'quota_warning'
      { resource: 'storage' | 'database' | 'email' | 'realtime' |
        'ai' | 'inbox', usage_percent, message } — fires once per 80%
      and 95% crossing per resource per month.
  - 'auth_event'
      { event: 'user_deleted' | 'user_banned' | 'user_unbanned' |
        'impersonation_started', user_id, actor_id }.

The 'system:user' channel emits 'feedback_resolved' { ticket_id,
response, resolution_status } when the platform team responds to or
resolves a feedback() ticket you submitted. The channel is bound to your
own user id.

Platform-emitted events bypass the publish quota — they're free.

## Limits
Free: 100,000 publishes / month. Pro+: unlimited. Per-message
payload cap: 64 KB.

## Don't build with this
Durable history, replay-on-connect, presence, stateful rooms. Realtime is a
fire-and-forget transport. State belongs in sw.db — which is also what
drives every live update a browser can see.
`,

  'cron': `# Cron — Scheduled Tasks

Customer recurring schedules are available on Builder and higher. Free keeps
one-shot jobs and queues, but creating or editing customer cron schedules is
disabled by the plan.

> **New, 2026-09-02 — plans now set a minimum interval between fires.**
> Creating or editing a schedule tighter than your plan allows is refused
> (\`CRON_SCHEDULE_TOO_FREQUENT\`). Schedules that already exist are NOT
> re-checked and keep running unchanged. Read your plan's interval from
> \`cron_list({ project_id })\` → \`policy.min_interval_minutes\`.
> See "Minimum interval" below.

Run a handler on a fixed schedule. Schedules use UTC by default. Pass an IANA
\`timezone\` such as \`America/Los_Angeles\` when the schedule should follow a
local wall clock; daylight-saving changes are applied automatically. For
example, 09:00 in Los Angeles fires at 16:00Z during September PDT and 17:00Z
during December PST. Existing schedules and calls that omit \`timezone\` remain
UTC.

## Create a schedule
cron_create({
  project_id: "my-app",
  schedule: "0 9 * * *",                    // 5-field cron expression
  timezone: "America/Los_Angeles",          // optional; defaults to UTC
  handler: "/api/jobs/daily-digest",
  payload: { segment: "daily" }             // optional
})

## Run once now

Use \`cron_run({ cron_id })\` to test the existing handler immediately. It uses
the same job path as a scheduled fire, does not change the schedule, and
records the job with \`trigger: "manual"\`. Read that task's history with
\`job_get({ cron_id })\`.

## Schedule format
  minute  hour  day-of-month  month  day-of-week
  0       9     *             *      *           → every day at 09:00 in the selected timezone
  */15    *     *             *      *           → every 15 minutes
  0       0     1             *      *           → first of every month

The finest granularity is **one minute** — a 5-field expression has no
seconds field, so you can't schedule "every 10 seconds." For sub-minute
live updates, push via realtime as data arrives instead of scheduling →
\`docs({ topic: 'live-data' })\`.

## Minimum interval

Your plan sets the smallest gap allowed between two fires. Read it from
\`cron_list({ project_id })\`, which returns a \`policy\` block carrying
\`plan\` (the plan's name), \`min_interval_minutes\` and
\`max_per_project\`. Null on either field means that plan sets no limit.

A schedule that fires more often than \`min_interval_minutes\` is refused
when you create or edit it — \`CRON_SCHEDULE_TOO_FREQUENT\`, with a message
naming the plan's interval and the one you asked for. The check measures the
schedule's real cadence, so a tight gap hidden inside a sparse-looking
expression is caught too.

**Schedules that already exist are never re-checked.** A schedule created
before its plan had a floor keeps firing exactly as it does today; only a
create or an edit of the schedule itself is checked. Editing the handler,
the payload, the name, or resuming a paused task leaves the cadence alone.

\`policy.max_per_project\` is the other plan limit: how many scheduled tasks
one project may hold. Both numbers come from your plan — never assume them,
read them.

## Handler
Point handler at a deployed function — a cron handler IS a deployed function,
written and deployed like any other (see docs({ topic: 'functions' })), so
deploy it before creating the schedule. Platform POSTs payload when the
schedule fires. Same retry and idempotency rules as sw.jobs: a run may
repeat and must be idempotent; no exactly-once guarantee.

Verify that a request really came from the scheduler before doing work:
\`if (!(await sw.jobs.verifyInvocation(req))) return new Response('forbidden', { status: 403 });\`
— the same call sw.jobs handlers use (sw.queue.verifyInvocation delegates to
it). Do not trust a request header or a shared secret of your own; the
platform signs each invocation and \`verifyInvocation\` is the only supported
check.

## Recipe — hourly cleanup of stale rows

"Delete unpaid/expired submissions every hour" is a scheduled task even when
nobody says "cron". It needs both halves: a deployed, signed handler and a
registered schedule.

\`\`\`ts
// api/jobs/cleanup.ts — deployed with the app; runs only when the scheduler calls it
export default async function (req, sw) {
  if (!(await sw.jobs.verifyInvocation(req))) return new Response('forbidden', { status: 403 });
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const r = await sw.db.remove('submissions', { where: { status: 'unpaid', created_at: { lt: cutoff } } });
  return Response.json({ removed: r.changes });
}
\`\`\`

\`\`\`bash
somewhere deploy                                   # the handler must be live first
somewhere cron create "0 * * * *" /api/jobs/cleanup --project <project> --name cleanup
somewhere cron run cleanup --project <project>     # fire once now to prove it (id or name)
\`\`\`

The schedule is refused with \`CRON_SCHEDULE_TOO_FREQUENT\` if it is tighter
than your plan's \`min_interval_minutes\` (read it from \`cron_list\`). The
handler may run more than once and must be idempotent.

## Missed fires
If the platform is down across a fire time, the run is NOT replayed.
Design schedules to tolerate an occasional skipped run.
`,

  'live-data': `# Live data — one poller, fan out to every client

The golden path for any app that shows the SAME live value to many
viewers at once: live scores, a price ticker, a leaderboard, an auction
count, a status board. There is a right way and a wrong way, and the
wrong way is the one most agents reach for first.

**Anti-pattern (don't): per-client polling.** Every viewer hits the
source on a timer. A World-Cup-style live-scores page where 5,000
viewers each poll the source every 12 seconds makes ~25,000 calls/minute
to that source — your rate limits trip, the source may ban you, and the
cost scales with your audience. Worse with every viewer you add.

**Pattern (do): one server-side poller, one declared live view.** Fetch
the source ONCE on the server per tick, write the snapshot to your
database, and let every client's declared live view re-read it. Load on
the source is O(1) — the same single fetch whether one person or a
million are watching.

## Step 0 — taking over a project you didn't build

Adding live data usually means editing an app you didn't write. Orient
first, with the dependable sequence:

  1. project_files_list { project_id }  — the file tree (paths only).
  2. project_grep { project_id, pattern } — find where things live
     (e.g. the polling code, the page that renders the value).
  3. project_file_read { project_id, path } — read the few files that
     matched.

## The pattern, end to end

  1. A scheduled function (cron) fetches the live source ONCE per tick.
  2. It writes the snapshot to a table with the structured builder, so a
     client connecting mid-stream reads the current value immediately and
     the write invalidates every subscribed view.
  3. A second function DECLARES the live view over that table.
  4. Each client calls that function once for first paint, then re-reads
     it on every invalidation. No client ever polls the source.

Declare the snapshot table in \`db/schema.ts\` — it is the same value for
everyone, so \`shared()\`:

\`\`\`typescript
// db/schema.ts
import { schema, table, id, text, timestamp, shared } from 'somewhere/db'

export default schema({
  live_snapshot: table({
    id: id(), key: text({ unique: true }), json: text(),
    updated_at: timestamp({ default: 'now' }),
  }, { scope: shared() }),
})
\`\`\`

## Server — the poller (a scheduled function)

\`\`\`typescript
// api/poll-scores.ts — fetch once, write the snapshot.
export default async function (req, sw) {
  const scores = await (await fetch('https://example.com/api/scores/live')).json()

  // The composed write is what invalidates every live view over this table.
  // Raw sw.db.query never feeds a live view — and on a project with a
  // db/schema.ts it cannot write at all.
  await sw.db.insert('live_snapshot',
    { key: 'scores', json: JSON.stringify(scores) },
    { onConflict: 'update' })
  return Response.json({ ok: true })
}
\`\`\`

## Server — the declared view the browser subscribes to

\`\`\`typescript
// api/scores.ts
export default async function (_req, sw) {
  return Response.json(await sw.db.live('scores.current', sw.db.from('live_snapshot', {
    where: { key: 'scores' },
    columns: ['id', 'key', 'json'],
    order: [['id', 'asc']],
    limit: 1,
  })))
}
\`\`\`

Schedule it to refresh once a minute:

\`\`\`text
cron_create({ project_id: "my-app", schedule: "* * * * *", handler: "/api/poll-scores" })
\`\`\`

## Client — read once, then subscribe (never poll)

\`\`\`js
import { watchLive } from '/__sw/live/client.js'

// First paint AND every update come from the same call: watchLive loads
// through your function, then re-loads whenever the platform says the
// declared view may be stale. The source is never touched from the browser.
watchLive(
  () => fetch('/api/scores', { credentials: 'include' }).then(r => r.json()),
  (res) => render(JSON.parse(res.data[0].json)),
)
\`\`\`

Every frame on that socket is control only — "this view may now be stale" —
so the browser always re-reads through your function and never applies a row
off the wire. \`watchLive\` also refreshes on reconnect, on tab focus, and
at least every 30 seconds, so a missed invalidation self-heals.

Realtime CHANNELS are not an option here: an app-user or anonymous browser
session is refused on every channel (\`CHANNEL_FORBIDDEN\`, 403), and
\`sw.realtime.publish\` is not available inside a function. See
\`docs({ topic: 'realtime' })\`.

## Sub-minute updates (live sports, finance)

**Cron cannot go sub-minute — a hard floor.** A 5-field cron expression has
no seconds field, so you cannot schedule "every 10 seconds," and your plan
may set a wider minimum than a minute on top of that (\`cron_list\` reports
it as \`policy.min_interval_minutes\`). For sub-minute live data you do NOT
lean on cron for the cadence:

- If you RECEIVE the data (a webhook, an inbound feed, a user action),
  write the snapshot the instant it arrives — the composed write
  invalidates every subscribed view immediately, with no schedule at all.
- If you must PULL it, run the cron poller at the tightest interval your
  plan allows to keep the snapshot fresh; anything arriving faster is
  written from wherever it enters your system.

Either way the rule holds: every viewer re-reads one snapshot through your
own function — the source is hit O(1), never once-per-viewer.

## Reference data: enrich into a table, don't hardcode it

Seed/reference data — a squad roster, a product catalog, a venue list —
does NOT belong inline in your frontend. Hardcoding it means every
correction is a redeploy. Instead, write a RE-RUNNABLE job that builds
the dataset into \`sw.db\` (or a \`sw.fs\` JSON file), and have the page
read it at runtime:

\`\`\`typescript
// jobs/build-rosters.ts — fetch sources, extract to a schema, store. Re-runnable.
export default async function (req, sw) {
  const raw = await (await fetch('https://example.com/teams')).text()
  const result = await sw.ai.chat({
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content:
      \`Extract every player from this page as a JSON array of
       {team, name, number, position}. Return ONLY the JSON.\\n\\n\${raw}\` }],
  })
  const players = JSON.parse(result.text)
  for (const p of players) {
    await sw.db.query(
      'INSERT INTO players (team, name, number, position) VALUES (?, ?, ?, ?)',
      [p.team, p.name, p.number, p.position]
    )
  }
  return Response.json({ inserted: players.length })
}
\`\`\`

Run it on demand or on a cron (\`cron_create\`) to refresh. The frontend
fetches \`/api/players\`, so correcting a roster updates the live app
with NO redeploy. Same shape for any "fetch sources → extract to a
schema → serve" job.
`,

  'smoke': `# Smoke tests — deploy and recurring checks

Manual \`site_check\` and deploy-triggered verification remain available on
every plan. Automatic recurring smoke checks run on Builder and higher at the
plan cadence; Free does not run recurring smoke work.

Status per run: \`pass\` / \`partial\` / \`fail\`. A fail-after-pass
transition is detected and alerted automatically, debounced by
\`alert_cooldown_seconds\` (default 3600).

## MCP

  site_check_status({ project_id })
    → { latest: SmokeRun, history: SmokeRun[] }

  site_check({ project_id })
    → { run: SmokeRun }            // synchronous on-demand probe

  smoke_config_get({ project_id })
  smoke_config_update({ project_id, enabled?, test_auth_flow?, alert_cooldown_seconds?, extra_checks?, test_user_email?, canary_enabled? })

\`extra_checks\` is an array of additional URL probes:
  [ { name: "users-list", path: "/api/users", expect_status: 200 }, ... ]

## Probe fields

Each probe accepts:

- \`path\` (required) — must start with \`/\`.
- \`method\` — default \`GET\`.
- \`name\` — label in run results (max 80 chars); auto-generated if omitted.
- \`expect_status\` — exact HTTP status. Without it, anything below 500
  passes — useful for "POST /api/login with no body should be 4xx, not
  500" and similar contract checks.
- \`headers\` — extra request headers (max 10 per probe).
- \`body\` — request body. An object is sent as JSON (Content-Type set
  for you); a string is sent raw. Max 8 KB.
- \`auth: "test_user"\` — the probe runs authenticated: the platform
  mints a fresh session for the project's designated test user at probe
  time. Set the test user first with
  \`smoke_config_update({ test_user_email })\` — it must be an existing
  app user of the project (create one via signup). No credentials are
  ever stored in the manifest. When \`auth\` is set, the Authorization
  header can't be overridden via \`headers\`.
- \`expect_json_path\` — dot-path (or array of them, max 10) that must
  resolve to a non-null value in the JSON response, e.g.
  \`"data.reply"\` or \`"choices.0.message"\`.
- \`expect_contains\` / \`expect_not_contains\` — substrings the response
  text must / must not contain (string or array, max 10 each).
- \`expect_max_ms\` — fail the probe if it takes longer than this, even
  on HTTP 200.

## 15-minute canary (opt-in)

  smoke_config_update({ project_id, canary_enabled: true })

Runs the full check set (homepage + custom domains + extra_checks +
\`/_smoke_tests.json\`) every 15 minutes, on top of the regular
cadence. Off by default. A fail-after-pass transition alerts the
project owner (debounced by \`alert_cooldown_seconds\`).

## Auto-detected: \`/_smoke_tests.json\`

Deploy a JSON file at \`/_smoke_tests.json\` in your project and the
cron picks up the entries automatically — same shape as
\`extra_checks\`, no config call needed. Up to 20 entries per project.
Useful when you want the smoke contract to ship with the code, not
sit in the dashboard:

\`\`\`json
[
  { "name": "homepage",     "path": "/",                 "expect_status": 200 },
  { "name": "auth-page",    "path": "/login",            "expect_status": 200 },
  { "name": "api-list-no-auth", "path": "/api/users", "method": "GET", "expect_status": 401 }
]
\`\`\`

If both \`extra_checks\` and \`/_smoke_tests.json\` are present, both
run — they're additive.

## Opt out

  await smoke_config_update({ project_id: '...', enabled: false })

Use for projects whose homepage is intentionally a 401 (private apps)
or where the cron is a nuisance during a known outage window. You can
still trigger \`site_check\` while disabled — the opt-out only stops
the automated cron + deploy hooks.
`,

  'tasks': `# Tasks — Per-project ticketing

Track work, incidents, or any todo-shaped state per project. Tasks
and their comments live in the project's own database (auto-created
on first write) so they travel with exports. Free +
unlimited. Every mutation publishes a realtime event automatically.

## From a deployed function

\`\`\`js
const t = await sw.tasks.create({
  title: 'Investigate latency',
  priority: 'high',
  area: 'api',
})
await sw.tasks.comment(t.id, 'spike started ~14:02 UTC')
await sw.tasks.update(t.id, { status: 'in_progress', assignee: userId })

// Break work into sub-tasks.
const sub = await sw.tasks.create({
  title: 'Profile the slow endpoint',
  parent_id: t.id,
  area: 'api',
})

const open = await sw.tasks.list({ status: 'open', limit: 100 })
const apiOnly = await sw.tasks.list({ area: 'api' })
const topLevel = await sw.tasks.list({ parent_id: 'null' })  // no parent
const children = await sw.tasks.list({ parent_id: t.id })
const full = await sw.tasks.get(t.id)   // includes comments[]

await sw.tasks.delete(t.id)
\`\`\`

## Fields

- \`id\` (\`tsk_…\`)
- \`title\` (required), \`description\`
- \`status\`: \`backlog\` | \`open\` | \`in_progress\` | \`blocked\` |
  \`needs_review\` | \`done\` | \`archived\`. \`backlog\` is for raw,
  untriaged ideas — devs filter with \`status:'open'\` so backlog
  doesn't surface in active queues; promote when ready to work. Use
  \`blocked\` when external action is required, \`needs_review\` when
  work is done but waiting on sign-off.
- \`priority\`: \`low\` | \`normal\` | \`high\` | \`urgent\`
- \`assignee\`, \`reporter\` (defaults to caller)
- \`labels\`: string[]
- \`due_at\`: ms epoch
- \`area\`: free-form subsystem tag (e.g. \`billing\`, \`auth\`, \`ui\`)
  for filtering related tasks
- \`parent_id\`: optional parent task ID — makes this a sub-task. A
  task cannot be its own parent. Deleting a parent does NOT cascade —
  detach or delete sub-tasks first if you want them gone.
- \`created_at\`, \`updated_at\`, \`completed_at\` (auto-synced when
  transitioning to / from \`done\`)

## Notifications

Every mutation publishes \`task.created\` / \`task.updated\` /
\`task.deleted\` / \`task.commented\` on the project's
\`system:project\` realtime channel — no config required.

Optionally fan out to a webhook URL and / or email:

\`\`\`js
const { webhook_secret } = await sw.tasks.settings.update({
  webhook_url: 'https://example.com/task-webhook',
  notify_email: 'alerts@yourcompany.com',
})
// Store webhook_secret — it's returned exactly once.
\`\`\`

Webhook signature header:
\`X-Somewhere-Signature: t=<ms>,v1=<hmac-sha256-hex>\` — signed body
is \`\${ms}.\${rawBody}\`. Same scheme as db_webhooks and inbox.

Pass an empty string to clear a field. Clearing \`webhook_url\` also
clears the secret. \`sw.tasks.settings.get()\` never returns the
secret — only the first \`settings.update\` that mints one does.

## MCP tools

- \`tasks_create\` / \`tasks_list\` (pass \`task_id\` to read one task's
  bounded current state) / \`tasks_get\` (current, history, field, or full
  view — below) / \`tasks_update\` (also accepts \`comment\` to append a
  comment) / \`tasks_delete\`
- \`tasks_settings_get\` / \`tasks_settings_update\`

## Reading a task: current, history, field, full

Reads are bounded so an agent never receives a runaway payload, and nothing
is lost: every shortened field names its exact expansion, and \`view=full\`
returns everything. \`GET /v1/tasks/:id\` takes the same options as
\`tasks_get\`: \`view\`, \`kind\`, \`field\`, \`event_id\`, \`cursor\`,
\`limit\`, \`offset\`.

- **\`view=current\` (default).** The task's live fields, bounded to about
  12,000 JSON characters. Only top-level fields are shortened (description,
  status_note, relationships, acceptance_criteria, why carry the largest
  caps); each shortened field appears in \`omitted\` as
  \`{ json_chars, total_items?, returned_items? }\`. \`history\` carries the
  comment and activity totals, and \`retrieval\` carries the exact follow-up
  calls. Values are read from live records, not a transaction snapshot.
- **\`view=history\`, \`kind=comments|activity\`.** Newest first
  (\`created_at DESC, id DESC\`), \`limit\` default 5, cap 20; the response
  budget may return fewer. Continue by repeating the same options with
  \`page.next_cursor\` as \`cursor\`. The keyset fixes its upper bounds on the
  first page: later appends do not restart the traversal, deleted events
  disappear, edited comment bodies are live, and a deletion followed by an
  insert at the same timestamp can admit a new event on a later page.
- **\`view=field\`, \`field=<top-level key>\`.** Expands one shortened field
  as JSON text in chunks of up to 4,200 characters (UTF-16 offsets);
  concatenate the \`content\` chunks, then \`JSON.parse\` once. For a history
  event's field also pass \`kind\` and \`event_id\`. Every continuation checks
  a content hash: if the field changed you get \`CURSOR_STALE\` (409) —
  restart that field read without a cursor. \`description_excerpt\` expands
  \`description\`; comments and activity are read with \`view=history\`.
- **\`view=full\`.** The unbounded compatibility response: every field
  complete, all comments and activity oldest first (\`created_at ASC, id
  ASC\`). \`sw.tasks.get()\` and \`sw.tasks.list()\` in your functions use
  this view.

\`cursor\` and \`offset\` are exclusive; \`cursor\` is valid only for history
and field reads and must be paired with the options that produced it
(\`INVALID_CURSOR\` otherwise). \`tasks_list\` pages the same way: default
10 rows (cap 500; bounded reads return at most 20 per page and shorten
\`title\`, \`status_note\` and \`description_excerpt\`; \`detail=full\`
permits unbounded descriptions). Ordering is a live keyset, so edits to the
sort or filter fields can skip or repeat rows — restart without a cursor for
a fresh queue. Never concatenate pages automatically.

## Org memory — recall before the decision, record after it changes

Tasks also back the org's durable memory. These two tools are for decisions
and beliefs, not ordinary todo rows:

- \`recall({ project_id, q?, type? })\` — use before changing architecture,
  product policy, operations, or any choice the founder treats as settled.
  It searches durable philosophy/directive/spec/learning rows so the next
  implementation starts with the existing decision.
- \`record({ project_id, title, body?, type?, area?, labels? })\` — use at
  close-out when a principle, SOP, supplier fact, learning, vision, or spec
  changed. State the claim as a sentence in \`title\`; link related task ids in
  \`body\`.

For active work use \`tasks_*\`. For "what do we believe, and why?" use
\`recall\` / \`record\`.

## Default ordering

\`tasks_list\` and \`sw.tasks.list({})\` sort active tasks ahead of
\`done\` ones, then by priority (\`urgent\` → \`high\` → \`normal\` →
\`low\`), then by \`created_at DESC\` within each priority. Pass an
explicit filter (\`status\`, \`priority\`, \`area\`, \`parent_id\`) to
narrow. There's no \`order_by\` field — if you need a different order,
sort client-side.

## Closing a task: always include a resolution_note

\`\`\`js
await sw.tasks.update(id, {
  status: 'done',
  resolution_note: 'Root cause: stale CDN cache. Purged + added cache-bust query string. No customer impact.',
})
\`\`\`

The note is persisted as a comment AND included in the resolution
email + webhook payload so the reporter knows what was done. If you
omit it on a task with zero prior comments, the API returns the same
\`{ ok: true }\` response with an extra \`hint\` field nudging you to
add one. The warning is non-blocking — bulk triage of stale tickets
doesn't need a note on every row.

## Best practices

- **Priority honestly.** Reserve \`urgent\` for things actively
  breaking customers. Default to \`normal\`. \`high\` is for "needs
  this sprint".
- **Use \`area\` consistently per project.** Pick 4–8 tags
  (\`billing\`, \`auth\`, \`api\`, \`ui\`, \`infra\`) and reuse them.
  The dashboard can filter on it; agents can list per-area open work.
- **Parent + sub-tasks for multi-step work.** Use \`parent_id\` when a
  task naturally splits. Don't create a parent for a one-liner.
- **Don't delete; close as \`done\` or \`archived\`.** The audit trail
  matters. \`delete\` is for malformed test rows.
`,

  'sw.rateLimit': `# sw.rateLimit — Rate limiting

Throttle abusive callers without standing up Redis or a token-bucket
library. One method, fixed-window counter, per-second granularity.

## sw.rateLimit.check(key, max, windowSeconds)

Returns \`{ allowed, remaining, reset, limit, window_seconds }\`.
On \`allowed: false\`, return 429 to the caller. \`reset\` is the epoch
seconds when the current window rolls over.

## Per-IP login throttle

\`\`\`js
export async function POST(req, sw) {
  const ip = req.headers.get('cf-connecting-ip') || 'unknown'
  const rl = await sw.rateLimit.check(\`login:\${ip}\`, 5, 60)
  if (!rl.allowed) {
    return Response.json(
      { error: 'too_many_attempts', retry_at: rl.reset },
      { status: 429 }
    )
  }
  // …handle login
}
\`\`\`

## Per-user API throttle

\`\`\`js
const user = await sw.auth.fromRequest(req)
const rl = await sw.rateLimit.check(\`api:\${user.id}\`, 100, 60)
if (!rl.allowed) return Response.json({ error: 'rate_limited' }, { status: 429 })
\`\`\`

## Per-endpoint global cap

\`\`\`js
const rl = await sw.rateLimit.check('signup', 1000, 3600)  // 1k signups/hour
if (!rl.allowed) return Response.json({ error: 'paused' }, { status: 429 })
\`\`\`

## Notes

- Keys are scoped per project automatically — \`login:1.2.3.4\` in your
  app does not collide with the same key in someone else's app.
- \`max\` is a positive integer up to 1,000,000.
- \`windowSeconds\` is between 1 and 86,400 (24h).
- Counters are best-effort fixed-window. A small under-count is possible
  at window boundaries on highly concurrent calls — fine for throttling,
  not appropriate for hard quotas.
`,

  'pricing': `# Pricing

Tiers: Free, Builder, Pro, Scale, Enterprise. Projects, deploys, and bandwidth are
unlimited on every tier; custom domains are available on every tier (Free retains the
"Built on Somewhere" badge). Current prices, limits, and AI allowances are served live at:

  GET https://api.somewhere.tech/v1/pricing   (public, cached)

Always read /v1/pricing for exact, current numbers rather than hardcoding them. A user's
own plan and usage are on their dashboard Billing page.
`,

  'sw.billing': `# sw.billing — plans & feature gating for YOUR app's users

Define the plans YOUR app sells and the features each one unlocks, then gate
anything with a single check. You gate on a stable feature name (\`'export'\`),
never on a plan name or a Stripe price — so renaming or re-pricing a plan never
touches your gate code. This is the entitlement layer that pairs with
\`sw.payments\` (which collects the money): a successful checkout sets the user's
plan automatically, and \`sw.billing\` turns that plan into yes/no answers.

(Looking for OUR pricing tiers — what somewhere.tech charges YOU? That's
\`docs({ topic: 'billing' })\`. This topic is about the plans YOUR app offers
ITS users.)

## 1. Define your plans (in code, once)

\`\`\`js
// in a deployed function — declarative, safe to run on every deploy
await sw.billing.definePlans([
  { slug: 'free', name: 'Free', features: [] },
  { slug: 'pro',  name: 'Pro', price_cents: 2000, interval: 'month',
    features: ['export', 'api_access', { feature: 'seats', limit: 10 }] },
]);
\`\`\`

- The list you pass becomes THE catalog (anything not listed is removed) —
  idempotent, so just keep it in your code and it converges.
- \`slug\` is what a user's plan is set to. \`features\` are free-form names you
  invent and gate on; a feature can carry an optional numeric \`limit\`.
- \`price_cents\`/\`interval\` are for display (your pricing page) — they don't
  charge anyone; \`sw.payments\` does the charging.
- View your live catalog read-only in the dashboard under a project's
  Auth → Plans tab. The dashboard never edits plans — your code is the source.

## 2. Gate a feature

Server side, in a function:

\`\`\`js
if (await sw.billing.has(user.id, 'export')) {
  // ...do the gated thing
}
const ent = await sw.billing.entitlements(user.id);
// ent = { plan: 'pro', plan_defined: true, features: ['export','api_access','seats'], limits: { seats: 10 } }
\`\`\`

Client side, with @somewhere-tech/sdk/react (the user's feature list rides their
session, so these are instant — no extra request):

\`\`\`tsx
import { useEntitlements, Gate } from '@somewhere-tech/sdk/react';

function ExportButton() {
  const { has } = useEntitlements();      // also: { entitlements, loading }
  return has('export') ? <Export/> : <Upsell/>;
}

// declarative — the feature-gating mirror of <Protect>
<Gate feature="export" fallback={<Upsell/>}><Export/></Gate>
\`\`\`

\`auth.billing.plans()\` returns the catalog for rendering a pricing page.

## 3. Drop-in pricing + manage UI (React)

A whole pricing page and a manage-subscription button, no custom code — both
ride the @somewhere-tech/sdk/auth session (no extra setup beyond the auth you
already mount):

\`\`\`tsx
import { PricingTable, BillingPortal } from '@somewhere-tech/sdk/react';

<PricingTable/>     // your catalog plans, current plan highlighted, Subscribe → checkout
<BillingPortal/>    // one-click "manage/cancel" via the Stripe portal
\`\`\`

Both are logic-only/unstyled — theme with the \`sw-*\` class hooks
(\`sw-pricing-table\`, \`sw-plan[data-current]\`, \`sw-plan-name/-price/-features/-cta\`,
\`sw-billing-portal\`). Prefer to wire it yourself? The same actions are on the
client: \`auth.billing.subscribe(planSlug)\` and \`auth.billing.openBillingPortal()\`
(both redirect to Stripe; success/cancel/return default to the current page).

Subscribe checks out for the SIGNED-IN user (resolved server-side from the
session, never a client-supplied id) and the worker resolves the plan's price
from your catalog's \`stripe_price_id\` — so a plan is purchasable once it's
\`active\` and carries a \`stripe_price_id\`. Set \`stripe_price_id\` on each paid
plan in \`definePlans()\`; a \`$0\`/no-price plan can't be checked out.

## 4. How a user gets a plan

You don't write webhook code. \`sw.payments.checkoutForUser(userId, { plan })\`
(what \`<PricingTable>\` calls under the hood) starts a Checkout Session; when
payment completes, the platform sets that user's plan, and \`sw.billing\`
immediately reflects it. Cancelling (via \`<BillingPortal>\`) clears it.
(\`docs({ topic: 'payments' })\` covers the checkout side.)

## Notes

- Fully additive. If you already branch on the raw plan name
  (\`user.plan === 'pro'\`), that keeps working — adopt \`has()\` when you want.
- \`sw.auth.me()\` / \`fromRequest()\` now include \`entitlements: string[]\` on the
  user, which is what the client checks read.
- REST (if you're not in a function): \`POST /v1/entitlements/plans\` (define,
  developer key), \`GET /v1/entitlements/plans\` (catalog), \`GET
  /v1/entitlements/me\`, \`GET /v1/entitlements/has?feature=…\`.

Related topics: \`payments\`, \`auth-client\`, \`sw.auth\`.
`,

  'billing': `# Plans & Pricing

(Building YOUR OWN app's plans + feature-gating for your users? That's a
different thing — see \`docs({ topic: 'sw.billing' })\`. This topic is what
somewhere.tech charges you.)

Pricing is DB-driven (the tier_plans table) and served live at
/v1/pricing — always fetch that for the current numbers rather than
hardcoding them. Every tier includes UNLIMITED projects, deploys, and
bandwidth (zero egress fees). Custom domains are free on every tier.

Payments: charges settle to your connected account, minus Stripe's standard
processing fee and a 0.5% platform fee (each checkout response includes
\`fee_percent\` so you can account for it). Managed AI uses the same all-in
catalog rates on every tier. Free includes $0.50 each month and paid plans
include $5 per billing period. Included/default calls never spend prepaid
balance automatically; explicit paid-model selection on Free uses prepaid
only, while eligible paid-plan calls use the allowance first and then prepaid.
Published request and model limits still apply. Inbox is metered per inbound
email (rate at /v1/pricing), never capped or time-expired.

## The tiers
Five tiers — Free, Builder, Pro, Scale, Enterprise. Fetch /v1/pricing for the
live prices and per-tier caps (files, database, email, realtime publishes,
upload size, uptime-check frequency). They differ along two axes:

- **Core platform plus plan capabilities.** Every tier includes functions,
  database, auth, outbound email, AI, payments, files, realtime, one-shot jobs,
  queues, builds, and deploys. Higher tiers raise caps; Builder and higher add
  customer cron and recurring smoke checks. See /v1/pricing for the current
  numbers and capability flags.
- **Service level.** Free shows a "Built on Somewhere" badge and uses its
  included AI allowance and request limits. Builder removes the badge and adds
  advisory debugging (copilot reads your deployed code + diagnoses bugs) plus a
  daily LLM security review. Pro adds office hours and a stronger review.
  Scale adds per-deploy
  review + priority support. Enterprise adds custom limits, contracts, SLA, and
  invoicing.

## The "unlimited" caveat
Advertised "unlimited" (e.g. database rows / auth users on higher tiers)
means a high SAFETY cap, never literally uncapped — to protect shared
infrastructure. Row/user counts are metered with warnings before any cap;
the platform never silently blacks out a live app at a limit.

## Check your plan / upgrade
Your plan is per-ACCOUNT (not per-project) — see it in Dashboard → Billing.
Upgrade there, or via payments_checkout with the tier's Stripe Price ID
from /v1/pricing.
`,

  'changes': `# Recent behaviour changes

Dated platform behaviour changes, newest first. One entry per change: what
changed, what it means for code you already deployed, and the topic that carries
the full contract. This log is the advance notice for anything that alters how
existing code behaves — read it before assuming a new failure is yours.

Each entry names a topic. That topic, not this line, is the current contract.

- **Outbound guard now refuses literal blocked targets (it used to observe
  only).** A request that reaches the platform's outbound guard with a
  non-public address or internal hostname, embedded \`user:password\`, a
  non-HTTP scheme, or a port other than 80, 443 or 1024 and above gets a 403
  with \`x-sw-outbound-error\` before it leaves. Requests to public hosts are
  unchanged, and the runtime's own checks still run first. Preview functions
  still cannot fetch at all (\`DRAFT_EGRESS_DENIED\`).
  \`docs({ topic: 'sw.fetch' })\`.
- **2026-09-02 — local dev now reaches your project's database and files on
  every plan.** Running \`somewhere dev\` on your own machine reads and writes
  the project's own database and files on Free and Builder as well as Pro and
  Scale. Nothing to enable, no setup step, and it is the same database and the
  same files the deployed app uses — a project with a published release behaves
  like one that has never been deployed, so local writes are production writes.
  This only grants: no plan loses anything, and deploying was never gated by it
  on any plan. \`LOCAL_DEV_DB_NOT_ENABLED\` still exists as a code but no
  current plan returns it. Preview (\`somewhere preview\`, private previews,
  promote, the dev/prod split and its separate database) is a different product
  and is unchanged on Pro and Scale. \`docs({ topic: 'local-dev' })\`.
- **2026-09-02 — whole numbers wider than a JSON number travel as strings, in
  both directions.** A whole number above \`9007199254740991\` written as a JSON
  number in a request body — \`db_query\` / \`db_batch\` parameters, a structured
  write's values, an \`api\` body — is rounded by JSON itself before the platform
  ever sees it, so the value stored differed from the value sent, with no error.
  Those requests are now refused before anything is written, with
  \`NUMBER_PRECISION_LOST\` naming the field, the digits you sent and the number
  that arrived. Send such a value as a string (\`"9223372036854775807"\`): that is
  the same exact form a read returns, so a value read out of the database writes
  straight back. \`sw.db.insert\` / \`sw.db.update\` accept that string on a
  declared \`integer\` column. A dump now emits such a value as a bare numeric
  literal, so a restore produces a whole number again. Nothing else changes —
  whole numbers up to \`9007199254740991\`, decimals, and any larger whole number
  a JSON number carries exactly all behave exactly as before.
  \`docs({ topic: 'sw.db' })\`.
- **2026-09-02 — structured writes return 64-bit whole numbers intact.**
  \`sw.db.insert\`, \`sw.db.update\` and \`sw.db.remove\` project their affected row
  through the same exact-decimal-string cast reads already use, so a write that
  touches a row holding a 64-bit id (a Snowflake id, an imported \`bigint\`)
  returns normally. Before this it applied the write and then reported
  \`DATABASE_VALUE_TOO_LARGE\`, which read as a failed write that had in fact
  succeeded. On a SQL-mode project raw \`sw.db.query\` is never rewritten, so
  cast the column yourself in your own \`RETURNING\` clause.
  \`docs({ topic: 'sw.db' })\`.
- **2026-09-02 — cron has a plan minimum fire interval.** Creating or editing a
  schedule tighter than the plan allows is refused with
  \`CRON_SCHEDULE_TOO_FREQUENT\`; existing schedules are not re-checked and keep
  running unchanged. Read the plan's interval from \`cron_list({ project_id })\`.
  \`docs({ topic: 'cron' })\`.
- **2026-09-01 — empty AI completions say whose problem they are.**
  \`/v1/ai/complete\` still answers \`MODEL_EMPTY_RESPONSE\` when a model produces
  no text, but the status now splits the class: HTTP 422 \`retry: false\` when the
  request is yours to fix, with the cause, stop reason, and token counts in
  \`data\`; HTTP 502 \`retry: true\` only on a genuine provider failure worth
  retrying. It used to be 502 both ways, so callers branching on 5xx retried a
  deterministic budget problem — 5xx is theirs, 4xx is yours.
  \`BUILDER_MODEL_OUTPUT_TRUNCATED\` moved 502→422 for the same reason; matching
  on the error code is unchanged. \`docs({ topic: 'sw.ai' })\`.
- **2026-09-01 — the project database and files in \`somewhere dev\` are one plan
  entitlement.** Pro and Scale include it; on Free or Builder a local \`sw.db\` or
  \`sw.fs\` call returns \`LOCAL_DEV_DB_NOT_ENABLED\` naming the plan, and
  redeploying does not change it. Deploying is unaffected on every plan, so a
  local refusal is never a fault in the project's code. Read it before planning
  a local-first workflow: \`limits.local_dev_db_allowed\` on \`GET /v1/pricing\`, or
  \`local_dev_db_allowed\` on \`project_get\`. \`docs({ topic: 'local-dev' })\`.

## Where the rest of the history lives

This log carries behaviour changes, not the release feed. Per-project deploy
history is \`project_deploys\`; what a specific deploy changed is
\`project_diff_versions\`. If a documented contract looks wrong, file it with
\`support_ticket({ message })\`.

Related: \`troubleshooting\`, \`guarantees\`, \`feedback\`.
`,

  'feedback': `# Platform Feedback — Bug? Doc gap? Tell us.

If the platform itself blocks you — an MCP tool doesn't behave like its
description, an endpoint returns a surprising shape, the docs contradict
the live behavior, a feature is missing — file a ticket. You don't have
to be a senior debugger to file one; "I tried X, expected Y, got Z" is
already useful.

## Submit

\`\`\`ts
const t = await support_ticket({
  message: "PUT /v1/fs binary upload returns 200 but reads back UTF-8-replaced. Repro: curl --data-binary @cat.jpg ...",
  project_id: "my-app",                 // optional
  context: { endpoint: "PUT /v1/fs", file_size: 82823 },  // optional
});
// → { ticket_id: "pfb_a1b2c3d4e5f6", status: "open", created_at: 1715000000000 }
\`\`\`

Our team is alerted immediately with your message and ticket
id. They reply on the ticket — and **when they do, you get an email**
at the address on your account. No polling required.

## Read back

Use these if you want to check before the email lands:

- \`support_ticket({ ticket_id })\` — one ticket, full
  detail including the response.
- \`support_ticket({ status?, limit? })\` — every ticket
  you've filed (most recent first), with status and response inline
  (omit \`message\` and \`ticket_id\` to list).

## Shape returned by status / list

\`\`\`json
{
  "ticket_id": "pfb_a1b2c3d4e5f6",
  "status": "open" | "investigating" | "resolved",
  "message": "your original report",
  "response": "the team's reply (null until they answer)",
  "responder": "support@somewhere.tech",
  "created_at": 1715000000000,
  "resolved_at": null | 1715000000000
}
\`\`\`

## What "good" looks like

A useful ticket gives the platform team three things in 4–5 lines:

1. **What you tried** — exact endpoint or MCP tool + the args.
2. **What you expected** — based on what doc or precedent.
3. **What happened** — the raw response or error code, not a paraphrase.

Bad ticket: "files don't work, please fix". Good ticket: "POST /v1/fs
with content-type application/octet-stream and binary body returns 200,
but the readback replaces every byte ≥0x80 with EF BF BD. AGENT.md says
binary is supported."

## When to use which

- **Stuck on architecture** → \`advisor({ question })\`.
- **The platform itself is broken or unclear** → \`support_ticket\`.
- **You think the docs are wrong** → \`support_ticket\`. The docs
  are derived from this file (\`platform-help\`) and \`AGENT.md\`. If
  it's wrong here, it's wrong everywhere.

## What the team does with it

Open tickets surface in our team's dashboard, get triaged, and
either get a fix shipped (which closes the ticket with a deployed-in
note) or a workaround written into the response. The bug gets logged
and the next agent that hits it sees the fix in the docs, not the same
dead end.
`,

  'calendar': `# Calendar — atomic holds and reservations

\`sw.calendar\` is the built-in reservation primitive for booking apps. It
atomically holds one resource + time range, treats active holds and pending
payments as conflicts, and gives you a hold token that can be passed into
Checkout. Use it instead of a SELECT-then-INSERT booking table when a
double-booking would cost money or trust.

## Runtime methods

- \`sw.calendar.hold(resource, range, ttl?)\`
- \`sw.calendar.hold({ resource, range, ttl?, ttl_seconds?, ttl_ms?, metadata? })\`
- \`sw.calendar.blackout(resource, range, options?)\`
- \`sw.calendar.removeBlackout(reservationId, options?)\`
- \`sw.calendar.cancel(reservationId, options?)\`
- \`sw.calendar.rebook(reservationId, newRange)\`
- \`sw.calendar.setPolicy(resource, policy)\`
- \`sw.calendar.getPolicy(resource)\`
- \`sw.calendar.availability(resource, range)\`
- \`sw.calendar.availability({ resource, range })\`
- \`sw.calendar.list(resource, { range?, statuses?, limit?, cursor? })\`
- \`sw.calendar.list({ resource, range?, statuses?, limit?, cursor? })\`
- \`sw.calendar.get(reservationId)\`
- \`sw.calendar.pending(token, { payment_reference? })\`
- \`sw.calendar.confirm(token, { payment_reference? })\`
- \`sw.calendar.release(token, { payment_reference?, release_reason? })\`
- \`sw.calendar.expire({ resource? })\`

REST equivalents are \`POST /v1/calendar/hold\`, \`/blackout\`,
\`/blackout/remove\`, \`/cancel\`, \`/rebook\`, \`/policy/set\`,
\`/policy/get\`, \`/availability\`, \`/list\`, \`/get\`, \`/pending\`,
\`/confirm\`, \`/release\`, and \`/expire\`. The REST
body includes \`project_id\`; the runtime helper injects it for you.

## Resource policies, blocks, cancellations, and rebooking

\`setPolicy\` declares optional \`min_stay_nights\`, \`max_stay_nights\`,
\`advance_notice_hours\`, \`bookable_from_ms\`, and \`turnaround_hours\` for
one resource; pass \`null\` for a field to clear it. Holds and rebooks enforce
the policy with stable 409 codes: \`CALENDAR_MIN_STAY\`,
\`CALENDAR_MAX_STAY\`, \`CALENDAR_ADVANCE_NOTICE\`, and
\`CALENDAR_BUFFER_CONFLICT\`.

Use \`blackout\` / \`removeBlackout\` for operator-owned unavailable ranges,
\`cancel\` for a confirmed reservation, and \`rebook\` to move a confirmed
reservation atomically. Each operation is project-scoped and returns the
updated reservation or the stable conflict/not-found code named in its error.

## Hold input

\`\`\`js
const hold = await sw.calendar.hold({
  resource: 'room:queen-204',
  range: {
    start: '2026-08-01T15:00:00-07:00',
    end:   '2026-08-03T11:00:00-07:00',
    timezone: 'America/Los_Angeles',
  },
  ttl_seconds: 40 * 60,
  metadata: { party_size: 2 },
});
\`\`\`

\`range.start\` and \`range.end\` accept epoch milliseconds or ISO timestamps
with an explicit \`Z\` / offset. \`range.timezone\` must be a valid IANA
timezone. Ranges are half-open: \`[start, end)\`. Adjacent reservations are
allowed; overlapping reservations conflict. The conflict set is active
\`hold\`, \`pending_payment\`, and \`confirmed\`; expired/released rows do not
block new holds. Default TTL is 35 minutes, minimum is 1 second, maximum is
24 hours.

## Hold response

\`\`\`js
{
  token: 'calh_...',        // same value as hold_token
  hold_token: 'calh_...',
  expires_at: 1785625200000,
  reservation: {
    id: 'cal_...',
    project_id: '...',
    resource: 'room:queen-204',
    start_ms: 1785612000000,
    end_ms: 1785765600000,
    timezone: 'America/Los_Angeles',
    status: 'hold',
    hold_token_prefix: 'calh_...',
    metadata: { party_size: 2 },
    payment_reference: null,
    expires_at: 1785625200000,
    confirmed_at: null,
    released_at: null,
    release_reason: null,
    created_at: 1785622800000,
    updated_at: 1785622800000,
  }
}
\`\`\`

Store the token server-side or return it to the browser only long enough to
start checkout. Later operations require the token and the same project.

## Availability and booking reads

Use the calendar read side to render availability; you do not need a shadow
table of holds. Availability returns active \`hold\` / \`pending_payment\` /
\`confirmed\` conflicts clipped to the requested range, plus the maximal free
ranges between them. Expired holds are ignored even before an explicit
\`expire()\` sweep.

\`\`\`js
const availability = await sw.calendar.availability({
  resource: 'room:queen-204',
  range: {
    start: '2026-08-01T00:00:00-07:00',
    end: '2026-08-08T00:00:00-07:00',
  },
});
// -> { resource, range: { start_ms, end_ms },
//      busy: [{ reservation_id, kind: 'hold'|'booking', status,
//               start_ms, end_ms, expires_at }],
//      free: [{ start_ms, end_ms }] }

const page = await sw.calendar.list('room:queen-204', {
  range: { start: Date.now(), end: Date.now() + 30 * 86400000 },
  limit: 100,
});
// -> { reservations: [...], next_cursor: string|null }
// Pass next_cursor back as cursor. By default list returns active holds and
// confirmed bookings. Pass statuses: ['released', 'expired'] for audit rows.

const { reservation } = await sw.calendar.get(page.reservations[0].id);
\`\`\`

\`range.start\` / \`range.end\` use the same epoch-millisecond or explicit-
offset ISO format as holds. \`list\` requires a resource, accepts an optional
overlap range, defaults to 100 rows, and caps \`limit\` at 500. \`get\` is
project-scoped and returns \`CALENDAR_RESERVATION_NOT_FOUND\` for a missing or
cross-project id.

## Hold → checkout → confirm

\`\`\`js
const hold = await sw.calendar.hold({
  resource: body.resourceId,
  range: body.range,
  ttl_seconds: 45 * 60,
});

const checkout = await sw.payments.checkout({
  env: 'prod',
  mode: 'payment',
  calendar_hold_token: hold.hold_token,
  line_items: [{ amount: 2500, currency: 'usd', name: 'Reservation deposit' }],
  success_url: 'https://my-app.somewhere.site/booked',
  cancel_url: 'https://my-app.somewhere.site/book',
});
\`\`\`

Checkout marks the hold \`pending_payment\`, sets the Stripe Checkout expiry to
the hold expiry, and records a payment reference. The hold must have at least
31 minutes remaining when checkout starts; otherwise the platform returns
\`CALENDAR_HOLD_TTL_TOO_SHORT\` and releases the hold. On
\`checkout.session.completed\`, the platform confirms the hold. On checkout
expiry or failed/canceled payment, it releases the hold. A single checkout may
use \`calendar_hold_token\`, \`quote_id\`, or both. When both are supplied the
stored quote prices the Checkout session and the calendar hold reserves the
dates; both records are bound to the same session in one atomic database batch.
Completion confirms the hold before completing the quote booking, and a lost
slot leaves the quote unfulfilled for recovery instead of double-fulfilling.

Manual confirmation is also available:

\`\`\`js
await sw.calendar.pending(hold.hold_token, { payment_reference: 'order_123' });
await sw.calendar.confirm(hold.hold_token, { payment_reference: 'order_123' });
await sw.calendar.release(hold.hold_token, { release_reason: 'customer_canceled' });
await sw.calendar.expire({ resource: 'room:queen-204' }); // optional resource filter
\`\`\`

\`confirm\` is idempotent once confirmed with the same payment reference.
If a paid checkout arrives after the original hold expired and another hold
has taken the slot, the reservation is marked
\`payment_received_slot_lost\` and the webhook payload surfaces the problem
for refund/manual recovery.
`,

  'payments': `# Payments — Stripe Connect

The platform wires Stripe Connect for you. You get \`payments_*\` MCP
tools and \`sw.payments\` inside deployed functions. End-customers pay
through a Stripe Checkout Session and money settles to the developer's
connected account, minus Stripe's standard processing fee and a 0.5%
platform fee — each checkout response includes \`fee_percent\` so you can account for it.

## You DO NOT need to onboard to start building

Test-mode checkouts work immediately. Call payments_checkout (or
sw.payments.checkout) with env="dev" — when the developer hasn't
onboarded yet, the session runs directly on the platform's own Stripe
test account (no Connect destination, no application fee), so card
4242 4242 4242 4242 succeeds end-to-end. The response includes
\`is_stand_in: true\` and \`platform_fee_cents: 0\` so callers know
the fee won't apply on those sessions. Useful for dev demos,
integration tests, or showing the user the flow before they decide
to wire real bank info. Once the developer calls payments_onboard,
dev-mode checkouts switch to running against their own test
connected account (still no live charges; same 4242 card).

\`\`\`json
// MCP — agent calling the platform
payments_checkout({
  project_id: "my-store",
  env: "dev",
  mode: "payment",
  line_items: '[{"amount": 4900, "currency": "usd", "name": "Premium plan"}]',
  success_url: "https://my-store.somewhere.site/done",
  cancel_url:  "https://my-store.somewhere.site/cart"
})
\`\`\`

\`\`\`js
// Inside a deployed function — env is auto-detected from PROJECT_ENV.
// Use env="prod" for live charges (default once payments_onboard is done).
export default async function(req, sw) {
  const user = await sw.auth.fromRequest(req);
  if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 });

  const { url } = await sw.payments.checkoutForUser(user.id, {
    plan: 'premium',
    mode: 'payment',
    line_items: [{ amount: 4900, currency: 'usd', name: 'Premium plan' }],
    success_url: 'https://my-store.somewhere.site/done',
    cancel_url:  'https://my-store.somewhere.site/cart'
  })
  return Response.redirect(url, 303)
}
\`\`\`

For app-user entitlements, prefer checkoutForUser. The platform creates
a checkout-intent row and sends only that intent id through Stripe
metadata; webhooks derive app_user_id and plan from the platform
database. Do not pass browser-controlled metadata.app_user_id or
metadata.plan through a public handler.

## Quote-backed checkout

Use \`sw.payments.quote\` when the customer is buying a computed basket
(hotel nights, service fees, local/Stripe tax, promo discounts, deposit)
and checkout must use that immutable server-side snapshot instead of fresh
browser-supplied amounts.

\`\`\`js
const quote = await sw.payments.quote(
  {
    id: 'cabin-7',
    name: 'Cabin 7',
    currency: 'usd',
    baseRate: { amount: 18000, unit: 'night' },
    fees: [
      { name: 'Cleaning fee', amount: 4500, kind: 'flat', taxable: true },
      { name: 'Guest fee', amount: 2000, kind: 'per_guest_per_night' },
    ],
    discounts: [{ code: 'WEEKLONG', percent: 10, min_nights: 7 }],
    tax: { rate_bps: 875 },
    deposit: { percent_bps: 2500, capture_method: 'manual' },
  },
  { start: '2026-08-01', end: '2026-08-04' },
  {
    guests: 2,
    promo: 'WEEKLONG',
    booking: {
      id: 'booking_123',              // optional; generated if omitted
      app_user_id: user.id,           // optional; must belong to this project
      external_id: 'PMS-42',
      metadata: { room: 'cabin-7' },
    },
  },
);
\`\`\`

\`resource.currency\` is a 3-letter ISO code. \`range\` is date-only:
\`{ start, end }\`, \`{ from, to }\`, or \`['YYYY-MM-DD', 'YYYY-MM-DD']\`.
It must span 1 to 366 nights. Amounts are integer cents. Fee \`kind\` can
be \`flat\`, \`per_night\`, \`per_guest\`, or \`per_guest_per_night\`.
Discounts accept \`amount\`, \`percent\`, or \`percent_bps\`, plus optional
\`min_nights\` / \`min_guests\` and promo codes. \`tax.rate_bps\` computes
local tax; \`tax.stripe: true\` requires \`opts.tax.customer_details\` and
stores Stripe Tax's calculation id/breakdown on the quote.

The response is a 30-minute immutable quote snapshot:

\`\`\`js
{
  quote_id: 'pqt_...',
  booking_id: 'booking_123',
  expires_at: '2026-08-01T12:30:00.000Z',
  resource: { id: 'cabin-7', name: 'Cabin 7' },
  range: { start: '2026-08-01', end: '2026-08-04', nights: 3 },
  guests: 2,
  promo: 'WEEKLONG',
  currency: 'usd',
  subtotal: 70500,
  taxes: { amount: 6169, source: 'local', calculation_id: null, breakdown: undefined },
  deposit: { amount: 19167, capture_method: 'manual' },
  total: 95836,
  lineItems: [
    { id: 'base_18000', kind: 'base', name: 'Cabin 7 nightly rate', amount: 54000, currency: 'usd', quantity: 1, taxable: true, source: 'base_rate' },
    { id: 'fee_1', kind: 'fee', name: 'Cleaning fee', amount: 4500, currency: 'usd', quantity: 1, taxable: true, source: 'flat' },
    { id: 'fee_2', kind: 'fee', name: 'Guest fee', amount: 12000, currency: 'usd', quantity: 1, taxable: true, source: 'per_guest_per_night' },
    { id: 'tax', kind: 'tax', name: 'Estimated tax', amount: 6169, currency: 'usd', quantity: 1, taxable: false, source: 'local' },
    { id: 'deposit', kind: 'deposit', name: 'Deposit hold', amount: 19167, currency: 'usd', quantity: 1, taxable: false, source: 'manual' },
  ],
  discounts: [], // 3 nights does not satisfy WEEKLONG's min_nights: 7
}
\`\`\`

Start checkout with the \`quote_id\`; do not pass \`line_items\` again.
The platform reloads the stored \`lineItems\`, verifies their total, and
atomically marks the quote used so two concurrent checkout calls cannot
create two Stripe sessions for one quote.

\`\`\`js
const checkout = await sw.payments.checkout({
  env: 'prod',
  quote_id: quote.quote_id,
  booking_id: quote.booking_id,
  calendar_hold_token: hold.hold_token, // optional: compose quoted price + date hold
  success_url: 'https://my-app.somewhere.site/paid',
  cancel_url: 'https://my-app.somewhere.site/quote',
  customer_email: user.email,
});
// -> { session_id, url, amount_total_cents, platform_fee_cents,
//      fee_percent, stripe_mode, is_stand_in, checkout_intent_id,
//      quote_id, booking_id, capture_method, payment_intent_id }
\`\`\`

Quote checkouts are one-time \`mode: 'payment'\` checkouts. They may include a
\`calendar_hold_token\`; existing quote-only and calendar-only checkouts keep
their prior behavior. For the combined flow, create the hold first and give it
at least 31 minutes of remaining TTL.

## Onboarding for live charges

Call payments_onboard when the developer is ready to take REAL money.
It's per-account (NOT per-project) — one onboard covers every project
the developer owns now or in the future. Returns a Stripe-hosted URL
for KYC + bank info.

\`\`\`json
payments_onboard({
  return_url:  "https://my-store.somewhere.site/payments/done",
  refresh_url: "https://my-store.somewhere.site/payments/retry"
})
\`\`\`

After the developer finishes onboarding, payments_status reports
charges_enabled=true and you can call payments_checkout({ env: "prod" }).

## Collaborators

Anyone with access to the project can run checkouts. Funds always go
to the project OWNER's connected account. If the owner has not
finished live onboarding and a collaborator calls
payments_checkout({ env: "prod" }), the platform returns 412 with code
OWNER_NOT_ONBOARDED and a message telling the caller the owner needs
to onboard first.

## What's NOT done for you

The user-facing pricing page, cart UI, and post-success receipts are
your code. Stripe Connect handles money + tax + payouts. You handle
"what does the customer click before they get to checkout".

## The moment payment succeeds — compose the built-ins

Do post-payment work from a trusted payment event/reconciliation handler,
not from the browser's success-page redirect. After the paid order or plan
state is durably recorded:

- Send the receipt or confirmation with \`sw.email.send(...)\` inside the
  handler, or \`email_send(...)\` from an agent/operator flow.
- Track \`checkout_completed\` with \`sw.analytics.track(...)\` or
  \`analytics_track(...)\`; track \`checkout_started\` when you create the
  session so the pair becomes a conversion funnel.
- Generate a downloadable invoice/receipt with \`sw.render.pdf(...)\` or
  \`render_pdf(...)\` and store it in the project's files when it will be
  reused.
- If generation or batch email needs retry/status, dispatch
  \`sw.jobs.create(...)\` / \`job_create(...)\`. If it is a no-result side
  effect, use \`sw.queue.push(...)\` / \`queue_send(...)\`.
- Update an open order screen by declaring the order read as a live view
  (\`sw.db.live(name, sw.db.from('orders', …))\`) — the write invalidates it
  and the browser re-reads. Notify a buyer whose tab is closed with
  \`sw.push.send({ payload, user_id })\`, once a subscription exists for
  them (registration is developer-side today — see the push topic).

Full setup and limits: \`docs({ topic: 'sw.email' })\`,
\`docs({ topic: 'analytics' })\`, \`docs({ topic: 'render' })\`,
\`docs({ topic: 'sw.jobs' })\`, \`docs({ topic: 'sw.queue' })\`,
\`docs({ topic: 'realtime' })\`, and \`docs({ topic: 'sw.push' })\`.

## Webhook events — what each flow actually emits

The platform's own Stripe webhook (/v1/payments/webhook) is the receiver
for every flow below; you never register it yourself.

- **Connect status** — keeps charges_enabled / payouts_enabled in sync.
  Emits nothing to your app.
- **\`checkoutForUser\` plan tracking** — on checkout.session.completed,
  invoice.payment_failed and customer.subscription.deleted it updates
  app_users.plan / plan_status (see "Automatic plan tracking" below).
  It updates the user row; it does not deliver a project webhook event.
- **Calendar quote checkout** — on checkout.session.completed for a
  quote, the project webhook receives \`payment.completed\` (see the
  calendar section below for its fields).
- **Ad-hoc Checkout you create yourself** (\`sw.payments.checkout\` without
  \`checkoutForUser\`) — emits NO project event today. The names
  \`payment_received\`, \`subscription_created\` and
  \`subscription_cancelled\` exist in the webhook event vocabulary but no
  code path fires them; do not subscribe to them expecting delivery.
  Whether the platform will bridge ad-hoc Checkout into a project event is
  an open product decision.

To react to charge.succeeded / payment_intent.succeeded inside YOUR app
for an ad-hoc Checkout, register a SECOND Stripe destination in the
developer's connected account and point it at one of your deployed
functions; verify its signature with Stripe's own scheme:

### Verifying a second Stripe destination in your function

Stripe's signed content is three parts concatenated, nothing else: the
timestamp from the header in unix SECONDS, then a literal dot, then the exact
raw request body bytes — \`\${t}.\${rawBody}\`. The \`stripe-signature\`
header carries \`t=<unix seconds>,v1=<hex>\` (possibly several \`v1\`), and
\`v1\` is HMAC-SHA256 of that exact string with the endpoint's signing secret.
Milliseconds, a re-serialized body, or the body alone all produce a different
MAC.
Verification requires the exact raw request bytes, a freshness check on
\`t\` (Stripe's SDK default tolerance is 300 seconds) and a constant-time
compare; the SDK's \`constructEventAsync\` does all of that, and the platform
verifies its own webhook the same way. When a signature fails, diagnose the
endpoint secret (test vs live, the secret of THIS endpoint), the environment,
whether the body was re-serialized, and header parsing — a
timestamp-dot-body scheme is not evidence that the payload is "not Stripe".
Do not look for \`X-Somewhere-Signature\` here; that header belongs to the
platform's own flows (drain: \`t=<ms>,v1=…\` over \`\${ms}.\${rawBody}\`;
subscriptions: bare hex over the raw body). This example verifies and stops;
it does not fulfil anything.

A verified signature proves Stripe sent the event; it does not prove YOUR
order is paid. The two files below are the shared, tested recipe
(\`checkout-fulfillment\`; the table name is its one parameter, shown as
\`payment_requests\`). The advisor renders the same bytes, and the platform's
fixtures run them against the real runtime and the real Stripe SDK. Use them
as they are; the checks they carry are the contract.

${RECIPE_CHECKOUT_FULFILLMENT}

What the recipe enforces, and why each line is there:

- **The table is declared \`serverOnly()\`.** A webhook has no signed-in
  user. Composed writes (\`sw.db.update\` / \`remove\`) have no server mode
  and take only \`{ set, where }\`, so on a table with \`scope: owner()\` the
  update is refused with \`AUTH_REQUIRED\` — and on a visitor-mode project it
  is silently scoped to an anonymous visitor instead, matches nothing, and the
  zero-change result reads as a duplicate: the order is never fulfilled and
  nothing errors. Declare the payment table server-only; for an existing app,
  merge it into your current \`db/schema.ts\` rather than replacing the file.
- **The stored order is the authority.** Session id, amount in minor units,
  lowercase currency, and \`livemode\` are recorded when the session is
  created and compared against both the event and the session. Mode is not a
  setting and not derived from a key prefix: the webhook is authenticated by
  its signing secret, and the order row says which mode it was created in.
- **Connect is a variant, not a check.** \`stripe_account_id\` is the
  connected account for Connect deliveries and \`null\` for a direct,
  account-specific endpoint, where \`event.account\` is absent. Its absence
  is not a failure.
- **Receipt and transition are ONE statement on the order row.** The
  composed \`sw.db.tx\` can commit several writes atomically, but a guarded
  update matching zero rows is a successful no-op: it does not abort sibling
  writes. A separate receipt insert therefore cannot use that update as its
  success condition. The
  guarded update binds id, session, status \`pending\` and every compared
  value; one returned row means this call fulfilled, none means re-read and
  classify: the same event already applied is a duplicate (200), anything
  else is unresolved (409). An events table written after the transition is
  fine as an audit log; it must never be the gate.
- **Limit:** side effects (email, PDF, stock) are outside the statement. A
  crash after the update and before the side effect is lost on retry, since
  the retry sees zero changes. Set a fulfilment marker in the same update and
  drain it from a scheduled job if that loss is unacceptable. On an unmanaged
  (SQL-mode) schema, \`sw.db.batch\` runs as one all-or-nothing batch.
- **Subscriptions** (\`mode: 'subscription'\`): treat
  \`checkout.session.completed\` as "subscription started" and take paid /
  unpaid state from \`invoice.paid\` / \`invoice.payment_failed\` for the
  subscription id, with the same single-row guard keyed on the invoice id.

## Automatic plan tracking on app_users

Want user.plan = "premium" to flip automatically when the customer
pays — and to flip back when they cancel — without writing a single
webhook handler? Use \`checkoutForUser\` from inside a deployed function.
The platform mints a signed intent row server-side and forwards only
its id through Stripe metadata, so a browser cannot spoof
\`app_user_id\` or \`plan\`:

  const user = await sw.auth.fromRequest(req);
  if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 });

  const { url } = await sw.payments.checkoutForUser(user.id, {
    plan: "premium",
    mode: "subscription",
    env: "prod",
    line_items: [{ price: "price_PREMIUM_MONTHLY", quantity: 1 }],
    success_url: "https://my-app.somewhere.site/billing/success",
    cancel_url:  "https://my-app.somewhere.site/billing/cancel",
    customer_email: user.email,
  });

The platform's own Stripe Connect webhook will:

  - on checkout.session.completed   → app_users.plan = "premium",
    plan_status = "active", and stamp stripe_customer_id +
    stripe_subscription_id.
  - on invoice.payment_failed       → plan_status = "past_due" (plan
    stays the same so you can show "your premium will lapse" copy).
  - on customer.subscription.deleted → plan_status = "canceled".

Read the current plan on the user object:

  const user = await sw.auth.fromRequest(req);
  if (user.plan_status !== "active") return Response.redirect("/billing");
  if (user.plan === "premium") { /* unlock the feature */ }

  // Or directly:
  const { user } = await sw.auth.me(token);
  console.log(user.plan, user.plan_status);
  // → "premium", "active"   (or "free", null when the user has never paid)

Note: plan is always returned (defaults to "free" for users who have
never checked out). plan_status is null for free users, and
"active" | "past_due" | "canceled" once they've subscribed.

## Manual-capture deposits

A quote resource can set \`deposit\` as a cents number or an object:

\`\`\`js
deposit: {
  amount: 5000,              // or percent / percent_bps
  capture_method: 'manual',  // default when deposit is present
}
\`\`\`

Manual deposits add a \`kind: 'deposit'\` line item and make quote checkout
create a manual-capture PaymentIntent. When Stripe reports
\`checkout.session.completed\`, the quote booking moves to \`authorized\`
instead of \`completed\`, and the project webhook receives
\`payment.completed\` with \`capture_method: 'manual'\`, \`status:
'authorized'\`, \`quote_id\`, \`booking_id\`, \`payment_intent_id\`, and the
quote/booking snapshots.

Capture or release the authorization exactly once from trusted server/operator
code using the REST endpoints. There are no dedicated \`sw.payments.capture\`
or MCP \`payments_capture\` helpers yet, so do not claim one exists.

\`\`\`http
POST /v1/payments/capture
Authorization: Bearer smt_...
Content-Type: application/json

{
  "project_id": "my-app",
  "booking_id": "booking_123",
  "amount": 5000,
  "env": "prod"
}
\`\`\`

\`booking_id\` or \`payment_intent_id\` is required. \`amount\` is optional;
when omitted, the platform captures the authorized deposit amount, not the
full quote total. If supplied, \`amount\` must be a positive integer cents
value and cannot exceed \`deposit_cents\`. The booking must be manual capture,
\`authorized\`, uncaptured, and unreleased. The response:

\`\`\`js
{
  booking_id: 'booking_123',
  quote_id: 'pqt_...',
  payment_intent_id: 'pi_...',
  status: 'succeeded',
  captured_cents: 5000,
  stripe_mode: 'live'
}
\`\`\`

Release cancels an uncaptured authorization:

\`\`\`http
POST /v1/payments/release
Authorization: Bearer smt_...
Content-Type: application/json

{
  "project_id": "my-app",
  "booking_id": "booking_123",
  "env": "prod"
}
\`\`\`

Response:

\`\`\`js
{
  booking_id: 'booking_123',
  quote_id: 'pqt_...',
  payment_intent_id: 'pi_...',
  status: 'canceled',
  stripe_mode: 'live'
}
\`\`\`

Both API paths and Stripe webhook replays use conditional state transitions:
\`authorized -> captured\` or \`authorized -> released\` only, with
\`captured_at IS NULL\` and \`released_at IS NULL\`. A replay, double-click,
capture-after-release, or release-after-capture returns/settles as a state
conflict instead of charging twice.

## Refunds, cancels, transactions, portal, events

Five more endpoints round out the payments surface so you don't need
to drop down to the Stripe SDK or build a custom dashboard.

### Refund a charge

\`\`\`js
// Inside a deployed function. Pass payment_intent_id from the
// checkout session (sw.payments.checkout returns it indirectly via
// the session object; you typically store it on your order row).
const refund = await sw.payments.refund({
  payment_intent_id: 'pi_3PqXYZ...',
  // amount: 1000,            // omit for full refund (in cents)
  // reason: 'requested_by_customer'
});
// → { refund_id, status, amount, currency, charge_id, ... }
\`\`\`

Stripe's processing fees are handled by Stripe's standard refund policy.

### Cancel a subscription

\`\`\`js
await sw.payments.cancelSubscription({ subscription_id: 'sub_...' });
// Default: cancel_at_period_end=true — customer keeps access until period end.

await sw.payments.cancelSubscription({ subscription_id: 'sub_...', immediately: true });
// Stops billing now and ends access.
\`\`\`

\`app_users.plan_status\` is updated automatically by the webhook on
\`customer.subscription.deleted\` — no extra wiring required.

### List recent transactions

\`\`\`js
const { transactions, next_cursor } = await sw.payments.transactions({ limit: 20 });
// → transactions: [{ id, amount, currency, status, paid, refunded,
//                    created, customer_id, payment_intent_id, ... }]
// Paginate with: sw.payments.transactions({ limit: 20, starting_after: next_cursor })
\`\`\`

### Open the Stripe Billing Portal for an end-customer

The portal lets customers update their card, switch plans, view
invoices, and cancel themselves — no support ticket required.

\`\`\`js
const user = await sw.auth.fromRequest(req);
if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 });

const { url } = await sw.payments.portalForUser(user.id, {
  return_url:  'https://my-app.somewhere.site/account/billing',
});
return Response.redirect(url, 303);
\`\`\`

\`portalForUser(user.id, ...)\` is the safe default for app-user billing:
the runtime sends \`app_user_id\`, and the platform resolves that user's
stored \`stripe_customer_id\` server-side before creating the portal
session. Never accept \`customer_id\` from a browser body, query string, or
other client-controlled input.

\`sw.payments.portal({ customer_id, ... })\` still exists for trusted
server/operator flows where your code already loaded the customer id from
your own database and checked that the caller may manage that customer. Do
not use it for "current signed-in user" account pages.

(Stripe auto-creates a default portal configuration on first use.
Advanced settings — what plans are switchable, custom branding —
need a one-time click in the connected account's Stripe dashboard.)

### Read the webhook event ledger

Every Stripe event the platform's webhook receives is persisted in a
ledger you can read back. The handler is idempotent — Stripe
redeliveries (which happen on transport failures) appear exactly
once. Use this to drive an in-product activity feed or to verify
delivery during integration.

\`\`\`js
const { events, next_cursor } = await sw.payments.events({
  limit: 50,
  // type: 'checkout.session.completed',   // optional filter
  // before: 1715000000000,                // ms-epoch cursor
});
// → events: [{ id, type, mode, account_id, project_id,
//              amount_cents, currency, livemode, received_at }]
\`\`\`

### One-time vs subscription

\`payments_checkout\` accepts \`mode: 'payment'\` (one-time charge)
or \`mode: 'subscription'\` (recurring billing). Same endpoint, same
automatic plan-tracking metadata. Default is
\`'payment'\`.

### Gating features after payment

Payments collect the money; \`sw.billing\` turns a paid plan into feature
yes/no answers. Pair them: \`checkoutForUser(userId, { plan: 'pro' })\` sets the
user's plan on success, then \`sw.billing.has(userId, 'export')\` (or \`<Gate
feature>\` client-side) gates on it — no webhook code. See \`docs({ topic:
'sw.billing' })\`.
`,

  'guarantees': `# What the platform guarantees — what your code can't get wrong

Every item below is something a developer building on the DIY stack
(Vercel + Supabase + Clerk + Stripe + Resend + …) has to get right
themselves, gets wrong, and ships to production not knowing they got
it wrong. The platform handles it.

Why this matters: these are exactly the bugs that are easy to write
and hard to catch by eye — the kind that can ship to production without
anyone noticing. The bounded security review can flag recognizable instances;
it does not prove every endpoint or arbitrary query safe.

---

## Security

### Auto-scoped database queries
- **Platform:** the structured builder \`sw.db.from/insert/update/remove\` auto-scopes a declared \`scoped\` table to the request's verified user — no user argument, no owner filter to forget. Ordinary raw SQL is refused in managed mode; an explicitly authorized \`sw.db.server.query\` read bypasses declared row permissions. The deploy scanner may flag recognizable risky shapes, but is not a proof of complete authorization.
- **DIY:** hand-write row-level-security policies in Postgres, attach them to every table, debug why your prod queries return zero rows when the policy is too strict.
- **What goes wrong:** the developer forgets the policy on one table. Every logged-in user can read every other user's data. Found in our own code on \`emails\`, \`drafts\`, and \`conversations\` before the auto-scope shipped.

### Private file enforcement
- **Platform:** \`/storage/*\` checks the \`visibility\` column before serving. Direct writes (sw.fs.write) and signed-URL uploads default to \`private\`; only project-deployed static assets default to \`public\`. No path-guess leak.
- **DIY:** write the S3 bucket policy, write a Lambda authorizer, debug why your CDN cached a private object publicly.
- **What goes wrong:** a dropped visibility filter is the classic failure mode — it can make every "private" upload publicly downloadable. The platform's \`/storage/*\` check + the deploy scanner (which blocks any deploy that bypasses the visibility column) guard against it.

### SSRF protection on outbound fetches
- **Platform:** every user-controlled URL fetch (webhooks, AI transcribe \`audio_url\`, render, scrape) goes through \`safeFetch\` — DNS resolves, blocks private + link-local + metadata IPs, validates redirects, enforces timeout + byte cap.
- **DIY:** know what SSRF is, know the AWS metadata IP, remember to check redirects after the first hop, set a timeout, set a byte cap. Do this for every endpoint that fetches a user URL.
- **What goes wrong:** user submits \`http://169.254.169.254/latest/meta-data\` as a webhook URL → your worker fetches it → cloud credentials leak.

### Per-project JWT signing keys
- **Platform:** every project derives its own JWT signing key via HKDF from a master secret + project ID. Compromising one project's tokens doesn't compromise another's.
- **DIY:** share one HS256 secret across every tenant in your auth provider.
- **What goes wrong:** an attacker who exfiltrates one customer's session token can forge tokens for any customer.

### Atomic token consumption
- **Platform:** password reset, magic link, refresh token, MFA challenge — all consume atomically via \`UPDATE … WHERE token = ? AND consumed_at IS NULL\`. A token that's already been used returns "invalid" the second time, even under concurrent requests.
- **DIY:** read the token row, check unused, mark used, write. Two parallel requests both see "unused", both proceed.
- **What goes wrong:** an attacker who intercepts a reset link can use it twice before the original user even loads the page. Atomic consumption closes this for every token type.

### Compile-time SSRF + resource limits
- **Platform:** the platform blocks imports from attacker-controlled URLs and enforces strict deploy-time resource limits (up to 1500 files, 5MB of source, 25MB per binary) automatically.
- **DIY:** trust that your build pipeline doesn't fetch attacker-controlled URLs during \`npm install\` / \`vite build\`.
- **What goes wrong:** a user deploys \`import "http://169.254.169.254/..."\` → your build worker fetches cloud metadata → leak.

### App-user lockdown
- **Platform:** routes use \`apiKeyAuth\` (developer \`smt_\` only) or \`eitherAuth\` (developer or app-user JWT). App-user JWTs can NEVER hit platform-admin endpoints (\`/v1/admin/*\`, project lifecycle, billing). The route-policy table is enforced at the worker layer, not in handlers.
- **DIY:** remember to add the middleware on every new route. Forget once = customer's logged-in user can delete the customer's other projects.
- **What goes wrong:** one forgotten middleware on a new route would let a logged-in app user reach endpoints they should never touch. The platform enforces this at the policy layer, so it can't be forgotten per-route.

### Deploy security review (LLM)
- **Platform:** \`security_review\` runs a strong AI model over every deployed function on-demand. Returns Markdown findings against 9 risk categories (auth bypass, raw SQL, env leakage, RCE, CSRF, …) with file + region + fix.
- **DIY:** read your own diffs and hope.
- **What goes wrong:** subtle auth-bypass patterns that are easy to miss in manual review are surfaced by on-demand review and by the paid tier's configured daily or promote cadence.

### Payment metadata validation
- **Platform:** \`sw.payments.checkout\` validates line items server-side against your project's price catalog. The caller can't pass arbitrary \`amount\` or \`currency\`. Return URLs are pinned to your project's domain — no open-redirect via the success URL.
- **DIY:** trust the client. Discover that someone bought your $99 product for $0.01 by passing \`amount_cents: 1\`.
- **What goes wrong:** client-trusted pricing is a classic under-charge exploit. Server-side price validation eliminates it.

---

## Reliability

### Platform-level CORS
- **Platform:** \`/api/*\` OPTIONS preflights return 204 with correct headers automatically. Every function response gets \`Access-Control-Allow-Origin\` + \`Credentials\` + standard allow-lists layered on.
- **DIY:** copy 10 lines of CORS boilerplate into every function file. Forget on one file = browser blocks every fetch from your frontend.
- **What goes wrong:** spend half a day debugging "why does my fetch work in curl but not in the browser" because you forgot the OPTIONS handler.

### Blank-page deploy gate
- **Platform:** after a live deploy, a headless browser captures a homepage screenshot. PNG below 10 KB triggers \`DEPLOY_BLANK_PAGE\` — alert fires, the deploy is flagged.
- **DIY:** nothing. You ship a build that compiles, looks fine in dev, blanks white in prod because of a missing env var. Customer reports it 6 hours later.
- **What goes wrong:** classic live-only error. Now caught within seconds of deploy.

### Deploy failure alerting
- **Platform:** every deploy / patch / blank-page / health failure is detected and alerted automatically with the project + version + cause.
- **DIY:** wire Sentry to your build pipeline, wire Sentry to your CDN, write the alert routing. Maintain it.
- **What goes wrong:** a customer's deploy silently fails; they don't notice for hours. You don't notice ever.

### Automatic health checks
- **Platform:** Builder and higher get recurring smoke tests at the plan cadence. Free keeps manual checks and deploy-triggered verification. Failures surface on the dashboard and follow the configured alert path.
- **DIY:** set up Pingdom / UptimeRobot per project. Configure alerts. Pay per probe.
- **What goes wrong:** you find out your prod site went down when a customer tweets at you.

### npm imports work in deployed functions
- **Platform:** a pure-JS dependency such as \`import { nanoid } from 'nanoid'\` resolves automatically at deploy from your \`package.json\`; ship a lockfile for exact versions. No build step, no bundle config. (\`zod\` currently fails at first load — see docs({ topic: 'functions' }) → npm packages.)
- **DIY:** maintain a webpack / esbuild config, decide what to bundle, manage versions.
- **What goes wrong:** spend hours debugging why your serverless function can't find \`lodash\` because the bundler tree-shook it.

### One live project
- **Platform:** source, data tools, \`somewhere deploy\`, and Browser use the same live project. Rollback restores the previous live version.
- **DIY:** coordinate multiple hosting targets, data stores, and publish scripts.
- **What goes wrong:** tools silently point at different targets and you debug or overwrite the wrong state.

### Version history + rollback
- **Platform:** every live deploy writes a \`deployments\` row; every screenshot, architecture, and description is per-version. \`project_rollback\` restores files + functions + DB-schema-state in one call.
- **DIY:** snapshot your storage yourself, or hope you can re-deploy from git.
- **What goes wrong:** you push a broken commit, can't reproduce the previous build locally, and your last working deploy is gone.

---

## Infrastructure

### Zero-config compilation
- **Platform:** ship \`.jsx\` / \`.tsx\` / \`.ts\` / \`.css\` directly. The platform compiles at deploy time — JSX/TSX, Tailwind, CSS modules, and path aliases all handled.
- **DIY:** maintain a build pipeline, a bundler config, a Tailwind config, and the CI that reinstalls from your lock.
- **What goes wrong:** spend the first 4 hours of every new project getting Vite to work with the right plugin set.

### One context for database + auth + email + payments + AI
- **Platform:** every function gets \`sw\` with \`sw.db\`, \`sw.auth\`, \`sw.email\`, \`sw.payments\`, \`sw.ai\`, \`sw.fs\`. One context, zero API keys to manage.
- **DIY:** Supabase client + Clerk SDK + Stripe SDK + Resend SDK + OpenAI SDK. Five API keys, five rotations, five rate-limit dashboards.
- **What goes wrong:** "when does it make sense for the company managing your auth to NOT send your forgot-password email?" (Clerk → Resend hand-off. Both companies wash their hands of failures at the boundary.)

### One bill, one usage view
- **Platform:** all your usage (AI, files, browser automation) rolls up into one bill and one usage view.
- **DIY:** five vendor bills, five cost dashboards.
- **What goes wrong:** "when does it make sense for the company managing your auth to NOT know if that user has paid?" (Stripe → Clerk webhook. If the webhook drops, the user's tier is wrong and you don't notice.)

### Custom domain provisioning
- **Platform:** \`domain_attach\` writes the DNS, requests the cert, attaches to the project. Renewal state machine recovers from any partial failure.
- **DIY:** a DNS provider's API + Let's Encrypt cert-manager + your host's domain-attach API. Three places things can fail, no single source of truth.
- **What goes wrong:** the cert expires because the renewal cron ran but the DNS validation step failed silently. Customer's site shows \`NET::ERR_CERT_DATE_INVALID\` for 3 weeks.

---

## Post-deploy intelligence

### LLM security review
- **Platform:** every deploy is one MCP call away from a structured 9-category security review of your server functions; on paid plans it also runs on promote and in a daily pass.
- **DIY:** Snyk / Semgrep + custom rules + nothing that knows your platform.
- **What goes wrong:** generic linters can't say "your sw.db.query bypasses row-level security" because they don't know what sw.db is.

### Live-site screenshots, per version
- **Platform:** desktop + mobile PNGs captured automatically post-deploy. Dashboard renders them as thumbnails on the version history.
- **DIY:** Puppeteer + a screenshot worker + S3 storage.
- **What goes wrong:** you can't see what a year-old deploy looked like.

### Architecture diagram, per version
- **Platform:** Sonnet writes a Mermaid flowchart from your source. Dashboard renders it. Agents pull it before \`project_patch\` so they know what exists.
- **DIY:** draw it in Figma, watch it go stale.
- **What goes wrong:** every architecture diagram of every project is wrong within two weeks.

### Plain-English app description
- **Platform:** Haiku writes a 2-3 sentence summary per version. "Restaurant booking app with AI chatbot. 89 users browse 24 restaurants and book tables."
- **DIY:** maintain a README. Forget to update it.
- **What goes wrong:** you have 30 projects and can't remember which one was "the recipe thing with the auth bug."

---

## How to read this list

Every line above is something the platform handles so you can't get
it wrong. That's the point. You ship code; we keep the failure modes
off your plate.

If you're building on the DIY stack today and reading this and
nodding — yes, you have all of these failure modes. We had them too.
Then we built the platform to stop having them.
`,

  'getting-started': `<!-- BEGIN CANONICAL AGENT WORKFLOW -->
## Getting started — use the whole workflow

1. Declare every table in \`db/schema.ts\`. Choose \`owner()\` (own rows), \`shared()\`
   (cross-user rows) or \`serverOnly()\`, plus a \`client\` block for browser
   columns (docs: declared-data).
2. Check TypeScript with \`somewhere typecheck\`.
3. Deploy raw source with \`somewhere deploy\`; do not build first. That deploy
   is your backend.
4. Optional: \`somewhere dev\` for frontend hot reload against it.
5. Verify the live flow with
   \`somewhere verify --url <live> --flow flow.json\`. One call runs the named
   steps, checks page/console/network health, and captures screenshots.
6. For sign-in checks, read the test inbox: \`somewhere email test-inbox <addr>\`.
7. Exercise a scheduled job now with \`somewhere cron run <id>\`.
8. Diagnose with \`somewhere errors\` (refusals vs exceptions); \`somewhere logs\`
   has the full detail.

### Two habits that keep the app fast and scoped

**Reads issued together travel together:** independent reads go in one
\`Promise.all\` — one round trip, not one each.

**\`owner()\` tables need no auth guard.** Structured queries already resolve the
request identity and scope rows; do not query auth first just to protect them.
Scope: project isolation and row ownership on the structured API. Raw SQL and
your own endpoints enforce their own caller policy; the platform cannot tell if
a custom admin endpoint checks its caller:

\`\`\`ts
export default async function (_req, sw) {
  const posts = await sw.db.from('posts', {
    order: ['created_at', 'desc'],
  });
  return Response.json({ posts: posts.data });
}
\`\`\`

Ordinary lookups: \`somewhere docs <topic>\` or
\`https://somewhere.tech/start.txt\`; uncertain architecture or composition:
\`somewhere advisor "<question>"\`. Without a shell: MCP \`docs({ topic })\`,
\`advisor({ question })\`; \`catalog\` finds tools.

No account yet? \`npx @somewhere-tech/cli deploy\` publishes a temporary app and
prints its live URL, claim URL, and expiry. On a hosted VM, after consent,
\`somewhere login\` prints a code a human approves in their browser; the machine
stays signed in.
<!-- END CANONICAL AGENT WORKFLOW -->

# Getting Started — Build an app in 10 minutes

For a new project, the path is create → \`somewhere dev\` → \`somewhere deploy\`
→ verify the live URL. The eight steps below fill in auth and data without
adding a preview step.

This is the fastest path. Read this once, then follow the eight steps
in order. **Don't** improvise — the sequence below is what works in a
demo.

**Want a worked example first?** [emailsomewhere.com](https://emailsomewhere.com)
is a complete email product built end-to-end on these same primitives —
15 API routes, 12 tables, AI inbox classification, realtime UI. No
internal helpers, no special access. Same APIs you'll have. Good
reference for "what does a real app actually look like here."

## Step 0 — Install the CLI and log in

\`\`\`bash
npm i -g @somewhere-tech/cli
somewhere auth login
\`\`\`

A browser window opens for human approval, then the session lands in
\`~/.somewhere/config.json\`. CLI, MCP bridge, and \`somewhere deploy\`
all read it. The flow is equivalent to \`gh auth login\`; no API key is
part of the human setup path. The \`smt_\` key remains available only
for CI/CD automation.

## Step 1 — Create the project

\`\`\`bash
mkdir my-app && cd my-app
somewhere init --name my-app
\`\`\`

\`somewhere init\` creates the project on the platform, claims the
subdomain, writes \`.somewhere.json\` so deploys know which project to
target, and wires Claude Code's MCP config in one shot. From the agent
side, MCP \`project_create\` does the same backend call if you'd rather
stay inside the chat.

## Step 2 — Wire Google auth (always do this first)

Two function files. That's it.

\`\`\`typescript
// api/auth/google.ts — sends the user to Google
export default async function (req, sw) {
  const url = sw.auth.googleUrl({ redirect_uri: \\\`https://\\\${sw.subdomain}.somewhere.site/api/auth/google-callback\\\` })
  return Response.redirect(url, 302)
}
\`\`\`

\`\`\`typescript
// api/auth/google-callback.ts — exchanges the code for a protected cookie session
export default async function (req, sw) {
  return sw.auth.googleCallbackWithCookie(req, '/')
}
\`\`\`

## Step 3 — Wire email auth

\`\`\`typescript
// api/auth/signup.ts
export default async function (req, sw) {
  const { email, password } = await req.json()
  const result = await sw.auth.signup({ email, password })
  return Response.json(result)
}

// api/auth/login.ts
export default async function (req, sw) {
  const { email, password } = await req.json()
  const result = await sw.auth.login({ email, password })
  return Response.json(result)
}

// api/auth/me.ts
export default async function (req, sw) {
  const user = await sw.auth.fromRequest(req)
  if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 })
  return Response.json(user)
}
\`\`\`

\`sw.auth.fromRequest(req)\` reads the cookie or Authorization header
and returns the validated user — or null. **Never** parse cookies
manually inside a function.

## Step 4 — Declare your database tables in db/schema.ts

Your data model is a file in the project, versioned and deployed with the
code, so the next session reads the schema instead of guessing it.
\`somewhere init\` already scaffolded \`db/schema.ts\` with one table in
it; add yours to the same file.

\`\`\`typescript
// db/schema.ts — a declaration the platform reads, never code that runs
import { id, owner, schema, table, text, timestamp } from 'somewhere/db';

export default schema({
  posts: table({
    id: id(),
    title: text(),
    body: text({ nullable: true }),
    created_at: timestamp({ default: 'now' }),
  }, {
    scope: owner(),        // per-user rows; the owner column is platform-managed
  }),
});
\`\`\`

A table stays invisible to the browser until its declaration carries a
\`client\` block. That block is the whole grant — \`read\` / \`create\` /
\`update\` name the columns, \`delete\` is a boolean, \`publicRead\` opens the
\`read\` columns to visitors who are not signed in, and \`identity\` is
\`'authenticated'\` or \`'visitor'\` (derived from the scope):

\`\`\`typescript
// in that same schema file — a public guestbook, signable without an account
entries: table({ id: id(), name: text() }, {
  scope: owner({ visitors: true }),
  client: { read: ['id', 'name'], publicRead: true, create: ['name'] },
}),
\`\`\`

The platform generates a typed client from that declaration, so the page
reaches its own data with no handler of its own:

\`\`\`typescript
// src/main.ts — the module that imports it must be .ts, .tsx or .jsx
import { data } from 'somewhere:data';

const page = await data.entries.list({ limit: 50 });
await data.entries.create({ name: 'Ada' });
\`\`\`

Only the operations you granted exist on that client; an ungranted one is
refused with \`DATA_ACCESS_DENIED\`, on direct HTTP to the data endpoint just
the same. Step 5 is for the rules a grant cannot express. Full rules:
\`docs({ topic: 'declared-data' })\`.

Every live deploy compares the file with the real database and creates what
is missing. \`somewhere dev\` does not, so apply it once up front:

\`\`\`bash
npx @somewhere-tech/cli db apply-schema
\`\`\`

Additions apply on their own; anything that would drop data is refused
(\`SCHEMA_DEPLOY_REFUSED\`) until the file says so explicitly, and
re-applying an unchanged file does nothing.

**Deploying a schema file latches the project into managed mode, one way.**
From that deploy on, ordinary \`sw.db.query\` / \`sw.db.batch\` are refused
with \`MANAGED_RAW_SQL_REQUIRES_SERVER_AUTHORITY\`. Use declared structured
operations normally. For a deliberate raw read, authorize the caller and use
\`sw.db.server.query\` / \`sw.db.server.batch\`; declared row permissions do
not apply to those calls, and managed raw writes remain refused. Developer-side
raw SQL is untouched: \`db_query\`, \`db_migrate\`, the CLI and the dashboard
keep full raw SQL against the same database.

Want a hand-written schema instead — because your functions need raw SQL
writes, or the shape is beyond what the file expresses? Then don't ship a
\`db/schema.ts\` on that project at all: deploying that file, and only that,
is what flips the project into managed mode. Migrate developer-side instead,
once, up front:

\`\`\`typescript
// developer-side — db_migrate MCP tool (NOT inside a function):
db_migrate({ project_id, sql: \`
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    created_at INTEGER DEFAULT (unixepoch())
  );
\` })
\`\`\`

Every production-targeted \`db_migrate\` takes an automatic named restore point
before your SQL runs, though restoring in place is not available, so the point is a marker rather than an undo (whole-database rewind). The
platform does not analyze raw migration SQL — it runs exactly as written.
Declare each table's access intent afterwards with \`db_scope_set\`.
Either way DDL is developer-side: \`sw.db.migrate\` was removed from the
function runtime (2026-05-21) and a CREATE TABLE inside a handler throws
\`DDL_NOT_ALLOWED_IN_FUNCTION\`.

## Step 5 — Build your product logic

Anything a client grant cannot express — an admin view, a moderated feed, any
rule that must judge its caller — is a function. API functions live in
\`api/\`, and each file is a route. Use \`sw.db\`, \`sw.ai\`, \`sw.fs\`,
\`sw.email\` — not \`fetch('https://api.somewhere.tech/...')\`.

\`\`\`typescript
// api/posts.ts
export default async function (req, sw) {
  const user = await sw.auth.fromRequest(req)
  if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 })

  if (req.method === 'GET') {
    const { data } = await sw.db.from('posts', { order: ['created_at', 'desc'] })
    return Response.json(data)
  }
  if (req.method === 'POST') {
    const { title, body } = await req.json()
    await sw.db.insert('posts', { title, body })
    return Response.json({ ok: true })
  }
}
\`\`\`

\`posts\` is an \`owner()\` table, so the platform confines both calls to
the signed-in user server-side — no \`user_id\` column of your own, and no
WHERE clause that a bug can drop.

## While building — reach for the primitive at the moment it appears

The platform already has the common product edges. Use the inside-function
\`sw.*\` method in deployed code; use the matching MCP tool from an agent or
operator workflow.

- You add users, checkout, publishing, or any other product action → track it
  with \`sw.analytics.track\` / \`analytics_track\`. See
  \`docs({ topic: 'analytics' })\`.
- A user needs a welcome, receipt, status, or alert email →
  \`sw.email.send\` / \`email_send\`. See \`docs({ topic: 'sw.email' })\`.
- A live page should change without polling → declare the read as a live
  view with \`sw.db.live(name, sw.db.from(...))\` and subscribe with
  \`watchLive\`. Realtime channels are developer-authority only and
  \`sw.realtime.*\` is not available in a function. See
  \`docs({ topic: 'realtime' })\`.
- An alert must arrive after the tab closes → \`sw.push.send({ payload,
  user_id })\` / \`push_send\`, against subscriptions registered with
  \`push_subscribe\` (developer authority; \`sw.push.subscribe\` is not
  available in a function). See \`docs({ topic: 'sw.push' })\`.
- Work will outlive the request or needs retries/status → \`sw.jobs.create\` /
  \`job_create\`. A side effect needs no result → \`sw.queue.push\` /
  \`queue_send\`. See \`docs({ topic: 'sw.jobs' })\` and
  \`docs({ topic: 'sw.queue' })\`.
- FAQs, products, or docs need meaning-based search → create the index once
  with \`search_index_create\`, then call \`sw.search.upsert\` /
  \`search_upsert\` whenever content changes. Use \`ai_embed\` only for custom
  vector math. See \`docs({ topic: 'search' })\` and
  \`docs({ topic: 'sw.ai' })\`.
- The app accepts audio or needs generated visual assets →
  \`sw.ai.transcribe\` / \`ai_transcribe\`, or \`sw.ai.generateImage\` /
  \`ai_generate_image\`. See \`docs({ topic: 'sw.ai' })\`.
- A user needs an invoice, ticket, certificate, or report download →
  \`sw.render.pdf\` / \`render_pdf\`. See \`docs({ topic: 'render' })\`.
- Before changing a settled architecture/product decision, call \`recall\`.
  When the decision or operating rule changes, call \`record\` at close-out.
  See \`docs({ topic: 'tasks' })\`.
- Before deploy, run \`project_check\` on the source you edited. See
  \`docs({ topic: 'deploy' })\`.

## Step 6 — Build the frontend

Plain \`index.html\` (or React, or whatever) that calls your \`api/*\`
endpoints with \`fetch\`. The cookie set in Step 2 is sent automatically
on same-origin requests.

## Step 7 — Run locally

\`\`\`bash
somewhere dev
\`\`\`

Open the localhost URL and exercise the app while you build. This loop uses the
real project's database and files, so local writes are production writes.

## Step 8 — Deploy and verify live

\`\`\`bash
somewhere deploy
somewhere browser <live-url>
\`\`\`

The CLI uploads your raw source and the platform compiles it. The live URL
prints when the deploy is ready. Every deploy goes live the moment it finishes.

**When you have real users or data:** use \`somewhere preview\` for a rotating
private URL and isolated database, then promote the exact preview you reviewed.
Preview protects an established app; it is not an extra first-run step.

## Have a frontend already? Install the SDK first

If you're wiring up a frontend (or porting an existing app), the client SDK
is the fastest path — two lines and you're running queries:

\`\`\`bash
npm i @somewhere-tech/sdk
\`\`\`

\`\`\`js
import { createClient } from '@somewhere-tech/sdk'
const client = createClient('https://<project>.somewhere.site', SOMEWHERE_KEY)
const { data, error } = await client.from('todos').select('*').eq('user_id', id)
await client.auth.signInWithPassword({ email, password })
\`\`\`

Browser sign-in is cookie-mode by default — it needs the one-file auth
backend from docs({ topic: 'auth-client' }) mounted at /api/auth.
Full reference → docs({ topic: 'sdk' }). Other languages → docs({ topic: 'sdks' }).
Porting an app → docs({ topic: 'migration-supabase' }).

## DO NOT

- ❌ Build a \`messages\` or \`conversations\` table for chat history.
  Use \`conversation_id\` on \`sw.ai.chat\` — the platform persists +
  truncates for you.
- ❌ Write \`getCookie()\` or token parsing. Use \`sw.auth.fromRequest(req)\`.
- ❌ Write visitor-session management by hand. Declare \`owner({ visitors: true })\`
  on the table; the platform issues the visitor session and moves rows to the
  account on sign-in.
- ❌ Write retry / timeout / rate-limit loops around \`sw.*\` calls.
  The platform handles upstream retries already.
- ❌ Deploy via MCP \`project_deploy\` for a single-file edit. Use the
  CLI's \`somewhere deploy\` for full deploys, or MCP \`project_patch\`
  for a single-file patch.
- ❌ Call \`https://api.somewhere.tech/v1/...\` from inside a deployed
  function. \`sw.*\` is the same surface, faster, no API key juggling.
- ❌ Put environment variables for \`sw.*\` services (database, AI,
  email, etc). \`sw.*\` is already authenticated — env vars are for
  YOUR external services (Stripe, Twilio, etc).

## Default model recommendation

Start with \`await sw.ai.chat({ messages: [...] })\`: omit both provider
and model for free \`gpt-5.6-luna\`. The allowance is 10 requests/minute,
200/day per owner on every plan, with 8,192 estimated input and 1,024 output
tokens per call. There is no paid fallback. For larger requests or another
model, choose an explicit provider/model from \`ai_catalog\`.

## Available docs topics

Call docs({ topic: "<name>" }) for any of:

  Onboarding
    setup                 — slower step-by-step setup flow
    architecture-patterns — chat app, REST API + auth, file uploads, jobs
    common-mistakes       — real failure modes the platform has seen
    troubleshooting       — error message → fix lookup

  Inside-function references (sw.* services your code uses)
    sw.db, sw.fs, sw.ai, sw.email, sw.env, sw.jobs,
    sw.queue, sw.logs, sw.auth, sw.rateLimit, sw.push, sw.image

  Developer-side surfaces
    projects, deploy, domains, search, render, video,
    analytics, inbox, calls

  Platform features
    functions, realtime, cron, billing
`,

  'setup': `# Setup — Use the CLI, or connect MCP without a shell

Three minutes from zero to a deployed app. No API keys to copy.

## 1. Install the CLI

\`\`\`bash
npm i -g @somewhere-tech/cli
\`\`\`

The package is \`@somewhere-tech/cli\`. The binary is \`somewhere\`.

Requires Node 18+. The CLI works on macOS, Linux, and Windows (via WSL or PowerShell).

## 2. Log in (browser-based, no key paste)

\`\`\`bash
somewhere auth login
\`\`\`

The command prints an eight-character code and a somewhere.tech link, opens a
browser if the machine has one, and waits. A human approves that code in their
own browser; the session then lands in \`~/.somewhere/config.json\`. Same flow as
\`gh auth login\`. The code is good for five minutes.

Nothing has to open a browser on the machine running the command, so this is
also the login path on a hosted VM (ChatGPT Work, Claude Work), a remote
container, or any SSH session — the terminal and the browser can be different
devices. Signing an account in is the account owner's decision: confirm consent
before starting the flow, show the code and the link exactly as printed, and
leave the approval to the person in the browser. A code should only ever be
approved if it matches the one on that person's own terminal.

The session persists on that machine: every later command and shell reuses it. The access credential lasts 24 hours and the CLI renews it silently;
the renewal right lasts 30 days and resets each time it is used, so a machine
touched at least monthly stays signed in. A sign-out, or approving the same
device name again, ends the old session.

After this you can run \`somewhere deploy\`, \`somewhere logs\`, and
the MCP bridge — all read the same config file. Do **not** paste an
\`smt_\` key into a config file. The smt_ developer key still exists
for CI / server-to-server, but for a human setup flow always use
\`auth login\`.

## 3. Optionally connect MCP to Claude Code

The Somewhere CLI includes the MCP bridge. Register it with Claude Code:

\`\`\`bash
somewhere mcp install claude-code
# reload Claude Code
\`\`\`

After reload, the Somewhere MCP tools are available in context. The bridge uses
the CLI session, so you don't paste a key. This step is optional when the agent
has a shell — the CLI needs no MCP setup: routine work uses first-class CLI
commands, \`somewhere call <tool> '<json>'\` covers the full tool catalog, and
\`somewhere run <script>\` executes code against the live project. The bridge
shares the CLI login; a separately connected Claude.ai or ChatGPT uses its own
OAuth session. Connected clients without a shell use MCP directly, where
\`run_code\` is the same capability (the directory connector's runs cannot
generate AI media or move money; the CLI is unrestricted).

## 4. Deploy something

A real React + function example — the platform compiles the JSX and
the server-side TypeScript automatically at deploy time. No build
step.

\`\`\`bash
mkdir hello && cd hello
\`\`\`

\`index.html\` — entry point:

\`\`\`html
<!doctype html>
<html><head><title>hello</title></head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.tsx"></script>
</body></html>
\`\`\`

\`src/main.tsx\` — React app (raw TSX, deployed as-is):

\`\`\`tsx
import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';

function App() {
  const [msg, setMsg] = useState('loading...');
  useEffect(() => {
    fetch('/api/hello').then(r => r.json()).then(d => setMsg(d.message));
  }, []);
  return <h1>{msg}</h1>;
}

createRoot(document.getElementById('root')!).render(<App />);
\`\`\`

\`api/hello.ts\` — server function (raw TS, deployed as-is):

\`\`\`ts
export default async function(req, sw) {
  return Response.json({ message: 'hello from a function' });
}
\`\`\`

Now deploy:

\`\`\`bash
somewhere deploy
\`\`\`

The CLI uploads the source files. The platform's compiler bundles
\`src/main.tsx\` into a hashed JS chunk under \`/_compiled/\`, rewrites
\`index.html\` to load it, and compiles \`api/hello.ts\` into a function
the runtime can execute. The public URL serves that live deploy.

(For just-a-static-page, you can ship a single \`index.html\` with
plain HTML — the JSX/TSX compiler only runs on files that need it.)

## Common follow-up commands

\`\`\`bash
somewhere logs            # tail recent function logs
somewhere deploy          # redeploy current directory
somewhere mcp             # raw stdio MCP bridge (for hosts you wire by hand)
somewhere auth status     # show current login
\`\`\`

For everything else (custom domains, project rename, env vars, billing), run
\`somewhere call --list\` and invoke the matching platform tool, or use the
dashboard at https://somewhere.tech. Without a shell, use the matching MCP tool.

## Ephemeral environments (Claude Code Web, sandboxes, containers)

This is for a machine whose home directory does NOT survive (Claude Code Web, a
fresh CI container, a sandboxed runner). A hosted VM with a lasting home
directory does not need it — use \`somewhere login\` above, which stays signed in
across sessions.

Where the home directory is discarded, the browser-based \`somewhere auth login\`
won't survive the session — but the MCP connection already has an authenticated
session. Pair the CLI to that session in one step:

\`\`\`text
1. npm i -g @somewhere-tech/cli            # ~5 seconds
2. Call MCP tool auth_cli_pair             # returns { key, expires_at }
3. somewhere auth set <key from step 2>    # 24h-TTL token
4. somewhere whoami                         # confirm identity
5. somewhere deploy                         # ready to go
\`\`\`

\`auth_cli_pair\` mints a short-lived \`smt_\` key (kind='cli_pair', 24h
TTL) scoped to the same user as the MCP session. The agent writes the
token to the CLI config; the CLI works for the rest of the session.
The key auto-expires; revoke early with \`DELETE /v1/keys/<id>\` if you
need to.

Pure-MCP path (Claude.ai connector, no shell at all): skip the CLI entirely and
use the platform tools directly. With a shell, \`somewhere call\` invokes those
same tools without requiring an MCP client, while first-class commands handle
the routine workflows.
`,

  'common-mistakes': `# Common Mistakes — Things real users have hit

**STOP.** Before writing any code, check if the platform already
handles it. Eight rules cover most of the wasted-time tickets:

- ❌ Don't build a \`messages\` or \`conversations\` table for chat
  history → use \`conversation_id\` on \`sw.ai.chat()\`. The platform
  loads, persists, and truncates history for you.
- ❌ Don't write \`getCookie()\` / token-parsing helpers →
  \`sw.auth.fromRequest(req)\` reads cookie + Bearer header and returns
  the validated user (or null) in one call.
- ❌ Don't write visitor-session management → declare \`owner({ visitors: true })\`
  on the table; the platform issues the visitor session and moves rows to the
  account on sign-in.
- ❌ Don't hand-roll Stripe webhook handling — see the \`payments\` topic
  for the supported flow.
- ❌ Don't deploy a single-file change via MCP \`project_deploy\` — that
  replaces every file in the project. Use \`project_patch\` for a single
  file or the \`somewhere deploy\` CLI for a full deploy.
- ❌ Don't write retry / timeout / rate-limit loops around \`sw.*\` —
  the platform retries upstream calls already; nested retries make
  things worse.
- ❌ Don't call \`https://api.somewhere.tech/v1/...\` from inside a
  deployed function → use \`sw.*\` (same authenticated runtime surface,
  no developer-key or hand-built platform request).
- ❌ Don't set env vars for platform services (\`SOMEWHERE_API_KEY\`,
  database URLs, etc.) → \`sw.*\` is already authenticated. Env vars
  are for YOUR external services (e.g. a payment provider, an SMS API,
  your own AI key, etc).

The rest of this topic is the *long* list of failure modes from real
support tickets. Skim once.

## 1. Calling api.somewhere.tech from inside a deployed function

**Wrong:**
\`\`\`typescript
// inside a deployed function
const res = await fetch('https://api.somewhere.tech/v1/db/query', {
  headers: { Authorization: 'Bearer smt_...' },
  ...
})
\`\`\`

**Right:**
\`\`\`typescript
const res = await sw.db.query('SELECT * FROM users')
\`\`\`

Inside a deployed function you have direct bindings: \`sw.db\`, \`sw.fs\`,
\`sw.ai\`, \`sw.email\`, \`sw.auth\`, \`sw.env\`, \`sw.jobs\`,
\`sw.queue\`, \`sw.logs\`. Each one talks to the platform without a
network hop and without auth juggling. The REST surface
(\`api.somewhere.tech\`) is for code running OUTSIDE the platform — your
laptop, a third-party server, a webhook handler somewhere else.

## 2. Using project_deploy when you meant project_patch

\`project_deploy\` **replaces** every file in the project. If you pass
\`{ files: { "index.html": "..." } }\`, every other file is deleted.

For a single-file edit, use \`project_patch\` — one file per call.
Two modes: \`{ path, content }\` rewrites the file, or
\`{ path, find, replace }\` does a server-side substring swap (~200
bytes on the wire). The platform auto-routes the path to static or
function. For multi-file changes, call \`project_patch\` once per
file (the platform preserves everything you don't name).

## 3. Putting tokens or JWTs in URLs

Don't do this:
\`\`\`text
https://my-app.somewhere.site/dashboard?token=eyJhbGc...
\`\`\`

Tokens in query strings end up in:
- Browser history
- Server access logs
- HTTP referrer headers when the page links out
- Anyone watching over your shoulder

Use cookies (httpOnly, secure, sameSite) or the \`Authorization: Bearer\`
header. The auth flows the platform ships with already do this — only
break the pattern if you have a very specific reason.

## 4. Putting smt_ keys in browser-accessible code

The \`smt_\` developer key is admin. It can read every project, deploy
code, change env vars. If it leaks (committed to GitHub, embedded in
JavaScript bundle, dropped in browser localStorage) someone can take
over the account.

Use the smt_ key only:
- Server-side, in env vars
- In CI/CD secrets
- In your local terminal

For browser code, mint app-user JWTs through \`sw.auth.signup\` /
\`sw.auth.login\`. JWTs are scoped to one user, one project — leak
blast radius is one account.

## 5. Reasoning models with too-low max_tokens

Reasoning models (${WORKERS_AI_REASONING_MODELS_INLINE}) think first, then answer. The \`<thinking>\`
block consumes tokens. If \`max_tokens\` is too small, the model burns
its budget on reasoning and returns no answer at all —
\`MODEL_EMPTY_RESPONSE\` at HTTP 422, \`retry: false\`, with the stop
reason and token counts in \`data\`. Raise the budget; do not retry and
do not switch model.

**Wrong:** \`max_tokens: 500\` for a reasoning model.
**Right:** \`max_tokens: 4000\` minimum, \`8000+\` is safer.

For non-reasoning models (Claude, gpt, Llama-Scout) 500 is fine.

## 6. sw.fs.write camelCase vs snake_case

The \`sw.fs.write\` binding accepts both \`contentType\` (camelCase) and
\`content_type\` (snake_case) for the MIME type. Other fields are
camelCase only. Pick one style per project for consistency, but the
platform tolerates either on this option.

\`\`\`typescript
await sw.fs.write('/uploads/avatar.png', bytes, {
  contentType: 'image/png'  // or content_type — both work
})
\`\`\`

## 7. "My deploy didn't update the live site"

Every successful \`project_deploy\` and \`project_patch\` publishes one
immutable release and moves \`active_release_id\` to it.
\`https://{subdomain}.somewhere.site\` serves that exact release. If the
live site looks stale, it's
almost always one of:

- Browser or CDN cache. Hard-reload (Cmd-Shift-R), or check with
  \`curl -sI https://{subdomain}.somewhere.site\`.
- The deploy hit a different project than you think (wrong
  \`project_id\`).
- Function changes can take 2-4 seconds to propagate; static changes
  are ~1s.

## 8. Auth emails not arriving

The platform sends auth emails (signup confirmation, password reset)
from \`noreply@somewhere.tech\` by default. That domain is not on your
project — it's the platform's. Some email providers flag it as
suspicious because the sending domain doesn't match your app's domain.

Fix: add a verified sender domain in dashboard Settings. Once verified,
auth emails go out from \`noreply@yourdomain.com\` and deliverability
improves.

## 9. Forgetting to redeploy after rotating an env var

\`sw.env.MY_KEY\` reads the value baked into the running function
bundle. When you rotate an env var via the dashboard or
\`POST /v1/projects/:id/env\`, **the running function still sees the
old value until the next deploy**. Run \`project_deploy\` (or
\`project_patch\` with no changes — empty patch is allowed) to refresh.
`,

  'architecture-patterns': `# Architecture Patterns — How to wire common app shapes

Each pattern is a working sketch you can lift and adapt.

## Two ways to use the platform

There are two distinct entry points. Pick based on where your code runs.

**Outside the platform** (your laptop, CI, a different host):
- Auth: \`Authorization: Bearer smt_...\` developer key (or app-user JWT for end-user calls)
- Surface: REST at \`https://api.somewhere.tech/v1/*\` and MCP at \`https://mcp.somewhere.tech/mcp\`
- Use case: deploy scripts, admin tooling, agent calls, webhooks from third parties

**Inside a deployed function** (code running on the platform):
- Auth: none — the binding is pre-scoped to your project
- Surface: \`sw.db\`, \`sw.fs\`, \`sw.ai\`, \`sw.email\`, \`sw.auth\`, \`sw.env\`, \`sw.jobs\`, \`sw.queue\`, \`sw.logs\`
- Use case: API endpoints, server-side logic, AI proxies, file uploads, scheduled work

When you write a function, default to \`sw.*\`. Only fall back to the
REST surface when you have a specific reason (calling another project,
calling from outside).

## Pattern: Chat app with auth + history

Database:
\`\`\`text
users(id, email, password_hash, ...)         -- created by sw.auth.signup
_conversations(id, project_id, ...)          -- platform-managed
_conversation_messages(...)                  -- platform-managed
\`\`\`

Function (\`api/chat.ts\`):
\`\`\`typescript
export default async function (req, sw) {
  const { user } = await sw.auth.me(req.headers.get('Authorization')?.slice(7))
  if (!user) return new Response('Unauthorized', { status: 401 })

  const { conversation_id, message } = await req.json()

  const result = await sw.ai.chat({
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: message }],
    conversation_id  // platform persists + truncates history
  })

  return Response.json({
    conversation_id: result.conversation_id,
    reply: result.text
  })
}
\`\`\`

Conversation history is stored on the platform — you don't manage it.
Pass the same \`conversation_id\` on subsequent calls and the platform
loads + truncates history automatically.

## Pattern: REST API with end-user auth

Function (\`api/posts.ts\`):
\`\`\`typescript
export default async function (req, sw) {
  const jwt = req.headers.get('Authorization')?.slice(7)
  const { user } = await sw.auth.me(jwt)
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 })

  if (req.method === 'GET') {
    const { data } = await sw.db.query(
      'SELECT * FROM posts WHERE author_id = ? ORDER BY created_at DESC',
      [user.id]
    )
    return Response.json(data)
  }

  if (req.method === 'POST') {
    const { title, body } = await req.json()
    const { data } = await sw.db.query(
      'INSERT INTO posts (author_id, title, body) VALUES (?, ?, ?) RETURNING *',
      [user.id, title, body]
    )
    return Response.json(data[0], { status: 201 })
  }
}
\`\`\`

Auth is a single \`sw.auth.me(jwt)\` call. The platform validates the
token, returns the user, and you scope queries by \`user.id\`.

## Pattern: File upload with public URL

Function (\`api/upload.ts\`):
\`\`\`typescript
export default async function (req, sw) {
  const { user } = await sw.auth.me(req.headers.get('Authorization')?.slice(7))
  if (!user) return new Response('Unauthorized', { status: 401 })

  const formData = await req.formData()
  const file = formData.get('file') as File
  const buf = await file.arrayBuffer()

  const path = \`/uploads/\${user.id}/\${crypto.randomUUID()}-\${file.name}\`
  await sw.fs.write(path, new Uint8Array(buf), {
    contentType: file.type
  })

  // Public URL — anyone with the URL can read.
  const url = \`https://\${sw.env.PROJECT_SUBDOMAIN}.somewhere.site/storage\${path}\`
  return Response.json({ url })
}
\`\`\`

Files written under \`/uploads/\` are served on the project's domain at
\`/storage/<path>\`. For private files, use a separate path prefix and
gate downloads through a function.

## Pattern: Background work

Inline jobs (return immediately, work later):
\`\`\`typescript
// API endpoint
export default async function (req, sw) {
  const { email } = await req.json()
  await sw.jobs.create({
    handler: 'jobs/send-welcome',
    payload: { email }
  })
  return Response.json({ queued: true })
}
\`\`\`

Handler (\`jobs/send-welcome.ts\`):
\`\`\`typescript
export default async function ({ payload }, sw) {
  await sw.email.send({
    to: payload.email,
    subject: 'Welcome',
    html: '<h1>Hi!</h1>'
  })
}
\`\`\`

For fire-and-forget side effects use \`sw.queue.push({ handler, payload })\`
— no return value, no status to inspect.

For scheduled work use \`cron_create\` to point a cron expression at
a function path.

## Pattern: External API proxy (hide your key)

\`\`\`typescript
// api/openai-proxy.ts — keeps OPENAI_API_KEY off the client
export default async function (req, sw) {
  const { user } = await sw.auth.me(req.headers.get('Authorization')?.slice(7))
  if (!user) return new Response('Unauthorized', { status: 401 })

  const body = await req.json()
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: \`Bearer \${sw.env.OPENAI_API_KEY}\`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  })
  return new Response(r.body, { status: r.status, headers: { 'Content-Type': 'application/json' } })
}
\`\`\`

Set \`OPENAI_API_KEY\` as an env var on the project. The browser never
sees it. Same pattern for Stripe, Twilio, anything.

For built-in models (chat, image generation, TTS, embeddings, etc.)
prefer \`sw.ai.*\` — billing is metered through the platform and you
don't manage upstream keys at all.
`,

  'troubleshooting': `# Troubleshooting — Common errors and what to do

Pick the row that matches your error and apply the fix.

## "FUNCTION_NOT_FOUND" or 404 on a /api/* route

The function file isn't deployed, or the route doesn't match.

Check:
1. Did you actually deploy the function? \`deploy_status({ project_id })\`
   lists deployed functions.
2. Does the file path match the URL? \`api/users/[id].ts\` serves
   \`/api/users/123\`. \`api/users.ts\` serves \`/api/users\`.
3. Was the deploy actually successful? Re-run \`project_deploy\` and
   check the response — every deploy goes live; if the route still
   404s, the function isn't in the bundle.

## "API key is invalid" inside sw.* calls

The function bundle's runtime keys are stale. This happens after the
platform rotates internal keys, or after a billing-state change that
re-issued credentials.

Fix: redeploy the project with any small touch, e.g.
\`project_patch({ project_id, path: "index.html", find: " ", replace: " " })\`
(a no-op find/replace bumps the version + reissues runtime keys).

Re-running \`project_deploy\` works too but replaces all files, so
\`project_patch\` is safer.

## "SPENDING_CAP_REACHED"

The project hit its monthly AI spending cap. By default each project
has a cap to prevent runaway costs.

Fix: dashboard → Settings → AI → raise the cap. Or for testing, set
the cap to a high value and leave it. Admin accounts bypass this gate
automatically.

The cap is per-project, not per-account.

## Auth emails (signup, password reset) not arriving

Two common causes:

**Sender not verified** — The platform sends from \`noreply@somewhere.tech\`
by default. Some inboxes flag this as suspicious. Add a verified
sender domain in dashboard Settings → Email, then auth emails come
from your own domain.

**Email not configured** — Email send goes through the platform email service. If the
project's account doesn't have email sending wired up, sends fail silently
(logged, not surfaced). Check dashboard Logs for the project to see
the actual error.

## "Site not loading after deploy"

Every \`project_deploy\` and \`project_patch\` writes to the live serving
slot. If the live site still shows
the old version, it's almost always cache:

1. **Browser cache.** Hard reload (Cmd-Shift-R) or open the URL in a
   private window.
2. **Edge cache.** \`curl -sI https://{subdomain}.somewhere.site/\`
   shows the response headers — \`cache-control\` tells you whether it
   was cached.
3. **Wrong project.** Confirm the \`project_id\` matches the subdomain
   you're hitting.

If a deploy genuinely failed silently, \`deploy_status({ project_id })\`
returns the most recent timestamp — older than your last deploy means
the deploy errored.

## Managed-mode raw SQL errors

The project has a deployed \`db/schema.ts\`, so it is in managed mode.
Ordinary \`sw.db.query\` / \`sw.db.batch\` fail before transport with
\`MANAGED_RAW_SQL_REQUIRES_SERVER_AUTHORITY\`, including in job, queue, and
cron handlers. Explicit \`sw.db.server.query\` / \`sw.db.server.batch\` reads
run as written after your function authorizes the caller; a raw write through
them fails with \`MANAGED_RAW_WRITE_FORBIDDEN\`.

Fix: write with \`sw.db.insert\` / \`sw.db.update\` / \`sw.db.remove\` (the
table needs a declared intent), or run the statement with developer
authority (\`db_query\` / \`db_batch\` / \`db_migrate\`), which is
unaffected. There is no verb that switches the project back to SQL mode.
Full contract: \`docs({ topic: 'sw.db' })\`, "Managed mode".

## "AUTH_REQUIRED" from sw.db.from / insert / count on an owner() table

The table is user-owned, so the platform scopes it to a principal, and this
request had none: there is no signed-in user, and this table does not declare
\`owner({ visitors: true })\`, which is the declaration that accepts a stable
anonymous visitor identity. Inspect the table in \`db_scope_list\`; its
\`owner_principal\` summary describes both declaration forms.

Fix: send the request signed in (same-origin session cookie, or
\`Authorization: Bearer <app-user token>\`); or, after the handler independently
checks that this caller is allowed to read across users, use the deliberate
server-side cross-user mode \`{ asServer: true }\` with
\`sw.db.from\` / \`sw.db.count\`; or put the data on a \`shared()\` /
\`serverOnly()\` table and manage the visitor key yourself.

## "REALTIME_UNAVAILABLE" / "CHANNEL_FORBIDDEN"

\`sw.realtime.*\` is not available inside a deployed function, and realtime
channels refuse app-user and visitor sessions. Neither is a
configuration problem and there is no flag to turn them on.

Fix: for browser live updates declare a live view —
\`sw.db.live(name, sw.db.from(...))\` + \`watchLive\`. For server-to-server
fan-out, publish and subscribe with a developer key. See
\`docs({ topic: 'realtime' })\`.

## "payload is required" from sw.push.send

\`sw.push.send\` takes ONE object with the notification nested inside it:
\`sw.push.send({ payload: { title, body }, user_id })\`. The
two-argument \`send(payload, options)\` form is not accepted.

## db_migrate_to was retired

\`db_migrate_to\` and \`POST /v1/db/migrate-to\` were removed. Schema
changes go through \`db_migrate\` with explicit SQL: it takes an automatic
named restore point before production-targeted statements and applies them atomically,
exactly as written (the platform does not analyze raw migration SQL). After
creating a table, declare its access intent with \`db_scope_set\`.

## "DOMAIN_NOT_VERIFIED" on a custom domain

The TXT record hasn't propagated, or doesn't match what the platform
expects.

Fix:
1. \`domain_verify({ domain })\` returns the exact TXT name + value
   you should set.
2. Wait 60-300 seconds after setting DNS for propagation.
3. Use \`dig +short TXT _somewhere-challenge.<domain>\` from terminal
   to confirm DNS-side before re-running verify.

If the value is correct but verify still fails, the most common cause
is multiple TXT records on the same name — the older one shadows the
new one. Delete the stale record.

## "API_KEY is invalid" from sw.ai

If you set a per-project AI provider key (e.g., your own provider
key for higher rate limits), the runtime injects it into the function
bundle. After rotating that key, you need to redeploy. Same fix as
"API key is invalid" above.

If you didn't set a custom key, you're using the platform-managed
pool — \`API_KEY is invalid\` from \`sw.ai\` means the platform's
upstream credential rotated and your bundle is stale. Redeploy.

## Deploy succeeds but old code still serves

Browser cache, CDN cache, or you're on the wrong environment.

In that order, try:
1. Hard reload (Cmd-Shift-R / Ctrl-F5).
2. Open the URL in a private window — bypasses local cache.
3. Check \`deploy_status({ project_id })\` to see the timestamp of the
   most recent deploy. If it's older than your last \`project_deploy\`
   call, the deploy actually failed and you missed the error.

## Hosted workspace ("/workspace") shows "Disconnected code=4001"

The workspace machine is on an outdated agent version. The platform
restart-loops it until either the image gets fixed or the machine is
replaced.

Fix is on our side. If you hit this, post in the support channel
with your project_id and account email — it's not user-fixable.

## "Origin not allowed" when calling from a custom subdomain

The project's CORS allowlist doesn't include the origin you're
calling from. By default the platform allows the project's own
\`*.somewhere.site\` URL plus any verified custom domains for the
project.

Fix: add the exact origin to the project's allowlist. From the CLI/MCP,
read it with \`project_allowed_origins_get\` and set the full list with
\`project_allowed_origins_set\` (owner or platform admin only), e.g.
\`somewhere call project_allowed_origins_set '{"project_id":"my-app","allowed_origins":["https://app.example.com"]}'\`.
Each entry is an exact origin — scheme + host + optional port, no path or
wildcards. The dashboard's Settings → CORS does the same thing. Or if
you're calling server-to-server, use the smt_ key — CORS doesn't apply to
non-browser callers.

## End-users see "Something went wrong" on my live site

When the deployed function throws or crashes during a page load, the
platform serves a branded fallback page so visitors never see a raw
infrastructure error or JSON blob. It looks like:

> # Something went wrong
> The app ran into a problem. Try again in a moment.

Three things to know:

1. **The crash is in your function — read the stack trace.** Every
   uncaught exception is captured to your project's logs with the
   full stack:
   \`\`\`
   project_logs({ project_id, level: 'error', limit: 20 })
   \`\`\`
   Or open the dashboard → project → Logs tab and filter level=error.
   Each row has \`data.stack\`, \`data.path\`, \`data.method\`, \`data.route\`,
   and \`data.request_id\` (the \`cf-ray\` you can correlate with deeper
   logs if you contact support).
2. **The fallback only triggers for page loads.** \`/api/*\` requests
   still return JSON to JS callers — your client error handling stays
   the same. The branded page only appears when a *page* request
   itself fails.
3. **You can customize the page.** Upload a \`_error.html\` file (or
   \`_error/index.html\`) in your project. If present, the platform
   serves that on any unhandled error instead of the default. Plain
   static HTML — no templating, no function dispatch needed.

## How to read your error logs

Every error on your project lands in \`app_logs\` and is reachable
three ways:

- **MCP**: \`project_logs({ project_id, level: 'error', limit: 50 })\` returns
  the most recent error rows in JSON. Add \`since: '1h'\` or a
  unix-ms timestamp to scope the window. Combine with \`q:\` for a
  free-text search across message + data.
- **Dashboard**: project → Logs tab. Filter by level, source
  (function | server | client | system), or search.
- **From inside a function**: \`sw.logs.error(message, data)\` writes
  a row with source='server'. Use this for known-bad branches your
  code handles deliberately.

What you'll see for an uncaught function exception:

\`\`\`json
{
  "level": "error",
  "source": "server",
  "message": "FUNCTION_ERROR: Cannot read properties of undefined (reading 'id')",
  "data": {
    "code": "FUNCTION_ERROR",
    "stack": "TypeError: Cannot read properties of undefined...\\n  at handler (api/users.ts:14:18)\\n  ...",
    "request_id": "8f3c1d2a4b5e6789-LHR",
    "method": "POST",
    "path": "/api/users",
    "route": "/api/users",
    "slot": "prod"
  },
  "created_at": 1715551234567
}
\`\`\`

The \`stack\` field is the single most useful field for debugging — it
tells you the exact file + line in your code where the throw
originated. \`CONTEXT_BUILD_FAILED\` means the function's project context could
not be assembled before the handler ran. Page-dispatch failures (the function
could not start, timed out, or exceeded its runtime limit) show up with
\`FUNCTION_DISPATCH_FAILED\`; an uncaught handler exception is
\`FUNCTION_ERROR\`. Match \`data.request_id\` to the response's
\`x-request-id\` when tracing one request.

Note: error capture is best-effort and runs via \`sw.waitUntil\` —
it never blocks the visitor's response, and the underlying request
returns the branded error page either way.

\`\`\`bash
# Quick custom error page (write via fs_write or include in next deploy):
<!doctype html><h1>my-app is down</h1><p>back in a sec</p>
\`\`\`

The default page is the right call most of the time — only override
when your app's design needs a matching aesthetic.

## All API errors include a hint field

Every JSON error from the platform now ships with a \`hint\` field
that names the most relevant \`docs\` topic. Read the hint
instead of guessing what to call next:

\`\`\`json
{
  "ok": false,
  "error": "VERSION_CONFLICT",
  "message": "Project version is 14, you sent 13.",
  "hint": "Try docs({ topic: 'deploy' }) for usage details..."
}
\`\`\`

If a hint looks misleading, send \`support_ticket({ message })\` —
you'll get a ticket_id you can check with \`support_ticket({ ticket_id })\`.
`,

  'sw.web': `# sw.web — Read pages from the public web

Available inside any deployed function via the sw argument
provided to the handler.

sw.web fetches public web pages and returns their content as clean
markdown. Use it when an agent or feature needs to ingest content from
a URL it doesn't host — docs, blog posts, marketing pages, articles.
The platform proxies the call so your function never holds the upstream
key and never has to fight CORS.

## sw.web.scrape(url, opts?)

Fetch a URL and return its content as markdown by default. Strips
nav/footer/sidebar so you get the main article body.

  const page = await sw.web.scrape('https://docs.somewhere.tech/getting-started')
  // page = {
  //   url: '...', title: 'Getting started', description: '...',
  //   language: 'en', status_code: 200,
  //   markdown: '# Getting started\\n...'
  // }

opts:
  formats?    — array of: markdown | html | rawHtml | links | screenshot
                Default: ['markdown'].
  only_main?  — strip nav/footer/sidebar (default true). Set false to
                keep the full DOM.
  wait_for?   — ms to wait for the page to settle (max 30000). Use for
                SPAs that hydrate after initial load.

## sw.web.search(query, opts?)

Search the public web by keyword. Returns ranked result URLs +
titles + snippets — no page bodies. Pair with \`sw.web.scrape\` when
you want the full content of a specific result.

  const hits = await sw.web.search('react server components streaming', { count: 5 })
  // hits = {
  //   query: '...', count: 5,
  //   results: [
  //     { url: '...', title: '...', description: '...', age: '2 days ago', source: 'blog.example.dev' },
  //     ...
  //   ]
  // }

opts:
  count?      — 1 to 20, default 10.
  country?    — 2-letter code to bias results, e.g. 'us', 'gb', 'de'.
  freshness?  — 'pd' (past day) | 'pw' (past week) | 'pm' (past month)
                | 'py' (past year).
  safesearch? — 'off' | 'moderate' | 'strict'. Default 'moderate'.

## When to use what

- Find URLs by keyword → \`sw.web.search\`. Returns titles + snippets.
- One page → \`sw.web.scrape\`. Returns markdown ready for an LLM prompt.
- Search → scrape pattern is the standard agent loop:

    const hits = await sw.web.search(question, { count: 3 })
    const pages = await Promise.all(
      hits.results.map((r) => sw.web.scrape(r.url))
    )

- A whole site → not supported; scrape pages individually.

## Errors

UPSTREAM_NOT_CONFIGURED  — the platform doesn't have the matching
                           provider wired in this environment.
RATE_LIMITED              — too many calls; retry with backoff.
UPSTREAM_QUOTA            — platform-wide quota exhausted; our team
                           tops it up.
UPSTREAM_ERROR            — provider returned a non-2xx. For scrape,
                           often means the page blocked the request or
                           the URL is wrong.
`,

  'sw.push': `# sw.push — Web Push notifications

Available inside any deployed function via the sw argument
provided to the handler.

Web Push lets you send a notification to a user's browser even when
your tab is closed. The browser registers a push subscription with its
push service (FCM for Chrome, Mozilla autopush for Firefox, Apple for
Safari), hands you back an opaque endpoint + crypto keys, and you POST
encrypted payloads to that endpoint signed with a VAPID JWT.

Per-project VAPID keypair: generated lazily on first call to
sw.push.vapidPublicKey() or sw.push.send(). The same public key is
what the browser must pass to PushManager.subscribe() — fetch it once
in your service worker registration code and reuse it.

## sw.push.vapidPublicKey()
Returns { vapid_public_key }. base64url uncompressed P-256 (87 chars).
Hand this to the browser; the browser hands it to PushManager.subscribe.

const { vapid_public_key } = await sw.push.vapidPublicKey()

## sw.push.subscribe / sw.push.unsubscribe — not available in a function

Both throw \`PUSH_SUBSCRIBE_UNAVAILABLE\` (400). The in-function path that
stored a browser subscription against a caller-supplied user id is
withdrawn; registration is a developer-authority operation today:

  push_subscribe({
    project_id: "my-app",
    subscription: { endpoint, keys: { p256dh, auth } },   // verbatim from the browser
    user_id: "usr_123"                                    // optional target
  })
  // → { id }   idempotent on (project_id, endpoint)

  push_unsubscribe({ project_id: "my-app", endpoint })

The same operations exist as \`POST /v1/push/subscribe\` and
\`POST /v1/push/unsubscribe\` with a developer key. There is currently no
supported way for your own app to register a visitor's browser by itself:
an app-user session is not authorized for those endpoints, and a deployed
function cannot call \`sw.push.subscribe\`. Until that path returns, push
reaches only subscriptions you registered with developer credentials — fine
for your own devices and for admin/ops alerts, not for end-user opt-in at
scale. Say so in \`feedback({ ... })\` if you need it.

## sw.push.send({ payload, ... })
Encrypts and POSTs the payload to one or many stored subscriptions.
Returns { sent, failed, gone, recipients }.

ONE object argument, with the notification body nested under \`payload\`.
There is no second options argument — \`sw.push.send(payload, options)\`
fails with VALIDATION_ERROR "payload is required."

  payload    — required; a string or any JSON-serializable value
  user_id?   — send to every subscription for one app-user
  endpoint?  — send to one specific endpoint (idempotent retry)
  ttl?       — push service TTL in seconds, default 86400

If neither user_id nor endpoint is given, broadcasts to every
subscription in the project. Use sparingly: broadcasts are capped at 500
recipients per call (RECIPIENT_CAP_EXCEEDED above that) and 10 sends per
minute per project.

Subscriptions returning 404/410 are auto-deleted (browser revoked).

// Send to one user
await sw.push.send({ payload: { title: 'New message', body: 'You have mail.' }, user_id: user.id })

// Send to a specific endpoint
await sw.push.send({ payload: { url: '/orders/42' }, endpoint: subscription.endpoint })

// Broadcast to whole project
await sw.push.send({ payload: { title: 'Site update', body: 'New version live.' } })

// A project with no stored subscriptions is not an error:
// → { sent: 0, failed: 0, gone: 0, recipients: 0 }

## Browser-side flow

1. Get the public key from your function:
   const { vapid_public_key } = await fetch('/api/push-key').then(r => r.json())

2. Register a service worker, then subscribe:
   const reg = await navigator.serviceWorker.register('/sw.js')
   const sub = await reg.pushManager.subscribe({
     userVisibleOnly: true,
     applicationServerKey: vapid_public_key,  // base64url string
   })

3. POST the subscription back to your function:
   await fetch('/api/push-subscribe', { method: 'POST', body: JSON.stringify(sub) })

4. Store it. Your function cannot register it (sw.push.subscribe is
   unavailable), so today the function has to persist the subscription in
   your own table and registration happens with developer credentials —
   push_subscribe({ project_id, subscription, user_id }) — before
   sw.push.send can reach that browser.

5. In your service worker, listen for 'push':
   self.addEventListener('push', (e) => {
     const data = e.data?.json() || {}
     e.waitUntil(self.registration.showNotification(data.title, { body: data.body }))
   })

## Limits

Payload max 3000 bytes encrypted. Larger payloads throw. If you need
to send more, store it server-side and push a tiny payload with the
URL or id to fetch.
`,

  'sw.notifications': `# sw.notifications — unified notify primitive

One call → fan-out across push, in-app bell, and (when an address is
provided) email. Safe for LLM tool-calling — the orchestration lives
on the platform, and the caller supplies the recipient and message once.

## sw.notifications.send(userId, { title, body?, url?, email?, channels? })

  await sw.notifications.send(user.id, {
    title: 'Northern line: minor delays',
    body: 'Reported 14:02 GMT. Estimated 10–15 min impact southbound.',
    url: '/lines/northern',
    channels: ['bell', 'push'],   // optional; default ['bell', 'push']
  })

Returns { bell?, push?, email? } with per-channel result. Each entry
is { ok: true, ... } or { ok: false, error: '...', code? } so the
caller can branch without a try/catch per channel.

Channels:
- bell — writes a row to _notifications in the project's own
  database. Auto-creates the table on first use. Render with
  sw.notifications.list(userId) / unreadCount(userId). Hidden from
  db_describe / db_browse like every _-prefixed table.
- push — proxies to sw.push.send against every active subscription
  for that userId. Silent no-op if the user hasn't subscribed.
- email — only fires when opts.email is set explicitly. We don't
  auto-look up the address (your user-table shape is yours). Pair
  with sw.auth.fromRequest(req, { enrichFrom: 'members' }) to pull
  the email + send in two lines. It uses the platform-managed transactional
  sender with the project name as its label, so a new project needs no sender
  setup; opts.email must be the address of that userId (or the project's
  owner). Pass opts.from only when using a verified sender domain of your own.
  The project plan's email allowance and send rate limit still apply.

## Bell helpers

  const { notifications } = await sw.notifications.list(user.id, {
    limit: 50,             // default 50, max 200
    unread_only: false,    // default false
  })
  // notifications[i] = { id, title, body, url, read, created_at }

  const n = await sw.notifications.unreadCount(user.id)
  await sw.notifications.markRead(notifId)
  await sw.notifications.markAllRead(user.id)

## What this is NOT (yet)

- No platform-level dedup, rate-limit, or per-user channel prefs.
  Roll those in your handler if you need them — this is the
  primitive.
- No retries — push / email failures surface immediately. Re-call
  after fixing the cause.
`,

  'sw.image': `# sw.image — Image transformations

Available inside any deployed function via the sw argument
provided to the handler.

sw.image.resize builds a transformation URL — it doesn't fetch the
image, it returns a URL that triggers transformation at the edge when
the browser (or your code) fetches it. Stick the URL in <img src>
for free, no extra hop.

## sw.image.resize(source, options)
Returns a string URL.

source:
  '/uploads/foo.png'                — relative path on this project's domain
  'https://example.com/foo.png'     — absolute URL (must be reachable
                                       from the project's zone)

options (all optional):
  width        number     pixel width
  height       number     pixel height
  fit          'cover' | 'contain' | 'scale-down' | 'crop' | 'pad'
  format       'auto' | 'webp' | 'avif' | 'json'  (default: format=auto)
  quality      1–100      JPEG/WebP/AVIF quality
  dpr          number     device-pixel ratio (1, 2, 3)
  gravity      'auto' | 'left' | 'right' | 'top' | 'bottom' | 'face' | '0.5x0.5'
  background   '#ffffff'  fill colour for pad/contain
  blur         1–250
  sharpen      1–10
  rotate       90 | 180 | 270
  trim         '20;30;20;30'  edge trim (top;right;bottom;left)
  metadata     'keep' | 'copyright' | 'none'
  anim         true | false   (animated GIF/WebP support)

Examples:

const thumb = sw.image.resize('/photo.jpg', { width: 200, height: 200, fit: 'cover' })
// → https://your-project.somewhere.site/cdn-cgi/image/width=200,height=200,fit=cover/photo.jpg

const webp = sw.image.resize(uploadedFile.url, { width: 800, format: 'webp', quality: 80 })

return new Response(\`<img src="\${thumb}" />\`, { headers: { 'Content-Type': 'text/html' } })

## Billing

5,000 unique transformations / month free per project; usage beyond
that is at /v1/pricing. Repeated fetches of the same transformed URL are
cached at the edge — only the first fetch counts. Cached for 1 year
by default.

## Source restrictions

The source URL must be on the project's subdomain (default) or on a
verified custom domain attached to the project. Cross-origin external
URLs are blocked by default and return 403 — if you need to transform
images from a domain you don't own, file via the \`feedback\` tool.

For files in sw.fs, point at the project URL with the path:
  sw.image.resize('/api/files/photo.jpg', { width: 400 })
where /api/files/photo.jpg is a function that does sw.fs.read.

## Errors

The transformed URL returns 4xx if Image Transformations isn't enabled
on the zone, or 415 if the source isn't an image. The helper itself
only validates the inputs and builds the URL — it does not pre-flight.
`,

  'recipe-ai-agent': `# Recipe — AI agent with tool calls

Build a chatbot that holds conversation history, looks things up in
your project's database, and answers grounded questions. Uses
\`sw.ai.chat\` with tool-use + sw.ai conversation persistence.

## Database schema

  // db/schema.ts — deploy this declaration with the app source.
  import { schema, table, id, text, timestamp, owner } from 'somewhere/db'

  export default schema({
    knowledge: table({
      id: id({ uuid: true }),
      title: text(),
      body: text(),
      created_at: timestamp({ default: 'now' }),
    }, {
      scope: owner(),
      indexes: [['title']],
    }),
  })

## Function: api/chat.ts

  export default async (req, sw) => {
    const user = await sw.auth.requireUser(req)
    const body = await req.json()                       // { conversation_id, message }

    const tools = [
      {
        name: 'lookup_knowledge',
        description: 'Search the knowledge base. Returns matching titles + bodies.',
        input_schema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
    ]

    let messages = [{ role: 'user', content: body.message }]

    while (true) {
      const r = await sw.ai.forUser(user.id).chat({
        provider: 'anthropic',
        conversation_id: body.conversation_id,
        system: 'Use lookup_knowledge to ground your answers. If nothing matches, say so.',
        messages,
        tools,
      })

      // Tool-call loop: if the model wants a tool, run it + feed back.
      if (r.stop_reason !== 'tool_use') return Response.json({ reply: r.text })

      const toolUse = r.content.find(b => b.type === 'tool_use')
      const rows = await sw.db.from('knowledge', {
        columns: ['id', 'title', 'body'],
        where: {
          $or: [
            { title: { contains: toolUse.input.query } },
            { body: { contains: toolUse.input.query } },
          ],
        },
        limit: 5,
      })

      messages = [
        { role: 'assistant', content: r.content },
        { role: 'user', content: [{
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(rows.data),
        }] },
      ]
    }
  }

## Conversation history is automatic

\`sw.ai.forUser(user.id)\` scopes the conversation to that subject.
Pass the same \`conversation_id\` next turn and the platform replays
prior messages server-side — your handler stays stateless.

## Variations

- **Structured output instead of tool-use:** pass \`response_schema\`
  and read \`r.parsed\`. The free default makes no repair call on parse failure.
- **Free model:** omit \`provider\` and \`model\` to use
  \`gpt-5.6-luna\` — no activation required, rate-limited and
  capped, but free to the user.
- **Meaning-based knowledge lookup:** create an index once with
  \`search_index_create\`, then \`search_upsert\` whenever a knowledge row
  changes and query it through \`sw.search\`. Use \`ai_embed\` only when the
  agent needs custom vectors or clustering outside the managed search index.
- **Voice input:** run uploaded audio through \`sw.ai.transcribe\` or the
  \`ai_transcribe\` MCP tool, then pass the returned text into this same chat
  handler.
- **Generated visual output:** use \`sw.ai.generateImage\` or
  \`ai_generate_image\` when the product asks the agent for a hero, thumbnail,
  social card, or other visual asset; store reusable output in the project's
  files.

Related topics: \`sw.ai\`, \`sw.auth\`, \`sw.db\`, \`search\`.
`,

  'recipe-booking': `# Recipe — Booking / calendar app

Calendar slot reservation with availability hints and payment checkout. Each
appointment locks a provider calendar range with \`sw.calendar\` and binds that
hold to checkout. This recipe stops before app-level fulfillment.

## Database schema

  // db/schema.ts — trusted functions own provider configuration; browsers
  // reach only the narrow availability and booking handlers below.
  import { schema, table, id, text, integer, timestamp, serverOnly } from 'somewhere/db'

  export default schema({
    providers: table({
      id: id({ uuid: true }),
      user_id: text(),
      name: text(),
      slot_minutes: integer({ default: 60 }),
      price_cents: integer({ default: 0 }),
      timezone: text({ default: 'UTC' }),
      created_at: timestamp({ default: 'now' }),
    }, { scope: serverOnly() }),
  })

## Function: api/availability.ts — list candidate slots in a day

  export default async (req, sw) => {
    const url = new URL(req.url)
    const providerId = url.searchParams.get('provider_id')
    const dayStart = parseInt(url.searchParams.get('day_start'))   // unix ms
    const dayEnd = dayStart + 24 * 3600 * 1000

    // provider ids identify the public booking calendar; expose only timing.
    const { data: providers } = await sw.db.from('providers', {
      columns: ['slot_minutes'], where: { id: providerId }, limit: 1, asServer: true,
    })
    if (!providers[0]) return Response.json({ error: 'not_found' }, { status: 404 })

    const availability = await sw.calendar.availability({
      resource: \`provider:\${providerId}\`,
      range: { start: dayStart, end: dayEnd },
    })

    // The same calendar conflict set powers both this UI and the atomic hold.
    const slotMs = providers[0].slot_minutes * 60 * 1000
    const slots = []
    for (let t = dayStart; t + slotMs <= dayEnd; t += slotMs) {
      const overlap = availability.busy.some(b => b.start_ms < t + slotMs && b.end_ms > t)
      if (!overlap) slots.push({ starts_at: t, ends_at: t + slotMs })
    }
    return Response.json({ slots })
  }

## Function: api/book.ts — reserve + checkout

  export default async (req, sw) => {
    const { provider_id, customer_email, starts_at } = await req.json()
    // This public endpoint deliberately reads the selected provider's booking
    // terms, then exposes only the checkout URL and hold expiry.
    const { data: providers } = await sw.db.from('providers', {
      columns: ['slot_minutes', 'price_cents', 'timezone'],
      where: { id: provider_id }, limit: 1, asServer: true,
    })
    const provider = providers[0]
    if (!provider) return Response.json({ error: 'not_found' }, { status: 404 })

    const ends_at = starts_at + provider.slot_minutes * 60 * 1000

    let hold
    try {
      hold = await sw.calendar.hold({
        resource: \`provider:\${provider_id}\`,
        range: {
          start: starts_at,
          end: ends_at,
          timezone: provider.timezone,
        },
        ttl_seconds: 45 * 60,
      })
    } catch (err) {
      if (err?.code === 'CALENDAR_CONFLICT') {
        return Response.json({ error: 'slot_taken' }, { status: 409 })
      }
      throw err
    }

    try {
      const checkout = await sw.payments.checkout({
        env: 'prod',
        mode: 'payment',
        calendar_hold_token: hold.hold_token,
        line_items: [{ amount: provider.price_cents, currency: 'usd', name: 'Appointment' }],
        success_url: \`https://\${sw.env.SUBDOMAIN}.somewhere.site/checkout-return\`,
        cancel_url: \`https://\${sw.env.SUBDOMAIN}.somewhere.site/book\`,
        customer_email,
      })

      return Response.json({
        reservation_id: hold.reservation.id,
        status: 'pending_payment',
        checkout_url: checkout.url,
        hold_expires_at: hold.expires_at,
      })
    } catch (err) {
      await sw.calendar.release(hold.hold_token, { release_reason: 'checkout_setup_failed' }).catch(() => {})
      throw err
    }
  }

The checkout call binds the hold token to the payment session so the platform
can manage its lifecycle. A success redirect is navigation, not payment proof.
\`sw.payments.events\` is an activity feed and does not expose checkout metadata
or payment status, so this recipe does not mark the booking fulfilled or send a
confirmation email. Add those effects only behind a supported, signed payment
completion callback that proves the payment succeeded.

Related topics: \`sw.calendar\`, \`sw.db\`, \`sw.payments\`.
`,

  'recipe-ecommerce': `# Recipe — Fixed-price catalog checkout

Start Stripe checkout for an always-available catalog. This small recipe
intentionally stops at checkout creation: it does not fulfill an order, send a
confirmation, or reserve and decrement limited inventory.

## Database schema

  // db/schema.ts — the checkout function reads this private catalog and returns
  // only the checkout URL.
  import { schema, table, id, text, integer, boolean, timestamp, serverOnly } from 'somewhere/db'

  export default schema({
    products: table({
      id: id({ uuid: true }),
      name: text(),
      description: text({ nullable: true }),
      price_cents: integer(),
      image_url: text({ nullable: true }),
      active: boolean({ default: true }),
      created_at: timestamp({ default: 'now' }),
    }, { scope: serverOnly() }),
  })

## Function: api/checkout.ts — create checkout

  export default async (req, sw) => {
    const { items, customer_email } = await req.json()
    if (!Array.isArray(items) || items.length < 1 || items.length > 20 ||
        typeof customer_email !== 'string') {
      return Response.json({ error: 'invalid_cart' }, { status: 400 })
    }
    if (items.some(it => typeof it.product_id !== 'string' ||
        !Number.isInteger(it.quantity) || it.quantity < 1 || it.quantity > 99)) {
      return Response.json({ error: 'invalid_cart' }, { status: 400 })
    }
    const ids = items.map(it => it.product_id)
    if (new Set(ids).size !== ids.length) {
      return Response.json({ error: 'duplicate_product' }, { status: 400 })
    }

    // This public function intentionally reads only active catalog fields.
    const { data: products } = await sw.db.from('products', {
      columns: ['id', 'name', 'price_cents'],
      where: { id: { in: ids }, active: true },
      limit: 20,
      asServer: true,
    })
    if (products.length !== items.length) {
      return Response.json({ error: 'product_unavailable' }, { status: 400 })
    }
    const byId = Object.fromEntries(products.map(product => [product.id, product]))
    const checkout = await sw.payments.checkout({
      env: 'prod',
      mode: 'payment',
      line_items: items.map(item => ({
        amount: byId[item.product_id].price_cents,
        currency: 'usd',
        name: byId[item.product_id].name,
        quantity: item.quantity,
      })),
      success_url: \`https://\${sw.env.SUBDOMAIN}.somewhere.site/thanks\`,
      cancel_url: \`https://\${sw.env.SUBDOMAIN}.somewhere.site/cart\`,
      customer_email,
    })
    return Response.json({ status: 'pending_payment', checkout_url: checkout.url })
  }

## Notes

- **Inventory.** This recipe is for products that remain available. A limited-
  stock store needs a reservation design that handles expiry, payment failure,
  and compensation; do not add a guarded decrement to this flow and call it an
  inventory guarantee.
- **Fulfillment.** A success redirect is not payment proof, and
  \`sw.payments.events\` does not expose per-checkout metadata or payment status.
  Keep fulfillment and confirmation out of this handler. Add those effects
  only when your integration has a supported, signed payment-completion
  callback; if the product is a plan entitlement, use \`checkoutForUser\` and
  \`sw.billing\`, which apply entitlement changes from platform-verified events.
- **Cart persistence.** Store the cart in the browser. For logged-in carts,
  gate behind \`sw.auth.requireUser\` and use a separately declared owner table.
- **Catalog discovery.** Create a product index once with
  \`search_index_create\`, then \`search_upsert\` whenever a product changes.

Related topics: \`payments\`, \`sw.billing\`, \`sw.db\`, \`search\`.
`,

  'recipe-multi-chat': `# Recipe — Multi-chat (Claude.ai-style conversation list)

End users of your chatbot app keep multiple separate conversations,
like Claude.ai's sidebar. The conversation infrastructure already
exists on the platform — \`sw.ai.forUser(userId).chat({ conversation_id })\`
scopes history to the subject. This recipe shows the UI pattern that
wraps it.

Single-chat apps (e.g., a support widget that's "always the same
conversation") don't need any of this — call sw.ai.chat without
conversation_id and you're done.

## Backend — three endpoints

  // api/chat/send.ts — POST { conversation_id?, message } → { reply, conversation_id }
  export default async (req, sw) => {
    const user = await sw.auth.requireUser(req)
    const body = await req.json()
    const conversation_id = body.conversation_id || crypto.randomUUID()
    const r = await sw.ai.forUser(user.id).chat({
      provider: 'anthropic',
      conversation_id,
      system: 'You are a helpful assistant.',
      messages: [{ role: 'user', content: body.message }],
    })
    return Response.json({ reply: r.text, conversation_id })
  }

  // api/chat/list.ts — GET → recent conversations for the user
  export default async (req, sw) => {
    const user = await sw.auth.requireUser(req)
    return Response.json(await sw.ai.forUser(user.id).conversationList({ limit: 50 }))
  }

  // api/chat/get.ts — GET ?id=... → full transcript
  export default async (req, sw) => {
    const user = await sw.auth.requireUser(req)
    const id = new URL(req.url).searchParams.get('id')
    return Response.json(await sw.ai.forUser(user.id).conversationGet(id))
  }

  // api/chat/delete.ts — DELETE ?id=...
  export default async (req, sw) => {
    const user = await sw.auth.requireUser(req)
    const id = new URL(req.url).searchParams.get('id')
    await sw.ai.forUser(user.id).conversationDelete(id)
    return new Response(null, { status: 204 })
  }

## Frontend — sketch

  function ChatApp() {
    const [conversations, setConversations] = useState([])
    const [currentId, setCurrentId] = useState(null)         // null = new chat
    const [messages, setMessages] = useState([])
    const [input, setInput] = useState('')

    useEffect(() => { fetch('/api/chat/list').then(r => r.json()).then(setConversations) }, [])
    useEffect(() => {
      if (!currentId) { setMessages([]); return }
      fetch(\`/api/chat/get?id=\${currentId}\`).then(r => r.json()).then(d => setMessages(d.messages))
    }, [currentId])

    async function send() {
      const optimistic = [...messages, { role: 'user', content: input }]
      setMessages(optimistic); setInput('')
      const r = await fetch('/api/chat/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation_id: currentId, message: input }),
      }).then(r => r.json())
      setMessages([...optimistic, { role: 'assistant', content: r.reply }])
      if (!currentId) {
        setCurrentId(r.conversation_id)
        setConversations([{ id: r.conversation_id, updated_at: Date.now() }, ...conversations])
      }
    }

    return (
      <div style={{ display: 'flex' }}>
        <aside style={{ width: 240, borderRight: '1px solid #eee' }}>
          <button onClick={() => setCurrentId(null)}>+ New chat</button>
          {conversations.map(c => (
            <div key={c.id} onClick={() => setCurrentId(c.id)}
                 style={{ padding: 8, background: currentId === c.id ? '#f0f0f0' : 'transparent' }}>
              {c.id.slice(0, 8)} · {new Date(c.updated_at).toLocaleString()}
            </div>
          ))}
        </aside>
        <main style={{ flex: 1, padding: 16 }}>
          {messages.map((m, i) => <p key={i}><strong>{m.role}:</strong> {m.content}</p>)}
          <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && send()} />
        </main>
      </div>
    )
  }

## What you get for free

- **History server-side.** You never store messages in localStorage —
  reloading the page restores the full transcript via conversationGet.
- **Subject scoping.** sw.ai.forUser(userId) means conversation_ids are
  isolated per user; a leaked id from user A doesn't load user B's
  history.
- **Compaction.** Long conversations auto-compact via the
  history_max_messages / history_max_tokens caps; pass
  compaction:'summarize' to fold dropped turns into a rolling summary.

Related topics: \`sw.ai\`, \`sw.auth\`.
`,

  'sw.endpoint': `# sw.endpoint — declarative endpoint wrapper

\`sw.endpoint\` wraps a server function with auth, body validation, rate
limiting, error formatting, and CORS so you only write business logic.
Eight lines of boilerplate every endpoint needs — gone.

  // api/signup.ts
  export default sw.endpoint({
    auth: 'none',
    body: { email: 'email', password: 'string', name: 'string?' },
    rateLimit: '5/minute',
    cors: 'same-origin',
    handler: async ({ body }, sw) => {
      const user = await sw.auth.signup(body.email, body.password, { name: body.name });
      return { ok: true, user_id: user.id };
    }
  });

## What the platform handles before your handler runs

- **auth** — \`'required'\` calls \`sw.auth.requireUser(request)\` and
  returns 401 if the request isn't signed in. \`'optional'\` enriches
  \`user\` when present, otherwise leaves it \`null\`. \`'none'\` skips.
- **body** — parses JSON, validates against the schema, returns 400
  \`VALIDATION_ERROR\` with a list of field-level messages if anything's
  off. Schema types: \`'string'\`, \`'email'\`, \`'number'\`, \`'boolean'\`,
  \`'array'\`, \`'object'\`. Suffix \`'?'\` to make a field optional
  (\`'string?'\`). Nest objects by nesting the schema.
- **rateLimit** — string like \`'10/minute'\`, \`'60/hour'\`, \`'1000/day'\`.
  Counter is keyed by user id when authed, by client IP otherwise, with
  the request path appended so two endpoints don't share a bucket.
  Returns 429 \`RATE_LIMITED\` + \`Retry-After\` header.
- **cors** — \`'same-origin'\` (default; no CORS headers), \`'*'\` (allow
  any), or an allow-list array (\`['app.example.com']\` — subdomain
  matches accepted). Preflight \`OPTIONS\` is auto-answered with 204.

## What your handler receives

\`async ({ body, user, headers, params, request }, sw) => …\`

- \`body\` — the validated, parsed JSON (\`null\` when no schema or for
  GET/DELETE/HEAD).
- \`user\` — the authed user, or \`null\` for \`auth: 'optional'\`/\`'none'\`.
- \`headers\` — the request \`Headers\` object.
- \`params\` — route params (from \`api/[id].ts\`-style paths).
- \`request\` — the original \`Request\` if you need it.
- \`sw\` — the per-request platform context, same as a plain handler's
  second arg.

Return a plain object → wrapped in \`Response.json\`. Return a
\`Response\` → passed through unchanged. Return \`null\`/\`undefined\` → 204.

## Errors

Throw anywhere in your handler and the wrapper formats it: thrown
errors with \`.status\` and \`.code\` become exact HTTP responses,
everything else lands as 500 \`HANDLER_ERROR\`. No stack traces ever
leak to the caller — the full error goes to your function logs.

  throw Object.assign(new Error('Not enough credit.'), { status: 402, code: 'INSUFFICIENT_FUNDS' });

## When NOT to use it

You don't have to. A plain \`async (req, sw) => …\` handler still works.
Reach for \`sw.endpoint\` whenever the endpoint needs auth, validation,
or rate limiting — which is "almost always."

Related topics: \`sw.auth\`, \`sw.rateLimit\`.
`,

  'recipe-escalation': `# Recipe — Cheap model escalates to smart model when stuck

Run your chatbot on a cheap fast model (Haiku, GPT-4o-mini) for the
90% of turns that are easy — navigation, simple lookups, short
answers. When a turn is actually hard (a real bug, architecture
advice, a code review), the cheap model can hand the *whole conversation*
to a smarter model in one round-trip. The application receives the final
answer from the same agent run.

This is exactly how the Help widget in the somewhere.tech dashboard
works (Haiku → Sonnet) — paying cheap-model rates on the 90% easy case
and smart-model rates only when you need it, you ship a "smart" chatbot
at a fraction of all-premium cost.

## The pattern

Add one tool — \`ask_expert\` — to a \`sw.agent.run\` call. When invoked, the
handler runs a single \`sw.ai.chat\` against the smart model with the
same conversation history, then returns the smart model's answer as
the tool result. The cheap model relays it.

## Code

  // api/chat.ts
  export default async (req, sw) => {
    const user = await sw.auth.requireUser(req)
    const body = await req.json()
    const conversation_id = body.conversation_id || crypto.randomUUID()

    const askExpert = {
      name: 'ask_expert',
      description: 'Forward this conversation to a more capable model for a deeper answer. Use for: real debugging help (stack traces, "why doesn\\'t this work"), architecture advice, code review, genuine unknowns. Do NOT use for: simple lookups, navigation, status questions.',
      input_schema: {
        type: 'object',
        properties: { reason: { type: 'string', description: 'One sentence on why you are escalating (telemetry only).' } },
        required: ['reason'],
      },
      execute: async ({ reason: _reason }) => {
        // Rate-limit BEFORE calling the smart model so a chatty
        // cheap model can't burn your spend.
        const today = new Date().toISOString().slice(0, 10)
        const key = \`escalate:\${user.id}:\${today}\`
        const used = Number((await sw.kv.get(key)) || 0)
        const cap = user.tier === 'pro' ? 20 : 3   // free/builder: 3/day
        if (used >= cap) {
          return 'Daily expert quota reached.'
        }
        await sw.kv.put(key, String(used + 1), { expirationTtl: 36 * 3600 })

        // Hand the WHOLE conversation to the smart model.
        // sw.ai.forUser scopes history to this user; passing the same
        // conversation_id replays every turn so far.
        const smart = await sw.ai.forUser(user.id).chat({
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          conversation_id,
          system: 'You are an expert assistant. Be precise and thorough.',
          messages: [],
        })
        return smart.text
      },
    }

    const r = await sw.agent.run({
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      conversation_id,
      subject_type: 'app_user',
      subject_id: user.id,
      system: 'You are a helpful assistant. When a user asks for real debugging help, architecture advice, or a code review — call ask_expert. For everything else, answer directly.',
      messages: [{ role: 'user', content: body.message }],
      tools: [askExpert],
    })
    return Response.json({ reply: r.text, conversation_id })
  }

The escalation tool uses the same capped agent loop as the other tools.

## When the cheap model should escalate

Four typical escalation signals:

- **Debugging** — user pastes a stack trace, error, or asks "why
  doesn't X work?". The cheap model is usually wrong on these; the
  smart model spots the missing \`await\` / wrong destructure / off-by-
  one.
- **Architecture / design advice** — "how should I structure my
  database for…", "where should this logic live…". The cheap model
  picks one option confidently; the smart model weighs trade-offs.
- **Code review** — user pastes 30+ lines of code asking for feedback.
- **Genuine unknown** — the user is asking about a domain the cheap
  model hasn't been taught (your product, a niche library).

Typical non-escalation signals:
- Navigation ("where do I find X?").
- Project status ("am I healthy?", "what's my usage?").
- Simple how-to questions answered in your existing system prompt.

## Cost math

See /v1/pricing for current per-model rates. Cheap and smart models
typically differ by an order of magnitude or more on per-turn cost.

If 10% of turns escalate, your blended cost is roughly 6× the
cheap-model-only rate — but your bot now gets the hard questions right.
Cheap-everywhere costs less per turn and gets half the hard answers wrong.

## Tier gating

Don't expose the same cap to every user. The recipe above branches
on \`user.tier\` (set when you create the user, or stored in your own
\`users\` row). A reasonable starting shape:

- **Free** — 3 escalations / day.
- **Paid** — 20 / day.
- **Top tier** — unlimited.

When the cap is hit, the tool result reports that the daily expert quota was
reached. The application retains authority over how that state is presented.

Related topics: \`sw.ai\`, \`recipe-ai-agent\`, \`recipe-multi-chat\`.
`,

  'database-engine': `# Database — SQL support, capabilities, and limits

## Short answer

A fully managed relational database, one database per project. It supports
foreign keys, joins, indexes, transactions, triggers, JSON operators,
full-text search, and math functions. Deployed functions normally use a
native project binding; first-use activation, placement, transport, scheduling,
and engine execution can all contribute to end-to-end latency.

## What you get vs Postgres

Supported syntax and capabilities:
- Standard SQL: SELECT / INSERT / UPDATE / DELETE / JOIN / GROUP BY / HAVING / window functions
- Constraints: PRIMARY KEY, FOREIGN KEY (with ON DELETE/UPDATE), UNIQUE, NOT NULL, CHECK
- Indexes (B-tree), partial indexes, expression indexes
- Triggers (BEFORE / AFTER / INSTEAD OF)
- Transactions with full ACID, savepoints
- JSON columns + JSON operators (\`json_extract\`, \`->\`, \`->>\`)
- Full-text search
- Common Table Expressions, recursive CTEs

What's different from Postgres (most don't matter for app code):
- \`RETURNING\` is supported on INSERT, UPDATE, and DELETE.
- No \`ENUM\` types — use CHECK constraints + TEXT.
- No \`UUID\` type — use TEXT, generate via \`crypto.randomUUID()\` in your function.
- No stored procedures / PL/pgSQL — write logic in your server function.
- No materialized views — cache results in a regular table refreshed via cron.
- Ordinary writes are direct. The per-project database engine schedules writes
  one at a time; there is no additional platform write queue. Concurrent reads
  may overlap, but placement and database load still affect latency.
- Default-engine semantics apply. Division by zero returns \`NULL\`,
  ascending order places \`NULL\` first by default, and \`LIKE\` is
  case-insensitive for ASCII unless the query makes its intent explicit.

## What the platform compensates for

- **Schema as source** — declare tables in \`db/schema.ts\` and deploy; the
  platform creates them and arms per-user scoping in the same step, and the
  file stays the only schema writer for those tables. Hand-managed tables keep
  \`db_migrate\` + \`db_scope_set\` — see the two-worlds section in
  docs({ topic: 'sw.db' }).
- **Vector search** — \`sw.search.*\` gives you embeddings + similarity queries over your tables without bolting on a separate vector database.
- **Realtime DB events** — the developer-side \`db_webhook_set/get/delete\`
  tools register a webhook on INSERT/UPDATE/DELETE. Cleaner than LISTEN/NOTIFY
  for typical app use.
- **Per-user row scoping** — the structured builder
  \`sw.db.from/count/insert/update/remove\` on a declared user-owned table injects the
  owner filter from the request's verified user automatically. Explicit
  \`sw.db.server\` reads bypass that scope only when selected by the function.
- **Atomic batches** — \`sw.db.tx\` and \`sw.db.server.tx\` commit related
  declared operations together; ordinary single writes remain direct.
- **Database storage** — account totals are Free 500 MB / Builder 10 GB / Pro
  25 GB / Scale 50 GB / Enterprise contract, with a separate 10 GB ceiling on
  one project database. Storage is enforced; reads are unmetered. The live
  values are returned by \`GET /v1/pricing\`.

## When to use somewhere.tech's DB

✓ App data tied to end-users (accounts, content, sessions, orders, messages, embeddings).
✓ Small-to-medium relational data — anything from 1 row to 10 GB in one project.
✓ Request-path relational work where calls are bounded and write bursts are batched.

## When to reach for Postgres

✗ Heavy analytics / complex window queries over hundreds of millions of rows (use a warehouse).
✗ Existing Postgres-native ecosystem (PostGIS, pgvector tuning, specific extensions you depend on).
✗ Cross-region multi-master writes that need >1 simultaneous writer.

## Managed project database vs Postgres and Neon

The managed project database removes setup that otherwise belongs to the app:
database activation, schema application from \`db/schema.ts\`, a generated typed
client, declared row-permission enforcement, and deploy diagnostics. The app
still owns its data model, query design, and authorization decisions in server
functions. The compiler checks declared contracts and known unsafe shapes; it
does not prove that every query is correct or efficient.

Postgres provides its own semantics, extensions, drivers, and operational
ecosystem. Neon provides managed Postgres plus HTTP and WebSocket driver
options. With either, the application chooses and configures the provider,
region, credentials, connection behavior, migrations, authorization policy,
transactions, and recovery plan. Next.js can integrate these providers; the
framework does not choose those policies for the application.

Neon references: https://neon.com/docs/reference/compatibility and
https://neon.com/docs/serverless/serverless-driver

Developer-side \`db_dump\` gives you a SQL file when another database better
fits the workload. It restores directly into the source database engine;
Postgres requires the two-step conversion in \`portability\`.

Related: \`sw.db\`, \`portability\`, \`security-model\`.
`,

  'sql-compatibility': `# SQL compatibility — what Postgres code ports, and what doesn't

The platform translates a documented Postgres-flavored syntax subset. This is
not full Postgres compatibility: the default database keeps its own expression,
typing, comparison, and ordering semantics. Unsupported syntax fails with a
corrective error where it can be detected; valid cross-dialect SQL can still
produce a documented engine-specific result.

## Translated automatically

- \`NOW()\` becomes \`datetime('now')\`
- \`TRUE\` / \`FALSE\` become \`1\` / \`0\`
- \`ILIKE\` becomes \`LIKE\` (case-insensitive for ASCII)
- \`SERIAL\` becomes an auto-increment INTEGER PRIMARY KEY
- \`$1, $2, …\` placeholders become positional \`?\`
- \`col->>'key'\` and \`col->'key'\` become \`json_extract(col, '$.key')\`
- \`RETURNING\` on INSERT works natively

These are the exact spelling translations the platform implements; they do not
imply broader Postgres semantics.

## Runtime semantic seams (not translation targets)

- \`SELECT 1 / 0\` returns \`NULL\`; it does not throw a Postgres-style
  division-by-zero error. Guard the divisor explicitly when zero is invalid.
- Ascending \`ORDER BY\` places \`NULL\` first by default. Add \`NULLS LAST\`
  when that ordering is required.
- \`LIKE\` is case-insensitive for ASCII by default. Use explicit normalization
  when case behavior is part of the application contract.
- Integer operands use integer numeric affinity (\`5 / 2\` is \`2\`); use a real
  operand such as \`2.0\` when fractional division is required.
- \`RETURNING\` works for INSERT, UPDATE, and DELETE.

The database has a 30-second hard query ceiling. The runtime \`sw.db.query\`
surface does not expose a shorter true-cancellation contract. The external
\`db_query timeout_ms\` bounds how long the caller waits; it does not prove that
already-accepted database work was cancelled.

## Use this form (clean equivalent; auto-translation rolling out)

- Date math: \`created_at > NOW() - INTERVAL '7 days'\` → \`created_at > datetime('now','-7 days')\` (units: second, minute, hour, day, month, year)
- \`generate_series(1, 10)\` → \`WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM s WHERE n<10) SELECT n FROM s\`
- \`DISTINCT ON (user_id) … ORDER BY user_id, created_at DESC\` → wrap in \`ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC)\` and keep \`rn = 1\` (DISTINCT ON itself errors loudly with this exact fix — it isn't auto-rewritten, because a \`*\` select-list can't be rewritten safely without your schema)
- \`CREATE TYPE … AS ENUM('a','b')\` → \`col TEXT CHECK(col IN ('a','b'))\` (auto-translated when the CREATE TYPE and the table using it are in the same migration)
- \`array_agg(tag)\` → \`json_group_array(tag)\`

JSONB containment \`data @> '{"k":"v"}'\` auto-translates to \`json_extract(data,'$.k') = 'v'\` for the **flat case** — one or more keys whose values are scalar strings or numbers (multiple keys are AND-ed together, matching containment). Nested objects, array values, and boolean/null values are NOT auto-translated — they would risk silently matching the wrong rows, so they fail loud; write the explicit \`json_extract\` conditions yourself for those.

## Errors loudly with the fix (not supported as written)

- \`tags TEXT[]\` (any array type) → store as JSON text: \`tags TEXT DEFAULT '[]'\`, query with \`WHERE tag IN (SELECT value FROM json_each(tags))\`
- \`BEGIN; … COMMIT;\` in one query → use \`sw.db.batch([{ sql, params }, …])\` (atomic, all-or-nothing)
- \`GEOMETRY\`, \`GEOGRAPHY\`, \`TSVECTOR\`, \`HSTORE\`, \`INET\`, \`BYTEA\`, … → use full-text / \`sw.search\` / \`sw.fs\`; otherwise move the workload to Postgres

Arrays are the most common: store them as a JSON text column and unroll with \`json_each()\` for querying.

## Provided as a primitive (don't emulate Postgres)

- Full-text search — native: \`CREATE VIRTUAL TABLE docs USING fts5(title, body)\`, then \`WHERE docs MATCH 'term'\`. Or \`sw.search\` for embeddings + ranking.
- Vector / semantic search — \`sw.search\` (no separate vector database).
- Per-user row security — the structured builder
  \`sw.db.from/insert/update/remove\` on a declared \`scoped\` table, instead of
  CREATE POLICY.

## Not available on the managed database

PL/pgSQL (write logic in your server function), PostGIS, table
partitioning, and custom engine index types (GIN/GiST/BRIN — use an
app-managed index table + FTS5). For genuinely Postgres-only needs, export and
move the workload to Postgres. The platform does not provide a managed Postgres
adapter or an automatic migration service.

Related: \`database-engine\`, \`sw.db\`, \`portability\`.
`,

  'cors': `# CORS — which browser origins may call your \`/api/*\` functions

Read this when a browser call to your API returns
\`403 {"ok":false,"error":"ORIGIN_NOT_ALLOWED"}\`, or before you point a
frontend hosted elsewhere at a somewhere.tech project.

## Your own origins are allowed by construction — nothing to configure

While the platform is serving your project on a host, that host's origin is
your project's own origin. There is no row to write and nothing to turn on:

- your **production** project URL, \`https://<subdomain>.somewhere.site\`
- every **verified custom domain** attached to the project
- your **private preview** URL

A brand-new project has an empty allowlist and its own frontend still works.
If you are calling your API from a page the platform served for that same
project, the allowlist is not your problem — read "Diagnose a 403" below.

The one nuance: a preview origin is admitted while the preview host is being
served, and a production origin while production is being served. It is not a
cross-environment grant, so a page on your production host calling your
preview host is a third-party call and needs the allowlist.

## The allowlist is for THIRD-PARTY origins only

Configure an origin when the page making the call is **not** served by this
project — a frontend you host elsewhere, a marketing site on another
domain, a local dev server on \`http://localhost:5173\`, or another
somewhere.tech project.

There is no somewhere project allowed-origins subcommand. The allowlist is
a platform tool, reached from the CLI through \`somewhere call\`:

\`\`\`bash
# Read the current list first — set replaces it wholesale.
somewhere call project_allowed_origins_get '{"project_id":"my-app"}'

# Replace the FULL list. Include everything you want kept.
somewhere call project_allowed_origins_set '{"project_id":"my-app","allowed_origins":["https://app.example.com","http://localhost:5173"]}'

# Clear it.
somewhere call project_allowed_origins_set '{"project_id":"my-app","allowed_origins":[]}'
\`\`\`

Over MCP the same tools are \`project_allowed_origins_get\` and
\`project_allowed_origins_set\`. The dashboard's Settings → CORS does the same
thing. \`project_id\` accepts the project UUID, subdomain, or slug and is
resolved server-side; the response echoes the resolved \`project_id\`, so use
that value in follow-up calls rather than a shortened name.

Rules the platform enforces on each entry:

- An **exact origin**: scheme + host + optional port. No path, query,
  fragment, credentials, or wildcards — \`https://app.example.com/\` and
  \`https://*.example.com\` are both rejected with \`VALIDATION_ERROR\`.
- \`https\` only, except \`http://localhost\` and \`http://127.0.0.1\`.
- Matching is **byte-exact**. A different subdomain, a different port, and a
  trailing slash are each a different origin and must be listed on their own.
- At most 50 origins per project.
- Reading the list is open to any project member; changing it is the project
  **owner or a platform admin** only, and every change is audited.

## What is refused, and what reaches your function

The check applies to \`/api/*\` only, and it is about **credentials**, not
about blocking traffic:

| Request | Outcome |
|---|---|
| No \`Origin\` header (server-to-server, \`curl\`, a mobile app) | Reaches your function. CORS is a browser mechanism; a non-browser caller is unaffected. |
| Approved origin (own or configured) | Reaches your function. The platform adds the CORS response headers, including \`Access-Control-Allow-Credentials\`. |
| Approved origin, \`OPTIONS\` preflight | Answered by the platform with \`204\` and those headers. You never write preflight boilerplate. |
| Unapproved origin, **no** \`Cookie\` and **no** \`Authorization\`, method \`GET\`/\`HEAD\`/\`POST\` | Reaches your function, with **no** platform CORS headers. Whether the browser may read the result is decided by the headers your own handler sets. |
| Unapproved origin carrying \`Cookie\` or \`Authorization\` | Refused with \`403 {"ok":false,"error":"ORIGIN_NOT_ALLOWED"}\` before your code runs. |
| Unapproved origin, preflight advertising a method other than \`GET\`/\`HEAD\`/\`POST\`, or \`Authorization\`/\`Cookie\` in \`Access-Control-Request-Headers\` | Same \`403\`. The preflight is announcing a credentialed follow-up. |

So a deliberately public, credentialless API stays possible: set your own
\`Access-Control-Allow-Origin: *\` (without \`Access-Control-Allow-Credentials\`)
in the handler's response. When your handler sets its own
\`Access-Control-Allow-Origin\`, that header wins and the platform layers
nothing on top.

## Diagnose a 403 ORIGIN_NOT_ALLOWED

1. Read the exact \`Origin\` header the browser sent — the DevTools Network
   tab shows it on the failing request. That string, byte for byte, is what
   has to match.
2. Is it a host the platform serves for **this** project (production URL,
   verified custom domain, this project's preview)? Then it is already
   allowed, and the failure is something else: a stale bookmark on an old
   subdomain, a call aimed at a different project, or a custom domain that is
   attached but not yet verified. Check with
   \`somewhere call project_get '{"project_id":"my-app"}'\` and
   \`somewhere call domain_list '{"project_id":"my-app"}'\`.
3. Otherwise it is a third-party origin: add it with
   \`project_allowed_origins_set\`, sending the full list.
4. Not from a browser at all? Then \`ORIGIN_NOT_ALLOWED\` means something is
   forwarding an \`Origin\` header along with a cookie or bearer token. Drop
   the \`Origin\` header, or list that origin.

## Legacy mode

A small number of projects created before the origin policy landed are
**grandfathered**: their \`/api/*\` responses still carry the old permissive
CORS headers and no origin is refused. \`project_allowed_origins_get\` reports
this as \`cors_mode: "legacy"\`; every other project reports \`"safe"\`.
Building against \`legacy\` is building against a behaviour that is on its way
out — write the allowlist as if you were on \`safe\`.

Related: \`security-model\`, \`auth-client\`, \`troubleshooting\`.
`,

  'security-model': `# Security model — who can read/write what

## Three actor classes

1. **End users** of your app — sign up via \`sw.auth\`. Get a JWT in
   cookies or \`Authorization: Bearer …\`. Identified by
   \`sw.auth.fromRequest(req)\`. Cannot run raw SQL from the browser.
2. **Your server functions** — code you deploy under \`api/*\`. Run with
   project-level credentials. Can run raw SQL, hit any \`sw.*\` method,
   read env vars.
3. **You (the developer)** — somewhere.tech account, smt_ API key.
   Can deploy, change settings, query the database via MCP / dashboard,
   access logs.

## Data access via the CLI, MCP server & API

The somewhere MCP server and \`somewhere\` CLI are clients for your own control plane. They let an agent or developer manage YOUR account — create projects, deploy code, run database queries, manage files, secrets, and domains.

- Authentication: OAuth 2.0 (MCP) or interactive browser login (\`somewhere auth login\`, CLI). The session token is stored locally in \`~/.somewhere/config.json\` and sent only to \`api.somewhere.tech\` / \`mcp.somewhere.tech\` over HTTPS. We never request, read, or store third-party passwords. A revocable \`smt_\` API key is offered for CI; it is the only long-lived credential.
- Scope: the token acts as your developer identity — it can perform any action your account can (read/write your projects' source, databases, stored files, environment variables/secrets, deploys, billing config) and ONLY for resources your account owns, never another user's. During \`somewhere deploy\` the CLI reads the project source in the working directory to upload it and reads nothing outside that directory.
- What it does not do: it does not read arbitrary files on your machine, harvest environment variables, touch other applications' credentials, or contact any host other than the somewhere.tech API. Secret VALUES are write-only through these tools — they cannot be read back.
- Revocation is immediate: revoke from the dashboard (connected clients / API keys) or delete \`~/.somewhere/config.json\`.

## Per-user data access

For data scoped to an end-user (notes, orders, messages, etc.), declare the
table's owner column (\`intent: 'scoped'\`) and use the structured builder — it
scopes to the request's verified user automatically, with no user argument:

\`\`\`js
// auto-scoped to the signed-in user
const mine = await sw.db.from('notes');
await sw.db.insert('notes', { body }); // owner column set by the platform
\`\`\`

On managed projects, ordinary \`sw.db.query\` / \`sw.db.batch\` are refused.
For an intentional raw read, authorize the caller first and use
\`sw.db.server.query\` / \`sw.db.server.batch\`; those calls are never scoped or
rewritten for you.

## Can raw SQL bypass scoping?

- **From browser code:** no. App-user database access is structured table
  access; raw SQL endpoints refuse app-user credentials.
- **From your own server code:** only deliberately. A trusted server function
  must authorize the caller and select \`sw.db.server.query\` or
  \`sw.db.server.batch\` for an intentional raw read. Options on ordinary raw
  calls do not grant server authority in managed mode.
- **Via the MCP \`db_query\` tool:** yes — but only with your developer
  key (smt_), never with an end-user JWT.

## Deploy-time + on-demand review

- **Every deploy** runs a regex scanner that catches the obvious shapes
  (auth bypass, raw SQL, payment metadata spoof, env leakage, eval,
  RCE). Hits surface as \`warnings[]\` in the deploy response — advisory
  only, never blocks.
- **On-demand** (\`security_review\` MCP tool, also via dashboard) runs
  an LLM over the deployed code and returns a Markdown report with
  WHAT/WHERE/IMPACT/FIX per finding. Higher tiers use a stronger model;
  per-run cost is at /v1/pricing.

## Server-side secrets

- \`sw.env.SECRET_NAME\` — server-side. Reading it inside a handler is
  fine. Returning it in a response (\`Response.json(sw.env)\`) is a leak;
  the security review flags this shape.
- \`VITE_*\` / \`REACT_APP_*\` names are the exception and are NOT server-side:
  the compiler writes those values into your browser JavaScript as plain text,
  where every visitor can read them. Only give a variable one of those names
  when the value is meant to be public (an API base URL, a publishable key),
  and set it with \`public: true\`. A secret named \`VITE_STRIPE_SECRET\` is
  published, not protected.
- Stripe keys, API keys, model keys: set via \`somewhere env set KEY value\`
  or the dashboard. Stored encrypted. Keep them prefix-free.

## Admin paths

- \`sw.auth.admin\` (privileged auth ops — impersonate, delete user,
  list all users) is not callable inside deployed functions — any call
  throws \`AUTH_ADMIN_REMOVED_FROM_RUNTIME\`. Use the developer-key
  surface instead (auth_user_update, auth_impersonate, …) from your
  own tooling.
- \`sw.db.migrate\` is removed from deployed functions; run schema changes with
  developer credentials through \`db_migrate\`, the CLI, or dashboard.
- \`sw.keys.*\` / \`sw.deploy.*\` are developer-key only.

## Runtime function key scope

Your deployed functions share one server credential
(\`PROJECT_API_KEY\`) that lives inside the \`sw.*\` helpers and is never
exposed to your code. On deploy it is scoped to exactly the
surfaces your functions use: a function that only calls \`sw.db\` and
\`sw.payments\` gets a key that can reach the database and payments
areas and nothing else — a call to an unused area is refused. This is
derived from your code automatically (no config), and every \`sw.*\`
surface keeps working unchanged. Functions deployed before this
shipped keep their prior full grant until their next deploy, so
nothing breaks mid-flight. If you reach the platform only through the
documented \`sw.*\` methods (the normal case), there is nothing to do.

## Auth token lifecycle

- Access tokens: 1 hour. Auto-refreshed inline — if expired and the
  refresh is valid, the response includes \`X-New-Access-Token\` +
  \`X-New-Refresh-Token\` headers (CORS exposes them).
- Refresh tokens: 30 days, rotated on use, with a 24h grace window so
  a slow client doesn't get logged out from a race.
- Revoke a session: \`auth_revoke_session\` (MCP) or
  \`DELETE /v1/auth/sessions/:id\` with a developer key.

## Your part — the seven app-security rules

The platform owns the boundaries above. Which of your users may do what —
application-level authorization — is yours. These seven rules are the whole of
it; on somewhere most are the floor, not homework. Paste the block into the
project's CLAUDE.md (or equivalent) so every session starts with it:

\`\`\`md
# Security rules (the browser is untrusted)
1. NEVER trust the client for identity: the user is who the SERVER says (verified session), never a user_id from a body, query param, or localStorage.
2. SCOPE EVERY QUERY to the signed-in user, server-side; default deny. Declare each table user-owned / shared / server-only (unsure = user-owned). Use sw.db.from / insert / update / remove for user-owned tables; any raw SQL carries its own WHERE user_id = ?.
3. THE BROWSER MAY NEVER WRITE PRIVILEGE FIELDS (role, is_admin, permissions, plan, balance, credits): server-set only; whitelist client-writable columns.
4. NO SECRETS IN CLIENT CODE: keys and tokens live in server env only and are read with sw.env inside a function; public keys are fine; if a secret reaches the page, rotate it.
5. AUTHORIZE ON THE SERVER, not in the UI: a hidden button is not a control; re-check the caller on every endpoint.
6. LOCK DOWN CORS: same-origin by default, explicit allowed origins only; never reflect an arbitrary Origin with credentials.
7. PARAMETERIZE EVERYTHING: no concatenated SQL; validate every input; treat every client field as hostile.
Server code stays free to do anything intended. These rules constrain the untrusted browser and the end-user credential only.
\`\`\`

The block is written for any coding agent, on any stack. Here, rule 1 is
enforced by the platform, rule 2 by the structured query API on user-owned
tables, and the deploy review flags the most common slips on 3, 4 and 5 — the
block keeps you honest about the rest.

Related: \`sw.auth\`, \`sw.db\`, \`common-mistakes\`.
`,

  'pricing-comparison': `# Pricing comparison — somewhere.tech vs the stack

You'd normally need a stack like:

| Service     | Typical cost            | Replaced by   |
|---|---|---|
| Vercel Pro  | $20/mo                  | hosting + functions |
| Supabase Pro| $25/mo                  | database + auth + storage |
| Clerk       | $25/mo + per-MAU        | auth |
| Resend      | $20/mo (50k/mo)         | email |
| Pinecone    | $70/mo (starter)        | vector search |
| Cron / queue | ~$10/mo (Upstash, etc) | background work |
| **Total**   | **~$170/mo + per-MAU**  | one stack |

## What somewhere.tech costs

| Tier        | $/mo | What's in it |
|---|---:|---|
| Free        | $0   | Unlimited projects and core application services |
| Builder     | $25  | Core services, paid limits, cron, recurring checks, and inbound email |
| Pro         | $50  | + inbox, more limits, advisory debugging, security review |
| Scale       | $100 | + highest limits |
| Enterprise  | contact us | Custom terms for larger teams — talk to us |

Unlimited projects + deploys on every tier. See
\`docs({ topic: 'billing' })\` for the canonical full list.

## What we do NOT charge for

- **Bandwidth**: zero egress fees. Vercel's Hobby tier caps you at
  100 GB/mo bandwidth; Pro is $40/TB after the first TB.
- **Build minutes**: unmetered. Vercel Pro is 6000 min/mo.
- **End users**: no per-user fees. Free includes 1,000 users per project;
  paid plans include unlimited users. Clerk's $25 Pro tier caps at 5K MAUs,
  then $0.02 each.
- Bandwidth and storage carry no extra usage charges.

## Payments & AI — what we DO charge

- **Payments**: Stripe Connect charges carry a 0.5% platform fee on top of
  Stripe's standard processing fees; each checkout response includes \`fee_percent\`.
- **AI**: the same all-in catalog rates apply on every tier. Free includes
  $0.50/month and paid plans include $5/billing period; allowance and prepaid
  ordering plus request limits are published at /v1/pricing.

Related: \`billing\`, \`vs-supabase\`, \`vs-vercel\`, \`portability\`.
`,

  'portability': `# Portability — getting your data out

The platform doesn't lock you in. Three exit paths, all one-shot:

## Full database dump

\`\`\`bash
# Via MCP (in Claude Code / any MCP client)
db_dump({ project_id: "my-app" })

# Via the CLI
somewhere db dump > backup.sql

# Via curl
curl -X POST https://api.somewhere.tech/v1/db/dump \\
  -H "Authorization: Bearer smt_..." \\
  -H "Content-Type: application/json" \\
  -d '{"project_id":"my-app"}' \\
  -o backup.sql
\`\`\`

Returns a single \`.sql\` file: schema (CREATE TABLE / INDEX / TRIGGER)
+ every row as INSERT statements + sequence state + transaction wrapper. It
restores directly into the source database engine. The dump is ONE captured
read — schema, rows and sequence state come from the same batch — and it is
all-or-nothing: a schema change during the capture is refused
(\`DUMP_SCHEMA_CHANGED\`, 409), a capture that cannot be confirmed is refused
(\`DUMP_CAPTURE_UNCONFIRMED\`, 503), an oversized capture query is refused
(\`DUMP_CAPTURE_LIMIT_EXCEEDED\`, 413), and in no case is a partial file
produced. Postgres is a real two-step conversion:

\`\`\`bash
sqlite3 backup.db < backup.sql
pgloader backup.db postgresql://user:pass@host/db
\`\`\`

## Neon integration status

Today, Neon is an external Postgres destination: create and configure the
database, run the conversion above, review dialect differences, and replace
\`sw.db\` calls manually.

**Planned, with no committed release date:** a direct managed Neon integration.
The scope under evaluation is guided provisioning, connection setup, and
migration assistance. It is not a promise of automatic or lossless conversion;
schema semantics, queries, authorization policy, transactions, region choice,
and recovery settings still require review.

Review the dialect seams in \`migration.txt\` after conversion. The platform
never sees the \`.sql\` after handing it to you. \`sw.db.dump()\` is not
available inside a deployed function; exporting the whole database requires
developer credentials.

Refusals, none of which produce a partial file: a table above 1,000,000
rows (\`DUMP_ROW_LIMIT_EXCEEDED\`, 413), a schema the dump cannot represent
(\`DUMP_UNSUPPORTED_SCHEMA\`, 422) — full-text (FTS5) tables with
internally stored content are captured with their declared options,
configuration and contents, including the platform's file search index,
and restore into a fresh database with MATCH intact; external-content and
contentless full-text tables, other virtual-table modules and
unpreservable sequence state refuse — table metadata that cannot be verified
(\`DUMP_SCHEMA_UNAVAILABLE\`, 503), a project that has no database yet
(\`DATABASE_NOT_INITIALIZED\`, 409 — the dump never creates one), an owner or
database that changed while the capture ran (\`DUMP_SOURCE_CHANGED\`, 409),
and table-access declarations that could not be read or were invalid
(\`DUMP_POLICY_UNAVAILABLE\`, 503; \`DUMP_POLICY_INVALID\`, 422). There is no
streaming dump above the row cap; narrow a large table with a filtered table
export.

**Policy is reported, not restored.** Table-access declarations and
sensitive-column marks are platform policy, not SQL. Their labels travel as
comment lines in the SQL preamble; the MCP tool parses them into
\`excluded_security_policy.policies\`. A warning appears only when that list
is non-empty. An empty list on a successful capture means no table-access
declarations were found in this capture; it does not establish that access is
safe or preserve your application's authorization, and member join
definitions and handler authorization are outside that list. Labels are
informational: a SQL restore never applies them. Re-declare after restoring
and verify with \`db_scope_list\`.

**The capture receipt.** The REST response carries it in the
\`X-Dump-Capture\` header and the MCP result as
\`excluded_security_policy.capture\` (v1). It holds identity, hashes and
times only — never the labels: the canonical \`project_id\` and
\`database_id\`, \`sql_sha256\` / \`schema_sha256\` / \`policy_sha256\`, and
\`policy_observed_at\`, \`data_observation_started_at\`,
\`data_observation_completed_at\`, \`binding_checked_at\`. Hashes let you
detect changed bytes against metadata you keep; they are not a signature, not
provenance, and not proof of a snapshot consistent across stores. Matching
binding checks before and after mean the same project, owner and database
were observed twice; they do not exclude a change between the observations.
When capture metadata is present but malformed, or its SQL or policy hash
does not match, the MCP tool returns \`DUMP_INTEGRITY_UNCONFIRMED\` (502) and
no SQL. An absent receipt (an older API during a rolling release) means no
capture-integrity evidence; the informational policy labels may still be
present. A dump restores data and schema; it makes no promise about the
destination's isolation.

## Per-table CSV

\`\`\`bash
db_export({ project_id: "my-app", table: "orders" })
\`\`\`

Up to 100K rows per call, optional filters. Useful for grabbing one
specific table when you don't need the full dump.

## File storage

\`\`\`bash
fs_read({ project_id: "my-app", path: "/" })        # list a directory
fs_read({ project_id: "my-app", path: "..." })      # one file
# Or browse via the dashboard's Files tab and download via signed URLs.
\`\`\`

## Source code

Your project's deployed functions live in the platform's file store.
Pull them back via:

\`\`\`bash
somewhere pull <project-id-or-subdomain>     # CLI clones into ./
\`\`\`

The code is standard JS/TS. The \`sw.*\` API is documented in
\`docs({ topic })\`; replacing it means swapping the binding for direct
serverless / Postgres / Stripe / external AI API calls. No proprietary
build step, no required framework — what you wrote runs on any
JS-compatible serverless runtime.

## What you cannot easily port

- The somewhere.site subdomain (\`<your-app>.somewhere.site\`) doesn't
  follow you. Custom domains do (you own the DNS).
- End-user password credentials require a separate email-approved export.
  The direct project owner runs \`somewhere auth export <project> --output <new-file>\`
  and enters the code sent to their current verified account email. The CLI
  creates a private file without printing hashes or overwriting existing files.
  It contains stable user IDs and supported bcrypt credentials, with explicit
  coverage counts and warnings for unsupported credentials. Passwordless users
  have no password to export; sessions, reset codes and MFA secrets are excluded.
- The dashboard, copilot, and security-review surfaces are platform
  features — they don't migrate, but your data + code does.

Related: \`sw.db\`, \`security-model\`, \`portability\`.
`,

  'vs-supabase': `# somewhere.tech vs Supabase — honest comparison

## When to use somewhere.tech

✓ **You want one platform for the whole backend.** Database + auth + files
  + email + payments + AI + cron + queues all behind one API and one bill.
  Supabase covers database + auth + storage + edge functions; you still
  wire Stripe, Resend, Inngest, Pinecone, OpenAI yourself.
✓ **You're shipping fast** — typically AI-built apps from Claude Code or
  Cursor. The MCP server gives the coding agent tools to deploy,
  query, and configure without leaving the chat.
✓ **Payments built in.** Stripe Connect is wired for you — no separate
  Stripe/billing integration to stand up. Supabase doesn't offer this.
✓ **Predictable pricing.** Flat monthly tiers — current ladder at /v1/pricing.
  No per-MAU jumps, no bandwidth overages, no project caps.

## When to use Supabase

✗ **Heavy Postgres dependency.** You already rely on pgvector tuning,
  PostGIS, JSON path queries with complex aggregations, listen/notify,
  or a Postgres-specific extension we don't substitute for.
✗ **Existing Supabase project with momentum.** No reason to migrate
  for migration's sake.
✗ **Complex relational data at scale (>10 GB single project).** Our
  database-per-project model has a 10 GB ceiling — fine for the typical
  app, not ideal for a multi-tenant warehouse.
✗ **Self-host requirement.** Supabase is open-source and you can
  self-host the whole thing. We are not self-hostable.
✗ **You want Postgres-native client libraries.** PostgREST, postgrest-js,
  the broader Postgres tooling ecosystem.

## What's roughly equivalent

| Need                | somewhere.tech              | Supabase                  |
|---|---|---|
| Database            | \`sw.db\` (full SQL)        | \`supabase.from()\` (Postgres) |
| Auth                | \`sw.auth\` (Google, magic link, MFA) | \`supabase.auth\` |
| Storage             | \`sw.fs\` (no egress fees)  | \`supabase.storage\` (S3) |
| Row-level security  | \`sw.db.from/insert/update\` (auto-scoped) | Postgres RLS policies |
| Realtime DB events  | developer-side \`db_webhook_*\` tools | Postgres replication |
| Vector search       | \`sw.search\` (built-in)     | pgvector (add-on) |
| Edge functions      | every \`api/*\` file         | \`/functions/v1/*\` |
| Email send/receive  | \`sw.email\` + \`sw.inbox\`    | not included — wire Resend |
| Payments            | \`sw.payments\`              | not included — wire Stripe |
| AI                  | \`sw.ai\` (multi-provider proxy) | not included — wire OpenAI |
| Background jobs     | \`sw.jobs\` / \`sw.queue\` / \`sw.cron\` | not included — wire Inngest |
| Pricing             | flat tiers — see /v1/pricing | $25/mo Pro + usage |

## Migration paths

→ **somewhere.tech → Supabase**: \`db_dump\` → load into a database file →
  \`pgloader\` that file into Postgres. Application data comes out in full.
  Password credentials travel separately: \`somewhere auth export <project>
  --output <new-file>\` requests verified-owner email approval, then downloads
  supported bcrypt credentials and stable user IDs into a private local file.
  \`db_dump\` and \`auth_users_list\` do not return hashes. Check the export's
  coverage and warnings: unsupported credentials require a password reset.
  Sessions, refresh tokens, reset codes and MFA secrets are never exported.
  See \`migration.txt\` for the same portability contract.
→ **Supabase → somewhere.tech**: \`pg_dump\` → import via \`db_migrate\` +
  \`db_import_csv\` per table. Auth users: export from Supabase via their
  admin API, then POST the rows to \`/v1/auth/import\` (up to 1,000 per
  request) — bcrypt is the default, so hashes import as-is and each user
  signs in with their existing password. \`auth_users_list\` is a READ tool
  and cannot create users; do not use it for import.

Related: \`portability\`, \`database-engine\`, \`pricing-comparison\`.
`,

  'vs-vercel': `# somewhere.tech vs Vercel — honest comparison

## Framework and backend responsibilities

Next.js is an application framework; Vercel is a hosting platform optimized for
running it. A Next.js application can integrate managed database, auth, files,
email, payments, AI, and job providers. The application team chooses those
providers and owns their credentials, SDKs, migrations, authorization policies,
webhooks, and cross-service diagnostics.

somewhere.tech hosts static or client-rendered React/Vite frontends and server
functions, and includes those backend capabilities behind one project contract.
It applies declared database permissions, generates the typed data client, and
connects deploy diagnostics to the same project. The application still owns its
business rules and the content it publishes.

## When to use somewhere.tech

✓ **You want backend included, not added on.** Database, auth, storage,
  email, payments, AI — all behind one API. Vercel gives you hosting +
  serverless functions; you still need Supabase / Neon / Clerk / Resend
  / Stripe / OpenAI / Inngest / Pinecone.
✓ **AI-built apps shipped from a chat client.** The MCP server lets
  Claude / Cursor deploy, query, and configure end-to-end. Vercel CLI
  is the equivalent for the hosting half, but the backend half lives
  in 7 different dashboards.
✓ **Predictable pricing on bandwidth and MAUs.** Vercel meters bandwidth
  ($40/TB after 1 TB on Pro), function invocations, and Edge Middleware
  invocations. We have zero egress fees and unlimited end-users.
✓ **One bill for the whole stack.** A flat monthly tier (see /v1/pricing)
  covers everything. A typical Vercel + Supabase + Clerk + Resend stack runs
  ~$170/mo before usage.

## When to use Vercel

✗ **You're shipping a Next.js app with ISR / SSR / app router.** Next.js
  is Vercel-native; SSR, ISR, on-demand revalidation, image optimization,
  middleware all work best there.
✗ **Existing team workflow.** GitHub-PR previews per branch, preview
  environment URLs, the Vercel deploy bot in your PRs. We have CLI
  deploys + dashboard previews, but not the same per-PR ergonomics.
✗ **Edge runtime + edge config + ISR cache.** If your app's whole
  identity is the edge-rendering story, Vercel's primitives are deeper
  than ours (we expose less of the edge-cache machinery directly).
✗ **You don't want any backend.** A pure static site with a few API
  routes that hit external services is what Vercel is best at. We're
  optimized for "needs a database + users."

## Rendering and SEO responsibilities

Next.js can render route output statically, from cached server work, or for a
request. Its App Router also provides metadata APIs and file conventions for
\`sitemap.xml\`, \`robots.txt\`, icons, and social images. The application chooses
the rendering and cache behavior and supplies the actual metadata and content.

somewhere.tech does not execute Next.js SSR, ISR, or App Router code. It compiles
raw React/Vite source, serves deployed HTML and assets, and runs \`api/*\` server
functions. For crawler-facing route content, deploy a separate HTML page for
that route or generate the HTML before deployment. A client-router-only path
shares the entry HTML and is not a separate crawler document. Deployment
screenshots are preview evidence, not rendered HTML for crawlers.

Edit titles, descriptions, canonical URLs, Open Graph tags, and other metadata
in the deployed HTML. If the project does not provide \`sitemap.xml\` or
\`robots.txt\`, the platform generates fallbacks; the sitemap enumerates only
deployed HTML pages. A custom file overrides its generated counterpart. Search
Console registration and ownership verification remain application work.

Next.js references: https://nextjs.org/docs/app/getting-started/partial-prerendering
and https://nextjs.org/docs/app/getting-started/metadata-and-og-images

## What's roughly equivalent

| Need              | somewhere.tech            | Vercel + …                |
|---|---|---|
| Static hosting    | every project, all tiers  | Vercel Hobby / Pro |
| Server functions  | \`api/*\` files             | \`/api/*\` Vercel functions |
| Database          | \`sw.db\` (built-in)        | Vercel Postgres / Neon / Supabase |
| Auth              | \`sw.auth\` (built-in)      | Clerk / Auth.js / NextAuth |
| File storage      | \`sw.fs\` (built-in)        | Vercel Blob / S3 / R2 |
| Email send        | \`sw.email\` (built-in)     | Resend / SendGrid |
| Payments          | \`sw.payments\` (built-in)  | Stripe (you wire it) |
| AI                | \`sw.ai\` (built-in)        | OpenAI SDK (you wire it) |
| Background jobs   | \`sw.jobs/queue/cron\`      | Vercel Cron / Inngest / QStash |
| Bandwidth         | unlimited (no egress fees)| 1 TB free, $40/TB |
| MAU pricing       | none                       | depends on auth provider |
| Pricing           | flat tiers — see /v1/pricing | $20 Pro + add-ons |

## Migration paths

→ **somewhere.tech → Vercel**: code is standard JS/TS. Replace \`sw.*\`
  bindings with direct service calls (Neon for DB, S3 for files, Resend
  for email, Stripe SDK for payments). \`db_dump\` → load into a database file
  → \`pgloader\` that file into Neon Postgres.
→ **Vercel → somewhere.tech**: copy your \`api/*\` route handlers in,
  swap \`@vercel/postgres\` calls for \`sw.db.query\`, swap your auth
  provider for \`sw.auth\`. Wiring takes hours, not days, because the
  shapes are similar.

Related: \`portability\`, \`pricing-comparison\`, \`vs-supabase\`.
`,

  'design-system': `# Design System — Read before generating UI

> One reference for every agent writing frontend code on somewhere.tech.
> Mirror at https://somewhere.tech/llms-design-system.txt (plain text,
> identical content). Update the topic + the public file together.

## Rule zero: deploy raw source, don't build

The platform compiles JSX/TSX on deploy. Never run
\`npm run build\`, \`vite build\`, or any bundler before \`somewhere
deploy\`. Push raw \`.tsx\` / \`.css\` / \`.html\`. Build output gets
rejected with \`BUNDLED_DEPLOY_REJECTED\` unless \`--prebuilt\`, the project
setting, or \`allow_bundled: true\` explicitly opts out. Visual editors (overlay
annotator, \`project_design_tokens\`, \`project_patch\` find/replace,
source-map resolution) all break against bundled output.

## The edit→deploy→verify loop

Read the live source, make the smallest coherent edit, run the relevant local
check, deploy once, and verify the public \`<slug>.somewhere.site\` URL. The
default workflow has no staging or private-preview step.

## CSS variable convention (theme-correct by default)

**The one rule: never hardcode a hex color in a component file.** Use
CSS custom properties from \`globals.css\`. They auto-switch on
\`<html data-theme="light">\`.

Bad — breaks in light mode:
\`<div style={{ background: '#1a1a1e', color: '#e5e5e5' }}>…</div>\`

Good — themes automatically:
\`<div style={{ background: 'var(--surface)', color: 'var(--text)' }}>…</div>\`

The canonical var set (define both \`:root\` and
\`[data-theme="light"]\` overrides in \`globals.css\`):

| Token | Use |
|---|---|
| \`--bg\`, \`--surface\`, \`--surface-2\`, \`--bg-2\` | Page / cards / hover / code blocks |
| \`--text\`, \`--text-muted\`, \`--text-dim\` | Body / labels / metadata |
| \`--border\`, \`--border-strong\` | Dividers, emphasized dividers |
| \`--brand\`, \`--brand-deep\`, \`--brand-glow\` | Primary CTA / hover / halo |
| \`--success\`, \`--warning\`, \`--danger\` | Status pills |

If a color you need isn't in the set, **add a var** rather than
sprinkling raw hex. Pair every \`:root\` definition with a
\`[data-theme="light"]\` override at the same time — otherwise the
component silently breaks in light mode.

## Font pairing — defaults that work

Default font stack (system-first, zero load, theme-clean):
\`font-family: -apple-system, system-ui, 'Segoe UI', Roboto, sans-serif;\`

If a project wants a display font, pair ONE display face with ONE
neutral body face. Two safe pairings:

- Display: Inter (heading 600–700) + body: Inter (400). Single
  family, two weights. Cheapest perf, no FOUT.
- Display: Fraunces (serif, 600) + body: Inter (400). Editorial feel,
  still readable at small sizes.

**Banned by default** (perf + readability traps): Roboto Slab, Open
Sans (overused, looks generic), Comic Sans MS (obvious), Times New
Roman (default browser fallback — pick something or use the system
stack), Papyrus, Brush Script, anything calligraphic.

For brand-led marketing pages where personality matters, the founder
can override the defaults — but the project-level decision lives in
\`globals.css\` as a single \`--font-display\` / \`--font-body\` pair,
not scattered \`font-family: …\` declarations across components.

## Layout

- Single content column on mobile (\`max-width: min(100% - 2rem, 720px)\`,
  centered).
- Two-column from \`768px\` up via CSS grid, not flexbox-juggling.
- Spacing scale (4-base): 4, 8, 12, 16, 24, 32, 48, 64 px — pick from
  this set rather than freehand pixel values. Store as \`--space-1\` …
  \`--space-8\` in \`globals.css\` for consistency.
- Avoid sticky / fixed positioning except for the top nav. Sticky
  footers and pinned CTAs feel cheap.

## Animation

- Hover: \`transition: all 0.15s ease\`. Anything slower feels laggy on
  buttons.
- Page transitions: skip them. The dashboard / app surfaces should
  feel like native software, not a slideshow.
- Loading states: a thin 1px progress bar in \`var(--brand)\` at the top
  of the surface reads as "we're working." A centered spinner reads as
  "we're stuck."

## Self-check before \`somewhere deploy\`

1. Toggle \`data-theme="light"\` on \`<html>\` in DevTools — does every
   surface still read correctly? Any inline hex in a component
   \`style={...}\` is a near-certain failure.
2. Resize to 375px wide — does anything overflow horizontally?
3. Tab through with the keyboard — is the focus ring visible on every
   interactive element?
4. Visit the public \`<slug>.somewhere.site\` URL after deploying — does
   the live page render the same as your source? (If not, you probably
   built instead of pushing raw source.)

## Tone directions (placeholder — founder fills)

The 11 tone directions (founder's canonical list) live in the founder's
prompt doc; until they're pasted in here verbatim, the safe default is
"plain, calm, technical — like a senior engineer's README." Avoid
marketing-speak ("supercharge", "revolutionary"). Prefer concrete
nouns over abstractions ("60-second deploy" beats "fast iteration").

## Variance directive (placeholder — founder fills)

When generating multiple visual variants for a single design ask,
ensure the variants differ along at least TWO axes — e.g. layout AND
type scale, not just color. A "blue version / green version" isn't
variance. The founder's full variance prompt is pending paste-in.

Related: \`sw.image\`, \`deploy\`, \`portability\`.
`,
};

/** Shell-less first-run body. Kept outside PLATFORM_HELP_TOPICS so the
 * generated all-client docs retain the complete CLI reference while the MCP
 * handler can replace that body for connector callers with steps they can
 * actually execute. */
export const CLAUDE_CONNECTOR_GETTING_STARTED_HELP = `# Getting Started — Build through the Claude connector

This guide uses connector tools and does not require a terminal. Complete
the first app with tool calls:

1. \`project_create\` with a \`name\` (and optional \`subdomain\`). It returns the
   \`project_id\` every other call takes.
2. Author the source. Declare every table in \`db/schema.ts\` — a declaration
   the platform reads, never code that runs: \`owner()\` for per-user rows,
   \`shared()\` for intentional cross-user rows, \`serverOnly()\` for trusted
   server access. Pages and assets go in \`files\`; route handlers such as
   \`api/hello.ts\` go in \`functions\` and \`export default async function (req, sw)\`,
   reading rows with \`sw.db.from('table')\`. Contracts:
   \`docs({ topic: 'database' })\`, \`docs({ topic: 'functions' })\`,
   \`docs({ topic: 'sw.auth' })\`.
3. \`project_deploy\` with \`project_id\`, \`files: [{ path, content }]\` and
   \`functions: [{ path, content }]\`. The platform compiles the source,
   applies the schema file (creating missing tables and recording each
   table's scope) and publishes at the live URL. No build step. To change the
   database, deploy the changed schema file; \`db_migrate\` runs explicit SQL
   migrations; \`db_query\` reads or writes
   rows with SQL (writes persist).
4. Confirm what shipped: \`project_deploys\` (version and outcome),
   \`project_get\` (live URL and release), \`project_files_list\` /
   \`project_file_read\` / \`project_grep\` (the uploaded source),
   \`db_describe\` (tables and row counts) and \`db_scope_list\` (the scopes
   recorded). \`db_scope_set\` is only for a table that already existed before
   the schema file declared its owner column.
5. \`site_verify\` with \`project_id\` and the live \`url\` (optional
   \`actions\`, \`expect_requests\`, \`viewports\`) runs one browser flow across
   desktop and phone and returns one structured verdict; \`site_check\` /
   \`site_check_status\` record and read a site check. When a verdict points
   at a file, fix that file with \`project_patch\` (\`path\` plus \`find\` /
   \`replace\`, or full \`content\`), which redeploys. If a deploy made things
   worse, \`project_rollback\` restores the previous code; \`with_schema: true\`
   also restores the previous schema through the deployment checks, and
   \`preview: true\` returns the plan without applying it.

One-off work against the live project: \`run_code\` executes a short
ES-module script whose default async function receives \`sw\`; writes persist,
the script is temporary, \`session_id\` keeps explicitly returned JSON between
runs, and \`include_env\` exposes project secrets only when true. Connector
runs cannot generate AI media (image generation, speech synthesis, background
removal) or move money (payment capture, release, refund); text responses,
website generation and refund reads remain available. From a terminal, the CLI
runs the same scripts without these restrictions.

Anything without a dedicated tool: \`api_read\` sends up to 10 independent
GET/HEAD requests and \`api_write\` up to 10 independent POST/PUT/PATCH/DELETE
requests against the REST reference at \`https://somewhere.tech/docs.txt\`,
one result per request in input order; a batch is not a transaction — some
requests may succeed while others fail.

Also on this connector: app users (\`auth_signup\`, \`auth_login\`, \`auth_me\`,
\`auth_users_list\`), \`email_send\` from an authorized project, project
files (\`fs_read\`, \`fs_write\`, \`fs_upload\`, \`fs_public_url\`,
\`fs_signed_url\`), domains
(\`domain_check\` for availability and price, \`domain_add\`, \`domain_verify\`
— purchase happens in the dashboard), data (\`db_dump\` exports data;
\`db_import\` introspects an existing table and generates its schema
declaration — it does not import data), tasks (\`tasks_list\`, \`tasks_get\`,
\`tasks_create\`, \`tasks_update\`, with attachments), \`ai_complete\` for a
text response charged to the project, \`security_review\` of the deployed
source, \`project_docs\` / \`docs_query\` (bounded with \`path\`, \`symbol\` or
\`route\`) / \`project_export\` for reading a project, \`catalog\` for the tool
list, and \`connector_link_email\` for an account recovery link.

Not available through this connector by policy: AI media (image generation,
speech synthesis, background removal); money movement (payment capture,
release, refund); creating new credentials or platform-internal operations
through the generic API. Website generation and refund reads are available.
Domain purchase is completed in the dashboard by design, not by policy;
\`domain_check\` still reports availability and price. From a terminal, the Somewhere CLI is the primary
surface, needs no connector, and carries none of these restrictions.
`;

export const CONNECTOR_GETTING_STARTED_HELP = `# Getting Started — Build through MCP

This client has no terminal. Complete the whole first app with tool calls:

1. Call \`project_create\` with a name and subdomain.
2. Call \`project_deploy\` with raw source: static files in \`files\` and
   route handlers such as \`api/hello.ts\` in \`functions\`. The platform
   compiles the source.
3. Apply schema changes with \`db_migrate\`; read and write rows with
   \`db_query\`.
4. Confirm the uploaded source with \`project_file_read\` and the deploy
   version with \`project_deploys\`.
5. Run \`site_verify\` for the action flow, page/console/network health, and
   desktop + phone screenshots in one call; inspect \`errors\` and
   \`project_logs\` only when its report points there, then fix a single file
   with \`project_patch\`.

No install, login, init, or shell command is part of this path.
`;

/** Consistent cross-link appended to EVERY resolved topic (founder
 *  directive 2026-06-17): the static manual answers ONE surface, but most
 *  real questions span surfaces or depend on the project's live state —
 *  so every topic ends by pointing at the project-aware advisor. One
 *  footer, identical across all topics. Not added to the "topic not found"
 *  message (that already routes the agent to the topic list). */
const ADVISOR_FOOTER =
  '\n\n---\n\n→ Building this on your project, or spanning surfaces? ' +
  'Ask `advisor({ question, project_id })` — an expert that sees your live project.';

const PLATFORM_HELP_TOPIC_SYNONYMS: Readonly<Record<string, string>> = {
  files: 'sw.fs',
  origins: 'cors',
  'allowed-origins': 'cors',
  'cross-origin': 'cors',
  'origin-not-allowed': 'cors',
  drafts: 'dev-environments',
  draft: 'dev-environments',
  'dev-env': 'dev-environments',
  'dev-prod': 'dev-environments',
  preview: 'dev-environments',
  staging: 'dev-environments',
  promote: 'dev-environments',
  rollback: 'dev-environments',
  fetch: 'sw.fetch',
  http: 'sw.fetch',
  outbound: 'sw.fetch',
  'outbound-http': 'sw.fetch',
  'outbound-request': 'sw.fetch',
  'outbound-http-request': 'sw.fetch',
};

interface PlatformHelpTopicMatch {
  key: string;
  alternatives: string[];
}

function resolvePlatformHelpTopic(topic: string): PlatformHelpTopicMatch | null {
  const raw = (topic || '').trim();
  const lowerKey = raw.toLowerCase();
  const normalizedQueryKey = lowerKey.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const describesOutboundRequest = /\boutbound\b/.test(lowerKey) && /\b(?:fetch|https?|request)\b/.test(lowerKey);
  const key = PLATFORM_HELP_TOPIC_SYNONYMS[lowerKey]
    ?? PLATFORM_HELP_TOPIC_SYNONYMS[normalizedQueryKey]
    ?? (describesOutboundRequest ? 'sw.fetch' : raw);
  if (PLATFORM_HELP_TOPICS[key]) return { key, alternatives: [] };

  const norm = (value: string) => value.toLowerCase().replace(/^sw\./, '').replace(/[^a-z0-9]/g, '');
  const q = norm(key);
  if (!q) return null;
  const keys = Object.keys(PLATFORM_HELP_TOPICS);
  const exactNorm = keys.find((candidate) => norm(candidate) === q);
  if (exactNorm) return { key: exactNorm, alternatives: [] };
  const subs = keys.filter((candidate) => {
    const normalizedCandidate = norm(candidate);
    return normalizedCandidate.length >= 3 && (normalizedCandidate.includes(q) || q.includes(normalizedCandidate));
  });
  if (subs.length === 0) return null;
  const best = subs.slice().sort((a, b) => norm(a).length - norm(b).length)[0];
  return { key: best, alternatives: subs.filter((candidate) => candidate !== best) };
}

export function platformHelpTopicExists(topic: string): boolean {
  return resolvePlatformHelpTopic(topic) !== null;
}

// Topic bodies may carry `<!--layer:surface|contract|why-->` provenance
// markers (documentation philosophy tsk_a8935456). scripts/generate-docs.mjs
// strips them for the web surfaces; every RUNTIME serve path (docs({topic}) and
// the advisor's topic ingestion) must strip them too so a marker never reaches
// a caller. Single choke point — call this wherever a raw topic body is served.
export function stripDocLayerMarkers(body: string): string {
  return body.replace(/^[ \t]*<!--layer:(?:surface|contract|why)-->[ \t]*\n?/gim, '');
}

export function platformHelp(topic: string): string {
  const raw = (topic || '').trim();
  const match = resolvePlatformHelpTopic(raw);
  if (match) {
    const prefix = match.alternatives.length > 0
      ? `(Showing the closest topic "${match.key}" for "${raw}" — also: ${match.alternatives.join(', ')}.)\n\n`
      : '';
    return prefix + stripDocLayerMarkers(PLATFORM_HELP_TOPICS[match.key]) + ADVISOR_FOOTER;
  }

  const available = Object.keys(PLATFORM_HELP_TOPICS).sort().join(', ');
  return `Topic "${raw}" not found.\n\nAvailable topics: ${available}\n\nCall docs({ topic: "<one of the above>" }).`;
}

/**
 * Advisor dependency edges between canonical topics (editorial-owned; the
 * selector reports missing/budget receipts). Key = a selected topic; each
 * edge adds either the whole dependent topic, or the exact section named by
 * `heading`. Traversal semantics — a headed edge is a LEAF: it pins that one
 * section's bytes and does not follow the target topic's own edges. Only an
 * unheaded (whole-topic) edge recurses, with a visited set ending cycles.
 * A topic selected as a root still expands its own edges. This is why a
 * payments question pins two sw.auth sections without importing sw.auth's
 * browser-session and response-shape dependencies (replay case 110). Every
 * key, topic and heading must exist — enforced by
 * scripts/test-advisor-topic-dependencies.mjs (run by docs-lint); the
 * selector's leaf/recurse fixtures live with the selector.
 */
export const ADVISOR_TOPIC_DEPENDENCIES: Readonly<Record<string, readonly { topic: string; heading?: string }[]>> = Object.freeze({
  // Auth answers need the browser session model, the shared response contract
  // and the handler shape the callback lives in.
  'sw.auth': [
    // Headed self-references make the magic-link and browser-session packet
    // complete without topic ranking; the consumer's visited set ends cycles.
    { topic: 'sw.auth', heading: '## Magic links (passwordless sign-in)' },
    { topic: 'sw.auth', heading: '## Browser sessions — use httpOnly cookies, not tokens' },
    { topic: 'auth-client', heading: '## 3. Browser happy path — zero dependencies' },
    { topic: 'auth-client', heading: '## Response shapes — one contract' },
    { topic: 'functions', heading: '## Format' },
    { topic: 'functions', heading: '## Redirects' },
  ],
  'auth-client': [
    { topic: 'sw.auth', heading: '## Browser sessions — use httpOnly cookies, not tokens' },
  ],
  // A cron or queue handler is a jobs-style handler in a deployed function.
  'cron': [
    // Own headed references so registration, the signed handler and the
    // hourly-cleanup recipe enter every scheduled-work packet.
    { topic: 'cron', heading: '## Create a schedule' },
    { topic: 'cron', heading: '## Handler' },
    { topic: 'cron', heading: '## Recipe — hourly cleanup of stale rows' },
    { topic: 'sw.jobs', heading: '## Job handler function' },
    { topic: 'functions', heading: '## Format' },
  ],
  'sw.queue': [
    { topic: 'sw.jobs', heading: '## Job handler function' },
  ],
  // Payments flows are distinguished in their own topic; signatures and the
  // caller identity come from these.
  'payments': [
    // Replay79/110: a live app may request test-mode Checkout; preserve the
    // stand-in/onboarding contract so app wording never implies live charges.
    { topic: 'payments', heading: '## You DO NOT need to onboard to start building' },
    // Own headed reference so ranking cannot omit the Stripe verification;
    // the project drain (payment.completed) and subscription system are
    // separate signature contracts, referenced by their owners.
    { topic: 'payments', heading: '### Verifying a second Stripe destination in your function' },
    // Per-flow emissions: which flows deliver a project event, which update
    // the user row, which emit nothing. Without it the verifier alone reads
    // as "every fulfilment needs a second Stripe destination" (replay 49,
    // 97, 98). Separate from the direct Stripe signature above.
    { topic: 'payments', heading: '## Webhook events — what each flow actually emits' },
    { topic: 'sw.auth', heading: '## Lifecycle webhook (clean up your own tables on user delete)' },
    { topic: 'projects', heading: '## Outbound webhook subscriptions — the raw-body signature' },
    { topic: 'sw.auth', heading: '## Get the user from a request — start here' },
    { topic: 'functions', heading: '## Format' },
  ],
  // Image generation writes files.
  'sw.image': [
    { topic: 'sw.fs', heading: '## sw.fs.write(path, content, options?)' },
  ],
  // Database answers carry the handler signature the examples assume.
  'sw.db': [
    // Own headed reference: the exact verb/where shapes must enter every
    // database packet regardless of ranking.
    { topic: 'sw.db', heading: '### Builder verbs and where-shapes' },
    { topic: 'sw.db', heading: '## sw.db.tx(intents) — all-or-nothing composed writes' },
    { topic: 'functions', heading: '## Format' },
  ],
  // Replay 179/180: a reminder-email or public-screenshot workflow needs the
  // send contract and the public-URL contract pinned once the selector
  // recognises the request; these are self-references, not blanket
  // cron→email or browser→files edges.
  'sw.email': [
    { topic: 'sw.email', heading: '## sw.email.send(message)' },
  ],
  'sw.fs': [
    { topic: 'sw.fs', heading: '## sw.fs.public_url(path, { makePublic? })' },
    { topic: 'sw.fs', heading: '## Public URL' },
  ],
  'deploy': [
    { topic: 'verify-before-deploy' },
  ],
});
