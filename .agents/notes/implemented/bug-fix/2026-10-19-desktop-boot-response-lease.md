# Agent Note: Retain Desktop startup responses through renderer boot

Status: implemented

English | [中文](2026-10-19-desktop-boot-response-lease.zh.md)

## Problem

A Desktop development launch collects the index injection table from the Host after the Web application document is already loading. The document then executes the parser-blocking bootstrap rows, which fetch revisioned plugin bundle URLs. HMR can publish several client bundle generations between injection collection and those fetches. `ClientModuleRegistry` kept the current graph and only one preceding batch generation, so the bootstrap URL in the injection table could fall out of both tables. The Host answered 404, the client module system never mounted, and the window displayed the native startup recovery dialog. React render errors, missing root slots, unknown Session messages, and the earlier `MARKS_REMOTE_SPEC` syntax error were downstream or historical incidents rather than this failure.

The retained one-generation fallback existed to cover a request racing one rebuild. It cannot cover an arbitrary number of rebuilds, and a fixed generation count still fails under sustained editing.

## Decision

`ClientModuleRegistry.retainBootResponses()` snapshots the current graph's startup combo scripts, combo maps, and per-row fallback combo responses, then returns an idempotent release. The Host acquires this lease immediately before `collectIndexInjections()`. The injection table and retained responses therefore describe one graph generation, regardless of later HMR recompositions.

The Desktop Host returns the lease with the injection rows over the lifecycle control channel. Electron stores at most one lease per application renderer and serializes boot and release operations for that renderer. The renderer releases the lease after both the injection-table boot path and `AppWebEntry.run()` settle, including failure. Renderer destruction, Host replacement, update preparation, backend failure, and application shutdown release or drop outstanding leases before the owning Host stops. Update and shutdown first close boot admission; an in-flight Host request resolves after that request fails or returns, and a returned stale lease is released without becoming visible to the renderer. An update that fails before stopping the Host reopens admission. The Host also releases its retained leases when it shuts down or cannot deliver a boot response.

The lease covers combo scripts and maps because those are the bytes the startup injection table directly advertises; per-row one-resource fallback URLs are included because a batch that executed without registering a row falls back to that URL during the same boot. Package-local chunks remain lazy and outside the lease. Their files can already be overwritten when an older revision is requested, and retaining a response plan would serve new bytes under an old URL. A chunk materialized before a rebuild remains available through the ordinary immutable response table; an unrequested old chunk returns 404 after its revision changes.

The registry retains each lease independently in memory until release. This is not a bounded generation cache: the renderer-scoped lease ends at the point the startup URLs no longer need to be resolved.

## Alternatives considered

**Retain a fixed number of later generations.** Sustained HMR can still publish more generations than the bound, so the bootstrap URL can age out before the renderer requests it.

**Expire retained responses after a timer or TTL.** Correctness would depend on how long the renderer takes to start, which is neither bounded nor observable at the Host.

**Eagerly read and retain every bundle and package-local chunk when acquiring the lease.** This adds I/O and memory for files the renderer may never request. It also cannot guarantee exact old chunk bytes after an unrequested chunk was overwritten before the lease was acquired.

**Disable HMR during Desktop startup.** This changes development behavior globally rather than tying retention to the renderer that needs the specific startup generation.

**Pause the whole build pipeline for the startup window.** The Host cannot know which graph a renderer is about to execute until it collects the table, and a global pause would block unrelated build publication without narrowing ownership.

**Recover in the renderer after a 404.** The bootstrap failure prevents the client module tree and recovery UI from mounting reliably; by then the document can no longer retry against the missing generation.

## Consequences

Startup bundle URLs remain resolvable through an arbitrarily long HMR burst while the renderer is booting. Each active renderer holds at most one lease, and repeated boot requests release the previous one before acquiring the next. Release is idempotent and does not affect other renderers or earlier materialized responses.

The Host may retain the startup combo and map plans for the duration of renderer boot. The renderer release is best-effort after startup failure, but destruction and shutdown paths also release or discard the Host-owned lease so a dead renderer does not pin it indefinitely.

The protocol now carries a lease with boot injections and a matching release acknowledgement, so Desktop and Host built from different protocol generations must not be mixed. `DESKTOP_HOST_PROTOCOL_VERSION` advances with this wire change.

The first request for a prior-generation combo map after a rebuild still reads the current authored map file, as before. Package-local chunk URLs preserve only responses that were materialized under their original revision; a stale, unmaterialized chunk is intentionally 404 rather than a mixed-generation body.

## Verification

Client Modules tests cover an explicit lease across three rebuilds, idempotent independent release, retained row fallback and map URLs, and an unmaterialized old package-local chunk returning 404 without aliasing new bytes. Desktop tests cover serialized concurrent boots, renderer-owned release, release rejection retained until destruction, renderer destruction, boot-admission draining before backend stop, stale boot rejection, replacement Hosts, malformed IPC, and the `process.send` receiver required by Electron's Node mode. Web tests cover release after startup settles and after injection failure without replacing native recovery.
