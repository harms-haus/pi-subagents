# Profiles Reference

Complete reference for the subagent profile system in pi-subagents.

> **See also:** [Architecture Overview](architecture.md) · [Tools Reference](tools-reference.md)

---

## 1. Overview

Profiles are named, reusable configurations that pre-configure how a sub-agent runs. Instead of specifying provider, model, system prompt, thinking level, tool restrictions, and other settings inline with every task, you define them once in a profile and reference it by name.

Profiles are useful for:

- **Consistency** — ensure every code-review task uses the same model and instructions
- **Specialization** — maintain separate profiles for different roles (reviewer, researcher, planner, etc.)
- **Security** — restrict tool access or extensions for untrusted tasks
- **Convenience** — swap models or providers globally by editing a single file

Each profile is a standalone Markdown file with YAML frontmatter. The frontmatter defines configuration; the Markdown body becomes the sub-agent's system prompt.

---

## 2. Profile File Format

Profiles are Markdown files (`.md`) stored in the [agent-profiles directory](#4-profile-locations--resolution). They use YAML frontmatter for configuration and Markdown body for the system prompt.

### Structure

```markdown
---
name: my-profile
provider: anthropic
model: claude-sonnet-4-5
thinkingLevel: high
tools: read,bash,grep
noExtensions: true
---

You are an expert code reviewer. Focus on bugs, security issues, and
performance. Be thorough but concise in your feedback.
```

### Frontmatter Fields

Every field in the frontmatter is **optional**. Only `name` is required for the profile to be loaded.

| Field | Type | Description |
|---|---|---|
| `name` | `string` | **Required.** The profile's identifier. Must match `[a-zA-Z0-9_-]+`. Determines the filename (`{name}.md`). Note: `name` is not part of the `SubagentProfile` type — it is extracted during loading and used as the key in the profiles map. |
| `provider` | `string` | LLM provider name (e.g., `anthropic`, `openai`, `dashscope`). Maps to `--provider`. |
| `model` | `string` | Model ID or pattern. Supports `provider/id` format (e.g., `anthropic/claude-sonnet-4-5`) and `:thinking` shorthand (e.g., `sonnet:high`). Maps to `--model`. |
| `thinkingLevel` | `string` | Extended thinking level. Valid values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. Maps to `--thinking`. |
| `tools` | `string` or `string[]` | Comma-separated string **or** YAML array of tool names to **allow**. If set, only these tools are available. E.g., `read,bash,grep` or `[read, bash, grep]`. Maps to `--tools`. |
| `noTools` | `boolean` | If `true`, disables all tools for the sub-agent. Maps to `--no-tools`. Mutually exclusive with `tools` and `excludeTools` — if multiple are set, precedence is `noTools` > `tools` > `excludeTools`. |
| `excludeTools` | `string` or `string[]` | Comma-separated string **or** YAML array of tool names to **exclude** from the parent session's full tool set. The allowed tools are computed at spawn time: all available tools minus the blacklisted ones, passed as `--tools` to the child process. Mutually exclusive with `tools` — if both are set, an error is thrown. If `noTools` is also set, `noTools` takes precedence and `excludeTools` is silently ignored. |
| `noExtensions` | `boolean` | If `true`, disables all extensions. Maps to `--no-extensions`. |
| `extensions` | `string` or `string[]` | Comma-separated string **or** YAML array of extension file paths to load. Each entry maps to a separate `--extension` flag. |
| `noSkills` | `boolean` | If `true`, disables skills. Maps to `--no-skills`. |
| `noContextFiles` | `boolean` | If `true`, disables context files (`AGENTS.md`, `CLAUDE.md`). Maps to `--no-context-files`. |
| `appendSystemPrompt` | `string` | Text appended to pi's default system prompt. Use when you want to add instructions without replacing the default entirely. Maps to `--append-system-prompt`. |
| `apiKey` | `string` | Custom API key for this profile. Stored as the `PI_API_KEY` environment variable — **never passed as a CLI argument**. |
| `extraArgs` | `string` or `string[]` | Comma-separated string **or** YAML array of additional CLI arguments passed verbatim to the sub-agent. Subject to [security validation](#8-security-considerations). |

### Markdown Body → `systemPrompt`

The Markdown body (everything after the closing `---`) becomes the sub-agent's `systemPrompt`, mapping to the `--system-prompt` CLI flag. This **replaces** pi's default system prompt entirely.

- Leading and trailing whitespace is trimmed.
- If the body is empty, no `--system-prompt` flag is emitted.
- Use `appendSystemPrompt` if you want to **add to** the default system prompt instead of replacing it.

---

## 3. Profile Locations & Resolution

### Directory Paths

| Scope | Directory | Example |
|---|---|---|
| **Global** | `~/.pi/agent/agent-profiles/` | `~/.pi/agent/agent-profiles/code-reviewer.md` |
| **Project-local** | `.pi/agent-profiles/` (relative to project root) | `my-project/.pi/agent-profiles/code-reviewer.md` |

The global directory respects the `PI_CODING_AGENT_DIR` environment variable. If set, the base path is `$PI_CODING_AGENT_DIR` instead of `~/.pi/agent`.

### Override Behavior

Project-local profiles **override** global profiles with the same `name`. Loading order:

1. Global profiles are loaded first
2. Project-local profiles are loaded second, overwriting any global profile with a matching name

### Caching

Profiles are cached in memory with a **5-second TTL**. The cache is keyed by the working directory (`cwd`). Cache invalidation happens automatically on:

- `saveProfile()` — creating or updating a profile
- `deleteProfile()` — removing a profile

You can also manually clear the cache by calling `invalidateProfilesCache()`.

---

## 4. Complete Examples

### Minimal Profile

The simplest possible profile — just sets a model. All other settings use pi defaults.

```markdown
---
name: fast
model: anthropic/claude-sonnet-4-5
---
```

### Code Reviewer

A thorough reviewer with high thinking, a restricted tool set, and a custom system prompt.

```markdown
---
name: code-reviewer
provider: anthropic
model: claude-sonnet-4-5
thinkingLevel: high
tools: read,bash,grep,edit,write
---

You are an expert code reviewer. Analyze code for:

1. **Bugs** — logic errors, race conditions, edge cases
2. **Security** — injection, auth issues, data leaks
3. **Performance** — unnecessary allocations, inefficient algorithms
4. **Maintainability** — clarity, naming, structure

Be thorough but concise. Report findings in order of severity.
```

### Fast Worker

Optimized for speed — no thinking, no extensions, brief responses.

```markdown
---
name: fast-worker
provider: dashscope
model: qwen3.5-plus
thinkingLevel: off
appendSystemPrompt: Be concise. Skip explanations unless explicitly asked. Return only code or direct answers.
noExtensions: true
---
```

### Restricted Sandbox

Maximum isolation — no tools, no extensions, no skills, no context files. Ideal for running untrusted or exploratory prompts.

```markdown
---
name: sandbox
model: openai/gpt-4o
noTools: true
noExtensions: true
noSkills: true
noContextFiles: true
---

You are in a restricted environment with no tool access. Answer questions using your training knowledge only. If you need to read files or run commands, explain what you would do but cannot execute it.
```

### Read-Only Worker

A profile that excludes write-capable tools while retaining read and search access.

```markdown
---
name: read-only-worker
provider: zai
model: glm-5.1
thinkingLevel: medium
excludeTools: write,edit,bash
---

You are a read-only analyst. You can read files and search but cannot modify anything.
```

### Profile with API Key

Uses a dedicated API key, useful for quota management or multi-account setups.

```markdown
---
name: research-budget
provider: openai
model: gpt-4o-mini
apiKey: sk-proj-abc123def456ghi789
appendSystemPrompt: You are a research assistant. Use web search to find current information. Cite your sources.
extensions: /path/to/web-search-extension.js
---
```

> **Security note:** The `apiKey` is placed into the `PI_API_KEY` environment variable at runtime, never exposed via `/proc/PID/cmdline`. Still, treat profile files as sensitive — they may contain API keys.

---

## 5. Using Profiles in Tasks

Profiles can be applied at two levels when calling `delegate_to_subagents`.

### Per-Task Profile

Each task specifies its own profile via the `profile` field:

```json
{
  "delegate_to_subagents": {
    "tasks": [
      {
        "name": "review-src",
        "prompt": "Review all TypeScript files in src/.",
        "profile": "code-reviewer"
      },
      {
        "name": "research-patterns",
        "prompt": "Research best practices for error handling in TypeScript.",
        "profile": "research-budget"
      }
    ]
  }
}
```

### Top-Level Default Profile

Set a default profile for all tasks at the top level. Individual tasks can still override with their own `profile`:

```json
{
  "delegate_to_subagents": {
    "profile": "fast-worker",
    "tasks": [
      {
        "name": "quick-task",
        "prompt": "Count the lines in src/."
      },
      {
        "name": "deep-review",
        "prompt": "Perform a deep security audit of auth.ts.",
        "profile": "code-reviewer"
      }
    ]
  }
}
```

### Resolution Order

| Priority | Source | Example |
|---|---|---|
| **1 (highest)** | Per-task `profile` field | `tasks[0].profile` |
| **2** | Top-level `profile` parameter | `delegate_to_subagents.profile` |
| **3 (lowest)** | No profile — pi defaults | Neither field set |

If a profile name cannot be resolved (doesn't exist in any profiles directory), the task fails with an error:

```
Unknown profile: "nonexistent". Available profiles: code-reviewer, fast-worker, sandbox
```

### Listing Available Profiles

The LLM can discover available profiles via the `list_subagent_profiles` tool:

```json
{
  "list_subagent_profiles": {}
}
```

Or interactively with the [`/profile` command](#6-the-profile-command).

---

## 6. The `/profile` Command

Manage profiles interactively from the TUI. The `/profile` command provides a full CRUD interface.

### Subcommands

| Command | Aliases | Description |
|---|---|---|
| `/profile list` | `ls` | List all loaded profiles with one-line summaries |
| `/profile show <name>` | `<name>` (bare) | Display full details of a profile |
| `/profile create <name>` | `new` | Launch interactive wizard to create a new profile |
| `/profile edit <name>` | — | Launch interactive wizard to edit an existing profile |
| `/profile delete <name>` | `rm`, `remove` | Delete a profile (confirms first) |

### Name Validation

Profile names must match the pattern `^[a-zA-Z0-9_-]+$`:

- **Allowed:** letters, digits, hyphens (`-`), underscores (`_`)
- **Not allowed:** spaces, dots, slashes, special characters
- **Case-sensitive:** `CodeReviewer` and `code-reviewer` are distinct

### Interactive Editor Walkthrough

Both `/profile create` and `/profile edit` launch a step-by-step wizard:

1. **Scope** — choose `Global` (`~/.pi/agent/agent-profiles/`) or `Project` (`.pi/agent-profiles/`)
2. **Provider** — enter provider name (pre-filled on edit); skip to omit
3. **Model** — enter model ID (pre-filled on edit); skip to omit
4. **System prompt** — confirm whether to set/keep a custom system prompt; if yes, opens a full editor for the prompt text
5. **Append system prompt** — confirm whether to set/keep appended text; if yes, enter the text
6. **Thinking level** — confirm whether to set; if yes, select from: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`
7. **Tools** — confirm whether to configure; if yes, choose from three options:
   - **Disable all tools** (`noTools`) — sub-agent runs with no tool access
   - **Allowlist** — enter a comma-separated list of tools to *allow* (all others excluded)
   - **Blacklist** — enter a comma-separated list of tools to *exclude* (all others allowed)
8. **Extensions** — confirm whether to configure; if yes, choose to disable all extensions (`noExtensions`) or enter comma-separated paths
9. **Review** — displays the full profile summary; confirm to save or cancel

At any step, answering "No" or canceling skips that field. Skipped fields are omitted from the saved profile (pi defaults apply).

---

## 7. Profile → CLI Argument Mapping

Profiles are converted to CLI arguments and environment variables via `profileToArgs()`. The resulting args are injected into the `pi` subprocess invocation for the sub-agent.

| Profile Field | CLI Flag | Notes |
|---|---|---|
| `provider` | `--provider <value>` | |
| `model` | `--model <value>` | |
| `systemPrompt` | `--system-prompt <value>` | Sourced from Markdown body |
| `appendSystemPrompt` | `--append-system-prompt <value>` | |
| `thinkingLevel` | `--thinking <value>` | |
| `tools` | `--tools <comma-separated>` | Joined with commas: `read,bash,grep` |
| `noTools` | `--no-tools` | Boolean flag; no value |
| `excludeTools` | `--tools <computed>` | Resolved at runtime via `applyExcludeTools()`: all parent tools minus blacklisted names, joined into a comma-separated `--tools` value |
| `noExtensions` | `--no-extensions` | Boolean flag; no value |
| `extensions` | `--extension <value>` (×N) | One `--extension` flag per entry |
| `noSkills` | `--no-skills` | Boolean flag; no value |
| `noContextFiles` | `--no-context-files` | Boolean flag; no value |
| `apiKey` | *(env var)* | Set as `PI_API_KEY` in process environment — **not a CLI flag** |
| `extraArgs` | *(appended verbatim)* | Each array element appended directly to the args array |

### `noTools` vs `tools` vs `excludeTools` Precedence

Tool configuration follows three-way precedence: **`noTools` > `tools` > `excludeTools`**.

- If `noTools` is `true`, only `--no-tools` is emitted — both `tools` and `excludeTools` are ignored.
- If `noTools` is not set but `tools` is, only `--tools` is emitted with the allowlist — `excludeTools` is ignored.
- If neither `noTools` nor `tools` is set but `excludeTools` is, the blacklisted tools are subtracted from the parent session's full tool set via `applyExcludeTools()`, and the resulting allowed set is passed as `--tools`.

This matches the behavior in `profileToArgs()`:

```typescript
if (profile.noTools) {
  args.push("--no-tools");
} else if (profile.tools && profile.tools.length > 0) {
  args.push("--tools", profile.tools.join(","));
}
// else: excludeTools is resolved at runtime via applyExcludeTools()
// to produce a computed tools array, which is then passed as --tools
```

> **Note:** `applyExcludeTools()` resolves `excludeTools` to a computed `tools` array **before** `profileToArgs()` runs. By the time the extraArgs validation guard executes, the profile already has `tools` set (not `excludeTools`), so the guard checks against `profile.tools` regardless of whether the original profile used `tools` or `excludeTools`.

If both `tools` and `excludeTools` are set without `noTools`, an error is thrown — they are mutually exclusive.

### API Key Handling

The `apiKey` field is **never** passed as a CLI argument. Instead, it is set as the `PI_API_KEY` environment variable in the sub-agent's process environment. This prevents the key from appearing in `/proc/PID/cmdline` or process listings.

### Example Conversion

Given this profile:

```markdown
---
name: reviewer
provider: anthropic
model: claude-sonnet-4-5
thinkingLevel: high
tools: read,bash,grep
noExtensions: true
apiKey: sk-test-abc123
extraArgs: --verbose
---

You are a code reviewer.
```

The resulting invocation parameters:

```
args: [
  "--provider", "anthropic",
  "--model", "claude-sonnet-4-5",
  "--system-prompt", "You are a code reviewer.",
  "--thinking", "high",
  "--tools", "read,bash,grep",
  "--no-extensions",
  "--verbose"
]
env: {
  PI_API_KEY: "sk-test-abc123"
}
```

---

## 8. Security Considerations

### API Keys

- API keys in profile files are stored as plain text. Treat profile directories as sensitive.
- At runtime, API keys are passed via the `PI_API_KEY` environment variable, not CLI arguments, avoiding exposure in process listings.
- The `/profile show` command masks API keys in display output (e.g., `sk-t****bc123`).

### `extraArgs` Validation

The `extraArgs` field is subject to security validation before being passed to the subprocess. The following are **blocked**:

| Pattern | Example | Error |
|---|---|---|
| Null bytes | `"test\0arg"` | `Invalid extraArg: contains null byte` |
| Shell operators at start | `"| ls"`, `"& rm"`, `"; echo"` | `Refusing extraArg: potentially unsafe argument '\| ls...'` |
| Command separators | `"&& rm"`, `"|| exit"`, `"; ls"` | `Refusing extraArg: potentially unsafe argument '&& rm...'` |
| Shell redirection | `"> file"`, `">> file"`, `"< file"` | `Refusing extraArg: potentially unsafe argument '> file...'` |
| Backticks / leading `$` | ``"`whoami`"``, `"$HOME"` | ``Refusing extraArg: potentially unsafe argument '`whoami`...'`` |

> **Note:** The validation regex catches backticks and `$` only at the **start** of an argument. It does **not** detect `$()` command substitution when it appears later in the string (e.g., `"arg$(whoami)"` passes validation).

The validation regex:

```
/^[\s|&;$\\`!]|&&|\|\||;|>|>>|<|<</
```

### Tool Restriction Override Guard

When `excludeTools`, `tools`, or `noTools` is set in a profile, passing tool-restriction flags via `extraArgs` is **blocked**. The following `extraArgs` patterns are rejected:

| Blocked Flag | Example `extraArgs` | Error |
|---|---|---|
| `--tools` | `"--tools=read,write"` | `Cannot pass --tools in extraArgs when tools are configured in profile` |
| `-t` | `"-t read"` | `Cannot pass -t in extraArgs when tools are configured in profile` |
| `--no-tools` | `"--no-tools"` | `Cannot pass --no-tools in extraArgs when tools are configured in profile` |
| `-nt` | `"-nt"` | `Cannot pass -nt in extraArgs when tools are configured in profile` |

Both space-separated (`--tools read`) and equals-sign (`--tools=read`) forms are caught. This prevents `extraArgs` from silently overriding the profile's tool restrictions.

### Profile File Permissions

Consider restricting read access to profile directories if they contain API keys:

```bash
chmod 700 ~/.pi/agent/agent-profiles/
chmod 600 ~/.pi/agent/agent-profiles/*.md
```

### Project-Local Profiles

Be cautious when using project-local profiles in shared repositories — they are committed with the project and visible to all collaborators. Prefer global profiles for sensitive configurations (API keys, etc.).

---

## Related Documentation

- [Tools Reference](tools-reference.md) — the `delegate_to_subagents`, `get_subagent_output`, `get_subagent_session`, and `list_subagent_profiles` tools
- [Architecture Overview](architecture.md) — how sub-agents are spawned and managed
- [README](../README.md) — installation and quick start
