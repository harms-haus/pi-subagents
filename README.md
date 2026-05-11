# pi-subagents

A pi extension that allows the main agent to spawn parallel sub-agents, with each sub-agent's latest output rendered in a rolling TUI window inline with the main agent's conversation history.

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
        "prompt": "Review and fix all linting errors in the src/ directory. Use the bash tool to run eslint and fix any issues."
      },
      {
        "name": "linter-tests",
        "prompt": "Review and fix all linting errors in the tests/ directory. Use the bash tool to run eslint and fix any issues."
      }
    ],
    "maxLinesPerWindow": 10
  }
}
```

### Parameters

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `tasks` | `Array<{name, prompt, cwd?}>` | Yes | Array of tasks to delegate. Each gets its own sub-agent process. |
| `maxLinesPerWindow` | `number` | No | Maximum lines to show per sub-agent window (default: 10) |

Each task:
- `name`: Display label shown in the TUI window header
- `prompt`: Prompt sent to the sub-agent (same as typing into pi directly)
- `cwd`: Working directory for the sub-agent (default: current directory)

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
