// The Pages root: a plain page that lists the feeds and how to add each. Only the repository slug appears in it.
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function indexPage({ repo, siteUrl }) {
  const r = esc(repo), u = esc(siteUrl), gh = `https://github.com/${r}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Earthshade releases</title>
<style>:root{color-scheme:light dark}body{font:16px/1.5 system-ui,sans-serif;max-width:42rem;margin:0 auto;padding:1.5rem 1rem}code{overflow-wrap:anywhere}li{margin:.6rem 0}</style></head>
<body>
<h1>Earthshade releases</h1>
<p>Builds of the Earthshade apps and the feeds that install and update them. Source: <a href="${gh}">${r}</a>.</p>
<h2>Wall (Android tablet)</h2>
<ul>
<li><strong>F-Droid client</strong> (F-Droid, Droid-ify, Neo Store): Settings, Repositories, add <code>${u}/fdroid/repo</code>. Beta builds too: <code>${u}/fdroid-beta/repo</code>. Accept the repository's key when asked, then install &quot;Earthshade Wall&quot;.</li>
<li><strong>Obtainium</strong>: Add app, paste <code>${gh}</code>, filter release titles with <code>^Wall</code>, turn on &quot;Include prereleases&quot; for beta.</li>
<li><strong>Direct download</strong>: the APK of each release at <a href="${gh}/releases">${gh}/releases</a>.</li>
</ul>
<h2>iPad and iPhone</h2>
<ul>
<li><strong>AltStore</strong>: Browse, Sources, add <code>${u}/altstore.json</code> (beta: <code>${u}/altstore-beta.json</code>).</li>
<li><strong>SideStore</strong>: the same source URLs under Sources.</li>
<li><strong>TestFlight</strong>: by invitation only.</li>
</ul>
</body></html>
`;
}
