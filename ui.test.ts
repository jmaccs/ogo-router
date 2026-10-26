import { describe, expect, test } from "bun:test";
import {
  getDashboardSnapshot,
  removeDelegate,
  updateDashboard,
  updateDelegate,
} from "./ui.ts";

describe("OGO dashboard UI", () => {
  test("tracks the tmux dashboard snapshot and delegate pane lifecycle", () => {
    const budget = {
      pressure: "yellow" as const,
      tier: 2,
      windows: [{ label: "5h", used: 25, limit: 100 }],
      pace: "On pace",
      source: "live",
      status: [
        "API status 5h ok | week ok | month ok",
        "Pi since sync: 5h 0, week 0, month 0 requests",
        "models.dev opencode-go: 34 models, checked 147m ago",
      ],
      notes: [],
    };
    updateDashboard({
      budget,
      agent: ["Conductor • opencode-go/model", "Working…"],
    });
    updateDelegate("task-1", {
      role: "scout",
      model: "opencode-go/model",
      status: "running",
      last: ["Inspecting relevant files."],
    });

    expect(getDashboardSnapshot()).toEqual({
      budget,
      agent: ["Conductor • opencode-go/model", "Working…"],
      delegates: {
        "task-1": {
          role: "scout",
          model: "opencode-go/model",
          status: "running",
          last: ["Inspecting relevant files."],
        },
      },
    });

    updateDelegate("task-1", {
      status: "done",
      last: ["Found relevant code paths."],
    });
    expect(getDashboardSnapshot().delegates["task-1"]).toEqual({
      role: "scout",
      model: "opencode-go/model",
      status: "done",
      last: ["Found relevant code paths."],
    });

    removeDelegate("task-1");
    expect(getDashboardSnapshot().delegates).toEqual({});
  });
});
