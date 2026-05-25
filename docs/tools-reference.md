# Tools Reference

Complete reference for all tools provided by the pi-subagents extension.

> For profile configuration details, see [docs/profiles.md](profiles.md).
> For internal architecture (session lifecycle, process spawning, TUI rendering), see [docs/architecture.md](architecture.md).

## 1. Overview

| Tool                                                  | Description                                                                                     |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [`delegate_to_subagents`](#2-delegate_to_subagents)   | Spawn one or more parallel sub-agents to work on separate tasks concurrently.                   |
| [`get_subagent_output`](#3-get_subagent_output)       | Retrieve the final assistant text output from a completed sub-agent session.                    |
| [`get_subagent_session`](#4-get_subagent_session)     | Retrieve the complete session transcript, including all messages, tool calls, and tool results. |
| [`list_subagent_profiles`](#5-list_subagent_profiles) | List all available named sub-agent profiles and their configurations.                           |

All tools are registered on the pi-coding-agent `ExtensionAPI` via `pi.registerTool()`.

---

## 2. delegate_to_subagents

### Purpose

Spawn one or more parallel sub-agents to work on independent tasks. Each sub-agent runs in an isolated `pi` process with its own context window, tool access, and working directory. Live progress from each sub-agent is displayed in a rolling TUI window.

The tool returns session IDs for each task, which can be used with `get_subagent_output` and `get_subagent_session` to retrieve results after completion.

### Parameters

Defined by `DelegateParams` (TypeBox schema in [`schemas.ts`](../src/schemas.ts)):

| Parameter | Type                | Required | Default | Description                                                                            |
| --------- | ------------------- | -------- | ------- | -------------------------------------------------------------------------------------- |
| `tasks`   | `Array<TaskObject>` | Yes      | —       | Array of 1–16 tasks to execute in parallel. See Task Object below.                     |
| `profile` | `string`            | No       | —       | Default profile name applied to all tasks. Overridden by any per-task `profile` field. |

### Task Object

Each element of the `tasks` array has the following fields:

| Field     | Type              | Required | Default         | Description                                                                                                                                 |
| --------- | ----------------- | -------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`    | `string`          | Yes      | —               | Display name for this sub-agent's TUI window.                                                                                               |
| `prompt`  | `string`          | Yes      | —               | The task/prompt sent to the sub-agent. When `resume` is set, the prior transcript is prepended (see [Resume Mechanics](#resume-mechanics)). |
| `cwd`     | `string`          | No       | `process.cwd()` | Working directory for this sub-agent. Must be an absolute path and must not contain `..` segments.                                          |
| `profile` | `string`          | No       | —               | Named sub-agent profile for this specific task (overrides the top-level `profile`). See [docs/profiles.md](profiles.md).                    |
| `timeout` | `number`          | No       | `600`           | Timeout in seconds. Must be ≥ 1. Aborts the sub-agent when exceeded.                                                                        |
| `resume`  | `string`          | No       | —               | A previous session ID to continue work from. The resumed agent receives the prior session's transcript as context.                          |
| `files`   | `Array<FileSpec>` | No       | —               | File paths to read and prepend to the sub-agent's prompt. See [Files Parameter](#files-parameter).                                          |

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

After profile resolution, a skill validation and resolution pipeline runs:

1. **`validateProfileSkills()`** — Checks each resolved profile for mutually exclusive field combinations (`suggestedSkills` + `noSkills`, or `loadSkills` + `noSkills`). If a conflict is found, the entire tool call throws — no sub-agents are spawned.
2. **`discoverSkills()`** — Called **once** (result cached) if any profile references `suggestedSkills` or `loadSkills`. Scans global and project-local skill directories.
3. **`resolveProfileSkills()`** — Called once per **unique** profile (deduplicated to avoid repeated file reads). Resolves skill names to file paths (`suggestedSkills`) or reads skill content into `appendSystemPrompt` (`loadSkills`). Unknown skill names cause the task to fail with an error, but other tasks continue normally.

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

### Files Parameter

When a task specifies `files`, each file is read from disk and its contents are prepended to the prompt before the sub-agent is spawned. This provides context to the sub-agent without embedding large file contents directly in the prompt string.

Each entry in the `files` array can be:

- **A string** — Just a file path (relative to the task's `cwd` or absolute):

  ```json
  "src/main.ts"
  ```

- **A range object** — Read specific lines (1-indexed, inclusive):

  ```json
  { "path": "src/main.ts", "start": 10, "end": 50 }
  ```

  If `start` is omitted, defaults to line 1. If `end` is omitted, reads to end of file.

- **A head object** — Read the first N lines (minimum: 1):

  ```json
  { "path": "src/main.ts", "head": 20 }
  ```

- **A tail object** — Read the last N lines (minimum: 1):
  ```json
  { "path": "src/main.ts", "tail": 30 }
  ```

Files are resolved relative to the task's `cwd` (or the extension's working directory if not set). The file size limit is **1 MB** per file — larger files produce a placeholder message.

File contents are formatted with a header and prepended before the prompt (and before any resume context):

```
=== src/main.ts ===
import { foo } from "bar";
...

=== README.md ===
# My Project
...

[task prompt here]
```

Missing or unreadable files produce a placeholder instead of failing the entire task:

- `[file not found: path]` — File does not exist
- `[could not read file: path]` — File exists but cannot be read (permissions, encoding)
- `[file too large: path (NKB, limit 1024KB)]` — File exceeds the 1 MB size limit

#### Timeout Behavior

- Each task gets its own `AbortController` and timer based on its `timeout` value (or the 600s default).
- When the timer fires, the task's `AbortController` is triggered, aborting the sub-agent process.
- The abort handler sends `SIGTERM`, escalating to `SIGKILL` after 5 seconds if the process hasn't exited.
- The window and session status are set to `"error"` with the message:
  ```
  Timed out after {N}s. Consider resuming with a longer timeout.
  ```
- If the parent tool call's signal is aborted, all task controllers are also aborted (but this does not produce the "timed out" message).

**Timeout Extension:** When a sub-agent's timeout expires but the agent is still actively working (making tool calls), the timeout is automatically extended rather than immediately killing the process. A two-timer mechanism is used: when the original `timeout` elapses, an idle timer is started instead of aborting. Each tool call resets this idle timer. The sub-agent is only killed when no tool calls have been made for `extend_timeout_debounce` seconds. This setting defaults to **30** and is loaded from the settings file (project-local overrides global). The value is clamped to the range 0–300 seconds. The TUI always displays the original timeout value.

**Loop Detection:** To prevent runaway sub-agents, pi-subagents monitors tool call patterns. Each tool call's name and arguments are serialized as JSON into a signature string. If `looping_tool_count` (default **5**, range 0–50) consecutive tool call signatures are identical strings (exact match), the sub-agent is immediately killed with `SIGTERM` and marked as errored:

```
Loop detected: sub-agent is repeating the same tool calls
```

`looping_tool_count` is configurable via the settings file under `subagents` (project-local overrides global). Set `looping_tool_count` to `0` to disable loop detection entirely.

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

#### Session Persistence

Sessions are persisted to the main agent's session log immediately after each sub-agent completes (or errors). This enables session data to survive agent restarts.

**How it works:**

1. After each task finishes — whether successfully, due to an error (unknown profile, loop detection, timeout), or any other reason — `persistSession()` calls `pi.appendEntry()` with the custom entry type `"pi-subagents"` and the serialized `SubagentSessionData`.
2. Each task is persisted independently. For multiple tasks, `appendEntry` is called once per task.
3. Persistence is **fault-tolerant**: if `appendEntry()` throws, the error is caught and logged as a warning. It does not break delegation or affect other tasks.

**Session reconstruction on restart:**

- When the main agent session restarts or resumes (`session_start` event with `reason !== "new"`), the extension iterates over all custom entries in the session log and reconstructs the in-memory session store via `deserializeSessionData()`.
- Only entries with `customType === "pi-subagents"` are processed. Malformed entries are silently skipped.
- **Stale "running" sessions** — sessions that were still `"running"` when the main agent session ended (e.g., due to a crash) — are automatically converted to `"error"` status with the message:
  ```
  Session was interrupted (main agent session ended unexpectedly)
  ```
  This ensures that `get_subagent_output` and `get_subagent_session` can always return meaningful data for persisted sessions.
- New sessions (`reason === "new"`) skip reconstruction entirely — there is no prior data to load.
- On `session_shutdown`, the in-memory session store is cleared.

### TUI Rendering

The tool provides custom `renderCall` and `renderResult` implementations:

- **`renderCall`**: Displays the tool name, task count, and profile information.

  ```
  delegate_to_subagents 3 sub-agents (default profile: researcher) profiles: [writer, researcher]
  ```

- **`renderResult`**: Shows a live rolling window display with:
  - **Global status header**: `Sub-agents: 2 running, 1 done, 1 error`
  - **Per-agent windows**: Each with a condensed header: `{icon} {bold name} • {profile-name} ({provider}/{model} {thinking-level}) • {n} tools • [{completed}/{total}] • {elapsed}s/{timeout}s`. Tool calls are rendered in muted color. `ls` and `find` calls display condensed summaries instead of raw output:
    - `ls → src/` (call) → `  2 files, 1 dir` (result); empty results show `  (empty)`
    - `find → *.ts in src/` (call) → `  3 matches` (result); empty results show `  0 matches`
    - Truncated results show a `+` suffix (e.g., `  500 files, 3 dirs+`)
      The todo segment `[completed/total]` only appears when todos are active and incomplete. Elapsed time updates live every second and freezes when the subagent completes.
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

**With files — provide context to sub-agents:**

```json
{
  "tasks": [
    {
      "name": "review-api",
      "prompt": "Review the API routes for security issues.",
      "files": ["src/routes.ts", { "path": "src/middleware.ts", "head": 50 }]
    },
    {
      "name": "review-tests",
      "prompt": "Check test coverage for the auth module.",
      "files": [{ "path": "src/auth.ts", "tail": 30 }, "tests/auth.test.ts"]
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

| Parameter   | Type     | Required | Description                                         |
| ----------- | -------- | -------- | --------------------------------------------------- |
| `sessionId` | `string` | Yes      | The session ID returned by `delegate_to_subagents`. |

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

| Parameter   | Type     | Required | Description                                         |
| ----------- | -------- | -------- | --------------------------------------------------- |
| `sessionId` | `string` | Yes      | The session ID returned by `delegate_to_subagents`. |

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

| Condition                                        | Tool(s)                                       | Error Message                                                                                                                            | When                                                                                                                                                 |
| ------------------------------------------------ | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Session not found**                            | `get_subagent_output`, `get_subagent_session` | `Session "{id}" not found. The session may have expired or the ID is incorrect.`                                                         | Session ID not in store or has zero runs.                                                                                                            |
| **Resume session still running**                 | `delegate_to_subagents`                       | `Cannot resume: session "{id}" is still running. Wait for it to complete before resuming.`                                               | `resume` references a session currently in the active set.                                                                                           |
| **Resume session not found**                     | `delegate_to_subagents`                       | `Cannot resume: session "{id}" not found. The session may have expired or the ID is incorrect.`                                          | `resume` references a non-existent session or one with zero runs.                                                                                    |
| **Unknown profile**                              | `delegate_to_subagents`                       | `Unknown profile: "{name}". Available profiles: {list}`                                                                                  | Task specifies a profile name not found in global or project-local directories. Other tasks continue normally.                                       |
| **Sub-agent spawn failure**                      | `delegate_to_subagents` (internal)            | `Failed to spawn sub-agent process`                                                                                                      | The child `pi` process fails to start (e.g., binary not found, permission denied). Caught by the `error` event on `spawn()`.                         |
| **Timeout**                                      | `delegate_to_subagents` (internal)            | `Timed out after {N}s. Consider resuming with a longer timeout.`                                                                         | A task exceeds its `timeout` value (default 600s). The sub-agent is aborted via `SIGTERM` → `SIGKILL`.                                               |
| **Invalid cwd — relative path**                  | `delegate_to_subagents` (internal)            | `cwd must be an absolute path`                                                                                                           | The `cwd` parameter is not an absolute path. Thrown before the sub-agent is spawned.                                                                 |
| **Invalid cwd — path traversal**                 | `delegate_to_subagents` (internal)            | `cwd must not contain '..' path segments`                                                                                                | The resolved `cwd` contains `..` segments. Thrown before the sub-agent is spawned.                                                                   |
| **Unknown skill (suggestedSkills)**              | `delegate_to_subagents`                       | `Unknown skills: "bad-name". Available skills: skill-a, skill-b`                                                                         | Profile specifies a skill name not found by skill discovery. The task is marked as error; other tasks continue normally.                             |
| **Skills + noSkills conflict (suggestedSkills)** | `delegate_to_subagents`                       | `Profile "name" has both "suggestedSkills" and "noSkills" set. These are mutually exclusive — --no-skills would override --skill flags.` | Profile validation throws during `validateProfileSkills()`. The entire tool call fails — no sub-agents are spawned.                                  |
| **Skills + noSkills conflict (loadSkills)**      | `delegate_to_subagents`                       | `Profile "name" has both "loadSkills" and "noSkills" set. These are mutually exclusive — --no-skills disables skill discovery.`          | Profile validation throws during `validateProfileSkills()`. The entire tool call fails — no sub-agents are spawned.                                  |
| **Loop detected**                                | `delegate_to_subagents` (internal)            | `Loop detected: sub-agent is repeating the same tool calls`                                                                              | `looping_tool_count` consecutive tool call signatures (serialized as JSON) were identical. The sub-agent is killed via `SIGTERM`.                    |
| **File not found**                               | `delegate_to_subagents` (files)               | `[file not found: {path}]`                                                                                                               | A file specified in `files` does not exist. The task continues with a placeholder in the prompt.                                                     |
| **File unreadable**                              | `delegate_to_subagents` (files)               | `[could not read file: {path}]`                                                                                                          | A file exists but cannot be read (permissions, encoding). The task continues with a placeholder.                                                     |
| **File too large**                               | `delegate_to_subagents` (files)               | `[file too large: {path} ({size}KB, limit 1024KB)]`                                                                                      | A file exceeds the 1 MB size limit. The task continues with a placeholder.                                                                           |
| **Tool restriction override guard**              | `delegate_to_subagents`                       | `Refusing extraArg "${arg}" which would override profile tool restrictions. Use the dedicated profile fields instead.`                   | Thrown when `extraArgs` contains `--tools`, `-t`, `--no-tools`, or `-nt` (including their `=` forms) while the profile has tool restrictions active. |

---

## Cross-References

- **Profile configuration**: See [docs/profiles.md](profiles.md) for profile file format, frontmatter schema, and profile resolution order.
- **Architecture**: See [docs/architecture.md](architecture.md) for session lifecycle, process management, and TUI rendering internals.
