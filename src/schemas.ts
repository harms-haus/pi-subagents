/**
 * pi-subagents Extension Schemas
 *
 * TypeBox schemas for tool parameter validation.
 */

import { Type } from "typebox";
import { MAX_PARALLEL_TASKS } from "./types";

// ── Schema ───────────────────────────────────────────────────────────

/** Schema for a single sub-agent task */
export const TaskSchema = Type.Object({
  name: Type.String({ description: "Display name for this sub-agent window" }),
  prompt: Type.String({ description: "The task/prompt to send to the sub-agent" }),
  cwd: Type.Optional(Type.String({ description: "Working directory for this sub-agent" })),
  profile: Type.Optional(
    Type.String({
      description: "Named subagent profile from settings (sets provider/model, system prompt, thinking level, etc.)",
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
