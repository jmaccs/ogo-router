// tmux.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
let sidebarPane: string | undefined;

async function tmux(...args: string[]): Promise<string> {
	return (await run("tmux", args)).stdout.trim();
}

export const inTmux = () => Boolean(process.env.TMUX);

async function paneAlive(id: string): Promise<boolean> {
	try {
		await tmux("display-message", "-p", "-t", id, "#{pane_id}");
		return true;
	} catch {
		return false;
	}
}

export async function openSidebarPane(sidebarScript: string, stateFile: string, width = 42) {
	if (!inTmux()) return false;
	if (sidebarPane && (await paneAlive(sidebarPane))) return true;
	sidebarPane = await tmux(
		"split-window", "-h", "-d",              // -d: don't steal focus
		"-l", String(width),
		"-t", process.env.TMUX_PANE ?? "",       // split pi's own pane, not whichever is active
		"-P", "-F", "#{pane_id}",
		`node ${JSON.stringify(sidebarScript)} ${JSON.stringify(stateFile)}`,
	);
	await tmux("select-pane", "-t", sidebarPane, "-T", "OGO");
	return true;
}

export async function closeSidebarPane() {
	if (sidebarPane && (await paneAlive(sidebarPane))) await tmux("kill-pane", "-t", sidebarPane);
	sidebarPane = undefined;
}

export async function toggleSidebarPane(sidebarScript: string, stateFile: string) {
	if (sidebarPane && (await paneAlive(sidebarPane))) return closeSidebarPane();
	await openSidebarPane(sidebarScript, stateFile);
}

const delegatePanes = new Set<string>();
const MAX_PANES = 3;

export async function openDelegatePane(
	logFile: string,
	title: string,
): Promise<string | undefined> {
	if (!sidebarPane || !(await paneAlive(sidebarPane))) return undefined;
	if (delegatePanes.size >= MAX_PANES) return undefined; // overflow tasks are sidebar-only
	const id = await tmux(
		"split-window", "-v", "-d", "-t", sidebarPane,
		"-P", "-F", "#{pane_id}",
		`tail -n +1 -F ${JSON.stringify(logFile)}`,
	);
	delegatePanes.add(id);
	await tmux("select-pane", "-t", id, "-T", title);
	return id;
}

export function closePaneLater(id: string | undefined, delayMs: number) {
	if (!id) return;
	setTimeout(async () => {
		delegatePanes.delete(id);
		if (await paneAlive(id)) await tmux("kill-pane", "-t", id).catch(() => {});
	}, delayMs).unref();
}