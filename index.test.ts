import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionVirtualModel,
} from "@earendil-works/pi-coding-agent";

describe("OGO router M1", () => {
	let tempHome: string;
	let originalHome: string | undefined;
	let originalDataDir: string | undefined;
	let originalApiKey: string | undefined;
	let originalFetch: typeof globalThis.fetch;
	let virtualModel: ExtensionVirtualModel<unknown> | undefined;
	let readDashboardSnapshot:
		| (() => { budget?: { source: string; status: string[]; notes: string[] } })
		| undefined;
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const status = new Map<string, string>();
	let widget: string[] = [];
	let notifications = 0;
	let models: Array<{ provider: string; id: string }> = [];
	let fetchAuthorization: string | null = null;
	let fetchStatus = 200;
	let usagePercent = { fiveHours: 10, week: 30, month: 20 };
	let tierByModel = new Map<string, number>();

	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			setStatus(key: string, value: string | undefined) {
				if (value === undefined) status.delete(key);
				else status.set(key, value);
			},
			setWidget(_key: string, content: string[] | undefined) {
				widget = content ?? [];
			},
			notify() {
				notifications++;
			},
			custom() {
				return Promise.resolve();
			},
		},
		modelRegistry: { getAvailable: () => models },
	} as unknown as ExtensionContext;

	async function invoke(event: string, data: unknown): Promise<void> {
		const handler = handlers.get(event);
		if (!handler) throw new Error(`Missing ${event} handler`);
		await handler(data, ctx);
	}

	function dashboard(): { source: string; status: string[]; notes: string[] } {
		const budget = readDashboardSnapshot?.().budget;
		if (!budget) throw new Error("Dashboard budget has not been initialized");
		return budget;
	}

	beforeAll(async () => {
		tempHome = await mkdtemp(join(tmpdir(), "ogo-router-test-"));
		originalHome = process.env.HOME;
		originalDataDir = process.env.OGO_ROUTER_DATA_DIR;
		originalApiKey = process.env.OPENCODE_API_KEY;
		originalFetch = globalThis.fetch;
		process.env.HOME = tempHome;
		process.env.OGO_ROUTER_DATA_DIR = join(tempHome, ".pi", "agent");
		delete process.env.OPENCODE_API_KEY;
		const config = (await Bun.file(new URL("./router.json", import.meta.url).pathname).json()) as {
			tierModels: Record<string, string[]>;
		};
		tierByModel = new Map(
			Object.entries(config.tierModels).flatMap(([tier, refs]) =>
				refs.map((ref) => [ref, Number(tier)] as const),
			),
		);
		models = Object.values(config.tierModels).flat().map((ref) => {
			const separator = ref.indexOf("/");
			return { provider: ref.slice(0, separator), id: ref.slice(separator + 1) };
		});
		globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
			if (String(input).includes("models.dev")) {
				return Response.json({
					"opencode-go": {
						models: {
							"glm-5.3-flash": { cost: { input: 0.15, output: 0.5 }, tool_call: true },
							"mimo-v2.5": { cost: { input: 0.14, output: 0.28 }, tool_call: true },
						},
					},
				});
			}
			fetchAuthorization = new Headers(init?.headers).get("Authorization");
			const now = Date.now();
			const payload = {
				usage: {
					rolling: { status: "ok", percent: usagePercent.fiveHours, resetsAt: new Date(now + 60 * 60 * 1000).toISOString() },
					weekly: { status: "ok", percent: usagePercent.week, resetsAt: new Date(now + 2 * 24 * 60 * 60 * 1000).toISOString() },
					monthly: { status: "ok", percent: usagePercent.month, resetsAt: new Date(now + 20 * 24 * 60 * 60 * 1000).toISOString() },
				},
			};
			return Response.json(fetchStatus === 200 ? payload : { error: "unavailable" }, { status: fetchStatus });
		}) as typeof globalThis.fetch;

		const extension = (await import("./index.ts")).default;
		readDashboardSnapshot = (await import("./ui.ts")).getDashboardSnapshot;
		const api = {
			registerVirtualModel(definition: ExtensionVirtualModel<unknown>) {
				virtualModel = definition;
			},
			registerTool() {},
			registerCommand() {},
			getAllTools: () => [],
			on(event: string, handler: unknown) {
				handlers.set(event, handler as (...args: unknown[]) => unknown);
				return () => {};
			},
		} as unknown as ExtensionAPI;
		extension(api);
	});

	afterAll(async () => {
		globalThis.fetch = originalFetch;
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		if (originalDataDir === undefined) delete process.env.OGO_ROUTER_DATA_DIR;
		else process.env.OGO_ROUTER_DATA_DIR = originalDataDir;
		if (originalApiKey === undefined) delete process.env.OPENCODE_API_KEY;
		else process.env.OPENCODE_API_KEY = originalApiKey;
		await rm(tempHome, { recursive: true, force: true });
	});

	test("routes requests and reconciles live snapshots with local pending usage", async () => {
		expect(virtualModel).toBeDefined();
		await invoke("session_start", { type: "session_start" });
		let budget = dashboard();
		expect(budget.source).toBeTruthy();
		expect(budget.status.join("\n")).toContain("API status");
		expect(budget.status.join("\n")).toContain("models.dev opencode-go:");
		expect(budget.notes.join("\n")).toContain("OPENCODE_API_KEY is not set");
		expect(widget).toEqual([]);
		expect(status.size).toBe(0);
		expect(notifications).toBe(0);

		const route = virtualModel!.route;
		const request = {
			model: { provider: "ogo", id: "auto" },
			thinkingLevel: "low",
			messages: [{ role: "user", content: "quick summary", timestamp: Date.now() }],
		};
		const routeContext = { modelRegistry: { getAvailable: () => models } } as unknown as ExtensionContext;

		const direct = await route({ ...request, reason: "direct" } as never, routeContext);
		expect(direct.model.id).toBe("glm-5.3-flash");
		const user = await route({ ...request, reason: "user" } as never, routeContext);
		expect(user.model.id).toBe("mimo-v2.5");
		const continuation = await route({
			...request,
			reason: "continuation",
			previous: { model: user.model, thinkingLevel: "low" },
			state: user.state,
		} as never, routeContext);
		expect(continuation.model.id).toBe(user.model.id);
		const retry = await route({
			...request,
			reason: "retry",
			state: user.state,
			failed: { model: user.model, message: { errorMessage: "quota exceeded" } },
		} as never, routeContext);
		expect(retry.model.id).toBe("longcat-2.0");
		process.env.OPENCODE_API_KEY = "mock-test-key";
		await invoke("session_start", { type: "session_start" });
		const allModels = models;
		models = [{ provider: "openrouter", id: "anthropic/claude-opus-4.8" }];
		const escalation = await route({
			...request,
			thinkingLevel: "high",
			messages: [{ role: "user", content: "ultrabrain formal verification", timestamp: Date.now() }],
			reason: "user",
		} as never, routeContext);
		expect(escalation.model.provider).toBe("openrouter");
		models = allModels;

		process.env.OPENCODE_API_KEY = "mock-test-key";
		await invoke("session_start", { type: "session_start" });
		expect(fetchAuthorization).toBe("Bearer mock-test-key");
		budget = dashboard();
		expect(budget.source).toContain("Go usage live");
		expect(budget.status.join("\n")).toContain("API status 5h ok");
		expect(budget.status.join("\n")).toContain("models.dev opencode-go:");
		expect(widget).toEqual([]);
		expect(status.size).toBe(0);
		expect(notifications).toBe(0);

		await invoke("message_end", {
			type: "message_end",
			message: {
				role: "assistant",
				provider: "opencode-go",
				model: "mimo-v2.5",
				usage: { cost: { total: 0 } },
				timestamp: Date.now(),
			},
		});
		budget = dashboard();
		expect(budget.status.join("\n")).toContain("Pi since sync: 5h 1");

		fetchStatus = 503;
		await invoke("session_start", { type: "session_start" });
		budget = dashboard();
		expect(budget.source).toContain("Go usage stale");
		expect(budget.status.join("\n")).toContain("Pi since sync: 5h 1");
		expect(status.size).toBe(0);
		expect(notifications).toBe(0);

		fetchStatus = 200;
		usagePercent = { fiveHours: 95, week: 30, month: 20 };
		await invoke("session_start", { type: "session_start" });
		budget = dashboard();
		expect(budget.source).toContain("Go usage live");
		expect(status.size).toBe(0);
		expect(notifications).toBe(0);
		const redBudgetRoute = await route({
			...request,
			thinkingLevel: "high",
			messages: [{ role: "user", content: "ultrabrain formal verification", timestamp: Date.now() }],
			reason: "user",
		} as never, routeContext);
		expect(tierByModel.get(`${redBudgetRoute.model.provider}/${redBudgetRoute.model.id}`)).toBeLessThanOrEqual(1);
		const ledger = await readFile(join(tempHome, ".pi", "agent", "ogo-router-usage.jsonl"), "utf8");
		expect(JSON.parse(ledger.trim()).recordedAt).toBeNumber();
	});
});
