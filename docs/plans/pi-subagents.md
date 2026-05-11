# Research & Implementation Plan: pi-subagents Plugin

## 1. Research Findings

### 1.1 Extension Architecture
Pi extensions are TypeScript modules exporting a default factory function receiving `ExtensionAPI`. They can:

- **Register custom tools** via `pi.registerTool()` — the LLM sees them as callable tools. Each tool can define `renderCall` and `renderResult` for custom TUI display.
- **Register custom message renderers** via `pi.registerMessageRenderer()` — controls how entries of a `customType` appear inline in the message history.
- **Use `onUpdate` in tool `execute`** — stream partial results mid-execution so the TUI re-renders live.
- **Listen to lifecycle events** via `pi.on("tool_execution_start", ...)` etc.
- **Spawn child processes** via `node:child_process` — the existing [`subagent` example](https://github.com/earendil-works/pi-mono/tree/main/packages/pi-coding-agent/examples/extensions/subagent) spawns `pi --mode json -p --no-session` and captures structured JSON events from stdout.
- **Render custom TUI components** via `renderResult` returning components from `@earendil-works/pi-tui` (e.g., `Text`, `Container`, `Box`, `Spacer`).
- **Place widgets above/below the editor** via `ctx.ui.setWidget()`.
- **Emit custom messages into the session** via `pi.sendMessage()`.

### 1.2 TUI Rendering Patterns
Key components available from `@earendil-works/pi-tui`:

- `Text` — multi-line text with word wrapping.
- `Container` — vertical group of child components.
- `Box` — container with padding and background color.
- `Spacer` — empty vertical space.
- `Markdown` — renders markdown with syntax highlighting.

Key rules:
- `render(width)` returns `string[]` where each string ≤ `width`.
- Must implement `invalidate()` for theme changes.
- Partial results are supported via `renderResult(result, { isPartial, expanded }, theme, context)`.

### 1.3 Existing Subagent Example
The existing `subagent` example (at `examples/extensions/subagent/`) already provides a working subagent system with:

- **Process spawning**: Spawns `pi` in `json` mode via `node:child_process.spawn()`.
- **Event streaming**: Parses JSONL events from stdout (`message_end`, `tool_result_end`) to build `Message[]` arrays per sub-agent.
- **Parallel execution**: `mapWithConcurrencyLimit()` runs up to `MAX_CONCURRENCY=4` tasks in parallel.
- **Live updates**: Calls `onUpdate()` with partial results as sub-agents stream output.
- **Custom rendering**: `renderResult` shows final output when collapsed and expanded views when the user toggles with `Ctrl+O`.

**What it does NOT do that our plugin needs:**
- It does not render a live "window" of the latest N lines from each running sub-agent inline in the history.
- Its `renderResult` only shows the final `messages` array, not a rolling live feed.
- It does collapse to a limited line count (`COLLAPSED_ITEM_COUNT = 10`), but this is for the *final* collapsed view, not a live-updating window.

### 1.4 Hooks & Streaming Updates
During tool execution:
1. `tool_execution_start` fires when the tool is invoked.
2. The tool's `execute()` runs. Inside it, `onUpdate(partialResult)` can be called to update the partial state.
3. Pi re-renders the tool result via `renderResult(..., { isPartial: true }, ...)`.
4. `tool_execution_update` fires after each partial update.
5. `tool_execution_end` fires when the tool finishes.

This means we can stream live sub-agent output by calling `onUpdate()` inside the `execute()` function as new lines arrive from the spawned process.

---

## 2. Goal

Build a pi extension (`pi-subagents`) that:

1. Exposes a custom tool (e.g., `delegate_to_subagents`) the LLM can invoke.
2. Spawns one or more sub-agent `pi` processes in parallel.
3. Displays a live-updating TUI "window" in the **main agent's conversation history** for each running sub-agent.
4. Each window shows the latest N lines (default 10, configurable) of that sub-agent's output.
5. Windows update in real-time as the sub-agents stream output.
6. Multiple sub-agents running in parallel each get their own window, stacked vertically.
7. The window remains inline with the main agent's history (as a rendered tool result, not as a widget or overlay).

---

## 3. Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  Main Agent TUI (pi interactive mode)                              │
│                                                                      │
│  User: "Fix all the linting errors in src/ and tests/"              │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │ Tool: delegate_to_subagents                                    │ │
│  │                                                                │ │
│  │ ┌─ sub-agent: linter-src ───────────────────────────────┐   │ │
│  │ │  ... line 7 of latest output...                          │   │ │
│  │ │  ... line 8 of latest output...                          │   │ │
│  │ │  ... line 9 of latest output...                          │   │ │
│  │ │  ... line 10 (most recent) ...                             │   │ │
│  │ └─────────────────────────────────────────────────────────┘   │ │
│  │                                                                │ │
│  │ ┌─ sub-agent: linter-tests ─────────────────────────────┐   │ │
│  │ │  ... line 7 of latest output...                          │   │ │
│  │ │  ... line 8 of latest output...                          │   │ │
│  │ │  ... line 9 of latest output...                          │   │ │
│  │ │  ... line 10 (most recent) ...                             │   │ │
│  │ └─────────────────────────────────────────────────────────┘   │ │
│  │                                                                │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                      │
│  Assistant: "The sub-agents have completed..."                       │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

### 3.1 Core Components

1. **`delegate_to_subagents` tool**
   - Parameters: array of tasks `{ name, prompt, cwd? }`, optional `maxLinesPerWindow` (default 10).
   - Execution: spawns each sub-agent as a `pi --mode json -p --no-session` process.
   - Returns: aggregated results when all complete.

2. **SubAgentController**
   - Manages the child `pi` process for a single sub-agent.
   - Maintains a circular/rolling buffer of the latest N lines from stdout.
   - Emits updates via a callback so the parent can call `onUpdate()`.

3. **ResultRenderer**
   - `renderCall()`: Shows a compact summary of what sub-agents are being invoked.
   - `renderResult()`: Receives the current partial/final result and renders the live windows.
   - When `isPartial === true`, renders the live-updating line windows.
   - When `isPartial === false`, renders a summary of all completed sub-agents.

4. **State Model (per tool invocation)**
   ```typescript
   interface SubAgentWindow {
     name: string;
     status: "running" | "completed" | "error";
     lines: string[];               // rolling buffer, max length = maxLinesPerWindow
     exitCode: number | null;
     finalOutput: string;
   }

   interface DelegateResult {
     windows: SubAgentWindow[];
     globalStatus: "running" | "done";
     maxLinesPerWindow: number;
   }
   ```

---

## 4. Implementation Steps

### Step 1: Scaffold the Extension

Create the extension file at the appropriate location (global or project-local):

```
~/.pi/agent/extensions/pi-subagents/index.ts
~/.pi/agent/extensions/pi-subagents/package.json   (if deps needed)
```

### Step 2: Define the Tool Schema

```typescript
import { Type } from "typebox";

const DelegateParams = Type.Object({
  tasks: Type.Array(
    Type.Object({
      name: Type.String({ description: "Display name for this sub-agent window" }),
      prompt: Type.String({ description: "The task/prompt to send to the sub-agent" }),
      cwd: Type.Optional(Type.String({ description: "Working directory for this sub-agent" })),
    }),
    { minItems: 1 }
  ),
  maxLinesPerWindow: Type.Optional(
    Type.Number({ default: 10, description: "Max lines to show per sub-agent window" })
  ),
});
```

### Step 3: Implement the SubAgent Spawner

- Use `spawn("pi", ["--mode", "json", "-p", "--no-session", prompt])`.
- Parse stdout as JSONL. Each line is a Pi event (`message_end`, `tool_execution_end`, etc.).
- For text output, extract `event.message.content` text parts and append to the rolling buffer.
- For tool calls, format a short line (e.g., `→ bash: npm test`) and append to the rolling buffer.
- Call the update callback after each new line so the UI refreshes.
- On process exit, capture the final exit code.

**Rolling buffer logic:**
```typescript
function appendLine(window: SubAgentWindow, line: string) {
  window.lines.push(line);
  if (window.lines.length > window.maxLines) {
    window.lines.shift(); // or use a circular buffer index for perf
  }
}
```

### Step 4: Implement the `execute` function

```typescript
async execute(toolCallId, params, signal, onUpdate, ctx) {
  const maxLines = params.maxLinesPerWindow ?? 10;
  const windows: SubAgentWindow[] = params.tasks.map(t => ({
    name: t.name,
    status: "running",
    lines: [],
    exitCode: null,
    finalOutput: "",
    maxLines,
  }));

  const emitUpdate = () => {
    onUpdate({
      content: [{ type: "text", text: getSummaryText(windows) }],
      details: { windows, maxLinesPerWindow: maxLines },
    });
  };

  await Promise.all(
    params.tasks.map((task, idx) =>
      runSubAgent(task, windows[idx], signal, () => {
        emitUpdate();
      })
    )
  );

  return {
    content: [{ type: "text", text: buildFinalSummary(windows) }],
    details: { windows, maxLinesPerWindow: maxLines },
  };
}
```

### Step 5: Implement `renderCall`

Shows a compact one-line summary when the tool is first invoked:

```typescript
renderCall(args, theme, _ctx) {
  const count = args.tasks?.length ?? 1;
  const text = theme.fg("toolTitle", theme.bold("delegate_to_subagents "))
    + theme.fg("accent", `${count} sub-agent${count > 1 ? "s" : ""}`);
  return new Text(text, 0, 0);
}
```

### Step 6: Implement `renderResult`

This is the most critical piece. It must render a live-updating window per sub-agent.

```typescript
renderResult(result, { isPartial, expanded }, theme, _ctx) {
  const details = result.details as { windows: SubAgentWindow[], maxLinesPerWindow: number } | undefined;
  if (!details) return new Text("(no details)", 0, 0);

  const container = new Container();

  for (const win of details.windows) {
    // Sub-agent header: name + status icon
    const statusIcon = win.status === "running" ? "⏳"
                     : win.status === "error" ? "✗"
                     : "✓";
    const headerColor = win.status === "running" ? "warning"
                      : win.status === "error" ? "error"
                      : "success";

    let headerText = theme.fg(headerColor, statusIcon)
      + " "
      + theme.fg("accent", theme.bold(win.name));
    container.addChild(new Text(headerText, 0, 0));

    // Window: latest N lines
    if (win.lines.length === 0) {
      container.addChild(new Text(theme.fg("muted", "  (starting...)"), 0, 0));
    } else {
      for (const line of win.lines) {
        const formatted = theme.fg("toolOutput", truncateToWidth(`  ${line}`, width));
        container.addChild(new Text(formatted, 0, 0));
      }
    }

    container.addChild(new Spacer(1));
  }

  // Global status
  const running = details.windows.filter(w => w.status === "running").length;
  if (running > 0) {
    container.addChild(new Text(
      theme.fg("muted", `${running} running...`),
      0, 0
    ));
  }

  return container;
}
```

**Key TUI considerations:**
- Use `truncateToWidth()` from `@earendil-works/pi-tui` to ensure no line exceeds terminal width.
- The `Container` will stack all windows vertically.
- Each window is bounded by the sub-agent header + at most `maxLinesPerWindow` lines.
- When `expanded === true`, show the full final output for each sub-agent (not just the window).

### Step 7: Handle Abort / Cancellation

- Pass the `signal` (from `ctx.signal`) to each spawned process.
- On `SIGTERM`, kill the child process gracefully; after a timeout, `SIGKILL`.
- Ensure the `tool_execution_end` correctly reports cancellation.

### Step 8: Package & Test

- Place under `~/.pi/agent/extensions/pi-subagents/` or in a standalone repo.
- Install via `pi -e ./path.ts` during development.
- Test with multiple parallel sub-agents to ensure:
  - Windows update correctly without flickering.
  - Output buffering doesn't cause memory leaks.
  - Abort correctly terminates all child processes.

---

## 5. Key Hooks & API Methods

| Hook / API | Purpose |
|---|---|
| `pi.registerTool()` | Register `delegate_to_subagents` so the LLM can call it. |
| `renderCall` | Show compact invocation text in the history. |
| `renderResult` | Show live windows (partial) or final summary (complete). |
| `onUpdate()` | Called inside `execute` to stream partial results. |
| `ctx.signal` | Abort signal for cancellation support. |
| `truncateToWidth()` | Ensure lines fit within terminal width. |
| `Text`, `Container`, `Spacer` | Build the visual window layout. |

---

## 6. Open Questions & Risks

1. **Performance of frequent re-renders**: Calling `onUpdate()` every time a sub-agent prints a line could cause high TUI re-render cost. We may need to debounce updates (e.g., throttle to 100ms or only update on newlines).
2. **Pi JSON mode output volume**: `pi --mode json` outputs a JSON line for every event. For long sub-agent sessions, this is a lot of JSON. We need efficient streaming parsing.
3. **Terminal width changes**: `renderResult` receives a `width` parameter. Our component must handle it. The rolling buffer stores raw lines, and `renderResult` truncates.
4. **Memory leak from messages**: The sub-agent example accumulates `messages[]` for each sub-agent. If a sub-agent runs for a long time, this consumes memory. Our plugin only needs the latest N lines, so we should NOT store all messages — only the rolling buffer.
5. **Escape codes from sub-agent output**: Sub-agents may output ANSI codes. We should probably strip them with a regex before storing lines, or the TUI may break.
6. **Pi `--mode json` tool result rendering**: If the sub-agent calls tools, we want to show a brief summary (e.g., `→ bash: lint src/*.ts`), not the full JSON tool result. We'll format tool events into short human-readable lines.

---

## 7. Future Enhancements

- **Click to expand**: Allow the user to click/expand a single sub-agent window to see full scrollback (beyond 10 lines) inline.
- **Error highlighting**: If a sub-agent exits with a non-zero code, highlight the window border in red.
- **Progress bar**: If the sub-agent can report progress (e.g., number of files processed), show a mini progress bar in the window header.
- **Filtering**: Allow the user to filter which sub-agent windows are visible when many are running in parallel.
- **Profile management UI**: Add a `/profiles` command to list, create, and edit profiles interactively.
- **Profile inheritance**: Allow profiles to extend other profiles for shared base configuration.
- **Environment variables**: Support env var overrides for profile settings.

---

## 8. Summary

This plugin is achievable entirely within Pi's existing extension system:

1. **Tool registration** exposes the capability to the LLM.
2. **Process spawning** runs sub-agents via `pi --mode json`.
3. **Streaming `onUpdate()`** drives live re-rendering.
4. **`renderResult` with `isPartial`** renders the 10-line windows inline in the conversation history.
5. **`Container` + `Text`** from `pi-tui` builds the multi-window layout.
6. **Parallelism** is handled by `Promise.all` spawning multiple processes.
7. **Debounced updates** and **rolling buffers** keep performance acceptable.

**Next action**: Implement `index.ts` according to the architecture above, starting with a single sub-agent and then expanding to parallel support.
