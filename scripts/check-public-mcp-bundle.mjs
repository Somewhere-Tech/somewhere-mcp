#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const output = mkdtempSync(join(tmpdir(), 'somewhere-mcp-bundle-'));
const wrangler = resolve(root, 'node_modules/.bin/wrangler');
try {
  const result = spawnSync(wrangler, [
    'deploy', '--dry-run', '--config', 'wrangler.example.toml', '--outdir', output,
  ], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || 'Wrangler dry run failed.\n');
    process.exit(result.status ?? 1);
  }
  console.log('Bundle check passed with the sanitized example configuration.');
} finally {
  rmSync(output, { recursive: true, force: true });
}
