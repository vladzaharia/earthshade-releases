#!/usr/bin/env node
// Sample releases for the local dry run (build-local.sh): the APK just built, a stable and a beta IPA of each Apple app made of a
// placeholder Payload, in the shape of GitHub's releases API. Nothing here is a real build.
//   sample-releases.mjs --dir <out> --apk <file> --tag wall-v0.0.1-beta.1 --repo <owner/name>
import { readFileSync, writeFileSync, mkdirSync, statSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fromTag } from '../version.mjs';

export function sampleReleases({ dir, apk, tag, repo }) {
  mkdirSync(join(dir, 'assets'), { recursive: true });
  const asset = (rtag, name, file) => ({ name, size: statSync(file).size, browser_download_url: `https://github.com/${repo}/releases/download/${rtag}/${name}` });
  const release = (rtag, assets, n) => ({ tag_name: rtag, draft: false, prerelease: /beta/.test(rtag), published_at: `2026-11-${String(10 + n).padStart(2, '0')}T10:00:00Z`, body: `Sample ${rtag}`, assets });
  const out = [];
  const v = fromTag(tag);
  const apkName = `earthshade-wall-${v.versionName}.apk`;
  copyFileSync(apk, join(dir, 'assets', apkName));
  out.push(release(tag, [asset(tag, apkName, apk)], 3));
  let n = 0;
  for (const app of ['desk', 'phone']) for (const t of [`${app}-v0.1.0`, `${app}-v0.2.0-beta.1`]) {
    const ver = fromTag(t), build = 50 + ++n, name = `earthshade-${app}-${ver.versionName}-build${build}.ipa`;
    const w = mkdtempSync(join(tmpdir(), 'ipa-'));
    execFileSync('sh', ['-c', `mkdir -p Payload/X.app && echo placeholder > Payload/X.app/Info.plist && zip -qr "${join(dir, 'assets', name)}" Payload`], { cwd: w });
    out.push(release(t, [asset(t, name, join(dir, 'assets', name))], n));
  }
  writeFileSync(join(dir, 'releases.json'), JSON.stringify(out, null, 2));
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), opt = (n) => a[a.indexOf(n) + 1];
  sampleReleases({ dir: opt('--dir'), apk: opt('--apk'), tag: opt('--tag'), repo: opt('--repo') });
  console.log(`sample releases in ${opt('--dir')}`);
}
