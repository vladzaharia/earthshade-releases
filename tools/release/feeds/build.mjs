#!/usr/bin/env node
// Builds the feeds site (the gh-pages branch of the releases repository) from that repository's releases.
//   build.mjs --releases releases.json --assets <dir> --out <site dir> --repo <owner/name> --site-url <https://owner.github.io/name>
//             [--fdroid-mode fdroid|fallback|none|auto] [--keystore f --alias a  (password in FDROID_KEYSTORE_PASS)] [--download]
//   --download fetches the APKs the F-Droid repos need into --assets. Modes: fdroid runs `fdroid update` (CI), fallback writes the index with
//   tools/release/feeds/fdroid.mjs (local dry run, needs jarsigner and apksigner), none skips F-Droid, auto = fdroid when installed else fallback.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, cpSync, existsSync, statSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReleases, classify } from './lib.mjs';
import { buildSource, validateSource } from './altstore.mjs';
import { indexPage } from './index-page.mjs';
import { selectApks, prepareRepo, signIndex, validateRepoDir } from './fdroid.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '../../..');

export function buildSite({ releasesFile, assetsDir, out, repo, siteUrl, fdroidMode = 'auto', keystore, alias, root = repoRoot, keep = 5 }) {
  const { apks, ipas } = classify(parseReleases(readFileSync(releasesFile, 'utf8')));
  const apps = JSON.parse(readFileSync(join(root, 'ios/release/apps.json'), 'utf8'));
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, 'icons'), { recursive: true });
  writeFileSync(join(out, '.nojekyll'), '');
  copyFileSync(join(here, 'README-releases.md'), join(out, 'README.md'));
  writeFileSync(join(out, 'index.html'), indexPage({ repo, siteUrl }));
  for (const [k, v] of Object.entries(apps)) if (v.icon) copyFileSync(join(root, v.icon), join(out, 'icons', `${k}.png`));

  for (const channel of ['stable', 'beta']) {
    const s = buildSource({ ipas, channel, siteUrl, apps });
    validateSource(s);
    writeFileSync(join(out, channel === 'beta' ? 'altstore-beta.json' : 'altstore.json'), JSON.stringify(s, null, 2) + '\n');
  }

  const downloads = [...new Map(['stable', 'beta'].flatMap((c) => selectApks(apks, c, keep)).map((a) => [a.name, a])).values()];
  const result = { downloads, fdroid: [] };
  if (fdroidMode === 'none') return result;
  const have = (() => { try { execFileSync('fdroid', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
  const mode = fdroidMode === 'auto' ? (have ? 'fdroid' : 'fallback') : fdroidMode;
  for (const channel of ['stable', 'beta']) {
    const chosen = selectApks(apks, channel, keep);
    if (!chosen.length) continue;
    const sub = channel === 'beta' ? 'fdroid-beta' : 'fdroid';
    const dir = join(out, '..', `.fdroid-work-${channel}`), repoUrl = `${siteUrl}/${sub}/repo`;
    const name = channel === 'beta' ? 'Earthshade (beta)' : 'Earthshade';
    prepareRepo({ dir, assetsDir, apks: chosen, repoUrl, name, keystore, alias, storePass: process.env.FDROID_KEYSTORE_PASS ?? '' });
    if (mode === 'fdroid') execFileSync('fdroid', ['update', '--create-metadata'], { cwd: dir, stdio: 'inherit' });
    else signIndex({ dir, apks: chosen, repoUrl, name, keystore, alias });
    validateRepoDir(join(dir, 'repo'), { jarsigner: mode === 'fallback' });
    cpSync(join(dir, 'repo'), join(out, sub, 'repo'), { recursive: true });
    rmSync(dir, { recursive: true, force: true });
    result.fdroid.push({ channel, mode, versions: chosen.map((a) => a.versionName) });
  }
  return result;
}

export async function download(downloads, dir) {
  mkdirSync(dir, { recursive: true });
  for (const d of downloads) {
    const f = join(dir, d.name);
    if (existsSync(f) && statSync(f).size === d.size) continue;
    const r = await fetch(d.url);
    if (!r.ok) throw new Error(`${d.url}: HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length !== d.size) throw new Error(`${d.name}: ${buf.length} bytes, the release says ${d.size}`);
    writeFileSync(f, buf);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (n, d) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : d; };
  try {
    const need = (n) => opt(n) ?? (() => { throw new Error(`${n} is required`); })();
    const o = { releasesFile: need('--releases'), assetsDir: need('--assets'), out: need('--out'), repo: need('--repo'), siteUrl: need('--site-url').replace(/\/$/, ''),
      fdroidMode: opt('--fdroid-mode', 'auto'), keystore: opt('--keystore'), alias: opt('--alias') };
    if (a.includes('--download')) {
      const { apks } = classify(parseReleases(readFileSync(o.releasesFile, 'utf8')));
      await download([...new Map(['stable', 'beta'].flatMap((c) => selectApks(apks, c)).map((x) => [x.name, x])).values()], o.assetsDir);
    }
    const r = buildSite(o);
    console.log(`feeds site in ${o.out}: AltStore sources, F-Droid ${r.fdroid.map((f) => `${f.channel} (${f.mode}: ${f.versions.join(', ')})`).join('; ') || 'none'}`);
  } catch (e) { console.error(e.message); process.exit(1); }
}
