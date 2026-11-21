#!/usr/bin/env node
// The Pages site: the AltStore and SideStore sources built from the releases, plus the F-Droid repositories as they were signed
// (the publisher holds no F-Droid key; it only places what the private workflow handed over).
//   site.mjs --releases <releases ndjson|json> --out <dir> --repo <owner/name> --site-url <url> [--fdroid-tar <fdroid.tar>]
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildSite } from '../../feeds/build.mjs';

export function placeFdroid(tar, out) {
  const names = execFileSync('tar', ['-tf', tar], { encoding: 'utf8' }).split('\n').filter(Boolean);
  for (const n of names) if (!/^(fdroid|fdroid-beta)(\/|$)/.test(n) || n.split('/').includes('..') || n.startsWith('/'))
    throw new Error(`${n}: outside fdroid and fdroid-beta; the tar is refused`);
  execFileSync('tar', ['-xf', tar, '-C', out]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), opt = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
  try {
    for (const n of ['--releases', '--out', '--repo', '--site-url']) if (!opt(n)) throw new Error(`${n} is required`);
    buildSite({ releasesFile: opt('--releases'), assetsDir: '', out: opt('--out'), repo: opt('--repo'), siteUrl: opt('--site-url').replace(/\/$/, ''), fdroidMode: 'none' });
    if (opt('--fdroid-tar')) placeFdroid(opt('--fdroid-tar'), opt('--out'));
    console.log(`site in ${opt('--out')}${opt('--fdroid-tar') ? ' with the F-Droid repositories' : ' (AltStore sources only)'}`);
  } catch (e) { console.error(e.message); process.exit(1); }
}
