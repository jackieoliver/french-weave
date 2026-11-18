#!/usr/bin/env bash
set -euo pipefail

runfiles_root="${TEST_SRCDIR}/${TEST_WORKSPACE}"
mkdir -p "${TEST_TMPDIR}/tests"
cp "${runfiles_root}/tests/check_version_bump.py" "${TEST_TMPDIR}/tests/check_version_bump.py"
cp "${runfiles_root}/tests/test_version_bump.py" "${TEST_TMPDIR}/tests/test_version_bump.py"
cd "${TEST_TMPDIR}/tests"
for tool in python3 git; do
  case "$(command -v "$tool")" in
    /nix/store/*) ;;
    *) echo "${tool} must come from the pinned Nix shell" >&2; exit 1 ;;
  esac
done
export PYTHONDONTWRITEBYTECODE=1
export TMPDIR="${TEST_TMPDIR}"
exec python3 -m unittest \
  test_version_bump.VersionBump.test_runtime_reference_scan_handles_build_metadata_and_binary_assets \
  test_version_bump.VersionBump.test_new_e2e_file_fails_closed \
  test_version_bump.VersionBump.test_unshipped_changes_need_no_bump \
  test_version_bump.VersionBump.test_build_metadata_exemption_does_not_hide_packager_change
