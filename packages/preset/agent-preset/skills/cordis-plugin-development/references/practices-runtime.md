# Harness plugin runtime practices

Performance and UI rules. They follow from how the Host and the shell actually
run plugin code, so a violation costs either the whole process or the user's
trust in the panel. Read `practices.md` first for the mechanism rules; these
two sections were split out of it to keep each file readable in one pass.

Confirm every Service method, Event name, and dispatch mode named here with
`cordis_inspect_query` (`Service`, `Event`) before relying on it; the installed
Harness is the authority.

## Performance

- Keep per-session state derived from the log in a `ctx.sessionProjections` unit instead of subscribing to `session/event` and rescanning `session.events`. `apply(state, event)` is pure and synchronous and returns the same reference for events it ignores, so unchanged state costs nothing downstream. Read with `stateOf()`. A `view()` returns the same reference when its value is unchanged, which suppresses publication.
- Keep projection state plain JSON and bump `stateVersion` when fields or fold semantics change. The projection cache then checkpoints it, cold reads replay only the tail, and stale checkpoints are discarded.
- Keep the persisted state small, and measure the distribution rather than one sample. The cache rewrites the whole row on every change, so a row that grows with the session costs quadratically: a field that stored raw tool arguments was correct, passed every test, and reached 470 KB on one session. Bound any collection you keep in state and store a hash rather than a payload when identity is all you need.
- Wait on durable events such as `turn/end`, `assistant/message`, or `tool/result`; render live tokens from `agent/assistant-stream`. Do not poll `agent/status`. `whenIdle()` does not mean one follow-up finished: several inputs can share one running interval.
- A timer that starts work calls `agent.followup()`, which wakes the agent; `agent.inject()` does not wake it, so injected context can wait in the inbox until other input arrives. Clear the timer in the owning effect.
- **Never hold the event loop through a plugin lifecycle hook.** The Host runs one Node event loop, so a synchronous long task in `apply()`, an event listener, a tool body, or a slot injector freezes every session, tool, and HTTP request in the process; nothing inside the process can rescue it. Bound the work per call and hand anything longer to an async path: stream or chunk with `await`, move it to `ctx.subprocess`/`ctx.shell`, or schedule it on a worker. An unbounded `while` loop, a synchronous read of a large file, and a blocking `spawnSync` are all the same failure.
- The Desktop shell replaces a Host that stops answering its liveness probes, so a hidden infinite loop costs the person whatever that Host was holding. Treat a blocking loop as a defect even when the frozen window eventually recovers.

## UI

- Render plugin pages as React components in a slot. Do not serve an HTML page from the Host and embed it in an iframe: an iframe document does not receive the host's theme tokens, light/dark switching, or `ctx.locale`.
- Style with the theme tokens that `cordis_inspect_query` `Theme` lists (`--dsw-alias-*`); literal colors are for artwork only. Tokens are the lowest-risk way to match the host: a renamed token degrades appearance but never breaks rendering. Copy spacing, type sizes, and row patterns from an existing host page of the same kind; the Plugin Manager page is the reference for management lists.
- Do not `require('@deepseek-ai/dsh-client-ui-primitives')` or load any other Harness Client package as a module; `dsh.client.inject` entries only order activation and stay allowed. They change without notice, a plain-JS plugin has no type check, and a throwing component blanks your slot entry (console: `slot entry crashed in '<slot>'`). Write your own controls and match the host instead: copy markup, CSS, and behavior from the primitive into the plugin (`src/*.tsx` and `*.module.css` in a DSH source checkout, or the installed package's `lib/index.js` and `lib/**/*.css`), or inspect the rendered host control in the connected page. Rename copied classes under your plugin's prefix, keep only `--dsw-alias-*` token references, and keep the behavior that users rely on, such as Modal focus and Escape handling, `role="switch"` with `aria-checked`, and Tooltip placement. Tokens then remain the only shared styling dependency.
- Contribute through slots: `ctx.slots.inject(ownerKey, () => ctx.slots.register(...))`. The callback's registrations are disposed when the owning declaration collapses and reinstalled when it returns. Read session data through the slot props' selector hooks, subscribing to the smallest slice. Do not write DOM outside your component or append to `document.body`.
- Add a Chat row by registering an event definition with `ctx.uiConversation.events.register()` and its view in the `conversation.chat.node` slot under the definition's `kind`, which is the renderer key; the Conversation layer owns paging, Turn and Step placement, and incremental assembly.
- When the Client needs a value derived from a session, declare `wire.view` on the Host projection. The value reaches the Client already computed; the Client does not fold session events itself.
- Treat the view as untrusted input on the way in. A payload can be older than the code reading it (a cached row, a stale tab), so every field the view does not always publish is optional at the render site. A render throw is a blank panel, which reads to the user as a plugin that does nothing.
