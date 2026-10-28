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

		const spread = getDelegateTierCandidates(
			{ ...worker!, tier: 0, fallbackTiers: [] },
			0,
			{
				"0": [
					"opencode-go/provider-a1",
					"opencode-go/provider-a2",
					"openrouter/provider-b",
				],
			},
			[
				{ provider: "opencode-go", id: "provider-a1" },
				{ provider: "opencode-go", id: "provider-a2" },
				{ provider: "openrouter", id: "provider-b" },
			],
		);
		expect(spread).toEqual([
			"opencode-go/provider-a1",
			"openrouter/provider-b",
			"opencode-go/provider-a2",
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
		const events = [
			{ type: "message_end", message: assistantMessage },
			{ type: "turn_end", message: assistantMessage, toolResults: [] },
			{ type: "agent_end", messages: [assistantMessage], willRetry: false },
		].map((event) => JSON.stringify(event)).join("\n");
		const cliPath = join(tempDir, "fake-pi");
		const argPath = join(tempDir, "args.json");
		const script = `#!${process.execPath}\nconst args = process.argv.slice(2);\nconst systemPromptPath = args[args.indexOf("--append-system-prompt") + 1];\nconst userPromptArg = args.find((arg) => arg.startsWith("@"));\nawait Bun.write(${JSON.stringify(argPath)}, JSON.stringify({ args, systemPrompt: await Bun.file(systemPromptPath).text(), userPrompt: await Bun.file(userPromptArg.slice(1)).text() }));\nprocess.stderr.write("diagnostic line\\n");\nprocess.stdout.write(${JSON.stringify(`${events}\n`)});\n`;
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
		const captured = JSON.parse(await readFile(argPath, "utf8")) as {
			args: string[];
			systemPrompt: string;
			userPrompt: string;
		};
		const args = captured.args;
		const systemPromptArgIndex = args.indexOf("--append-system-prompt");
		const systemPromptPath = args[systemPromptArgIndex + 1] ?? "";
		const userPromptArg = args.find((arg) => arg.startsWith("@"));

		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(32 * 1024);
		expect(text).toContain("Full result saved to:");
		expect(args.slice(args.indexOf("--tools") + 1, args.indexOf("--tools") + 2)).toEqual(["read,grep,find,ls"]);
		expect(args).toContain("--no-skills");
		expect(args).toContain("--no-extensions");
		expect(systemPromptArgIndex).toBeGreaterThan(-1);
		expect(systemPromptPath).not.toBe("");
		expect(userPromptArg).toContain("@");
		expect(systemPromptPath.endsWith("system-prompt.txt")).toBe(true);
		expect(userPromptArg!.endsWith("user-prompt.txt")).toBe(true);
		expect(captured.systemPrompt).toContain("This role is read-only");
		expect(captured.userPrompt).toContain("Inspect the test fixture.");
		expect(args).not.toContain("Inspect the test fixture.");
		expect(await Bun.file(systemPromptPath).exists()).toBe(false);
		expect(await Bun.file(userPromptArg!.slice(1)).exists()).toBe(false);
		expect(recorded).toHaveLength(1);
		expect(recorded[0]?.role).toBe("scout");
		expect(recorded[0]?.messages).toHaveLength(1);
		expect(result.usage?.cost.total).toBe(0.25);
		expect((await readdir(join(tempDir, "delegate-logs"))).length).toBe(1);
		const log = await readFile(delegateLogPath, "utf8");
		expect(log).toContain(output);
		expect(log.match(/\[stderr\]/g)).toHaveLength(1);
		expect(closedPane).toEqual({ id: "delegate-pane", delayMs: 15_000 });
	});

	test("returns task setup failures without rejecting parallel task aggregation", async () => {
		const tempDir = await tempDirPromise;
		let registeredTool: ToolDefinition | undefined;
		const pi = {
			registerTool(tool: ToolDefinition) {
				registeredTool = tool;
			},
		} as unknown as ExtensionAPI;
		registerDelegation(pi, {
			dataDir: tempDir,
			async getBudgetCap() {
				return 0;
			},
			getModelCatalog() {
				throw new Error("catalog unavailable");
			},
			async recordUsage() {},
		}, {
			"0": ["opencode-go/mimo-v2.5"],
			"1": [],
			"2": [],
			"3": [],
		});
		const context = {
			cwd: tempDir,
			tools: [],
			modelRegistry: {
				getAvailable: () => [{ provider: "opencode-go", id: "mimo-v2.5" }],
			},
		} as unknown as ExtensionToolContext;

		const result = await registeredTool!.execute(
			"test-parallel-delegate",
			{
				tasks: [
					{ role: "scout", task: "Inspect one." },
					{ role: "scout", task: "Inspect another." },
				],
			},
			undefined,
			undefined,
			context,
		);
		const text = result.content.find((block) => block.type === "text")?.text ?? "";

		expect(result.isError).toBe(true);
		expect(text.match(/catalog unavailable/g)).toHaveLength(2);
	});

	test("retries provider faults across providers but not ordinary task failures", async () => {
		const tempDir = await tempDirPromise;
		const invocationPath = join(tempDir, "provider-retry-count");
		const cliPath = join(tempDir, "provider-retry-pi");
		const successMessage = {
			role: "assistant",
			provider: "openrouter",
			model: "provider-b",
			timestamp: Date.now() + 1,
			content: [{ type: "text", text: "Recovered on another provider." }],
			usage: { cost: { total: 0 } },
			stopReason: "stop",
		};
		const failureMessage = {
			role: "assistant",
			provider: "opencode-go",
			model: "provider-a1",
			timestamp: Date.now(),
			content: [{ type: "text", text: "Temporary provider error." }],
			usage: { cost: { total: 0 } },
			stopReason: "error",
			errorMessage: "HTTP 503 Service Unavailable",
		};
		const script = `#!${process.execPath}\nconst invocationPath = ${JSON.stringify(invocationPath)};\nlet count = 0;\ntry { count = Number(await Bun.file(invocationPath).text()); } catch {}\ncount++;\nawait Bun.write(invocationPath, String(count));\nconst model = process.argv[process.argv.indexOf("--model") + 1];\nconst event = model === "openrouter/provider-b" ? ${JSON.stringify({ type: "message_end", message: successMessage })} : ${JSON.stringify({ type: "message_end", message: failureMessage })};\nprocess.stdout.write(JSON.stringify(event) + "\\n");\n`;
		await Bun.write(cliPath, script);
		await chmod(cliPath, 0o755);
		process.env.PI_CLI_PATH = cliPath;

		let registeredTool: ToolDefinition | undefined;
		const pi = {
			registerTool(tool: ToolDefinition) {
				registeredTool = tool;
			},
		} as unknown as ExtensionAPI;
		registerDelegation(pi, {
			dataDir: tempDir,
			async getBudgetCap() {
				return 0;
			},
			getModelCatalog() {
				return undefined;
			},
			async recordUsage() {},
		}, {
			"0": [
				"opencode-go/provider-a1",
				"opencode-go/provider-a2",
				"openrouter/provider-b",
			],
			"1": [],
			"2": [],
			"3": [],
		});
		const context = {
			cwd: tempDir,
			tools: ["read", "grep", "find", "ls"].map((name) => ({ name })),
			modelRegistry: {
				getAvailable: () => [
					{ provider: "opencode-go", id: "provider-a1" },
					{ provider: "opencode-go", id: "provider-a2" },
					{ provider: "openrouter", id: "provider-b" },
				],
			},
		} as unknown as ExtensionToolContext;

		const result = await registeredTool!.execute(
			"test-provider-retry",
			{ role: "scout", task: "Inspect provider retry behavior." },
			undefined,
			undefined,
			context,
		);
		const details = result.details as {
			results: Array<{ attempts: string[]; output: string }>;
		};

		expect(await readFile(invocationPath, "utf8")).toBe("2");
		expect(details.results[0]?.attempts).toEqual([
			"opencode-go/provider-a1",
			"openrouter/provider-b",
		]);
		expect(details.results[0]?.output).toContain("Recovered");
	});

	test("does not retry an editable role after it has issued a tool call", async () => {
		const tempDir = await tempDirPromise;
		const invocationPath = join(tempDir, "editable-retry-count");
		const cliPath = join(tempDir, "editable-retry-pi");
		const message = {
			role: "assistant",
			provider: "opencode-go",
			model: "editable-a1",
			timestamp: Date.now(),
			content: [
				{ type: "toolCall", id: "edit-1", name: "edit", arguments: {} },
				{ type: "text", text: "The edit was started." },
			],
			usage: { cost: { total: 0 } },
			stopReason: "error",
			errorMessage: "HTTP 503 Service Unavailable",
		};
		const script = `#!${process.execPath}\nconst invocationPath = ${JSON.stringify(invocationPath)};\nlet count = 0;\ntry { count = Number(await Bun.file(invocationPath).text()); } catch {}\nawait Bun.write(invocationPath, String(count + 1));\nprocess.stdout.write(JSON.stringify(${JSON.stringify({ type: "message_end", message })}) + "\\n");\n`;
		await Bun.write(cliPath, script);
		await chmod(cliPath, 0o755);
		process.env.PI_CLI_PATH = cliPath;

		let registeredTool: ToolDefinition | undefined;
		const pi = {
			registerTool(tool: ToolDefinition) {
				registeredTool = tool;
			},
		} as unknown as ExtensionAPI;
		registerDelegation(pi, {
			dataDir: tempDir,
			async getBudgetCap() {
				return 1;
			},
			getModelCatalog() {
				return undefined;
			},
			async recordUsage() {},
		}, {
			"0": ["opencode-go/edit-a0"],
			"1": ["opencode-go/editable-a1", "openrouter/editable-b"],
			"2": [],
			"3": [],
		});
		const context = {
			cwd: tempDir,
			tools: ["read", "grep", "find", "ls", "edit", "write"].map((name) => ({ name })),
			modelRegistry: {
				getAvailable: () => [
					{ provider: "opencode-go", id: "editable-a1" },
					{ provider: "openrouter", id: "editable-b" },
					{ provider: "opencode-go", id: "edit-a0" },
				],
			},
		} as unknown as ExtensionToolContext;

		const result = await registeredTool!.execute(
			"test-editable-retry",
			{ role: "worker", task: "Make the assigned edit." },
			undefined,
			undefined,
			context,
		);

		expect(await readFile(invocationPath, "utf8")).toBe("1");
		expect(result.isError).toBe(true);
	});

	test("does not cool down or retry a model for an ordinary task error", async () => {
		const tempDir = await tempDirPromise;
		const invocationPath = join(tempDir, "task-error-count");
		const cliPath = join(tempDir, "task-error-pi");
		const message = {
			role: "assistant",
			provider: "opencode-go",
			model: "task-error-a1",
			timestamp: Date.now(),
			content: [{ type: "text", text: "The requested operation is invalid." }],
			usage: { cost: { total: 0 } },
			stopReason: "error",
			errorMessage: "Invalid task input: expected 429 tokens of context.",
		};
		const script = `#!${process.execPath}\nconst invocationPath = ${JSON.stringify(invocationPath)};\nlet count = 0;\ntry { count = Number(await Bun.file(invocationPath).text()); } catch {}\nawait Bun.write(invocationPath, String(count + 1));\nprocess.stdout.write(JSON.stringify(${JSON.stringify({ type: "message_end", message })}) + "\\n");\n`;
		await Bun.write(cliPath, script);
		await chmod(cliPath, 0o755);
		process.env.PI_CLI_PATH = cliPath;

		let registeredTool: ToolDefinition | undefined;
		const pi = {
			registerTool(tool: ToolDefinition) {
				registeredTool = tool;
			},
		} as unknown as ExtensionAPI;
		registerDelegation(pi, {
			dataDir: tempDir,
			async getBudgetCap() {
				return 0;
			},
			getModelCatalog() {
				return undefined;
			},
			async recordUsage() {},
		}, {
			"0": [
				"opencode-go/task-error-a1",
				"opencode-go/task-error-a2",
				"openrouter/task-error-b",
			],
			"1": [],
			"2": [],
			"3": [],
		});
		const context = {
			cwd: tempDir,
			tools: ["read", "grep", "find", "ls"].map((name) => ({ name })),
			modelRegistry: {
				getAvailable: () => [
					{ provider: "opencode-go", id: "task-error-a1" },
					{ provider: "opencode-go", id: "task-error-a2" },
					{ provider: "openrouter", id: "task-error-b" },
				],
			},
		} as unknown as ExtensionToolContext;

		const result = await registeredTool!.execute(
			"test-task-error",
			{ role: "scout", task: "Run the unsupported operation." },
			undefined,
			undefined,
			context,
		);

		expect(await readFile(invocationPath, "utf8")).toBe("1");
		expect(result.isError).toBe(true);
		await registeredTool!.execute(
			"test-task-error-again",
			{ role: "scout", task: "Run the unsupported operation again." },
			undefined,
			undefined,
			context,
		);
		expect(await readFile(invocationPath, "utf8")).toBe("2");
	});

	test("opens a provider circuit after repeated provider faults", async () => {
		const tempDir = await tempDirPromise;
		const invocationPath = join(tempDir, "circuit-failure-count");
		const cliPath = join(tempDir, "circuit-pi");
		const message = {
			role: "assistant",
			provider: "test-provider",
			model: "model-a1",
			timestamp: Date.now(),
			content: [{ type: "text", text: "Provider unavailable." }],
			usage: { cost: { total: 0 } },
			stopReason: "error",
			errorMessage: "HTTP 503 Service Unavailable",
		};
		const script = `#!${process.execPath}\nconst invocationPath = ${JSON.stringify(invocationPath)};\nlet count = 0;\ntry { count = Number(await Bun.file(invocationPath).text()); } catch {}\nawait Bun.write(invocationPath, String(count + 1));\nprocess.stdout.write(JSON.stringify(${JSON.stringify({ type: "message_end", message })}) + "\\n");\n`;
		await Bun.write(cliPath, script);
		await chmod(cliPath, 0o755);
		process.env.PI_CLI_PATH = cliPath;

		let registeredTool: ToolDefinition | undefined;
		const pi = {
			registerTool(tool: ToolDefinition) {
				registeredTool = tool;
			},
		} as unknown as ExtensionAPI;
		const tierModels = {
			"0": [
				"test-provider/model-a1",
				"test-provider/model-a2",
				"test-provider/model-a3",
			],
			"1": [],
			"2": [],
			"3": [],
		};
		registerDelegation(pi, {
			dataDir: tempDir,
			async getBudgetCap() {
				return 0;
			},
			getModelCatalog() {
				return undefined;
			},
			async recordUsage() {},
		}, tierModels);
		const context = {
			cwd: tempDir,
			tools: ["read", "grep", "find", "ls"].map((name) => ({ name })),
			modelRegistry: {
				getAvailable: () =>
					tierModels["0"]!.map((ref) => ({
						provider: "test-provider",
						id: ref.slice("test-provider/".length),
					})),
			},
		} as unknown as ExtensionToolContext;

		const first = await registeredTool!.execute(
			"test-provider-circuit",
			{ role: "scout", task: "Check provider availability." },
			undefined,
			undefined,
			context,
		);
		expect(first.isError).toBe(true);
		expect(await readFile(invocationPath, "utf8")).toBe("2");

		const second = await registeredTool!.execute(
			"test-provider-circuit-open",
			{ role: "scout", task: "Check whether the circuit is open." },
			undefined,
			undefined,
			context,
		);
		expect(second.isError).toBe(true);
		expect(await readFile(invocationPath, "utf8")).toBe("2");
	});
});
