import { appendFile, mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  refreshModelCatalog,
  type ModelCatalogResult,
  type ModelCatalogSnapshot,
} from "./catalog.ts";
import { registerDelegation } from "./delegation.ts";
import {
  registerDashboard,
  updateDashboard,
  openOverlaySidebar,
} from "./ui.ts";
import {
  computeSnapshotMeter,
  computeLocalMeter as computeWeightedLocalMeter,
  parseGoUsageSnapshot,
  usageWindows,
  type GoUsageSnapshot,
  type UsageLedgerRecord,
  type UsageWindow,
} from "./usage.ts";

import {
  closePaneLater,
  closeSidebarPane,
  inTmux,
  openDelegatePane,
  openSidebarPane,
} from "./tmux.ts";
import { getDataDir, getStateFile } from "./state.ts";

const root = dirname(fileURLToPath(import.meta.url));
const dataDir = getDataDir();
const ledgerPath = join(dataDir, "ogo-router-usage.jsonl");
const snapshotPath = join(dataDir, "ogo-router-usage-snapshot.json");
const modelCatalogPath = join(dataDir, "ogo-model-catalog.json");
const refreshIntervalMs = 60_000;

export const stateFile = getStateFile(dataDir);

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
  failedModels?: string[];
  modelCooldowns?: Record<string, number>;
};
type LedgerEntry = UsageLedgerRecord & { cost: number; role?: string };
type Quota = Record<QuotaWindow, number | null>;
type RouterConfig = {
  virtualProvider: string;
  virtualModel: string;
  goProvider: string;
  modelCatalog: {
    url: string;
    provider: string;
    refreshIntervalMs: number;
    timeoutMs: number;
  };
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
let modelCatalogResult: ModelCatalogResult = { changedPrices: [] };
let modelCatalogRefresh: Promise<void> | undefined;
type LedgerIndex = {
  dev: number;
  ino: number;
  offset: number;
  lineNumber: number;
  partialLine: string;
  entries: LedgerEntry[];
};
let ledgerIndex: LedgerIndex | undefined;

function parseJson<T>(text: string, source: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(
      `Invalid JSON in ${source}: ${error instanceof Error ? error.message : String(error)}`,
    );
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
  typeof routerConfig.virtualProvider !== "string" ||
  !routerConfig.virtualProvider ||
  typeof routerConfig.virtualModel !== "string" ||
  !routerConfig.virtualModel ||
  typeof routerConfig.goProvider !== "string" ||
  !routerConfig.goProvider ||
  !routerConfig.modelCatalog ||
  typeof routerConfig.modelCatalog.url !== "string" ||
  typeof routerConfig.modelCatalog.provider !== "string" ||
  !Number.isFinite(routerConfig.modelCatalog.refreshIntervalMs) ||
  routerConfig.modelCatalog.refreshIntervalMs < 60 * 60 * 1000 ||
  !Number.isFinite(routerConfig.modelCatalog.timeoutMs) ||
  routerConfig.modelCatalog.timeoutMs <= 0 ||
  !routerConfig.tierModels ||
  typeof routerConfig.tierModels !== "object" ||
  !Array.isArray(routerConfig.escalationModels) ||
  !routerConfig.modelQuotas ||
  typeof routerConfig.modelQuotas !== "object"
) {
  throw new Error("router.json is missing required router settings");
}
if (
  !categoryDocument.categories ||
  typeof categoryDocument.categories !== "object"
) {
  throw new Error('ogo.json must contain a "categories" object');
}
const categories = categoryDocument.categories as Record<
  string,
  CategoryConfig
>;
for (const [tier, models] of Object.entries(routerConfig.tierModels)) {
  if (!["0", "1", "2", "3"].includes(tier) || !Array.isArray(models)) {
    throw new Error(`Invalid tier "${tier}" in router.json`);
  }
  for (const ref of models) {
    if (typeof ref !== "string")
      throw new Error(`Invalid model reference in tier ${tier}`);
    parseModelKey(ref);
  }
}
for (const [name, category] of Object.entries(categories)) {
  if (
    !category ||
    typeof category.model !== "string" ||
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
    throw new Error(
      `Invalid or un-tiered escalation model "${String(ref)}" in router.json`,
    );
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

async function refreshModelData(): Promise<void> {
  if (modelCatalogRefresh) return modelCatalogRefresh;
  modelCatalogRefresh = (async () => {
    modelCatalogResult = await refreshModelCatalog({
      ...routerConfig.modelCatalog,
      cachePath: modelCatalogPath,
    });
    if (modelCatalogResult.error) {
      console.warn(
        `[ogo-router] ${modelCatalogResult.error}; using cached catalog or configured model order.`,
      );
    }
    if (modelCatalogResult.changedPrices.length) {
      const changes = modelCatalogResult.priceChanges?.map(
        ({ model, previous, current }) =>
          `${model} input ${previous?.input ?? "n/a"}->${current?.input ?? "n/a"}, ` +
          `output ${previous?.output ?? "n/a"}->${current?.output ?? "n/a"}`,
      );
      console.info(
        `[ogo-router] models.dev pricing changed for ${modelCatalogResult.changedPrices.length} ` +
          `${routerConfig.modelCatalog.provider} models: ${changes?.join("; ") ?? modelCatalogResult.changedPrices.join(", ")}`,
      );
    }
  })().finally(() => {
    modelCatalogRefresh = undefined;
  });
  await modelCatalogRefresh;
}

function modelCatalogSnapshot(): ModelCatalogSnapshot | undefined {
  return modelCatalogResult.snapshot;
}

function tierOf(key: string): Tier | undefined {
  for (const [tierText, models] of Object.entries(routerConfig.tierModels)) {
    if (!models.includes(key)) continue;
    const tier = Number(tierText);
    if (tier >= 0 && tier <= 3) return tier as Tier;
  }
  return undefined;
}

function getUserText(
  messages: readonly { role: string; content?: unknown }[],
): string {
  const message = messages.findLast((item) => item.role === "user");
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .flatMap((block) =>
      typeof block === "object" &&
      block !== null &&
      "type" in block &&
      block.type === "text" &&
      "text" in block &&
      typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join("\n");
}

function classifyCategory(text: string, thinkingLevel: string): string {
  const lower = text.toLowerCase();
  if (
    /\b(ultrabrain|prove|formal verification|hardest|extremely difficult)\b/.test(
      lower,
    )
  ) {
    return "ultrabrain";
  }
  if (/\b(architecture|architect|system design|trade-?offs?)\b/.test(lower))
    return "architect";
  if (
    /\b(deep dive|deep analysis|complex|difficult|debug|root cause)\b/.test(
      lower,
    )
  )
    return "deep";
  if (/\b(visual|ui|ux|frontend|css|design system)\b/.test(lower))
    return "visual-engineering";
  if (
    /\b(writing|proofread|copyedit|copy edit|draft|email|article|blog post|essay|poem|press release|marketing copy)\b/.test(
      lower,
    ) ||
    /\b(rewrite|edit)\s+(this|the|my)?\s*(paragraph|email|article|essay|poem|copy|document)\b/.test(
      lower,
    )
  )
    return "writing";
  if (/\b(creative|illustration|artistry|brainstorm names)\b/.test(lower))
    return "artistry";
  if (/\b(quick|brief|simple|small question|one-liner)\b/.test(lower))
    return "quick";
  return thinkingLevel === "high" ? "unspecified-high" : "unspecified-low";
}

function categoryStrength(category: string): number {
  if (category === "ultrabrain") return 4;
  if (category === "architect" || category === "deep" || category === "unspecified-high")
    return 3;
  if (category === "visual-engineering" || category === "artistry") return 2;
  if (category === "writing") return 1;
  return 0;
}

function parseLedgerEntry(value: unknown, line: number): LedgerEntry {
  if (
    typeof value !== "object" ||
    value === null ||
    !("provider" in value) ||
    typeof value.provider !== "string" ||
    !("model" in value) ||
    typeof value.model !== "string" ||
    !("cost" in value) ||
    typeof value.cost !== "number" ||
    !Number.isFinite(value.cost) ||
    !("timestamp" in value) ||
    typeof value.timestamp !== "number" ||
    !Number.isFinite(value.timestamp) ||
    ("recordedAt" in value &&
      (typeof value.recordedAt !== "number" ||
        !Number.isFinite(value.recordedAt))) ||
    ("role" in value && typeof value.role !== "string")
  ) {
    throw new Error(
      `Invalid usage ledger entry on line ${line} (${ledgerPath})`,
    );
  }
  const recordedAt = "recordedAt" in value ? value.recordedAt : undefined;
  const role =
    "role" in value && typeof value.role === "string" ? value.role : undefined;
  return {
    provider: value.provider,
    model: value.model,
    cost: value.cost,
    timestamp: value.timestamp,
    recordedAt: typeof recordedAt === "number" ? recordedAt : undefined,
    role,
  };
}

async function readLedger(): Promise<LedgerEntry[]> {
  let fileInfo: Awaited<ReturnType<typeof stat>>;
  try {
    fileInfo = await stat(ledgerPath);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      ledgerIndex = undefined;
      return [];
    }
    throw error;
  }
  if (
    !ledgerIndex ||
    ledgerIndex.dev !== fileInfo.dev ||
    ledgerIndex.ino !== fileInfo.ino ||
    fileInfo.size < ledgerIndex.offset
  ) {
    ledgerIndex = {
      dev: fileInfo.dev,
      ino: fileInfo.ino,
      offset: 0,
      lineNumber: 0,
      partialLine: "",
      entries: [],
    };
  }
  if (fileInfo.size === ledgerIndex.offset) return [...ledgerIndex.entries];

  const file = await open(ledgerPath, "r");
  const decoder = new StringDecoder("utf8");
  try {
    while (ledgerIndex.offset < fileInfo.size) {
      const buffer = Buffer.alloc(
        Math.min(64 * 1024, fileInfo.size - ledgerIndex.offset),
      );
      const { bytesRead } = await file.read(
        buffer,
        0,
        buffer.length,
        ledgerIndex.offset,
      );
      if (!bytesRead) break;
      ledgerIndex.offset += bytesRead;
      const text =
        ledgerIndex.partialLine + decoder.write(buffer.subarray(0, bytesRead));
      const lines = text.split("\n");
      ledgerIndex.partialLine = lines.pop() ?? "";
      for (const line of lines) {
        ledgerIndex.lineNumber++;
        if (!line.trim()) continue;
        try {
          ledgerIndex.entries.push(
            parseLedgerEntry(
              JSON.parse(line) as unknown,
              ledgerIndex.lineNumber,
            ),
          );
        } catch (error) {
          console.warn(
            `[ogo-router] Skipping invalid usage ledger line ${ledgerIndex.lineNumber} (${ledgerPath}): ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    ledgerIndex.partialLine += decoder.end();
  } finally {
    await file.close();
  }
  return [...ledgerIndex.entries];
}

async function loadUsageState(): Promise<void> {
  if (usageStateLoaded) return;
  usageStateLoaded = true;
  let contents: string;
  try {
    contents = await readFile(snapshotPath, "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return;
    throw error;
  }
  try {
    const value = parseJson<unknown>(contents, snapshotPath);
    if (
      typeof value !== "object" ||
      value === null ||
      !("fetchedAt" in value) ||
      typeof value.fetchedAt !== "number" ||
      !Number.isFinite(value.fetchedAt)
    ) {
      throw new Error("stored usage snapshot has invalid timestamp");
    }
    latestSnapshot = parseGoUsageSnapshot(value, value.fetchedAt);
    usageRefreshState = "stale";
  } catch (error) {
    lastUsageError =
      error instanceof Error
        ? error.message
        : "Stored usage snapshot is invalid";
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
      lastUsageError =
        error instanceof Error &&
        ["AbortError", "TimeoutError"].includes(error.name)
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
      lastUsageError =
        error instanceof Error
          ? error.message
          : "usage endpoint returned invalid data";
      usageRefreshState = latestSnapshot ? "stale" : "estimate";
      return;
    }

    latestSnapshot = nextSnapshot;
    usageRefreshState = "live";
    lastUsageError = undefined;
    try {
      await mkdir(dataDir, { recursive: true });
      await writeFile(
        snapshotPath,
        `${JSON.stringify(nextSnapshot)}\n`,
        "utf8",
      );
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
  if (window === "fiveHours")
    return now - usageWindows.fiveHours;
  if (window === "week") {
    const day = (date.getUTCDay() + 6) % 7;
    return Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate() - day,
    );
  }
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function computeLocalMeter(
  entries: readonly LedgerEntry[],
  now = Date.now(),
): Meter {
  const meter = computeWeightedLocalMeter(
    entries,
    routerConfig.modelQuotas,
    now,
  );
  return {
    ...meter,
    source: "estimate",
  };
}

function computeMeter(
  entries: readonly LedgerEntry[],
  now = Date.now(),
): Meter {
  if (latestSnapshot) {
    return {
      ...computeSnapshotMeter(
        latestSnapshot,
        entries,
        routerConfig.goProvider,
        now,
      ),
      source:
        usageRefreshState === "live" &&
        now - latestSnapshot.fetchedAt >= refreshIntervalMs
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

  const previousRank = previous
    ? ["green", "yellow", "orange", "red"].indexOf(previous)
    : -1;
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

function buildCandidates(category: string): string[] {
  const config = categories[category] ?? categories["unspecified-low"];
  if (!config)
    throw new Error('ogo.json must define the "unspecified-low" category');
  return [...new Set([config.model, ...config.fallback_models])];
}

function candidateTier(key: string): Tier {
  const tier = tierOf(key);
  if (tier === undefined)
    throw new Error(`No tier is configured for ${key} in router.json`);
  return tier;
}

function fallbackCandidates(maxTier: Tier, preferredTier: Tier): string[] {
  const driverTier = Math.min(maxTier, 2) as Tier;
  const startTier = Math.min(driverTier, preferredTier) as Tier;
  return Object.entries(routerConfig.tierModels)
    .filter(([tier]) => Number(tier) <= startTier && Number(tier) <= 2)
    .sort(([left], [right]) => Number(right) - Number(left))
    .flatMap(([, models]) => models);
}

function fallbackTierRank(tier: Tier, preferredTier: Tier): number {
  if (tier < preferredTier) return preferredTier - tier;
  return 10 + tier - preferredTier;
}

function failureKind(message: string): "transient" | "limited" | "other" {
  if (
    /\b429\b|rate.?limit|quota exceeded|too many requests|resource exhausted/i.test(
      message,
    )
  )
    return "limited";
  if (
    /\bHTTP\s*5\d{2}\b|\bstatus code 5\d{2}\b|\b5\d{2}\s+(server|internal server)\b|timeout|temporar(?:y|ily)|overload|network|connection/i.test(
      message,
    )
  )
    return "transient";
  return "other";
}

function quotaAllows(
  key: string,
  recentRequests: ReadonlyMap<string, number>,
): boolean {
  const quota = routerConfig.modelQuotas[key];
  if (!quota) return true;
  const limit = quota.fiveHours;
  if (limit === null || limit === undefined) return true;
  const used = recentRequests.get(key) ?? 0;
  return used < limit * 0.9;
}

function availableModel<T extends ModelRef>(
  key: string,
  available: readonly T[],
): T | undefined {
  const ref = parseModelKey(key);
  return available.find(
    (model) => model.provider === ref.provider && model.id === ref.id,
  );
}

function renderBudgetStatus(meter: Meter): string[] {
  const lines = [
    meter.windowStatus
      ? `API status 5h ${meter.windowStatus.fiveHours} | week ${meter.windowStatus.week} | month ${meter.windowStatus.month}`
      : "API status unavailable",
    meter.source === "estimate"
      ? `Local estimate; Pi Go requests: 5h ${meter.pending.fiveHours}, week ${meter.pending.week}, month ${meter.pending.month}`
      : `Pi since sync: 5h ${meter.pending.fiveHours}, week ${meter.pending.week}, month ${meter.pending.month} requests`,
  ];
  if (modelCatalogResult.snapshot) {
    const ageMinutes = Math.max(
      0,
      Math.floor((Date.now() - modelCatalogResult.snapshot.fetchedAt) / 60_000),
    );
    const changeNote = modelCatalogResult.changedPrices.length
      ? ` | price changes: ${modelCatalogResult.changedPrices.slice(0, 3).join(", ")}` +
        (modelCatalogResult.changedPrices.length > 3 ? ", ..." : "")
      : "";
    lines.push(
      `models.dev ${modelCatalogResult.snapshot.provider}: ${Object.keys(modelCatalogResult.snapshot.models).length} models, ` +
        `checked ${ageMinutes}m ago${changeNote}`,
    );
  } else {
    lines.push(
      modelCatalogResult.error ??
        "models.dev catalog unavailable; using configured model order",
    );
  }
  if (modelCatalogResult.error)
    lines.push(`models.dev refresh issue: ${modelCatalogResult.error}`);
  if (lastUsageError) lines.push(`Go sync issue: ${lastUsageError}`);
  return lines;
}

async function updateBudgetUI(state?: Pressure) {
  await loadUsageState();
  const entries = await readLedger();
  const meter = computeMeter(entries);
  const pressure = pressureState(meter, state ?? activePressure);
  activePressure = pressure;
  updateDashboard({
    budget: {
      pressure,
      model: currentRoutedModel,
      tier: currentRoutedModel ? tierOf(currentRoutedModel) : undefined,
      windows: [
        {
          label: "5h",
          used: meter.used.fiveHours,
          limit: meter.limit.fiveHours,
        },
        { label: "wk", used: meter.used.week, limit: meter.limit.week },
        { label: "mo", used: meter.used.month, limit: meter.limit.month },
      ],
      pace: `pace ${meter.pace.fiveHours.toFixed(1)}x · ${meter.pace.week.toFixed(1)}x · ${meter.pace.month.toFixed(1)}x`,
      source:
        meter.source === "live"
          ? "Go usage live"
          : meter.source === "stale"
            ? "Go usage stale"
            : "local estimate",
      status: renderBudgetStatus(meter),
      notes: [
        lastUsageError && `⚠ ${lastUsageError}`,
        modelCatalogResult.error && `⚠ catalog: ${modelCatalogResult.error}`,
      ].filter((n): n is string => Boolean(n)),
    },
  });
  if (pressure === "red" && lastNotifiedPressure !== "red") {
    console.warn(
      `[ogo-router] ${meter.source} budget is red; routing is capped at tier 1.`,
    );
  }
  lastNotifiedPressure = pressure;
  if (lastUsageError && lastNotifiedUsageError !== lastUsageError) {
    console.warn(
      `[ogo-router] Usage refresh unavailable: ${lastUsageError}; using ${meter.source} budget data.`,
    );
  }
  lastNotifiedUsageError = lastUsageError;
}

async function recordDelegateUsage(
  messages: unknown[],
  role: string,
): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const records: LedgerEntry[] = [];
  for (const message of messages) {
    if (
      typeof message !== "object" ||
      message === null ||
      !("role" in message) ||
      message.role !== "assistant" ||
      !("provider" in message) ||
      typeof message.provider !== "string" ||
      !("model" in message) ||
      typeof message.model !== "string" ||
      !("timestamp" in message) ||
      typeof message.timestamp !== "number" ||
      !Number.isFinite(message.timestamp) ||
      !("usage" in message) ||
      typeof message.usage !== "object" ||
      message.usage === null ||
      !("cost" in message.usage) ||
      typeof message.usage.cost !== "object" ||
      message.usage.cost === null ||
      !("total" in message.usage.cost) ||
      typeof message.usage.cost.total !== "number" ||
      !Number.isFinite(message.usage.cost.total)
    ) {
      continue;
    }
    records.push({
      provider: message.provider,
      model: message.model,
      cost: message.usage.cost.total,
      timestamp: message.timestamp,
      recordedAt: Date.now(),
      role,
    });
  }
  if (records.length) {
    await appendFile(
      ledgerPath,
      `${records.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );
  }
}

export default function (pi: ExtensionAPI) {
  registerDashboard(pi);
  pi.registerVirtualModel<RouterState>({
    provider: routerConfig.virtualProvider,
    id: routerConfig.virtualModel,
    name: "Auto (budgeted)",
    thinkingLevels: ["low", "medium", "high"],
    async route(request, ctx) {
      await loadUsageState();
      const available = ctx.modelRegistry.getAvailable();
      const ledger = await readLedger();
      const recentRequests = new Map<string, number>();
      const fiveHoursAgo = windowStart("fiveHours", Date.now());
      for (const entry of ledger) {
        if (entry.timestamp < fiveHoursAgo) continue;
        const key = `${entry.provider}/${entry.model}`;
        recentRequests.set(key, (recentRequests.get(key) ?? 0) + 1);
      }
      const meter = computeMeter(ledger);
      const pressure = pressureState(meter, request.state?.budgetState);
      activePressure = pressure;
      const maxTier = tierCap(pressure, request.thinkingLevel);
      const driverTier = Math.min(maxTier, 2) as Tier;
      const previousState = request.state;
      let category = previousState?.category ?? "unspecified-low";
      let candidates = previousState?.candidates ?? [];
      const retryCounts = { ...(previousState?.retryCounts ?? {}) };
      const failedModels = new Set(previousState?.failedModels ?? []);
      const now = Date.now();
      const modelCooldowns: Record<string, number> = Object.fromEntries(
        Object.entries(previousState?.modelCooldowns ?? {}).filter(
          ([, until]) => until > now,
        ),
      );
      let preferredTier: Tier = driverTier;

      if (request.reason === "user") {
        const classified = classifyCategory(
          getUserText(request.messages),
          request.thinkingLevel,
        );
        const ambiguousHighDefault =
          previousState?.category &&
          previousState.category !== "unspecified-high" &&
          classified === "unspecified-high";
        if (
          !previousState?.category ||
          (!ambiguousHighDefault &&
            categoryStrength(classified) > categoryStrength(category))
        )
          category = classified;
        candidates = buildCandidates(category);
        failedModels.clear();
        for (const key of Object.keys(retryCounts)) delete retryCounts[key];
      } else if (!candidates.length) {
        category = classifyCategory(
          getUserText(request.messages),
          request.thinkingLevel,
        );
        candidates = buildCandidates(category);
      }

      if (request.reason === "direct") {
        category = "unspecified-low";
        candidates = Object.entries(routerConfig.tierModels)
          .filter(([tier]) => Number(tier) === 0)
          .flatMap(([, models]) => models);
        preferredTier = 0;
      }

      const previousKey =
        request.reason === "continuation" && request.previous
          ? modelKey(request.previous.model)
          : undefined;
      if (previousKey) {
        const previousTier = candidateTier(previousKey);
        if (
          previousTier <= driverTier &&
          !failedModels.has(previousKey) &&
          !((modelCooldowns[previousKey] ?? 0) > now) &&
          quotaAllows(previousKey, recentRequests) &&
          availableModel(previousKey, available)
        ) {
          currentRoutedModel = previousKey;
          return {
            model: request.previous!.model,
            thinkingLevel:
              request.previous!.thinkingLevel ?? request.thinkingLevel,
            state: {
              category,
              candidates,
              budgetState: pressure,
              retryCounts,
              failedModels: [...failedModels],
              modelCooldowns,
            },
          };
        }
        candidates = [...new Set([previousKey, ...candidates])];
        preferredTier = Math.min(
          driverTier,
          Math.max(0, previousTier - 1),
        ) as Tier;
      } else if (candidates.length) {
        preferredTier = Math.min(
          driverTier,
          candidateTier(candidates[0]!),
        ) as Tier;
      }

      if (request.reason === "retry" && request.failed) {
        const failedKey = modelKey(request.failed.model);
        const failure = failureKind(
          request.failed.message.errorMessage ?? "",
        );
        const attempts = retryCounts[failedKey] ?? 0;
        if (
          failure === "transient" &&
          attempts === 0 &&
          candidateTier(failedKey) <= driverTier
        ) {
          retryCounts[failedKey] = 1;
          currentRoutedModel = failedKey;
          return {
            model: request.failed.model,
            thinkingLevel:
              request.failed.thinkingLevel ?? request.thinkingLevel,
            state: {
              category,
              candidates,
              budgetState: pressure,
              retryCounts,
              failedModels: [...failedModels],
              modelCooldowns,
            },
          };
        }
        failedModels.add(failedKey);
        if (failure === "limited")
          modelCooldowns[failedKey] = now + 5 * 60 * 1000;
        else if (failure === "transient")
          modelCooldowns[failedKey] = now + 60 * 1000;
        const failedIndex = candidates.indexOf(failedKey);
        if (failedIndex >= 0) candidates = candidates.slice(failedIndex + 1);
        candidates = candidates.filter((key) => key !== failedKey);
      }

      let primary: string | undefined;
      if (request.reason === "user" || request.reason === "direct") {
        primary = candidates[0];
      } else if (request.reason === "continuation") {
        primary = candidates.find(
          (key) => key !== previousKey && candidateTier(key) === preferredTier,
        );
      }
      const fallbacks = [
        ...new Set([
          ...candidates.filter((key) => key !== primary),
          ...fallbackCandidates(driverTier, preferredTier),
        ]),
      ].filter((key) => key !== primary);
      const fallbackOrder = new Map(
        fallbacks.map((key, index) => [key, index]),
      );
      fallbacks.sort((left, right) => {
        const tierDifference =
          fallbackTierRank(candidateTier(left), preferredTier) -
          fallbackTierRank(candidateTier(right), preferredTier);
        if (tierDifference !== 0) return tierDifference;
        return (
          (fallbackOrder.get(left) ?? 0) -
          (fallbackOrder.get(right) ?? 0)
        );
      });
      const candidatePool = [
        ...new Set([
          ...(primary ? [primary] : []),
          ...fallbacks,
        ]),
      ];
      const eligible = candidatePool.filter((key) => {
        return (
          candidateTier(key) <= driverTier &&
          !failedModels.has(key) &&
          !((modelCooldowns[key] ?? 0) > now) &&
          quotaAllows(key, recentRequests)
        );
      });
      const selectedKey = eligible.find((key) =>
        availableModel(key, available),
      );
      if (!selectedKey) {
        throw new Error(
          `No available model for category "${category}" under the ${pressure} budget cap (tier ${driverTier}). ` +
            "Check provider credentials, router.json tier mappings, and local quotas.",
        );
      }
      const model = availableModel(selectedKey, available);
      if (!model)
        throw new Error(`Selected model ${selectedKey} is no longer available`);
      currentRoutedModel = selectedKey;

      return {
        model,
        thinkingLevel: request.thinkingLevel,
        state: {
          category,
          candidates,
          budgetState: pressure,
          retryCounts,
          failedModels: [...failedModels],
          modelCooldowns,
        },
      };
    },
  });

  registerDelegation(
    pi,
    {
      dataDir,
      async getBudgetCap(ctx) {
        await refreshModelData();
        await loadUsageState();
        await refreshUsage();
        const meter = computeMeter(await readLedger());
        const state = pressureState(meter, activePressure);
        activePressure = state;
        return tierCap(state, ctx.thinkingLevel ?? "medium");
      },
      getModelCatalog: modelCatalogSnapshot,
      recordUsage: recordDelegateUsage,
      panes: inTmux()
        ? { open: openDelegatePane, closeLater: closePaneLater }
        : undefined,
    },
    routerConfig.tierModels,
  );

  pi.on("session_start", async (_event, ctx) => {
    const ok = await openSidebarPane(join(root, "sidebar.ts"), stateFile);
    if (!ok) openOverlaySidebar(ctx);
    await refreshModelData();
    await refreshUsage(true);
    await updateBudgetUI();
  });
  pi.on("session_shutdown", async () => {
    await closeSidebarPane();
  });
  pi.on("agent_start", () => {
    updateDashboard({
      agent: [
        `Conductor • ${currentRoutedModel ?? "waiting for route"}`,
        "Working…",
      ],
    });
  });

  pi.on("agent_settled", async () => {
    await refreshUsage();
    await updateBudgetUI();
  });

  pi.on("message_end", async (event) => {
    if (event.message.role !== "assistant") return;
    const { provider, model, usage, timestamp } = event.message;
    const messageText =
      typeof event.message.content === "string"
        ? event.message.content
        : Array.isArray(event.message.content)
          ? event.message.content
              .flatMap((block) => (block.type === "text" ? [block.text] : []))
              .join("\n")
          : "";
    if (messageText.trim()) {
      updateDashboard({
        agent: [
          `Conductor • ${provider}/${model}`,
          ...messageText.trim().split("\n").slice(-12),
        ],
      });
    }
    if (!Number.isFinite(usage.cost.total) || !Number.isFinite(timestamp)) {
      throw new Error(
        "Assistant message has invalid usage cost or timestamp; refusing to corrupt the OGO ledger.",
      );
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
    await updateBudgetUI();
  });
}
