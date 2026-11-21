// Self-tests for the feed builders and validators: node --test tools/release/feeds/   (CI runs this; no network, no secrets, no fdroidserver needed)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseReleases, classify } from './lib.mjs';
import { buildSource, validateSource } from './altstore.mjs';
import { selectApks, prepareRepo, indexV1, validateIndexV1, sigFromPem } from './fdroid.mjs';
import { buildSite } from './build.mjs';

const REPO = 'o/earthshade-releases';
const asset = (name, size = 10) => ({ name, size, browser_download_url: `https://github.com/${REPO}/releases/download/x/${name}` });
const rel = (tag, assets, over = {}) => ({ tag_name: tag, draft: false, prerelease: /beta/.test(tag), published_at: '2026-11-20T10:00:00Z', body: `notes ${tag}`, assets, ...over });
const RELEASES = [
  rel('wall-v1.2.3', [asset('earthshade-wall-1.2.3.apk'), asset('update.json')]),
  rel('wall-v1.3.0-beta.1', [asset('earthshade-wall-1.3.0-beta.1.apk')]),
  rel('wall-v1.2.2', [asset('earthshade-wall-1.2.2.apk')]),
  rel('desk-v0.2.0', [asset('earthshade-desk-0.2.0-build57.ipa', 5000)]),
  rel('desk-v0.3.0-beta.1', [asset('earthshade-desk-0.3.0-beta.1-build60.ipa', 6000)]),
  rel('phone-v0.1.0', [asset('earthshade-phone-0.1.0-build58.ipa', 4000)]),
  rel('beta', [asset('update.json')], { prerelease: true }),
  rel('wall-v9.9.9', [asset('earthshade-wall-9.9.9.apk')], { draft: true }),
  rel('desk-v0.1.0', [asset('notes.txt')]),
];
const APPS = JSON.parse(readFileSync(new URL('../../../ios/release/apps.json', import.meta.url), 'utf8'));
const tmp = () => mkdtempSync(join(tmpdir(), 'feeds-'));

test('parseReleases takes an array or the lines gh api --paginate --jq .[] prints', () => {
  assert.equal(parseReleases(JSON.stringify(RELEASES)).length, RELEASES.length);
  assert.equal(parseReleases(RELEASES.map((r) => JSON.stringify(r)).join('\n')).length, RELEASES.length);
  assert.equal(parseReleases(JSON.stringify([RELEASES.slice(0, 2), RELEASES.slice(2, 3)])).length, 3); // --paginate without --slurp can nest pages
});

test('classify keeps tagged APK and IPA assets, newest version first, and skips drafts, the rolling beta and releases without a build', () => {
  const { apks, ipas } = classify(RELEASES);
  assert.deepEqual(apks.map((a) => a.versionName), ['1.3.0-beta.1', '1.2.3', '1.2.2']);
  assert.equal(apks[1].versionCode, 1020399);
  assert.equal(apks[0].channel, 'beta');
  const desk = ipas.filter((i) => i.app === 'desk').map((i) => i.versionName);
  assert.deepEqual(desk, ['0.3.0-beta.1', '0.2.0']);
  assert.equal(ipas.find((i) => i.versionName === '0.2.0').size, 5000);
  assert.equal(classify([rel('desk-v1.0.0', [asset('earthshade-desk-1.0.0.ipa')])]).ipas.length, 0); // no build number in the name: refused, not guessed
});

test('AltStore source: stable has only stable builds, beta has both, each newest first, and both validate', () => {
  const { ipas } = classify(RELEASES);
  const cfg = { siteUrl: 'https://o.github.io/earthshade-releases', apps: APPS };
  const stable = buildSource({ ipas, channel: 'stable', ...cfg });
  const beta = buildSource({ ipas, channel: 'beta', ...cfg });
  validateSource(stable); validateSource(beta);
  const desk = (s) => s.apps.find((a) => a.bundleIdentifier === 'gg.vlad.earthshade.desk');
  assert.deepEqual(desk(stable).versions.map((v) => v.version), ['0.2.0']);
  assert.deepEqual(desk(beta).versions.map((v) => v.version), ['0.3.0', '0.2.0']); // the IPA's CFBundleShortVersionString (apple-plan strips -beta.N)
  assert.match(desk(beta).versions[0].localizedDescription, /0\.3\.0-beta\.1/);
  assert.deepEqual(Object.keys(desk(beta).appPermissions.privacy).sort(), ['NSCameraUsageDescription', 'NSMicrophoneUsageDescription', 'NSSpeechRecognitionUsageDescription']);
  assert.equal(desk(beta).versions[0].buildVersion, '60');
  assert.equal(desk(beta).versions[0].size, 6000);
  assert.match(desk(beta).versions[0].downloadURL, /\.ipa$/);
  assert.match(desk(beta).versions[0].date, /^2026-11-20T10:00:00Z$/);
  assert.ok(stable.apps.some((a) => a.bundleIdentifier === 'gg.vlad.earthshade.phone'));
  assert.notEqual(stable.name, beta.name);
});

test('AltStore source: an app without a build is left out, and the validator names what is missing', () => {
  const { ipas } = classify(RELEASES);
  const s = buildSource({ ipas: ipas.filter((i) => i.app === 'desk'), channel: 'stable', siteUrl: 'https://x', apps: APPS });
  assert.equal(s.apps.length, 1);
  const bad = structuredClone(s);
  delete bad.apps[0].versions[0].downloadURL;
  assert.throws(() => validateSource(bad), /downloadURL/);
  const bad2 = structuredClone(s); bad2.apps[0].versions[0].date = 'yesterday';
  assert.throws(() => validateSource(bad2), /date/);
  const bad3 = structuredClone(s); delete bad3.apps[0].bundleIdentifier;
  assert.throws(() => validateSource(bad3), /bundleIdentifier/);
});

test('selectApks: the stable repo has only stable builds, the beta repo the newest of each kind, both capped', () => {
  const { apks } = classify(RELEASES);
  assert.deepEqual(selectApks(apks, 'stable', 5).map((a) => a.versionName), ['1.2.3', '1.2.2']);
  assert.deepEqual(selectApks(apks, 'beta', 5).map((a) => a.versionName), ['1.3.0-beta.1', '1.2.3', '1.2.2']);
  assert.deepEqual(selectApks(apks, 'stable', 1).map((a) => a.versionName), ['1.2.3']);
});

test('F-Droid index-v1 from APKs validates, carries versionCode order, and the validator catches a broken one', () => {
  const { apks } = classify(RELEASES);
  const chosen = selectApks(apks, 'beta', 5).map((a) => ({ ...a, sha256: 'ab'.repeat(32), sig: 'cd'.repeat(16), signer: 'ef'.repeat(32) }));
  const idx = indexV1({ apks: chosen, repoUrl: 'https://o.github.io/earthshade-releases/fdroid-beta/repo', name: 'Earthshade beta', now: 1763632800000 });
  validateIndexV1(idx);
  assert.equal(idx.repo.timestamp, 1763632800000);
  assert.equal(idx.apps[0].packageName, 'gg.vlad.earthshade');
  assert.equal(idx.apps[0].suggestedVersionCode, String(chosen[0].versionCode));
  assert.deepEqual(idx.packages['gg.vlad.earthshade'].map((p) => p.versionCode), chosen.map((a) => a.versionCode));
  assert.equal(idx.packages['gg.vlad.earthshade'][0].apkName, 'earthshade-wall-1.3.0-beta.1.apk');
  const bad = structuredClone(idx); delete bad.packages['gg.vlad.earthshade'][0].hash;
  assert.throws(() => validateIndexV1(bad), /hash/);
  const bad2 = structuredClone(idx); bad2.apps.push({ ...bad2.apps[0], packageName: 'other' });
  assert.throws(() => validateIndexV1(bad2), /other/);
});

test('sigFromPem is the md5 of the hex of the certificate, as F-Droid defines sig', () => {
  const der = Buffer.from('certificate bytes');
  const pem = `-----BEGIN CERTIFICATE-----\n${der.toString('base64')}\n-----END CERTIFICATE-----\n`;
  const r = sigFromPem(pem);
  assert.equal(r.sig, createHash('md5').update(der.toString('hex')).digest('hex'));
  assert.equal(r.signer, createHash('sha256').update(der).digest('hex'));
  assert.throws(() => sigFromPem('nothing'), /certificate/);
});

test('prepareRepo writes config.yml (quoted secrets), metadata and the APKs; the config is private', () => {
  const dir = tmp(), assets = tmp();
  writeFileSync(join(assets, 'earthshade-wall-1.2.3.apk'), 'apk');
  const { apks } = classify(RELEASES);
  prepareRepo({ dir, assetsDir: assets, apks: selectApks(apks, 'stable', 1), repoUrl: 'https://o.github.io/r/fdroid/repo', name: 'Earthshade',
    keystore: '/k/ks.p12', alias: 'rel', storePass: 'p"w: #1' });
  const cfg = readFileSync(join(dir, 'config.yml'), 'utf8');
  assert.match(cfg, /repo_url: "https:\/\/o.github.io\/r\/fdroid\/repo"/);
  assert.match(cfg, /keystorepass: "p\\"w: #1"/);
  assert.match(cfg, /repo_keyalias: "rel"/);
  assert.equal(statModeOf(join(dir, 'config.yml')), 0o600);
  assert.ok(existsSync(join(dir, 'repo/earthshade-wall-1.2.3.apk')));
  assert.match(readFileSync(join(dir, 'metadata/gg.vlad.earthshade.yml'), 'utf8'), /Name: Earthshade Wall/);
  assert.throws(() => prepareRepo({ dir: tmp(), assetsDir: tmp(), apks: selectApks(apks, 'stable', 1), repoUrl: 'u', name: 'n', keystore: 'k', alias: 'a', storePass: 'p' }), /earthshade-wall-1.2.3.apk/);
});
import { statSync } from 'node:fs';
const statModeOf = (p) => statSync(p).mode & 0o777;

test('buildSite writes both AltStore sources, the icons, a README and the list of APKs to download', () => {
  const out = tmp(), assets = tmp(), file = join(tmp(), 'r.json');
  writeFileSync(join(assets, 'earthshade-wall-1.2.3.apk'), 'a'); writeFileSync(join(assets, 'earthshade-wall-1.3.0-beta.1.apk'), 'b'); writeFileSync(join(assets, 'earthshade-wall-1.2.2.apk'), 'c');
  writeFileSync(file, JSON.stringify(RELEASES));
  const r = buildSite({ releasesFile: file, assetsDir: assets, out, repo: REPO, siteUrl: 'https://o.github.io/earthshade-releases', fdroidMode: 'none', root: new URL('../../../', import.meta.url).pathname });
  assert.ok(existsSync(join(out, 'altstore.json')) && existsSync(join(out, 'altstore-beta.json')));
  assert.ok(existsSync(join(out, 'README.md')) && existsSync(join(out, '.nojekyll')));
  assert.deepEqual(r.downloads.map((d) => d.name).sort(), ['earthshade-wall-1.2.2.apk', 'earthshade-wall-1.2.3.apk', 'earthshade-wall-1.3.0-beta.1.apk']);
  assert.ok(readdirSync(join(out, 'icons')).length >= 2);
});

test('AltStore source: a hotfix published after a newer beta does not fail validation', () => {
  const rs = [rel('desk-v0.3.0-beta.1', [asset('earthshade-desk-0.3.0-beta.1-build60.ipa')]),
    rel('desk-v0.2.1', [asset('earthshade-desk-0.2.1-build61.ipa')], { published_at: '2026-11-21T10:00:00Z' })];
  const s = buildSource({ ipas: classify(rs).ipas, channel: 'beta', siteUrl: 'https://x', apps: APPS });
  validateSource(s);
  assert.deepEqual(s.apps[0].versions.map((v) => v.buildVersion), ['60', '61']);
});
