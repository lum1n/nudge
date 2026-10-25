#!/bin/sh
# The Android versionCode of a release version, which must grow with every release:
#   major·1000000 + minor·10000 + patch·100, plus 99 for a release and the pre-release's last
#   number (up to 98) for one such as 0.3.0-beta.2, so 0.3.0-beta.2 → 30002 < 0.3.0 → 30099.
#   Only that number counts, so it keeps growing from beta to rc: beta.1, beta.2, rc.3.
#   packages/release/scripts/android-version-code.sh 0.3.0-beta.2
set -eu

# Without leading zeros, which $((…)) would read as octal.
num() {
  n=$(printf '%s' "$1" | sed 's/^0*//')
  echo "${n:-0}"
}

version=${1:?usage: android-version-code.sh <version>}
core=${version%%-*}
case $core in
  *[!0-9.]* | *..* | .* | *.) echo "Not a version: $version" >&2 && exit 1 ;;
esac
IFS=. read -r major minor patch rest <<END
$core
END
if [ -z "${patch:-}" ] || [ -n "${rest:-}" ] || [ "$minor" -gt 99 ] || [ "$patch" -gt 99 ] ||
  [ "$major" -gt 2099 ]; then
  echo "Not a version Android can number: $version" >&2 && exit 1
fi
major=$(num "$major") minor=$(num "$minor") patch=$(num "$patch")
if [ "$core" = "$version" ]; then
  pre=99
else
  # The pre-release's last run of digits, such as 2 in beta.2; 0 without one.
  pre=$(printf '%s' "${version#*-}" | sed 's/.*[^0-9]//')
  case $pre in '' | *[!0-9]*) pre=0 ;; *) pre=$(num "$pre") ;; esac
  [ "$pre" -le 98 ] || pre=98
fi
echo $((major * 1000000 + minor * 10000 + patch * 100 + pre))
