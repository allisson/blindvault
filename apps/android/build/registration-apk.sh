#!/bin/sh
# The APK that proves to Google's developer verification that the maintainer holds the release key
# (android.md §10, D274, D295): the package io.github.allisson.blindvault, no code, and only the
# Play Console's snippet in assets/adi-registration.properties, signed with the release key. It is
# uploaded to the Play Console once and never published.
#
#   apps/android/build/registration-apk.sh <snippet file> <keystore> <output.apk> [key alias, default blindvault]
#
# Needs ANDROID_HOME with platform 36 and build tools 36.0.0. apksigner asks for the keystore's
# password on the terminal.
set -eu

if [ $# -lt 3 ] || [ $# -gt 4 ]; then
  echo "usage: $0 <snippet file> <keystore> <output.apk> [key alias]" >&2
  exit 2
fi
snippet=$1
keystore=$2
out=$3
alias=${4:-blindvault}
here=$(cd "$(dirname "$0")/.." && pwd)
pinned=$(tr -d '[:space:]' < "$here/release-cert.sha256")
sdk=${ANDROID_HOME:?ANDROID_HOME is not set}
tools="$sdk/build-tools/36.0.0"
work=$(mktemp -d)

mkdir "$work/assets"
cp "$snippet" "$work/assets/adi-registration.properties"
cat > "$work/AndroidManifest.xml" <<'EOF'
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="io.github.allisson.blindvault"
    android:versionCode="1"
    android:versionName="registration">
    <application android:hasCode="false" android:label="BlindVault" />
</manifest>
EOF

"$tools/aapt2" link -o "$work/linked.apk" -I "$sdk/platforms/android-36/android.jar" \
  --manifest "$work/AndroidManifest.xml" -A "$work/assets" \
  --min-sdk-version 34 --target-sdk-version 36
"$tools/zipalign" -p -f 4 "$work/linked.apk" "$work/aligned.apk"
"$tools/apksigner" sign --ks "$keystore" --ks-key-alias "$alias" --out "$out" "$work/aligned.apk"

certs=$("$tools/apksigner" verify --print-certs "$out" | sed -n 's/^Signer #[0-9]* certificate SHA-256 digest: //p')
if [ "$certs" != "$pinned" ]; then
  rm -f "$out"
  echo "the APK's signer is '$certs', not the pinned $pinned" >&2
  exit 1
fi
echo "Registration APK: $out, signed by $pinned"
