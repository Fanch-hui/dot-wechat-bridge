import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

await promisify(execFile)(process.execPath,['scripts/build.mjs']);
const worker=(await import(pathToFileURL(resolve('dist/server/index.js')).href)).default;
const env={BRIDGE_TOKEN:'artifact-test-token'};
const url='https://bridge.example/gateway/main.js';

test('gateway artifact rejects requests without valid bridge authentication',async()=>{
  for(const headers of [new Headers(),new Headers({Authorization:'Bearer invalid'})]) {
    const response=await worker.fetch(new Request(url,{headers}),env);
    assert.equal(response.status,401);
    assert.deepEqual(await response.json(),{error:'gateway_authentication_required'});
  }
});

test('gateway artifact preserves the exact gateway build bytes',async()=>{
  const response=await worker.fetch(new Request(url,{headers:{Authorization:`Bearer ${env.BRIDGE_TOKEN}`}}),env);
  assert.equal(response.status,200);
  assert.equal(response.headers.get('Cache-Control'),'no-store');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),await readFile('dist/gateway/main.js'));
});
