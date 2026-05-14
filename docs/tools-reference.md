# Tools Reference

Complete reference for all tools provided by the pi-subagents extension.

> For profile configuration details, see [docs/profiles.md](profiles.md).
> For internal architecture (session lifecycle, process spawning, TUI rendering), see [docs/architecture.md](architecture.md).

## 1. Overview

| Tool | Description |
|------|-------------|
| [`delegate_to_subagents`](#2-delegate_to_subagents) | Spawn one or more parallel sub-agents to work on separate tasks concurrently. |
| [`get_subagent_output`](#3-get_subagent_output) | Retrieve the final assistant text output from a completed sub-agent session. |
| [`get_subagent_session`](#4-get_subagent_session) | Retrieve the complete session transcript, including all messages, tool calls, and tool results. |
| [`list_subagent_profiles`](#5-list_subagent_profiles) | List all available named sub-agent profiles and their configurations. |

All tools are registered on the pi-coding-agent `ExtensionAPI` via `pi.registerTool()`.

---

## 2. delegate_to_subagents

### Purpose

Spawn one or more parallel sub-agents to work on independent tasks. Each sub-agent runs in an isolated `pi` process with its own context window, tool access, and working directory. Live progress from each sub-agent is displayed in a rolling TUI window.

The tool returns session IDs for each task, which can be used with `get_subagent_output` and `get_subagent_session` to retrieve results after completion.

### Parameters

Defined by `DelegateParams` (TypeBox schema in [`schemas.ts`](../src/schemas.ts)):

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `tasks` | `Array<TaskObject>` | Yes | — | Array of 1–16 tasks to execute in parallel. See Task Object below. |
| `profile` | `string` | No | — | Default profile name applied to all tasks. Overridden by any per-task `profile` field. |

### Task Object

Each element of the `tasks` array has the following fields:

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | `string` | Yes | — | Display name for this sub-agent's TUI window. |
| `prompt` | `string` | Yes | — | The task/prompt sent to the sub-agent. When `resume` is set, the prior transcript is prepended (see [Resume Mechanics](#resume-mechanics)). |
| `cwd` | `string` | No | `process.cwd()` | Working directory for this sub-agent. Must be an absolute path and must not contain `..` segments. |
| `profile` | `string` | No | — | Named sub-agent profile for this specific task (overrides the top-level `profile`). See [docs/profiles.md](profiles.md). |
| `timeout` | `number` | No | `600` | Timeout in seconds. Must be ≥ 1. Aborts the sub-agent when exceeded. |
| `resume` | `string` | No | — | A previous session ID to continue work from. The resumed agent receives the prior session's transcript as context. |

### Return Value

Returns an object with:

- **`content`**: Array with a single `{ type: "text", text: string }` entry containing a summary line per task. Each line includes status (✓/✗), task name, session ID, error message (if any), and profile info.
- **`details`**: A `WindowedSubagentDetails` object containing live window state, max lines per window, global status (`"running"` or `"done"`), and all session IDs.

**Summary text format:**
```
✓ build-assets: completed (session: a3f7b9c2d1e8f4a1)
✗ run-tests: error — Timed out after 300s. Consider resuming with a longer timeout. (session: f4e1d8a7c0b39265)
```

### Behavior Details

#### Concurrency

- Maximum of **4 sub-agents** run simultaneously (`MAX_CONCURRENCY = 4`).
- Additional tasks are queued and started as earlier ones complete.
- Up to **16 tasks** total can be specified (`MAX_PARALLEL_TASKS = 16`).

#### Profile Resolution

Profiles are resolved **per-task** before execution begins. The resolution order is:

1. Per-task `profile` field (highest priority)
2. Top-level `profile` field (fallback)
3. No profile (if neither is set)

Resolution happens synchronously at the start of `execute()`, before any sub-agents are spawned.

#### Resume Mechanics

When a task specifies `resume`:

1. The session ID is validated against the session store — the session must exist and have at least one run.
2. The session must **not** be currently running (checked against the active session set).
3. If valid, all previous runs from the session are formatted into a human-readable transcript via `formatRunsForResume()` and prepended to the task's prompt:

```
Previously:

--- Run 1 (completed, 42 messages) ---
User: Analyze the codebase structure...
Assistant: The project has 3 main modules...
Tool Call: read(src/index.ts)
Tool Result: export interface Config {...}
...

Instructions:

Continue by refactoring the main loop.
```

4. The resumed task uses the **same session ID** as the original (not a new UUID).
5. The session store records the new run as an additional entry in the `SessionRecord.runs` array.

#### Timeout Behavior

- Each task gets its own `AbortController` and timer based on its `timeout` value (or the 600s default).
- When the timer fires, the task's `AbortController` is triggered, aborting the sub-agent process.
- The abort handler sends `SIGTERM`, escalating to `SIGKILL` after 5 seconds if the process hasn't exited.
- The window and session status are set to `"error"` with the message:
  ```
  Timed out after {N}s. Consider resuming with a longer timeout.
  ```
- If the parent tool call's signal is aborted, all task controllers are also aborted (but this does not produce the "timed out" message).

#### Unknown Profile Handling

Profile resolution happens before any sub-agents are spawned. If a task references a profile that cannot be found:

- The task's window and session are immediately marked as `"error"`.
- The error message lists available profiles:
  ```
  Unknown profile: "code-reviewer". Available profiles: researcher, writer
  ```
  If no profiles are configured, the message reads:
  ```
  Unknown profile: "code-reviewer". Available profiles: (none)
  ```
- Other tasks continue to execute normally — one bad profile does not cancel remaining tasks.

#### Resume Validation

Two checks are performed during `execute()`, before any sub-agents are spawned:

1. **Session exists**: `sessionStore.get(resumeId)` must return a record with at least one run. Otherwise:
   ```
   Cannot resume: session "a1b2c3d4e5f6a7b8" not found. The session may have expired or the ID is incorrect.
   ```
2. **Session not running**: The resume ID must not be in the active session set. Otherwise:
   ```
   Cannot resume: session "a1b2c3d4e5f6a7b8" is still running. Wait for it to complete before resuming.
   ```

If validation fails for **any** task, the entire tool call throws — no sub-agents are spawned.

### TUI Rendering

The tool provides custom `renderCall` and `renderResult` implementations:

- **`renderCall`**: Displays the tool name, task count, and profile information.
  ```
  delegate_to_subagents 3 sub-agents (default profile: researcher) profiles: [writer, researcher]
  ```

- **`renderResult`**: Shows a live rolling window display with:
  - **Global status header**: `Sub-agents: 2 running, 1 done, 1 error (15-line window)`
  - **Per-agent windows**: Each with a header (icon + name + profile), followed by rolling output lines. Tool calls are rendered in muted color.
  - **Expanded mode** (Ctrl+O): Shows all captured messages instead of just the latest N lines.
  - **Error display**: Red-colored error message beneath the agent's output.
  - **Footer**: When all agents are done, displays session IDs for use with retrieval tools.

### Examples

**Basic — two tasks, no profiles:**

```json
{
  "tasks": [
    {
      "name": "review-pr",
      "prompt": "Review the latest pull request and provide constructive feedback."
    },
    {
      "name": "update-docs",
      "prompt": "Update the API documentation to reflect the new /v2 endpoints."
    }
  ]
}
```

**With profiles — default and per-task overrides:**

```json
{
  "profile": "researcher",
  "tasks": [
    {
      "name": "market-analysis",
      "prompt": "Research competitor pricing for SaaS analytics platforms.",
      "profile": "analyst"
    },
    {
      "name": "tech-survey",
      "prompt": "Survey the latest developments in RAG architectures."
    }
  ]
}
```

**With resume — continue a timed-out session:**

```json
{
  "tasks": [
    {
      "name": "refactor-core",
      "prompt": "Continue refactoring the core module. Focus on the event dispatcher.",
      "resume": "a3f7b9c2d1e8f4a1",
      "timeout": 900
    }
  ]
}
```

---

## 3. get_subagent_output

### Purpose

Retrieve the final assistant text output from a completed sub-agent session. This is the primary way to get sub-agent results without requiring the sub-agent to write to files.

For **resumed sessions** (multiple runs), returns the output from the **latest** run only.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | `string` | Yes | The session ID returned by `delegate_to_subagents`. |

Defined inline as `Type.Object({ sessionId: Type.String(...) })`.

### Return Value

- **`content`**: Array with a single `{ type: "text", text: string }` entry containing the last assistant text message from the latest run.
- **`details`**:
  - `sessionId`: The queried session ID.
  - `status`: `"running"`, `"completed"`, or `"error"`.
  - `taskName`: The task name from the session.
  - `runCount`: Total number of runs (1 for normal sessions, 2+ for resumed sessions).
  - `maxLines`: TUI truncation limit.

If no assistant text was produced, returns `"(no text output from sub-agent)"`.

### Resumed Sessions

For sessions with multiple runs (created via `resume`), this tool returns output from `record.runs[record.runs.length - 1]` — the **latest** run only. It does **not** concatenate output from previous runs.

### Error Handling

If the session ID is not found or the session has no runs:

```
Session "c4d5e6f7a8b9c0d1" not found. The session may have expired or the ID is incorrect.
```

### TUI Rendering

Uses a **truncating renderer**: output is displayed in the TUI up to `maxLinesPerWindow` lines (loaded from profile config). Excess lines are indicated with:

```
... (47 more lines)
```

The **full content** is still injected into the LLM's context — truncation only affects TUI display.

---

## 4. get_subagent_session

### Purpose

Retrieve the **complete** session transcript from a sub-agent, including all messages: assistant text, tool calls, and tool results. Use this for detailed debugging or when you need the full conversation history.

For **resumed sessions** (multiple runs), returns **all runs' data concatenated** with run separators.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sessionId` | `string` | Yes | The session ID returned by `delegate_to_subagents`. |

Defined inline as `Type.Object({ sessionId: Type.String(...) })`.

### Return Value

- **`content`**: Array with a single `{ type: "text", text: string }` entry containing the full transcript.

  Each message is processed as follows:
  - **Text content**: Extracted and added verbatim.
  - **Tool calls**: Formatted as `→ toolName: {JSON args preview (120 chars)}`.
  - **Tool results**: Formatted as `[tool result]: {text}` — truncated to 500 characters with `...` appended if longer.
  - **Error messages**: Formatted as `[Error: {message}]`.

  Runs are separated by `\n---\n`. For multi-run (resumed) sessions, each run is prefixed with a header:
  ```
  === Run 1/3 (completed) ===
  ...
  ---
  === Run 2/3 (completed) ===
  ...
  ```

- **`details`**:
  - `sessionId`: The queried session ID.
  - `status`: Status of the latest run (`"running"`, `"completed"`, or `"error"`).
  - `taskName`: Task name from the latest run.
  - `messageCount`: Total messages across **all** runs (sum of `r.messages.length` for each run).
  - `exitCode`: Exit code from the latest run.
  - `model`: Model identifier from the latest run.
  - `runCount`: Number of runs (1 for normal, 2+ for resumed sessions).
  - `maxLines`: TUI truncation limit.

### Resumed Sessions

For sessions with multiple runs, `get_subagent_session` iterates over **all** runs in `record.runs` and concatenates their messages into a single transcript. Each run is clearly labeled with its run number and status.

### Error Handling

If the session ID is not found or the session has no runs:

```
Session "c4d5e6f7a8b9c0d1" not found. The session may have expired or the ID is incorrect.
```

### TUI Rendering

Uses the same **truncating renderer** as `get_subagent_output` — display is limited to `maxLinesPerWindow` lines with a truncation indicator. Full content is available in the LLM context.

---

## 5. list_subagent_profiles

### Purpose

List all available named sub-agent profiles that can be used with `delegate_to_subagents`. Profiles are loaded from two locations:

- **Global**: `~/.pi/agent/agent-profiles/*.md`
- **Project-local**: `.pi/agent-profiles/*.md`

Project-local profiles override global profiles with the same name.

### Parameters

None. The parameters schema is `Type.Object({})` — an empty object.

### Return Value

- **`content`**: Array with a single `{ type: "text", text: string }` entry. Each line is a profile summary generated by `profileSummary()`, containing the profile name, provider/model, system prompt preview, and key settings.
- **`details`**:
  - `count`: Number of profiles found.
  - `profiles`: Object mapping profile names to their summary strings.

### Empty Case

When no profiles are found, returns:

```
No subagent profiles found. Add .md files to ~/.pi/agent/agent-profiles/ or .pi/agent-profiles/.
```

With `details: { count: 0 }`.

### TUI Rendering

Uses a **simple (non-truncating) renderer** — the full profile list is displayed without truncation.

---

## 6. Error Reference

All error conditions and their messages:

| Condition | Tool(s) | Error Message | When |
|-----------|---------|---------------|------|
| **Session not found** | `get_subagent_output`, `get_subagent_session` | `Session "{id}" not found. The session may have expired or the ID is incorrect.` | Session ID not in store or has zero runs. |
| **Resume session still running** | `delegate_to_subagents` | `Cannot resume: session "{id}" is still running. Wait for it to complete before resuming.` | `resume` references a session currently in the active set. |
| **Resume session not found** | `delegate_to_subagents` | `Cannot resume: session "{id}" not found. The session may have expired or the ID is incorrect.` | `resume` references a non-existent session or one with zero runs. |
| **Unknown profile** | `delegate_to_subagents` | `Unknown profile: "{name}". Available profiles: {list}` | Task specifies a profile name not found in global or project-local directories. Other tasks continue normally. |
| **Sub-agent spawn failure** | `delegate_to_subagents` (internal) | `Failed to spawn sub-agent process` | The child `pi` process fails to start (e.g., binary not found, permission denied). Caught by the `error` event on `spawn()`. |
| **Timeout** | `delegate_to_subagents` (internal) | `Timed out after {N}s. Consider resuming with a longer timeout.` | A task exceeds its `timeout` value (default 600s). The sub-agent is aborted via `SIGTERM` → `SIGKILL`. |
| **Invalid cwd — relative path** | `delegate_to_subagents` (internal) | `cwd must be an absolute path` | The `cwd` parameter is not an absolute path. Thrown before the sub-agent is spawned. |
| **Invalid cwd — path traversal** | `delegate_to_subagents` (internal) | `cwd must not contain '..' path segments` | The resolved `cwd` contains `..` segments. Thrown before the sub-agent is spawned. |

---

## Cross-References

- **Profile configuration**: See [docs/profiles.md](profiles.md) for profile file format, frontmatter schema, and profile resolution order.
- **Architecture**: See [docs/architecture.md](architecture.md) for session lifecycle, process management, and TUI rendering internals.
