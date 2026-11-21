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

// ---- the hand-over carries the indexes and the one new APK, never the earlier APKs (fdroid-pack.mjs) ----
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { packFdroid, readPrior } from './fdroid-pack.mjs';
import { indexPage } from './index-page.mjs';
import { validateRepoDir } from './fdroid.mjs';

const certOf = () => ({ sig: 'cd'.repeat(16), signer: 'ef'.repeat(32) });
function throwawayKey() {
  const d = tmp(), ks = join(d, 'k.p12');
  execFileSync('keytool', ['-genkeypair', '-keystore', ks, '-storetype', 'PKCS12', '-storepass', 'pw12345', '-keypass', 'pw12345', '-alias', 'fd', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '2', '-dname', 'CN=t'], { stdio: 'ignore' });
  process.env.FDROID_KEYSTORE_PASS = 'pw12345';
  return ks;
}
const apkFile = (v, size = 1000) => { const f = join(tmp(), `earthshade-wall-${v}.apk`); writeFileSync(f, Buffer.alloc(size, v)); return f; };
const SITE = 'https://o.github.io/earthshade-releases';
const listTar = (t) => execFileSync('tar', ['-tf', t], { encoding: 'utf8' }).split('\n').filter(Boolean);
const indexIn = (tar, sub) => { const d = tmp(); execFileSync('tar', ['-xf', tar, '-C', d]); return JSON.parse(readFileSync(join(d, sub, 'repo/index-v1.json'), 'utf8')); };

test('packFdroid: the tar holds indexes and a state file only, and stays the same size when releases pile up and builds are dropped', () => {
  const ks = throwawayKey(), d = tmp(); let prior; const sizes = [];
  for (let n = 1; n <= 9; n++) {
    const out = join(d, `t${n}.tar`);
    packFdroid({ apk: apkFile(`1.0.0-beta.${n}`, 300_000), tag: `wall-v1.0.0-beta.${n}`, siteUrl: SITE, out, prior, keystore: ks, alias: 'fd', certOf, now: new Date(Date.UTC(2026, 10, n)) });
    assert.ok(listTar(out).every((f) => !f.endsWith('.apk')), listTar(out).join());
    sizes.push(statSync(out).size); prior = out;
  }
  assert.ok(Math.max(...sizes.slice(4)) - Math.min(...sizes.slice(4)) < 2048, `size kept flat once the retention is full: ${sizes}`);
  assert.ok(sizes[8] < 64_000, `${sizes[8]} bytes`);
});

test('packFdroid: retention is the newest 5 per repository, stable builds in both, and the index names exactly the kept APKs', () => {
  const ks = throwawayKey(), d = tmp(); let prior;
  const tags = ['1.0.0-beta.1', '1.0.0', '1.0.1-beta.1', '1.0.1-beta.2', '1.0.1', '1.1.0-beta.1', '1.1.0-beta.2', '1.1.0'];
  for (const [i, v] of tags.entries()) { const out = join(d, `t${i}.tar`); packFdroid({ apk: apkFile(v), tag: `wall-v${v}`, siteUrl: SITE, out, prior, keystore: ks, alias: 'fd', certOf }); prior = out; }
  const names = (sub) => indexIn(prior, sub).packages['gg.vlad.earthshade'].map((p) => p.versionName);
  assert.deepEqual(names('fdroid-beta'), ['1.1.0', '1.1.0-beta.2', '1.1.0-beta.1', '1.0.1', '1.0.1-beta.2']);
  assert.deepEqual(names('fdroid'), ['1.1.0', '1.0.1', '1.0.0']);
  const state = readPrior(prior, certOf).map((e) => e.versionName).sort();
  assert.deepEqual(state, ['1.0.0', '1.0.1', '1.0.1-beta.2', '1.1.0', '1.1.0-beta.1', '1.1.0-beta.2']);
});

test('packFdroid: the index it writes is the one the publisher validates once it holds the APKs, and a rerun of a tag replaces its entry', () => {
  const ks = throwawayKey(), d = tmp();
  const a = apkFile('1.0.0-beta.1'), b = apkFile('1.0.0-beta.2', 2000);
  packFdroid({ apk: a, tag: 'wall-v1.0.0-beta.1', siteUrl: SITE, out: join(d, 'a.tar'), keystore: ks, alias: 'fd', certOf });
  packFdroid({ apk: b, tag: 'wall-v1.0.0-beta.2', siteUrl: SITE, out: join(d, 'b.tar'), prior: join(d, 'a.tar'), keystore: ks, alias: 'fd', certOf });
  packFdroid({ apk: b, tag: 'wall-v1.0.0-beta.2', siteUrl: SITE, out: join(d, 'c.tar'), prior: join(d, 'b.tar'), keystore: ks, alias: 'fd', certOf });
  const x = tmp(); execFileSync('tar', ['-xf', join(d, 'c.tar'), '-C', x]);
  const repo = join(x, 'fdroid-beta/repo');
  assert.equal(JSON.parse(readFileSync(join(repo, 'index-v1.json'), 'utf8')).packages['gg.vlad.earthshade'].length, 2);
  assert.equal(existsSync(join(x, 'fdroid')), false); // no stable build yet
  writeFileSync(join(repo, 'earthshade-wall-1.0.0-beta.1.apk'), readFileSync(a)); writeFileSync(join(repo, 'earthshade-wall-1.0.0-beta.2.apk'), readFileSync(b));
  validateRepoDir(repo, { jarsigner: true });
  writeFileSync(join(repo, 'earthshade-wall-1.0.0-beta.2.apk'), 'changed');
  assert.throws(() => validateRepoDir(repo), /beta\.2\.apk does not match its hash/);
});

test('migration: the legacy fdroid.tar (repositories with every APK inside) gives the state, and the next pack keeps that build', () => {
  const ks = throwawayKey(), d = tmp();
  // a legacy tar as fdroidserver left it: the APK renamed to <package>_<versionCode>.apk, named by its index-v1.json
  const old = apkFile('0.1.0-beta.1', 3000), legacy = join(d, 'legacy'); mkdirSync(join(legacy, 'fdroid-beta/repo'), { recursive: true });
  writeFileSync(join(legacy, 'fdroid-beta/repo/gg.vlad.earthshade_10001.apk'), readFileSync(old));
  writeFileSync(join(legacy, 'fdroid-beta/repo/index-v1.json'), JSON.stringify({ packages: { 'gg.vlad.earthshade': [{ apkName: 'gg.vlad.earthshade_10001.apk', versionName: '0.1.0-beta.1', versionCode: 10001 }] } }));
  execFileSync('tar', ['-cf', join(d, 'fdroid.tar'), '-C', legacy, 'fdroid-beta']);
  const prior = readPrior(join(d, 'fdroid.tar'), certOf);
  assert.deepEqual(prior.map((e) => [e.name, e.channel, e.versionCode, e.size, e.sha256]),
    [['earthshade-wall-0.1.0-beta.1.apk', 'beta', 10001, 3000, createHash('sha256').update(readFileSync(old)).digest('hex')]]);
  packFdroid({ apk: apkFile('0.1.0-beta.2'), tag: 'wall-v0.1.0-beta.2', siteUrl: SITE, out: join(d, 'new.tar'), prior: join(d, 'fdroid.tar'), keystore: ks, alias: 'fd', certOf });
  assert.deepEqual(indexIn(join(d, 'new.tar'), 'fdroid-beta').packages['gg.vlad.earthshade'].map((p) => p.apkName), ['earthshade-wall-0.1.0-beta.2.apk', 'earthshade-wall-0.1.0-beta.1.apk']);
  assert.ok(listTar(join(d, 'new.tar')).every((f) => !f.endsWith('.apk')));
  assert.throws(() => readPrior(join(d, 'new.tar').replace('new', 'none'), certOf).length || (() => { throw new Error('empty'); })(), /empty/);
});

test('packFdroid refuses an APK whose name is not its tag, and a corrupt state', () => {
  const ks = throwawayKey(), d = tmp();
  assert.throws(() => packFdroid({ apk: apkFile('1.0.0'), tag: 'wall-v1.0.1', siteUrl: SITE, out: join(d, 'x.tar'), keystore: ks, alias: 'fd', certOf }), /earthshade-wall-1\.0\.1\.apk/);
  packFdroid({ apk: apkFile('1.0.0'), tag: 'wall-v1.0.0', siteUrl: SITE, out: join(d, 'a.tar'), keystore: ks, alias: 'fd', certOf });
  const x = tmp(); execFileSync('tar', ['-xf', join(d, 'a.tar'), '-C', x]);
  const st = JSON.parse(readFileSync(join(x, 'fdroid-state.json'), 'utf8')); st.apks[0].sha256 = 'nothex';
  writeFileSync(join(x, 'fdroid-state.json'), JSON.stringify(st));
  execFileSync('tar', ['-cf', join(d, 'bad.tar'), '-C', x, 'fdroid-state.json']);
  assert.throws(() => readPrior(join(d, 'bad.tar'), certOf), /bad entry/);
});

test('the Pages root has a plain index page that lists every feed and names only the repository', () => {
  const html = indexPage({ repo: REPO, siteUrl: SITE });
  for (const u of [`${SITE}/fdroid/repo`, `${SITE}/fdroid-beta/repo`, `${SITE}/altstore.json`, `${SITE}/altstore-beta.json`, `https://github.com/${REPO}`]) assert.ok(html.includes(u), u);
  assert.match(html, /Obtainium/); assert.match(html, /SideStore/); assert.match(html, /TestFlight/);
  assert.ok(!/<script/.test(html));
  assert.match(indexPage({ repo: 'a"<b', siteUrl: SITE }), /a&quot;&lt;b/);
  const out = tmp(), file = join(tmp(), 'r.json'); writeFileSync(file, JSON.stringify(RELEASES));
  buildSite({ releasesFile: file, assetsDir: '', out, repo: REPO, siteUrl: SITE, fdroidMode: 'none', root: new URL('../../../', import.meta.url).pathname });
  assert.equal(readFileSync(join(out, 'index.html'), 'utf8'), html);
});

test('packFdroid: a build whose release was deleted (not in `held`) drops out of the index and the state, so a rollback does not wedge the next release', () => {
  const ks = throwawayKey(), d = tmp(); let prior;
  for (const n of [1, 2]) { const out = join(d, `t${n}.tar`); packFdroid({ apk: apkFile(`1.0.0-beta.${n}`), tag: `wall-v1.0.0-beta.${n}`, siteUrl: SITE, out, prior, keystore: ks, alias: 'fd', certOf }); prior = out; }
  packFdroid({ apk: apkFile('1.0.0-beta.3'), tag: 'wall-v1.0.0-beta.3', siteUrl: SITE, out: join(d, 't3.tar'), prior, keystore: ks, alias: 'fd', certOf,
    held: new Set(['earthshade-wall-1.0.0-beta.1.apk']) }); // beta.2 was deleted
  assert.deepEqual(indexIn(join(d, 't3.tar'), 'fdroid-beta').packages['gg.vlad.earthshade'].map((p) => p.versionName), ['1.0.0-beta.3', '1.0.0-beta.1']);
  assert.deepEqual(readPrior(join(d, 't3.tar'), certOf).map((e) => e.versionName).sort(), ['1.0.0-beta.1', '1.0.0-beta.3']);
});
