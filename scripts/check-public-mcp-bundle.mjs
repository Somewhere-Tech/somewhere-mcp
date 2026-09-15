#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const wrangler = resolve(root, 'node_modules/.bin/wrangler');

const plugin = JSON.parse(readFileSync(resolve(root, '.cursor-plugin/plugin.json'), 'utf8'));
const mcp = JSON.parse(readFileSync(resolve(root, 'mcp.json'), 'utf8'));
const expectedPluginKeys = [
  'author', 'description', 'homepage', 'keywords', 'license', 'logo',
  'mcpServers', 'name', 'repository', 'version',
];
const actualPluginKeys = Object.keys(plugin).sort();
if (JSON.stringify(actualPluginKeys) !== JSON.stringify(expectedPluginKeys)) {
  throw new Error(`Unexpected Cursor plugin fields: ${actualPluginKeys.join(', ')}`);
}
if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(plugin.name)) {
  throw new Error('Cursor plugin name must be lowercase kebab-case.');
}
if (!/^\d+\.\d+\.\d+$/.test(plugin.version)) {
  throw new Error('Cursor plugin version must be semantic versioning.');
}
if (plugin.mcpServers !== 'mcp.json') {
  throw new Error('Cursor plugin must reference the exported root mcp.json.');
}
if (plugin.logo !== 'assets/logo.svg' || !existsSync(resolve(root, plugin.logo))) {
  throw new Error('Cursor plugin logo must resolve inside the export.');
}
if (Object.keys(mcp).length !== 1 || Object.keys(mcp.mcpServers ?? {}).length !== 1) {
  throw new Error('Cursor MCP configuration must expose one canonical server.');
}
const somewhere = mcp.mcpServers.somewhere;
if (JSON.stringify(somewhere) !== JSON.stringify({ url: 'https://mcp.somewhere.tech/mcp' })) {
  throw new Error('Cursor MCP configuration must use the canonical OAuth endpoint without overrides.');
}
console.log('Cursor plugin manifest and MCP configuration passed.');

const temporary = mkdtempSync(join(tmpdir(), 'somewhere-mcp-bundle-'));
const output = join(temporary, 'output');
const config = join(temporary, 'wrangler.toml');
try {
  writeFileSync(config, [
    'name = "somewhere-mcp-bundle-check"',
    `main = ${JSON.stringify(resolve(root, 'mcp-server/src/index.ts'))}`,
    'compatibility_date = "2024-12-01"',
    'compatibility_flags = ["nodejs_compat"]',
    '',
  ].join('\n'));
  const result = spawnSync(wrangler, [
    'deploy', '--dry-run', '--config', config, '--outdir', output,
  ], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'Wrangler dry run failed.');
  }
  console.log('Bundle check passed with isolated test configuration.');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
