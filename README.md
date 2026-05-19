# pi-subagents

A pi extension that allows the main agent to spawn parallel sub-agents, with each sub-agent's latest output rendered in a rolling TUI window inline with the main agent's conversation history.

Sub-agents can optionally use **named profiles** that pre-configure provider/model, system prompts, thinking levels, and other model settings. Profiles are stored as individual `.md` files with YAML frontmatter.

## Installation

### Installed as a pi package (Recommended)

```bash
pi install git:github.com/harms-haus/pi-subagents
```

Or use `https://` / `ssh://` instead of `git:` if you prefer.

### Local Development

Clone the repo and install the local path (use `-l` for project-local install):

```bash
cd pi-subagents
pi install . -l
```

## Usage

Once installed, the LLM can use the tool:

```json
{
  "delegate_to_subagents": {
    "tasks": [
      {
        "name": "linter-src",
        "prompt": "Review and fix all linting errors in the src/ directory."
      },
      {
        "name": "linter-tests",
        "prompt": "Review and fix all linting errors in the tests/ directory.",
        "profile": "fast-worker"
      }
    ]
  }
}
```

### Providing File Context

Each task can include a `files` array to read file contents and prepend them to the sub-agent's prompt:

```json
{
  "delegate_to_subagents": {
    "tasks": [
      {
        "name": "fix-lint",
        "prompt": "Fix all linting errors in this file.",
        "files": ["src/utils.ts"]
      }
    ]
  }
}
```

File specs support line ranges: `{ "path": "src/main.ts", "start": 10, "end": 50 }`, `{ "path": "log.txt", "tail": 20 }`, or `{ "path": "config.json", "head": 5 }`.

> See [docs/tools-reference.md](docs/tools-reference.md) for complete parameter documentation.

After `delegate_to_subagents` completes, it returns **session IDs** for each task. Use `get_subagent_output` to retrieve the final text output:

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `tasks` | `Array<{name, prompt, cwd?, profile?, timeout?, resume?, files?}>` | Yes | Array of tasks to delegate. Each gets its own sub-agent process. |
| `profile` | `string` | No | Default profile for all tasks (overridden by per-task profile) |

Each task:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Display label shown in the TUI window header |
| `prompt` | `string` | Yes | Prompt sent to the sub-agent (same as typing into pi directly) |
| `cwd` | `string` | No | Working directory for the sub-agent (default: current directory) |
| `profile` | `string` | No | Named profile to use for this sub-agent (see below) |
| `timeout` | `number` | No | Timeout in seconds for this sub-agent. Default: 600. Timeouts auto-extend when the sub-agent is actively producing output — after the initial timeout expires, the sub-agent is only killed after a configurable idle period (see `extend_timeout_debounce` setting). |
| `resume` | `string` | No | Previous session ID to resume from. The resumed sub-agent receives the prior session's transcript as context. Only completed or errored sessions can be resumed. |
| `files` | `Array<FileSpec>` | No | File paths to read and prepend to the sub-agent's prompt. See "Providing File Context" above. |

The `maxLinesPerWindow` setting is configured in `settings.json` under `subagents.maxLinesPerWindow` (default: 15).

### Retrieving Sub-agent Output

After `delegate_to_subagents` completes, each task has a session ID. Use these tools to retrieve results:

- **`get_subagent_output(sessionId)`** — Returns the last assistant text output from a sub-agent session. For resumed sessions, returns the latest run's output. This is the primary way to get results.
- **`get_subagent_session(sessionId)`** — Returns the full session transcript including all messages, tool calls, and results. For resumed sessions, returns all runs' data concatenated. Use for debugging.
- **`list_subagent_profiles()`** — Lists all available subagent profiles that can be used with `delegate_to_subagents`.

```json
{
  "get_subagent_output": {
    "sessionId": "a1b2c3d4e5f6a7b8"
  }
}
```

### Resuming Sessions

Use the `resume` parameter to continue work from a previously completed (or errored) sub-agent session. The resumed agent receives the full transcript of all prior runs prepended to its prompt:

```json
{
  "delegate_to_subagents": {
    "tasks": [
      {
        "name": "continue-refactor",
        "prompt": "Continue the refactoring. Focus on the remaining utility modules.",
        "resume": "a1b2c3d4e5f6a7b8"
      }
    ]
  }
}
```

Key behaviors:

- The resumed agent's prompt is prefixed with `Previously:\n\n<transcript>\n\nInstructions:\n\n<your prompt>`, giving it full context of prior work.
- Only **completed** or **errored** sessions can be resumed. Running sessions will throw an error.
- A session can be resumed multiple times — each resume creates a new "run" appended to the session record.
- `get_subagent_output` returns output from the **latest run** only.
- `get_subagent_session` returns **all runs** concatenated with run separators.

## Subagent Profiles

Profiles let you pre-configure the provider, model, system prompt, thinking level, and other settings for sub-agents. Each profile is a `.md` file with YAML frontmatter.

### Profile Locations

| Scope | Directory |
|-------|-----------|
| Global | `~/.pi/agent/agent-profiles/*.md` |
| Project | `.pi/agent-profiles/*.md` |

Project-local profiles override global profiles with the same name.

### Example Profiles

**`~/.pi/agent/agent-profiles/code-reviewer.md`**:

```markdown
---
name: code-reviewer
provider: anthropic
model: claude-sonnet-4-5
thinkingLevel: high
tools: read,bash,grep,find
---
You are an expert code reviewer. Focus on bugs, security issues, and performance problems. Be thorough but concise.
```

**`~/.pi/agent/agent-profiles/fast-worker.md`**:

```markdown
---
name: fast-worker
model: dashscope/qwen3.5-plus
appendSystemPrompt: Be concise. Skip explanations unless asked.
thinkingLevel: off
---
```

**`.pi/agent-profiles/researcher.md`** (project-local):

```markdown
---
name: researcher
provider: openai
model: gpt-4o
appendSystemPrompt: Use web search to find information. Cite sources when possible.
---
You are a research assistant.
```

### Profile Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | `string` | **Required.** Profile identifier (from YAML frontmatter name field) |
| `provider` | `string` | Provider name (e.g., `"anthropic"`, `"openai"`, `"dashscope"`) |
| `model` | `string` | Model pattern or ID. Supports `"provider/id"` format and `":thinking"` shorthand (e.g., `"sonnet:high"`) |
| `systemPrompt` | N/A | Set via the **body** of the markdown file (text after `---`). Replaces the default system prompt entirely. |
| `appendSystemPrompt` | `string` | Append text to the default system prompt |
| `thinkingLevel` | `string` | Thinking level: `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"` |
| `noTools` | `boolean` | Disable all tools |
| `tools` | `string` or `string[]` | Comma-separated string or YAML array of tool names to enable (allowlist) |
| `excludeTools` | `string` or `string[]` | Comma-separated string or YAML array of tool names to exclude (blacklist; mutually exclusive with `tools`) |
| `noExtensions` | `boolean` | Disable all extensions |
| `extensions` | `string` or `string[]` | Comma-separated string or YAML array of extension paths to load |
| `noSkills` | `boolean` | Disable skills. Mutually exclusive with `suggestedSkills` and `loadSkills` |
| `suggestedSkills` | `string` or `string[]` | Skill names to *suggest* to the sub-agent via `--skill` CLI flags; the model chooses whether to load them |
| `loadSkills` | `string` or `string[]` | Skill names to *pre-load* into the sub-agent's system prompt (content wrapped in `<loaded_skill>` XML tags) |
| `noContextFiles` | `boolean` | Disable AGENTS.md/CLAUDE.md context files |
| `apiKey` | `string` | Custom API key (stored as `PI_API_KEY` env var, not in CLI args) |
| `extraArgs` | `string` or `string[]` | Comma-separated string or YAML array of additional CLI arguments |

Array fields (`tools`, `extensions`, `extraArgs`, `suggestedSkills`, `loadSkills`) support both YAML arrays and comma-separated strings:

```yaml
tools:
  - read
  - bash
  - grep
```

or equivalently:

```yaml
tools: read,bash,grep
```

### Using Profiles

**Per-task profile** — each task specifies its own profile:

```json
{
  "delegate_to_subagents": {
    "tasks": [
      { "name": "review", "prompt": "Review src/...", "profile": "code-reviewer" },
      { "name": "research", "prompt": "Find best practices for...", "profile": "researcher" }
    ]
  }
}
```

**Default profile for all tasks** — set at the top level, overridden by per-task profiles:

```json
{
  "delegate_to_subagents": {
    "profile": "fast-worker",
    "tasks": [
      { "name": "task-a", "prompt": "..." },
      { "name": "task-b", "prompt": "...", "profile": "code-reviewer" }
    ]
  }
}
```

### Profile Resolution Order

1. Per-task `profile` field (highest priority)
2. Top-level `profile` parameter
3. If neither is specified, no profile is applied (uses pi defaults)

Profiles are loaded from `.md` files:

1. Global: `~/.pi/agent/agent-profiles/*.md`
2. Project-local: `.pi/agent-profiles/*.md` (overrides global profiles with the same name)

The profile cache refreshes every 5 seconds.

### Settings

Additional settings are configured in `settings.json` under the `subagents` key:

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `maxLinesPerWindow` | `number` | `15` | Number of lines shown in each sub-agent's rolling TUI window |
| `commandPreviewWidth` | `number` | Terminal width − 4 (TTY) or `160` (non-TTY) | Controls tool call preview truncation width in the rolling window. **In TTY mode, terminal width − 4 is used as a hard override — settings files are never consulted.** In non-TTY mode, falls back through settings files (global → project → default 160). Minimum: 20 |
| `extend_timeout_debounce` | `number` | `30` | Seconds of idle time (no output activity) before a timed-out sub-agent is killed. The initial timeout starts this idle window; any output resets it. Range: 0–300. |
| `looping_tool_count` | `number` | `5` | Number of consecutive tool calls checked for loop detection. Set to `0` to disable. Range: 0–50. |
| `looping_tool_similarity` | `number` | `0.95` | Bigram similarity threshold for loop detection. When the last `looping_tool_count` tool calls are all pairwise similar above this threshold, the sub-agent is killed. Range: 0–1. |

Settings are loaded from `~/.pi/agent/settings.json` (global) and `.pi/settings.json` (project-local, overrides global). **Note:** `commandPreviewWidth` settings are only consulted in non-TTY mode.

## The `/profile` Command

Use `/profile` interactively to manage subagent profiles without editing files by hand:

| Command | Description |
|---------|-------------|
| `/profile list` | List all profiles with summaries |
| `/profile show <name>` | Display full details of a profile |
| `/profile <name>` | Alias for `show` |
| `/profile create <name>` | Interactively create a new profile |
| `/profile edit <name>` | Interactively edit an existing profile |
| `/profile delete <name>` | Delete a profile |

### Interactive Editor

`/profile create` and `/profile edit` walk you through each setting:

1. **Scope** — save to global (`~/.pi/agent/agent-profiles/`) or project-local (`.pi/agent-profiles/`) directory
2. **Provider** — e.g. `anthropic`, `openai`, `dashscope`
3. **Model** — supports `provider/id` and `:thinking` shorthand
4. **System prompt** — the body text of the `.md` file (replaces default system prompt)
5. **Append system prompt** — optionally append to the default
6. **Thinking level** — off, minimal, low, medium, high, xhigh
7. **Tools** — choose to disable all (`noTools`), enable a specific set (`tools`), or exclude specific tools (`excludeTools`)
8. **Extensions** — restrict or disable
9. **Skills** — if skills are already set, offers to remove them; otherwise asks whether to configure skills, then prompts for comma-separated suggested and/or pre-loaded skill names
10. **Review & save** — shows full profile as markdown before confirming

You can skip any field by answering "No" — it will be omitted from the profile (using pi defaults).

## Features

- **Parallel execution**: Multiple sub-agents run concurrently (up to 4 at a time by default)
- **Rolling window**: Each sub-agent shows its latest N lines in real-time
- **Live updates**: The TUI re-renders as sub-agents stream output
- **Expandable (Ctrl+O)**: Collapse to rolling window, expand to see full sub-agent output
- **Error handling**: Non-zero exit codes and errors are highlighted
- **Abort support**: Hitting Escape cancels all running sub-agents
- **Session resume**: Continue work from completed/errored sessions with full transcript context
- **Per-task timeouts**: Configurable timeout per sub-agent (default 600s), with auto-extension while the agent remains active
- **Loop detection**: Automatically kills sub-agents that repeat the same tool calls in a tight loop

## Architecture

```
Main Agent TUI
  │
  └── delegate_to_subagents
        │
        ├── Resolve profiles from .md files
        │   ├── Global: ~/.pi/agent/agent-profiles/*.md
        │   └── Project: .pi/agent-profiles/*.md
        │
        ├── Validate profile skills (suggestedSkills/loadSkills vs noSkills)
        │
        ├── Resolve skill names → file paths (suggestedSkills) or injected content (loadSkills)
        │
        ├── Validate resume targets (must be completed/errored)
        │
        ├── For each task (concurrency ≤ 4):
        │   │
        │   ├── [resume?] Inject prior session transcript into prompt
        │   │
        │   ├── Spawn: pi --mode json -p --no-session [profile args...] "prompt"
        │   │   │
        │   │   ├── Parse JSONL stdout events
        │   │   ├── Update rolling window (latest N lines)
        │   │   ├── Track tool calls & results
        │   │   └── [timeout?] Abort if task timeout exceeded
        │   │
        │   └── Store session data (messages, status, exit code)
        │
        └── Return session IDs → get_subagent_output / get_subagent_session
```

Each sub-agent is a separate `pi` process in JSON mode. We parse JSONL events from stdout and maintain a rolling line buffer per agent. The tool's `renderResult` builds a `Container` of `Text` components, displayed inline with the conversation history.
