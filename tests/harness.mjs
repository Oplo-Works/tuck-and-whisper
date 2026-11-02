// v2 acceptance harness. Historical live v15 harness is in legacy-v15/.
import { spawnSync } from 'node:child_process';
const runs = [
  ['--test', 'tests/workflow.test.mjs', 'tests/storage.test.mjs', 'tests/cache.test.mjs'],
  ['node_modules/@playwright/test/cli.js', 'test']
];
for (const args of runs) { const r = spawnSync(process.execPath, args, { stdio: 'inherit' }); if (r.status !== 0) process.exit(r.status || 1); }
