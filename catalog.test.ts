import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	parseModelCatalog,
	rankCatalogModels,
	refreshModelCatalog,
} from "./catalog.ts";

const tempDirPromise = mkdtemp(join(tmpdir(), "ogo-catalog-test-"));

afterAll(async () => {
	await rm(await tempDirPromise, { recursive: true, force: true });
});

describe("models.dev catalog", () => {
	test("parses provider metadata and ranks configured same-tier models by price", () => {
		const catalog = parseModelCatalog({
			"opencode-go": {
				models: {
					expensive: { cost: { input: 2, output: 4 }, tool_call: true },
					cheap: { cost: { input: 0.2, output: 0.4 }, tool_call: true },
					unsupported: { cost: { input: 0, output: 0 }, tool_call: false },
					unpriced: { tool_call: true },
				},
			},
		}, "opencode-go", 500);
		const candidates = [
			"opencode-go/expensive",
			"opencode-go/unsupported",
			"opencode-go/cheap",
			"opencode-go/unpriced",
		];

		expect(rankCatalogModels(candidates, "opencode-go", catalog, true)).toEqual([
			"opencode-go/cheap",
			"opencode-go/expensive",
			"opencode-go/unpriced",
		]);
		expect(rankCatalogModels(candidates, "opencode-go", undefined, false)).toEqual(candidates);
	});

	test("refreshes sparingly, reports pricing changes, and keeps stale cache on errors", async () => {
		const tempDir = await tempDirPromise;
		const options = {
			url: "https://models.dev/api.json",
			provider: "opencode-go",
			cachePath: join(tempDir, "catalog.json"),
			refreshIntervalMs: 10_000,
			timeoutMs: 90_000,
		};
		let calls = 0;
		let inputPrice = 0.1;
		const fetcher = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			calls++;
			expect(init?.signal).toBeDefined();
			return Response.json({
				"opencode-go": {
					models: { model: { cost: { input: inputPrice, output: 0.5 }, tool_call: true } },
				},
			});
		};

		const first = await refreshModelCatalog(options, 1_000, fetcher);
		expect(first.snapshot?.models.model?.input).toBe(0.1);
		expect(first.changedPrices).toEqual([]);
		const fresh = await refreshModelCatalog(options, 5_000, fetcher);
		expect(fresh.snapshot?.fetchedAt).toBe(1_000);
		expect(calls).toBe(1);

		inputPrice = 0.2;
		const updated = await refreshModelCatalog(options, 12_000, fetcher);
		expect(updated.changedPrices).toEqual(["model"]);
		expect(updated.snapshot?.models.model?.input).toBe(0.2);

		const failed = await refreshModelCatalog(options, 23_000, async () => {
			throw new DOMException("request timed out", "TimeoutError");
		});
		expect(failed.snapshot?.models.model?.input).toBe(0.2);
		expect(failed.error).toContain("timed out");
		const throttled = await refreshModelCatalog(options, 24_000, async () => {
			throw new Error("should not be called again within the refresh interval");
		});
		expect(throttled.snapshot?.models.model?.input).toBe(0.2);
		expect(throttled.error).toContain("timed out");
	});

	test("rejects catalog payloads without the configured provider", () => {
		expect(() => parseModelCatalog({ providers: {} }, "opencode-go", 100)).toThrow(
			'missing provider "opencode-go" models',
		);
	});
});
