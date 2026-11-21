#!/usr/bin/env node
// The hand-over manifest: the private repository's release workflows push their artefacts to a branch incoming/<tag> of the releases
// repository together with incoming.json (tag, channel, app, versions, the sha256 of every file, the source commit). The publisher there
// (tools/release/publisher/) verifies it before it publishes anything.
//   incoming.mjs make --dir <dir> --tag <tag> --commit <40 hex>   writes <dir>/incoming.json for the files in <dir>
//   incoming.mjs verify <dir> [--no-cert --cert-file <file>]       checks the manifest, every sha256 and the APK's signing certificate
//   incoming.mjs --self-test                                       (the tests are tools/release/incoming.test.mjs)
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync, lstatSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fromTag } from './version.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const roleOf = (n) => (n.endsWith('.apk') ? 'apk' : n.endsWith('.ipa') ? 'ipa' : n === 'fdroid.tar' ? 'fdroid' : null);

export function makeIncoming({ dir, tag, commit }) {
  const v = fromTag(tag);
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('sourceCommit must be 40 lower-case hex digits');
  const files = readdirSync(dir).filter((n) => n !== 'incoming.json').sort().map((name) => {
    const role = roleOf(name);
    if (!role) throw new Error(`${name}: not an apk, ipa or fdroid.tar`);
    const b = readFileSync(join(dir, name));
    return { name, role, sha256: sha(b), size: b.length };
  });
  const m = { v: 1, tag, channel: v.channel, app: v.app, versionName: v.versionName, versionCode: v.versionCode, sourceCommit: commit, files };
  writeFileSync(join(dir, 'incoming.json'), JSON.stringify(m, null, 2) + '\n');
  return m;
}

// certCheck(apkPath) throws when the APK is not signed with the pinned release certificate.
export function verifyIncoming(dir, { certCheck }) {
  const m = JSON.parse(readFileSync(join(dir, 'incoming.json'), 'utf8'));
  if (m?.v !== 1) throw new Error('incoming.json: unknown version');
  const v = fromTag(m.tag);
  for (const k of ['app', 'channel', 'versionName', 'versionCode']) if (m[k] !== v[k]) throw new Error(`incoming.json: ${k} ${m[k]} does not match the tag ${m.tag}`);
  if (!/^[0-9a-f]{40}$/.test(m.sourceCommit ?? '')) throw new Error('incoming.json: sourceCommit is not a commit id');
  if (!Array.isArray(m.files) || !m.files.length) throw new Error('incoming.json: no files');
  const seen = new Set();
  for (const f of m.files) {
    if (!NAME.test(f.name ?? '') || f.name === 'incoming.json' || seen.has(f.name)) throw new Error(`incoming.json: bad file name ${JSON.stringify(f.name)}`);
    seen.add(f.name);
    const p = join(dir, f.name);
    let st; try { st = lstatSync(p); } catch { throw new Error(`${f.name}: missing`); }
    if (!st.isFile()) throw new Error(`${f.name}: not a regular file`);
    const b = readFileSync(p);
    if (b.length !== f.size || sha(b) !== f.sha256) throw new Error(`${f.name}: sha256 or size differs from the manifest`);
    if (roleOf(f.name) !== f.role) throw new Error(`${f.name}: role ${f.role} does not fit the name`);
  }
  for (const n of readdirSync(dir)) if (n !== 'incoming.json' && n !== '.git' && !seen.has(n)) throw new Error(`${n}: not in the manifest`);
  const of = (r) => m.files.filter((f) => f.role === r);
  if (m.app === 'wall') {
    const want = `earthshade-wall-${v.versionName}.apk`;
    if (of('apk').length !== 1 || of('apk')[0].name !== want || of('ipa').length) throw new Error(`a wall hand-over holds exactly ${want} (and optionally fdroid.tar), no ipa`);
    if (of('fdroid').length > 1) throw new Error('more than one fdroid.tar');
    certCheck(join(dir, want));
  } else {
    const re = new RegExp(`^earthshade-${m.app}-${v.versionName.replace(/\./g, '\\.')}-build\\d+\\.ipa$`);
    if (of('ipa').length !== 1 || !re.test(of('ipa')[0].name) || of('apk').length) throw new Error(`an Apple hand-over holds exactly one earthshade-${m.app}-${v.versionName}-build<n>.ipa`);
    if (of('fdroid').length) throw new Error('fdroid.tar belongs to a wall hand-over only');
  }
  return m;
}

export function cliCertCheck(certFile = join(here, 'release-cert.sha256')) {
  return (apk) => {
    try { execFileSync(join(here, 'apk-cert.sh'), ['--check', certFile, apk], { stdio: ['ignore', 'inherit', 'pipe'] }); }
    catch (e) { throw new Error(String(e.stderr ?? e.message).trim() || 'the signing certificate check failed'); }
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), opt = (n, d) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : d; };
  try {
    if (a[0] === 'make') { const m = makeIncoming({ dir: opt('--dir'), tag: opt('--tag'), commit: opt('--commit') }); console.log(`incoming.json: ${m.tag}, ${m.files.length} file(s)`); }
    else if (a[0] === 'verify') {
      const m = verifyIncoming(a[1], { certCheck: a.includes('--no-cert') ? () => {} : cliCertCheck(opt('--cert-file')) });
      console.log(`incoming ${m.tag} (${m.channel}) verified: ${m.files.map((f) => f.name).join(', ')}`);
    } else throw new Error('usage: incoming.mjs make --dir d --tag t --commit sha | verify <dir> [--no-cert] [--cert-file f]');
  } catch (e) { console.error(e.message); process.exit(1); }
}
