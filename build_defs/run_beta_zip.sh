#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" != 2 || "$2" != /* ]]; then
    echo 'Usage: bazel run //:beta_zip -- /absolute/new/output/directory' >&2
    exit 2
fi

bun_path="${RUNFILES_DIR:-$0.runfiles}/$1"
checkout="${BUILD_WORKSPACE_DIRECTORY:?Run this target with bazel run}"
# The packager rejects source symlinks itself. Give it the checkout, since
# Bazel's runfiles links would hide which files were symlinks in that checkout.
# Reserve a fresh directory so an older ZIP cannot be replaced.
mkdir -- "$2"
export DO_NOT_TRACK=1
exec "$bun_path" "$checkout/extension/scripts/package.mjs" --out "$2"
