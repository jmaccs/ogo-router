import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	computeSnapshotMeter,
	parseGoUsageSnapshot,
	usageWindows,
	type GoUsageSnapshot,
	type UsageLedgerRecord,
	type UsageWindow,
} from "./usage.ts";

const root = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.OGO_ROUTER_DATA_DIR ?? join(homedir(), ".pi", "agent");
const ledgerPath = join(dataDir, "ogo-router-usage.jsonl");
const snapshotPath = join(dataDir, "ogo-router-usage-snapshot.json");
const refreshIntervalMs = 60_000;

type QuotaWindow = UsageWindow;
type Tier = 0 | 1 | 2 | 3;
type Pressure = "green" | "yellow" | "orange" | "red";
type ModelRef = { provider: string; id: string };
type CategoryConfig = { model: string; fallback_models: string[] };
type RouterState = {
	category: string;
	candidates: string[];
	budgetState: Pressure;
	retryCounts: Record<string, number>;
};
type LedgerEntry = UsageLedgerRecord & { cost: number };
type Quota = Record<QuotaWindow, number | null>;
type RouterConfig = {
	virtualProvider: string;
	virtualModel: string;
	goProvider: string;
	tierModels: Record<string, string[]>;
	escalationModels: string[];
	modelQuotas: Record<string, Quota>;
};
type Meter = {
	used: Record<QuotaWindow, number>;
	limit: Record<QuotaWindow, number>;
	pace: Record<QuotaWindow, number>;
	pressure: number;
	pending: Record<QuotaWindow, number>;
	source: "live" | "stale" | "estimate";
	fetchedAt?: number;
	windowStatus?: Record<QuotaWindow, string>;
};

let activePressure: Pressure | undefined;
let currentRoutedModel: string | undefined;
let lastNotifiedPressure: Pressure | undefined;
let latestSnapshot: GoUsageSnapshot | undefined;
let usageRefreshState: Meter["source"] = "estimate";
let lastUsageError: string | undefined;
let lastNotifiedUsageError: string | undefined;
let lastFetchAttemptAt = 0;
let usageStateLoaded = false;
let usageRefresh: Promise<void> | undefined;

function parseJson<T>(text: string, source: string): T {
	try {
		return JSON.parse(text) as T;
	} catch (error) {
		throw new Error(`Invalid JSON in ${source}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

const routerConfig = parseJson<RouterConfig>(
	await readFile(join(root, "router.json"), "utf8"),
	"router.json",
);
const categoryDocument = parseJson<{ categories?: unknown }>(
	await readFile(join(root, "ogo.json"), "utf8"),
	"ogo.json",
);

if (
	typeof routerConfig.virtualProvider !== "string" || !routerConfig.virtualProvider ||
	typeof routerConfig.virtualModel !== "string" || !routerConfig.virtualModel ||
	typeof routerConfig.goProvider !== "string" || !routerConfig.goProvider ||
	!routerConfig.tierModels || typeof routerConfig.tierModels !== "object" ||
	!Array.isArray(routerConfig.escalationModels) ||
	!routerConfig.modelQuotas || typeof routerConfig.modelQuotas !== "object"
) {
	throw new Error("router.json is missing required router settings");
}
if (!categoryDocument.categories || typeof categoryDocument.categories !== "object") {
	throw new Error('ogo.json must contain a "categories" object');
}
const categories = categoryDocument.categories as Record<string, CategoryConfig>;
for (const [tier, models] of Object.entries(routerConfig.tierModels)) {
	if (!["0", "1", "2", "3"].includes(tier) || !Array.isArray(models)) {
		throw new Error(`Invalid tier "${tier}" in router.json`);
	}
	for (const ref of models) {
		if (typeof ref !== "string") throw new Error(`Invalid model reference in tier ${tier}`);
		parseModelKey(ref);
	}
}
for (const [name, category] of Object.entries(categories)) {
	if (
		!category || typeof category.model !== "string" ||
		!Array.isArray(category.fallback_models) ||
		!category.fallback_models.every((model) => typeof model === "string")
	) {
		throw new Error(`Invalid category "${name}" in ogo.json`);
	}
	for (const ref of [category.model, ...category.fallback_models]) {
		parseModelKey(ref);
		if (tierOf(ref) === undefined) {
			throw new Error(`No tier is configured for ${ref}`);
		}
	}
}
for (const ref of routerConfig.escalationModels) {
	if (typeof ref !== "string" || tierOf(ref) === undefined) {
		throw new Error(`Invalid or un-tiered escalation model "${String(ref)}" in router.json`);
	}
}
for (const [ref, quota] of Object.entries(routerConfig.modelQuotas)) {
	parseModelKey(ref);
	for (const window of Object.keys(usageWindows) as QuotaWindow[]) {
		const value = quota?.[window];
		if (value !== null && (!Number.isFinite(value) || value < 0)) {
			throw new Error(`Invalid ${window} quota for ${ref} in router.json`);
		}
	}
}

function modelKey(ref: ModelRef): string {
	return `${ref.provider}/${ref.id}`;
}

function parseModelKey(key: string): ModelRef {
	const separator = key.indexOf("/");
	if (separator < 1 || separator === key.length - 1) {
		throw new Error(`Invalid model reference "${key}" in router configuration`);
	}
	return { provider: key.slice(0, separator), id: key.slice(separator + 1) };
}

function tierOf(key: string): Tier | undefined {
	for (const [tierText, models] of Object.entries(routerConfig.tierModels)) {
		if (!models.includes(key)) continue;
		const tier = Number(tierText);
		if (tier >= 0 && tier <= 3) return tier as Tier;
	}
	return undefined;
}

function getUserText(messages: readonly { role: string; content?: unknown }[]): string {
	const message = messages.findLast((item) => item.role === "user");
	if (!message) return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.flatMap((block) =>
			typeof block === "object" && block !== null && "type" in block && block.type === "text" &&
			"text" in block && typeof block.text === "string"
				? [block.text]
				: [],
		)
		.join("\n");
}

function classifyCategory(text: string, thinkingLevel: string): string {
	const lower = text.toLowerCase();
	if (/\b(ultrabrain|prove|formal verification|hardest|extremely difficult)\b/.test(lower)) {
		return "ultrabrain";
	}
	if (/\b(architecture|architect|system design|trade-?offs?)\b/.test(lower)) return "architect";
	if (/\b(deep dive|deep analysis|complex|difficult|debug|root cause)\b/.test(lower)) return "deep";
	if (/\b(visual|ui|ux|frontend|css|design system)\b/.test(lower)) return "visual-engineering";
	if (/\b(write|writing|rewrite|edit this|proofread|copyedit)\b/.test(lower)) return "writing";
	if (/\b(creative|illustration|artistry|brainstorm names)\b/.test(lower)) return "artistry";
	if (/\b(quick|brief|simple|small question|one-liner)\b/.test(lower)) return "quick";
	return thinkingLevel === "high" ? "unspecified-high" : "unspecified-low";
}

function parseLedgerEntry(value: unknown, line: number): LedgerEntry {
	if (
		typeof value !== "object" || value === null ||
		!("provider" in value) || typeof value.provider !== "string" ||
		!("model" in value) || typeof value.model !== "string" ||
		!("cost" in value) || typeof value.cost !== "number" || !Number.isFinite(value.cost) ||
		!("timestamp" in value) || typeof value.timestamp !== "number" || !Number.isFinite(value.timestamp) ||
		("recordedAt" in value && (typeof value.recordedAt !== "number" || !Number.isFinite(value.recordedAt)))
	) {
		throw new Error(`Invalid usage ledger entry on line ${line} (${ledgerPath})`);
	}
	const recordedAt = "recordedAt" in value ? value.recordedAt : undefined;
	return {
		provider: value.provider,
		model: value.model,
		cost: value.cost,
		timestamp: value.timestamp,
		recordedAt: typeof recordedAt === "number" ? recordedAt : undefined,
	};
}

async function readLedger(): Promise<LedgerEntry[]> {
	let contents: string;
	try {
		contents = await readFile(ledgerPath, "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return [];
		}
		throw error;
	}
	return contents.split("\n").flatMap((line, index) => {
		if (!line.trim()) return [];
		return [parseLedgerEntry(parseJson<unknown>(line, `${ledgerPath}:${index + 1}`), index + 1)];
	});
}

async function loadUsageState(): Promise<void> {
	if (usageStateLoaded) return;
	usageStateLoaded = true;
	let contents: string;
	try {
		contents = await readFile(snapshotPath, "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
		throw error;
	}
	try {
		const value = parseJson<unknown>(contents, snapshotPath);
		if (
			typeof value !== "object" || value === null ||
			!("fetchedAt" in value) || typeof value.fetchedAt !== "number" || !Number.isFinite(value.fetchedAt)
		) {
			throw new Error("stored usage snapshot has invalid timestamp");
		}
		latestSnapshot = parseGoUsageSnapshot(value, value.fetchedAt);
		usageRefreshState = "stale";
	} catch (error) {
		lastUsageError = error instanceof Error ? error.message : "Stored usage snapshot is invalid";
		usageRefreshState = "estimate";
	}
}

async function refreshUsage(force = false): Promise<void> {
	await loadUsageState();
	if (usageRefresh) return usageRefresh;
	if (!force && Date.now() - lastFetchAttemptAt < refreshIntervalMs) return;
	lastFetchAttemptAt = Date.now();

	const apiKey = process.env.OPENCODE_API_KEY;
	if (!apiKey) {
		usageRefreshState = latestSnapshot ? "stale" : "estimate";
		lastUsageError = "OPENCODE_API_KEY is not set";
		return;
	}

	usageRefresh = (async () => {
		const requestStartedAt = Date.now();
		let response: Response;
		try {
			response = await fetch("https://opencode.ai/zen/go/v1/usage", {
				headers: { Authorization: `Bearer ${apiKey}` },
				redirect: "error",
				signal: AbortSignal.timeout(5_000),
			});
		} catch (error) {
			lastUsageError = error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)
				? "usage endpoint request timed out"
				: "usage endpoint request failed";
			usageRefreshState = latestSnapshot ? "stale" : "estimate";
			return;
		}
		if (!response.ok) {
			lastUsageError = `usage endpoint returned HTTP ${response.status}`;
			usageRefreshState = latestSnapshot ? "stale" : "estimate";
			return;
		}
		let body: unknown;
		try {
			body = await response.json();
		} catch {
			lastUsageError = "usage endpoint returned invalid JSON";
			usageRefreshState = latestSnapshot ? "stale" : "estimate";
			return;
		}
		let nextSnapshot: GoUsageSnapshot;
		try {
			nextSnapshot = parseGoUsageSnapshot(body, requestStartedAt);
		} catch (error) {
			lastUsageError = error instanceof Error ? error.message : "usage endpoint returned invalid data";
			usageRefreshState = latestSnapshot ? "stale" : "estimate";
			return;
		}

		latestSnapshot = nextSnapshot;
		usageRefreshState = "live";
		lastUsageError = undefined;
		try {
			await mkdir(dataDir, { recursive: true });
			await writeFile(snapshotPath, `${JSON.stringify(nextSnapshot)}\n`, "utf8");
		} catch {
			lastUsageError = "could not persist usage snapshot";
		}
	})().finally(() => {
		usageRefresh = undefined;
	});
	await usageRefresh;
}

function windowStart(window: QuotaWindow, now: number): number {
	const date = new Date(now);
	if (window === "fiveHours") return Math.floor(now / usageWindows.fiveHours) * usageWindows.fiveHours;
	if (window === "week") {
		const day = (date.getUTCDay() + 6) % 7;
		return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day);
	}
	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function computeLocalMeter(entries: readonly LedgerEntry[], now = Date.now()): Meter {
	const used = { fiveHours: 0, week: 0, month: 0 };
	const limit = { fiveHours: 0, week: 0, month: 0 };
	const windowsList = Object.keys(usageWindows) as QuotaWindow[];
	for (const [key, quota] of Object.entries(routerConfig.modelQuotas)) {
		const { provider, id } = parseModelKey(key);
		const modelEntries = entries.filter((entry) => entry.provider === provider && entry.model === id);
		for (const window of windowsList) {
			const quotaLimit = quota[window];
			if (quotaLimit === null) continue;
			limit[window] += quotaLimit;
			const start = windowStart(window, now);
			used[window] += modelEntries.filter((entry) => entry.timestamp >= start && entry.timestamp <= now).length;
		}
	}
	const utilization = windowsList.map((window) => (limit[window] ? used[window] / limit[window] : 0));
	const elapsed = windowsList.map((window) => {
		const start = windowStart(window, now);
		return Math.max((now - start) / usageWindows[window], 0.01);
	});
	const paceValues = windowsList.map((_, index) => utilization[index]! / Math.max(elapsed[index]!, 0.01));
	const pace = Object.fromEntries(windowsList.map((window, index) => [window, paceValues[index]!])) as Record<
		QuotaWindow,
		number
	>;
	return {
		used,
		limit,
		pace,
		pressure: Math.max(...paceValues),
		pending: { fiveHours: 0, week: 0, month: 0 },
		source: "estimate",
	};
}

function computeMeter(entries: readonly LedgerEntry[], now = Date.now()): Meter {
	if (latestSnapshot) {
		return {
			...computeSnapshotMeter(latestSnapshot, entries, routerConfig.goProvider, now),
			source: usageRefreshState === "live" && now - latestSnapshot.fetchedAt >= refreshIntervalMs
				? "stale"
				: usageRefreshState,
			fetchedAt: latestSnapshot.fetchedAt,
			windowStatus: {
				fiveHours: latestSnapshot.usage.rolling.status,
				week: latestSnapshot.usage.weekly.status,
				month: latestSnapshot.usage.monthly.status,
			},
		};
	}
	return computeLocalMeter(entries, now);
}

function pressureState(meter: Meter, previous?: Pressure): Pressure {
	const fiveHour = meter.limit.fiveHours
		? meter.used.fiveHours / meter.limit.fiveHours
		: 0;
	let rank: number;
	if (meter.pressure > 1.4 || fiveHour > 0.9) rank = 3;
	else if (meter.pressure > 1.1 || fiveHour > 0.75) rank = 2;
	else if (meter.pressure > 0.8) rank = 1;
	else rank = 0;

	const previousRank = previous ? ["green", "yellow", "orange", "red"].indexOf(previous) : -1;
	if (previousRank > rank) {
		const canRelax =
			(previousRank === 3 && meter.pressure < 1.3 && fiveHour < 0.85) ||
			(previousRank === 2 && meter.pressure < 1.0 && fiveHour < 0.65) ||
			(previousRank === 1 && meter.pressure < 0.7);
		if (!canRelax) rank = previousRank;
	}
	return (["green", "yellow", "orange", "red"] as const)[rank]!;
}

function tierCap(pressure: Pressure, thinkingLevel: string): Tier {
	switch (pressure) {
		case "red":
			return 1;
		case "orange":
			return 2;
		case "yellow":
			return thinkingLevel === "high" ? 3 : 2;
		case "green":
			return thinkingLevel === "low" ? 1 : thinkingLevel === "medium" ? 2 : 3;
	}
}

function buildCandidates(category: string, thinkingLevel: string): string[] {
	const config = categories[category] ?? categories["unspecified-low"];
	if (!config) throw new Error('ogo.json must define the "unspecified-low" category');
	const candidates = [config.model, ...config.fallback_models];
	if (
		thinkingLevel === "high" &&
		["architect", "deep", "ultrabrain", "unspecified-high"].includes(category)
	) {
		candidates.push(...routerConfig.escalationModels);
	}
	return [...new Set(candidates)];
}

function candidateTier(key: string): Tier {
	const tier = tierOf(key);
	if (tier === undefined) throw new Error(`No tier is configured for ${key} in router.json`);
	return tier;
}

function fallbackCandidates(maxTier: Tier): string[] {
	return Object.entries(routerConfig.tierModels)
		.filter(([tier]) => Number(tier) <= maxTier)
		.sort(([left], [right]) => Number(right) - Number(left))
		.flatMap(([, models]) => models);
}

function bar(used: number, limit: number, width = 12): string {
	if (!limit) return `[${"=".repeat(width)}] unlimited`;
	const ratio = Math.min(used / limit, 1);
	const filled = Math.round(ratio * width);
	return `[${"#".repeat(filled)}${".".repeat(width - filled)}] ${Math.round(ratio * 100)}%`;
}

function renderBudget(meter: Meter, pressure: Pressure, currentModel?: string): string[] {
	const tier = currentModel ? tierOf(currentModel) : undefined;
	const age = meter.fetchedAt === undefined
		? ""
		: ` (${Math.max(0, Math.floor((Date.now() - meter.fetchedAt) / 60_000))}m old)`;
	const source = meter.source === "live"
		? `Go usage live${age}`
		: meter.source === "stale"
			? `Go usage stale${age}`
			: "local estimate";
	const lines = [
		`OGO budget: ${pressure}${tier !== undefined ? ` | T${tier}` : ""}${currentModel ? ` | ${currentModel}` : ""}`,
		`5h ${bar(meter.used.fiveHours, meter.limit.fiveHours)}  week ${bar(meter.used.week, meter.limit.week)}`,
		`month ${bar(meter.used.month, meter.limit.month)}`,
		`${source} | pace 5h ${meter.pace.fiveHours.toFixed(1)}x | week ${meter.pace.week.toFixed(1)}x | month ${meter.pace.month.toFixed(1)}x`,
		meter.windowStatus
			? `API status 5h ${meter.windowStatus.fiveHours} | week ${meter.windowStatus.week} | month ${meter.windowStatus.month}`
			: "API status unavailable",
	];
	lines.push(
		meter.source === "estimate"
			? `Local estimate; Pi Go requests: 5h ${meter.pending.fiveHours}, week ${meter.pending.week}, month ${meter.pending.month}`
			: `Pi since sync: 5h ${meter.pending.fiveHours}, week ${meter.pending.week}, month ${meter.pending.month} requests`,
	);
	if (lastUsageError) lines.push(`Last Go sync issue: ${lastUsageError}`);
	return lines;
}

async function updateBudgetUI(ctx: ExtensionContext, state?: Pressure) {
	await loadUsageState();
	const entries = await readLedger();
	const meter = computeMeter(entries);
	const pressure = pressureState(meter, state ?? activePressure);
	activePressure = pressure;
	ctx.ui.setStatus(
		"ogo-budget",
		`5h ${Math.round((meter.used.fiveHours / Math.max(meter.limit.fiveHours, 1)) * 100)}% | ` +
			`wk ${Math.round((meter.used.week / Math.max(meter.limit.week, 1)) * 100)}% | ` +
			`mo ${Math.round((meter.used.month / Math.max(meter.limit.month, 1)) * 100)}% | ${pressure} | ` +
			(meter.source === "live" ? "Go live" : meter.source === "stale" ? "Go stale" : "local estimate"),
	);
	ctx.ui.setWidget("ogo-budget", renderBudget(meter, pressure, currentRoutedModel), { placement: "aboveEditor" });
	if (pressure === "red" && lastNotifiedPressure !== "red" && ctx.hasUI) {
		ctx.ui.notify(`OGO ${meter.source} budget is red; routing is capped at tier 1.`, "warning");
	}
	lastNotifiedPressure = pressure;
	if (lastUsageError && ctx.hasUI && lastNotifiedUsageError !== lastUsageError) {
		ctx.ui.notify(`OGO usage refresh unavailable: ${lastUsageError}. Using ${meter.source} budget data.`, "warning");
	} else if (lastUsageError && !ctx.hasUI && lastNotifiedUsageError !== lastUsageError) {
		console.warn(`[ogo-router] Usage refresh unavailable: ${lastUsageError}; using ${meter.source} budget data.`);
	}
	lastNotifiedUsageError = lastUsageError;
}

export default function (pi: ExtensionAPI) {
	pi.registerVirtualModel<RouterState>({
		provider: routerConfig.virtualProvider,
		id: routerConfig.virtualModel,
		name: "Auto (budgeted)",
		thinkingLevels: ["low", "medium", "high"],
		async route(request, ctx) {
			await loadUsageState();
			const available = ctx.modelRegistry.getAvailable();
			const ledger = await readLedger();
			const meter = computeMeter(ledger);
			const pressure = pressureState(meter, request.state?.budgetState);
			activePressure = pressure;
			const maxTier = tierCap(pressure, request.thinkingLevel);
			const previousState = request.state;

			if (request.reason === "continuation" && request.previous) {
				currentRoutedModel = modelKey(request.previous.model);
				return {
					model: request.previous.model,
					thinkingLevel: request.previous.thinkingLevel ?? request.thinkingLevel,
					state: previousState,
				};
			}

			let category = previousState?.category ?? "unspecified-low";
			let candidates = previousState?.candidates ?? [];
			const retryCounts = { ...(previousState?.retryCounts ?? {}) };
			if (request.reason === "user" || !candidates.length) {
				category = classifyCategory(getUserText(request.messages), request.thinkingLevel);
				candidates = buildCandidates(category, request.thinkingLevel);
			}

			if (request.reason === "direct") {
				category = "unspecified-low";
				candidates = Object.entries(routerConfig.tierModels)
					.filter(([tier]) => Number(tier) === 0)
					.flatMap(([, models]) => models);
			}

			if (request.reason === "retry" && request.failed) {
				const failedKey = modelKey(request.failed.model);
				const failedMessage = request.failed.message;
				const transient = /timeout|temporar|overload|5\d\d|network|connection/i.test(
					failedMessage.errorMessage ?? "",
				);
				const attempts = retryCounts[failedKey] ?? 0;
				if (transient && attempts === 0) {
					retryCounts[failedKey] = 1;
					currentRoutedModel = failedKey;
					return {
						model: request.failed.model,
						thinkingLevel: request.failed.thinkingLevel ?? request.thinkingLevel,
						state: { category, candidates, budgetState: pressure, retryCounts },
					};
				}
				const failedIndex = candidates.indexOf(failedKey);
				if (failedIndex >= 0) candidates = candidates.slice(failedIndex + 1);
				candidates = candidates.filter((key) => key !== failedKey);
			}

			const candidatePool = [...new Set([...candidates, ...fallbackCandidates(maxTier)])];
			const eligible = candidatePool.filter((key) => {
				const tier = candidateTier(key);
				if (tier > maxTier) return false;
				const quota = routerConfig.modelQuotas[key];
				if (!quota) return true;
				const used = ledger.filter(
					(entry) => `${entry.provider}/${entry.model}` === key &&
						entry.timestamp >= windowStart("fiveHours", Date.now()),
				).length;
				const limit = quota.fiveHours;
				return limit === null || limit === undefined || used < limit * 0.9;
			});
			const selectedKey = eligible.find((key) => {
				const ref = parseModelKey(key);
				return available.some((model) => model.provider === ref.provider && model.id === ref.id);
			});
			if (!selectedKey) {
				throw new Error(
					`No available model for category "${category}" under the ${pressure} budget cap (tier ${maxTier}). ` +
						"Check provider credentials, router.json tier mappings, and local quotas.",
				);
			}
			const selectedRef = parseModelKey(selectedKey);
			const model = available.find(
				(item) => item.provider === selectedRef.provider && item.id === selectedRef.id,
			);
			if (!model) throw new Error(`Selected model ${selectedKey} is no longer available`);
			currentRoutedModel = selectedKey;

			return {
				model,
				thinkingLevel: request.thinkingLevel,
				state: { category, candidates, budgetState: pressure, retryCounts },
			};
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await refreshUsage(true);
		await updateBudgetUI(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		await refreshUsage();
		await updateBudgetUI(ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;
		const { provider, model, usage, timestamp } = event.message;
		if (!Number.isFinite(usage.cost.total) || !Number.isFinite(timestamp)) {
			throw new Error("Assistant message has invalid usage cost or timestamp; refusing to corrupt the OGO ledger.");
		}
		await mkdir(dirname(ledgerPath), { recursive: true });
		const entry: LedgerEntry = {
			provider,
			model,
			cost: usage.cost.total,
			timestamp,
			recordedAt: Date.now(),
		};
		await appendFile(ledgerPath, `${JSON.stringify(entry)}\n`, "utf8");
		await updateBudgetUI(ctx);
	});
}
