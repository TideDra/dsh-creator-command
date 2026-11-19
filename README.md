# dsh-creator-command

[English](./README.md) | [中文](./README.zh.md)

A [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) plugin bundle (`@local/dsh-creator-command`) that adds a `/creator` slash command, allowing any live session (`standard`, `ptc`, `minimal`, `codex`, `agy`, etc.) to dynamically gain DSH Creator mode (`cordis` preset) skills and plugin/Cordis inspection tools without switching to a new session.

## Features

- **Additive Per-Session Overlay**: Mounts Creator skills and tools strictly onto the current session's `agent.ctx` scope layer — existing tools and skills remain intact, other sessions are unaffected, and preset-level global tool `restrict` masks do not block the added tools.
- **Creator Skills Included**: Exposes DSH's built-in `@deepseek-ai/dsh-agent-preset/skills` (`agent-experience`, `cordis-composition-reference`, `cordis-plugin-development`, `editing-cordis-compositions`) through progressive `<available_skills>` disclosure and refreshes the Web UI's `/` skill autocomplete catalog immediately.
- **Creator Tools Included**: Equips the session with any missing Creator tools (`skill`, `cordis_inspect_list`, `cordis_inspect_query`, `plugin_manager`, and `plugin_market` when `pluginMarket` is mounted) while preserving existing preset tools without collisions.
- **KV-Cache Friendly**: Does not mutate `ctx.systemPrompt.section()`, keeping your conversation's system-prompt prefix cache intact across mid-session toggles.
- **Durable Across Resume & Fork**: Derives activation state from standard `command/run` and `command/done` session events via `ctx.sessionProjections`, automatically restoring `/creator` capabilities when a session is resumed or forked.

## Installation

### Option 1: Install directly from GitHub URL

In the DSH Web UI **Plugins** page (or via `plugin_manager` `install_bundle`), install from:

```text
git+https://github.com/TideDra/dsh-creator-command.git
```

### Option 2: Clone locally and install as a directory bundle

```bash
git clone https://github.com/TideDra/dsh-creator-command.git
```

Then install the cloned directory path via the DSH Plugin Manager or ask your DSH agent to call `plugin_manager` (`action: "install_bundle"`) with the local directory path.

## Usage

Type `/creator` in any session composer:

- `/creator` or `/creator on` — Enable DSH Creator mode skills and tools for the current session.
- `/creator <message>` — Enable Creator mode capabilities and immediately send `<message>` (with optional image/file attachments) to the agent.
- `/creator status` — Check whether Creator mode is active and list visible Creator skills and tools.
- `/creator off` — Unmount dynamically added Creator skills and tools from the current session (built-in preset tools remain untouched).

## Configuration

Optional fields on the `creator-command` entry in `cordis.patch.yml`:

| Field | Default | Description |
|---|---|---|
| `commandName` | `"creator"` | Slash command name without leading `/` |
| `customSkillDirs` | `[]` | Additional skill directories to mount alongside `@deepseek-ai/dsh-agent-preset/skills` |
| `includeFsTools` | `false` | Also mount `read` / `write` / `edit` (`@deepseek-ai/dsh-tool-fs`) when the session has neither `read` nor `read_file` |

## File Structure

- `package.json` — Bundle manifest, exports, locales, and icon declaration.
- `cordis.patch.yml` — Cordis composition patch inserting `creator-command`.
- `index.js` — Host plugin implementation (`/creator` command, `sessionProjections` state fold, and `agent.ctx` scoped mounting).
- `locale/en.json`, `locale/zh.json` — English and Chinese plugin metadata.
- `icon.svg` — Plugin vector icon.
- `test/creator-command.test.mjs` — Unit and integration test suite.

## License

[MIT](./LICENSE)
