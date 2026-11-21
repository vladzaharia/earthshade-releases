// The publisher's plan: update.json, the versionCode guard per channel and what the rolling beta release does.
import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { plan } from './plan.mjs';

const mf = (tag, extra = {}) => ({ v: 1, tag, ...extra });
const wallIncoming = (tag, versionName, versionCode, channel) => ({ tag, app: 'wall', channel, versionName, versionCode,
  files: [{ name: `earthshade-wall-${versionName}.apk`, role: 'apk', sha256: 'ab'.repeat(32), size: 9 }] });
const bytes = Buffer.from('apk bytes');
const base = { repo: 'o/earthshade-releases', apkBytes: bytes, now: '2026-11-20T10:00:00Z' };
const cur = (versionCode, sha256 = 'cd'.repeat(32)) => ({ versionCode, sha256 });

test('a stable wall release is latest and replaces the beta manifest when newer', () => {
  const p = plan({ ...base, incoming: wallIncoming('wall-v1.2.3', '1.2.3', 1020399, 'stable'), current: cur(1010199), beta: cur(1020301) });
  assert.equal(p.release.latest, true); assert.equal(p.release.prerelease, false);
  assert.equal(p.updateJson.versionCode, 1020399);
  assert.equal(p.updateJson.apkUrl, 'https://github.com/o/earthshade-releases/releases/download/wall-v1.2.3/earthshade-wall-1.2.3.apk');
  assert.equal(p.moveBeta, true); assert.equal(p.betaExists, true);
});

test('a beta release is a pre-release and only moves beta when newer', () => {
  const inc = wallIncoming('wall-v1.2.4-beta.1', '1.2.4-beta.1', 1020401, 'beta');
  assert.equal(plan({ ...base, incoming: inc, current: cur(1020301), beta: null }).release.prerelease, true);
  assert.equal(plan({ ...base, incoming: inc, current: cur(1020301), beta: null }).betaExists, false);
  assert.equal(plan({ ...base, incoming: inc, current: cur(1020301), beta: cur(1020500) }).moveBeta, false);
});

test('a versionCode not above the channel current is refused, an identical rerun is not', () => {
  const inc = wallIncoming('wall-v1.2.3', '1.2.3', 1020399, 'stable');
  assert.throws(() => plan({ ...base, incoming: inc, current: cur(1020399) }), /not above/);
  assert.throws(() => plan({ ...base, incoming: inc, current: cur(1030199) }), /not above/);
  const sha = createHash('sha256').update(bytes).digest('hex');
  assert.equal(plan({ ...base, incoming: inc, current: cur(1020399, sha) }).updateJson.versionCode, 1020399);
});

test('an Apple release is never latest and has no update.json', () => {
  const p = plan({ ...base, incoming: { tag: 'desk-v0.2.0-beta.1', app: 'desk', channel: 'beta', versionName: '0.2.0-beta.1', versionCode: 20001,
    files: [{ name: 'earthshade-desk-0.2.0-beta.1-build5.ipa', role: 'ipa', sha256: 'ab'.repeat(32), size: 9 }] }, apkBytes: null });
  assert.equal(p.release.latest, false); assert.equal(p.release.prerelease, true); assert.equal(p.updateJson, null); assert.equal(p.moveBeta, false);
  const s = plan({ ...base, incoming: { tag: 'phone-v0.1.0', app: 'phone', channel: 'stable', versionName: '0.1.0', versionCode: 10099,
    files: [{ name: 'earthshade-phone-0.1.0-build6.ipa', role: 'ipa', sha256: 'ab'.repeat(32), size: 9 }] }, apkBytes: null });
  assert.equal(s.release.latest, false); assert.equal(s.release.prerelease, false);
});
