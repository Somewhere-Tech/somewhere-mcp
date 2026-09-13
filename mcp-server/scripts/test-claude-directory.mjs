import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readRegisteredToolSource } from './registered-tool-source.mjs';

const { toolSpecs } = readRegisteredToolSource();
const output = await build({ entryPoints: [fileURLToPath(new URL('../src/index.ts', import.meta.url))], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' });
const { default: worker } = await import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].text + '\n//# sourceURL=claude-directory-fixture.mjs').toString('base64'));
const requests = [];
const env = { SOMEWHERE_TECH_ADMIN_KEY: 'fixture-only', API_SERVICE: { async fetch(request) {
  const url = new URL(request.url);
  requests.push({ path: url.pathname, method: request.method, body: request.method === 'GET' ? null : await request.clone().json().catch(() => null) });
  if (url.pathname === '/v1/notifications/inbox-pull') return Response.json({ ok: true, data: { notifications: [] } });
  if (url.pathname === '/v1/fixture-large') return Response.json({ok:true,data:'x'.repeat(300000)});
  if (url.pathname === '/v1/fixture-uncertain') throw new Error('fixture network failure');
  if (url.pathname === '/v1/projects') return Response.json({ ok: true, data: { projects: [{ id: '8b95e398-60e7-491d-b4b0-21d30bc6bdca', subdomain: 'review-project' }] } });
  return Response.json({ ok: true, data: { id: 'review-project', files: [], sent: true } });
} } };
env.RUNNER_SERVICE = { async fetch(request) { requests.push({path: new URL(request.url).pathname, method: request.method, body: await request.json()}); return Response.json({ok:true, data:{result:42}}); } };
const ctx = { waitUntil() {}, passThroughOnException() {} };
async function rpc(method, params = {}, path = '/mcp/connector?groups=all') {
  const response = await worker.fetch(new Request('https://mcp.somewhere.tech' + path, {
    method: 'POST', headers: { authorization: 'Bearer smt_directory_fixture', 'content-type': 'application/json', 'Mcp-Tool-Groups': 'all' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }), env, ctx);
  assert.equal(response.status, 200);
  return response.json();
}

const listed = (await rpc('tools/list')).result.tools;
assert.equal(listed.length, 51);
for (const tool of listed) {
  assert.ok(tool.annotations.title?.trim(), `${tool.name}: a readable title`);
  assert.ok(tool.name.length <= 64);
  assert.ok(tool.annotations.readOnlyHint === true || tool.annotations.destructiveHint === true, `${tool.name}: explicit read or mutation permission`);
  assert.ok(tool.description.length < 1000, `${tool.name}: bounded description`);
  assert.doesNotMatch(tool.description, /LEAD WITH|Install:|not available on|ai_generate_image/);
  assert.equal(tool.inputSchema.properties.method, undefined, `${tool.name}: no generic HTTP method dispatch`);
}
const catalog = await rpc('tools/call', { name: 'catalog', arguments: { load: 'all' } });
const catalogTools = catalog.result.content.filter(item => item.type === 'text')
  .map(item => { try { return JSON.parse(item.text).tools; } catch { return undefined; } })
  .find(Array.isArray);
assert.ok(catalogTools, 'catalog exposes the same tool definitions');
assert.deepEqual(catalogTools.map(tool => tool.name).sort(), listed.map(tool => tool.name).sort());
for (const tool of catalogTools) {
  const advertised = listed.find(entry => entry.name === tool.name);
  assert.deepEqual(tool.annotations, advertised.annotations);
  assert.equal(tool.description, advertised.description);
}

// Denials happen before any business request, even with full-surface discovery headers.
for (const name of ['ai_generate_image', 'ai_tts', 'domain_buy', 'api']) {
  const before = requests.length;
  const result = await rpc('tools/call', { name, arguments: {} });
  assert.match(JSON.stringify(result), /TOOL_NOT_AVAILABLE|Unknown tool/);
  assert.equal(requests.length, before, `${name}: no upstream side effect`);
}

// Legitimate reads and writes still reach their fixed authorized API routes.
for (const [name, args, path, method] of [
  ['project_get', { project_id: 'review-project' }, '/v1/projects/8b95e398-60e7-491d-b4b0-21d30bc6bdca', 'GET'],
  ['project_files_list', { project_id: 'review-project' }, '/v1/deploy/files-list', 'GET'],
  ['project_file_read', { project_id: 'review-project', path: 'index.html' }, '/v1/deploy/file', 'GET'],
  ['db_scope_set', { project_id: 'review-project', table: 'notes', owner_column: 'user_id' }, '/v1/db/scopes', 'POST'],
]) {
  requests.length = 0;
  const result = await rpc('tools/call', { name, arguments: args });
  assert.equal(result.error, undefined, name);
  assert.notEqual(result.result?.isError, true, name);
  assert.ok(requests.some(request => request.path === path && request.method === method), `${name}: correct upstream operation ${JSON.stringify({requests,result})}`);
}

// API classes validate the full batch before any operation and cannot cross permissions.
for (const [name, calls] of [
  ['api_read', [{method:'POST',path:'/v1/tasks'}]],
  ['api_write', [{method:'GET',path:'/v1/tasks'}]],
  ['api_write', [{method:'POST',path:'/v1/tasks'}, {method:'POST',path:'/v1/ai/generate-image'}]],
  ['api_write', [{method:'POST',path:'/v1/payments/refund'}]],
  ['api_write', [{method:'POST',path:'/v1/ai/%67enerate-image'}]],
  ['api_write', [{method:'POST',path:'/v1/keys'}]],
]) {
  requests.length=0;
  const result=await rpc('tools/call',{name,arguments:{calls}});
  assert.equal(result.result?.isError,true,JSON.stringify(result));
  assert.equal(requests.filter(r=>r.path!=='/v1/projects'&&r.path!=='/v1/mcp-miss'&&!r.path.startsWith('/v1/notifications/')).length,0,`${name}: rejected batch performs no business request: ${JSON.stringify(requests)}`);
}
for (const [name, method] of [['api_read','GET'],['api_write','POST']]) {
  requests.length=0;
  const result=await rpc('tools/call',{name,arguments:{calls:[{method,path:'/v1/tasks'}]}});
  assert.notEqual(result.result?.isError,true,JSON.stringify(result));
  assert.ok(requests.some(r=>r.path==='/v1/tasks'&&r.method===method));
}
const mixedResult=await rpc('tools/call',{name:'api_write',arguments:{calls:[{method:'POST',path:'/v1/tasks'},{method:'POST',path:'/v1/fixture-uncertain'}]}});
assert.match(JSON.stringify(mixedResult),/REQUEST_OUTCOME_UNKNOWN/);
assert.match(JSON.stringify(mixedResult),/sent/,'successful sibling result is retained');
const oversized=await rpc('tools/call',{name:'api_read',arguments:{calls:[{method:'GET',path:'/v1/fixture-large'}]}});
assert.ok(JSON.stringify(oversized).length<10000,'large API responses are bounded');
assert.match(JSON.stringify(oversized),/omitted/);
for (const [path, restricted] of [['/mcp/connector',true],['/mcp?groups=all',false]]) {
  requests.length=0;
  const result=await rpc('tools/call',{name:'run_code',arguments:{project_id:'8b95e398-60e7-491d-b4b0-21d30bc6bdca',code:'export default async () => 42',execution_policy:'unrestricted'}},path);
  assert.notEqual(result.result?.isError,true,JSON.stringify(result));
  const run=requests.find(r=>r.path==='/run');
  assert.ok(run);
  assert.equal(run.body.execution_policy, restricted ? 'connector' : undefined);
}
for(const name of ['tasks_list','tasks_get','tasks_create','tasks_update','fs_upload','fs_read','fs_write','domain_check','run_code']) assert.ok(listed.some(t=>t.name===name),`${name} retained`);

// Other surfaces retain their independently declared behavior and presentation.
const full = (await rpc('tools/list', {}, '/mcp?groups=all')).result.tools;
const chatgpt = (await rpc('tools/list', {}, '/mcp/chatgpt')).result.tools;
assert.ok(full.some(tool => tool.name === 'ai_generate_image'));
assert.ok(chatgpt.some(tool => tool.name === 'tasks_update'));
for (const tool of chatgpt) {
  for (const hint of ['readOnlyHint', 'destructiveHint', 'openWorldHint']) {
    assert.equal(typeof tool.annotations?.[hint], 'boolean', `${tool.name}: ChatGPT emits ${hint}`);
  }
}
const expectedReadOnly = new Set(['catalog', 'db_describe', 'db_import', 'db_scope_list', 'deploy_status', 'docs', 'docs_query', 'errors', 'fs_read', 'project_deploys', 'project_docs', 'project_export', 'project_file_read', 'project_files_list', 'project_get', 'project_grep', 'project_list', 'project_view_urls', 'site_check_status', 'tasks_get', 'tasks_list']);
const expectedDestructive = new Set(['db_migrate', 'db_query', 'db_scope_set', 'fs_public_url', 'fs_upload', 'fs_write', 'project_archive', 'project_delete', 'project_delete_confirm', 'project_deploy', 'project_notice_acknowledge', 'project_patch', 'project_promote', 'project_rollback', 'run_code', 'security_review', 'support_ticket', 'tasks_update']);
const expectedOpenWorld = new Set(['advisor', 'connector_link_email', 'fs_public_url', 'fs_upload', 'project_archive', 'project_delete_confirm', 'project_deploy', 'project_patch', 'project_promote', 'project_rollback', 'run_code', 'security_review', 'site_check', 'support_ticket', 'tasks_create', 'tasks_update']);
for (const tool of chatgpt) {
  assert.equal(tool.annotations.readOnlyHint, expectedReadOnly.has(tool.name), `${tool.name}: readOnlyHint classification`);
  assert.equal(tool.annotations.destructiveHint, expectedDestructive.has(tool.name), `${tool.name}: destructiveHint classification`);
  assert.equal(tool.annotations.openWorldHint, expectedOpenWorld.has(tool.name), `${tool.name}: openWorldHint classification`);
}
for (const name of ['project_deploy', 'project_patch']) {
  const spec = toolSpecs.find(tool => tool.name === name);
  assert.equal(full.find(tool => tool.name === name).annotations.destructiveHint, spec.annotations.destructiveHint);
  assert.equal(listed.find(tool => tool.name === name).annotations.destructiveHint, true);
}
for (const method of ['GET', 'HEAD']) {
  const response = await worker.fetch(new Request('https://mcp.somewhere.tech/.well-known/openai-apps-challenge', { method }), env, ctx);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^text\/plain/);
  assert.equal(await response.text(), method === 'GET' ? 'A3C78TSNxkWGdXV4tvW3j3Fzp9EhKRr4CsOggJ5Kl6o' : '');
}
const initialized = await rpc('initialize', { protocolVersion: '2025-03-26', clientInfo: { name: 'arbitrary-claude-client', version: '1' } });
assert.doesNotMatch(initialized.result.instructions, /`db_query`|`fs_write`|CLI commands cannot run/);
console.log('Claude directory: bounded metadata, permission hints, retained operations, excluded tool denials, and other surface isolation pass. Live reviewer testing is separate.');
