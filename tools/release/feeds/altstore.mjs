// The AltStore / SideStore source (https://faq.altstore.io/developers/make-a-source): one JSON per channel, apps from ios/release/apps.json.
// stable: stable builds only. beta: every build, newest first (a source has no channels, and the order of `versions` decides what is newest).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function buildSource({ ipas, channel, siteUrl, apps }) {
  const out = [];
  for (const [key, cfg] of Object.entries(apps)) {
    if (key.startsWith('_') || !cfg.bundleId) continue;
    const versions = ipas.filter((i) => i.app === key && (channel === 'beta' || i.channel === 'stable')).map((i) => ({
      version: i.versionName.replace(/-beta\.\d+$/, ''), buildVersion: i.build, date: i.date, downloadURL: i.url, size: i.size,
      localizedDescription: i.notes || `${cfg.displayName} ${i.versionName}`, minOSVersion: cfg.minOSVersion ?? '26.0',
    }));
    if (!versions.length) continue;
    out.push({ name: cfg.displayName, bundleIdentifier: cfg.bundleId, developerName: cfg.developerName ?? 'Earthshade', subtitle: cfg.subtitle,
      localizedDescription: cfg.description, iconURL: `${siteUrl}/icons/${key}.png`, tintColor: cfg.tintColor ?? '#2F6F5E', category: 'lifestyle',
      versions, appPermissions: cfg.permissions ?? { entitlements: [], privacy: {} } });
  }
  return { name: channel === 'beta' ? 'Earthshade (beta)' : 'Earthshade', subtitle: channel === 'beta' ? 'Stable and beta builds' : 'Stable builds',
    description: 'Earthshade for iPad and iPhone, signed by your own Apple ID when you install.', website: siteUrl, iconURL: `${siteUrl}/icons/desk.png`,
    tintColor: '#2F6F5E', apps: out, news: [] };
}

// Fields the format lists as required (docs above); throws naming the first thing wrong.
export function validateSource(s) {
  const need = (o, k, where, type = 'string') => { if (typeof o?.[k] !== type || (type === 'string' && !o[k])) throw new Error(`${where}: ${k} must be a ${type}`); };
  need(s, 'name', 'source');
  if (!Array.isArray(s.apps) || !Array.isArray(s.news)) throw new Error('source: apps and news must be arrays');
  const seen = new Set();
  for (const a of s.apps) {
    const w = `app ${a?.name ?? '?'}`;
    for (const k of ['name', 'bundleIdentifier', 'developerName', 'localizedDescription', 'iconURL']) need(a, k, w);
    if (seen.has(a.bundleIdentifier)) throw new Error(`${w}: bundleIdentifier repeated`);
    seen.add(a.bundleIdentifier);
    if (!/^https:\/\//.test(a.iconURL)) throw new Error(`${w}: iconURL must be https`);
    if (!a.versions?.length) throw new Error(`${w}: no versions`);
    if (typeof a.appPermissions !== 'object' || typeof a.appPermissions.privacy !== 'object') throw new Error(`${w}: appPermissions.privacy missing`);
    for (const v of a.versions) {
      const vw = `${w} ${v?.version ?? '?'}`;
      for (const k of ['version', 'buildVersion', 'date', 'downloadURL']) need(v, k, vw);
      need(v, 'size', vw, 'number');
      if (!/^https:\/\/.+\.ipa$/.test(v.downloadURL)) throw new Error(`${vw}: downloadURL must be an https .ipa`);
      if (!/^\d{4}-\d\d-\d\d(T[\d:.]+(Z|[+-]\d\d:\d\d))?$/.test(v.date) || Number.isNaN(Date.parse(v.date))) throw new Error(`${vw}: date must be ISO 8601 (${v.date})`);
    }
    // order is the builder's (versionCode, newest first); dates are not compared: a hotfix can be newer than a later version's beta
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === 'validate') {
  try { validateSource(JSON.parse(readFileSync(process.argv[3], 'utf8'))); console.log(`${process.argv[3]}: valid`); } catch (e) { console.error(e.message); process.exit(1); }
}
