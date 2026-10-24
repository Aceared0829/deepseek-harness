# Pitfalls log

Append-only record of failures actually observed on this installation. Every entry bought with a real debugging session; read this before designing a change, and add to it whenever a new failure surfaces.

Entry shape: symptom first (what the operator saw), then root cause, then the rule that prevents it.

---

## 2026-10-18 - Page-level plugin sync failed: locale namespace already has locale en

Symptom: the Web page reported that this page's plugins could not finish syncing, with locale namespace dsh-time-machine already has locale en, while the server-side enablement stayed unchanged. Retrying the page sync never helped.

Cause: the packaged plugin called locale.register(ns, dicts) from a ctx.effect without a guard or a returned disposer. locale.register throws when the namespace already holds that locale, and the effect reruns whenever the locale service instance is replaced, so the second register failed the whole plugin fiber.

Rule: never let a duplicate locale registration escape. Guard it in try/catch and return a disposer from the effect. Rung 8 of the ladder covers this.

## 2026-10-18 - Wrong conclusion: service assumed missing because the profile directory lacked it

Symptom: a required service looked absent. Grepping the profile directory and require.resolve from it both failed, which suggested the plugin would break the boot.

Cause: the profile cordis.yml is an empty root []. Every live row is contributed by a bundle patch under packages/bundle/<bundle>/cordis.patch.yml, and the packages themselves resolve through the pnpm virtual store, not through the profile node_modules top level. A directory-local search proves nothing about what is mounted.

Rule: resolve a service question from the bundle patches and from package sources, never from the profile directory alone. State the evidence path when claiming a service exists or is missing.

## 2026-10-18 - A hard inject on an optional service risks a failed fiber

Symptom: none observed, caught during review. But the shape is dangerous: a name in export const inject that a profile does not mount leaves the fiber pending or failed, and the page reports it as a plugin that did not activate.

Cause: inject is a hard dependency in Cordis, not a hint.

Rule: for anything a profile might legitimately not mount, use ctx.get(name) with a guarded early return, and keep inject for what must exist. Rungs 4 and 5 exist to prove both branches.

## 2026-10-18 - Typert generation silently unavailable outside the workspace

Symptom: a plugin placed outside the repository could not emit ./typert or ./remote, and the client could not call ctx.remote.<ns>.

Cause: three independent walls. The generator filters package roots to under <root>/packages. The client tsdown preset that emits the ModuleLoader factory is not a published package and hardcodes the repository root. And the Client Remote refuses to mount a contribution without a strict generated codec, so the SRC decorator fallback, which only runs in a source Host, does not help a built app.

Rule: outside the workspace, hand-write client.js and reach the Host over a generic connection.rpc channel instead of a Remote namespace. Inside the workspace, the normal Typert path is available.

## 2026-10-18 - Unverified restart request

Symptom: an operator was nearly told to restart on the strength of syntax checks alone, after a claim that two required services were missing turned out to be a search error.

Cause: treating a passing node --check as evidence that the next boot would work, and reporting a service as absent from a directory-local search.

Rule: the ladder, in order, on the real tree, before any restart request. When a claim drives a decision, name the file and line that proves it.

## 2026-10-18 - Desktop window vanished: profile manifest carried a UTF-8 BOM

Symptom: every desktop launch ended in the Host log at `Unexpected token '﻿'` from `readProfileManifest`, with no window. The profile stayed broken across retries until the file itself changed.

Cause: an editor or script outside DSH rewrote `$DSH_HOME/profiles/desktop/package.json` with a UTF-8 BOM, four-space indentation, CRLF, and reordered keys. DSH's own writers emit `JSON.stringify` output with LF and no BOM, and `readProfileManifest` parses the raw text with `JSON.parse`, which rejects U+FEFF. The BOM was introduced by tooling around a local ChatGPT-account bundle edit, not by pnpm or the plugin manager.

Rule: treat profile manifests and bundle JSON as UTF-8 without BOM. After any manual or PowerShell JSON edit, assert the first bytes are `7B`, run `node -e` `JSON.parse` on the real file, and start the desktop app before claiming it opens. When diagnosing this symptom, read the newest `crash-*-host.log` first; it names the parse path.

## 2026-10-18 - Local bundle client.js held replacement characters after an encoding loss

Symptom: the ChatGPT account settings card loaded, but its Chinese strings displayed as boxes and question marks.

Cause: `client.js` in the local `dsh-chatgpt-account` bundle had already been written with `U+FFFD` replacement characters, so the display loss was in the file, not the terminal or locale service.

Rule: for hand-written local bundles, validate non-ASCII strings by code point, not by eye in a console that may itself be mis-decoding output. Keep source files UTF-8 without BOM and save copy containing Chinese through an editor that preserves UTF-8.

## 2026-10-18 - DSH would not start: UTF-8 BOM written into the profile package.json

Symptom: the desktop app exited before any window appeared, every launch. No plugin error was shown because the process died while reading the profile manifest.

Cause: apps/desktop/.desktop-build/development/home/profiles/desktop/package.json opened with the bytes EF BB BF. readProfileManifest at packages/boot/app-boot/src/profile.ts:620 calls JSON.parse on the raw text, and JSON.parse rejects a leading U+FEFF, so the Host threw Unexpected token before creating a window. The file also showed 4-space indent and CRLF, the signature of Windows PowerShell 5.1 ConvertTo-Json piped into Set-Content. DSH's own writer (profile.ts:633) emits JSON.stringify with LF and no BOM, so this could not have come from pnpm or the plugin manager.

Rule: never author or rewrite a JSON manifest (profile package.json, a bundle package.json, a snapshot manifest) through ConvertTo-Json | Set-Content. Write it through Node or through [Text.UTF8Encoding]::new($false), and verify the first three bytes afterwards. Rung 2 now checks this mechanically.

## 2026-10-18 - Non-ASCII silently destroyed while writing a source file through PowerShell

Symptom: the plugin loaded and DSH booted, but the settings card showed garbled text. The file held 42 U+FFFD replacement characters where Chinese copy used to be. Syntax checking still passed, so nothing flagged it.

Cause: the file was built with repeated Add-Content calls from PowerShell. Non-ASCII passed through a console encoding that could not represent it and was replaced at write time. A later read cannot recover it: the bytes are gone, not merely displayed wrong.

Rule: for any file containing non-ASCII, write it with an explicit no-BOM UTF-8 encoder or through Node, and verify afterwards by counting U+FFFD (expect zero). Treat a non-zero count as corruption, not as a display quirk. When authoring localized copy, prefer writing from a Node script with a UTF-8 literal so the bytes never cross the console.

## 2026-10-19 - Projection wire value containing undefined broke every new Session

Symptom: the desktop sidebar and persisted Session files were intact, but the input bar said the conversation was unavailable and every New Session action failed with `gateway/internal: failed to create session: Error: forwarded host event "api-session/added" argument 0 is not lossless JSON data`. A live debugger stopped in `packages/api/remotes/lib/index.js` showed undefined at `projections.values.harnessEvidence.harness.parentSession` and `.firstIncompleteTurn`.

Cause: the custom `plugins/harness-eval` projection returned optional fields with `undefined` from `view()`. The gateway rejects any nested undefined before forwarding `api-session/added`, so creation rolled back. Syntax checks and the visible Harness tab did not catch it because the fault is in the runtime projection value, not in module parsing or rendering.

Rule: model both projection state and its wire view as lossless JSON. Omit optional properties until they have values, or encode open state as `null`; never leave `undefined` in nested objects or array rows. Exercise `init`, an open turn, and a closed turn through `apply` and `view`, recursively reject undefined at both stages, and JSON round-trip the state. Treat a blank new Session with no cache row as normal, not as proof that the projection is unmounted.

## 2026-10-19 - Projection cache silently rejects undefined state

Symptom: the Harness tab rendered correctly, but `node plugins/harness-eval/verify.mjs` found no `harnessEvidence` row after multiple restarts. The running Host had already printed `[harness-eval] registered projection key "harnessEvidence"`, so the plugin was mounted.

Cause: projection state is checkpointed under the plain-JSON contract, and `SessionProjectionCache` rejects state that cannot survive a lossless JSON round trip. `EMPTY_STATE.harness` held three undefined properties, and open turn rows held `outcome: undefined`, so every cache write failed even though the wire view for a blank session happened not to expose those paths. The initial projection therefore worked live without producing a cache row.

Rule: validate projection state separately from its wire view, including the empty-init state and open turns, with a recursive undefined scan and `JSON.parse(JSON.stringify(state))`. Bump `stateVersion` whenever the persisted state encoding changes; `undefined`-vs-`null` and omitted keys are encoding changes.

## 2026-10-19 - History failed to project: harnessMarks read without inject

Symptom: sidebar history stayed visible, but opening a persisted session produced `历史加载失败: failed to project session "session-19ffa784-e65c-4e8d-851c-95a76a73fb3b": cannot get property "harnessMarks" without inject (gateway/internal)`. New sessions appeared blank, so the failure was easy to mistake for a rendering issue.

Cause: `lib/index.js` held `marksReader = sessionId => ctx.harnessMarks?.marksFor(sessionId) ?? []`. `harnessMarks` is mounted by this plugin through `ctx.plugin(HarnessMarks)`, but it is not in `inject` (`['sessionProjections']`). Cordis's context proxy rejects the property read before optional chaining can help. The `wire.view` callback runs while projecting loaded history, so the exception escaped the projection and rejected the whole session projection. `src/index.js` had already been corrected to `ctx.get('harnessMarks')`, but the deployed `lib/index.js` drifted from source.

Rule: for an optional, child-mounted, or possibly disposed service, read `ctx.get(name)` and guard absence explicitly. Put the service name in `inject` only when the fiber must wait for it. Test the real consumer path with a present service and with `ctx.get` returning undefined, and require source and deployed bytes to match before restart. A blank new session is not evidence that the projection is healthy.

## 2026-10-19 - Console reported MARKS_REMOTE_SPEC duplicate declaration in a clean bundle

Symptom: a web-boot crash log ended with `Uncaught SyntaxError: Identifier 'MARKS_REMOTE_SPEC' has already been declared`, so `dsh-harness-eval` failed to activate. The current `lib/client.js` contained no `MARKS_REMOTE_SPEC`, and file size and SHA-256 matched the deployed profile copy.

Cause: Electron's `Code Cache/js` retained an older compiled bundle from a rapid sequence of client edits. Chromium executed that stale compilation even though the source bundle served for the current revision was clean. Searching the cache found the identifier in `Code Cache\js\1ac2c00164d7f799_0`, while the current script did not contain it.

Rule: when the current bundle is clean but Electron reports an identifier that does not exist in it, stop editing the bundle to match the error. Close the app, move `Code Cache` to a timestamped backup so Chromium rebuilds it, then retest the real session path. Treat a cache hit as a suspect whenever a hand-written client bundle was edited repeatedly without a clean process restart.

## 2026-10-19 - Remote namespace failed to mount because an endpoint was named remove

Symptom: after the projection read was fixed, the console reported `[harness-eval] could not mount the marks namespace: ... method "harnessMarks/remove" conflicts with its namespace service`, so marks remained unavailable even though the descriptor and decorator agreed.

Cause: `@Remote('remove')` named an endpoint after `RemoteNamespaceService.remove()`. The Client gateway installs endpoints as properties on the namespace service and rejects any name already present on that service or its reserved field set. Comparing the Host decorators with the Client descriptor alone cannot detect this collision because both sides declare the same invalid name.

Rule: avoid every field and method owned by the Client `RemoteNamespaceService` when naming a Remote endpoint, especially `remove`. Mount-test the contribution through the Client `$mount` path, or mechanically reject the namespace service's reserved names; a spec-versus-decorator comparison proves agreement, not mountability.

## 2026-10-19 - Client Remote namespace read through the property proxy

Symptom: the marks namespace mounted, but creating a mark failed with `保存失败：cannot get property "remote.harnessMarks" without inject`. The same projection session loaded normally, so the failure appeared only on a write.

Course: the browser callback read `ctx.remote.harnessMarks`. Cordis's property resolver enforces `inject` before optional chaining can run, and the asynchronous `$mount` result is not a static inject entry. The context proxy therefore threw instead of returning undefined.

Rule: resolve dynamically mounted or asynchronous services with `ctx.get('remote.<namespace>')` and report absence explicitly. Test the callback path, not only the descriptor or the visible tab: a namespace can mount successfully while the first write still throws.

## 2026-10-19 - Verification checked root index.js instead of the manifest entry

Symptom: the ready-made plugin checker reported PASS for host parity and copy consistency, but it never loaded the host module the profile actually executes. Importing that module was the only step that could expose a missing decorator dependency or a top-level ESM failure.

Cause: `verify-plugin.mjs` looked for `index.js` at the package root, while this plugin declares `main: lib/index.js`. The copy-parity loop also covered only the host entry even though `lib/marks.js` and `lib/typert.remote-client.js` are independently copied artifacts.

Rule: load the manifest's real `main`, and byte-compare every runtime artifact described as a copy. A checker that only agrees with its own assumed layout is not evidence about the package the Host will load.

## 2026-10-20 - A manually launched Host tested the project directory instead of the desktop profile

Symptom: a hand-launched Desktop Host returned `settings/describe` with `ok: true`, while the real desktop launcher failed the same welcome RPC. The isolated result looked like proof that the profile composition was healthy.

Cause: `apps/desktop-host/src/index.ts` takes `projectDir` as argv[3] and the profile directory as argv[4] (`process.argv[2]`/`[3]` inside the Host). The manual command passed the generated development project as both arguments, so it loaded the project's basic bundle manifest rather than `home/profiles/desktop`.

Rule: when reproducing Desktop startup, use the same Host arguments as `HostProcess`: runtime project, then the actual `home/profiles/<name>` directory, then the prepared primary runtime. A manual Host that does not name the failing profile proves nothing about that profile's plugins.

## 2026-10-20 - Third-party Typert manifest used the obsolete codec schema field

Symptom: the desktop profile booted, but every `settings/describe` returned `ok:false`, and the welcome window reported `desktop welcome: Web RPC failed`. Host stderr named `typert-loader: dsh-mimir invocation "dsh-mimir#research/addEvidenceEdge" parameter codec has no create() factory`.

Cause: `dsh-mimir@0.21.1` generated its Typert host manifest with `codec.schema`, while the current loader requires a strict codec with a `create()` projection factory. The loader rejects the whole contributor, and the dependent settings surface fails even though the plugin's module imports.

Rule: after changing profile plugins, launch the real Desktop profile and inspect Host stderr, not only whether the window opens. Treat a failed `typert-loader` contributor as a composition failure; disable or upgrade the offending plugin before diagnosing unrelated settings or approval UI.

## 2026-10-20 - Service method read an injected dependency through the caller context

Symptom: the model selector failed with `cannot get property "remote.session" without inject` even though `ModelDirectoryResolver` declared `remote.session` in its own static inject list. A dependent plugin that injected only `modelDirectories` triggered the failure by calling `directoryFor()`.

Cause: Cordis tracks service method calls under the caller context. Inside `directoryFor()`, `this.ctx.sessions` returned the original owner's service, but reading `this.ctx.remote.session` enforced the caller's inject list, which omitted `remote.session`, so the proxy threw before returning the dependency.

Rule: capture a dependency while the providing context is current, or read it with `ctx.get(name)`. Do not assume the service's own static inject list authorizes a `this.ctx` property-proxy read during a caller-tracked method. Exercise the consumer with the minimum inject needed to reach the service, not only through the service's own plugin.

## 2026-10-24 - Mixed rc.2 profile plugins disabled session creation on an rc.3 runtime

Symptom: the desktop shell and sidebar loaded, but opening or creating a Session failed with `gateway/service-unavailable: typert gateway: session/create: active Service "sessionController" is unavailable`. The profile patch contained no disable for `session-query-sqlite`, yet the live Loader reported that entry as `disabled: true`; `sessionQuery` was never published, so `session-controller`, `session-reference`, and `ui-deliverables` stayed pending.

`session/list` and `session/create` returned successfully after the official optional bundles and their `@deepseek-ai/dsh-*` closure moved from `0.2.1-rc.2` to `0.2.1-rc.3`, while the runtime remained `0.2.1-rc.3`.

The rc.3 compatibility preflight had disabled the rc.2 `session-query-sqlite` entry because its `peerDependencies` did not include the running runtime line. Disabling compatibility checks or re-enabling only that entry would not have fixed the other rc.2 optional bundles and would have hidden the dependency mismatch.

Rule: after upgrading a DSH runtime, inventory every official bundle in the profile and update the whole official dependency closure through the official package-manager entry before diagnosing Session services. Confirm that the profile dependency versions, `pnpm-lock.yaml`, and every running bundle agree on the runtime line. Do not patch one disabled entry or disable the compatibility preflight; then verify the live service publication, an existing Session's history, and a newly created Session.
