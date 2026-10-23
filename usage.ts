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

	for (const window of Object.keys(snapshotWindows) as UsageWindow[]) {
		const period = snapshot.usage[snapshotWindows[window]];
		const startAt = usagePeriodStart(window, period.resetAt);
		const duration = period.resetAt - startAt;
		const elapsed = Math.min(1, Math.max((now - startAt) / duration, 0.01));
		used[window] = period.percent;
		pace[window] = period.percent / 100 / elapsed;
		pending[window] = ledger.filter((entry) => {
			const recordedAt = entry.recordedAt ?? entry.timestamp;
			return entry.provider === goProvider &&
				recordedAt >= snapshot.fetchedAt &&
				entry.timestamp >= startAt &&
				entry.timestamp <= now;
		}).length;
	}

	return {
		used,
		limit,
		pace,
		pressure: Math.max(pace.fiveHours, pace.week, pace.month),
		pending,
	};
}
