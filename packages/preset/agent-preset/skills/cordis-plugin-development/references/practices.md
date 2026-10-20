# Harness plugin practices

These rules follow from Harness mechanisms. Confirm every Service method, Event name, and dispatch mode named here with `cordis_inspect_query` (`Service`, `Event`) before relying on it; the installed Harness is the authority.

Performance and UI rules live in `practices-runtime.md`. Read that one too before
writing a view or anything that runs during a lifecycle hook: the two sections
were split out of this file so each stays readable in one pass.

## Principles

1. **The session log is the only source of truth.** Anything the model sees must be reconstructable from committed session events; fork, resume, and replay derive from the log. Plugin memory is a derived cache.
2. **Registrations are effects owned by a context.** Plugin unload, agent disposal, slot collapse, and profile patches remove what was registered on the corresponding context. Choose the owning context. A registration on another context, such as `agent.ctx`, has two owners: keep its disposer in your plugin's own effect too, so either teardown removes it.
3. **The framework drives; the plugin computes.** Session projections, Conversation assembly, and slot rendering subscribe, cache, and publish for you. A plugin that subscribes, rescans, or writes DOM itself bypasses that incremental machinery.
4. **Extension points are shared; use the weakest mechanism that suffices.** From weakest to strongest: `ctx.tools.restrict()` can only remove tools; `ctx.tools.guard()` can only deny; waterfall listeners can rewrite and depend on registration order; `system-prompt/assemble` replaces the whole assembly. The stronger the mechanism, the more of other plugins' contributions you must preserve.
5. **Other plugins and other Harness versions read your data.** Unknown event types, older readers, and older cached state meet what you write; declare compatibility with the envelope fields and versions the Harness provides.
6. **Plugin UI is part of the Harness UI.** Users see one application, so a plugin uses the host's theme tokens, locale, and layout patterns, and matches the look and behavior of host components. Whether that is possible is decided by where the UI renders, so choose the rendering surface before writing any view; later styling inside the wrong surface cannot recover consistency.

## Stability

- A waterfall listener (`agent/pre-step`, `agent/request`, `llm/stream`, `tools/pre-execute`, `tools/execute`, `tools/post-execute`) that does not own the decision must return `next()`. When rewriting an `agent/pre-step` decision, spread it (`{ ...decision, messages }`) so fields such as `startsRequestSeries` survive.
- A denial that must hold regardless of order is a `ctx.tools.guard()`; a guard is synchronous, so a decision that must await something, such as asking the user, returns `ask` from `tools/pre-execute`. Hiding tools from one agent is `ctx.tools.restrict()` on that agent's context; it keeps schema presentation, lookup, and execution aligned. Observe final tool outcomes on `tools/result`; use `tools/post-execute` only to transform a result. Do not listen to `system-prompt/assemble` to add or remove tools or text.
- Add prompt text with `ctx.systemPrompt.section()`. Add per-agent context with `agent.inject()`; it is logged as `agent/inbox/spliced` at call time and enters the next admitted step. `agent/request` listeners cannot change request messages.
- Register per-agent behavior on `agent.ctx`, obtained in an `agent/created` listener, so it is removed when that agent is disposed. Wrap it in one `agent.ctx.effect()` and also keep that disposer, keyed by agent, in your plugin's own effect; unloading the plugin does not dispose `agent.ctx` registrations by itself.
- Put optional services in `inject` or `ctx.inject([...], ...)` so the plugin stays inactive in profiles without them instead of throwing.
- Do not append session events with a new `type`. Readers accept an unknown stored event only when its envelope carries `ignorable: true`, and live `Session.append()` cannot set that marker, so the Session would refuse to reopen. `appendPluginRecord()` writes ignorable `plugin:` records, but it is reserved for DSH's experimental packages because a Session format migration keeps those records only on a best-effort basis. Derive state from existing events, or keep plugin-owned data in a storage service found through inspection.
- Put tunable values in the plugin's `Config` so users change them in `cordis.patch.yml`; the user's patch layer survives upgrades.
