// The publisher places the F-Droid indexes it was handed (signed elsewhere), supplies the APKs they name itself, and refuses what does not fit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { placeFdroid } from './site.mjs';
import { indexV1 } from '../../feeds/fdroid.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'site-'));
const tarOf = (entries) => {
  const d = tmp(); const src = join(d, 'src');
  for (const e of entries) { mkdirSync(join(src, e, '..'), { recursive: true }); writeFileSync(join(src, e), 'x'); }
  execFileSync('tar', ['-cf', join(d, 't.tar'), '-C', src, ...entries.map((e) => e.split('/')[0]).filter((v, i, a) => a.indexOf(v) === i)]);
  return { tar: join(d, 't.tar'), out: join(d, 'site') };
};

test('placeFdroid refuses a repository without its index', async () => {
  const { tar, out } = tarOf(['fdroid/repo/index-v1.jar', 'fdroid-beta/repo/index-v1.jar', 'fdroid-state.json']);
  mkdirSync(out);
  await assert.rejects(placeFdroid(tar, out), /neither index-v1\.json/);
});

test('placeFdroid refuses anything else in the tar', async () => {
  const { tar, out } = tarOf(['index.html', 'fdroid/repo/a']);
  mkdirSync(out);
  await assert.rejects(placeFdroid(tar, out), /outside fdroid/);
  assert.equal(existsSync(join(out, 'index.html')), false);
});

// A real signed index-v1.jar of <repo>/<file> (a throwaway key), as jarsigner makes it.
function signedJar(repo, file) {
  const ks = join(repo, '..', 'k.p12');
  if (!existsSync(ks)) execFileSync('keytool', ['-genkeypair', '-keystore', ks, '-storetype', 'PKCS12', '-storepass', 'throwaway', '-alias', 'k', '-dname', 'CN=t', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '2'], { stdio: 'pipe' });
  execFileSync('zip', ['-q', '-j', 'index-v1.jar', file], { cwd: repo });
  execFileSync('jarsigner', ['-keystore', ks, '-storepass', 'throwaway', '-sigalg', 'SHA256withRSA', '-digestalg', 'SHA256', 'index-v1.jar', 'k'], { cwd: repo, stdio: 'pipe' });
  rmSync(ks);
}

// A hand-over: index of two builds (A held by the publisher as a release asset, B handed over), signed index file present.
const APK = { a: 'apk a', b: 'apk b' };
const sha = (s) => createHash('sha256').update(s).digest('hex');
const entry = (k, versionCode, hash = sha(APK[k])) => ({ name: `earthshade-wall-${k}.apk`, versionName: k, versionCode, date: '2026-11-20T10:00:00Z', sha256: hash, sig: 'cd'.repeat(16), signer: 'ef'.repeat(32), size: APK[k].length });
function handOver(entries, { jarOf, stateNames = entries.map((e) => e.name) } = {}) {
  const d = tmp(), repo = join(d, 'src/fdroid-beta/repo');
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, 'index-v1.json'), JSON.stringify(indexV1({ apks: entries, repoUrl: 'https://o.github.io/r/fdroid-beta/repo', name: 'n' })));
  signedJar(repo, jarOf ?? 'index-v1.json');
  writeFileSync(join(d, 'src/fdroid-state.json'), JSON.stringify({ v: 1, apks: stateNames.map((name) => ({ name })) }));
  execFileSync('tar', ['-cf', join(d, 't.tar'), '-C', join(d, 'src'), 'fdroid-beta', 'fdroid-state.json']);
  const incoming = join(d, 'incoming'); mkdirSync(incoming); writeFileSync(join(incoming, 'earthshade-wall-b.apk'), APK.b);
  const cache = join(d, 'cache'); mkdirSync(cache); writeFileSync(join(cache, 'earthshade-wall-a.apk'), APK.a); // a release asset already fetched
  const out = join(d, 'site'); mkdirSync(out);
  const available = [{ name: 'earthshade-wall-a.apk', url: 'https://example.invalid/a', size: APK.a.length }];
  return { tar: join(d, 't.tar'), incoming, cache, out, available };
}

test('placeFdroid takes the new APK from the hand-over and the earlier one from the release assets, and every APK the index names ends up in the repo', async () => {
  const h = handOver([entry('b', 2), entry('a', 1)]);
  await placeFdroid(h.tar, h.out, { apkDirs: [h.incoming], available: h.available, assetsDir: h.cache });
  assert.equal(readFileSync(join(h.out, 'fdroid-beta/repo/earthshade-wall-b.apk'), 'utf8'), APK.b);
  assert.equal(readFileSync(join(h.out, 'fdroid-beta/repo/earthshade-wall-a.apk'), 'utf8'), APK.a);
  assert.equal(existsSync(join(h.out, 'fdroid-state.json')), false); // the state is the publisher's to keep, not the site's
});

test('placeFdroid refuses an index that names an APK the publisher does not hold', async () => {
  const h = handOver([entry('b', 2), entry('a', 1)]);
  await assert.rejects(placeFdroid(h.tar, h.out, { apkDirs: [h.incoming], available: [], assetsDir: h.cache }), /earthshade-wall-a\.apk.*does not hold/);
  assert.equal(existsSync(join(h.out, 'fdroid-beta')), false);
});

test('placeFdroid refuses an index whose hash differs from the APK the publisher holds', async () => {
  const h = handOver([entry('b', 2, 'ab'.repeat(32)), entry('a', 1)]);
  await assert.rejects(placeFdroid(h.tar, h.out, { apkDirs: [h.incoming], available: h.available, assetsDir: h.cache }), /earthshade-wall-b\.apk does not match its hash/);
  assert.equal(existsSync(join(h.out, 'fdroid-beta')), false);
});

test('placeFdroid refuses an index that names a path instead of a file', async () => {
  const h = handOver([{ ...entry('b', 2), name: '../x.apk' }]);
  await assert.rejects(placeFdroid(h.tar, h.out, { apkDirs: [h.incoming] }), /bad file/);
});

test('placeFdroid refuses a signed jar that holds another index than the loose index-v1.json', async () => {
  const d = tmp(), repo = join(d, 'src/fdroid-beta/repo');
  const h = handOver([entry('b', 2), entry('a', 1)]);
  // rebuild the hand-over with a jar made from an older index (one build fewer) next to the full loose index
  const src = join(d, 'src'); mkdirSync(repo, { recursive: true });
  const loose = indexV1({ apks: [entry('b', 2), entry('a', 1)], repoUrl: 'https://o.github.io/r/fdroid-beta/repo', name: 'n' });
  const stale = indexV1({ apks: [entry('a', 1)], repoUrl: 'https://o.github.io/r/fdroid-beta/repo', name: 'n' });
  writeFileSync(join(repo, 'stale.json'), JSON.stringify(stale));
  copyFileSync(join(repo, 'stale.json'), join(repo, 'index-v1.json'));
  signedJar(repo, 'index-v1.json');
  rmSync(join(repo, 'stale.json'));
  writeFileSync(join(repo, 'index-v1.json'), JSON.stringify(loose));
  writeFileSync(join(src, 'fdroid-state.json'), JSON.stringify({ v: 1, apks: [{ name: 'earthshade-wall-a.apk' }, { name: 'earthshade-wall-b.apk' }] }));
  execFileSync('tar', ['-cf', join(d, 't.tar'), '-C', src, 'fdroid-beta', 'fdroid-state.json']);
  await assert.rejects(placeFdroid(join(d, 't.tar'), h.out, { apkDirs: [h.incoming], available: h.available, assetsDir: h.cache }), /does not hold this index-v1\.json/);
});

test('placeFdroid refuses an index that names a build the kept state does not list', async () => {
  const h = handOver([entry('b', 2), entry('a', 1)], { stateNames: ['earthshade-wall-b.apk'] });
  await assert.rejects(placeFdroid(h.tar, h.out, { apkDirs: [h.incoming], available: h.available, assetsDir: h.cache }), /earthshade-wall-a\.apk.*fdroid-state\.json does not list/);
});
