#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" != 2 || "$2" != /* ]]; then
    echo 'Usage: bazel run //:beta_zip -- /absolute/new/output/directory' >&2
    exit 2
fi

bun_path="${RUNFILES_DIR:-$0.runfiles}/$1"
checkout="${BUILD_WORKSPACE_DIRECTORY:?Run this target with bazel run}"
# Stage only committed inputs. The archive preserves source symlinks for the
# packager to reject and cannot include an ignored file from the checkout.
revision=$(git -C "$checkout" rev-parse HEAD)
staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT
git -C "$checkout" archive "$revision" -- \
    LICENSE LICENSE-MIT NOTICE extension/manifest.json extension/_locales \
    extension/icons extension/src extension/scripts/content-bundle.mjs extension/scripts/package.mjs |
    tar -xf - -C "$staging"

# Reserve a fresh directory so an older ZIP cannot be replaced.
mkdir -- "$2"
echo "Packaging revision $revision"
export DO_NOT_TRACK=1
"$bun_path" "$staging/extension/scripts/package.mjs" --out "$2"
