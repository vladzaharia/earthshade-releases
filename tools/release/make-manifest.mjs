#!/usr/bin/env node
// Writes update.json for a signed APK (CONTRACTS §11 UpdateManifest: sha256, sizeBytes, versionCode, ...).
//   make-manifest.mjs --apk <file> --tag wall-v1.2.3 --repo <owner>/<name> [--out update.json] [--min-sdk 31]
//        [--notes <text>] [--current <update.json of the channel>]   (refuses when versionCode is not above the current one)
//   make-manifest.mjs --self-test
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { fromTag } from './version.mjs';

export function makeManifest({ apkBytes, apkName, tag, repo, minSdk = 31, notes = null, publishedAt = new Date().toISOString(), current = null }) {
  const v = fromTag(tag);
  if (current && v.versionCode <= current.versionCode)
    throw new Error(`versionCode ${v.versionCode} is not above the channel's current ${current.versionCode}`);
  const m = {
    v: 1, versionCode: v.versionCode, versionName: v.versionName,
    apkUrl: `https://github.com/${repo}/releases/download/${tag}/${apkName}`,
    sha256: createHash('sha256').update(apkBytes).digest('hex'), sizeBytes: apkBytes.length,
    minSdk, publishedAt: publishedAt.replace(/\.\d+Z$/, 'Z'),
  };
  if (notes) m.notes = notes;
  return m;
}

function selfTest() {
  const apk = Buffer.from('apk bytes');
  const m = makeManifest({ apkBytes: apk, apkName: 'earthshade-1.2.3.apk', tag: 'wall-v1.2.3', repo: 'o/earthshade-releases', publishedAt: '2026-11-20T10:00:00.123Z' });
  assert.equal(m.versionCode, 1020399);
  assert.equal(m.versionName, '1.2.3');
  assert.equal(m.sizeBytes, 9);
  assert.equal(m.sha256, createHash('sha256').update(apk).digest('hex'));
  assert.equal(m.apkUrl, 'https://github.com/o/earthshade-releases/releases/download/wall-v1.2.3/earthshade-1.2.3.apk');
  assert.equal(m.publishedAt, '2026-11-20T10:00:00Z');
  assert.equal('notes' in m, false);
  assert.equal(makeManifest({ apkBytes: apk, apkName: 'a.apk', tag: 'wall-v1.2.3-beta.2', repo: 'o/r', notes: 'x' }).notes, 'x');
  assert.throws(() => makeManifest({ apkBytes: apk, apkName: 'a', tag: 'wall-v1.2.3', repo: 'o/r', current: { versionCode: 1020399 } }), /not above/);
  assert.throws(() => makeManifest({ apkBytes: apk, apkName: 'a', tag: 'wall-v1.2.3-beta.1', repo: 'o/r', current: { versionCode: 1020399 } }), /not above/);
  makeManifest({ apkBytes: apk, apkName: 'a', tag: 'wall-v1.2.4', repo: 'o/r', current: { versionCode: 1020399 } });
  // every field UpdateManifest requires is present
  for (const k of ['versionCode', 'versionName', 'apkUrl', 'sha256', 'sizeBytes', 'minSdk', 'publishedAt']) assert.ok(k in m, k);
  console.log('make-manifest self-test: PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  try {
    if (a[0] === '--self-test') selfTest();
    else {
      const opt = (n, d) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : d; };
      const apk = opt('--apk'), tag = opt('--tag'), repo = opt('--repo');
      if (!apk || !tag || !repo) throw new Error('usage: make-manifest.mjs --apk <file> --tag <tag> --repo <owner/name> [--out f] [--min-sdk n] [--notes t] [--current f]');
      const curFile = opt('--current');
      const current = curFile && existsSync(curFile) && readFileSync(curFile, 'utf8').trim() ? JSON.parse(readFileSync(curFile, 'utf8')) : null;
      const m = makeManifest({ apkBytes: readFileSync(apk), apkName: apk.split('/').pop(), tag, repo,
        minSdk: Number(opt('--min-sdk', 31)), notes: opt('--notes', null), current });
      writeFileSync(opt('--out', 'update.json'), JSON.stringify(m, null, 2) + '\n');
      console.log(`wrote ${opt('--out', 'update.json')}: ${m.versionName} (${m.versionCode})`);
    }
  } catch (e) { console.error(e.message); process.exit(1); }
}
