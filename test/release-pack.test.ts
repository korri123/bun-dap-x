import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

interface CommandResult {
	stdout: string;
	stderr: string;
}

interface PackFile {
	path?: unknown;
}

interface PackEntry {
	filename?: unknown;
	files?: PackFile[];
	name?: unknown;
}

async function runCommand(cmd: string[], cwd: string): Promise<CommandResult> {
	const child = Bun.spawn({
		cmd,
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	if (exitCode !== 0) {
		throw new Error(`Command failed (${cmd.join(" ")}):\n${stderr}\n${stdout}`);
	}
	return { stdout, stderr };
}

test("release pack command writes parseable npm JSON", async () => {
	const repoRoot = path.resolve(import.meta.dir, "..");
	const packDir = await fs.mkdtemp(path.join(os.tmpdir(), "bun-dap-x-pack-"));
	try {
		await runCommand(["bun", "run", "build"], repoRoot);
		const result = await runCommand(["npm", "pack", "--json", "--ignore-scripts", "--pack-destination", packDir], repoRoot);
		const parsed: unknown = JSON.parse(result.stdout);
		expect(Array.isArray(parsed)).toBe(true);
		expect(parsed).toHaveLength(1);

		const [entry] = parsed as PackEntry[];
		expect(entry.name).toBe("bun-dap-x");
		expect(typeof entry.filename).toBe("string");
		expect(entry.files?.some((file) => file.path === "dist/bun-dap-x")).toBe(true);
		await expect(fs.stat(path.join(packDir, entry.filename as string))).resolves.toBeDefined();
	} finally {
		await fs.rm(packDir, { recursive: true, force: true });
	}
});
