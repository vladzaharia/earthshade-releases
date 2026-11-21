// What the feeds read: the releases of the public releases repository (GitHub API shape) sorted into APKs and IPAs.
import { fromTag } from '../version.mjs';

// `gh api --paginate` prints one JSON array per page (or, with --jq '.[]', one release per line): accept all of them.
export function parseReleases(text) {
  const t = text.trim();
  if (!t) return [];
  const flat = (v) => (Array.isArray(v) ? v.flatMap(flat) : [v]);
  try { return flat(JSON.parse(t)); } catch { /* not one document: fall through to one per line */ }
  return flat(t.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)));
}

const byNewest = (a, b) => b.versionCode - a.versionCode;

// APK: earthshade-wall-<versionName>.apk. IPA: earthshade-<app>-<versionName>-build<n>.ipa (the build number is CFBundleVersion, which AltStore needs).
export function classify(releases) {
  const apks = [], ipas = [];
  for (const r of releases) {
    if (r.draft) continue;
    let v; try { v = fromTag(r.tag_name); } catch { continue; } // `beta` (the rolling manifest release) and anything else untagged
    for (const a of r.assets ?? []) {
      const base = { tag: r.tag_name, app: v.app, channel: v.channel, versionName: v.versionName, versionCode: v.versionCode,
        name: a.name, url: a.browser_download_url, size: a.size, date: r.published_at, notes: r.body ?? '' };
      if (v.app === 'wall' && a.name.endsWith('.apk')) apks.push(base);
      else if (v.app !== 'wall') {
        const m = /-build(\d+)\.ipa$/.exec(a.name);
        if (m && a.name.startsWith(`earthshade-${v.app}-`)) ipas.push({ ...base, build: m[1] });
      }
    }
  }
  return { apks: apks.sort(byNewest), ipas: ipas.sort(byNewest) };
}
