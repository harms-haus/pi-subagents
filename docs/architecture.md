# Architecture Reference

Deep-dive architecture document for the pi-subagents extension. This covers internal modules, data flows, concurrency model, and lifecycle management.

## 1. Overview

pi-subagents is a pi-coding-agent extension that enables the main agent to spawn multiple isolated sub-agent processes in parallel. Each sub-agent runs its own `pi` subprocess with an independent context window, provider/model configuration, and tool access. Live output from each sub-agent is rendered in a rolling TUI window inline with the main agent's conversation. The extension provides four tools — `delegate_to_subagents`, `get_subagent_output`, `get_subagent_session`, and `list_subagent_profiles` — plus a `/profile` slash command for interactive profile management. Session data is maintained in an in-memory store with LRU eviction, **and is also persisted to the main agent's session tree** via custom entries written through `pi.appendEntry()`. On session load (startup, resume, reload, or fork), the `session_start` handler reconstructs the in-memory store from these persisted entries. All sub-agent communication flows through JSONL-parsed stdout from the spawned processes.

## 2. Module Map

| File                                  | Responsibility                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                        | Extension entry point; creates `sessionStore` (Map), registers tools/commands, handles `session_start` (reconstructs in-memory store from persisted custom entries) and `session_shutdown` lifecycle events                                                                                                                                                                                     |
| `src/types.ts`                        | Core type definitions (`SubAgentTask`, `SubAgentWindow`, `SubagentSessionData`, `SessionRecord`), configuration constants (`MAX_PARALLEL_TASKS`, `MAX_CONCURRENCY`, etc.), `syncState()` helper, session persistence helpers (`CUSTOM_ENTRY_TYPE`, `serializeSessionData()`, `deserializeSessionData()`). Re-exports `formatRunsForResume()` and `getTextContent()` from `format-transcript.ts` |
| `src/constants.ts`                    | Shared `getAgentDir()` function for resolving the agent directory (`process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent")`). Leaf module with no project imports                                                                                                                                                                                                                         |
| `src/spawner.ts`                      | Process spawning, JSONL parsing, abort handling. `runSubAgent()` spawns `pi` subprocess, buffers stdout/stderr, parses JSON events, updates rolling window. Uses `path.isAbsolute()` for cross-platform cwd validation and `tree-kill` npm package for cross-platform process tree termination (uses `taskkill` on Windows). Also processes `turn_end` events to capture ls/find tool result summaries. Also contains `getPiInvocation()` |
| `src/format-tool-call.ts`             | Re-exports from `format-path.ts` and `format-bash.ts`. Contains `formatToolCall()` (one-line tool previews), `formatToolResult()`, `formatToolResultInline()`, `getToolEmoji()`, `countNonEmptyLines()`, `countOutputEntries()`, `countDirsInOutput()`, and all tool-specific format call helpers                                                                                               |
| `src/format-path.ts`                  | Path shortening utilities: `shortenPath()`, `shortenPathsInText()`, `ABSOLUTE_PATH_PATTERN` regex string. Cross-platform: handles both Unix and Windows absolute paths                                                                                                                                                                                                                          |
| `src/format-bash.ts`                  | Bash command display formatting: `collapseCdDot()`, `formatBashCommand()`, `formatBashSegments()`, `flushTruncatedSegment()`, `getCdPattern()`, `BASH_PREFIX_WIDTH`, `BASH_CONT_PREFIX_WIDTH` constants. Handles both `&&` and `;` separators                                                                                                                                                    |
| `src/settings.ts`                     | `loadMaxLinesPerWindow()`, `loadCommandPreviewWidth()`, settings file reading (global + project-local). Uses `getAgentDir()` from `constants.ts` instead of inline path resolution                                                                                                                                                                                                             |
| `src/format-transcript.ts`            | `formatRunsForResume()` (resume transcript formatting), `getTextContent()` (message text extraction)                                                                                                                                                                                                                                                                                            |
| `src/profile-types.ts`                | `SubagentProfile`, `SubagentProfiles`, `ThinkingLevel`, `ProfileInvocation` type definitions                                                                                                                                                                                                                                                                                                    |
| `src/profile-formatting.ts`           | `profileSummary()`, `formatProfileDetail()`, `serializeProfileToMarkdown()`                                                                                                                                                                                                                                                                                                                     |
| `src/profiles.ts`                     | Profile loading from `.md` files, YAML frontmatter parsing, 5s TTL cache, `profileToArgs()` CLI conversion, profile CRUD, tool validation (`validateProfileTools`, `applyExcludeTools`), skill validation (`validateProfileSkills`) and resolution (`resolveProfileSkills`). Shell injection regex also catches Windows cmd.exe metacharacters (`^`, `%`, `\r`). `getProfilesDir()` is module-private (not exported). Re-exports from `profile-formatting.ts` and `profile-types.ts` |
| `src/profile-editor.ts`               | Interactive profile creation/editing via `/profile` command                                                                                                                                                                                                                                                                                                                                     |
| `src/commands/profile.ts`             | `/profile` slash command (list, show, create, edit, delete)                                                                                                                                                                                                                                                                                                                                     |
| `src/schemas.ts`                      | TypeBox schemas for `delegate_to_subagents` parameter validation                                                                                                                                                                                                                                                                                                                                |
| `src/tools/delegate.ts`               | `delegate_to_subagents` tool registration (~360 lines). Keeps `executeDelegate()`, `createTaskWindow()`, `createTaskWindows()`, `createTaskSession()`, `buildSummaryLines()`, `persistSession()`, `registerDelegateTool()`. Imports from delegate-runner, delegate-profiles, delegate-file-reader, delegate-types. Delegates TUI rendering to `delegate-render.ts`                              |
| `src/tools/delegate-types.ts`         | Shared type definitions for the delegate module family: `StaticDelegateParams`, `ResolvedProfileEntry`, `ProfileResolutionResult`, `TaskRunContext`                                                                                                                                                                                                                                              |
| `src/tools/delegate-file-reader.ts`   | File reading utilities: `readFileContents()`, `sliceLines()`, `MAX_FILE_BYTES` constant. Security: path containment check to prevent reading outside project directory                                                                                                                                                                                                                           |
| `src/tools/delegate-profiles.ts`      | Profile resolution logic: `resolveTaskProfiles()`, `applyToolExcludeLists()`, `discoverSkillsIfNeeded()`, `preResolveProfileSkills()`. Imports from delegate-types.ts, profiles.ts, constants.ts                                                                                                                                                                                                |
| `src/tools/delegate-runner.ts`        | Task execution: `runSingleTask()`, `buildEffectivePrompt()`, `setupIdleTimeout()`, `handlePostRunResult()`, `markTaskError()`. Imports from delegate-types.ts, delegate-file-reader.ts, spawner.ts, profile-types.ts, types.ts, utils.ts                                                                                                                                                          |
| `src/tools/delegate-render.ts`        | `colorizeToolLine()`, `renderDelegateCall()`, `renderDelegateResult()` — pure rendering functions for the delegate tool TUI display                                                                                                                                                                                                                                                             |
| `src/tools/retrieval.ts`              | `get_subagent_output`, `get_subagent_session`, `list_subagent_profiles` tool registrations with truncating renderers                                                                                                                                                                                                                                                                            |
| `src/utils.ts`                        | Shared helpers: ANSI stripping (`stripAnsi`), `appendLineToWindow()`, `getTextParts()`, `getLastAssistantText()`, `mapWithConcurrencyLimit()`, `countWindowStatuses()`, `getSummaryText()`                                                                                                                                                                                                      |
| `src/cache.ts`                        | Generic `TtlCache<T>` class for TTL-based caching. Used by profiles.ts and skill-discovery.ts                                                                                                                                                                                                                                                                                                  |
| `src/skill-discovery.ts`              | Package skill path resolution via `resolvePackageSkillPaths()`, with 5-second TTL cache. Imports from cache.ts and constants.ts                                                                                                                                                                                                                                                                 |

### Dependency Graph

```
index.ts
├── constants.ts (leaf — Node.js builtins only)
├── profiles.ts
│   ├── constants.ts
│   ├── profile-formatting.ts
│   │   └── profile-types.ts
│   └── profile-types.ts
├── commands/profile.ts
│   ├── profiles.ts
│   └── profile-editor.ts
│       └── profiles.ts
├── tools/delegate.ts
│   ├── tools/delegate-types.ts
│   ├── tools/delegate-runner.ts
│   │   ├── tools/delegate-types.ts
│   │   ├── tools/delegate-file-reader.ts
│   │   ├── spawner.ts
│   │   │   ├── format-tool-call.ts
│   │   │   │   ├── format-path.ts
│   │   │   │   └── format-bash.ts
│   │   │   │       └── format-path.ts
│   │   │   ├── profiles.ts
│   │   │   ├── settings.ts
│   │   │   │   └── constants.ts
│   │   │   ├── types.ts
│   │   │   └── utils.ts
│   │   │       └── types.ts
│   │   ├── profile-types.ts
│   │   ├── types.ts
│   │   └── utils.ts
│   ├── tools/delegate-render.ts
│   │   ├── types.ts
│   │   └── utils.ts
│   │       └── types.ts
│   ├── profiles.ts
│   ├── schemas.ts
│   │   └── types.ts
│   ├── settings.ts
│   │   └── constants.ts
│   ├── types.ts
│   └── utils.ts
│       └── types.ts
└── tools/retrieval.ts
    └── profiles.ts
```

## 3. Session Lifecycle

### 3.1 Session Store

The session store is an in-memory `Map<string, SessionRecord>` held in `index.ts`, shared across all tool registrations.

```ts
const sessionStore = new Map<string, SessionRecord>();
const MAX_STORED_SESSIONS = 32;
const MAX_RUNS_PER_SESSION = 10;
```

Each `SessionRecord` maps a session ID to an array of `SubagentSessionData` runs:

```ts
interface SessionRecord {
  runs: SubagentSessionData[]; // chronological, max 10
}
```

**Capacity management:**

- **Max sessions:** When `sessionStore.size >= 32`, the oldest session (determined by `runs[0].startedAt`) is evicted (LRU by start time).
- **Max runs per session:** When a session is resumed, the new run is appended to `record.runs`. If the array exceeds 10 entries, the oldest run is shifted off (`shift()`).

**Persistence:** After each sub-agent completes (or errors), `persistSession()` writes the session data to the main agent's session tree via `pi.appendEntry(CUSTOM_ENTRY_TYPE, serializeSessionData(session))`. This ensures session data survives across session reloads, resumes, and forks.

**Reconstruction:** On `session_start` (for any reason other than `"new"`), the handler iterates the session's custom entries, deserializes any with `customType === CUSTOM_ENTRY_TYPE` via `deserializeSessionData()`, and calls `registerSession()` to rebuild the in-memory store. Stale `"running"` sessions (from crashes) are automatically converted to `"error"` status during deserialization.

**Cleanup:** The store is cleared entirely on the `session_shutdown` event:

```ts
pi.on("session_shutdown", () => {
  sessionStore.clear();
});
```

### 3.2 Full Lifecycle Sequence

```
1. LLM calls delegate_to_subagents({ tasks: [...] })
2. delegate.ts validates resume parameters (if any)
3. Profile resolution: loadProfiles(cwd) → resolveProfile() per task
3a. `excludeTools` resolution: validateProfileTools() + applyExcludeTools() per profile with excludeTools
3b. Skill resolution: validateProfileSkills() → discoverSkills() (once, cached) → resolveProfileSkills() per unique profile
4. Windows created: one SubAgentWindow per task (TUI state)
5. Session data created: one SubagentSessionData per task (persistent store)
6. registerSession() → store in sessionStore (with LRU eviction)
7. mapWithConcurrencyLimit(tasks, 4) → per-task execution:
   a. Per-task AbortController with timeout (default 600s)
   b. Parent abort signal forwarded to task controller
   c. runSubAgent() spawns pi subprocess
   d. stdout lines parsed as JSONL, appended to rolling window; `turn_end` events processed to capture ls/find tool result summaries
   e. Process exit → status set to "completed" or "error"
   f. persistSession() → serialize and write to main agent's session tree via pi.appendEntry()
8. Summary result returned with session IDs
9. LLM retrieves output via get_subagent_output(sessionId)
   or get_subagent_session(sessionId)

**On session load** (`session_start` with reason ≠ `"new"`):
- Custom entries with `customType === "pi-subagents"` are deserialized via `deserializeSessionData()`
- Validated entries are registered into the in-memory session store
- Stale `"running"` entries (from crashes) are converted to `"error"` status
```

### 3.3 Resume Flow

When a task specifies a `resume` session ID:

1. The resume session must exist in the store and **not** be actively running.
2. `formatRunsForResume(record.runs)` produces a human-readable transcript of all previous runs, including user messages, assistant text, tool calls (truncated args to 120 chars), tool results (truncated to 500 chars), and error messages.
3. The transcript is prepended to the new task's prompt:

```ts
effectivePrompt = `Previously:\n\n${previousData}\n\nInstructions:\n\n${task.prompt}`;
```

4. The resumed session reuses the **same** session ID (from `task.resume`), so subsequent runs are appended to the same `SessionRecord`.
5. `get_subagent_output` returns only the **latest** run's text; `get_subagent_session` returns **all** runs concatenated with separators.

## 4. Spawner Internals

`runSubAgent()` in `src/spawner.ts` is the core process-spawning function.

### 4.1 pi Invocation

The subprocess is spawned using Node.js `child_process.spawn()`:

```ts
const proc = spawn(invocation.command, args, {
  cwd: resolvedCwd,
  shell: false,
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, ...profileEnv },
});
```

**Command resolution** (`getPiInvocation()` in `spawner.ts`):

- If running as a script (`process.argv[1]` exists and isn't in `$bunfs`), uses `process.execPath` + script path.
- Otherwise falls back to `pi` with no args.

**Args structure:**

```
[base args...] --mode json -p --no-session [profile args...] [task prompt]
```

- `--mode json` — forces JSON output from the pi subprocess.
- `-p` — enables profile mode (reads prompts from argument).
- `--no-session` — runs without interactive session persistence.
- Profile args (from `profileToArgs()`) are injected **before** the prompt, so they take effect as CLI flags.

### 4.2 stdout Line Buffering & JSONL Parsing

stdout data arrives in arbitrary Buffer chunks. The spawner implements line-buffered parsing:

```ts
proc.stdout.on("data", (data: Buffer) => {
  buffer += data.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? ""; // incomplete line held for next chunk
  for (const line of lines) {
    processLine(line);
  }
});
```

Each complete line is processed by `handleStdoutLine()`:

1. **Empty lines** — skipped.
2. **Non-JSON lines** — appended to the rolling window as plain text.
3. **JSON lines** — parsed. Two event types are processed:
   - **`turn_end` events** — `toolResults` array is inspected for `ls`/`find` tool results; summaries are generated via `formatToolResult()` and appended as `"tool"`-kind lines.
   - **`message_end` events** (with a `message` field) — Message is pushed to `session.messages` (capped at `MAX_MESSAGES_PER_SESSION = 500`).
   - Text parts extracted via `getTextParts()` → appended to rolling window.
   - Tool call parts formatted via `formatToolCall()` → appended as `"tool"`-kind lines.
   - Model metadata (`model`, `stopReason`, `errorMessage`) synced to window and session via `syncState()`.

### 4.3 stderr Handling

stderr data is captured and prefixed with `[stderr]:`, then appended to the rolling window. Unlike stdout, stderr is not parsed as JSON — it's treated as raw text.

### 4.4 Process Exit & Status Determination

On `close` event, `handleProcessExit()` determines final status:

```ts
const isError = code !== 0 || win.stopReason === "error" || win.stopReason === "aborted";
const status = isError ? "error" : "completed";
```

Any remaining buffered content is flushed before status is set. Spawn errors (e.g., binary not found) set status to `"error"` immediately with message `"Failed to spawn sub-agent process"`.

## 5. Abort & Timeout Handling

### 5.1 Per-Task AbortController

Each task gets its own `AbortController`:

```ts
const taskAbortController = new AbortController();
const taskAbortTimeout = setTimeout(() => {
  taskAbortController.abort();
}, taskTimeout * 1000); // taskTimeout defaults to 600s
```

### 5.2 Parent Signal Forwarding

The parent's `signal` (from the LLM tool execution context) is forwarded:

```ts
const onParentAbort = () => taskAbortController.abort();
if (signal?.aborted) {
  taskAbortController.abort();
} else if (signal) {
  signal.addEventListener("abort", onParentAbort, { once: true });
});
```

The listener is removed in the `finally` block to prevent leaks.

### 5.3 SIGTERM → SIGKILL Escalation

In `setupAbortHandler()`, when the task's abort signal fires, the process tree is terminated via the `tree-kill` npm package for cross-platform support (uses `taskkill` on Windows):

```ts
import kill from "tree-kill";

const killProc = () => {
  kill(proc.pid!, "SIGTERM", (err) => {
    if (err) {
      setTimeout(() => kill(proc.pid!, "SIGKILL"), 5000); // 5-second grace period
    }
  });
};
```

If the process was already aborted when the handler is installed (parent cancelled before spawn), `killProc()` is invoked immediately.

### 5.4 Timeout vs. Parent Abort Distinction

After `runSubAgent()` completes, the delegate tool checks whether the abort was caused by the task's own timeout (not the parent signal):

```ts
if (taskAbortController.signal.aborted && !signal?.aborted) {
  win.status = "error";
  win.errorMessage = `Timed out after ${taskTimeout}s. Consider resuming with a longer timeout.`;
}
```

This allows a clean timeout error message rather than treating it as a generic abort.

## 6. Rolling Buffer & TUI Updates

### 6.1 Dual Buffers in `appendLineToWindow()`

Each `SubAgentWindow` maintains two buffers:

| Buffer            | Purpose                                                  | Limit                            |
| ----------------- | -------------------------------------------------------- | -------------------------------- |
| `win.lines`       | Rolling window shown in **collapsed** TUI view           | `maxLines` (default 15)          |
| `win.allMessages` | Full message history shown in **expanded** view (Ctrl+O) | `MAX_MESSAGES_PER_SESSION` (500) |

```ts
export function appendLineToWindow(win, line, maxLines, kind = "text") {
  const clean = stripAnsi(line).trimEnd();
  if (!clean) return;
  const entry = { text: clean, kind };

  // Rolling window (latest N lines)
  win.lines.push(entry);
  while (win.lines.length > maxLines) win.lines.shift();

  // Full history (capped at 500)
  win.allMessages.push(entry);
  while (win.allMessages.length > MAX_MESSAGES_PER_SESSION) win.allMessages.shift();
}
```

Lines are ANSI-stripped before storage. Each `WindowLine` carries a `kind` (`"text"` or `"tool"`) that affects TUI rendering — tool lines are colorized by `colorizeToolLine()` in `delegate-render.ts`: diff additions in `toolDiffAdded` (green), removals in `toolDiffRemoved` (red), line counts in `toolDiffAdded`, ls/find result summary counts in `toolDiffAdded` (green), and all other text in `muted`.

### 6.2 Debounced TUI Updates

Updates to the TUI are debounced at 50ms to avoid excessive rendering pressure during high-throughput stdout:

```ts
const debouncedUpdate = () => {
  if (bufferTimeout) clearTimeout(bufferTimeout);
  bufferTimeout = setTimeout(() => onUpdate(), 50);
};
```

The final `onUpdate()` in `handleProcessExit()` is **not** debounced — it fires immediately to ensure the final status is visible.

### 6.3 `renderResult`: Collapsed vs. Expanded View

The `renderResult` method in `delegate.ts` renders the TUI output:

- **Collapsed** (default): Shows `win.lines` (latest N lines). If empty, displays `"(starting...)"`.
- **Expanded** (Ctrl+O): Shows `win.allMessages` (up to 500 entries). If empty, displays `"(no output)"`.

Each window header includes the agent name, profile info (if any), and a status icon (⏳ / ✗ / ✓). Error messages are shown in red below the window. When all agents complete, a footer lists session IDs for retrieval.

### 6.4 `formatToolCall()` One-Line Previews

Tool calls in the rolling window are rendered as concise one-liners by `formatToolCall()` in `format-tool-call.ts`. Each line is prefixed with a per-tool emoji via `getToolEmoji()` (also in `format-tool-call.ts`) — the `TOOL_EMOJI` map assigns one of 25 tool names a purpose-specific emoji, and unknown tools receive the 🔧 fallback. Tools that share a purpose share the same emoji (e.g., `grep`, `find`, and `web_search` all use 🔍). The final display in the rolling window is `emoji + " " + formatToolCall() output` (see `spawner.ts`). The table below describes the `formatToolCall()` portion only — the internal format without the emoji prefix.

Key patterns:

| Tool                         | Format                                                                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `edit`                       | `edit → path (N edits) +A/-R`                                                                                          |
| `write`                      | `write → path +L`                                                                                                      |
| `grep`                       | `grep → /pattern/ → glob-or-path`                                                                                      |
| `ls`                         | `ls → <path>` (defaults to `.` when no path)                                                                           |
| `find`                       | `find → <pattern> in <path>` or `find → <pattern>` (no path)                                                           |
| `bash`                       | `bash → first line of command (smart && splitting)`                                                                    |
| `read`                       | `read → path:offset+limit (L lines)`                                                                                   |
| `delegate_to_subagents`      | `delegate_to_subagents → N tasks [profile names]`                                                                      |
| LSP tools                    | `lsp_diagnostics → file`                                                                                               |
| `fetch_content`/`web_search` | `fetch_content → url (truncated)`                                                                                      |
| Generic                      | `toolName {"key":"value",...}` (full JSON args, truncated to width budget; empty `{}` omitted)                         |
| `write_todos`                | `write_todos → N todos written`                                                                                        |
| `edit_todos`                 | `edit_todos → description or action [indices]`                                                                         |
| `list_todos`                 | `list_todos`                                                                                                           |
| LSP tools (5)                | `lsp_name → file:line:column` (varies; `lsp_find_symbol` → `query`; `lsp_refactor_symbol` → `file:line:col → newName`) |
| `lint_files`                 | `lint → files... +N more` or `lint → (all)`                                                                            |
| `fetch_repo`                 | `fetch_repo → url`                                                                                                     |
| Session retrieval (3)        | `tool_name → sessionId` or just tool name                                                                              |
| `workflow_step`              | `workflow_step → action`                                                                                               |

Where A=lines added, R=lines removed, L=line count. The `(L lines)` suffix only appears when `limit` is specified. Diff stats are computed using `countNonEmptyLines()`, which counts non-blank lines without allocating intermediate arrays.

Diff stats (`+A/-R`), line counts (`(L lines)`), and numeric counts in ls/find result summary lines are colorized in the TUI using `colorizeToolLine()`: additions use `toolDiffAdded` (green), removals use `toolDiffRemoved` (red), and line counts use `toolDiffAdded` (green).

Paths are shortened via `shortenPath()` in `format-path.ts` (replaces home prefix with `~`, uses relative paths when shorter; cross-platform for both Unix and Windows absolute paths). Bash commands are collapsed (stripping redundant `cd <cwd>` prefixes) and formatted with `formatBashCommand()` in `format-bash.ts` (smart `&&` and `;` splitting with `│` continuation prefixes). Both are re-exported through `format-tool-call.ts`.

## 7. Concurrency Model

### 7.1 `mapWithConcurrencyLimit()` Worker-Pool Pattern

```ts
export async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]>;
```

Implementation uses a shared `nextIndex` counter accessed by `concurrency` worker coroutines:

```ts
let nextIndex = 0;
const workers = new Array(limit).fill(null).map(async () => {
  while (true) {
    const current = nextIndex++; // atomic-ish: JS single-threaded
    if (current >= items.length) return;
    results[current] = await fn(items[current], current);
  }
});
await Promise.all(workers);
```

This is a work-stealing pattern — as each worker completes its task, it immediately grabs the next available index. Results are stored at their original indices, preserving order.

### 7.2 Concurrency Constants

| Constant             | Value | Meaning                                                                             |
| -------------------- | ----- | ----------------------------------------------------------------------------------- |
| `MAX_CONCURRENCY`    | 4     | Active sub-agent processes at once                                                  |
| `MAX_PARALLEL_TASKS` | 16    | Maximum tasks in a single `delegate_to_subagents` call (enforced by TypeBox schema) |

When a delegation call has 16 tasks with concurrency 4, the first 4 spawn immediately, and the remaining 12 queue — each starts as a slot opens.

## 8. Profile System

See [docs/profiles.md](profiles.md) for the full profile documentation. This section covers the internal architecture.

### 8.1 Profile Loading

Profiles are loaded from two directories:

| Scope   | Path                                                                |
| ------- | ------------------------------------------------------------------- |
| Global  | `~/.pi/agent/agent-profiles/*.md` (configurable via `PI_AGENT_DIR`) |
| Project | `<cwd>/.pi/agent-profiles/*.md`                                     |

Project-local profiles **override** global profiles with the same name. Loading is synchronous via `readFileSync` — each `.md` file is parsed with `parseFrontmatter()`:

```ts
// Frontmatter keys → SubagentProfile fields
name, provider, model, thinkingLevel, appendSystemPrompt, apiKey,
noTools, noExtensions, noSkills, noContextFiles,
tools (string or comma-separated), excludeTools (comma-separated), extensions, extraArgs,
suggestedSkills (comma-separated), loadSkills (comma-separated)

// Body (after frontmatter) → systemPrompt
```

### 8.2 5-Second TTL Cache

```ts
let profilesCache: {
  cwd: string | undefined;
  profiles: SubagentProfiles;
  timestamp: number;
} | null = null;
const CACHE_TTL = 5000;
```

The cache key includes the `cwd` — different working directories get separate cache entries. Cache is invalidated by `saveProfile()`, `deleteProfile()`, and `invalidateProfilesCache()`.

### 8.3 `excludeTools` Resolution (in `delegate-profiles.ts`)

Before `profileToArgs()` is called, profiles with `excludeTools` are resolved to concrete tool allowlists via `applyToolExcludeLists()` in `delegate-profiles.ts`, called from the delegate tool's execute handler:

1. For each task whose profile has `excludeTools` set, `pi.getAllTools()` is called once to obtain the full list of available tool names.
2. `validateProfileTools(profile, name)` throws if both `tools` (allowlist) and `excludeTools` (blacklist) are set — they are mutually exclusive.
3. `applyExcludeTools(profile, allToolNames)` computes the allowlist:
   ```ts
   const excludeSet = new Set(profile.excludeTools);
   const computedTools = allToolNames.filter((name) => !excludeSet.has(name));
   return { ...profile, tools: computedTools, excludeTools: undefined };
   ```
4. The resolved profile (now with `tools` populated and `excludeTools` cleared) replaces the original in the `resolvedProfiles` array.
5. This resolved profile flows through `profileToArgs()` as a normal `--tools <computed-list>` argument.

If no profile has `excludeTools` set, `pi.getAllTools()` is never called.

### 8.4 Skill Resolution (in `delegate-profiles.ts`)

Before `profileToArgs()` is called, profiles with `suggestedSkills` or `loadSkills` are resolved in a multi-step pipeline via `discoverSkillsIfNeeded()` and `preResolveProfileSkills()` in `delegate-profiles.ts`, called from the delegate tool's execute handler:

1. **Mutual-exclusivity validation** — `validateProfileSkills(profile, name)` throws if `suggestedSkills` or `loadSkills` is combined with `noSkills`. These are mutually exclusive because `--no-skills` would either override `--skill` flags or disable skill content that was injected into the system prompt.

2. **Discovery (once per delegation)** — If any profile references skills, `discoverSkills()` is called exactly once with `{ cwd, agentDir, skillPaths: [], includeDefaults: true }`. The result is cached in a `Map<string, SkillMeta>` keyed by skill name. If no profile uses skills, discovery is skipped entirely.

3. **Per-profile resolution** — `resolveProfileSkills(profile, cwd, skillMap)` is called once per **unique** profile object (deduplicated via `skillResolvedProfiles` Map). Two resolution paths:
   - **`suggestedSkills`** — skill names are mapped to their file paths. The resolved `suggestedSkills` array contains file paths (not names), which `profileToArgs()` converts to `--skill <path>` CLI flags. Unknown skill names throw an error listing available skills.
   - **`loadSkills`** — skill names are mapped to their SKILL.md body content (frontmatter stripped via `stripFrontmatter()`). Each skill is wrapped in `<loaded_skill name="...">...</loaded_skill>` tags and appended to `appendSystemPrompt`. After resolution, `loadSkills` is set to `undefined` on the profile (it has been fully consumed).

4. **Deduplication via `skillResolvedProfiles` Map** — A `Map<SubagentProfile, { ok, profile } | { ok, error }>` ensures each unique profile object is resolved at most once. Multiple tasks sharing the same profile reuse the cached result.

5. **Error handling** — If `resolveProfileSkills()` throws (e.g., unknown skill name), the error is stored in `skillResolvedProfiles` as `{ ok: false, error }`. When the offending task is processed inside `mapWithConcurrencyLimit`, it is marked as `"error"` with the skill resolution error message — but **other tasks are unaffected** and continue normally.

### 8.5 `profileToArgs()` Conversion

Converts a `SubagentProfile` to CLI arguments and environment variables:

```ts
interface ProfileInvocation {
  args: string[]; // CLI flags appended before the prompt
  env: Record<string, string>; // merged into process.env
}
```

**Security note:** API keys are passed via `PI_API_KEY` environment variable, **not** as CLI arguments (which would be visible in `/proc/PID/cmdline`).

**Safety validation for `extraArgs`:**

- Null bytes (`\0`) are rejected.
- Characters at the start of an arg: whitespace, `|`, `&`, `;`, `$`, `\`, `` ` ``, `!`
- Command separators anywhere in the arg: `&&`, `||`, `;`, `>`, `>>`, `<`, `<<`

**`suggestedSkills` → `--skill` flags:** After `resolveProfileSkills()` runs, `suggestedSkills` contains resolved file paths (not skill names). `profileToArgs()` emits one `--skill <path>` per entry. `loadSkills` is never encountered here — it was already consumed by `resolveProfileSkills()` and merged into `appendSystemPrompt` during the skill resolution pipeline (§8.4).

**Tool-override blocking:** When any tool restriction is active on the profile (`noTools`, `tools`, or `excludeTools`), `extraArgs` containing tool-override flags are rejected. The blocked flags are:

| Flag         | Variants                         |
| ------------ | -------------------------------- |
| `--tools`    | `--tools`, `--tools=value`       |
| `-t`         | `-t`, `-t=value`                 |
| `--no-tools` | `--no-tools`, `--no-tools=value` |
| `-nt`        | `-nt`, `-nt=value`               |

This prevents `extraArgs` from bypassing the profile's intended tool restrictions via equals-sign forms or short flags.

### 8.6 Settings Files

Two settings locations are checked (project overrides global):

| Scope   | Path                        |
| ------- | --------------------------- |
| Global  | `~/.pi/agent/settings.json` |
| Project | `<cwd>/.pi/settings.json`   |

Settings are read from the `subagents` key:

```json
{
  "subagents": {
    "maxLinesPerWindow": 20,
    "commandPreviewWidth": 120
  }
}
```

Both values default gracefully if missing: `maxLinesPerWindow` defaults to `15`, `commandPreviewWidth` falls back to TTY terminal width minus 4 (or `160` in non-TTY environments), clamped to a minimum of `20`.

## 9. Settings

### 9.1 `maxLinesPerWindow`

Controls the number of lines shown in each sub-agent's collapsed rolling window.

- **Type:** `number`
- **Default:** `15`
- **Resolution:** Global settings → project settings → default

### 9.2 `commandPreviewWidth`

Controls the character budget for bash command previews in tool call lines.

- **Type:** `number`
- **Default:** Terminal width minus 4 (if TTY), otherwise `160`
- **Minimum:** `20` (clamped)
- **Resolution:** Two independent paths:
  - In TTY mode: terminal width − 4 (min 20); settings are **not consulted**
  - In non-TTY mode: global settings → project settings → default `160` (min 20)

### 9.3 Settings File Locations

```
~/.pi/agent/settings.json     ← global settings
<cwd>/.pi/settings.json       ← project-local settings
```

Project-local values override global values. The `SubagentSettings` interface supports additional arbitrary keys (extensible via `[key: string]: unknown`).
