# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] — 2025-05-14

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
