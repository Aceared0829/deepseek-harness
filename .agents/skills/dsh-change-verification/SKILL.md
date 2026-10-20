---
name: dsh-change-verification
description: Use when modifying this DSH installation in any way - writing or editing a plugin, changing profile config, patching a packaged plugin, adding a skill, or touching packages/ - and before telling the operator to restart DSH. Encodes the verification ladder that must pass before a restart is requested, plus the failure modes already hit in this repo.
---

# DSH change workflow

## The one rule

Never ask the operator to restart DSH because a change looks correct. A restart asserts the next launch will work, so it is only requested after the ladder below passes on the real tree. State what was verified and what stays uncertain; never promise a crash-free start on intuition.

## Verification ladder

Run in order. Every rung is cheap; skipping one is how a broken change reaches a restart.

1. **Syntax and deployment parity.** Run node --check on every touched .js/.mjs/.cjs. When the launcher loads a file copied from source, compare it byte-for-byte. When TypeScript emits the deployed file, verify the build and behavior instead; formatted compiler output is not expected to match source bytes. A browser bundle parses fine even though window is undefined at check time.
2. **Encoding.** Confirm every JSON and source file you touched has no UTF-8 BOM and, if it carries non-ASCII, zero U+FFFD replacement characters. Never write a manifest through ConvertTo-Json | Set-Content; use Node or UTF8Encoding($false). verify-plugin.mjs checks both.
3. **Manifest.** Re-read package.json after writing it: name, dsh.client.platform === web, exports[./client] present, and every path it names exists on disk.
4. **Module load.** Import the manifest's real host entry (`main`) with node --input-type=module. A plugin's entry can live under `lib/`; checking only a root `index.js` skips the file the profile loads. This catches ESM and top-level errors that --check cannot.
5. **Optional service access.** Every optional or child-mounted service must be read with ctx.get(name), never through the ctx.name property proxy unless `name` is in `inject`. Test both the present and absent result through the exact operation that reads it; a projection's test must call the registered `wire.view`, not only its fold.
6. **Dependency absence.** Call apply with a ctx whose get() returns undefined. It must warn and return, never throw. A throwing apply becomes a failed fiber on every profile missing that service.
7. **Dependency presence.** Call apply again with stub services and assert the registration actually happened: channel name, slot name, tool name.
8. **Real invocation.** Invoke the registered handler with realistic input and read the returned value. A registration that never runs proves nothing.
9. **Client factory.** For a browser bundle, stub globalThis.window.__ModuleLoader__.load, import the file, call factory(require) with a fake require, and assert id, inject, and apply.
10. **Hostile paths.** Re-run with the inputs that throw in practice: a duplicate locale.register, a rejected fetch, a missing credential. Each must degrade, not propagate.
11. **Real session path.** After restart, open a persisted session and create a new one. A boot with no error is not enough: projection failures surface only when history is requested, and a client bundle can fail import while the shell still draws.

## Failure modes already hit in this repo

Treat every one as a checklist item, not an anecdote.

- **Duplicate locale registration.** locale.register(ns, dicts) throws when the namespace already holds that locale. Wrap it in try/catch and never let it reach the fiber, or the whole plugin goes FAILED on the second apply.
- **Hard inject for an optional service.** A service in inject that the profile does not mount leaves the fiber pending or failed forever. Prefer ctx.get(name) with a guarded fallback.
- **Optional service read through the property proxy.** Reading `ctx.name` for a service not listed in `inject` throws `cannot get property "name" without inject` from the Cordis proxy, even when that service is mounted by the same plugin as a child. Use `ctx.get(name)`. If a projection view reads it, test that view with the service both present and absent.
- **Source and deployed copy diverged.** The profile loads built `lib/`; editing only `src/` leaves the running product on old behavior. Compare every copied runtime artifact, not only the host entry, before restarting.
- **Stale Electron Code Cache after a bundle edit.** A current bundle can be correct while Chromium executes an older cached compilation. If the file has no such identifier and the console reports it, back up `Code Cache` instead of editing the bundle around the phantom.
- **Remote endpoint collides with the namespace service.** An endpoint such as `remove` can agree in both the Host decorator and Client descriptor yet be rejected when `$mount` installs it, because `RemoteNamespaceService` already owns that name. Compare endpoints with the namespace service's reserved names and exercise the real mount.
- **Client property proxy for an async Remote namespace.** `ctx.remote.<namespace>` throws without an `inject` entry even after `$mount` resolves; read `ctx.get('remote.<namespace>')` in callbacks and invoke the real callback.
- **Reading a bundled plugin patch in the wrong place.** The profile cordis.yml is usually just an empty root []; the live rows come from each dsh.profile.bundles patch under packages/bundle/*/cordis.patch.yml. Grepping the profile directory alone gives false negatives, both for what is mounted and for which bundle provides a service.
- **Assuming the packaged build can run source.** The desktop app runs built artifacts. SRC decorator fallback and tsx-only paths exist for a source Host and silently do nothing in a built one.
- **Typert generation outside the workspace.** The generator filters package roots to under <root>/packages, and the client tsdown preset is not published. A plugin outside the workspace cannot emit ./typert or ./remote; use a hand-written client bundle and generic RPC instead of Remote namespaces.

## Installing a plugin here

The shipped guidance is to call plugin_manager install_bundle with the absolute package directory. Hand-editing the profile package.json works too, but then every step it would have done is yours: add the dependency as a link: entry, append the name to dsh.profile.bundles, and make the package resolvable under the profile node_modules. Verify all three afterwards, because a missing link surfaces only as a load failure at boot.

A change to skill files under a scanned root needs no restart: the filesystem provider watches its roots.

## Asking for the restart

Report three things and nothing more: which rungs passed, which limitation remains unverified (usually Cordis lifecycle details that cannot be simulated outside the Host), and the exact symptom that would indicate the change failed. A named symptom bounds the blast radius and lets the operator tell a cosmetic miss from a broken boot.

## Ready-made checker

references/verify-plugin.mjs walks the manifest rungs for a plugin directory and exits non-zero on the first problem, so it can gate a restart directly:

    node .agents/skills/dsh-change-verification/references/verify-plugin.mjs <plugin-dir>

## Keep this skill growing

references/pitfalls.md is append-only and read before designing a change. After every verification that ends in a working DSH, do this before closing the task:

1. Append any new failure to pitfalls.md in the same shape: operator-visible symptom, root cause, the rule that prevents it.
2. If a pitfall is mechanically checkable, add it to verify-plugin.mjs rather than leaving it as prose.
3. If a pitfall would have been caught by a missing rung, add that rung to the ladder above.

When a projection or other deferred consumer retains a service handle, verify the absence path as well as the success path. A service can be mounted, disposed, replaced, or not yet published when the consumer runs; an empty result must preserve the consumer's output contract and must not turn one missing dependency into a session-wide projection failure.

A skill that is not updated after a real debugging session has silently regressed: the next session pays for the same mistake twice.
