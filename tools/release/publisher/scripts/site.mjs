#!/usr/bin/env node
// The Pages site: the AltStore and SideStore sources built from the releases, plus the F-Droid repositories: the signed indexes handed over
// (the publisher holds no F-Droid key) and the APKs those indexes name, which the publisher holds itself: the new one from the hand-over, the
// earlier ones from the release assets. It refuses an index that names an APK it does not hold or whose sha256 differs.
//   site.mjs --releases <releases ndjson|json> --out <dir> --repo <owner/name> --site-url <url> [--fdroid-tar <fdroid-index.tar | legacy fdroid.tar>]
//            [--apk-dir <dir with APKs, e.g. incoming/>] [--assets <cache dir for downloaded APKs>]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, copyFileSync, cpSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSite, download } from '../../feeds/build.mjs';
import { parseReleases, classify } from '../../feeds/lib.mjs';
import { validateRepoDir } from '../../feeds/fdroid.mjs';

const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// apkDirs: directories whose APKs are used first (the hand-over); available: {name, url, size} of the release assets, downloaded into assetsDir.
export async function placeFdroid(tar, out, { apkDirs = [], available = [], assetsDir } = {}) {
  const names = execFileSync('tar', ['-tf', tar], { encoding: 'utf8' }).split('\n').filter(Boolean);
  for (const n of names) if (!/^((fdroid|fdroid-beta)(\/|$)|fdroid-state\.json$)/.test(n) || n.split('/').includes('..') || n.startsWith('/'))
    throw new Error(`${n}: outside fdroid, fdroid-beta and fdroid-state.json; the tar is refused`);
  const w = mkdtempSync(join(tmpdir(), 'fdroid-place-'));
  try {
    execFileSync('tar', ['-xf', tar, '-C', w, '--no-same-owner']);
    // the kept state (when present) names every build of both indexes: an index naming a build the state does not know is not what the packer wrote
    const stateFile = join(w, 'fdroid-state.json');
    let known; // read when the first index is, so a repository without its index still fails on that
    const stateNames = () => (known ??= existsSync(stateFile) ? new Set((JSON.parse(readFileSync(stateFile, 'utf8')).apks ?? []).map((e) => e.name)) : null);
    for (const sub of ['fdroid', 'fdroid-beta']) {
      if (!existsSync(join(w, sub))) continue;
      const repo = join(w, sub, 'repo');
      const idx = join(repo, 'index-v1.json');
      if (existsSync(idx)) {
        for (const list of Object.values(JSON.parse(readFileSync(idx, 'utf8')).packages ?? {})) for (const p of list) {
          if (!SAFE.test(p.apkName ?? '')) throw new Error(`${sub}: the index names a bad file ${JSON.stringify(p.apkName)}`);
          if (stateNames() && !stateNames().has(p.apkName)) throw new Error(`${sub}: the index names ${p.apkName}, which fdroid-state.json does not list`);
          const dest = join(repo, p.apkName);
          if (existsSync(dest)) continue;
          const local = apkDirs.map((d) => join(d, p.apkName)).find((f) => existsSync(f));
          if (local) { copyFileSync(local, dest); continue; }
          const a = available.find((x) => x.name === p.apkName);
          if (!a || !assetsDir) throw new Error(`${sub}: the index names ${p.apkName}, which the publisher does not hold (not handed over, not a release asset)`);
          await download([a], assetsDir);
          copyFileSync(join(assetsDir, p.apkName), dest);
        }
      }
      validateRepoDir(repo, { jarsigner: true }); // every APK the index names is there and matches its sha256; the signed jar verifies and holds this index
      cpSync(join(w, sub), join(out, sub), { recursive: true });
    }
  } finally { rmSync(w, { recursive: true, force: true }); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), opt = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
  try {
    for (const n of ['--releases', '--out', '--repo', '--site-url']) if (!opt(n)) throw new Error(`${n} is required`);
    buildSite({ releasesFile: opt('--releases'), assetsDir: '', out: opt('--out'), repo: opt('--repo'), siteUrl: opt('--site-url').replace(/\/$/, ''), fdroidMode: 'none' });
    if (opt('--fdroid-tar')) {
      const assetsDir = opt('--assets') ?? mkdtempSync(join(tmpdir(), 'fdroid-apks-'));
      mkdirSync(assetsDir, { recursive: true });
      const { apks } = classify(parseReleases(readFileSync(opt('--releases'), 'utf8')));
      await placeFdroid(opt('--fdroid-tar'), opt('--out'), { apkDirs: opt('--apk-dir') ? [opt('--apk-dir')] : [], available: apks, assetsDir });
    }
    console.log(`site in ${opt('--out')}${opt('--fdroid-tar') ? ' with the F-Droid repositories' : ' (AltStore sources only)'}`);
  } catch (e) { console.error(e.message); process.exit(1); }
}
