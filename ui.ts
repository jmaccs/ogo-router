import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import { writeFile, rename } from "node:fs/promises";

import { getStateFile } from "./state.ts";

export type Pressure = "green" | "yellow" | "orange" | "red";
export type BudgetView = {
  pressure: Pressure;
  model?: string;
  tier?: number;
  windows: { label: string; used: number; limit: number }[];
  pace: string;
  source: string;
  status: string[];
  notes: string[];
};
export type DelegateView = {
  role: string;
  model?: string;
  status: "running" | "done" | "failed";
  last: string[];
};
export type DashboardSnapshot = {
  budget?: BudgetView;
  agent: string[];
  delegates: Record<string, DelegateView>;
};

export function updateDelegate(id: string, patch: Partial<DelegateView>) {
  const prev = snapshot.delegates[id] ?? {
    role: "?",
    status: "running" as const,
    last: [],
  };
  updateDashboard({
    delegates: { ...snapshot.delegates, [id]: { ...prev, ...patch } },
  });
}

export function removeDelegate(id: string) {
  const { [id]: _gone, ...rest } = snapshot.delegates;
  updateDashboard({ delegates: rest });
}

let snapshot: DashboardSnapshot = { agent: [], delegates: {} };
const listeners = new Set<() => void>();
let scheduled = false;

export function updateDashboard(patch: Partial<DashboardSnapshot>) {
  snapshot = { ...snapshot, ...patch };
  scheduleWrite();
}

export function getDashboardSnapshot(): DashboardSnapshot {
  return snapshot;
}
let timer: NodeJS.Timeout | undefined;
function scheduleWrite() {
  if (timer) return;
  timer = setTimeout(async () => {
    timer = undefined;
    const stateFile = getStateFile();
    const tmp = `${stateFile}.tmp`;
    await writeFile(tmp, JSON.stringify(snapshot));
    await rename(tmp, stateFile); // atomic: the reader never sees a partial file
  }, 50);
}
const pressureColor = {
  green: "success",
  yellow: "warning",
  orange: "warning",
  red: "error",
} as const;

function bar(
  theme: Theme,
  used: number,
  limit: number,
  width: number,
  p: Pressure,
): string {
  const ratio = limit ? Math.min(used / limit, 1) : 0;
  const filled = Math.round(ratio * width);
  const color =
    ratio > 0.9
      ? "error"
      : ratio > 0.75
        ? "warning"
        : pressureColor[p === "red" ? "green" : p];
  return (
    theme.fg(color, "█".repeat(filled)) +
    theme.fg("dim", "░".repeat(width - filled)) +
    theme.fg("dim", ` ${Math.round(ratio * 100)}%`.padStart(5))
  );
}

function buildLines(theme: Theme, inner: number): string[] {
  const out: string[] = [];
  const heading = (t: string) =>
    out.push("", theme.fg("accent", theme.bold(t)));
  const b = snapshot.budget;

  out.push(theme.fg("accent", theme.bold("OGO")) + theme.fg("dim", "  router"));
  if (b) {
    const dot = theme.fg(pressureColor[b.pressure], "●");
    out.push(
      `${dot} ${b.pressure}${b.tier !== undefined ? theme.fg("dim", `  T${b.tier}`) : ""}`,
    );
    if (b.model) out.push(theme.fg("dim", b.model));

    heading("Usage");
    const labelW = Math.max(...b.windows.map((w) => w.label.length));
    for (const w of b.windows) {
      out.push(
        `${w.label.padEnd(labelW)} ${bar(theme, w.used, w.limit, inner - labelW - 7, b.pressure)}`,
      );
    }
    out.push(theme.fg("dim", b.pace), theme.fg("dim", b.source));
    for (const n of b.notes) out.push(theme.fg("warning", n));
  } else {
    out.push(theme.fg("dim", "Waiting for usage data…"));
  }

  if (snapshot.agent.length) {
    heading("Latest");
    out.push(...snapshot.agent.slice(-8).map((l) => theme.fg("dim", l)));
  }
  return out;
}

function createSidebar(
  tui: TUI,
  theme: Theme,
): Component & { dispose(): void } {
  const listener = () => tui.requestRender();
  listeners.add(listener);
  return {
    render(width) {
      const inner = Math.max(width - 3, 10); // rail + 1 pad each side
      const rail = theme.fg("accent", "│");
      return buildLines(theme, inner).map((line) => {
        const clipped = truncateToWidth(line, inner);
        const pad = " ".repeat(Math.max(inner - visibleWidth(clipped), 0));
        // opaque bg so the transcript never bleeds through
        return rail + theme.bg("customMessageBg", ` ${clipped}${pad} `);
      });
    },
    invalidate() {},
    handleInput() {}, // never consumes input
    dispose() {
      listeners.delete(listener);
    },
  };
}

type Handle = {
  setHidden(hidden: boolean): void;
  isHidden(): boolean;
  hide(): void;
};
let handle: Handle | undefined;

export function openOverlaySidebar(ctx: ExtensionContext): void {
  if (!ctx.hasUI || handle) return;
  // Deliberately NOT awaited: the promise only resolves when the overlay closes.
  void ctx.ui
    .custom<void>((tui, theme) => createSidebar(tui, theme), {
      overlay: true,
      onHandle: (h: Handle) => {
        handle = h;
      }, // verify name/shape in your version
      overlayOptions: {
        nonCapturing: true, // verify: keeps focus on the editor
        anchor: "right-center",
        width: 40,
        maxHeight: "100%",
        margin: 0,
        visible: (cols: number) => cols >= 120,
      },
    })
    .finally(() => {
      handle = undefined;
    });
}
export function registerDashboard(pi: ExtensionAPI): void {
  pi.registerCommand("ogo-ui", {
    description: "Toggle the OGO sidebar",
    handler: async (_args, ctx) => {
      if (!handle) return openOverlaySidebar(ctx);
      handle.setHidden(!handle.isHidden());
    },
  });
}
