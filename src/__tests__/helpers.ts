/**
 * Shared test helpers for pi-subagents test suite.
 *
 * Factory functions that create mock objects with sensible defaults,
 * so individual tests only need to override the properties they care about.
 */
import { EventEmitter } from "node:events";
import { vi } from "vitest";
import type {
	SubAgentWindow,
	SubagentSessionData,
	WindowedSubagentDetails,
} from "../types";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";

// ─── createMockPi ───────────────────────────────────────────────────
// Used in: tools.test.ts, retrieval-tools.test.ts, delegate-render.test.ts,
//          index.test.ts, profile-command.test.ts

/**
 * Create a minimal mock ExtensionAPI with sensible defaults.
 * Pass `overrides` to replace or extend any property.
 */
export function createMockPi(
	overrides: Partial<ExtensionAPI> = {},
): ExtensionAPI {
	return {
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
		on: vi.fn(),
		getAllTools: vi.fn().mockReturnValue([]),
		ui: {
			notify: vi.fn(),
			confirm: vi.fn(),
		},
		...overrides,
	} as unknown as ExtensionAPI;
}

// ─── makeSession ────────────────────────────────────────────────────
// Used in: index.test.ts, tools.test.ts, retrieval-tools.test.ts,
//          types-helpers.test.ts

/**
 * Factory for SubagentSessionData with sensible defaults.
 * Override any field via `overrides`.
 */
export function makeSession(
	overrides: Partial<SubagentSessionData> = {},
): SubagentSessionData {
	return {
		sessionId: `session-${Math.random().toString(36).slice(2, 10)}`,
		taskName: "test-task",
		prompt: "test prompt",
		cwd: "/tmp",
		status: "completed",
		messages: [],
		exitCode: 0,
		startedAt: Date.now(),
		...overrides,
	};
}

// ─── makeWindow ─────────────────────────────────────────────────────
// Used in: utils.test.ts, types-helpers.test.ts, delegate-render.test.ts,
//          spawner.test.ts

/**
 * Factory for SubAgentWindow with sensible defaults.
 * Override any field via `overrides`.
 */
export function makeWindow(
	overrides: Partial<SubAgentWindow> = {},
): SubAgentWindow {
	return {
		sessionId: "session-abc123",
		name: "test-window",
		status: "running",
		lines: [],
		allMessages: [],
		exitCode: null,
		startedAt: Date.now(),
		timeout: 600,
		toolCount: 0,
		...overrides,
	};
}

// ─── makeDetails ────────────────────────────────────────────────────
// Used in: delegate-render.test.ts

/**
 * Factory for WindowedSubagentDetails with sensible defaults.
 * Override any field via `overrides`.
 */
export function makeDetails(
	overrides: Partial<WindowedSubagentDetails> = {},
): WindowedSubagentDetails {
	return {
		windows: [],
		maxLinesPerWindow: 15,
		globalStatus: "running",
		sessionIds: [],
		...overrides,
	};
}

// ─── createMockProcess ──────────────────────────────────────────────
// Used in: spawner.test.ts

/** Type for the mock ChildProcess returned by createMockProcess */
export type MockChildProcess = EventEmitter & {
	stdout: EventEmitter;
	stderr: EventEmitter;
	stdin: EventEmitter & {
		write: ReturnType<typeof vi.fn>;
		end: ReturnType<typeof vi.fn>;
	};
	killed: boolean;
	kill: ReturnType<typeof vi.fn>;
};

/**
 * Create a mock ChildProcess with EventEmitter-based stdout/stderr/stdin.
 * The `kill` mock emits "exit" with code 0 for SIGTERM and 1 otherwise.
 */
export function createMockProcess(): MockChildProcess {
	const proc = new EventEmitter() as MockChildProcess;
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.stdin = Object.assign(new EventEmitter(), {
		write: vi.fn(),
		end: vi.fn(),
	}) as MockChildProcess["stdin"];
	proc.killed = false;
	proc.kill = vi.fn((signal: string) => {
		proc.killed = true;
		proc.emit("exit", signal === "SIGTERM" ? 0 : 1);
	});
	return proc;
}

// ─── createMockTheme ────────────────────────────────────────────────
// Used in: tools.test.ts, delegate-render.test.ts, retrieval-tools.test.ts

/**
 * Create a mock Theme where `fg` and `bold` pass through text unchanged.
 * Useful for testing that theme methods are called with correct arguments.
 */
export function createMockTheme(): Theme {
	return {
		fg: vi.fn((_color: string, text: string) => text),
		bold: vi.fn((text: string) => text),
	} as unknown as Theme;
}
