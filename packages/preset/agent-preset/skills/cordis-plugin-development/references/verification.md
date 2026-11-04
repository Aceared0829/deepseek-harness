# Verify before promoting

A bundle's first run must not happen in the profile you are working in. When a plugin breaks the Host, the session that would fix it is the one that no longer starts.

## Prove it opens before you ask for a restart

The staging gate below proves **the Host still starts**. It does not prove **the plugin works**. A plugin that installs cleanly, activates cleanly, and then throws inside its own projection, ships a payload the gateway rejects, or crashes its view is indistinguishable from a working one until a person clicks into it — and by then the only fix is another restart.

**Never ask a person to restart on the strength of green tests and an activated entry.** Before asking, exercise the three stages the product runs, in this order, against real data from the profile you are changing:

1. **Fold** — run the plugin's own state-building path over real input (real session logs, real rows, real files), then push the result through whatever schema or validator the durable layer applies. A throw here is not contained to your plugin: a projection that throws while folding fails for every session, and the tab shows history that never loads.
2. **Transport** — serialize the payload the way the transport does and require a lossless round trip with no `undefined`. A value the gateway rejects does not fail politely; a rejected session argument can roll back the whole operation that carried it.
3. **Render** — import the real Client bundle and render the real payload through it. A throw here is a blank tab, which looks exactly like "the plugin did nothing".

One command runs all three when the bundle registers a session projection:

    node scripts/plugin-gate.mjs --bundle <bundle-dir> --fixtures <dir-of-real-input>

It discovers the projection by mounting the plugin against a stub, folds each fixture, checks the wire payload, and renders the real view. Pass `--helper <spec>` when the bundle needs its own `review(input)` instead. Exit codes matter: `0` pass, `1` failed, `2` nothing was checked, `3` a stage could not run. **`2` and `3` are not passes** — report the plugin as unverified rather than working.

Also bound the size of anything that is persisted and rewritten on every change. Unit tests measure correctness, not cost: a row that stores raw tool arguments was correct, passed every test, and reached 470 KB on one session because it grew with every call. Check the distribution (median and worst case), not one sample. The gate reports that distribution and fails a row over `--max-state` (default 128 KB).

If you cannot run one of the three stages — no browser control, no real data — say which one you skipped and treat the plugin as unverified. Do not describe it as working.

## Stage in a disposable profile

From the DSH checkout that provides this Harness, one command runs the whole gate. When the workspace is not that checkout, invoke the script by absolute path:

    node scripts/stage-verify.mjs <bundle-dir>

Add `--static-only` for the manifest checks alone. The script binds to the Desktop development runtime by default; pass `--dsh <bin.js>` and `--home <DSH_HOME>` when the app you are changing uses another installation. It creates a temporary `DSH_HOME`, composes a profile from the `web` template, installs the bundle there, boots it on a free port, and reports PASS or FAIL. The live profile is never written. A failing run keeps its staging directory and prints the log path.

The gate catches what a syntax check cannot: a manifest that points at a missing file, a BOM or U+FFFD in a written file, a Host entry that throws while loading, a Client bundle that fails to import, and an entry that never activates.

## When the checkout is not available

Run the same stages by hand, with the CLI that belongs to the app you are changing:

1. `dsh --profile verify --from-default-profile web --dump-default-config` composes the profile without booting it.
2. `dsh plugin --profile verify add <absolute bundle directory>` installs it.
3. `dsh --profile verify --port <free port> --no-open` boots it; set `DSH_HOME` to a scratch directory first.
4. Request the URL the app prints. `401` means reachable but the token was rejected; `200` or a redirect means it serves.
5. Treat `warning: N entries did not activate` as a failure and read the `(id): Error:` line above it.

`--from-default-profile` **deletes** the target profile directory, including its `node_modules` and patch. Never point it at the profile you work in.

## Snapshot before promoting

    node scripts/profile-snapshot.mjs snapshot --profile desktop

Restore with `--id <snapshot>` after a bad promotion. The restore needs an app restart: a running process keeps the composition it booted with.

## Visual verification

Prefer the authenticated page already connected to Harness. Do not launch a separate browser from shell commands, change `HOME`, inspect personal browser profiles, search for authentication tokens, or alter keychains to obtain a screenshot. For a visual-only request without browser control, limit verification to JavaScript syntax, manifest validation, and the live Client slot, then report that visual verification remains unavailable. Before or after installation, do not search for rasterizers, invoke Quick Look, extract SVG into preview files, emulate React/DOM, or implement a custom renderer to compensate for missing browser control. A screenshot of a mock page is not verification of the running plugin.

For a page or panel, verify that styles use only theme tokens, the plugin imports no Harness Client package such as `@deepseek-ai/dsh-client-ui-primitives`, the console shows no slot entry crash, and the view reads correctly in light and dark themes beside a comparable host page. Scale verification to the change's risk.

For any test subprocess or temporary resource, use a unique owned directory, bound execution, and await cleanup. A failed optional preview must not turn into environment repair or block installation.
