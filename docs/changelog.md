# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] — 2026-05-14

### Added

- `delegate_to_subagents` tool with parallel execution (max 16 tasks, 4 concurrent)
- `get_subagent_output`, `get_subagent_session`, `list_subagent_profiles` retrieval tools
- Profile system using markdown+YAML frontmatter files (`~/.pi/agent/agent-profiles/*.md`, `.pi/agent-profiles/*.md`)
- `/profile` slash command with interactive profile editor
- Live TUI rolling window display with expand/collapse per sub-agent
- Per-task timeout with abort escalation (SIGTERM → SIGKILL after 5s)
- Session resume support via `resume` parameter
- Debounced TUI updates (50ms)
- Path shortening and tool call preview formatting
- In-memory session store with oldest-first eviction (max 32 sessions, 10 runs per session)
- Profile cache with 5-second TTL
- `excludeTools` profile field — blacklist of tool names to exclude from the parent session's full tool set. Mutually exclusive with `tools` (allowlist). Resolved at spawn time by computing `all tools - excluded tools` and passing the result via `--tools`.
- Security: `extraArgs` containing `--tools`, `--no-tools`, or their short/equals-sign forms are now blocked when tool restrictions (`tools`, `excludeTools`, or `noTools`) are active.
- Comprehensive test coverage: 365 tests (93% coverage) across 13 test files, covering session store, helper functions, profile editor, command handler, TUI rendering, retrieval tools, and profile/spawner modules.
- ESLint strict config (`eslint.config.js`) replacing Biome — 0 lint errors, no-explicit-any enforced, no-non-null-assertion enforced.
- GitHub Actions CI workflow (`.github/workflows/ci.yml`) — runs typecheck, lint, and tests on push/PR to main across Node 20 and 22.
- GitHub Actions publish workflow (`.github/workflows/publish.yml`) — dry-run publish on git tags matching `v*`.
- Vitest coverage reporting with `@vitest/coverage-v8` — 80% threshold for statements, branches, functions, and lines.
- `test:coverage` npm script for local coverage reporting.
- `typecheck` npm script (`tsc --noEmit`) for TypeScript validation.

### Changed

- `typebox` moved from `devDependencies` to `dependencies` (runtime usage).
- Added `repository`, `publishConfig`, `files`, and proper `author` to `package.json`.
- Added `@earendil-works/pi-ai` as `peerDependencies`.

### Fixed

- Fixed all implicit `any` parameter errors in source and test files.
- Fixed all non-null assertion (`!`) violations.
- Fixed all explicit `any` types in source files.
- Fixed biome formatting errors throughout codebase.
- Fixed Dirent type errors in profiles.test.ts.
