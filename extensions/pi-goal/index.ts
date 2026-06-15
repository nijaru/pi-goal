/**
 * pi-goal — Pi Extension
 *
 * Persistent loop. Define what "done" means, agent works until it's done.
 *
 * Provides:
 * - `/goal` command — set, view, pause, resume, clear goals
 * - `get_goal` tool — read current goal state
 * - `update_goal` tool — mark goal complete
 * - Auto-continue loop — agent keeps working until done
 * - Adversarial evaluation — different model checks completion
 * - Ideas backlog — prevent random walk
 * - Git-native keep/revert — commit on keep, reset on discard
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";

// Types

type GoalStatus = "pursuing" | "paused" | "achieved" | "unmet" | "budget_limited";

interface GoalState {
  id: string;
  objective: string;
  status: GoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  iterations: number;
  createdAt: string;
  updatedAt: string;
}

// TODO: Implement
// - Goal lifecycle (set, pause, resume, clear)
// - Auto-continue loop
// - Adversarial evaluation
// - Ideas backlog
// - Git-native keep/revert
// - Iteration log (journal.md)
// - Dashboard widget

export default function piGoal(pi: ExtensionAPI) {
  // Register /goal command
  pi.registerCommand("goal", {
    description: "Set, view, pause, resume, or clear a persistent goal",
    handler: async (args, ctx) => {
      // TODO: implement
      ctx.ui.notify("pi-goal: not yet implemented", "warning");
    },
  });

  // Register tools
  pi.registerTool({
    name: "get_goal",
    label: "Get Goal",
    description: "Read the current goal state and iteration history.",
    parameters: Type.Object({}),
    async execute() {
      // TODO: implement
      return { content: [{ type: "text", text: "No goal set." }] };
    },
  });

  pi.registerTool({
    name: "update_goal",
    label: "Update Goal",
    description: "Mark the current goal complete after adversarial evaluation.",
    parameters: Type.Object({
      status: Type.String({ enum: ["complete"] }),
    }),
    async execute(_id, params) {
      // TODO: implement
      return { content: [{ type: "text", text: "Not yet implemented." }] };
    },
  });
}
