// sidebar.ts: run with `node sidebar.ts <stateFile>`
import { readFileSync, watch } from "node:fs";
import { dirname, basename } from "node:path";

const file = process.argv[2]!;
const c = { dim: "\x1b[2m", bold: "\x1b[1m", reset: "\x1b[0m",
	green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m" };
const pcol = { green: c.green, yellow: c.yellow, orange: c.yellow, red: c.red };

function draw() {
	let s: any;
	try { s = JSON.parse(readFileSync(file, "utf8")); } catch { return; }
	const w = process.stdout.columns ?? 40;
	const out: string[] = [`${c.cyan}${c.bold}OGO${c.reset}${c.dim}  router${c.reset}`];
	const b = s.budget;
	if (b) {
		out.push(`${pcol[b.pressure as keyof typeof pcol]}●${c.reset} ${b.pressure}${b.tier !== undefined ? `${c.dim}  T${b.tier}${c.reset}` : ""}`);
		if (b.model) out.push(`${c.dim}${b.model}${c.reset}`);
		out.push("", `${c.cyan}${c.bold}Usage${c.reset}`);
		for (const x of b.windows) {
			const r = x.limit ? Math.min(x.used / x.limit, 1) : 0;
			const bw = Math.max(w - 12, 6), f = Math.round(r * bw);
			const col = r > 0.9 ? c.red : r > 0.75 ? c.yellow : c.green;
			out.push(`${x.label.padEnd(3)} ${col}${"█".repeat(f)}${c.dim}${"░".repeat(bw - f)} ${Math.round(r * 100)}%${c.reset}`);
		}
		out.push(`${c.dim}${b.pace}${c.reset}`, `${c.dim}${b.source}${c.reset}`);
		for (const n of b.notes) out.push(`${c.yellow}${n}${c.reset}`);
	}
	process.stdout.write("\x1b[H\x1b[2J" + out.join("\n"));
}

draw();
watch(dirname(file), (_e, name) => { if (name === basename(file)) draw(); });
process.stdout.on("resize", draw);
setInterval(draw, 5000); // fs.watch is flaky on some platforms
process.stdout.write("\x1b[?25l"); // hide cursor