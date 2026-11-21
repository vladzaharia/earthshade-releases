// A self-hosted F-Droid repository for the wall APK (https://f-droid.org/docs/Setup_an_F-Droid_App_Repo/).
// In CI fdroidserver (`fdroid update`) writes and signs the index from the directory prepareRepo builds. Without fdroidserver (the local dry run)
// indexV1 + signIndex write the same documented index-v1 structure and sign it with jarsigner, so the validator and the layout are exercised.
import { writeFileSync, readFileSync, mkdirSync, copyFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE = 'gg.vlad.earthshade';
const APP = { name: 'Earthshade Wall', summary: 'The household calendar on the wall tablet',
  description: 'Earthshade Wall is the always-on household calendar for a wall-mounted Android tablet. It pairs with your own Earthshade service.' };

// stable repo: stable builds only. beta repo: every build. Newest `keep` of them (older ones stay on the releases page, not in the repo).
export function selectApks(apks, channel, keep = 5) {
  return apks.filter((a) => channel === 'beta' || a.channel === 'stable').sort((a, b) => b.versionCode - a.versionCode).slice(0, keep);
}

const q = (s) => JSON.stringify(String(s)); // a JSON string is a valid double-quoted YAML scalar

export function prepareRepo({ dir, assetsDir, apks, repoUrl, name, keystore, alias, storePass }) {
  rmSync(dir, { recursive: true, force: true });
  for (const d of ['repo', 'metadata']) mkdirSync(join(dir, d), { recursive: true });
  for (const a of apks) {
    const src = join(assetsDir, a.name);
    if (!existsSync(src)) throw new Error(`missing ${a.name} in ${assetsDir}`);
    copyFileSync(src, join(dir, 'repo', a.name));
  }
  const cfg = join(dir, 'config.yml');
  writeFileSync(cfg, [`repo_url: ${q(repoUrl)}`, `repo_name: ${q(name)}`, `repo_description: ${q(`${name}: signed builds of the Earthshade wall app.`)}`,
    `keystore: ${q(keystore)}`, `repo_keyalias: ${q(alias)}`, `keystorepass: ${q(storePass)}`, `keypass: ${q(storePass)}`,
    `keydname: "CN=Earthshade releases"`, `make_current_version_link: false`, `archive_older: 0`, ''].join('\n'));
  chmodSync(cfg, 0o600);
  writeFileSync(join(dir, 'metadata', `${PACKAGE}.yml`), [`Categories:`, `  - System`, `License: Unknown`, `Name: ${APP.name}`, `Summary: ${q(APP.summary)}`,
    `Description: ${q(APP.description)}`, ''].join('\n'));
}

// F-Droid's `sig`: md5 of the hex text of the signing certificate (DER); `signer` is its SHA-256.
export function sigFromPem(pem) {
  const m = /-----BEGIN CERTIFICATE-----([^-]+)-----END CERTIFICATE-----/.exec(pem);
  if (!m) throw new Error('no certificate in the PEM');
  const der = Buffer.from(m[1].replace(/\s+/g, ''), 'base64');
  return { sig: createHash('md5').update(der.toString('hex')).digest('hex'), signer: createHash('sha256').update(der).digest('hex') };
}

export function certOfApk(apk) {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '';
  let signer = 'apksigner';
  try { execFileSync('sh', ['-c', 'command -v apksigner'], { stdio: 'ignore' }); } catch {
    const found = execFileSync('sh', ['-c', `ls -d "${sdk}"/build-tools/*/apksigner 2>/dev/null | sort -V | tail -1`], { encoding: 'utf8' }).trim();
    if (!found) throw new Error('apksigner not found (Android build-tools)');
    signer = found;
  }
  return sigFromPem(execFileSync(signer, ['verify', '--print-certs-pem', apk], { encoding: 'utf8' }));
}

// apks: selectApks entries plus sha256, sig, signer. Order: newest first, as F-Droid lists packages.
export function indexV1({ apks, repoUrl, name, now = Date.now() }) {
  const ms = (a) => Date.parse(a.date);
  return {
    repo: { timestamp: now, version: 21, maxage: 14, name, icon: 'icon.png', address: repoUrl, description: `${name}: signed builds of the Earthshade wall app.`, mirrors: [] },
    requests: { install: [], uninstall: [] },
    apps: [{ packageName: PACKAGE, name: APP.name, summary: APP.summary, description: APP.description, license: 'Unknown', categories: ['System'],
      added: Math.min(...apks.map(ms)), lastUpdated: Math.max(...apks.map(ms)), suggestedVersionCode: String(apks[0].versionCode), localized: { 'en-US': { name: APP.name, summary: APP.summary, description: APP.description } } }],
    packages: { [PACKAGE]: apks.map((a) => ({ packageName: PACKAGE, versionName: a.versionName, versionCode: a.versionCode, apkName: a.name, hash: a.sha256, hashType: 'sha256',
      sig: a.sig, signer: a.signer, size: a.size, minSdkVersion: 31, targetSdkVersion: 37, added: ms(a), features: [], nativecode: [] })) },
  };
}

export function validateIndexV1(i) {
  const bad = (m) => { throw new Error(`index-v1: ${m}`); };
  for (const k of ['timestamp', 'version', 'name', 'address']) if (i.repo?.[k] === undefined) bad(`repo.${k} missing`);
  if (!/^https:\/\//.test(i.repo.address)) bad('repo.address must be https');
  if (!Array.isArray(i.apps) || !i.apps.length) bad('no apps');
  for (const a of i.apps) {
    for (const k of ['packageName', 'name', 'added', 'lastUpdated']) if (a[k] === undefined) bad(`app ${a.packageName ?? '?'} lacks ${k}`);
    if (!i.packages?.[a.packageName]?.length) bad(`app ${a.packageName} has no packages`);
  }
  for (const [pkg, list] of Object.entries(i.packages)) {
    if (!i.apps.some((a) => a.packageName === pkg)) bad(`packages lists ${pkg}, which is not in apps`);
    for (const p of list) for (const k of ['versionName', 'versionCode', 'apkName', 'hash', 'hashType', 'sig', 'signer', 'size', 'minSdkVersion', 'added'])
      if (p[k] === undefined || p[k] === '') bad(`${pkg} ${p.versionName ?? '?'} lacks ${k}`);
    if (list.some((p, n) => n && p.versionCode > list[n - 1].versionCode)) bad(`${pkg}: packages must be newest first`);
    for (const p of list) if (!/^[0-9a-f]{64}$/.test(p.hash)) bad(`${pkg} ${p.versionName}: hash is not a SHA-256`);
  }
}

// Structure check of the repo directory fdroidserver or signIndex wrote: index-v1.json (+ jar) or the v2 pair, and the APKs the index names.
export function validateRepoDir(repoDir, { jarsigner = false } = {}) {
  const v1 = join(repoDir, 'index-v1.json');
  if (existsSync(v1)) {
    const idx = JSON.parse(readFileSync(v1, 'utf8'));
    validateIndexV1(idx);
    for (const list of Object.values(idx.packages)) for (const p of list) {
      const f = join(repoDir, p.apkName);
      if (!existsSync(f)) throw new Error(`index-v1: ${p.apkName} is not in the repo`);
      if (createHash('sha256').update(readFileSync(f)).digest('hex') !== p.hash) throw new Error(`index-v1: ${p.apkName} does not match its hash`);
    }
    if (!existsSync(join(repoDir, 'index-v1.jar'))) throw new Error('index-v1.jar (the signed index) is missing');
    if (jarsigner) execFileSync('jarsigner', ['-verify', join(repoDir, 'index-v1.jar')], { stdio: 'pipe' });
    return;
  }
  for (const f of ['entry.jar', 'index-v2.json']) if (!existsSync(join(repoDir, f))) throw new Error(`neither index-v1.json nor ${f} in ${repoDir}`);
  const v2 = JSON.parse(readFileSync(join(repoDir, 'index-v2.json'), 'utf8'));
  if (!v2.repo?.timestamp || !v2.packages?.[PACKAGE]?.versions) throw new Error('index-v2.json: repo or packages missing');
}

// Local dry run: write index-v1.json from the APKs in <dir>/repo and sign it into index-v1.jar with jarsigner (the password stays in the environment).
export function signIndex({ dir, apks, repoUrl, name, keystore, alias, passEnv = 'FDROID_KEYSTORE_PASS' }) {
  const withCert = apks.map((a) => {
    const f = join(dir, 'repo', a.name), buf = readFileSync(f);
    return { ...a, ...certOfApk(f), sha256: createHash('sha256').update(buf).digest('hex'), size: buf.length };
  });
  const repo = join(dir, 'repo');
  writeFileSync(join(repo, 'index-v1.json'), JSON.stringify(indexV1({ apks: withCert, repoUrl, name })));
  rmSync(join(repo, 'index-v1.jar'), { force: true });
  execFileSync('zip', ['-q', '-j', 'index-v1.jar', 'index-v1.json'], { cwd: repo });
  execFileSync('jarsigner', ['-keystore', keystore, `-storepass:env`, passEnv, '-sigalg', 'SHA256withRSA', '-digestalg', 'SHA256', 'index-v1.jar', alias], { cwd: repo, stdio: 'pipe' });
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === 'validate') {
  try { validateRepoDir(process.argv[3], { jarsigner: process.argv.includes('--jarsigner') }); console.log(`${process.argv[3]}: valid`); } catch (e) { console.error(e.message); process.exit(1); }
}
