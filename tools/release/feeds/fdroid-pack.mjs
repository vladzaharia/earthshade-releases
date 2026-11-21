#!/usr/bin/env node
// The signed F-Droid indexes for a wall release that is not published yet, packed as fdroid-index.tar for the hand-over. This runs in the
// private repository's release workflow, where the F-Droid key is; the publisher in the releases repository places the result and supplies the APKs.
//   fdroid-pack.mjs --apk <file> --tag wall-v1.2.3 --site-url <url> --out fdroid-index.tar [--prior <tar>] --keystore <f> --alias <a>   (password in FDROID_KEYSTORE_PASS)
//
// Nothing in the tar grows with the number of releases: it holds index-v1.json and index-v1.jar of each repository (at most `keep` builds each,
// so a few KB) and fdroid-state.json, the metadata of exactly those builds (file name, versions, sha256, size, signing certificate). The earlier
// APKs are not handed over and not downloaded here: the index of this release is written from that state plus the one new APK. --prior is the tar
// the publisher kept from the last release (the asset fdroid-index.tar of its release `feeds-state`). The legacy fdroid.tar (the repositories with
// every APK inside) is read too, once: its APKs give the same metadata, so the next release migrates without a manual step.
import { readFileSync, writeFileSync, mkdirSync, existsSync, mkdtempSync, rmSync, statSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromTag } from '../version.mjs';
import { selectApks, writeSignedIndex, certOfApk, PACKAGE } from './fdroid.mjs';

export const KEEP = 5;
export const REPOS = [{ channel: 'stable', sub: 'fdroid', name: 'Earthshade' }, { channel: 'beta', sub: 'fdroid-beta', name: 'Earthshade (beta)' }];
const HEX = (n) => new RegExp(`^[0-9a-f]{${n}}$`);

// One state entry per kept APK: what indexV1 needs, as selectApks, indexV1 and the publisher's checks read it.
function checkEntry(e) {
  const v = fromTag(`wall-v${e?.versionName}`);
  if (v.versionName !== e.versionName || v.versionCode !== e.versionCode || v.channel !== e.channel || e.name !== `earthshade-wall-${e.versionName}.apk`
    || !HEX(64).test(e.sha256) || !HEX(64).test(e.signer) || !HEX(32).test(e.sig) || !Number.isInteger(e.size) || e.size <= 0 || Number.isNaN(Date.parse(e.date)))
    throw new Error(`fdroid state: a bad entry for ${JSON.stringify(e?.name)}`);
  return e;
}

// The entries of the prior tar: the new state file, or (legacy) the packages of its index-v1.json files.
export function readPrior(tar, certOf = certOfApk) {
  if (!tar || !existsSync(tar)) return [];
  const w = mkdtempSync(join(tmpdir(), 'fdroid-prior-'));
  try {
    execFileSync('tar', ['-xf', tar, '-C', w, '--no-same-owner'], { stdio: 'pipe' });
    const st = join(w, 'fdroid-state.json');
    if (existsSync(st)) { const s = JSON.parse(readFileSync(st, 'utf8')); if (s?.v !== 1 || !Array.isArray(s.apks)) throw new Error('fdroid state: unknown format'); return s.apks.map(checkEntry); }
    // Legacy fdroid.tar: the APKs are inside. fdroidserver may have renamed them (<package>_<versionCode>.apk), so the version comes from the
    // index-v1.json when there is one (else from an earthshade-wall-<version>.apk name), and hash, size and certificate from the APK itself.
    const byName = new Map();
    const add = (f, versionName) => {
      const v = fromTag(`wall-v${versionName}`), name = `earthshade-wall-${v.versionName}.apk`, buf = readFileSync(f);
      if (!byName.has(name)) byName.set(name, checkEntry({ name, versionName: v.versionName, versionCode: v.versionCode, channel: v.channel,
        sha256: createHash('sha256').update(buf).digest('hex'), size: buf.length, ...certOf(f), date: statSync(f).mtime.toISOString() }));
    };
    for (const { sub } of REPOS) {
      const d = join(w, sub, 'repo'), idx = join(d, 'index-v1.json');
      if (!existsSync(d)) continue;
      if (existsSync(idx)) {
        for (const p of JSON.parse(readFileSync(idx, 'utf8')).packages?.[PACKAGE] ?? []) if (existsSync(join(d, basename(p.apkName)))) add(join(d, basename(p.apkName)), p.versionName);
      } else for (const n of readdirSync(d)) { const m = /^earthshade-wall-(.+)\.apk$/.exec(n); if (m) add(join(d, n), m[1]); }
    }
    if (!byName.size) throw new Error('the legacy fdroid.tar holds no wall APK that can be read');
    return [...byName.values()];
  } finally { rmSync(w, { recursive: true, force: true }); }
}

export function packFdroid({ apk, tag, siteUrl, out, prior, keystore, alias, keep = KEEP, held, now = new Date(), certOf = certOfApk }) {
  const v = fromTag(tag);
  if (v.app !== 'wall') throw new Error(`${tag} is not a wall tag`);
  const name = basename(apk);
  if (name !== `earthshade-wall-${v.versionName}.apk`) throw new Error(`${name} is not earthshade-wall-${v.versionName}.apk`);
  const buf = readFileSync(apk);
  const added = { name, versionName: v.versionName, versionCode: v.versionCode, channel: v.channel, date: now.toISOString(),
    sha256: createHash('sha256').update(buf).digest('hex'), size: buf.length, ...certOf(apk) };
  // `held` (when given): the APK names the releases still have. A build whose release was deleted (a rollback) or is not public drops out of the
  // index here; else the publisher, which cannot back it with an APK, would refuse every later release.
  const all = [...readPrior(prior, certOf).filter((e) => e.name !== name && (!held || held.has(e.name))), added];
  const work = mkdtempSync(join(tmpdir(), 'fdroid-pack-'));
  try {
    const kept = new Map(), built = [];
    for (const r of REPOS) {
      const chosen = selectApks(all, r.channel, keep);
      if (!chosen.length) continue;
      writeSignedIndex({ repoDir: join(work, r.sub, 'repo'), apks: chosen, repoUrl: `${siteUrl}/${r.sub}/repo`, name: r.name, keystore, alias, now: now.getTime() });
      for (const c of chosen) kept.set(c.name, c);
      built.push({ ...r, versions: chosen.map((c) => c.versionName) });
    }
    const state = [...kept.values()].sort((a, b) => b.versionCode - a.versionCode);
    writeFileSync(join(work, 'fdroid-state.json'), JSON.stringify({ v: 1, apks: state }, null, 2) + '\n');
    execFileSync('tar', ['-cf', out, '-C', work, ...built.map((b) => b.sub), 'fdroid-state.json']);
    return { built, kept: state.map((e) => e.name), bytes: statSync(out).size };
  } finally { rmSync(work, { recursive: true, force: true }); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), opt = (n, d) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : d; };
  try {
    const need = (n) => opt(n) ?? (() => { throw new Error(`${n} is required`); })();
    const r = packFdroid({ apk: need('--apk'), tag: need('--tag'), siteUrl: need('--site-url').replace(/\/$/, ''), out: need('--out'), prior: opt('--prior'), held: opt('--held') ? new Set(readFileSync(opt('--held'), 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)) : undefined,
      keystore: need('--keystore'), alias: need('--alias') });
    console.log(`fdroid-index.tar (${r.bytes} bytes): ${r.built.map((f) => `${f.channel} (${f.versions.join(', ')})`).join('; ')}`);
  } catch (e) { console.error(e.message); process.exit(1); }
}
