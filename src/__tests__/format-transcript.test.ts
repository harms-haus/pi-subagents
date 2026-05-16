/**
 * Tests for formatRunsForResume and getTextContent in src/format-transcript.ts
 */

import { describe, expect, it } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import type { SubagentSessionData } from "../types";
import { formatRunsForResume } from "../format-transcript";

// ── formatRunsForResume ────────────────────────────────────────────────

describe("formatRunsForResume", () => {
	/** Helper to create a SubagentSessionData with given messages */
	function makeRun(
		overrides: Partial<Omit<SubagentSessionData, "sessionId">> & {
			sessionId?: string;
		} = {},
	): SubagentSessionData {
		return {
			sessionId: `run-${Math.random().toString(36).slice(2, 8)}`,
			taskName: "test-task",
			prompt: "test prompt",
			startedAt: Date.now(),
			messages: [],
			status: "completed",
			exitCode: 0,
			...overrides,
		};
	}

	it("should return empty string for empty runs array", () => {
		expect(formatRunsForResume([])).toBe("");
	});

	it("should format a single run with user messages", () => {
		const run = makeRun({
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Please do something" }],
				} as unknown as Message,
			],
		});

		const result = formatRunsForResume([run]);

		// Single run should NOT have run separator
		expect(result).not.toContain("--- Run");
		expect(result).toContain("User: Please do something");
	});

	it("should format assistant text messages", () => {
		const run = makeRun({
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "I will help you with that." }],
				} as unknown as Message,
			],
		});

		const result = formatRunsForResume([run]);

		expect(result).toContain("Assistant: I will help you with that.");
	});

	it("should extract tool calls from assistant messages", () => {
		const run = makeRun({
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "text", text: "Let me check." },
						{
							type: "toolCall",
							name: "read_file",
							arguments: { path: "/tmp/test.txt" },
						},
					],
				} as unknown as Message,
			],
		});

		const result = formatRunsForResume([run]);

		expect(result).toContain("Assistant: Let me check.");
		expect(result).toContain("Tool Call: read_file");
		expect(result).toContain("path");
	});

	it("should truncate tool call arguments at 120 chars in the JSON representation", () => {
		const longArgs = { data: "x".repeat(200) };
		const run = makeRun({
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "toolCall", name: "big_tool", arguments: longArgs },
					],
				} as unknown as Message,
			],
		});

		const result = formatRunsForResume([run]);

		// The args JSON is truncated to 120 chars: the JSON.stringify is sliced at 120
		const toolCallLine = result
			.split("\n\n")
			.find((l) => l.startsWith("Tool Call: big_tool"));
		expect(toolCallLine).toBeDefined();
		// After the tool name, the remaining content (args JSON) should be <= 120 chars
		const argsPart = toolCallLine!.slice(`Tool Call: big_tool(`.length, -1); // remove trailing )
		expect(argsPart.length).toBeLessThanOrEqual(120);
	});

	it("should format tool result messages", () => {
		const run = makeRun({
			messages: [
				{
					role: "toolResult",
					content: [{ type: "text", text: "file contents here" }],
				} as unknown as Message,
			],
		});

		const result = formatRunsForResume([run]);

		expect(result).toContain("Tool Result: file contents here");
	});

	it("should truncate tool result text at 500 chars", () => {
		const longText = "A".repeat(600);
		const run = makeRun({
			messages: [
				{
					role: "toolResult",
					content: [{ type: "text", text: longText }],
				} as unknown as Message,
			],
		});

		const result = formatRunsForResume([run]);

		expect(result).toContain("Tool Result: ");
		// Should be truncated to 500 chars + "..."
		const toolResultLine = result
			.split("\n\n")
			.find((l) => l.startsWith("Tool Result:"));
		expect(toolResultLine).toBeDefined();
		const truncatedText = toolResultLine!.slice("Tool Result: ".length);
		expect(truncatedText).toBe(`${"A".repeat(500)}...`);
		expect(truncatedText.length).toBe(503); // 500 + 3 for "..."
	});

	it("should not truncate tool result text under 500 chars", () => {
		const shortText = "A".repeat(499);
		const run = makeRun({
			messages: [
				{
					role: "toolResult",
					content: [{ type: "text", text: shortText }],
				} as unknown as Message,
			],
		});

		const result = formatRunsForResume([run]);

		const toolResultLine = result
			.split("\n\n")
			.find((l) => l.startsWith("Tool Result:"));
		expect(toolResultLine).toBeDefined();
		const text = (toolResultLine ?? "").slice("Tool Result: ".length);
		expect(text).toBe(shortText);
		expect(text).not.toContain("...");
	});

	it("should include run separators for multiple runs", () => {
		const run1 = makeRun({
			messages: [
				{ role: "user", content: [{ type: "text", text: "first prompt" }] } as unknown as Message,
			],
		});
		const run2 = makeRun({
			messages: [
				{ role: "user", content: [{ type: "text", text: "second prompt" }] } as unknown as Message,
			],
		});

		const result = formatRunsForResume([run1, run2]);

		expect(result).toContain("--- Run 1");
		expect(result).toContain("--- Run 2");
		expect(result).toContain("User: first prompt");
		expect(result).toContain("User: second prompt");
	});

	it("should show status and message count in run separator", () => {
		const run = makeRun({
			status: "completed",
			messages: [
				{ role: "user", content: [{ type: "text", text: "hi" }] } as unknown as Message,
				{ role: "assistant", content: [{ type: "text", text: "hello" }] } as unknown as Message,
			],
		});

		const result = formatRunsForResume([run, run]);

		// With 2 runs, separators are added
		expect(result).toContain("completed, 2 messages");
	});

	it("should include error message at end of run", () => {
		const run = makeRun({
			status: "error",
			errorMessage: "Process timed out",
			messages: [
				{ role: "user", content: [{ type: "text", text: "do work" }] } as unknown as Message,
			],
		});

		const result = formatRunsForResume([run]);

		expect(result).toContain("[Error: Process timed out]");
	});

	it("should not include error section when errorMessage is undefined", () => {
		const run = makeRun({
			status: "completed",
			errorMessage: undefined,
			messages: [
				{ role: "user", content: [{ type: "text", text: "do work" }] } as unknown as Message,
			],
		});

		const result = formatRunsForResume([run]);

		expect(result).not.toContain("[Error:");
	});

	it("should handle messages with string content", () => {
		const run = makeRun({
			messages: [
				{ role: "user", content: "plain string content" } as any,
			],
		});

		const result = formatRunsForResume([run]);

		expect(result).toContain("User: plain string content");
	});

	it("should skip messages with no extractable text", () => {
		const run = makeRun({
			messages: [
				{
					role: "user",
					content: [],
				} as unknown as Message,
			],
		});

		const result = formatRunsForResume([run]);

		expect(result).toBe("");
	});

	it("should join text parts from array content with newlines", () => {
		const run = makeRun({
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "text", text: "Part one" },
						{ type: "text", text: "Part two" },
					],
				} as unknown as Message,
			],
		});

		const result = formatRunsForResume([run]);

		expect(result).toContain("Assistant: Part one\nPart two");
	});

	it("should handle tool calls without arguments", () => {
		const run = makeRun({
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", name: "simple_tool" }],
				} as unknown as Message,
			],
		});

		const result = formatRunsForResume([run]);

		expect(result).toContain("Tool Call: simple_tool({})");
	});

	it("should format a full conversation with mixed message types", () => {
		const run = makeRun({
			status: "completed",
			messages: [
				{ role: "user", content: [{ type: "text", text: "Read the file" }] } as unknown as Message,
				{
					role: "assistant",
					content: [
						{ type: "text", text: "I'll read it for you." },
						{
							type: "toolCall",
							name: "read",
							arguments: { path: "/tmp/test.txt" },
						},
					],
				} as unknown as Message,
				{
					role: "toolResult",
					content: [{ type: "text", text: "Hello World" }],
				} as unknown as Message,
				{
					role: "assistant",
					content: [{ type: "text", text: "The file contains: Hello World" }],
				} as unknown as Message,
			],
		});

		const result = formatRunsForResume([run]);

		expect(result).toContain("User: Read the file");
		expect(result).toContain("Assistant: I'll read it for you.");
		expect(result).toContain("Tool Call: read");
		expect(result).toContain("Tool Result: Hello World");
		expect(result).toContain("Assistant: The file contains: Hello World");
	});

	it("should separate parts with double newlines", () => {
		const run = makeRun({
			messages: [
				{ role: "user", content: [{ type: "text", text: "msg1" }] } as unknown as Message,
				{ role: "assistant", content: [{ type: "text", text: "msg2" }] } as unknown as Message,
			],
		});

		const result = formatRunsForResume([run]);

		expect(result).toBe("User: msg1\n\nAssistant: msg2");
	});

	it("should handle tool result at exactly 500 chars without truncation", () => {
		const exactText = "B".repeat(500);
		const run = makeRun({
			messages: [
				{
					role: "toolResult",
					content: [{ type: "text", text: exactText }],
				} as unknown as Message,
			],
		});

		const result = formatRunsForResume([run]);

		const toolResultLine = result
			.split("\n\n")
			.find((l) => l.startsWith("Tool Result:"));
		expect(toolResultLine).toBeDefined();
		const text = (toolResultLine ?? "").slice("Tool Result: ".length);
		expect(text).toBe(exactText);
		expect(text).not.toContain("...");
	});

	it("should handle tool result at 501 chars with truncation", () => {
		const text501 = "C".repeat(501);
		const run = makeRun({
			messages: [
				{
					role: "toolResult",
					content: [{ type: "text", text: text501 }],
				} as unknown as Message,
			],
		});

		const result = formatRunsForResume([run]);

		const toolResultLine = result
			.split("\n\n")
			.find((l) => l.startsWith("Tool Result:"));
		expect(toolResultLine).toBeDefined();
		const text = (toolResultLine ?? "").slice("Tool Result: ".length);
		expect(text).toBe(`${"C".repeat(500)}...`);
	});

	it("should not produce run separator header for a single run", () => {
		const run = makeRun({
			messages: [{ role: "user", content: [{ type: "text", text: "hello" }] } as unknown as Message],
		});

		const result = formatRunsForResume([run]);

		expect(result).not.toContain("--- Run");
		expect(result).toBe("User: hello");
	});
});
