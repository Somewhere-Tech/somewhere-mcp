#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
/**
 * Every caller-visible tool failure crosses the real MCP worker through the
 * official TypeScript SDK client. This catches invalid outer JSON-RPC and the
 * subtler failure where a result text block is JSON followed by prose.
 */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const output = await build({
  entryPoints: [fileURLToPath(new URL('../src/index.ts', import.meta.url))],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  write: false,
  logLevel: 'silent',
});
const worker = await import(
  'data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].text).toString('base64')
);

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const pending = [];
const api = {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/v1/projects') {
      return Response.json({ ok: true, data: { projects: [] } });
    }
    if (request.method === 'POST' && url.pathname === '/v1/projects') {
      return Response.json({
        ok: true,
        data: { id: PROJECT_ID, project_id: PROJECT_ID, subdomain: 'json-envelope-fixture' },
      });
    }
    if (url.pathname.includes('notifications') || url.pathname.includes('notices')) {
      return Response.json({ ok: true, data: { notices: [], newly_delivered_notice_ids: [] } });
    }
    return Response.json({ ok: true, data: {} });
  },
};
const env = {
  API_BASE_URL: 'https://api.test',
  API_SERVICE: api,
  SOMEWHERE_TECH_ADMIN_KEY: 'fixture-admin-key',
};
const executionContext = {
  waitUntil(promise) { pending.push(Promise.resolve(promise)); },
};

const transport = new StreamableHTTPClientTransport(
  new URL('https://mcp.test/mcp?groups=all'),
  {
    requestInit: {
      headers: {
        Authorization: 'Bearer smt_fixture',
        'User-Agent': 'mcp-sdk-json-envelope-contract',
      },
    },
    fetch: async (input, init) => worker.default.fetch(
      new Request(input, init),
      env,
      executionContext,
    ),
  },
);
const client = new Client({ name: 'json-envelope-contract', version: '1.0.0' });

await client.connect(transport);
try {
  const tools = [];
  let cursor;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  assert.ok(tools.length > 0, 'the official client listed caller-visible tools');

  // A non-UUID project reference forces every tool through the shared early
  // project-resolution failure without touching a product resource. Before
  // the fix this returned bare prose. Every advertised tool must now expose
  // one parseable JSON error payload through the official SDK client.
  for (const tool of tools) {
    const result = await client.callTool({
      name: tool.name,
      arguments: { project_id: 'json-envelope-fixture-missing' },
    });
    assert.equal(result.isError, true, `${tool.name}: fixture call must fail`);
    const textBlocks = result.content.filter((block) => block.type === 'text');
    assert.equal(textBlocks.length, 1, `${tool.name}: failure has one text envelope`);
    const payload = JSON.parse(textBlocks[0].text);
    assert.equal(payload.ok, false, `${tool.name}: failure envelope says ok:false`);
    assert.equal(typeof payload.error, 'string', `${tool.name}: failure envelope has an error code`);
    assert.equal(typeof payload.message, 'string', `${tool.name}: failure envelope has a message`);
  }

  // The success direction reproduces the launcher's project_create path. Its
  // text must remain a single JSON value, with the dashboard link inside that
  // value instead of appended after the closing brace.
  const created = await client.callTool({
    name: 'project_create',
    arguments: { name: 'JSON envelope fixture', subdomain: 'json-envelope-fixture' },
  });
  assert.notEqual(created.isError, true, 'project_create success remains successful');
  const createdText = created.content.find((block) => block.type === 'text');
  assert.ok(createdText, 'project_create success has a text result');
  const createdPayload = JSON.parse(createdText.text);
  assert.equal(createdPayload.ok, true);
  assert.match(createdPayload._control_app_link, /\/dashboard\/projects\//);
  assert.doesNotMatch(createdText.text, /Control your app:/,
    'human dashboard prose is not appended to standard JSON');

  console.log(`json-rpc response envelope: ${tools.length} tool failures + project_create success passed through the official SDK client`);
} finally {
  await client.close();
  await Promise.allSettled(pending);
}
