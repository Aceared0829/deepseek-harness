# DSH Profile Plugin Snapshot

English | [中文](README.zh.md)

Carry a DSH profile from one device to another: plugin roster, locked versions, and dependency-resolution policy.

## Contents

| File | Purpose |
| --- | --- |
| `package.json` | Plugin roster and version constraints. `dsh.profile.bundles` is the activation order; `dependencies` is where versions come from. |
| `pnpm-lock.yaml` | Lockfile. Restoration uses it to install **exactly** the same versions. |
| `pnpm-workspace.yaml` | pnpm resolution policy (`hoisted`), packages allowed to run builds, `minimumReleaseAgeExclude`. |
| `restore.ps1` | One-command restore script. |

## About the two local private packages

`package.json` links two `link:` dependencies that are **not published packages**, so a new device has no such directories and a plain install fails:

- `@local/dsh-desktop-extras` pointing at `<workspace>/bundles/desktop-extras`
- `@dsh-pet/bridge` pointing at `<workspace>/pet-src/integrations/dsh-pet-bridge`

`restore.ps1` detects this: it links the directory when it exists, and otherwise tells you and offers two choices (skip, or place the package yourself). **This is not a defect in the snapshot; the two packages only ever existed on the original machine.**

## Restoring

On the new device, first make sure the DSH repository is cloned and starts normally, then:

```powershell
# 1. 备份当前 profile（可选但强烈建议）
$profile = "$env:DSH_PROFILE_DIR"

# 2. 运行还原脚本
.\restore.ps1 -ProfileDir $profile
```

The script:

1. backs up the existing `package.json`, `pnpm-lock.yaml`, and `pnpm-workspace.yaml` to `.bak-<timestamp>`
2. copies the snapshot files in
3. rewrites the `link:` paths to the real paths on this device, or skips them
4. runs `pnpm install`, rolling the configuration back if it fails

### Parameters

| Parameter | Purpose |
| --- | --- |
| `-ProfileDir <path>` | Target profile directory; defaults to `$env:DSH_PROFILE_DIR` |
| `-WorkspaceDir <path>` | Workspace root holding the private packages. When omitted, the script searches upwards for `default-workspace` and then falls back to `~/Documents/deepseek-harness/default-workspace` |
| `-SkipLocalPackages` | Force both local private packages to be skipped |
| `-ForceUnfrozen` | Do not pass `--frozen-lockfile` |

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Complete success |
| `1` | Install failed and the configuration was rolled back (`node_modules` may need manual cleanup) |
| `2` | The configuration is in place, but this machine has no `pnpm`; run `pnpm install` yourself |

### About `--frozen-lockfile`

When the roster was rewritten because private packages were skipped, `package.json` and the lockfile necessarily disagree, so `--frozen-lockfile` fails outright. The script detects that case and falls back to a plain install; you do not handle it by hand.

## Notes

- **`cordis.patch.yml` is not part of this snapshot.** It is your private runtime configuration (model list, `baseURL`, theme, pet position). Copy it separately if you need it.
- Restart DSH after restoring so the plugins take effect.
- The script only reads files inside the snapshot directory and **never modifies the snapshot itself**, so it is safe to run repeatedly.
