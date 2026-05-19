/**
 * pi-subagents Extension Schemas
 *
 * TypeBox schemas for tool parameter validation.
 */

import { Type } from "typebox";
import { MAX_PARALLEL_TASKS } from "./types";

// ── Schema ───────────────────────────────────────────────────────────

/** Schema for a file range spec: { path, start?, end? } */
const FileRangeSchema = Type.Object({
  path: Type.String({ description: "File path (absolute or relative)" }),
  start: Type.Optional(Type.Number({ description: "1-indexed start line (inclusive)" })),
  end: Type.Optional(Type.Number({ description: "1-indexed end line (inclusive)" })),
});

/** Schema for a file tail spec: { path, tail } */
const FileTailSchema = Type.Object({
  path: Type.String({ description: "File path (absolute or relative)" }),
  tail: Type.Number({ description: "Number of lines from the end of the file", minimum: 1 }),
});

/** Schema for a file head spec: { path, head } */
const FileHeadSchema = Type.Object({
  path: Type.String({ description: "File path (absolute or relative)" }),
  head: Type.Number({ description: "Number of lines from the start of the file", minimum: 1 }),
});

/** Schema for a single file spec: string path, range object, tail object, or head object */
const FileSpecSchema = Type.Union([Type.String(), FileRangeSchema, FileTailSchema, FileHeadSchema]);

/** Schema for a single sub-agent task */
export const TaskSchema = Type.Object({
  name: Type.String({ description: "Display name for this sub-agent window" }),
  prompt: Type.String({ description: "The task/prompt to send to the sub-agent" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for this sub-agent" })),
  profile: Type.Optional(
    Type.String({
      description:
        "Named subagent profile from settings (sets provider/model, system prompt, thinking level, etc.)",
    }),
  ),
  timeout: Type.Optional(
    Type.Number({ description: "Timeout in seconds for this subagent (default 600)" }),
  ),
  resume: Type.Optional(Type.String({ description: "Previous session ID to resume from" })),
  files: Type.Optional(
    Type.Array(FileSpecSchema, {
      description:
        "Files to read and prepend to the prompt. Each entry can be a path string or an object with path and range options (head, tail, start/end).",
    }),
  ),
});

/** Schema for delegate_to_subagents tool parameters */
export const DelegateParams = Type.Object({
  tasks: Type.Array(TaskSchema, { minItems: 1, maxItems: MAX_PARALLEL_TASKS }),
  profile: Type.Optional(
    Type.String({
      description: "Default profile for all tasks (overridden by per-task profile)",
    }),
  ),
});
