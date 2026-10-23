import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { createDashboardComponent, getDashboardSnapshot, updateDashboard } from "./ui.ts";

describe("OGO dashboard UI", () => {
	test("renders distinct live agent and budget panes and refreshes on state changes", () => {
		let renders = 0;
		let closed = false;
		const tui = { requestRender: () => renders++ } as unknown as TUI;
		const theme = {
			fg: (_color: string, text: string) => text,
			bg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as unknown as Theme;
		updateDashboard({
			agent: ["Delegate • scout • opencode-go/model", "Found relevant code paths."],
			budget: ["OGO budget: yellow | T2", "5h [###.........] 25%"],
		});
		const component = createDashboardComponent(tui, theme, () => closed = true);
		const output = component.render(100).join("\n");

		expect(output).toContain("Agent output");
		expect(output).toContain("OGO budget");
		expect(output).toContain("Found relevant code paths.");
		expect(output).toContain("OGO budget: yellow | T2");
		component.handleInput?.("\u001b");
		expect(closed).toBe(true);

		updateDashboard({ agent: ["Conductor • opencode-go/next-model", "Updated response."] });
		expect(renders).toBe(1);
		expect(getDashboardSnapshot().agent).toContain("Updated response.");
		component.dispose();
	});
});
