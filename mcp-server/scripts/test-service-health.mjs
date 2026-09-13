#!/usr/bin/env node
import assert from 'node:assert/strict';
import 'tsx';
const imported = await import('../src/index.ts');
const worker = imported.default.default ?? imported.default;
const realFetch = globalThis.fetch;
let calls = 0;
globalThis.fetch = async () => { calls++; throw new Error('Liveness must not call external services'); };
const unavailable = new Proxy({}, { get() { throw new Error('Liveness must not access bindings'); } });
try {
  for (const query of ['', '?cached=1', '?question=ignored']) {
    const response = await worker.fetch(new Request(`https://mcp.somewhere.tech/health${query}`), unavailable, {
      waitUntil() { throw new Error('Liveness must not schedule model or audit work'); },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, service: 'somewhere-tech-mcp', version: '1.0.0' });
  }
  assert.equal(calls, 0);
  console.log('Service health: no models, bindings, external calls, or background jobs.');
} finally { globalThis.fetch = realFetch; }
