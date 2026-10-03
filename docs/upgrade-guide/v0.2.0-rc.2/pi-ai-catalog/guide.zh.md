---
kind: upgrade-guide
description: pi-ai 1.0 模型目录改变了已配置提供商可使用的模型 ID。
---

# 更新已配置的模型 ID

[English](guide.md) | 中文

## 变更

pi-ai 提供商使用已安装的 pi-ai 1.0 目录。显式的 `providers.<provider>.models` 列表会替换继承的目录，因此已有的受限列表可能隐藏新的 ChatGPT 模型。保存的模型选择必须指向当前目录或显式模型定义中存在的 ID。

## 迁移

1. 打开设置 → 模型 → ChatGPT 账号 → 编辑。移除受限模型列表以继承已安装的目录，或将所需的当前 ID 加入列表。
2. 在 profile 和 overlay 中，更新 `providers.<provider>.models` 和已选择的模型 ID，使其与已安装的目录一致。ChatGPT 路由是 `openai-codex`；当前目录包含 `gpt-6.1-sol`。
3. 在新会话中选择模型并发送消息。已有的 ChatGPT OAuth 凭据仍可使用；账号登录和额度控件位于设置 → 账号与余额。
