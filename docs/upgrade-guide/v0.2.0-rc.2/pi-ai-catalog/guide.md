---
kind: upgrade-guide
description: The pi-ai 1.0 model catalog changes the model IDs available to configured providers.
---

# Updating configured model IDs

English | [中文](guide.zh.md)

## Change

The pi-ai provider uses the installed pi-ai 1.0 catalog. Explicit `providers.<provider>.models` lists replace the inherited catalog, so an existing restricted list can hide new ChatGPT models. Saved model selections must refer to an ID available in the current catalog or an explicit model definition.

## Migration

1. Open Settings → Models → ChatGPT account → Edit. Remove a restricted model list to inherit the installed catalog, or add the desired current IDs to that list.
2. In profiles and overlays, update `providers.<provider>.models` and any selected model ID to match the installed catalog. The ChatGPT route is `openai-codex`; the current catalog includes `gpt-6.1-sol`.
3. Select the model in a new conversation and send a message. Existing ChatGPT OAuth credentials remain usable; account login and usage controls are available in Settings → Account and balance.
