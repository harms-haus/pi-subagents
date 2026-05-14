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

| Script          | Command                     | Description                                    |
| --------------- | --------------------------- | ---------------------------------------------- |
| `lint`          | `biome check src/`          | Run Biome linter on all source files           |
| `check`         | `biome check src/`          | Alias for `lint`                               |
| `test`          | `vitest run`                | Run the full test suite once                   |
| `test:watch`    | `vitest`                    | Run tests in watch mode during development     |
| `format`        | `biome format --write src/` | Auto-format all source files                   |
| `format:check`  | `biome format src/`         | Check formatting without modifying files       |

## Project Structure

| File / Directory                                | Responsibility                                                                    |
| ----------------------------------------------- | --------------------------------------------------------------------------------- |
| `src/index.ts`                                  | Extension entry point; sets up session store, registers tools and commands        |
| `src/types.ts`                                  | Core type definitions (`SubAgentTask`, `SubAgentWindow`, `SessionRecord`, etc.)   |
| `src/schemas.ts`                                | TypeBox validation schemas for `delegate_to_subagents` tool parameters            |
| `src/profiles.ts`                               | Profile loading from markdown files, CLI arg conversion, settings resolution      |
| `src/profile-editor.ts`                         | Interactive wizard for creating/editing profiles via the extension UI             |
| `src/spawner.ts`                                | Spawns child `pi` processes for sub-agents; parses JSON events, updates TUI       |
| `src/utils.ts`                                  | Shared helpers: ANSI stripping, path shortening, bash formatting, concurrency     |
| `src/commands/profile.ts`                       | `/profile` slash command (list, show, create, edit, delete profiles)              |
| `src/tools/delegate.ts`                         | `delegate_to_subagents` tool — spawns parallel sub-agents with live TUI windows   |
| `src/tools/retrieval.ts`                        | `get_subagent_output`, `get_subagent_session`, `list_subagent_profiles` tools     |
| `src/__tests__/smoke.test.ts`                   | Basic smoke test ensuring the test harness works                                  |
| `src/__tests__/schemas.test.ts`                 | Validates `TaskSchema` and `DelegateParams` — required/optional fields, edge cases|
| `src/__tests__/profiles.test.ts`                | Tests `profileToArgs` (CLI generation, extraArgs safety), profile summary/detail, settings loading (`loadMaxLinesPerWindow`, `loadCommandPreviewWidth`), directory resolution |
| `src/__tests__/spawner.test.ts`                 | Tests `runSubAgent` — spawn args, stdout/stderr parsing, JSON events, abort signals, path shortening in tool call display, smart `&&` splitting in bash command formatting |
| `src/__tests__/tools.test.ts`                   | Tests tool registration, session store operations, retrieval tool execution (`get_subagent_output`, `get_subagent_session`), resume logic, multi-run sessions, delegate timeout, `countWindowStatuses` |
| `src/__tests__/utils.test.ts`                   | Tests `stripAnsi`, `appendLineToWindow`, `mapWithConcurrencyLimit`, `getLastAssistantText`, `getSummaryText`, `getTextParts`, `shortenPath`, `shortenPathsInText`, `formatBashCommand`, `collapseCdDot` |

## TypeScript Configuration

The project uses **strict mode** with additional safety flags:

| Flag                              | Purpose                                          |
| --------------------------------- | ------------------------------------------------ |
| `strict`                          | Enables all strict type-checking options          |
| `noUnusedLocals`                  | Errors on unused local variables                  |
| `noUnusedParameters`              | Errors on unused function parameters              |
| `noImplicitReturns`               | Errors on functions that don't return in all paths|
| `noFallthroughCasesInSwitch`      | Errors on switch case fallthrough                 |
| `forceConsistentCasingInFileNames`| Prevents case-related import issues               |

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

| Test File                 | What It Covers                                                                 |
| ------------------------- | ------------------------------------------------------------------------------ |
| `smoke.test.ts`           | Verifies the test harness is functional                                        |
| `schemas.test.ts`         | `TaskSchema` and `DelegateParams` validation — required fields, optional fields, type mismatches, array constraints |
| `profiles.test.ts`        | `profileToArgs` CLI generation, `extraArgs` safety validation (null bytes, shell operators), `resolveProfile`, `profileSummary`, `formatProfileDetail` (API key masking), `loadMaxLinesPerWindow` settings resolution, `loadCommandPreviewWidth` (TTY vs settings), `getProfilesDir` |
| `spawner.test.ts`         | `runSubAgent` lifecycle — spawn arguments, stdout line processing, JSON `message_end` event parsing, malformed JSON handling, process exit codes, `AbortSignal` with SIGTERM escalation, profile argument injection, path shortening in tool call display, smart `&&` splitting with width budgets |
| `tools.test.ts`           | Tool registration (`registerDelegateTool`, `registerRetrievalTools`, `registerProfileCommand`), session store operations, retrieval tool execution (valid/invalid sessions, multi-run), delegate timeout via `AbortSignal`, resume validation (non-existent, still-running), resume prompt formatting, session ID reuse, `countWindowStatuses` |
| `utils.test.ts`           | `stripAnsi`, `appendLineToWindow` (rolling buffer eviction, ANSI removal, whitespace handling, tool kind), `mapWithConcurrencyLimit` (concurrency enforcement, ordering, error propagation, sequential), `getLastAssistantText`, `getSummaryText`, `getTextParts`, `shortenPath`, `shortenPathsInText`, `formatBashCommand` (truncation, `&&` splitting, continuation lines), `collapseCdDot` |

### Mocking Approach

- **Node builtins** (`node:fs`, `node:fs/promises`, `node:child_process`): mocked with `vi.mock()` to avoid filesystem/process side effects.
- **External packages** (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `@earendil-works/pi-ai`, `typebox`): mocked to provide minimal stubs matching the interfaces used by the code under test.
- **Internal modules** (`../profiles`, `../spawner`): partially mocked using `importOriginal` to override specific functions (e.g., `loadCommandPreviewWidth`) while keeping the rest of the module's real behavior.
- **Process state** (`process.stdout.columns`): temporarily overridden via `Object.defineProperty` and restored in `afterEach` to test TTY vs non-TTY paths deterministically.
- **Child processes**: simulated with `EventEmitter`-based mock objects that emit `data`, `close`, and `error` events.

## Code Style

The project uses [Biome](https://biomejs.dev/) v2.4.4 for linting and formatting.

### Key Conventions (`biome.json`)

| Rule                                      | Setting | Notes                                        |
| ----------------------------------------- | ------- | -------------------------------------------- |
| Indent style                              | spaces  | 2-space indentation                          |
| Line width                                | 120     |                                              |
| Quotes                                    | double  |                                              |
| Semicolons                                | always  |                                              |
| `organizeImports`                         | on      | Auto-sorts imports on save                   |
| `useTemplate`                             | error   | Prefer template literals over concatenation  |
| `useConst`                                | error   | Use `const` when a variable is never reassigned |
| `noParameterAssign`                       | off     | Parameter reassignment is allowed            |
| `noExplicitAny`                           | warn    | Discouraged but not enforced                 |
| `noForEach`                               | warn    | Discouraged in favor of `for...of`           |
| `useSimplifiedLogicExpression`            | warn    | Simplify boolean expressions                 |

There is one override for `src/index.ts` that disables `noControlCharactersInRegex` (needed for the ANSI escape code regex).

### Before Committing

```bash
bun run format    # Auto-format
bun run lint      # Check for lint errors
bun run test      # Run tests
```

## Pull Request Guidelines

1. **Run lint + tests before submitting.** All CI checks must pass:
   ```bash
   bun run format && bun run lint && bun run test
   ```

2. **Add tests for new features or bug fixes.** Match the existing testing patterns — mock external dependencies, use `describe`/`it` blocks, and assert specific behaviors.

3. **Update documentation if changing tool parameters or profile format.** This includes:
   - `src/schemas.ts` (TypeBox schema changes)
   - `src/types.ts` (Type interface changes)
   - `src/profiles.ts` (new profile frontmatter fields)
   - Any affected test files

4. **Keep commits focused.** One logical change per commit.

5. **Follow the existing code style.** Double quotes, semicolons, 2-space indentation, 120-char line width.
