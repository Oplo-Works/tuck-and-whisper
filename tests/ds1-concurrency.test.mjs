// DS-1 scenarios now exercise the v2 UI in an actual browser with deferred API stubs.
// v15's 68 baseline checks remain in tests/legacy-v15, explicitly not v2 validation.
import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--grep', 'DS1-'], { stdio: 'inherit' });
process.exit(result.status || 0);
