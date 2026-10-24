---
name: dsh-official-build
description: Use whenever this DSH checkout must be built, rebuilt, or have its artifacts refreshed - before launching the Desktop app after a source change, after pulling, or when a UI value looks missing or blank. Encodes the official pnpm build entry points, why invoking a bundler directly produces silently degraded artifacts, and the recovery steps already exercised on this installation.
---

# Building this DSH checkout

## The one rule

Never invoke a bundler directly. `tsdown`, `tsc -b`, and `vite` run inside the official
scripts precisely so the build can compute and inject the public client environment. Calling
them by hand produces artifacts that build without error and still render wrong.

The only supported entry points are the `pnpm run` scripts in the repository root. They come
from the upstream repository, https://github.com/deepseek-ai/deepseek-harness, which is the
authority for what "official" means here. When a script and a hand-written command differ,
the script wins.

## The commands

| Need | Command |
| --- | --- |
| Full build: artifacts plus aggregate checks | `pnpm run build` |
| Artifacts only, including the client environment binding | `pnpm run build:artifacts` |
| Type-check only, no bundling | `pnpm run typecheck` |
| Host and client bundles separately | `pnpm run build:lib` |
| Desktop app bundle after artifacts exist | `pnpm --filter @deepseek-ai/dsh-desktop run bundle` |

`pnpm run build:artifacts` is the normal choice before relaunching the Desktop app: it advances
every artifact step and writes `.dsh-build/client-build-environment.json`.

The Desktop dev launcher already does the right thing. `pnpm run dev:desktop` runs
`build:artifacts` then the app's own `build` unless `--skip-build` is passed, so prefer it over
bypassing the launcher.

## Why a direct bundler call degrades silently

`resolveClientBuildEnvironment` in `scripts/client-build-environment.ts` derives
`DSH_CLIENT_VERSION`, `DSH_CLIENT_COMMIT_HASH`, and a `DSH_CLIENT_GIT_DIRTY` marker, and
`scripts/build.ts` passes them to both bundlers. The client bundler only inlines variables that
are already present in its process environment, so a direct call with none set defines nothing.

The failure is invisible at build time. `SidebarRoot.tsx` writes `process.env.DSH_CLIENT_VERSION`;
without the define the bundler folds it to an empty object read that yields `undefined`, the
brand badge drops its version, and the build still reports success. Verified shape of the two
outcomes:

    // direct bundler call, no environment
    const version = {}.DSH_CLIENT_VERSION;   // undefined forever

    // official script
    function localBuildVersion() { return `0.2.1-rc.2-<commit>-dirty`; }

`-dirty` is correct and expected while the worktree holds uncommitted changes. Its absence on a
dirty tree is the signal that the environment did not reach the bundler.

## Read the record before trusting an artifact

`.dsh-build/client-build-environment.json` carries the exact public environment and a digest of
the client artifacts. `readClientBuildRecord` refuses to consume artifacts that differ from the
record, so a mismatch is a real defect, not noise. After any build, confirm the version in the
record matches `package.json` and that `DSH_CLIENT_GIT_DIRTY` reflects the worktree.

An artifact check that needs no browser: confirm the bundle contains the literal version string
rather than a `DSH_CLIENT_VERSION` property read.

## Never work around a failure by editing build output

`apps/desktop/lib/main.js` and every `packages/*/*/lib/` file are generated. A temporary edit to
one is acceptable only as a diagnostic, and the original must be restored from a copy before the
next build runs; a later build overwrites it anyway, so a hand edit is never a fix. Diagnose in
`src/`, fix in `src/`, rebuild with the official script.

## Restoring a degraded Desktop profile

The Desktop shell rolls a profile back automatically once a composition fails to reach readiness
three times, and it does so by renaming, not deleting, so recovery is always possible:

- The original patch is preserved beside the profile as `cordis.patch.yml.bak-<epoch-ms>` in the
  profile directory. Copy it back and verify with a hash comparison against the backup.
- `disableAllPlugins` also rewrites the manifest's bundle list, so re-check `package.json` in the
  profile against `home/profile-backups/<id>/package.json`.
- `boot-failures.json` under the Electron `userData` root authorizes the rollback. Remove it after
  restoring, or the next launch may roll back again.
- The recovery dialog's "Disable third-party plugins" button performs this same reset. Do not
  press it to "just retry" a launch problem.

Refreshing build artifacts is never a reason to touch a profile, and a profile reset is never a
reason to rebuild. Keep the two apart when diagnosing.

## Failure modes already hit here

- **Direct root `tsdown` run after a source change.** It rebuilt every client bundle with no build
  environment, so the sidebar lost its version badge while the build reported success. The fix was
  re-running the official client step with the derived environment, not editing the bundle.
- **Assuming a successful bundler exit means correct output.** Exit status covers module
  resolution, not inlined values. Check one known build value per artifact class.
- **Treating a regenerated `lib/` as disposable.** Source is authoritative and `lib/` is derived,
  but the app loads `lib/`. A stale or wrongly built `lib/` is what the operator actually sees.

## Keep this skill growing

Append a new entry whenever a build problem surfaces on this installation. Symptom first, then
cause, then the rule that prevents it, matching `references/pitfalls.md` in
`dsh-change-verification`.
