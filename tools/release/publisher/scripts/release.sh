#!/bin/bash
# Creates or updates the GitHub Release for a verified, planned hand-over (needs gh and GH_TOKEN; run by publish.yml, safe to rerun).
#   release.sh stage|finish <incoming dir> <plan dir> <owner/name>
# stage: the release is made as a draft with all its assets (nothing public). finish: it is published and the rolling beta release moves; publish.yml
# runs it only after the feeds are deployed, so a failure before that leaves nothing public.
set -eu -o pipefail
MODE="${1:?stage|finish}"; IN="${2:?}"; PL="${3:?}"; REPO="${4:?}"
j() { node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1]));const v=process.argv[2].split(".").reduce((o,k)=>o?.[k],p);console.log(Array.isArray(v)?v.join("\n"):v)' "$PL/plan.json" "$1"; }
TAG="$(j release.tag)"; TITLE="$(j release.title)"; NOTES="$(j release.notes)"
[ "$(j release.latest)" = true ] && LATEST=(--latest) || LATEST=(--latest=false)
[ "$(j release.prerelease)" = true ] && PRE=true || PRE=false
ASSETS=(); while IFS= read -r n; do ASSETS+=("$IN/$n"); done < <(j release.assets)
[ "$(j hasUpdateJson)" = true ] && ASSETS+=("$PL/update.json")
TARGET="$(gh api "repos/$REPO" --jq .default_branch)"
if [ "$MODE" = stage ]; then
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  gh release upload "$TAG" "${ASSETS[@]}" --repo "$REPO" --clobber
else
  gh release create "$TAG" "${ASSETS[@]}" --repo "$REPO" --target "$TARGET" --draft --title "$TITLE" --notes "$NOTES"
fi
echo "staged $TAG"; exit 0
fi
gh release edit "$TAG" --repo "$REPO" --draft=false --prerelease="$PRE" "${LATEST[@]}"
# The rolling `beta` release carries the newest manifest of either channel (plan.mjs decided whether this one is newer).
if [ "$(j hasUpdateJson)" = true ] && [ "$(j moveBeta)" = true ]; then
  if gh release view beta --repo "$REPO" >/dev/null 2>&1; then gh release upload beta "$PL/update.json" --repo "$REPO" --clobber
  else gh release create beta "$PL/update.json" --repo "$REPO" --target "$TARGET" --prerelease --title "Beta channel" --notes "Rolling release: update.json here is the beta channel."; fi
fi
echo "published $TAG"
