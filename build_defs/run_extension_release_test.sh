#!/usr/bin/env bash
set -euo pipefail

bun_path="${TEST_SRCDIR}/$1"
runfiles_root="${TEST_SRCDIR}/${TEST_WORKSPACE}"
# Bun discovers test source in a writable tree with the regular extension layout.
cp -LR "${runfiles_root}/extension" "${TEST_TMPDIR}/extension"
cd "${TEST_TMPDIR}/extension"
export DO_NOT_TRACK=1
exec "$bun_path" test ./test
