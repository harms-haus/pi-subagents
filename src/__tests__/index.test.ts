import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionRecord, SubagentSessionData } from "../types";
import { createMockPi, makeSession } from "./helpers";

// ── Mocks ──────────────────────────────────────────────────────────
// We intercept the sub-module registrations so we can capture the
// closures (registerSession, getActiveSessionIds, sessionStore) that
// are created inside the default export.

let capturedRegisterSession: (session: SubagentSessionData) => void;
let capturedGetActiveSessionIds: () => Set<string>;
let capturedSessionStore: Map<string, SessionRecord> | null = null;
let capturedShutdownHandler: (() => Promise<void>) | null = null;

vi.mock("../tools/delegate", () => ({
  registerDelegateTool: vi.fn(
    (
      _pi: unknown,
      sessionStore: Map<string, SessionRecord>,
      registerSession: (s: SubagentSessionData) => void,
      getActiveSessionIds: () => Set<string>,
    ) => {
      capturedSessionStore = sessionStore;
      capturedRegisterSession = registerSession;
      capturedGetActiveSessionIds = getActiveSessionIds;
    },
  ),
}));

vi.mock("../tools/retrieval", () => ({
  registerRetrievalTools: vi.fn(),
}));

vi.mock("../commands/profile", () => ({
  registerProfileCommand: vi.fn(),
}));

// ── Tests ──────────────────────────────────────────────────────────

describe("index.ts — default export", () => {
  let mockPi: ExtensionAPI;

  beforeEach(async () => {
    vi.clearAllMocks();
    capturedSessionStore = null;
    capturedShutdownHandler = null;

    mockPi = createMockPi();

    // Import the default export fresh so beforeEach gets clean state
    const mod = await import("../index");
    mod.default(mockPi);

    // Capture the session_shutdown handler
    const onCalls = vi.mocked(mockPi.on).mock.calls as [string, any][];
    const shutdownCall = onCalls.find(([event]) => event === "session_shutdown");
    if (shutdownCall) {
      capturedShutdownHandler = shutdownCall[1] as () => Promise<void>;
    }
  });

  // ── session_shutdown handler ─────────────────────────────────────

  describe("session_shutdown handler", () => {
    it("should clear the session store when invoked", async () => {
      // Add some sessions
      capturedRegisterSession(makeSession({ sessionId: "s1" }));
      capturedRegisterSession(makeSession({ sessionId: "s2" }));
      expect(capturedSessionStore!.size).toBe(2);

      // Trigger shutdown
      await capturedShutdownHandler!();

      expect(capturedSessionStore!.size).toBe(0);
    });
  });

  // ── registerSession — new session creation ───────────────────────

  describe("registerSession — new session creation", () => {
    it("should create a new entry in the session store", () => {
      const session = makeSession({ sessionId: "new-1" });
      capturedRegisterSession(session);

      expect(capturedSessionStore!.has("new-1")).toBe(true);
    });

    it("should store the session in a SessionRecord with one run", () => {
      const session = makeSession({ sessionId: "new-2" });
      capturedRegisterSession(session);

      const record = capturedSessionStore!.get("new-2")!;
      expect(record.runs).toHaveLength(1);
      expect(record.runs[0]).toBe(session);
    });

    it("should store multiple distinct sessions", () => {
      capturedRegisterSession(makeSession({ sessionId: "a" }));
      capturedRegisterSession(makeSession({ sessionId: "b" }));
      capturedRegisterSession(makeSession({ sessionId: "c" }));

      expect(capturedSessionStore!.size).toBe(3);
      expect(capturedSessionStore!.get("a")!.runs).toHaveLength(1);
      expect(capturedSessionStore!.get("b")!.runs).toHaveLength(1);
      expect(capturedSessionStore!.get("c")!.runs).toHaveLength(1);
    });
  });

  // ── registerSession — resume (appending to existing) ─────────────

  describe("registerSession — resume (appending)", () => {
    it("should append a run to an existing session record", () => {
      const first = makeSession({ sessionId: "resume-1", status: "completed" });
      capturedRegisterSession(first);

      const second = makeSession({ sessionId: "resume-1", status: "running" });
      capturedRegisterSession(second);

      const record = capturedSessionStore!.get("resume-1")!;
      expect(record.runs).toHaveLength(2);
      expect(record.runs[0]).toBe(first);
      expect(record.runs[1]).toBe(second);
    });

    it("should not increase the store size when resuming", () => {
      capturedRegisterSession(makeSession({ sessionId: "resume-2" }));
      expect(capturedSessionStore!.size).toBe(1);

      capturedRegisterSession(makeSession({ sessionId: "resume-2" }));
      expect(capturedSessionStore!.size).toBe(1);
    });

    it("should preserve chronological order of runs", () => {
      const first = makeSession({ sessionId: "resume-3", startedAt: 1000 });
      const second = makeSession({ sessionId: "resume-3", startedAt: 2000 });
      const third = makeSession({ sessionId: "resume-3", startedAt: 3000 });

      capturedRegisterSession(first);
      capturedRegisterSession(second);
      capturedRegisterSession(third);

      const record = capturedSessionStore!.get("resume-3")!;
      expect(record.runs).toHaveLength(3);
      expect(record.runs[0].startedAt).toBe(1000);
      expect(record.runs[1].startedAt).toBe(2000);
      expect(record.runs[2].startedAt).toBe(3000);
    });
  });

  // ── registerSession — run capping (MAX_RUNS_PER_SESSION=10) ──────

  describe("registerSession — run capping at MAX_RUNS_PER_SESSION=10", () => {
    it("should keep exactly 10 runs when the cap is exceeded", () => {
      const sessionId = "capped-session";

      // Insert 12 runs
      for (let i = 0; i < 12; i++) {
        capturedRegisterSession(
          makeSession({ sessionId, startedAt: i * 1000, taskName: `run-${i}` }),
        );
      }

      const record = capturedSessionStore!.get(sessionId)!;
      expect(record.runs).toHaveLength(10);
    });

    it("should evict the oldest runs first (FIFO)", () => {
      const sessionId = "fifo-session";

      for (let i = 0; i < 12; i++) {
        capturedRegisterSession(
          makeSession({ sessionId, startedAt: i * 1000, taskName: `run-${i}` }),
        );
      }

      const record = capturedSessionStore!.get(sessionId)!;

      // The first two runs (run-0, run-1) should have been evicted
      expect(record.runs[0].taskName).toBe("run-2");
      expect(record.runs[9].taskName).toBe("run-11");
    });

    it("should not drop runs when at exactly 10", () => {
      const sessionId = "exact-cap";

      for (let i = 0; i < 10; i++) {
        capturedRegisterSession(
          makeSession({ sessionId, startedAt: i * 1000, taskName: `run-${i}` }),
        );
      }

      const record = capturedSessionStore!.get(sessionId)!;
      expect(record.runs).toHaveLength(10);
      expect(record.runs[0].taskName).toBe("run-0");
      expect(record.runs[9].taskName).toBe("run-9");
    });

    it("should cap correctly when adding run 11 after eviction brought it to 10", () => {
      const sessionId = "cap-then-add";

      // Add 11 runs to trigger one eviction
      for (let i = 0; i < 11; i++) {
        capturedRegisterSession(
          makeSession({ sessionId, startedAt: i * 1000, taskName: `run-${i}` }),
        );
      }

      // Should be 10 after eviction of run-0
      let record = capturedSessionStore!.get(sessionId)!;
      expect(record.runs).toHaveLength(10);
      expect(record.runs[0].taskName).toBe("run-1");

      // Add one more
      capturedRegisterSession(makeSession({ sessionId, startedAt: 11000, taskName: "run-11" }));

      record = capturedSessionStore!.get(sessionId)!;
      expect(record.runs).toHaveLength(10);
      expect(record.runs[0].taskName).toBe("run-2");
      expect(record.runs[9].taskName).toBe("run-11");
    });
  });

  // ── registerSession — LRU eviction (MAX_STORED_SESSIONS=32) ──────

  describe("registerSession — LRU eviction at MAX_STORED_SESSIONS=32", () => {
    it("should evict the oldest session when store is full", () => {
      // Fill to 32
      for (let i = 0; i < 32; i++) {
        capturedRegisterSession(makeSession({ sessionId: `fill-${i}`, startedAt: i * 1000 }));
      }
      expect(capturedSessionStore!.size).toBe(32);

      // Add one more — should evict the one with the oldest first run (fill-0)
      capturedRegisterSession(makeSession({ sessionId: "overflow-1", startedAt: 32000 }));

      expect(capturedSessionStore!.size).toBe(32);
      expect(capturedSessionStore!.has("fill-0")).toBe(false);
      expect(capturedSessionStore!.has("overflow-1")).toBe(true);
    });

    it("should keep the 32 most recently created sessions", () => {
      for (let i = 0; i < 33; i++) {
        capturedRegisterSession(makeSession({ sessionId: `recent-${i}`, startedAt: i * 1000 }));
      }

      // Only recent-0 should have been evicted
      expect(capturedSessionStore!.has("recent-0")).toBe(false);
      for (let i = 1; i < 33; i++) {
        expect(capturedSessionStore!.has(`recent-${i}`)).toBe(true);
      }
    });

    it("should correctly evict based on the oldest first run's startedAt", () => {
      // Create session A with a very old timestamp
      capturedRegisterSession(makeSession({ sessionId: "ancient", startedAt: 100 }));

      // Create session B with a newer timestamp
      capturedRegisterSession(makeSession({ sessionId: "newer", startedAt: 9000 }));

      // Fill up to 32 total
      for (let i = 2; i < 32; i++) {
        capturedRegisterSession(makeSession({ sessionId: `mid-${i}`, startedAt: 2000 + i * 100 }));
      }

      expect(capturedSessionStore!.size).toBe(32);

      // Add one more — "ancient" (startedAt=100) should be evicted
      capturedRegisterSession(makeSession({ sessionId: "trigger-eviction", startedAt: 30000 }));

      expect(capturedSessionStore!.size).toBe(32);
      expect(capturedSessionStore!.has("ancient")).toBe(false);
      expect(capturedSessionStore!.has("newer")).toBe(true);
      expect(capturedSessionStore!.has("trigger-eviction")).toBe(true);
    });

    it("should handle multiple evictions over successive inserts", () => {
      // Fill store completely
      for (let i = 0; i < 32; i++) {
        capturedRegisterSession(makeSession({ sessionId: `base-${i}`, startedAt: i * 1000 }));
      }

      // Insert 5 more, evicting 5 oldest
      for (let i = 0; i < 5; i++) {
        capturedRegisterSession(
          makeSession({ sessionId: `extra-${i}`, startedAt: 32000 + i * 1000 }),
        );
      }

      expect(capturedSessionStore!.size).toBe(32);

      // base-0 through base-4 should have been evicted
      for (let i = 0; i < 5; i++) {
        expect(capturedSessionStore!.has(`base-${i}`)).toBe(false);
      }
      // base-5 through base-31 plus extra-0 through extra-4 = 27 + 5 = 32
      for (let i = 5; i < 32; i++) {
        expect(capturedSessionStore!.has(`base-${i}`)).toBe(true);
      }
      for (let i = 0; i < 5; i++) {
        expect(capturedSessionStore!.has(`extra-${i}`)).toBe(true);
      }
    });

    it("should not evict a session that has a running task", () => {
      // Fill to 32 sessions; the first one is marked as running
      capturedRegisterSession(
        makeSession({ sessionId: "running-old", startedAt: 100, status: "running" }),
      );
      for (let i = 1; i < 32; i++) {
        capturedRegisterSession(
          makeSession({ sessionId: `fill-${i}`, startedAt: 1000 + i * 1000, status: "completed" }),
        );
      }
      expect(capturedSessionStore!.size).toBe(32);

      // Add a 33rd session — the running-old session should NOT be evicted
      // even though it has the oldest startedAt; a non-running session should be evicted instead
      capturedRegisterSession(makeSession({ sessionId: "overflow-new", startedAt: 33000 }));

      expect(capturedSessionStore!.size).toBe(32);
      expect(capturedSessionStore!.has("running-old")).toBe(true);
      expect(capturedSessionStore!.has("overflow-new")).toBe(true);
      // The oldest non-running session (fill-1) should have been evicted instead
      expect(capturedSessionStore!.has("fill-1")).toBe(false);
    });

    it("should not evict any session when store is below the limit", () => {
      for (let i = 0; i < 31; i++) {
        capturedRegisterSession(makeSession({ sessionId: `under-${i}`, startedAt: i * 1000 }));
      }

      expect(capturedSessionStore!.size).toBe(31);

      // Add one more (32nd) — still at limit, no eviction
      capturedRegisterSession(makeSession({ sessionId: "thirty-second", startedAt: 31000 }));

      expect(capturedSessionStore!.size).toBe(32);
      expect(capturedSessionStore!.has("under-0")).toBe(true);
    });
  });

  // ── getActiveSessionIds — returns IDs of running sessions ────────

  describe("getActiveSessionIds — running sessions", () => {
    it("should return a Set of session IDs with running status", () => {
      capturedRegisterSession(makeSession({ sessionId: "running-1", status: "running" }));
      capturedRegisterSession(makeSession({ sessionId: "running-2", status: "running" }));

      const active = capturedGetActiveSessionIds();
      expect(active).toBeInstanceOf(Set);
      expect(active.size).toBe(2);
      expect(active.has("running-1")).toBe(true);
      expect(active.has("running-2")).toBe(true);
    });

    it("should include a session if any of its runs is running", () => {
      capturedRegisterSession(makeSession({ sessionId: "multi-run", status: "completed" }));
      capturedRegisterSession(makeSession({ sessionId: "multi-run", status: "running" }));

      const active = capturedGetActiveSessionIds();
      expect(active.has("multi-run")).toBe(true);
    });
  });

  // ── getActiveSessionIds — excludes completed/error sessions ──────

  describe("getActiveSessionIds — excludes completed/error sessions", () => {
    it("should return empty set when there are no running sessions", () => {
      capturedRegisterSession(makeSession({ sessionId: "done-1", status: "completed" }));
      capturedRegisterSession(makeSession({ sessionId: "done-2", status: "completed" }));

      const active = capturedGetActiveSessionIds();
      expect(active.size).toBe(0);
    });

    it("should exclude completed sessions", () => {
      capturedRegisterSession(makeSession({ sessionId: "completed-only", status: "completed" }));

      const active = capturedGetActiveSessionIds();
      expect(active.has("completed-only")).toBe(false);
    });

    it("should exclude error sessions", () => {
      capturedRegisterSession(makeSession({ sessionId: "errored", status: "error" }));

      const active = capturedGetActiveSessionIds();
      expect(active.has("errored")).toBe(false);
    });

    it("should return only the running sessions from a mixed set", () => {
      capturedRegisterSession(makeSession({ sessionId: "s-running", status: "running" }));
      capturedRegisterSession(makeSession({ sessionId: "s-completed", status: "completed" }));
      capturedRegisterSession(makeSession({ sessionId: "s-error", status: "error" }));

      const active = capturedGetActiveSessionIds();
      expect(active.size).toBe(1);
      expect(active.has("s-running")).toBe(true);
      expect(active.has("s-completed")).toBe(false);
      expect(active.has("s-error")).toBe(false);
    });

    it("should return empty set when store is empty", () => {
      const active = capturedGetActiveSessionIds();
      expect(active.size).toBe(0);
    });
  });

  // ── getActiveSessionIds — multi-run sessions ────────────────────────

  describe("getActiveSessionIds — multi-run sessions", () => {
    it("should include session when middle run is running", () => {
      capturedRegisterSession(
        makeSession({ sessionId: "multi-1", status: "completed", startedAt: 1000 }),
      );
      capturedRegisterSession(
        makeSession({ sessionId: "multi-1", status: "running", startedAt: 2000 }),
      );
      capturedRegisterSession(
        makeSession({ sessionId: "multi-1", status: "completed", startedAt: 3000 }),
      );

      const active = capturedGetActiveSessionIds();
      expect(active.has("multi-1")).toBe(true);
    });

    it("should exclude session when all 10 runs are completed", () => {
      const sessionId = "all-done";
      for (let i = 0; i < 10; i++) {
        capturedRegisterSession(
          makeSession({ sessionId, status: "completed", startedAt: i * 1000 }),
        );
      }

      const active = capturedGetActiveSessionIds();
      expect(active.has(sessionId)).toBe(false);
      expect(active.size).toBe(0);
    });
  });

  // ── Tool/command registration ────────────────────────────────────

  describe("tool and command registration", () => {
    it("should register session_shutdown event handler", () => {
      expect(mockPi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
    });

    it("should register the delegate tool via registerDelegateTool", async () => {
      const { registerDelegateTool } = await import("../tools/delegate");
      expect(registerDelegateTool).toHaveBeenCalledWith(
        mockPi,
        expect.any(Map),
        expect.any(Function),
        expect.any(Function),
      );
    });

    it("should register retrieval tools via registerRetrievalTools", async () => {
      const { registerRetrievalTools } = await import("../tools/retrieval");
      expect(registerRetrievalTools).toHaveBeenCalledWith(mockPi, capturedSessionStore);
    });

    it("should register the profile command via registerProfileCommand", async () => {
      const { registerProfileCommand } = await import("../commands/profile");
      expect(registerProfileCommand).toHaveBeenCalledWith(mockPi);
    });

    it("should pass the same sessionStore to delegate and retrieval tools", async () => {
      const { registerRetrievalTools } = await import("../tools/retrieval");
      const retrievalCall = vi.mocked(registerRetrievalTools).mock.calls[0];
      expect(retrievalCall[1]).toBe(capturedSessionStore);
    });
  });
});
