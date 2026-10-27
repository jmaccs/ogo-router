import { describe, expect, test } from "bun:test";
import {
	computeLocalMeter,
	computeSnapshotMeter,
	parseGoUsageSnapshot,
	usageWindows,
} from "./usage.ts";

const now = Date.UTC(2026, 9, 23, 12);

function response() {
	return {
		usage: {
			rolling: { status: "ok", percent: 50, resetsAt: new Date(now + usageWindows.fiveHours - 4 * 60 * 60 * 1000).toISOString() },
			weekly: { status: "ok", percent: 75, resetsAt: new Date(now + usageWindows.week - 5 * 24 * 60 * 60 * 1000).toISOString() },
			monthly: { status: "ok", percent: 10, resetsAt: new Date(now + usageWindows.month - 10 * 24 * 60 * 60 * 1000).toISOString() },
		},
	};
}

describe("Go usage snapshots", () => {
	test("validates API windows and calculates pace plus unsynced local requests", () => {
		const snapshot = parseGoUsageSnapshot(response(), now);
		const meter = computeSnapshotMeter(
			snapshot,
			[
				{ provider: "opencode-go", model: "m1", cost: 0, timestamp: now, recordedAt: now + 1 },
				{ provider: "opencode-go", model: "m2", cost: 0, timestamp: now, recordedAt: now - 1 },
				{ provider: "opencode-go", model: "m3", cost: 0, timestamp: now, recordedAt: now },
				{ provider: "openrouter", model: "m4", cost: 0, timestamp: now, recordedAt: now + 1 },
			],
			"opencode-go",
			now,
		);

		expect(meter.used).toEqual({ fiveHours: 50, week: 75, month: 10 });
		expect(meter.pending).toEqual({ fiveHours: 2, week: 2, month: 2 });
		expect(meter.pressure).toBeCloseTo(1.05);
	});

	test("rejects malformed usage windows and expired reset times", () => {
		expect(() => parseGoUsageSnapshot({ usage: {} }, now)).toThrow("missing rolling");
		expect(() =>
			parseGoUsageSnapshot(
				{
					usage: {
						...response().usage,
						rolling: { status: "ok", percent: "50", resetsAt: new Date(now + 1_000).toISOString() },
					},
				},
				now,
			),
		).toThrow("invalid rolling");
		expect(() =>
			parseGoUsageSnapshot(
				{
					usage: {
						...response().usage,
						rolling: { status: "ok", percent: 50, resetsAt: new Date(now - 1_000).toISOString() },
					},
				},
				now,
			),
		).toThrow("invalid rolling reset time");
	});

	test("weights local requests by their own model quota and uses rolling five hours", () => {
		const now = Date.UTC(2026, 9, 23, 12, 2);
		const quotas = {
			"opencode-go/high-quota": {
				fiveHours: 100,
				week: 100,
				month: 100,
			},
			"opencode-go/low-quota": {
				fiveHours: 10,
				week: 10,
				month: 10,
			},
		};
		const entries = [
			{
				provider: "opencode-go",
				model: "high-quota",
				cost: 0,
				timestamp: now,
			},
			...Array.from({ length: 10 }, () => ({
				provider: "opencode-go",
				model: "low-quota",
				cost: 0,
				timestamp: now,
			})),
			{
				provider: "opencode-go",
				model: "low-quota",
				cost: 0,
				timestamp: now - usageWindows.fiveHours - 1,
			},
		];

		const meter = computeLocalMeter(entries, quotas, now);

		expect(meter.used.fiveHours).toBeCloseTo(101);
		expect(meter.limit.fiveHours).toBe(100);
	});

	test("does not turn a small early-window burst into red pace", () => {
		const now = Date.UTC(2026, 9, 23, 12, 2);
		const meter = computeLocalMeter(
			[
				{
					provider: "opencode-go",
					model: "m1",
					cost: 0,
					timestamp: now,
				},
			],
			{
				"opencode-go/m1": {
					fiveHours: 100,
					week: 100,
					month: 100,
				},
			},
			now,
		);

		expect(meter.pace.fiveHours).toBeLessThan(0.8);
		expect(meter.pressure).toBeLessThan(0.8);
	});
});
