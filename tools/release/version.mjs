#!/usr/bin/env node
// The one place a release version is worked out (docs/ship/release.md).
//   version.mjs from-tag <tag>        wall-v1.2.3 | wall-v1.2.3-beta.4 | desk-v... | phone-v...: prints key=value lines
//   version.mjs bump <major|minor|patch> [--write]   next stable version from android/version.properties; prints the tag
//   version.mjs --self-test
// versionCode = major*1_000_000 + minor*10_000 + patch*100 + (stable ? 99 : beta number), so a beta of 1.2.3 sorts below 1.2.3
// and above 1.2.2. Minor and patch stay below 100 and a beta number below 99 (refused otherwise).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const TAG = /^(wall|desk|phone)-v(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/;

export function fromTag(tag) {
  const m = TAG.exec(tag);
  if (!m) throw new Error(`not a release tag: ${tag} (wall-v1.2.3, wall-v1.2.3-beta.1, desk-v..., phone-v...)`);
  const [major, minor, patch] = [m[2], m[3], m[4]].map(Number);
  const beta = m[5] === undefined ? null : Number(m[5]);
  if (minor > 99 || patch > 99 || (beta !== null && (beta < 1 || beta > 98))) throw new Error(`version out of range: ${tag}`);
  const versionCode = major * 1_000_000 + minor * 10_000 + patch * 100 + (beta ?? 99);
  if (versionCode > 2_100_000_000) throw new Error(`versionCode too large: ${tag}`);
  return { app: m[1], channel: beta === null ? 'stable' : 'beta',
    versionName: `${major}.${minor}.${patch}` + (beta === null ? '' : `-beta.${beta}`), versionCode };
}

export function bump(current, kind) {
  const [a, b, c] = current.split('.').map(Number);
  const next = { major: [a + 1, 0, 0], minor: [a, b + 1, 0], patch: [a, b, c + 1] }[kind];
  if (!next) throw new Error(`bump: major, minor or patch (got ${kind})`);
  return next.join('.');
}

const here = dirname(fileURLToPath(import.meta.url));
const propsFile = join(here, '../../android/version.properties');

function selfTest() {
  assert.deepEqual(fromTag('wall-v1.2.3'), { app: 'wall', channel: 'stable', versionName: '1.2.3', versionCode: 1020399 });
  assert.equal(fromTag('wall-v1.2.3-beta.4').versionCode, 1020304);
  assert.equal(fromTag('wall-v1.2.3-beta.4').channel, 'beta');
  assert.ok(fromTag('wall-v1.2.3-beta.98').versionCode < fromTag('wall-v1.2.3').versionCode);
  assert.ok(fromTag('wall-v1.2.3').versionCode < fromTag('wall-v1.2.4-beta.1').versionCode);
  assert.equal(fromTag('desk-v0.4.0').app, 'desk');
  for (const bad of ['v1.2.3', 'wall-1.2.3', 'wall-v1.2', 'wall-v1.2.3-rc.1', 'wall-v1.100.0', 'wall-v1.0.0-beta.0', 'wall-v1.2.3-beta.99'])
    assert.throws(() => fromTag(bad), undefined, bad);
  assert.equal(bump('0.1.0', 'patch'), '0.1.1');
  assert.equal(bump('0.1.9', 'minor'), '0.2.0');
  assert.equal(bump('0.9.9', 'major'), '1.0.0');
  console.log('version self-test: PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, arg, flag] = process.argv.slice(2);
  try {
    if (cmd === '--self-test') selfTest();
    else if (cmd === 'from-tag') for (const [k, v] of Object.entries(fromTag(arg))) console.log(`${k}=${v}`);
    else if (cmd === 'bump') {
      const text = readFileSync(propsFile, 'utf8');
      const cur = /^versionName=(\d+\.\d+\.\d+)/m.exec(text)?.[1];
      if (!cur) throw new Error('android/version.properties has no plain versionName');
      const next = bump(cur, arg);
      if (flag === '--write') {
        const code = fromTag(`wall-v${next}`).versionCode;
        writeFileSync(propsFile, text.replace(/^versionName=.*$/m, `versionName=${next}`).replace(/^versionCode=.*$/m, `versionCode=${code}`));
      }
      console.log(`wall-v${next}`);
    } else throw new Error('usage: version.mjs from-tag <tag> | bump <major|minor|patch> [--write] | --self-test');
  } catch (e) { console.error(e.message); process.exit(1); }
}
