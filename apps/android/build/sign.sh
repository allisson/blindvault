#!/bin/sh
# Signs a release's APK on the maintainer's machine (android.md §10, D270): the release key never
# reaches CI. Downloads the unsigned APK the release workflow attached, checks its attestation
# against the tag, signs it (schemes v2 and v3), checks that the signer is the pinned certificate and
# that the published signature, copied onto the unsigned APK with apksigcopier, gives the signed APK
# byte for byte, as a rebuild checks it (docs/build.md), and that the attached asset manifest is the
# APK's, whose hash About shows (D300). Uploads nothing: it prints the commands.
#
#   apps/android/build/sign.sh <tag> <keystore> [key alias, default blindvault]
#
# Needs gh, ANDROID_HOME with build tools 36.0.0, and apksigcopier 1.1.1 on PATH. apksigner asks for
# the keystore's password on the terminal.
set -eu

if [ $# -lt 2 ] || [ $# -gt 3 ]; then
  echo "usage: $0 <tag> <keystore> [key alias]" >&2
  exit 2
fi
tag=$1
keystore=$2
alias=${3:-blindvault}
version=${tag#v}
repo=allisson/blindvault
here=$(cd "$(dirname "$0")/.." && pwd)
pinned=$(tr -d '[:space:]' < "$here/release-cert.sha256")
PATH="${ANDROID_HOME:?ANDROID_HOME is not set}/build-tools/36.0.0:$PATH"
export PATH

unsigned="blindvault-android-$version-unsigned.apk"
signed="blindvault-android-$version.apk"
work=$(mktemp -d)

gh release download "$tag" -R "$repo" -D "$work" -p "$unsigned" -p asset-manifest-android.txt
for file in "$unsigned" asset-manifest-android.txt; do
  gh attestation verify "$work/$file" -R "$repo" \
    --signer-workflow "$repo/.github/workflows/release.yml" --source-ref "refs/tags/$tag"
done
# The attached manifest is the APK's own: its hash is the one About shows.
unzip -p "$work/$unsigned" assets/web/asset-manifest.txt | cmp - "$work/asset-manifest-android.txt"
manifest=$(shasum -a 256 "$work/asset-manifest-android.txt" | cut -d' ' -f1)

apksigner sign --ks "$keystore" --ks-key-alias "$alias" --alignment-preserved \
  --v1-signing-enabled false --v2-signing-enabled true --v3-signing-enabled true \
  --v4-signing-enabled false --out "$work/$signed" "$work/$unsigned"

# One signer, the pinned one.
certs=$(apksigner verify --print-certs "$work/$signed" | sed -n 's/^Signer #[0-9]* certificate SHA-256 digest: //p')
if [ "$certs" != "$pinned" ]; then
  echo "the APK's signer is '$certs', not the pinned $pinned" >&2
  exit 1
fi

# What a rebuild does: the published signature on the unsigned APK gives the signed one.
apksigcopier copy "$work/$signed" "$work/$unsigned" "$work/copied.apk"
cmp "$work/copied.apk" "$work/$signed"

sha=$(shasum -a 256 "$work/$signed" | cut -d' ' -f1)
cat > "$work/android.md" <<EOF

## Android

- \`$signed\` SHA-256: \`$sha\`
- Signing certificate SHA-256: \`$pinned\`
- Asset manifest SHA-256, as About shows it: \`$manifest\`

Install it by hand, or through Obtainium; Android installs over the app only an APK signed by the same key. To check it against this tag, rebuild the unsigned APK and copy this APK's signature onto it, as in [docs/build.md](https://github.com/$repo/blob/$tag/docs/build.md#android).
EOF

echo "Signed and checked: $work/$signed"
echo "sha256 $sha"
echo
echo "To publish, run each one:"
echo "  gh release upload $tag -R $repo '$work/$signed'"
echo "  gh release view $tag -R $repo --json body -q .body > '$work/body.md'"
echo "  cat '$work/android.md' >> '$work/body.md'"
echo "  gh release edit $tag -R $repo --notes-file '$work/body.md'"
