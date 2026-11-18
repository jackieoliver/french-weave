# Agent Instructions: Lang Weave

Lang Weave is a standalone Chrome extension fork of jackieoliver/french-weave (MIT, preserved in LICENSE-MIT). Lang Weave itself is licensed AGPL-3.0-or-later (LICENSE, NOTICE); keep both files and the NOTICE attribution in any release payload. Spanish is its bundled default. Global workflow rules apply from the shared agent configuration. AGENTS.md is canonical; other agent instruction files are symlinks.

## Project structure

- `extension/` — shipped MV3 extension, no build step or runtime dependencies; `src/` is code and `test/` holds Bun/happy-dom tests.
- `docs/` — extension design, mission state and acceptance evidence.
- `data/` — inherited lexicons, including the Spanish starter list.
- `scripts/`, `hooks/`, `commands/`, `.claude-plugin/`, `blocks/` — inherited French companion tooling, retained for history/upstream compatibility; outside the Spanish browser product.
- `tests/` — inherited Python gates and browser integration tooling.

## Environment and gates

The extension loads directly from `extension/`; nothing needs building to load it.
Bazel 8.7.0 comes from the root `flake.nix`. `nix develop --command bazel test //:fsrs_test //:package_boundary_test //:version_classifier_test` runs the original three Bazel targets. The unpacked ZIP, targeted extension regressions, and Chromium install smoke have separate targets. See `docs/bazel-fsrs.md` for the commands.
The gates listed below are not yet in the Bazel graph. Agents counted their standalone runs as validation evidence for PR #50 (tedks/lang-weave#50) only, by CTO ruling; that exception does not carry forward. Future agent validation follows the Bazel-only rule in the shared agent configuration. Where a needed gate has no Bazel target, close the gap through ditz `bazel-graph-remaining-gates` or seek a new ruling, rather than falling back to a standalone run.
`BUILD` and `BUILD.bazel` files under `extension/` are left out of both ZIPs and exempt from the version check.
Standalone entrypoints, kept for people who work in this repo without Bazel or the parent workspace (they are not agent validation evidence):
- `bun install --frozen-lockfile && bun test` inside `extension/`.
- `npm run test:highlights` inside `extension/`, the real Chromium light/dark CSS checks for highlight styling.
- `python3 -m unittest discover -s tests` from the root, for inherited Python tooling.

Keep Chrome runtime verification separate from mocked model verification; never imply a live Gemini check without one.

## Repo specifics

The extension must work without a Python/native host. Never read or write the user's French Weave progress. Preserve explicit site permissions, sensitive-site defaults, API-key isolation and stale-result guards. The historical `fr` property in swap/word objects is a compatibility field for target-language text. The manifest `key` fixes the extension ID (`lkbkmlgogcpcacjmdmoecgacdbfddbnh`) on every path; change or remove it only with a CEO ruling, because that moves every user to a new ID, and never commit the private key. Never put 0.12.0 or later into a pre-0.12.0 install directory: its self-reload would strand that install's progress (see docs/STABLE-ID-MISSION.md). Keyless updates between pre-0.12 releases keep the ID.

## Issue tracking

Use installed `ditz` from this worktree. Issues live on `ditz-metadata`; inspect `ditz --help=plain` and the relevant command's help. `ditz sync` delivers metadata separately from source pushes. Canonical recipes: https://github.com/tedks/ditz/blob/master/docs/agent-recipes.md and https://github.com/tedks/ditz/blob/master/docs/json-contracts.md.
