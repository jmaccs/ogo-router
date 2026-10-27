import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Usage } from "@earendil-works/pi-ai";
import {
  parseFrontmatter,
  type ExtensionAPI,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { rankCatalogModels, type ModelCatalogSnapshot } from "./catalog.ts";
import { updateDashboard } from "./ui.ts";

const root = dirname(fileURLToPath(import.meta.url));
const rolesDir = join(root, "agents");
const maxParallelTasks = 4;
const maxAttempts = 3;
const maxOutputBytes = 32 * 1024;
const maxProcessOutputBytes = 8 * 1024 * 1024;
const maxStderrBytes = 64 * 1024;
const processTimeoutMs = 2 * 60 * 1000;
const circuitCooldownMs = 60 * 1000;
const providerFailureThreshold = 2;
const modelCooldowns = new Map<string, number>();
type ProviderCircuit = {
  failures: number;
  openUntil: number;
  halfOpenInFlight: boolean;
};
type ProviderFailureKind =
  | "rate-limit"
  | "server"
  | "network"
  | "timeout"
  | "other";
const providerCircuits = new Map<string, ProviderCircuit>();

class DelegateAttemptError extends Error {
  constructor(
    message: string,
    readonly kind: ProviderFailureKind,
    readonly toolCallsOccurred: boolean,
    readonly providerResponded = false,
  ) {
    super(message);
    this.name = "DelegateAttemptError";
  }
}

type RoleTier = 0 | 1 | 2 | 3;
type RoleFrontmatter = {
  name?: unknown;
  description?: unknown;
  tier?: unknown;
  fallback_tiers?: unknown;
  tools?: unknown;
  skills?: unknown;
  editable?: unknown;
  parallel?: unknown;
};
export type RoleProfile = {
  name: string;
  description: string;
  tier: RoleTier;
  fallbackTiers: RoleTier[];
  tools: string[];
  skills: string[];
  editable: boolean;
  parallel: boolean;
  systemPrompt: string;
};
type Task = {
  role: string;
  task: string;
  acceptanceCriteria?: string[];
};
type DelegateParams = {
  role?: string;
  task?: string;
  acceptanceCriteria?: string[];
  tasks?: Task[];
};
type AssistantUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: Usage["cost"];
};
type SubtaskResult = {
  role: string;
  task: string;
  model?: string;
  output: string;
  outputPath?: string;
  usage: AssistantUsage;
  attempts: string[];
};
type DelegateDetails = {
  mode: "single" | "parallel";
  results: SubtaskResult[];
  usage: AssistantUsage;
};
type DelegationOptions = {
  dataDir: string;
  getBudgetCap: (ctx: ExtensionToolContext) => Promise<RoleTier>;
  getModelCatalog: () => ModelCatalogSnapshot | undefined;
  recordUsage: (messages: unknown[], role: string) => Promise<void>;
  panes?: {
		open(logFile: string, title: string): Promise<string | undefined>;
		closeLater(paneId: string | undefined, delayMs: number): void;
	};
};

const TaskSchema = Type.Object({
  role: Type.String({
    description:
      "Role to use: scout, mechanic, planner, worker, reviewer, debugger, or summarizer.",
  }),
  task: Type.String({
    description:
      "The bounded task and relevant context to pass to this isolated agent.",
  }),
  acceptanceCriteria: Type.Optional(Type.Array(Type.String())),
});

const DelegateParamsSchema = Type.Object({
  role: Type.Optional(
    Type.String({ description: "Role name for a single delegated task." }),
  ),
  task: Type.Optional(
    Type.String({ description: "Task brief for single-task mode." }),
  ),
  acceptanceCriteria: Type.Optional(Type.Array(Type.String())),
  tasks: Type.Optional(
    Type.Array(TaskSchema, {
      maxItems: maxParallelTasks,
      description: `Independent read-only scout tasks to run in parallel (maximum ${maxParallelTasks}).`,
    }),
  ),
});

function createTaskLog(dataDir: string, role: string) {
  const dir = join(dataDir, "delegate-logs");
  mkdirSync(dir, { recursive: true });
  const path = join(
    dir,
    `${Date.now()}-${role}-${crypto.randomUUID().slice(0, 8)}.log`,
  );
  const write = (text: string) => {
    try {
      appendFileSync(path, `${text}\n`, { mode: 0o600 });
    } catch {
      /* logging must never fail a task */
    }
  };
  return { path, write };
}

function isTier(value: unknown): value is RoleTier {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 3
  );
}

function parseStringList(
  value: unknown,
  field: string,
  role: string,
): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new Error(
      `Role "${role}" must declare ${field} as a list of strings`,
    );
  }
  return value;
}

function parseTierList(value: unknown, role: string): RoleTier[] {
  if (!Array.isArray(value) || !value.every(isTier)) {
    throw new Error(
      `Role "${role}" must declare fallback_tiers as a list of tier numbers`,
    );
  }
  return value;
}

export async function loadDelegationRoles(): Promise<Map<string, RoleProfile>> {
  const files = await readdir(rolesDir, { withFileTypes: true });
  const roles = new Map<string, RoleProfile>();
  for (const entry of files) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = join(rolesDir, entry.name);
    const content = await readFile(filePath, "utf8");
    const { frontmatter, body } = parseFrontmatter<RoleFrontmatter>(content);
    const name = typeof frontmatter.name === "string" ? frontmatter.name : "";
    if (!name || roles.has(name))
      throw new Error(`Invalid or duplicate role name in ${filePath}`);
    if (
      typeof frontmatter.description !== "string" ||
      !frontmatter.description.trim()
    ) {
      throw new Error(`Role "${name}" must have a description`);
    }
    if (!isTier(frontmatter.tier))
      throw new Error(`Role "${name}" must declare tier 0-3`);
    const fallbackTiers = parseTierList(frontmatter.fallback_tiers, name);
    const skills = parseStringList(frontmatter.skills, "skills", name);
    const tools = parseStringList(frontmatter.tools, "tools", name);
    if (
      typeof frontmatter.editable !== "boolean" ||
      typeof frontmatter.parallel !== "boolean"
    ) {
      throw new Error(
        `Role "${name}" must declare editable and parallel booleans`,
      );
    }
    roles.set(name, {
      name,
      description: frontmatter.description,
      tier: frontmatter.tier,
      fallbackTiers,
      tools,
      skills,
      editable: frontmatter.editable,
      parallel: frontmatter.parallel,
      systemPrompt: body.trim(),
    });
  }
  return roles;
}

function emptyUsage(): AssistantUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function addUsage(
  total: AssistantUsage,
  message: Record<string, unknown>,
): void {
  const usage = message.usage;
  if (typeof usage !== "object" || usage === null) return;
  const value = usage as Record<string, unknown>;
  for (const field of [
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "totalTokens",
  ] as const) {
    if (typeof value[field] === "number" && Number.isFinite(value[field]))
      total[field] += value[field];
  }
  if (typeof value.cost !== "object" || value.cost === null) return;
  const cost = value.cost as Record<string, unknown>;
  for (const field of [
    "input",
    "output",
    "cacheRead",
    "cacheWrite",
    "total",
  ] as const) {
    if (typeof cost[field] === "number" && Number.isFinite(cost[field]))
      total.cost[field] += cost[field];
  }
}

function toUsage(usage: AssistantUsage): Usage {
  return {
    ...usage,
    reasoning: undefined,
    totalTokens: usage.totalTokens,
    cost: { ...usage.cost },
  };
}

function addAssistantMessages(
  usage: AssistantUsage,
  messages: readonly unknown[],
): void {
  for (const message of messages) {
    if (isAssistantMessage(message)) addUsage(usage, message);
  }
}

function byteTruncate(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const marker = "\n\n[truncated]";
  const contentLimit = Math.max(
    0,
    maxBytes - Buffer.byteLength(marker, "utf8"),
  );
  const output = Buffer.from(text, "utf8")
    .subarray(0, contentLimit)
    .toString("utf8");
  return `${output}${marker}`;
}

function byteTruncateTail(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const marker = "[stderr truncated; showing tail]\n\n";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const contentLimit = Math.max(0, maxBytes - markerBytes);
  const bytes = Buffer.from(text, "utf8");
  const tail = (contentLimit ? bytes.subarray(-contentLimit) : Buffer.alloc(0))
    .toString("utf8");
  return `${marker}${tail}`;
}

function isAssistantMessage(value: unknown): value is Record<
  string,
  unknown
> & {
  role: "assistant";
  provider: string;
  model: string;
  timestamp: number;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "role" in value &&
    value.role === "assistant" &&
    "provider" in value &&
    typeof value.provider === "string" &&
    "model" in value &&
    typeof value.model === "string" &&
    "timestamp" in value &&
    typeof value.timestamp === "number"
  );
}

function getText(message: Record<string, unknown>): string {
  if (!Array.isArray(message.content)) return "";
  return message.content
    .flatMap((part) =>
      typeof part === "object" &&
      part !== null &&
      "type" in part &&
      part.type === "text" &&
      "text" in part &&
      typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("\n");
}

function availableTools(ctx: ExtensionToolContext): string[] {
  return ctx.tools
    .map((tool) => tool.name)
    .filter((name) => name !== "delegate" && !name.startsWith("ogo_"));
}

function toolsForRole(role: RoleProfile, ctx: ExtensionToolContext): string[] {
  const available = new Set(availableTools(ctx));
  if (role.tools.includes("*")) return [...available];
  return role.tools.filter((tool) => available.has(tool));
}

async function findSkill(
  cwd: string,
  name: string,
): Promise<string | undefined> {
  const roots = new Set<string>([
    join(homedir(), ".pi", "agent", "skills"),
    join(homedir(), ".agents", "skills"),
  ]);
  let current = resolve(cwd);
  while (true) {
    roots.add(join(current, ".agents", "skills"));
    roots.add(join(current, ".pi", "skills"));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const base of roots) {
    const direct = join(base, name, "SKILL.md");
    try {
      if ((await stat(direct)).isFile()) return direct;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        continue;
      }
      throw error;
    }
  }
  return undefined;
}

export async function loadDelegationSkills(
  role: RoleProfile,
  cwd: string,
): Promise<Array<{ path: string; text: string }>> {
  const skills: Array<{ path: string; text: string }> = [];
  for (const name of role.skills) {
    const path = await findSkill(cwd, name);
    if (!path)
      throw new Error(
        `Role "${role.name}" allows skill "${name}", but SKILL.md was not found`,
      );
    skills.push({ path, text: await readFile(path, "utf8") });
  }
  return skills;
}

function modelCandidates(
  role: RoleProfile,
  cap: RoleTier,
  tierModels: Record<string, string[]>,
  availableModels: readonly { provider: string; id: string }[],
  catalog?: ModelCatalogSnapshot,
  requiresToolCalls = false,
): string[] {
  const tiers = [...new Set([role.tier, ...role.fallbackTiers])].filter(
    (tier) => tier <= cap,
  );
  const available = new Set(
    availableModels.map((model) => `${model.provider}/${model.id}`),
  );
  const now = Date.now();
  const candidates = [
    ...new Set(
      tiers.flatMap((tier) => {
        const tierCandidates = (tierModels[String(tier)] ?? []).filter(
          (model) => available.has(model),
        );
        return spreadProviders(
          rankCatalogModels(
            tierCandidates,
            "opencode-go",
            catalog,
            requiresToolCalls,
          ),
        );
      }),
    ),
  ];
  const healthy = candidates.filter(
    (model) =>
      (modelCooldowns.get(model) ?? 0) <= now &&
      !providerIsOpen(providerFromModel(model), now),
  );
  return healthy.slice(0, 12);
}

function providerFromModel(model: string): string {
  const separator = model.indexOf("/");
  return separator < 1 ? model : model.slice(0, separator);
}

function providerIsOpen(provider: string, now = Date.now()): boolean {
  const circuit = providerCircuits.get(provider);
  return Boolean(
    circuit &&
      circuit.failures >= providerFailureThreshold &&
      circuit.openUntil > now,
  );
}

function acquireProvider(provider: string, now = Date.now()): boolean {
  const circuit = providerCircuits.get(provider);
  if (!circuit || circuit.failures < providerFailureThreshold) return true;
  if (circuit.openUntil > now || circuit.halfOpenInFlight) return false;
  circuit.halfOpenInFlight = true;
  return true;
}

function recordProviderSuccess(provider: string): void {
  providerCircuits.delete(provider);
}

function releaseProviderProbe(provider: string): void {
  const circuit = providerCircuits.get(provider);
  if (!circuit) return;
  if (circuit.failures >= providerFailureThreshold) {
    circuit.halfOpenInFlight = false;
    circuit.openUntil =
      Date.now() + circuitCooldownMs * (0.8 + Math.random() * 0.4);
    return;
  }
  circuit.halfOpenInFlight = false;
}

function recordProviderFailure(provider: string, now = Date.now()): void {
  const circuit = providerCircuits.get(provider) ?? {
    failures: 0,
    openUntil: 0,
    halfOpenInFlight: false,
  };
  const wasHalfOpen =
    circuit.failures >= providerFailureThreshold && circuit.halfOpenInFlight;
  circuit.halfOpenInFlight = false;
  circuit.failures++;
  if (circuit.failures >= providerFailureThreshold || wasHalfOpen) {
    const jitter = 0.8 + Math.random() * 0.4;
    circuit.openUntil = now + circuitCooldownMs * jitter;
  }
  providerCircuits.set(provider, circuit);
}

function providerFailureKind(
  message: string,
  error?: unknown,
): ProviderFailureKind {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
  if (
    /\bHTTP\s*429\b|\bstatus(?:\s+code)?\s*429\b|\b429\s+(?:too many requests|rate.?limit)\b|rate.?limit|quota exceeded|too many requests|resource exhausted/i.test(
      message,
    )
  )
    return "rate-limit";
  if (
    /\b(?:HTTP\s*|status(?:\s+code)?\s*)5\d{2}\b|\b5\d{2}\s+(?:server|internal server)\b/i.test(
      message,
    )
  )
    return "server";
  if (
    /^(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN)$/.test(
      code,
    ) ||
    /fetch failed|network error|connection (?:reset|refused|closed|lost)/i.test(
      message,
    )
  )
    return "network";
  if (/delegate timed out|timed out after \d+s/i.test(message))
    return "timeout";
  return "other";
}

function isProviderFault(kind: ProviderFailureKind): boolean {
  return kind === "rate-limit" || kind === "server" || kind === "network";
}

function spreadProviders(candidates: readonly string[]): string[] {
  const providers = new Map<string, string[]>();
  for (const candidate of candidates) {
    const provider = providerFromModel(candidate);
    const bucket = providers.get(provider) ?? [];
    bucket.push(candidate);
    providers.set(provider, bucket);
  }
  const ordered: string[] = [];
  while (providers.size) {
    for (const [provider, bucket] of providers) {
      const model = bucket.shift();
      if (model) ordered.push(model);
      if (!bucket.length) providers.delete(provider);
    }
  }
  return ordered;
}

async function runModel(
  model: string,
  role: RoleProfile,
  task: Task,
  cwd: string,
  tools: string[],
  skills: Array<{ path: string; text: string }>,
  signal: AbortSignal | undefined,
  onUsage: (messages: unknown[], role: string) => Promise<void>,
  onProgress: (output: string) => void,
  log: (text: string) => void,
): Promise<SubtaskResult> {
  const systemPrompt = [
    role.systemPrompt,
    ...skills.map(
      (skill) =>
        `## Preloaded skill: ${basename(dirname(skill.path))}\n\n${skill.text}`,
    ),
    role.editable
      ? "Editing is allowed only within the explicitly assigned scope."
      : "This role is read-only; do not create, modify, or delete files.",
    "Do not delegate further.",
  ]
    .filter(Boolean)
    .join("\n\n");
  const userPrompt = [
    "## Delegation brief",
    `Role: ${role.name}`,
    `Task:\n${task.task}`,
    task.acceptanceCriteria?.length
      ? `Acceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const args = [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--no-extensions",
    "--model",
    model,
  ];
  if (tools.length) args.push("--tools", tools.join(","));
  else args.push("--no-tools");
  args.push("--exclude-tools", "delegate", "--no-skills");
  args.push("--append-system-prompt", systemPrompt, userPrompt);

  const result: SubtaskResult = {
    role: role.name,
    task: task.task,
    model,
    output: "",
    usage: emptyUsage(),
    attempts: [model],
  };
  const messages: unknown[] = [];
  const messageTimestamps = new Set<number>();
  let toolCallsOccurred = false;
  let stderr = "";
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  let outputBytes = 0;
  let buffer = "";
  let aborted = false;
  let protocolError: Error | undefined;
  let processError: Error | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let terminateChild: () => void = () => {};

  const processMessage = (line: string) => {
    if (!line.trim()) return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch (error) {
      protocolError ??= new Error(
        `Invalid JSON from delegated Pi process: ${error instanceof Error ? error.message : String(error)}`,
      );
      terminateChild();
      return;
    }
    if (
      typeof event !== "object" ||
      event === null ||
      !("type" in event) ||
      event.type !== "message_end" ||
      !("message" in event)
    )
      return;
    const message = event.message;
    if (!isAssistantMessage(message)) return;
    if (!Number.isFinite(message.timestamp)) {
      protocolError ??= new Error(
        "Delegated Pi process returned an assistant message with invalid timestamp",
      );
      terminateChild();
      return;
    }
    if (messageTimestamps.has(message.timestamp))
      return;
    if (
      typeof message.provider !== "string" ||
      !message.provider ||
      typeof message.model !== "string" ||
      !message.model ||
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
      protocolError ??= new Error(
        "Delegated Pi process returned an assistant message with invalid usage data",
      );
      terminateChild();
      return;
    }
    messageTimestamps.add(message.timestamp);
    messages.push(message);
    const text = getText(message);
    if (text) {
      result.output = text;
      onProgress(text);
      log(text);
    }
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (
          typeof part === "object" &&
          part !== null &&
          "type" in part &&
          part.type === "toolCall" &&
          "name" in part
        ) {
          toolCallsOccurred = true;
          log(`→ ${String(part.name)}`);
        }
      }
    }

  };

  const command = process.env.PI_CLI_PATH || "pi";
  const child = spawn(command, args, {
    cwd,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  terminateChild = () => {
    child.kill("SIGTERM");
    if (!killTimer) {
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      killTimer.unref();
    }
  };
  const abortChild = () => {
    aborted = true;
    terminateChild();
  };
  if (signal?.aborted) abortChild();
  else signal?.addEventListener("abort", abortChild, { once: true });

  let timeout: ReturnType<typeof setTimeout>;
  const exitCode = await new Promise<number>((resolveExit) => {
    timeout = setTimeout(() => {
      processError = new Error(
        `Delegate timed out after ${processTimeoutMs / 1000}s`,
      );
      terminateChild();
    }, processTimeoutMs);
    timeout.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxProcessOutputBytes) {
        processError ??= new Error(
          "Delegate JSON output exceeded the 8 MiB process limit",
        );
        terminateChild();
        return;
      }
      buffer += stdoutDecoder.write(chunk);
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) processMessage(line);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = stderrDecoder.write(chunk);
      stderr = byteTruncateTail(stderr + text, maxStderrBytes);
      if (text.trim()) log(`[stderr] ${text.trimEnd()}`);
    });
    child.once("error", (error) => {
      processError ??= error;
      terminateChild();
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      buffer += stdoutDecoder.end();
      const finalStderr = stderrDecoder.end();
      stderr = byteTruncateTail(stderr + finalStderr, maxStderrBytes);
      if (finalStderr.trim()) log(`[stderr] ${finalStderr.trimEnd()}`);
      if (buffer.trim()) processMessage(buffer);
      processError ??= protocolError;
      resolveExit(code ?? 1);
    });
  });
  clearTimeout(timeout!);
  signal?.removeEventListener("abort", abortChild);
  await onUsage(messages, role.name);
  addAssistantMessages(result.usage, messages);

  if (processError)
    throw new DelegateAttemptError(
      processError.message,
      providerFailureKind(processError.message, processError),
      toolCallsOccurred,
    );
  if (aborted || signal?.aborted)
    throw new DelegateAttemptError(
      `Delegate "${role.name}" was cancelled`,
      "other",
      toolCallsOccurred,
    );
  const lastMessage = [...messages].reverse().find(isAssistantMessage);
  if (
    exitCode !== 0 ||
    !result.output ||
    (lastMessage && lastMessage.stopReason === "error")
  ) {
    const reason =
      stderr.trim() ||
      (lastMessage && typeof lastMessage.errorMessage === "string"
        ? lastMessage.errorMessage
        : `Pi exited with code ${exitCode}`);
    const failureEvidence = [
      stderr,
      lastMessage &&
      typeof lastMessage.errorMessage === "string"
        ? lastMessage.errorMessage
        : "",
      `Pi exited with code ${exitCode}`,
    ].join("\n");
    throw new DelegateAttemptError(
      reason,
      providerFailureKind(failureEvidence),
      toolCallsOccurred,
      Boolean(lastMessage),
    );
  }
  return result;
}

async function capAndSpill(
  output: string,
  dataDir: string,
): Promise<{ output: string; outputPath?: string }> {
  if (Buffer.byteLength(output, "utf8") <= maxOutputBytes) return { output };
  const dir = join(dataDir, "delegate-results");
  await mkdir(dir, { recursive: true });
  const outputPath = join(dir, `${Date.now()}-${crypto.randomUUID()}.txt`);
  await writeFile(outputPath, output, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  const suffix = `\n\nFull result saved to: ${outputPath}`;
  const prefixLimit = maxOutputBytes - Buffer.byteLength(suffix, "utf8");
  if (prefixLimit <= 0)
    throw new Error("Delegate output path exceeds the tool result size limit");
  return {
    output: `${byteTruncate(output, prefixLimit)}${suffix}`,
    outputPath,
  };
}

function errorResult(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerDelegation(
  pi: ExtensionAPI,
  options: DelegationOptions,
  tierModels: Record<string, string[]>,
): void {
  pi.registerTool({
    name: "delegate",
    label: "Delegate",
    description:
      "Delegate one bounded task to a role, or run up to four independent read-only scout tasks in parallel. " +
      "Roles: scout (recon), mechanic (scoped mechanical edits), planner (read-only planning), " +
      "worker (one implementation step), reviewer (read-only diff findings), debugger (read-only diagnosis), " +
      "summarizer (no tools). The conductor integrates all results.",
    parameters: DelegateParamsSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params: DelegateParams, signal, _onUpdate, ctx) {
      const single = Boolean(params.role && params.task);
      const parallel = Array.isArray(params.tasks) && params.tasks.length > 0;
      if (Number(single) + Number(parallel) !== 1) {
        return {
          content: [
            {
              type: "text",
              text: "Provide either role + task, or a non-empty tasks list.",
            },
          ],
          details: { mode: "single", results: [], usage: emptyUsage() },
          isError: true,
        };
      }
      let roles: Map<string, RoleProfile>;
      try {
        roles = await loadDelegationRoles();
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Could not load delegation roles: ${errorResult(error)}`,
            },
          ],
          details: {
            mode: parallel ? "parallel" : "single",
            results: [],
            usage: emptyUsage(),
          },
          isError: true,
        };
      }
      const tasks: Task[] = single
        ? [
            {
              role: params.role!,
              task: params.task!,
              acceptanceCriteria: params.acceptanceCriteria,
            },
          ]
        : params.tasks!;
      if (
        parallel &&
        tasks.some((task) => roles.get(task.role)?.parallel !== true)
      ) {
        return {
          content: [
            {
              type: "text",
              text: "Parallel mode is restricted to roles explicitly marked parallel; currently that is scout only.",
            },
          ],
          details: { mode: "parallel", results: [], usage: emptyUsage() },
          isError: true,
        };
      }
      for (const task of tasks) {
        if (!task.task.trim()) {
          return {
            content: [
              {
                type: "text",
                text: "Every delegated task must include a non-empty brief.",
              },
            ],
            details: {
              mode: parallel ? "parallel" : "single",
              results: [],
              usage: emptyUsage(),
            },
            isError: true,
          };
        }
        if (!roles.has(task.role)) {
          return {
            content: [
              {
                type: "text",
                text: `Unknown role "${task.role}". Available roles: ${[...roles.keys()].join(", ")}`,
              },
            ],
            details: {
              mode: parallel ? "parallel" : "single",
              results: [],
              usage: emptyUsage(),
            },
            isError: true,
          };
        }
      }

      const cap = await options.getBudgetCap(ctx);
      const results: SubtaskResult[] = [];
      const failures: string[] = [];
      const delegatedUsage = emptyUsage();
      type DelegateState = {
        role: string;
        status: "running" | "done" | "failed";
        model?: string;
        last: string[];
      };
      const delegateStates = new Map<string, DelegateState>();
      const publishDelegateStates = () => {
        updateDashboard({
          agent: [...delegateStates.values()].flatMap((delegate) => [
            `Delegate • ${delegate.role}${delegate.model ? ` • ${delegate.model}` : ""} • ${delegate.status}`,
            ...delegate.last,
          ]),
        });
      };
      const updateDelegate = (
        taskId: string,
        patch: Partial<DelegateState>,
      ) => {
        const current = delegateStates.get(taskId);
        let next: DelegateState;
        if (current) {
          next = { ...current, ...patch };
        } else {
          const role = patch.role;
          const status = patch.status;
          if (
            !role ||
            (status !== "running" && status !== "done" && status !== "failed")
          ) {
            throw new Error(`Cannot initialize delegate status for ${taskId}`);
          }
          next = { role, status, model: patch.model, last: patch.last ?? [] };
        }
        delegateStates.set(taskId, next);
        publishDelegateStates();
      };
      const removeDelegate = (taskId: string) => {
        delegateStates.delete(taskId);
        publishDelegateStates();
      };
      const runTask = async (task: Task): Promise<SubtaskResult | undefined> => {
        const role = roles.get(task.role)!;
        const taskId = crypto.randomUUID();
        const taskFailures: string[] = [];
        const fail = (message: string) => {
          taskFailures.push(message);
          failures.push(message);
        };

        const log = createTaskLog(options.dataDir, role.name);
        log.write(`# ${role.name}\n${task.task}\n`);
        updateDelegate(taskId, {
          role: role.name,
          status: "running",
          last: ["Starting isolated Pi process…"],
        });
        let paneId: string | undefined;
        let result: SubtaskResult | undefined;
        try {
          paneId = await options.panes?.open(log.path, role.name);
          const tools = toolsForRole(role, ctx);
          const skills = await loadDelegationSkills(role, ctx.cwd);
          const candidates = modelCandidates(
            role,
            cap,
            tierModels,
            ctx.modelRegistry.getAvailable(),
            options.getModelCatalog(),
            role.tools.length > 0,
          );
          if (!candidates.length) {
            fail(
              `${role.name}: no authenticated, circuit-healthy model available under tier ${cap}`,
            );
            log.write(`✗ ${taskFailures.at(-1)}`);
            return undefined;
          }

          const recordAndAggregate = async (
            messages: unknown[],
            roleName: string,
          ) => {
            const attemptUsage = emptyUsage();
            addAssistantMessages(attemptUsage, messages);
            await options.recordUsage(messages, roleName);
            for (const field of [
              "input",
              "output",
              "cacheRead",
              "cacheWrite",
              "totalTokens",
            ] as const) {
              delegatedUsage[field] += attemptUsage[field];
            }
            for (const field of [
              "input",
              "output",
              "cacheRead",
              "cacheWrite",
              "total",
            ] as const) {
              delegatedUsage.cost[field] += attemptUsage.cost[field];
            }
          };

          const attemptedModels: string[] = [];
          for (const model of candidates) {
            if (attemptedModels.length >= maxAttempts) break;
            const provider = providerFromModel(model);
            if (!acquireProvider(provider)) {
              log.write(`── skipped ${model}: provider circuit is open ──`);
              continue;
            }
            attemptedModels.push(model);
            log.write(
              `── attempt ${attemptedModels.length}/${maxAttempts}: ${model} ──`,
            );
            updateDelegate(taskId, { model, status: "running" });
            try {
              result = await runModel(
                model,
                role,
                task,
                ctx.cwd,
                tools,
                skills,
                signal,
                recordAndAggregate,
                (output) =>
                  updateDelegate(taskId, {
                    model,
                    last: output.trim().split("\n").slice(-3),
                  }),
                log.write,
              );
              recordProviderSuccess(provider);
              result.attempts = [...attemptedModels];
              break;
            } catch (error) {
              if (signal?.aborted) {
                releaseProviderProbe(provider);
                fail(`${role.name}: delegated task was cancelled`);
                break;
              }
              const attemptError =
                error instanceof DelegateAttemptError
                  ? error
                  : new DelegateAttemptError(
                      errorResult(error),
                      providerFailureKind(errorResult(error), error),
                      false,
                    );
              const providerFault = isProviderFault(attemptError.kind);
              if (providerFault) {
                recordProviderFailure(provider);
                const jitter = 0.8 + Math.random() * 0.4;
                const duration =
                  attemptError.kind === "rate-limit"
                    ? circuitCooldownMs * 2
                    : circuitCooldownMs;
                modelCooldowns.set(
                  model,
                  Date.now() + duration * jitter,
                );
              } else if (attemptError.providerResponded) {
                recordProviderSuccess(provider);
              } else {
                releaseProviderProbe(provider);
              }
              const message = errorResult(error);
              fail(`${role.name} on ${model}: ${message}`);
              log.write(`✗ ${message}`);
              updateDelegate(taskId, {
                last: [`✗ ${model}: ${message}`.slice(0, 200)],
              });
              const canRetry =
                providerFault && !attemptError.toolCallsOccurred;
              if (!canRetry) break;
            }
          }

          if (result) {
            const capped = await capAndSpill(result.output, options.dataDir);
            result.output = capped.output;
            result.outputPath = capped.outputPath;
          }
          return result;
        } catch (error) {
          const message = errorResult(error);
          fail(`${role.name}: ${message}`);
          log.write(`✗ ${message}`);
          updateDelegate(taskId, {
            status: "failed",
            last: [`✗ ${message}`.slice(0, 200)],
          });
          return undefined;
        } finally {
          const cancelled = !result && signal?.aborted;
          log.write(result ? "\n✓ done" : cancelled ? "\n⊘ cancelled" : "\n✗ failed");

          updateDelegate(taskId, {
            status: result ? "done" : "failed",
            model: result?.model,
            last: result
              ? result.output.trim().split("\n").slice(-3)
              : cancelled
                ? ["cancelled"]
                : taskFailures.slice(-2).map((line) => line.slice(0, 200)),
          });

          // Keep the finished row and pane visible long enough to read; failures linger longer.
          const lingerMs = result ? 15_000 : 120_000;
          options.panes?.closeLater(paneId, lingerMs);
          setTimeout(() => removeDelegate(taskId), lingerMs).unref();
        }
      };
      if (parallel) {
        const settled = await Promise.allSettled(tasks.map(runTask));
        for (const outcome of settled) {
          if (outcome.status === "fulfilled") {
            if (outcome.value) results.push(outcome.value);
          } else {
            failures.push(`Delegate task failed: ${errorResult(outcome.reason)}`);
          }
        }
      } else {
        const result = await runTask(tasks[0]!);
        if (result) results.push(result);
      }
      const usage = delegatedUsage;
      const details: DelegateDetails = {
        mode: parallel ? "parallel" : "single",
        results,
        usage,
      };
      const unboundedText = [
        ...results.map(
          (result) => `## ${result.role} (${result.model})\n\n${result.output}`,
        ),
        ...(failures.length
          ? [`## Delegate failures\n\n${failures.join("\n\n")}`]
          : []),
      ].join("\n\n");
      const cappedText = await capAndSpill(
        unboundedText || "No delegate completed successfully.",
        options.dataDir,
      );
      return {
        content: [{ type: "text", text: cappedText.output }],
        details,
        usage: toUsage(usage),
        isError: results.length === 0,
      };
    },
  });
}

export function getDelegateTierCandidates(
  role: RoleProfile,
  cap: RoleTier,
  tierModels: Record<string, string[]>,
  availableModels: readonly { provider: string; id: string }[],
  catalog?: ModelCatalogSnapshot,
  requiresToolCalls = false,
): string[] {
  return modelCandidates(
    role,
    cap,
    tierModels,
    availableModels,
    catalog,
    requiresToolCalls,
  );
}
