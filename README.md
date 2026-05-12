# pi-subagents

A pi extension that allows the main agent to spawn parallel sub-agents, with each sub-agent's latest output rendered in a rolling TUI window inline with the main agent's conversation history.

Sub-agents can optionally use **named profiles** that pre-configure provider/model, system prompts, thinking levels, and other model settings.

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

After `delegate_to_subagents` completes, it returns **session IDs** for each task. Use `get_subagent_output` to retrieve the final text output:

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `tasks` | `Array<{name, prompt, cwd?, profile?}>` | Yes | Array of tasks to delegate. Each gets its own sub-agent process. |
| `profile` | `string` | No | Default profile for all tasks (overridden by per-task profile) |

Each task:
- `name`: Display label shown in the TUI window header
- `prompt`: Prompt sent to the sub-agent (same as typing into pi directly)
- `cwd`: Working directory for the sub-agent (default: current directory)
- `profile`: Named profile to use for this sub-agent (see below)

The `maxLinesPerWindow` setting is configured in `settings.json` under `subagents.maxLinesPerWindow` (default: 15).

### Retrieving Sub-agent Output

After `delegate_to_subagents` completes, each task has a session ID. Use these tools to retrieve results:

- **`get_subagent_output(sessionId)`** — Returns the last assistant text output from a sub-agent session. This is the primary way to get results.
- **`get_subagent_session(sessionId)`** — Returns the full session transcript including all messages, tool calls, and results. Use for debugging.
- **`list_subagent_profiles()`** — Lists all available subagent profiles that can be used with `delegate_to_subagents`.

```json
{
  "get_subagent_output": {
    "sessionId": "abc12345"
  }
}
```

## Subagent Profiles

Profiles let you pre-configure the provider, model, system prompt, thinking level, and other settings for sub-agents. They are defined in `settings.json` under `subagents.profiles`.

### Defining Profiles

Add profiles to your global `~/.pi/agent/settings.json` or project-local `.pi/settings.json`:

```json
{
  "subagents": {
    "profiles": {
      "code-reviewer": {
        "model": "anthropic/claude-sonnet-4-5",
        "systemPrompt": "You are an expert code reviewer. Focus on bugs, security issues, and performance. Be thorough but concise.",
        "thinkingLevel": "high",
        "tools": ["read", "bash", "grep", "find"]
      },
      "fast-worker": {
        "model": "dashscope/qwen3.5-plus",
        "appendSystemPrompt": "Be concise. Skip explanations unless asked.",
        "thinkingLevel": "off"
      },
      "researcher": {
        "provider": "openai",
        "model": "gpt-4o",
        "systemPrompt": "You are a research assistant. Use web search to find information.",
        "thinkingLevel": "medium",
        "noExtensions": true
      },
      "planner": {
        "model": "dashscope/glm-5",
        "systemPrompt": "You are a planning agent. Break down tasks into steps. Do not execute, only plan.",
        "thinkingLevel": "high",
        "noTools": true
      }
    }
  }
}
```

### Profile Options

| Field | Type | Description |
|-------|------|-------------|
| `provider` | `string` | Provider name (e.g., `"anthropic"`, `"openai"`, `"dashscope"`)
| `model` | `string` | Model pattern or ID. Supports `"provider/id"` format and `":thinking"` shorthand (e.g., `"sonnet:high"`)
| `systemPrompt` | `string` | Replace the default system prompt entirely
| `appendSystemPrompt` | `string` | Append text to the default system prompt
| `thinkingLevel` | `string` | Thinking level: `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`
| `noTools` | `boolean` | Disable all tools
| `tools` | `string[]` | Allowlist of tool names to enable
| `noExtensions` | `boolean` | Disable all extensions
| `extensions` | `string[]` | Extension paths to load
| `noSkills` | `boolean` | Disable skills
| `noContextFiles` | `boolean` | Disable AGENTS.md/CLAUDE.md context files
| `apiKey` | `string` | Custom API key
| `extraArgs` | `string[]` | Additional CLI arguments passed verbatim

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

### Backward Compatibility: agentOverrides

The existing `subagents.agentOverrides` pattern continues to work. Entries in `agentOverrides` are treated as simple profiles with just model/provider settings:

```json
{
  "subagents": {
    "agentOverrides": {
      "worker": { "model": "dashscope/qwen3.5-plus" },
      "scout": { "model": "nvidia-nim/z-ai/glm4.7" }
    }
  }
}
```

If a name exists in both `profiles` and `agentOverrides`, the `profiles` entry takes precedence.

### Profile Resolution Order

1. Per-task `profile` field (highest priority)
2. Top-level `profile` parameter
3. If neither is specified, no profile is applied (uses pi defaults)

Settings are loaded from:
1. Global: `~/.pi/agent/settings.json`
2. Project-local: `.pi/settings.json` (overrides global)

## The `/profile` Command

Use `/profile` interactively to manage subagent profiles without editing JSON by hand:

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

1. **Scope** — save to global or project-local settings
2. **Provider** — e.g. `anthropic`, `openai`, `dashscope`
3. **Model** — supports `provider/id` and `:thinking` shorthand
4. **System prompt** — optionally set or replace the default
5. **Append system prompt** — optionally append to the default
6. **Thinking level** — off, minimal, low, medium, high, xhigh
7. **Tools** — restrict to an allowlist or disable all
8. **Extensions** — restrict or disable
9. **Review & save** — shows full profile before confirming

You can skip any field by answering "No" — it will be omitted from the profile (using pi defaults).

## Features

- **Parallel execution**: Multiple sub-agents run concurrently (up to 4 at a time by default)
- **Rolling window**: Each sub-agent shows its latest N lines in real-time
- **Live updates**: The TUI re-renders as sub-agents stream output
- **Expandable (Ctrl+O)**: Collapse to rolling window, expand to see full sub-agent output
- **Error handling**: Non-zero exit codes and errors are highlighted
- **Abort support**: Hitting Escape cancels all running sub-agents

## Architecture

```
Main Agent TUI
  └── Tool: delegate_to_subagents
        ├── Sub-agent A (pi --mode json -p)
        │       └── Latest 10 lines → TUI Window
        ├── Sub-agent B (pi --mode json -p)
        │       └── Latest 10 lines → TUI Window
        └── ...
```

Each sub-agent is a separate `pi` process in JSON mode. We parse JSONL events from stdout and maintain a rolling line buffer per agent. The tool's `renderResult` builds a `Container` of `Text` components, displayed inline with the conversation history.
