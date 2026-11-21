#!/usr/bin/env node
// The signed F-Droid repositories for a wall release that is not published yet, packed as fdroid.tar for the hand-over. This runs in the
// private repository's release workflow, where the F-Droid key is: the publisher in the releases repository only places the result.
//   fdroid-pack.mjs --apk <file> --tag wall-v1.2.3 --repo <owner/name> --site-url <url> --out fdroid.tar [--releases <releases json>]
//                   [--fdroid-mode fdroid|fallback|auto] --keystore <f> --alias <a>      (password in FDROID_KEYSTORE_PASS)
// --releases is the releases repository's current releases (GitHub API shape; absent = none yet). The new APK is added as if published.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReleases, classify } from './lib.mjs';
import { selectApks } from './fdroid.mjs';
import { buildSite, download } from './build.mjs';

export async function packFdroid({ apk, tag, repo, siteUrl, out, releasesFile, fdroidMode = 'auto', keystore, alias, offline = false }) {
  const work = mkdtempSync(join(tmpdir(), 'fdroid-pack-'));
  try {
    const name = basename(apk);
    const existing = releasesFile && existsSync(releasesFile) ? parseReleases(readFileSync(releasesFile, 'utf8')).filter((r) => r.tag_name !== tag) : [];
    const added = { tag_name: tag, draft: false, prerelease: /-beta\./.test(tag), published_at: new Date().toISOString(), body: '',
      assets: [{ name, size: statSync(apk).size, browser_download_url: `https://github.com/${repo}/releases/download/${tag}/${name}` }] };
    const rel = join(work, 'releases.json'), assets = join(work, 'apks');
    writeFileSync(rel, JSON.stringify([added, ...existing]));
    mkdirSync(assets); copyFileSync(apk, join(assets, name));
    if (!offline) {
      const { apks } = classify(parseReleases(readFileSync(rel, 'utf8')));
      await download([...new Map(['stable', 'beta'].flatMap((c) => selectApks(apks, c)).map((x) => [x.name, x])).values()], assets);
    }
    const site = join(work, 'site');
    const r = buildSite({ releasesFile: rel, assetsDir: assets, out: site, repo, siteUrl, fdroidMode, keystore, alias });
    const dirs = r.fdroid.map((f) => (f.channel === 'beta' ? 'fdroid-beta' : 'fdroid'));
    if (!dirs.length) throw new Error('no F-Droid repository was built');
    execFileSync('tar', ['-cf', out, '-C', site, ...dirs]);
    return r;
  } finally { rmSync(work, { recursive: true, force: true }); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), opt = (n, d) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : d; };
  try {
    const need = (n) => opt(n) ?? (() => { throw new Error(`${n} is required`); })();
    const r = await packFdroid({ apk: need('--apk'), tag: need('--tag'), repo: need('--repo'), siteUrl: need('--site-url').replace(/\/$/, ''), out: need('--out'),
      releasesFile: opt('--releases'), fdroidMode: opt('--fdroid-mode', 'auto'), keystore: need('--keystore'), alias: need('--alias'), offline: a.includes('--offline') });
    console.log(`fdroid.tar: ${r.fdroid.map((f) => `${f.channel} (${f.versions.join(', ')})`).join('; ')}`);
  } catch (e) { console.error(e.message); process.exit(1); }
}
