# DSH Profile 插件快照

[English](README.md) | 中文

把当前设备的 DSH profile（插件清单 + 版本锁定 + 依赖解析策略）同步到另一台设备。

## 内容

| 文件 | 说明 |
| --- | --- |
| `package.json` | 插件清单与版本约束。`dsh.profile.bundles` 是启用顺序，`dependencies` 是版本来源。 |
| `pnpm-lock.yaml` | 锁文件。还原时用它保证装出**完全相同**的版本。 |
| `pnpm-workspace.yaml` | pnpm 解析策略（`hoisted`）、允许构建的包、`minimumReleaseAgeExclude`。 |
| `restore.ps1` | 一键还原脚本。 |

## 关于 `link:` 依赖

`package.json` 里有 7 个 `link:` 依赖，它们**不是 npm 上的包**，新设备上没有这些目录，直接安装会失败。其中 5 个在 `<workspace>`（`default-workspace` 根）下，2 个在 DSH 仓库内：

| 包 | 期望位置 |
| --- | --- |
| `@local/dsh-desktop-extras` | `<workspace>/bundles/desktop-extras` |
| `@dsh-pet/bridge` | `<workspace>/pet-src/integrations/dsh-pet-bridge` |
| `@dsh-pet/lifecycle` | `<workspace>/dsh-kit/plugins/dsh-pet-lifecycle` |
| `dsh-connect-grok` | `<workspace>/dsh-connect-grok` |
| `dsh-connect-workbuddy` | `<workspace>/bundles/dsh-connect-workbuddy` |
| `dsh-harness-eval` | `<repo>/plugins/harness-eval` |
| `@deepseek-ai/dsh-subagent-claude-code` | `<repo>/packages/subagent/subagent-claude-code` |

`restore.ps1` 会自动检测：目录存在就按本机路径重新 link，不存在就提示你并从清单里移除该包。**这不是快照本身的问题，是这些包本来就只存在于本机。**

## 还原步骤

在新设备上，先确保 DSH 仓库已 clone 并能正常启动，然后：

```powershell
# 1. 备份当前 profile（可选但强烈建议）
$profile = "$env:DSH_PROFILE_DIR"

# 2. 运行还原脚本
.\restore.ps1 -ProfileDir $profile
```

脚本会：
1. 备份现有 `package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml` 到 `.bak-<时间戳>`
2. 复制快照文件进去
3. 把 `link:` 路径改写成新设备上的实际路径（或跳过）
4. 执行 `pnpm install`，失败时回滚配置

### 参数

| 参数 | 说明 |
| --- | --- |
| `-ProfileDir <path>` | 目标 profile 目录，默认取 `$env:DSH_PROFILE_DIR` |
| `-WorkspaceDir <path>` | 私有包所在 workspace 根目录。不指定时自动向上查找 `default-workspace`，再兜底 `~/Documents/deepseek-harness/default-workspace` |
| `-RepoDir <path>` | DSH 仓库根目录（用于 `packages/`、`plugins/` 内的 link）。不指定时取脚本所在目录向上两级 |
| `-SkipLocalPackages` | 强制跳过所有 `link:` 私有包 |
| `-ForceUnfrozen` | 不使用 `--frozen-lockfile` |

### 退出码

| 码 | 含义 |
| --- | --- |
| `0` | 完全成功 |
| `1` | 安装失败，配置已回滚（`node_modules` 可能残留，需手动清理） |
| `2` | 配置已就位，但本机没有 `pnpm`，需手动执行 `pnpm install` |

### 关于 `--frozen-lockfile`

清单被改写时（跳过了私有包），`package.json` 与 lock 必然不一致，`--frozen-lockfile` 会直接失败。脚本会自动检测这种情况并退化为普通安装，不需要你手动处理。

## 注意

- **`cordis.patch.yml` 不在此快照内** —— 那是你的私人运行时配置（模型清单、`baseURL`、主题、pet 位置）。需要的话单独拷贝。
- 还原后重启 DSH 使插件生效。
- 脚本只读取快照目录里的文件，**不会修改快照本身**，可以安全重复运行。
