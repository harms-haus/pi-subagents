# Contributing to pi-subagents

## Development Setup

### Prerequisites

- [Bun](https://bun.sh/) runtime — the project runs TypeScript directly with no build step.

### Clone & Install

```bash
git clone https://github.com/<your-fork>/pi-subagents.git
cd pi-subagents
bun install
```

### Local Dev Install into Pi

Install the extension project-locally (recommended during development):

```bash
pi install . -l
```

Or install globally:

```bash
pi install .
```

There is **no build step** — Bun executes `.ts` files directly, so changes take effect immediately after reinstalling.

## Scripts

| Script          | Command                 | Description                                |
| --------------- | ----------------------- | ------------------------------------------ |
| `lint`          | `eslint src/`           | Run ESLint on all source files             |
| `lint:fix`      | `eslint --fix src/`     | Auto-fix ESLint errors                     |
| `typecheck`     | `tsc --noEmit`          | Run TypeScript type checking               |
| `test`          | `vitest run`            | Run the full test suite once               |
| `test:watch`    | `vitest`                | Run tests in watch mode during development |
| `test:coverage` | `vitest run --coverage` | Run tests with coverage report             |
| `check`         | `eslint src/`           | Alias for `lint`                           |

## Project Structure

| File / Directory               | Responsibility                                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                 | Extension entry point; sets up session store, registers tools and commands                               |
| `src/types.ts`                 | Core type definitions, config constants (`SubAgentTask`, `SubAgentWindow`, `SessionRecord`, `syncState`) |
| `src/schemas.ts`               | TypeBox validation schemas for `delegate_to_subagents` tool parameters                                   |
| `src/profiles.ts`              | Profile loading from markdown files, CLI arg conversion, CRUD, re-exports from sub-modules               |
| `src/profile-types.ts`         | Shared profile type definitions (`SubagentProfile`, `ThinkingLevel`, etc.)                               |
| `src/profile-formatting.ts`    | Profile display formatting: summaries, detail views, markdown serialization                              |
| `src/profile-editor.ts`        | Interactive wizard for creating/editing profiles via the extension UI                                    |
| `src/settings.ts`              | Settings loading: `maxLinesPerWindow`, `commandPreviewWidth` from global/project files                   |
| `src/spawner.ts`               | Spawns child `pi` processes for sub-agents; parses JSON events, updates TUI                              |
| `src/format-tool-call.ts`      | Tool call preview formatting, path shortening, bash command formatting                                   |
| `src/format-transcript.ts`     | Transcript formatting for resume prompts (`formatRunsForResume`, `getTextContent`)                       |
| `src/utils.ts`                 | Shared helpers: ANSI stripping, window line management, concurrency, status counts                       |
| `src/tools/delegate-render.ts` | Pure rendering functions for delegate tool TUI output (call & result)                                    |
| `src/commands/profile.ts`      | `/profile` slash command (list, show, create, edit, delete profiles)                                     |
| `src/tools/delegate.ts`        | `delegate_to_subagents` tool — spawns parallel sub-agents with live TUI windows                          |
| `src/tools/retrieval.ts`       | `get_subagent_output`, `get_subagent_session`, `list_subagent_profiles` tools                            |

## TypeScript Configuration

The project uses **strict mode** with additional safety flags:

| Flag                               | Purpose                                            |
| ---------------------------------- | -------------------------------------------------- |
| `strict`                           | Enables all strict type-checking options           |
| `noUnusedLocals`                   | Errors on unused local variables                   |
| `noUnusedParameters`               | Errors on unused function parameters               |
| `noImplicitReturns`                | Errors on functions that don't return in all paths |
| `noFallthroughCasesInSwitch`       | Errors on switch case fallthrough                  |
| `forceConsistentCasingInFileNames` | Prevents case-related import issues                |

- **Module system**: ESM (`"module": "ESNext"`, `"moduleResolution": "bundler"`)
- **Target**: ES2022
- **Output**: `dist/` with declarations and source maps (configured but not used at runtime — Bun runs `.ts` directly)

## Testing

### Framework

[Vitest](https://vitest.dev/) (v3.x), configured via `vitest.config.ts`. Tests are discovered from `src/**/*.test.ts`.

### Running Tests

```bash
# Run once
bun run test

# Watch mode
bun run test:watch
```

### Test Files & Coverage

| Test File                      | What It Covers                                                                                                                                                                                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `helpers.ts`                   | Shared test helpers: factory functions for mock objects with sensible defaults                                                                                                                                                                                    |
| `index.test.ts`                | Tests session store: `registerSession` (creation, resume, eviction, capping), `getActiveSessionIds`, shutdown handler, `session_start` handler / session reconstruction from custom entries                                                                       |
| `types-helpers.test.ts`        | Tests `syncState`, `serializeSessionData`, `deserializeSessionData`, `CUSTOM_ENTRY_TYPE`                                                                                                                                                                          |
| `schemas.test.ts`              | `TaskSchema` and `DelegateParams` validation — required fields, optional fields, type mismatches, array constraints                                                                                                                                               |
| `profiles-core.test.ts`        | `resolveProfile`, `profileSummary`, `formatProfileDetail` (API key masking), `validateProfileTools`, `applyExcludeTools`, `validateProfileSkills`, `resolveProfileSkills`, `loadProfiles` (cache, project-local, parsing), `apiKey` security    |
| `profiles-args.test.ts`        | `profileToArgs` CLI generation, `extraArgs` tool-override security, `excludeTools` and `suggestedSkills` in `profileToArgs`, `profileSummary`/`formatProfileDetail` with `excludeTools` and skills                                                                |
| `profile-command.test.ts`      | Tests `/profile` command handler: list, show, create, edit, delete, bare name, completions                                                                                                                                                                        |
| `profile-editor.test.ts`       | Tests `editProfileInteractive` wizard with mocked UI (all paths)                                                                                                                                                                                                  |
| `spawner-core.test.ts`         | `runSubAgent` lifecycle (spawn, stdout/stderr, JSON events, abort signals), profile CRUD (`saveProfile`/`deleteProfile`), `serializeProfileToMarkdown`                                                                                                            |
| `spawner-output.test.ts`       | Output processing, message eviction, `turn_end` ls/find result handling, `handleStderrData`                                                                                                                                                                       |
| `spawner-tool-display.test.ts` | Path shortening in tool calls, bash command `&&` splitting, `formatToolCall` defaults, todo tool renderers, tool count tracking                                                                                                                                   |
| `spawner-loop.test.ts`         | Loop detection (consecutive similar tool calls)                                                                                                                                                                                                                   |
| `delegate-core.test.ts`        | Tool registration (`registerDelegateTool`, `registerRetrievalTools`, `registerProfileCommand`), retrieval tool execution (valid/invalid sessions, multi-run), rendering functions                                                                                 |
| `delegate-advanced.test.ts`    | Delegate timeout (`AbortSignal`), timeout extension, resume validation (non-existent, still-running), resume prompt formatting, multi-run output/session, abort signal forwarding, loop detection, `persistSession` / `appendEntry` calls after task completion   |
| `delegate-features.test.ts`    | `excludeTools` resolution, unknown profile handling, skill resolution, `files` parameter, file path security                                                                                                                                                      |
| `delegate-render.test.ts`      | Tests `renderCall` and `renderResult` for delegate tool (TUI rendering)                                                                                                                                                                                           |
| `retrieval-tools.test.ts`      | Tests retrieval tools: `list_subagent_profiles`, `createTruncatingRenderResult`, toolResult extraction                                                                                                                                                            |
| `format-tool-call.test.ts`     | `formatToolCall` branches (edit, write, grep, bash, read, etc.), path shortening, bash command formatting                                                                                                                                                         |
| `settings.test.ts`             | `loadMaxLinesPerWindow`, `loadCommandPreviewWidth` — global vs project overrides, TTY detection, error handling                                                                                                                                                   |
| `format-transcript.test.ts`    | `formatRunsForResume` (run separators, tool calls, truncation), `getTextContent`                                                                                                                                                                                  |
| `utils.test.ts`                | `stripAnsi`, `appendLineToWindow` (rolling buffer eviction, ANSI removal, whitespace handling, tool kind), `mapWithConcurrencyLimit` (concurrency enforcement, ordering, error propagation, sequential), `getLastAssistantText`, `getSummaryText`, `getTextParts` |

### Mocking Approach

- **Node builtins** (`node:fs`, `node:fs/promises`, `node:child_process`): mocked with `vi.mock()` to avoid filesystem/process side effects.
- **External packages** (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `@earendil-works/pi-ai`, `typebox`): mocked to provide minimal stubs matching the interfaces used by the code under test.
- **Internal modules** (`../profiles`, `../spawner`): partially mocked using `importOriginal` to override specific functions (e.g., `loadCommandPreviewWidth`) while keeping the rest of the module's real behavior.
- **Process state** (`process.stdout.columns`): temporarily overridden via `Object.defineProperty` and restored in `afterEach` to test TTY vs non-TTY paths deterministically.
- **Child processes**: simulated with `EventEmitter`-based mock objects that emit `data`, `close`, and `error` events.

## Code Style

The project uses [ESLint](https://eslint.org/) v10 (flat config) with `@typescript-eslint`, `eslint-plugin-import-x`, and `eslint-plugin-unicorn`.

### Configuration (`eslint.config.js`)

ESLint uses the flat config format. Key rules:

| Rule                      | Setting | Notes                                         |
| ------------------------- | ------- | --------------------------------------------- |
| `no-explicit-any`         | error   | Explicit `any` is forbidden                   |
| `no-non-null-assertion`   | error   | `!` operator forbidden                        |
| `no-unused-vars`          | error   | `_` prefix allowed for intentionally unused   |
| `consistent-type-imports` | error   | Use `import type` for type-only imports       |
| `eqeqeq`                  | error   | Always use `===` / `!==`                      |
| `prefer-template`         | error   | Template literals over concatenation          |
| `prefer-const`            | error   | Prefer `const` over `let`                     |
| `curly`                   | error   | Require braces on all if/for/while statements |
| `import/order`            | error   | Organized import groups                       |

Test files (`src/__tests__/**/*.test.ts`) have relaxed rules for `any`, non-null assertions, import ordering, and `unicorn/consistent-function-scoping` since mock-heavy code requires these patterns.

### Before Committing

```bash
bun run typecheck && bun run lint && bun run test
```

## Pull Request Guidelines

1. **Run lint + tests before submitting.** All CI checks must pass:

   ```bash
   bun run typecheck && bun run lint && bun run test
   ```

2. **Add tests for new features or bug fixes.** Match the existing testing patterns — mock external dependencies, use `describe`/`it` blocks, and assert specific behaviors.

3. **Update documentation if changing tool parameters or profile format.** This includes:
   - `src/schemas.ts` (TypeBox schema changes)
   - `src/types.ts` (Type interface changes)
   - `src/profile-types.ts` (Profile type changes)
   - `src/settings.ts` (Settings changes)
   - `src/profiles.ts` (new profile frontmatter fields)
   - Any affected test files

4. **Keep commits focused.** One logical change per commit.

5. **Follow the existing code style.** Double quotes, semicolons, 2-space indentation, 120-char line width.
