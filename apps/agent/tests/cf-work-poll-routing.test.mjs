import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { parse } from 'jsonc-parser';

// Live counterexample: a signed HTTP wake's global fetch reached the zone origin
// (text/plain 404), while cron reached the control Worker. The public-routing
// flag is required by Cloudflare for same-zone Worker HTTP subrequests.
for (const file of ['wrangler.jsonc', 'wrangler.dev.jsonc']) {
  test(`${file}: HTTP Work wake reaches the public control Worker route`, () => {
    const path = new URL(`../${file}`, import.meta.url);
    const errors = [];
    const config = parse(fs.readFileSync(path, 'utf8'), errors, { allowTrailingComma: true });
    assert.deepEqual(errors, []);
    for (const [name, effective] of [['default', config], ...Object.entries(config.env ?? {}).map(([name, overlay]) => [name, { ...config, ...overlay }])]) {
      assert(effective.compatibility_flags.includes('global_fetch_strictly_public'), `${file}/${name}: same-zone HTTP poll must not bypass the control Worker`);
    }
  });
}
