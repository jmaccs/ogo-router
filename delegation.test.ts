import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionToolContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { parseModelCatalog } from "./catalog.ts";
import {
	getDelegateTierCandidates,
	loadDelegationRoles,
	loadDelegationSkills,
	registerDelegation,
} from "./delegation.ts";

const tempDirPromise = mkdtemp(join(tmpdir(), "ogo-delegation-test-"));
const originalCliPath = process.env.PI_CLI_PATH;

afterAll(async () => {
	if (originalCliPath === undefined) delete process.env.PI_CLI_PATH;
	else process.env.PI_CLI_PATH = originalCliPath;
	await rm(await tempDirPromise, { recursive: true, force: true });
});

describe("OGO delegation", () => {
	test("loads numeric role tiers and enforces role tier preferences under the budget cap", async () => {
		const roles = await loadDelegationRoles();
		const worker = roles.get("worker");
		expect(worker).toBeDefined();
		expect(worker?.tier).toBe(1);
		expect(worker?.fallbackTiers).toEqual([0]);

		const config = await Bun.file(new URL("./router.json", import.meta.url).pathname).json() as {
			tierModels: Record<string, string[]>;
		};
		const availableModels = Object.values(config.tierModels).flat().map((ref) => {
			const [provider, ...id] = ref.split("/");
			return { provider: provider!, id: id.join("/") };
		});
		const candidates = getDelegateTierCandidates(worker!, 3, config.tierModels, availableModels);
		expect(candidates.every((model) => config.tierModels["1"]!.includes(model) || config.tierModels["0"]!.includes(model))).toBe(true);
		expect(candidates.some((model) => config.tierModels["1"]!.includes(model))).toBe(true);
		const fallbackCandidates = getDelegateTierCandidates(worker!, 0, config.tierModels, availableModels);
		expect(fallbackCandidates.every((model) => config.tierModels["0"]!.includes(model))).toBe(true);
		expect(fallbackCandidates.length).toBeGreaterThan(0);

		const tierModels = {
			"0": ["opencode-go/t0"],
			"1": ["opencode-go/t1-expensive", "opencode-go/t1-cheap", "opencode-go/no-tools"],
			"2": ["opencode-go/t2"],
		};
		const dynamicCatalog = parseModelCatalog({
			"opencode-go": {
				models: {
					"t0": { cost: { input: 0.1, output: 0.1 }, tool_call: true },
					"t1-expensive": { cost: { input: 2, output: 3 }, tool_call: true },
					"t1-cheap": { cost: { input: 0.1, output: 0.2 }, tool_call: true },
					"no-tools": { cost: { input: 0, output: 0 }, tool_call: false },
					"t2": { cost: { input: 0, output: 0 }, tool_call: true },
				},
			},
		}, "opencode-go", Date.now());
		const dynamicallyRanked = getDelegateTierCandidates(
			worker!,
			1,
			tierModels,
			Object.values(tierModels).flat().map((ref) => {
				const slash = ref.indexOf("/");
				return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
			}),
			dynamicCatalog,
			true,
		);
		expect(dynamicallyRanked).toEqual([
			"opencode-go/t1-cheap",
			"opencode-go/t1-expensive",
			"opencode-go/t0",
		]);
	});

	test("preloads only skills named in the role allowlist", async () => {
		const tempDir = await tempDirPromise;
		const skillPath = join(tempDir, ".agents", "skills", "fixture", "SKILL.md");
		await mkdir(join(tempDir, ".agents", "skills", "fixture"), { recursive: true });
		await writeFile(skillPath, "Use the fixture skill for this delegated task.", "utf8");
		const roles = await loadDelegationRoles();
		const scout = roles.get("scout")!;
		const allowed = await loadDelegationSkills({ ...scout, skills: ["fixture"] }, tempDir);
		const denied = await loadDelegationSkills({ ...scout, skills: [] }, tempDir);

		expect(allowed).toEqual([{ path: skillPath, text: "Use the fixture skill for this delegated task." }]);
		expect(denied).toEqual([]);
	});

	test("runs a scoped subprocess, spills oversized output, and records role usage", async () => {
		const tempDir = await tempDirPromise;
		const output = "x".repeat(40_000);
		const assistantMessage = {
			role: "assistant",
			provider: "opencode-go",
			model: "mimo-v2.5",
			timestamp: Date.now(),
			content: [{ type: "text", text: output }],
			usage: {
				input: 12,
				output: 34,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 46,
				cost: { input: 0.1, output: 0.15, cacheRead: 0, cacheWrite: 0, total: 0.25 },
			},
			stopReason: "stop",
		};
		const event = JSON.stringify({ type: "message_end", message: assistantMessage });
		const cliPath = join(tempDir, "fake-pi");
		const argPath = join(tempDir, "args.json");
		const script = `#!${process.execPath}\nawait Bun.write(${JSON.stringify(argPath)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(${JSON.stringify(`${event}\n`)});\n`;
		await Bun.write(cliPath, script);
		await chmod(cliPath, 0o755);
		process.env.PI_CLI_PATH = cliPath;

		let registeredTool: ToolDefinition | undefined;
		let delegateLogPath = "";
		let closedPane: { id: string | undefined; delayMs: number } | undefined;
		const pi = {
			registerTool(tool: ToolDefinition) {
				registeredTool = tool;
			},
		} as unknown as ExtensionAPI;
		const recorded: { messages: unknown[]; role: string }[] = [];
		registerDelegation(pi, {
			dataDir: tempDir,
			async getBudgetCap() {
				return 0;
			},
			getModelCatalog() {
				return undefined;
			},
			async recordUsage(messages, role) {
				recorded.push({ messages, role });
			},
			panes: {
				async open(logPath) {
					delegateLogPath = logPath;
					return "delegate-pane";
				},
				closeLater(id, delayMs) {
					closedPane = { id, delayMs };
				},
			},
		}, {
			"0": ["opencode-go/mimo-v2.5"],
			"1": [],
			"2": [],
			"3": [],
		});

		const context = {
			cwd: tempDir,
			tools: ["read", "grep", "find", "ls", "bash", "edit", "write", "delegate"].map((name) => ({ name })),
			modelRegistry: { getAvailable: () => [{ provider: "opencode-go", id: "mimo-v2.5" }] },
		} as unknown as ExtensionToolContext;
		const result = await registeredTool!.execute(
			"test-delegate",
			{ role: "scout", task: "Inspect the test fixture." },
			undefined,
			undefined,
			context,
		);
		const text = result.content.find((block) => block.type === "text")?.text ?? "";
		const args = JSON.parse(await readFile(argPath, "utf8")) as string[];

		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(32 * 1024);
		expect(text).toContain("Full result saved to:");
		expect(args.slice(args.indexOf("--tools") + 1, args.indexOf("--tools") + 2)).toEqual(["read,grep,find,ls"]);
		expect(args).toContain("--no-skills");
		expect(recorded).toHaveLength(1);
		expect(recorded[0]?.role).toBe("scout");
		expect(recorded[0]?.messages).toHaveLength(1);
		expect(result.usage?.cost.total).toBe(0.25);
		expect((await readdir(join(tempDir, "delegate-logs"))).length).toBe(1);
		expect(await readFile(delegateLogPath, "utf8")).toContain(output);
		expect(closedPane).toEqual({ id: "delegate-pane", delayMs: 15_000 });
	});
});
