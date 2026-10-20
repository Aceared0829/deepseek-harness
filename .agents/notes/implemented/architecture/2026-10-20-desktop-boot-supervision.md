# Agent Note: Bound Host startup and roll back a profile that cannot start

Status: implemented

English | [中文](2026-10-20-desktop-boot-supervision.zh.md)

## Problem

A plugin can end the Host without an exception the shell can observe. `process.exit()`, a synchronous loop, or a native crash each leave the Desktop shell in a state its existing failure paths do not cover:

| Symptom | Why it escaped |
|---|---|
| The window stays on the loading page forever | `DesktopHostProcess.start()` awaits a `ready` IPC message with no deadline; a Host blocked in a plugin's synchronous loop never sends one and never exits, so nothing rejects |
| A profile that cannot start is retried identically on every launch | Nothing outside the Host recorded that the last launches failed, so the composition that fails was never replaced |
| A broken composition stays broken | `installBundle` restores `package.json` and `pnpm-lock.yaml` when pnpm fails, but a plugin that installs cleanly and then prevents startup has written `cordis.patch.yml` and keeps it |

Native recovery already existed for a fatal failure the shell is told about. These four have no such report.

## Decision

Supervise the Host from the shell, which is the only party that survives it.

### A readiness deadline

`DesktopHostProcess.start()` arms `HOST_READY_TIMEOUT_MS` (default 120 s, `DSH_DESKTOP_HOST_READY_TIMEOUT_MS`) and fails the attempt with `DesktopHostReadyTimeoutError` when it expires, appending the retained stderr tail. `DesktopBackendController` already stops a failed child before publishing the error, so the stalled tree is killed by the existing escalation (`shutdown` → SIGTERM at 10 s → SIGKILL at 5 s). The deadline is cleared on `ready`, on any failure, and in `stop()`, so it can never fire against an attempt that already settled or a Host that already runs.

The bound covers silence, not performance. A slow-but-progressing Host reports `ready` eventually and is unaffected; only a Host that reports nothing for two minutes fails. Raising it is a config change, not a code change.

### A launch streak the shell owns

`DesktopBootJournal` (`apps/desktop/src/boot-journal.ts`) writes `boot-failures.json` under Electron userData — deliberately outside the profile, so a rollback cannot erase the record that authorizes it. Each launch that ends before readiness records:

- the **composition fingerprint**: `package.json`, `cordis.yml`, and `cordis.patch.yml` by content, absence included. Hashing content rather than mtime means any profile write starts a new streak, which is what makes "fix it and try again" work without a special case.
- a consecutive failure count for that exact fingerprint
- the failure kind: `address-in-use` or `composition`
- whether this composition already used its rollback

Reaching readiness deletes the file.

`main()` records failures in the `reconcileBackend()` rejection path, which is where `backend.start()` publishes every pre-readiness failure. `bootJournal.markReady()` runs immediately after `backend.start()` resolves, before any window work, because that resolution is the fact the journal exists to record.

### One automatic rollback

`recoverUnstartableProfile()` runs inside profile preparation, before the Host is spawned, so the failing composition is replaced before any plugin from it loads. It reuses `DesktopProfileManager.disableAllPlugins()` — the same `sanitizeProfile` call the native recovery button uses — under the profile write lock a package operation takes.

Constraints that keep recovery from becoming a second failure mode:

- **A listener conflict never rolls back.** `listen EADDRINUSE` means another DSH instance; no profile change fixes it, and rewriting the profile would destroy a working composition for nothing.
- **One rollback per composition.** `recordRollback()` sets a latch that survives subsequent failures of the same fingerprint, so a profile that is still unstartable after recovery reports the failure instead of rewriting itself in a loop.
- **A failed rollback does not fail the launch.** The write failure is logged and startup continues, so the Host's own diagnostic explains what is wrong instead of being replaced by an I/O error.
- **An uninitialized profile records nothing.** A profile directory that does not exist yet is about to be created by this launch and has attempted no composition.

After a successful launch the rollback is reported in a native message box once the workspace opens, because the profile no longer loads what the person configured.

### A liveness probe that can replace the Host

`DesktopHostProcess.probe()` sends the existing `update-tasks` control request and reports whether an answer arrived. A Host blocked in a synchronous loop leaves it unanswered while the process stays alive — the window keeps rendering and boot IPC requests simply never settle.

Detection and recovery are both armed by default. `DSH_DESKTOP_HOST_LIVENESS_INTERVAL_MS` probes every 30 seconds and `DSH_DESKTOP_HOST_STALL_PROBES` defaults to `3`, so a Host that is silent for 90 seconds is replaced. The first missed probe of an episode always writes a `host` crash report naming the stall, so a Host that recovers on its own still leaves a record.

### Measuring what a stall means

A probe that times out says the Host stopped answering; it does not say whether its loop was blocked or a request was merely slow. `apps/desktop-host` runs `monitorEventLoopDelay` for its whole lifetime and attaches the distribution to every `inspect` answer. Node delivers those samples from a timer the Host itself owns, which is exactly what a blocked loop stalls, so `max` reports the longest unbroken stretch of loop occupancy. The shell keeps the last measurement and quotes it in the stall report:

> `... did not answer a probe within 10000 ms ... Before that, its event loop was blocked for up to 4800 ms (p99 240 ms, p50 1 ms over 30000 ms).`

That sentence is what separates "a plugin is stuck" from "a request was slow": a large `max` with a small `p50` is one blocked stretch, while a large `p99` across many samples is sustained pressure. Sampling is best effort — a platform that refuses a histogram costs the Host nothing but the measurement, and the report then says no measurement was available.

The threshold turns detection into recovery through the same path the installer handoff uses: sweep boot leases so no renderer asks a doomed Host for injections, `backend.stop()`, `backend.start(prepareHostEnvironment)`, then drop the cached navigation and reload the page against the new URL. `DSH_DESKTOP_HOST_STALL_RECOVERIES` (default `1`) bounds restarts per application process, and a stall beyond that budget raises a native message box instead of restarting forever.

A setting of `0` for the interval or the threshold keeps detection without replacement, which is what a deployment whose long tasks must never be sacrificed wants. The trade is explicit rather than accidental: 90 seconds of genuinely blocked work is indistinguishable from a wedged plugin by the probe alone, so the default accepts losing that work to avoid leaving a frozen window.

## Alternatives considered

**Report only, never restart.** Keeping a stalled Host running preserves its work, but the person sees a frozen window with no way to tell a long task from a dead plugin. A bounded restart with a crash report and a spent-budget message gives them a working application and a record of what happened.

**Kill and restart on a single missed probe.** One probe at 30 seconds cannot separate a wedged plugin from a slow request. Three probes makes the decision cost 90 seconds of silence — long enough for a legitimate slow operation to finish, short enough that a frozen window does not persist.

**Roll the profile back on a runtime stall.** A stall after readiness is not a composition that cannot start, so the app-boot recovery path is the wrong tool: restarting the Host isolates the fault without discarding working plugin configuration.

**Treat any pre-readiness failure as rollback-worthy, including the listener conflict.** Cheap, but it rewrites a working profile because a second DSH instance happened to be running.

**Roll back on the first failure.** A single failure is often a stale lock, a transient read, or the port case. Three consecutive failures of the *same composition* is evidence; one is a sample.

**Keep the streak in the profile directory.** The rollback renames `cordis.patch.yml`; a record living beside it would be one rename away from being lost along with the composition it describes.

**Bump the failure limit with a Config field.** The shell has no profile-level Config; `DSH_DESKTOP_*` environment variables are the established surface for shell tunables, and the limit is not intended to be tuned per launch.

## Consequences

- A plugin that prevents startup costs one stuck launch (up to two minutes) instead of an indefinite hang, and at most three launches before the profile is recovered automatically.
- The shell now writes one small file under userData on failure and deletes it on success. A lost or corrupt record only costs the automatic rollback; `evaluate()` ignores it and `recordFailure()` is best effort.
- Recovery rewrites the profile before the Host starts, which means the person's plugins are disabled without a dialog first. The dialog explains it after the fact and names the failure count. This is the intended trade: an unstartable profile cannot show a dialog.
- `DesktopBackendHost` gained a required `probe()` member, so every test double needed it. `welcome-startup.spec.ts` mocks the module wholesale and now also supplies `HOST_READY_TIMEOUT_MS`.
- Liveness probing and stall replacement are on by default, so a Host whose event loop is wedged is replaced after 90 seconds of silence. That accepts losing any work the stalled loop held, which is the intended trade against leaving a frozen window.
- This change also fixed a test-hygiene defect the journal exposed: `welcome-startup.spec.ts` mocked `app.getPath('userData')` to the fixed path `/desktop-user-data`, so every run wrote the journal record next to the drive root. It now uses a temporary directory removed in `afterEach`. `main-startup.spec.ts` likewise created its profile directory once per file and never removed it; it now cleans up in `afterAll`. The journal's own `existsSync` guard against an uninitialized profile stays, because it is a real correctness rule independent of either mock.
- `plugin-development` practices now state that a lifecycle hook must not hold the event loop, since that is the defect this supervision only contains rather than prevents.

## Testing

- [boot-journal.spec.ts](../../../../apps/desktop/tests/boot-journal.spec.ts) pins the streak rules: no rollback before the limit, a new streak on any composition change, the listener-conflict exemption, the single-rollback latch, the readiness clear, ignored corrupt records, and the uninitialized-profile exemption.
- [host-process.spec.ts](../../../../apps/desktop/tests/host-process.spec.ts) pins a Host that holds its event loop failing at its deadline with the retained stderr, a Host that reports `ready` never failing afterwards, and `probe()` reporting an unanswered Host without failing it.
- [main-startup.spec.ts](../../../../apps/desktop/tests/main-startup.spec.ts) pins the wiring: a consumed streak rolls back during preparation and reports it, readiness clears the record, a pre-readiness failure records one, liveness reports a stall once, and the configured threshold replaces the Host, leaves it alone below the threshold, and reports instead of restarting once the budget is spent.
- [duration-env.spec.ts](../../../../apps/desktop/tests/duration-env.spec.ts) pins the five settings' ranges and defaults, including the armed defaults themselves (a 30-second interval and three probes) and that zero for either value keeps detection without replacement.
- [event-loop-delay.spec.ts](../../../../apps/desktop-host/tests/event-loop-delay.spec.ts) pins the sampler: nothing before the first sample, a spun event loop reported as a large maximum with ordered percentiles, reset describing its own window, an idempotent stop, integer milliseconds, and a platform that refuses a histogram costing no exception.
- `main-startup.spec.ts` also pins that a stall report quotes the delay the last answered probe measured, and says so when no measurement was available.
