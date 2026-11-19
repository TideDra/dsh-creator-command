# dsh-creator-command

[English](./README.md) | 中文

这是一个用于 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 的插件包（`@local/dsh-creator-command`），提供 `/creator` 斜杠命令，让任意当前会话（如 `standard`、`ptc`、`minimal`、`codex`、`agy` 等）无需新建会话即可动态挂载 DSH Creator 模式（`cordis` 预设）下的全部技能（Skills）与插件开发/自省工具（Tools）。

## 功能特性

- **纯增量会话级挂载**：仅在当前会话自身的 `agent.ctx` 作用域层增量挂载 Creator 技能与工具，完全保留会话原有的工具和技能，不影响其他会话，也不受预设级全局工具 `restrict` 屏蔽影响。
- **内置 Creator 技能**：自动挂载 `@deepseek-ai/dsh-agent-preset/skills`（`agent-experience`、`cordis-composition-reference`、`cordis-plugin-development`、`editing-cordis-compositions`），通过原生渐进式 `<available_skills>` 机制按需加载，并即时刷新 Web 端 `/` 技能补全菜单。
- **内置 Creator 工具**：按需补齐当前会话缺失的 `skill`、`cordis_inspect_list`、`cordis_inspect_query`、`plugin_manager` 以及 `plugin_market`（当 `pluginMarket` 服务已挂载时），与预设自带同名工具零冲突。
- **保持 KV Cache 稳定**：不修改会话开头的 `systemPrompt`，避免多轮对话中途开启/关闭时破坏模型前缀缓存。
- **会话恢复与分叉持久化**：基于 `ctx.sessionProjections` 从原生 `command/run` 与 `command/done` 会话日志推导状态，重启恢复（resume）或分叉（fork）会话时自动还原。

## 安装方式

### 方式一：通过 GitHub 地址直接安装

在 DSH Web 端 **插件（Plugins）** 页面（或通过 `plugin_manager` 的 `install_bundle`）直接输入仓库地址安装：

```text
git+https://github.com/TideDra/dsh-creator-command.git
```

### 方式二：克隆到本地目录安装

```bash
git clone https://github.com/TideDra/dsh-creator-command.git
```

然后在 DSH 插件管理器中选择克隆后的本地目录，或让 DSH Agent 调用 `plugin_manager`（`action: "install_bundle"`）指向该目录路径。

## 使用方法

在任意对话输入框中使用：

- `/creator` 或 `/creator on` — 为当前会话开启 DSH Creator 模式技能与工具。
- `/creator <消息内容>` — 开启 Creator 模式能力，并立即将该消息（支持携带图片/文件附件）提交给 Agent 执行。
- `/creator status` — 查看当前会话 Creator 模式状态以及可见的技能与工具列表。
- `/creator off` — 卸载当前会话动态挂载的 Creator 技能与工具（会话预设原有的工具保持不变）。

## 可选配置

可在 `cordis.patch.yml` 的 `creator-command` 条目 `config` 中配置：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `commandName` | `"creator"` | 斜杠命令名称（不含前导 `/`） |
| `customSkillDirs` | `[]` | 除 `@deepseek-ai/dsh-agent-preset/skills` 外额外挂载的技能目录 |
| `includeFsTools` | `false` | 当会话既无 `read` 也无 `read_file` 工具时，是否自动补齐 `read` / `write` / `edit`（`@deepseek-ai/dsh-tool-fs`） |

## 目录结构

- `package.json` — 插件包清单、导出项、多语言与图标声明
- `cordis.patch.yml` — Cordis 装配补丁，注册 `creator-command`
- `index.js` — Host 插件实现（`/creator` 命令、`sessionProjections` 状态折叠、`agent.ctx` 作用域动态挂载）
- `locale/en.json`、`locale/zh.json` — 中英文插件展示元信息
- `icon.svg` — 插件矢量图标
- `test/creator-command.test.mjs` — 单元与集成测试套件

## 许可证

[MIT](./LICENSE)
