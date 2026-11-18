#!/usr/bin/env bash
set -euo pipefail

bun_path="${TEST_SRCDIR}/$1"
export LANG_WEAVE_PLAYWRIGHT="${TEST_SRCDIR}/$2"
runfiles_root="${TEST_SRCDIR}/${TEST_WORKSPACE}"
: "${LANG_WEAVE_CHROMIUM:?Pass --test_env=LANG_WEAVE_CHROMIUM=/absolute/path/to/chromium}"
[[ "$LANG_WEAVE_CHROMIUM" = /* && -x "$LANG_WEAVE_CHROMIUM" ]]
export LANG_WEAVE_WELCOME_EXTENSION="${TEST_TMPDIR}/extension"
# The packaged manifest and all of its files are loaded exactly as extracted.
python3 -m zipfile -e "${runfiles_root}/lang-weave-beta.zip" "$LANG_WEAVE_WELCOME_EXTENSION"
# Chromium uses a Unix socket whose path cannot fit under the Bazel test directory.
export TMPDIR=/tmp
export DO_NOT_TRACK=1
exec "$bun_path" "${runfiles_root}/extension/e2e/welcome.mjs"
