# Earthshade releases

Signed builds of Earthshade and the feeds that point at them. This repository holds builds and feeds only; the source is private.

| App | How to get it |
|---|---|
| Wall (Android) | F-Droid client: add `https://<owner>.github.io/earthshade-releases/fdroid/repo` (beta too: `.../fdroid-beta/repo`). Obtainium: add this repository's URL. Or download the APK from Releases. |
| iPad and iPhone | TestFlight (invitation), or AltStore / SideStore: add the source `https://<owner>.github.io/earthshade-releases/altstore.json` (beta too: `.../altstore-beta.json`). |

`<owner>` is this repository's owner. The wall updates itself from `releases/latest/download/update.json`; do not edit it here.
Nothing in this repository is written by hand: the publisher workflow (`.github/workflows/publish.yml`) publishes every release and feed file.
