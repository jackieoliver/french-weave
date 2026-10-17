# Releasing (dev repo only)

The dev repo (`origin`, jackieoliver/french-weave-dev) carries everything. The public repo (`public`,
jackieoliver/french-weave) gets the same code minus the dev build's usage log. This file stays out of the public
release: the strip commit deletes it.

## What the public release leaves out

One commit on the `public-release` branch, "Public release: leave out the dev build's usage log", which:

- replaces `extension/src/usage.js` and `extension/src/usage-page.js` with no-op stubs that keep the API the worker
  and content script call, so `background.js` and `content.js` are the same as dev;
- deletes `scripts/fwusage.py`, `tests/test_usage.py`, `extension/test/usage.test.js`,
  `extension/test/usage-runtime.test.js` and this file;
- removes `fw.py usage`, the native host's `usage` handler (`fw_host.py`), the popup's usage line and switch
  (`popup.html`, `popup.js`) and the README's "Usage log (dev build only)" section;
- adds `extension/test/public-build.test.js`, which fails if any of that comes back.

## Cutting a release

1. Release on dev first: bump the version (plugin.json, marketplace.json if it has one, extension/manifest.json,
   extension/package.json) and land it on dev main. Public versions are dev versions; the public build carries no
   version of its own.
2. Merge dev main into `public-release` (never rebase it: the strip commit has to stay one commit that later merges
   build on):

   ```sh
   git fetch origin public
   git switch public-release
   git merge origin/main
   ```

3. Conflicts come only from dev changes to the stripped pieces. Keep the public side:
   - deleted files (modify/delete): `git rm <file>`;
   - `usage.js` / `usage-page.js`: `git checkout --ours <file>`; if dev added a function or method the worker or
     content script now calls, add a no-op for it to the stub;
   - `popup.html`, `popup.js`, `fw.py`, `fw_host.py`, `README.md`: take dev's change, then remove the usage parts
     again.
4. Check, with a memory cap on the extension tests:

   ```sh
   cd extension && bun install --frozen-lockfile && bun test && cd ..
   python3 -m pytest -q
   python3 tests/check_version_bump.py --base public/main --release
   grep -rn "fwusage\|usageOn\|Usage log" --exclude-dir=node_modules . || echo clean
   ```

5. Push the branch to origin for review. Only the owner pushes to the public repo
   (`git push public public-release:main`); a pre-push hook blocks it for everyone else.

## Notes

- Same version, two builds: `claude plugin update` and `refresh_copies` (scripts/fwlib.py) only act when the version
  changes, so switching one install from the dev marketplace to the public one at the same version keeps the dev
  copies. Reinstall (or run setup again) after switching.
- History: the public repo receives dev's full history as it is (commit messages included); it is never squashed or
  rewritten, so each release stays a plain merge on top of the last.
