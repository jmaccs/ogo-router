export const usageWindows = {
	fiveHours: 5 * 60 * 60 * 1000,
	week: 7 * 24 * 60 * 60 * 1000,
	month: 30 * 24 * 60 * 60 * 1000,
} as const;

export type UsageWindow = keyof typeof usageWindows;
export type UsageWindowSnapshot = {
	status: string;
	percent: number;
	resetsAt: string;
	resetAt: number;
};
export type GoUsageSnapshot = {
	fetchedAt: number;
	usage: Record<"rolling" | "weekly" | "monthly", UsageWindowSnapshot>;
};
export type UsageLedgerRecord = {
	provider: string;
	model: string;
	cost: number;
	timestamp: number;
	recordedAt?: number;
};
export type SnapshotMeter = {
	used: Record<UsageWindow, number>;
	limit: Record<UsageWindow, number>;
	pace: Record<UsageWindow, number>;
	pressure: number;
	pending: Record<UsageWindow, number>;
};
export type LocalQuota = Record<UsageWindow, number | null>;

function periodStart(window: UsageWindow, now: number): number {
	if (window === "fiveHours") return now - usageWindows.fiveHours;
	const date = new Date(now);
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

function conservativePace(
	used: number,
	elapsed: number,
	window: UsageWindow,
): number {
	const minimumElapsed = window === "fiveHours" ? 0.25 : 0.1;
	return used / Math.max(elapsed, minimumElapsed);
}

export function computeLocalMeter(
	entries: readonly UsageLedgerRecord[],
	quotas: Readonly<Record<string, LocalQuota>>,
	now = Date.now(),
): SnapshotMeter {
	const used = { fiveHours: 0, week: 0, month: 0 };
	const limit = { fiveHours: 100, week: 100, month: 100 };
	const pace = { fiveHours: 0, week: 0, month: 0 };
	const pending = { fiveHours: 0, week: 0, month: 0 };
	const windows = Object.keys(usageWindows) as UsageWindow[];
	const starts: Record<UsageWindow, number> = {
		fiveHours: periodStart("fiveHours", now),
		week: periodStart("week", now),
		month: periodStart("month", now),
	};
	const quotaByModel = new Map<string, LocalQuota>();
	for (const [key, quota] of Object.entries(quotas)) {
		const separator = key.indexOf("/");
		if (separator < 1) continue;
		quotaByModel.set(
			`${key.slice(0, separator)}\0${key.slice(separator + 1)}`,
			quota,
		);
	}
	const requests = new Map<string, Record<UsageWindow, number>>();
	for (const entry of entries) {
		const key = `${entry.provider}\0${entry.model}`;
		if (!quotaByModel.has(key) || entry.timestamp > now) continue;
		let counts = requests.get(key);
		if (!counts) {
			counts = { fiveHours: 0, week: 0, month: 0 };
			requests.set(key, counts);
		}
		for (const window of windows) {
			if (entry.timestamp >= starts[window]) counts[window]++;
		}
	}
	for (const [key, counts] of requests) {
		const quota = quotaByModel.get(key);
		if (!quota) continue;
		for (const window of windows) {
			const quotaLimit = quota[window];
			if (quotaLimit !== null && quotaLimit !== undefined && quotaLimit > 0)
				used[window] += (counts[window] / quotaLimit) * 100;
		}
	}

	for (const window of windows) {
		const elapsed = Math.min(
			1,
			Math.max((now - starts[window]) / usageWindows[window], 0),
		);
		pace[window] = conservativePace(used[window] / 100, elapsed, window);
	}

	return {
		used,
		limit,
		pace,
		pressure: Math.max(pace.fiveHours, pace.week, pace.month),
		pending,
	};
}

const snapshotWindows: Record<UsageWindow, keyof GoUsageSnapshot["usage"]> = {
	fiveHours: "rolling",
	week: "weekly",
	month: "monthly",
};

function usagePeriodStart(window: UsageWindow, resetAt: number): number {
	if (window !== "month") return resetAt - usageWindows[window];
	const reset = new Date(resetAt);
	const day = reset.getUTCDate();
	reset.setUTCDate(1);
	reset.setUTCMonth(reset.getUTCMonth() - 1);
	const lastDay = new Date(Date.UTC(reset.getUTCFullYear(), reset.getUTCMonth() + 1, 0)).getUTCDate();
	reset.setUTCDate(Math.min(day, lastDay));
	return reset.getTime();
}

export function parseGoUsageSnapshot(value: unknown, fetchedAt: number): GoUsageSnapshot {
	if (typeof value !== "object" || value === null || !("usage" in value)) {
		throw new Error("Go usage response must contain a usage object");
	}
	const usageValue = value.usage;
	if (typeof usageValue !== "object" || usageValue === null) {
		throw new Error("Go usage response must contain a usage object");
	}
	const usage = usageValue as Record<string, unknown>;
	const parsed = {} as GoUsageSnapshot["usage"];
	for (const window of Object.values(snapshotWindows)) {
		if (!(window in usage)) throw new Error(`Go usage response is missing ${window}`);
		const entry = usage[window];
		if (
			typeof entry !== "object" || entry === null ||
			!("status" in entry) || typeof entry.status !== "string" ||
			!("percent" in entry) || typeof entry.percent !== "number" ||
			!Number.isFinite(entry.percent) || entry.percent < 0 ||
			!("resetsAt" in entry) || typeof entry.resetsAt !== "string"
		) {
			throw new Error(`Go usage response has invalid ${window} values`);
		}
		const resetAt = Date.parse(entry.resetsAt);
		if (!Number.isFinite(resetAt) || resetAt <= fetchedAt) {
			throw new Error(`Go usage response has invalid ${window} reset time`);
		}
		parsed[window] = {
			status: entry.status,
			percent: entry.percent,
			resetsAt: entry.resetsAt,
			resetAt,
		};
	}
	return { fetchedAt, usage: parsed };
}

export function computeSnapshotMeter(
	snapshot: GoUsageSnapshot,
	ledger: readonly UsageLedgerRecord[],
	goProvider: string,
	now = Date.now(),
): SnapshotMeter {
	const used = { fiveHours: 0, week: 0, month: 0 };
	const limit = { fiveHours: 100, week: 100, month: 100 };
	const pace = { fiveHours: 0, week: 0, month: 0 };
	const pending = { fiveHours: 0, week: 0, month: 0 };
	const starts = { fiveHours: 0, week: 0, month: 0 };

	for (const window of Object.keys(snapshotWindows) as UsageWindow[]) {
		const period = snapshot.usage[snapshotWindows[window]];
		const startAt = usagePeriodStart(window, period.resetAt);
		starts[window] = startAt;
		const duration = period.resetAt - startAt;
		const elapsed = Math.min(1, Math.max((now - startAt) / duration, 0));
		used[window] = period.percent;
		pace[window] = conservativePace(
			period.percent / 100,
			elapsed,
			window,
		);
	}
	for (const entry of ledger) {
		const recordedAt = entry.recordedAt ?? entry.timestamp;
		if (
			entry.provider !== goProvider ||
			recordedAt < snapshot.fetchedAt ||
			entry.timestamp > now
		)
			continue;
		for (const window of Object.keys(snapshotWindows) as UsageWindow[]) {
			if (entry.timestamp >= starts[window]) pending[window]++;
		}
	}

	return {
		used,
		limit,
		pace,
		pressure: Math.max(pace.fiveHours, pace.week, pace.month),
		pending,
	};
}
