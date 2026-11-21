#!/bin/bash
# Prints the SHA-256 (lower-case hex) of the APK's signing certificate. Needs apksigner (Android build-tools) on PATH or under ANDROID_HOME.
#   tools/release/apk-cert.sh app-release.apk
# With --check <file>, exits 1 unless the certificate equals the first hex word in <file> (tools/release/release-cert.sha256).
set -eu -o pipefail
CHECK=""; if [ "${1:-}" = "--check" ]; then CHECK="$2"; shift 2; fi
APK="${1:?usage: apk-cert.sh [--check release-cert.sha256] <apk>}"
SIGNER="$(command -v apksigner || true)"
[ -n "$SIGNER" ] || SIGNER="$(ls -d "${ANDROID_HOME:-/nonexistent}"/build-tools/*/apksigner 2>/dev/null | sort -V | tail -1 || true)"
[ -n "$SIGNER" ] || { echo "apksigner not found (install Android build-tools)" >&2; exit 2; }
CERT="$("$SIGNER" verify --print-certs "$APK" | sed -nE 's/^(Signer #1|V[0-9.]+ Signer):? certificate SHA-256 digest: //p' | head -1 | tr 'A-F' 'a-f')"
[ -n "$CERT" ] || { echo "could not read the signing certificate of $APK" >&2; exit 2; }
if [ -z "$CHECK" ]; then echo "$CERT"; exit 0; fi
WANT="$(grep -Eo '[0-9a-fA-F]{64}' "$CHECK" | head -1 | tr 'A-F' 'a-f' || true)"
[ -n "$WANT" ] || { echo "$CHECK holds no SHA-256 yet: the owner records the release key's certificate there (docs/ship/release.md)" >&2; exit 1; }
[ "$CERT" = "$WANT" ] || { echo "signing certificate $CERT is not the release key's $WANT" >&2; exit 1; }
echo "signing certificate matches the release key"
