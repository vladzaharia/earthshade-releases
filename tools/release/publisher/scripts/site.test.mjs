// The publisher places the F-Droid repositories it was handed (signed elsewhere) and refuses a tar that reaches outside them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { placeFdroid } from './site.mjs';

const tarOf = (entries) => {
  const d = mkdtempSync(join(tmpdir(), 'site-')); const src = join(d, 'src');
  for (const e of entries) { mkdirSync(join(src, e, '..'), { recursive: true }); writeFileSync(join(src, e), 'x'); }
  execFileSync('tar', ['-cf', join(d, 't.tar'), '-C', src, ...entries.map((e) => e.split('/')[0]).filter((v, i, a) => a.indexOf(v) === i)]);
  return { tar: join(d, 't.tar'), out: join(d, 'site') };
};

test('placeFdroid unpacks fdroid and fdroid-beta into the site', () => {
  const { tar, out } = tarOf(['fdroid/repo/index-v1.jar', 'fdroid-beta/repo/index-v1.jar']);
  mkdirSync(out);
  placeFdroid(tar, out);
  assert.ok(existsSync(join(out, 'fdroid/repo/index-v1.jar')) && existsSync(join(out, 'fdroid-beta/repo/index-v1.jar')));
});

test('placeFdroid refuses anything else in the tar', () => {
  const { tar, out } = tarOf(['index.html', 'fdroid/repo/a']);
  mkdirSync(out);
  assert.throws(() => placeFdroid(tar, out), /outside fdroid/);
  assert.equal(existsSync(join(out, 'index.html')), false);
});
