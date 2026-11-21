#!/usr/bin/env node
// The publisher's decisions, taken before anything is published (a failure here publishes nothing).
//   plan.mjs --incoming <dir> --repo <owner/name> --out <dir> [--current <update.json of the channel>] [--beta <update.json of the beta release>]
// Writes <out>/plan.json and, for a wall release, <out>/update.json. A missing or empty --current/--beta file means nothing is published yet.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { makeManifest } from '../../make-manifest.mjs';

export function plan({ incoming, repo, apkBytes, current = null, beta = null, now = new Date().toISOString() }) {
  const { tag, app, channel, versionName } = incoming;
  const release = { tag, title: app === 'wall' ? `Wall ${versionName}` : tag, latest: app === 'wall' && channel === 'stable', prerelease: channel === 'beta',
    notes: app === 'wall' ? `Wall ${versionName} (${channel}).` : `${tag} for AltStore and SideStore (unsigned: the installer re-signs it with their Apple ID). TestFlight has the same build.`,
    assets: incoming.files.filter((f) => f.role !== 'fdroid').map((f) => f.name) };
  if (app !== 'wall') return { release, updateJson: null, moveBeta: false, betaExists: false };
  // A rerun of the same build (its manifest is already the channel's) is not a regression; anything else must be above the current one.
  const sha = createHash('sha256').update(apkBytes).digest('hex');
  const rerun = current && current.versionCode === incoming.versionCode && current.sha256 === sha;
  const updateJson = makeManifest({ apkBytes, apkName: incoming.files.find((f) => f.role === 'apk').name, tag, repo, publishedAt: now, current: rerun ? null : current });
  // The rolling beta release carries the newest manifest of either channel; it never moves backwards.
  const moveBeta = !beta || updateJson.versionCode > beta.versionCode;
  return { release, updateJson, moveBeta, betaExists: !!beta };
}

const readJson = (f) => (f && existsSync(f) && readFileSync(f, 'utf8').trim() ? JSON.parse(readFileSync(f, 'utf8')) : null);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), opt = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
  try {
    const dir = opt('--incoming'), out = opt('--out');
    if (!dir || !out || !opt('--repo')) throw new Error('usage: plan.mjs --incoming dir --repo owner/name --out dir [--current f] [--beta f]');
    const incoming = JSON.parse(readFileSync(join(dir, 'incoming.json'), 'utf8'));
    const apk = incoming.files.find((f) => f.role === 'apk');
    const p = plan({ incoming, repo: opt('--repo'), apkBytes: apk ? readFileSync(join(dir, apk.name)) : null, current: readJson(opt('--current')), beta: readJson(opt('--beta')) });
    mkdirSync(out, { recursive: true });
    if (p.updateJson) writeFileSync(join(out, 'update.json'), JSON.stringify(p.updateJson, null, 2) + '\n');
    writeFileSync(join(out, 'plan.json'), JSON.stringify({ ...p, updateJson: undefined, hasUpdateJson: !!p.updateJson }, null, 2) + '\n');
    console.log(`plan for ${incoming.tag}: ${p.release.latest ? 'latest' : p.release.prerelease ? 'pre-release' : 'release'}${p.updateJson ? `, update.json ${p.updateJson.versionCode}, beta ${p.moveBeta ? 'moves' : 'stays'}` : ''}`);
  } catch (e) { console.error(e.message); process.exit(1); }
}
