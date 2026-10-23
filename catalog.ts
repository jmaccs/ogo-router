import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type ModelCatalogModel = {
	input?: number;
	output?: number;
	toolCall?: boolean;
};

export type ModelCatalogSnapshot = {
	fetchedAt: number;
	provider: string;
	models: Record<string, ModelCatalogModel>;
};

export type ModelCatalogResult = {
	snapshot?: ModelCatalogSnapshot;
	changedPrices: string[];
	priceChanges?: Array<{
		model: string;
		previous?: Pick<ModelCatalogModel, "input" | "output">;
		current?: Pick<ModelCatalogModel, "input" | "output">;
	}>;
	error?: string;
};

export type ModelCatalogOptions = {
	url: string;
	provider: string;
	cachePath: string;
	refreshIntervalMs: number;
	timeoutMs: number;
};

function validPrice(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function parseModelCatalog(
	value: unknown,
	provider: string,
	fetchedAt: number,
): ModelCatalogSnapshot {
	if (typeof value !== "object" || value === null) {
		throw new Error(`models.dev response is missing provider "${provider}" models`);
	}
	const root = value as Record<string, unknown>;
	const providerValue = root[provider];
	if (
		typeof providerValue !== "object" || providerValue === null ||
		!("models" in providerValue) || typeof providerValue.models !== "object" ||
		providerValue.models === null || Array.isArray(providerValue.models)
	) {
		throw new Error(`models.dev response is missing provider "${provider}" models`);
	}

	const entries = providerValue.models as Record<string, unknown>;
	const models: Record<string, ModelCatalogModel> = {};
	for (const [id, raw] of Object.entries(entries)) {
		if (typeof raw !== "object" || raw === null) continue;
		const cost = "cost" in raw && typeof raw.cost === "object" && raw.cost !== null
			? raw.cost
			: undefined;
		const input = cost && "input" in cost && validPrice(cost.input) ? cost.input : undefined;
		const output = cost && "output" in cost && validPrice(cost.output) ? cost.output : undefined;
		const toolCall = "tool_call" in raw && typeof raw.tool_call === "boolean" ? raw.tool_call : undefined;
		if (input === undefined && output === undefined && toolCall === undefined) continue;
		models[id] = { input, output, toolCall };
	}
	if (!Object.keys(models).length) {
		throw new Error(`models.dev provider "${provider}" contains no usable model metadata`);
	}
	return { fetchedAt, provider, models };
}

function parseCachedCatalog(value: unknown, provider: string): ModelCatalogSnapshot {
	if (
		typeof value !== "object" || value === null ||
		!("fetchedAt" in value) || typeof value.fetchedAt !== "number" || !Number.isFinite(value.fetchedAt) ||
		!("provider" in value) || value.provider !== provider ||
		!("models" in value) || typeof value.models !== "object" || value.models === null || Array.isArray(value.models)
	) {
		throw new Error("Cached models.dev catalog has an invalid shape");
	}
	const models: Record<string, ModelCatalogModel> = {};
	for (const [id, raw] of Object.entries(value.models)) {
		if (
			typeof raw !== "object" || raw === null ||
			("input" in raw && raw.input !== undefined && !validPrice(raw.input)) ||
			("output" in raw && raw.output !== undefined && !validPrice(raw.output)) ||
			("toolCall" in raw && raw.toolCall !== undefined && typeof raw.toolCall !== "boolean")
		) {
			throw new Error(`Cached models.dev catalog has invalid metadata for "${id}"`);
		}
		models[id] = {
			input: "input" in raw && validPrice(raw.input) ? raw.input : undefined,
			output: "output" in raw && validPrice(raw.output) ? raw.output : undefined,
			toolCall: "toolCall" in raw && typeof raw.toolCall === "boolean" ? raw.toolCall : undefined,
		};
	}
	return { fetchedAt: value.fetchedAt, provider, models };
}

async function readCatalog(path: string, provider: string): Promise<ModelCatalogSnapshot | undefined> {
	try {
		const text = await readFile(path, "utf8");
		return parseCachedCatalog(JSON.parse(text) as unknown, provider);
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
}

async function readAttempt(path: string): Promise<{ attemptedAt: number; error?: string } | undefined> {
	try {
		const value = JSON.parse(await readFile(path, "utf8")) as unknown;
		if (
			typeof value !== "object" || value === null ||
			!("attemptedAt" in value) || typeof value.attemptedAt !== "number" || !Number.isFinite(value.attemptedAt) ||
			("error" in value && value.error !== undefined && typeof value.error !== "string")
		) {
			throw new Error("Cached models.dev refresh state has an invalid shape");
		}
		return {
			attemptedAt: value.attemptedAt,
			error: "error" in value && typeof value.error === "string" ? value.error : undefined,
		};
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
}

async function writeAttempt(
	path: string,
	attemptedAt: number,
	error?: string,
): Promise<string | undefined> {
	try {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, `${JSON.stringify({ attemptedAt, error })}\n`, "utf8");
		return undefined;
	} catch (writeError) {
		return `could not persist models.dev refresh state: ${writeError instanceof Error ? writeError.message : String(writeError)}`;
	}
}

function priceChanged(
	previous: ModelCatalogModel | undefined,
	next: ModelCatalogModel | undefined,
): boolean {
	if (!previous) return next?.input !== undefined || next?.output !== undefined;
	if (!next) return previous.input !== undefined || previous.output !== undefined;
	return previous.input !== next.input || previous.output !== next.output;
}

export async function refreshModelCatalog(
	options: ModelCatalogOptions,
	now = Date.now(),
	fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = fetch,
): Promise<ModelCatalogResult> {
	let previous: ModelCatalogSnapshot | undefined;
	let cacheError: string | undefined;
	try {
		previous = await readCatalog(options.cachePath, options.provider);
	} catch (error) {
		cacheError = error instanceof Error ? error.message : "cached models.dev catalog is invalid";
	}
	let previousAttempt: { attemptedAt: number; error?: string } | undefined;
	try {
		previousAttempt = await readAttempt(`${options.cachePath}.refresh.json`);
	} catch (error) {
		cacheError = [cacheError, error instanceof Error ? error.message : "cached refresh state is invalid"]
			.filter(Boolean).join("; ");
	}
	if (previous && now - previous.fetchedAt < options.refreshIntervalMs) {
		return { snapshot: previous, changedPrices: [] };
	}
	if (previousAttempt && now - previousAttempt.attemptedAt < options.refreshIntervalMs) {
		return {
			snapshot: previous,
			changedPrices: [],
			error: previousAttempt.error ?? cacheError,
		};
	}
	const attemptPath = `${options.cachePath}.refresh.json`;
	const attemptWriteError = await writeAttempt(attemptPath, now);

	const failed = async (error: string): Promise<ModelCatalogResult> => {
		const persistError = await writeAttempt(attemptPath, now, error);
		return {
			snapshot: previous,
			changedPrices: [],
			error: [error, persistError, attemptWriteError].filter(Boolean).join("; "),
		};
	};

	let response: Response;
	try {
		response = await fetcher(options.url, {
			redirect: "error",
			signal: AbortSignal.timeout(options.timeoutMs),
		});
	} catch (error) {
		const message = error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)
			? "request timed out"
			: "request failed";
		return await failed(cacheError ? `${cacheError}; models.dev ${message}` : `models.dev ${message}`);
	}
	if (!response.ok) {
		return await failed(
			cacheError
				? `${cacheError}; models.dev returned HTTP ${response.status}`
				: `models.dev returned HTTP ${response.status}`,
		);
	}

	let body: unknown;
	try {
		body = await response.json();
	} catch {
		return await failed(cacheError
			? `${cacheError}; models.dev returned invalid JSON`
			: "models.dev returned invalid JSON");
	}

	let snapshot: ModelCatalogSnapshot;
	try {
		snapshot = parseModelCatalog(body, options.provider, now);
	} catch (error) {
		return await failed([
				cacheError,
				error instanceof Error ? error.message : "models.dev catalog is invalid",
			].filter(Boolean).join("; "));
	}

	const allIds = new Set([...Object.keys(previous?.models ?? {}), ...Object.keys(snapshot.models)]);
	const changedPrices = previous
		? [...allIds].filter((id) => priceChanged(previous.models[id], snapshot.models[id]))
		: [];
	const priceChanges = changedPrices.map((model) => {
		const previousModel = previous?.models[model];
		const currentModel = snapshot.models[model];
		return {
			model,
			previous: previousModel
				? { input: previousModel.input, output: previousModel.output }
				: undefined,
			current: currentModel
				? { input: currentModel.input, output: currentModel.output }
				: undefined,
		};
	});
	try {
		await mkdir(dirname(options.cachePath), { recursive: true });
		await writeFile(options.cachePath, `${JSON.stringify(snapshot)}\n`, "utf8");
	} catch (error) {
		return await failed(
			`could not persist models.dev catalog: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const stateError = await writeAttempt(attemptPath, now);
	return {
		snapshot,
		changedPrices,
		priceChanges,
		error: [attemptWriteError, stateError].filter(Boolean).join("; ") || undefined,
	};
}

export function rankCatalogModels(
	models: readonly string[],
	provider: string,
	catalog: ModelCatalogSnapshot | undefined,
	requiresToolCalls: boolean,
): string[] {
	if (!catalog || catalog.provider !== provider) return [...models];
	const scored = models.map((ref, index) => {
		const prefix = `${provider}/`;
		const id = ref.startsWith(prefix) ? ref.slice(prefix.length) : undefined;
		const metadata = id ? catalog.models[id] : undefined;
		return {
			ref,
			index,
			metadata,
			score: metadata?.input !== undefined && metadata.output !== undefined
				? metadata.input + metadata.output
				: undefined,
		};
	}).filter(({ metadata }) => !requiresToolCalls || metadata?.toolCall !== false);
	scored.sort((left, right) => {
		if (left.score === undefined && right.score !== undefined) return 1;
		if (left.score !== undefined && right.score === undefined) return -1;
		return (left.score ?? 0) - (right.score ?? 0) || left.index - right.index;
	});
	return scored.map(({ ref }) => ref);
}
