import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Subprocess } from "bun";
import { DapSessionManager, requireBunAdapter } from "./support/dap-session.ts";

interface InspectNotifyServer {
	url: string;
	wait(timeoutMs: number): Promise<void>;
	close(): void;
}

function getFreeTcpPort(): number {
	const server = Bun.listen({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			open() {},
			data() {},
			close() {},
			error() {},
		},
	});
	const port = server.port;
	server.stop(true);
	return port;
}

function createInspectNotifyServer(): InspectNotifyServer {
	const received = Promise.withResolvers<void>();
	let settled = false;
	const settle = (): void => {
		if (settled) return;
		settled = true;
		received.resolve();
	};
	const fail = (error: Error): void => {
		if (settled) return;
		settled = true;
		received.reject(error);
	};
	const server = Bun.listen({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			open(socket) {
				settle();
				socket.end();
			},
			data(socket) {
				settle();
				socket.end();
			},
			close() {},
			error(_socket, error) {
				fail(error instanceof Error ? error : new Error(String(error)));
			},
		},
	});
	return {
		url: `tcp://127.0.0.1:${server.port}`,
		async wait(timeoutMs: number): Promise<void> {
			const timeout = Promise.withResolvers<never>();
			const timer = setTimeout(() => timeout.reject(new Error("Timed out waiting for Bun inspector notification")), timeoutMs);
			try {
				await Promise.race([received.promise, timeout.promise]);
			} finally {
				clearTimeout(timer);
			}
		},
		close() {
			server.stop(true);
		},
	};
}

describe("standalone Bun DAP adapter", () => {
	it("launches Bun and stops on a pending source breakpoint before user code runs", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "bun-dap-x-"));
		const manager = new DapSessionManager();
		const ownerId = `bun-dap-${Bun.randomUUIDv7()}`;
		try {
			const program = path.join(cwd, "app.ts");
			await Bun.write(
				program,
				["const value = 41;", "const result = value + 1;", "console.log('result', result);", "await new Promise(() => {});", ""].join("\n"),
			);
			const realProgram = await fs.realpath(program);
			await manager.setBreakpoint(program, 3, undefined, undefined, 10_000, { ownerId });

			const snapshot = await manager.launch({ ownerId, adapter: requireBunAdapter(cwd), program, cwd }, undefined, 30_000);

			expect(snapshot.adapter).toBe("bun");
			expect(snapshot.status).toBe("stopped");
			expect(snapshot.source?.path).toBe(realProgram);
			expect(snapshot.line).toBe(3);

			const stack = await manager.stackTrace(5, undefined, 10_000, { ownerId });
			expect(stack.stackFrames[0]?.source?.path).toBe(realProgram);
			expect(stack.stackFrames[0]?.line).toBe(3);

			const evaluated = await manager.evaluate("value", "repl", undefined, undefined, 10_000, { ownerId });
			expect(evaluated.evaluation?.result).toBe("41");
		} finally {
			await manager.terminate(undefined, 10_000, { ownerId }).catch(() => undefined);
			await fs.rm(cwd, { recursive: true, force: true });
		}
	}, 45_000);

	it("emulates stopOnEntry without Bun break-line injection", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "bun-dap-x-stop-on-entry-"));
		const manager = new DapSessionManager();
		const ownerId = `bun-dap-stop-on-entry-${Bun.randomUUIDv7()}`;
		try {
			const program = path.join(cwd, "entry.ts");
			await Bun.write(program, ["// leading comment", 'const marker = "entry";', "console.log(marker);", ""].join("\n"));
			const realProgram = await fs.realpath(program);

			const snapshot = await manager.launch(
				{ ownerId, adapter: requireBunAdapter(cwd), program, cwd, extraLaunchArguments: { stopOnEntry: true } },
				undefined,
				30_000,
			);

			expect(snapshot.status).toBe("stopped");
			expect(snapshot.stopReason).toBe("entry");
			expect(snapshot.source?.path).toBe(realProgram);
			expect(snapshot.line).toBe(2);
			expect((await manager.continue(undefined, 10_000, { ownerId })).state).toBe("terminated");
		} finally {
			await manager.terminate(undefined, 10_000, { ownerId }).catch(() => undefined);
			await fs.rm(cwd, { recursive: true, force: true });
		}
	}, 45_000);

	it("attaches to a Bun inspector target and evaluates locals at a breakpoint", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "bun-dap-x-attach-"));
		const notify = createInspectNotifyServer();
		const manager = new DapSessionManager();
		const ownerId = `bun-dap-attach-${Bun.randomUUIDv7()}`;
		let target: Subprocess<"ignore", "ignore", "ignore"> | undefined;
		let adapterTerminated = false;
		try {
			const program = path.join(cwd, "attach.ts");
			const breakpointLine = 2;
			await Bun.write(
				program,
				[
					"function compute(localValue: number) {",
					"  console.log('attach local', localValue);",
					"  return localValue;",
					"}",
					"compute(42);",
					"await new Promise(() => {});",
					"",
				].join("\n"),
			);
			const realProgram = await fs.realpath(program);
			const inspectorUrl = `ws://127.0.0.1:${getFreeTcpPort()}/${Bun.randomUUIDv7()}`;
			target = Bun.spawn({
				cmd: [process.execPath, program],
				cwd,
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
				env: {
					...Bun.env,
					BUN_INSPECT: `${inspectorUrl}?break=1`,
					BUN_INSPECT_NOTIFY: notify.url,
					BUN_QUIET_DEBUG_LOGS: "1",
					BUN_DEBUG_QUIET_LOGS: "1",
					FORCE_COLOR: "0",
				},
				windowsHide: true,
			});
			const notifyResult = await Promise.race([notify.wait(10_000).then(() => undefined), target.exited.then((exitCode) => ({ exitCode }))]);
			if (notifyResult) throw new Error(`Bun attach target exited before inspector notification (exit code ${notifyResult.exitCode})`);

			await manager.setBreakpoint(program, breakpointLine, undefined, undefined, 10_000, { ownerId });
			const attached = await manager.attach({ ownerId, adapter: requireBunAdapter(cwd), program, cwd, url: inspectorUrl }, undefined, 30_000);
			expect(attached.adapter).toBe("bun");
			expect(attached.status).toBe("stopped");
			expect(attached.breakpointCount).toBe(1);
			expect(attached.source?.path).toBe(realProgram);
			expect(attached.line).toBe(breakpointLine);

			const evaluated = await manager.evaluate("localValue", "repl", undefined, undefined, 10_000, { ownerId });
			expect(evaluated.evaluation?.result).toBe("42");

			const terminated = await manager.terminate(undefined, 10_000, { ownerId });
			adapterTerminated = true;
			expect(terminated.status).toBe("terminated");
		} finally {
			notify.close();
			if (!adapterTerminated) await manager.terminate(undefined, 10_000, { ownerId }).catch(() => undefined);
			if (target?.exitCode === null) target.kill("SIGTERM");
			await target?.exited.catch(() => undefined);
			await fs.rm(cwd, { recursive: true, force: true });
		}
	}, 45_000);

	it("launches a Bun executable program with test arguments and stops in imported test code", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "bun-dap-x-test-launch-"));
		const manager = new DapSessionManager();
		const ownerId = `bun-dap-test-launch-${Bun.randomUUIDv7()}`;
		try {
			const source = path.join(cwd, "math.ts");
			const testFile = path.join(cwd, "math.test.ts");
			await Bun.write(
				source,
				["export function addTwice(value: number): number {", "  const doubled = value * 2;", "  return doubled + 1;", "}", ""].join("\n"),
			);
			await Bun.write(
				testFile,
				[
					'import { expect, test } from "bun:test";',
					'import { addTwice } from "./math.ts";',
					'test("adds through imported code", () => {',
					"  const result = addTwice(20);",
					"  expect(result).toBe(41);",
					"});",
					"",
				].join("\n"),
			);
			const realSource = await fs.realpath(source);
			const adapter = requireBunAdapter(cwd);
			adapter.launchDefaults = { cwd };
			await manager.setBreakpoint(source, 2, undefined, undefined, 10_000, { ownerId });

			const snapshot = await manager.launch({ ownerId, adapter, program: process.execPath, cwd, args: ["test", path.basename(testFile)] }, undefined, 30_000);

			expect(snapshot.status).toBe("stopped");
			expect(snapshot.source?.path).toBe(realSource);
			expect(snapshot.line).toBe(2);

			const stack = await manager.stackTrace(5, undefined, 10_000, { ownerId });
			expect(stack.stackFrames[0]?.name).toBe("addTwice");
			expect(stack.stackFrames[0]?.source?.path).toBe(realSource);
			expect(stack.stackFrames[1]?.source?.path).toBe(await fs.realpath(testFile));

			const evaluated = await manager.evaluate("value", "repl", stack.stackFrames[0]?.id, undefined, 10_000, { ownerId });
			expect(evaluated.evaluation?.result).toBe("20");
		} finally {
			await manager.terminate(undefined, 10_000, { ownerId }).catch(() => undefined);
			await fs.rm(cwd, { recursive: true, force: true });
		}
	}, 45_000);

	it("disables Bun test timeouts for debug launch pauses", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "bun-dap-x-test-timeout-disabled-"));
		const manager = new DapSessionManager();
		const ownerId = `bun-dap-test-timeout-disabled-${Bun.randomUUIDv7()}`;
		try {
			const testFile = path.join(cwd, "timeout-disabled.test.ts");
			await Bun.write(
				testFile,
				[
					'import { expect, test } from "bun:test";',
					'test("survives debugger pause", async () => {',
					'  const marker = "before-pause";',
					"  console.log(marker);",
					"  await Bun.sleep(10);",
					'  expect(marker).toBe("before-pause");',
					"});",
					"",
				].join("\n"),
			);
			const adapter = requireBunAdapter(cwd);
			adapter.launchDefaults = { cwd };
			await manager.setBreakpoint(testFile, 4, undefined, undefined, 10_000, { ownerId });

			const snapshot = await manager.launch(
				{
					ownerId,
					adapter,
					program: process.execPath,
					cwd,
					args: ["test", path.basename(testFile)],
					extraLaunchArguments: { env: { FORCE_COLOR: "0" } },
				},
				undefined,
				30_000,
			);
			expect(snapshot.status).toBe("stopped");
			expect(snapshot.line).toBe(4);

			await Bun.sleep(5_500);
			const continued = await manager.continue(undefined, 20_000, { ownerId });
			expect(continued.state).toBe("terminated");
			const output = manager.getOutput(undefined, { ownerId }).output;
			expect(output).toContain("1 pass");
			expect(output).not.toContain("timed out after");
		} finally {
			await manager.terminate(undefined, 10_000, { ownerId }).catch(() => undefined);
			await fs.rm(cwd, { recursive: true, force: true });
		}
	}, 60_000);

	it("preserves explicit Bun test timeout arguments", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "bun-dap-x-test-timeout-explicit-"));
		const manager = new DapSessionManager();
		const ownerId = `bun-dap-test-timeout-explicit-${Bun.randomUUIDv7()}`;
		try {
			const testFile = path.join(cwd, "timeout-explicit.test.ts");
			await Bun.write(
				testFile,
				[
					'import { expect, test } from "bun:test";',
					'test("keeps explicit timeout", async () => {',
					"  await Bun.sleep(50);",
					"  expect(true).toBe(true);",
					"});",
					"",
				].join("\n"),
			);
			const adapter = requireBunAdapter(cwd);
			adapter.launchDefaults = { cwd };

			const snapshot = await manager.launch(
				{
					ownerId,
					adapter,
					program: process.execPath,
					cwd,
					args: ["test", "--timeout=10", path.basename(testFile)],
					extraLaunchArguments: { env: { FORCE_COLOR: "0" } },
				},
				undefined,
				30_000,
			);
			expect(snapshot.status).toBe("terminated");
			expect(manager.getOutput(undefined, { ownerId }).output).toContain("timed out after");
		} finally {
			await manager.terminate(undefined, 10_000, { ownerId }).catch(() => undefined);
			await fs.rm(cwd, { recursive: true, force: true });
		}
	}, 45_000);

	it("keeps an attached Bun test session usable after stack, scopes, and evaluate", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "bun-dap-x-test-attach-"));
		const notify = createInspectNotifyServer();
		const manager = new DapSessionManager();
		const ownerId = `bun-dap-test-attach-${Bun.randomUUIDv7()}`;
		let target: Subprocess<"ignore", "ignore", "ignore"> | undefined;
		let adapterTerminated = false;
		try {
			const source = path.join(cwd, "math.ts");
			const testFile = path.join(cwd, "math.test.ts");
			await Bun.write(
				source,
				["export function addTwice(value: number): number {", "  const doubled = value * 2;", "  return doubled + 1;", "}", ""].join("\n"),
			);
			await Bun.write(
				testFile,
				[
					'import { expect, test } from "bun:test";',
					'import { addTwice } from "./math.ts";',
					'test("adds through imported code", () => {',
					"  const result = addTwice(20);",
					"  expect(result).toBe(41);",
					"});",
					"",
				].join("\n"),
			);
			const realSource = await fs.realpath(source);
			const inspectorUrl = `ws://127.0.0.1:${getFreeTcpPort()}/${Bun.randomUUIDv7()}`;
			target = Bun.spawn({
				cmd: [process.execPath, "test", path.basename(testFile)],
				cwd,
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
				env: {
					...Bun.env,
					BUN_INSPECT: `${inspectorUrl}?break=1`,
					BUN_INSPECT_NOTIFY: notify.url,
					BUN_QUIET_DEBUG_LOGS: "1",
					BUN_DEBUG_QUIET_LOGS: "1",
					FORCE_COLOR: "0",
				},
				windowsHide: true,
			});
			const notifyResult = await Promise.race([notify.wait(10_000).then(() => undefined), target.exited.then((exitCode) => ({ exitCode }))]);
			if (notifyResult) throw new Error(`Bun test attach target exited before inspector notification (exit code ${notifyResult.exitCode})`);

			await manager.setBreakpoint(source, 2, undefined, undefined, 10_000, { ownerId });
			const attached = await manager.attach({ ownerId, adapter: requireBunAdapter(cwd), program: testFile, cwd, url: inspectorUrl }, undefined, 30_000);
			expect(attached.status).toBe("stopped");
			expect(attached.source?.path).toBe(realSource);
			expect(attached.line).toBe(2);

			const stack = await manager.stackTrace(5, undefined, 10_000, { ownerId });
			expect(stack.stackFrames[0]?.name).toBe("addTwice");
			expect(stack.stackFrames[0]?.source?.path).toBe(realSource);
			expect(stack.stackFrames[1]?.source?.path).toBe(await fs.realpath(testFile));
			const frameId = stack.stackFrames[0]?.id;
			expect(frameId).toBeGreaterThan(0);

			const scopes = await manager.scopes(frameId!, undefined, 10_000, { ownerId });
			expect(scopes.scopes.length).toBeGreaterThan(0);

			const evaluated = await manager.evaluate("value", "repl", frameId, undefined, 10_000, { ownerId });
			expect(evaluated.evaluation?.result).toBe("20");

			const terminated = await manager.terminate(undefined, 10_000, { ownerId });
			adapterTerminated = true;
			expect(terminated.status).toBe("terminated");
		} finally {
			notify.close();
			if (!adapterTerminated) await manager.terminate(undefined, 10_000, { ownerId }).catch(() => undefined);
			if (target?.exitCode === null) target.kill("SIGTERM");
			await target?.exited.catch(() => undefined);
			await fs.rm(cwd, { recursive: true, force: true });
		}
	}, 45_000);

	it("disables Bun test timeouts for inspect-brk attach pauses", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "bun-dap-x-test-attach-timeout-"));
		const notify = createInspectNotifyServer();
		const manager = new DapSessionManager();
		const ownerId = `bun-dap-test-attach-timeout-${Bun.randomUUIDv7()}`;
		let target: Subprocess<"ignore", "ignore", "pipe"> | undefined;
		let adapterTerminated = false;
		try {
			const testFile = path.join(cwd, "timeout-attach.test.ts");
			await Bun.write(
				testFile,
				[
					'import { expect, test } from "bun:test";',
					'test("survives attach pause", async () => {',
					'  const marker = "before-pause";',
					"  await Bun.sleep(10);",
					'  expect(marker).toBe("before-pause");',
					"});",
					"",
				].join("\n"),
			);
			const inspectorUrl = `ws://127.0.0.1:${getFreeTcpPort()}/${Bun.randomUUIDv7()}`;
			target = Bun.spawn({
				cmd: [process.execPath, "test", path.basename(testFile)],
				cwd,
				stdin: "ignore",
				stdout: "ignore",
				stderr: "pipe",
				env: {
					...Bun.env,
					BUN_INSPECT: `${inspectorUrl}?break=1`,
					BUN_INSPECT_NOTIFY: notify.url,
					BUN_QUIET_DEBUG_LOGS: "1",
					BUN_DEBUG_QUIET_LOGS: "1",
					FORCE_COLOR: "0",
				},
				windowsHide: true,
			});
			const stderrPromise = new Response(target.stderr).text();
			const notifyResult = await Promise.race([notify.wait(10_000).then(() => undefined), target.exited.then((exitCode) => ({ exitCode }))]);
			if (notifyResult) throw new Error(`Bun test attach target exited before inspector notification (exit code ${notifyResult.exitCode})`);

			await manager.setBreakpoint(testFile, 3, undefined, undefined, 10_000, { ownerId });
			const attached = await manager.attach({ ownerId, adapter: requireBunAdapter(cwd), program: testFile, cwd, url: inspectorUrl }, undefined, 30_000);
			expect(attached.status).toBe("stopped");
			expect(attached.line).toBe(3);

			await Bun.sleep(5_500);
			const continued = await manager.continue(undefined, 20_000, { ownerId });
			adapterTerminated = true;
			expect(continued.state).toBe("terminated");
			expect(await target.exited).toBe(0);
			expect(await stderrPromise).not.toContain("timed out after");
		} finally {
			notify.close();
			if (!adapterTerminated) await manager.terminate(undefined, 10_000, { ownerId }).catch(() => undefined);
			if (target?.exitCode === null) target.kill("SIGTERM");
			await target?.exited.catch(() => undefined);
			await fs.rm(cwd, { recursive: true, force: true });
		}
	}, 60_000);

	it("reports array length from Bun object size and terminates after continue", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "bun-dap-x-array-"));
		const manager = new DapSessionManager();
		const ownerId = `bun-dap-array-${Bun.randomUUIDv7()}`;
		try {
			const program = path.join(cwd, "array.ts");
			await Bun.write(
				program,
				[
					"function summarize(samples: { label: string; value: number }[]) {",
					"  const total = samples.reduce((sum, sample) => sum + sample.value, 0);",
					"  const first = samples[0];",
					"  const line = samples.map(s => s.label).join(',') + ':' + (total / samples.length);",
					"  console.log(line);",
					"  return { total, first, samples };",
					"}",
					"summarize([",
					"  { label: 'alpha', value: 2 },",
					"  { label: 'beta', value: 4 },",
					"  { label: 'gamma', value: 6 },",
					"]);",
					"",
				].join("\n"),
			);
			await manager.setBreakpoint(program, 4, undefined, undefined, 10_000, { ownerId });

			const snapshot = await manager.launch({ ownerId, adapter: requireBunAdapter(cwd), program, cwd }, undefined, 30_000);

			expect(snapshot.status).toBe("stopped");
			expect(snapshot.line).toBe(4);

			const stack = await manager.stackTrace(5, undefined, 10_000, { ownerId });
			const scopes = await manager.scopes(stack.stackFrames[0]!.id, undefined, 10_000, { ownerId });
			let samplesReference = 0;
			for (const scope of scopes.scopes) {
				const variables = await manager.variables(scope.variablesReference, undefined, 10_000, { ownerId });
				const total = variables.variables.find((variable) => variable.name === "total");
				if (total) expect(total.value).toBe("12");
				const samples = variables.variables.find((variable) => variable.name === "samples");
				if (samples) {
					samplesReference = samples.variablesReference;
					expect(samples.indexedVariables).toBe(3);
				}
			}
			expect(samplesReference).toBeGreaterThan(0);

			const sampleChildren = await manager.variables(samplesReference, undefined, 10_000, { ownerId });
			expect(sampleChildren.variables.filter((variable) => /^[0-2]$/.test(variable.name))).toHaveLength(3);
			expect(sampleChildren.variables.find((variable) => variable.name === "length")?.value).toBe("3");

			const firstEntry = sampleChildren.variables.find((variable) => variable.name === "0");
			expect(firstEntry?.variablesReference).toBeGreaterThan(0);
			const firstEntryChildren = await manager.variables(firstEntry!.variablesReference, undefined, 10_000, {
				ownerId,
			});
			expect(firstEntryChildren.variables.find((variable) => variable.name === "label")?.value).toBe("alpha");
			expect(firstEntryChildren.variables.find((variable) => variable.name === "value")?.value).toBe("2");

			const continued = await manager.continue(undefined, 10_000, { ownerId });
			expect(continued.state).toBe("terminated");
			expect(continued.snapshot.status).toBe("terminated");
			expect(manager.getOutput(undefined, { ownerId }).output).toContain("alpha,beta,gamma:4");
		} finally {
			await manager.terminate(undefined, 10_000, { ownerId }).catch(() => undefined);
			await fs.rm(cwd, { recursive: true, force: true });
		}
	}, 45_000);

	it("honors conditional and hit-count breakpoints in function scopes", async () => {
		for (const testCase of [
			{ ownerPrefix: "condition", condition: "sample.label === 'beta'", hitCondition: undefined },
			{ ownerPrefix: "hit", condition: undefined, hitCondition: "2" },
		]) {
			const cwd = await fs.mkdtemp(path.join(os.tmpdir(), `bun-dap-x-${testCase.ownerPrefix}-`));
			const manager = new DapSessionManager();
			const ownerId = `bun-dap-${testCase.ownerPrefix}-${Bun.randomUUIDv7()}`;
			try {
				const program = path.join(cwd, "calls.ts");
				const breakpointLine = 4;
				await Bun.write(
					program,
					[
						"let total = 0;",
						"function addSample(sample: { label: string; value: number }) {",
						"  const before = total;",
						"  total += sample.value;",
						"  return before;",
						"}",
						"addSample({ label: 'alpha', value: 2 });",
						"addSample({ label: 'beta', value: 4 });",
						"addSample({ label: 'gamma', value: 6 });",
						"console.log(total);",
						"",
					].join("\n"),
				);
				await manager.setBreakpoint(
					program,
					breakpointLine,
					testCase.condition,
					undefined,
					10_000,
					{ ownerId },
					{
						hitCondition: testCase.hitCondition,
					},
				);

				const snapshot = await manager.launch({ ownerId, adapter: requireBunAdapter(cwd), program, cwd }, undefined, 30_000);

				expect(snapshot.status).toBe("stopped");
				expect(snapshot.line).toBe(breakpointLine);
				expect((await manager.evaluate("sample.label", "repl", undefined, undefined, 10_000, { ownerId })).evaluation?.result).toBe("beta");
				expect((await manager.evaluate("total", "repl", undefined, undefined, 10_000, { ownerId })).evaluation?.result).toBe("2");
			} finally {
				await manager.terminate(undefined, 10_000, { ownerId }).catch(() => undefined);
				await fs.rm(cwd, { recursive: true, force: true });
			}
		}
	}, 60_000);

	it("binds DAP function breakpoints by scanning loaded Bun sources", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "bun-dap-x-function-"));
		const manager = new DapSessionManager();
		const ownerId = `bun-dap-function-${Bun.randomUUIDv7()}`;
		try {
			const program = path.join(cwd, "function-breakpoint.ts");
			await Bun.write(
				program,
				[
					"let total = 0;",
					"function recordSample(sample: { label: string; value: number }) {",
					"  const before = total;",
					"  total += sample.value;",
					"  return before;",
					"}",
					"recordSample({ label: 'alpha', value: 2 });",
					"recordSample({ label: 'beta', value: 4 });",
					"recordSample({ label: 'gamma', value: 6 });",
					"console.log(total);",
					"",
				].join("\n"),
			);
			const realProgram = await fs.realpath(program);
			await manager.setFunctionBreakpoint("recordSample", "sample.label === 'beta'", undefined, 10_000, { ownerId });

			const snapshot = await manager.launch({ ownerId, adapter: requireBunAdapter(cwd), program, cwd }, undefined, 30_000);

			expect(snapshot.status).toBe("stopped");
			expect(snapshot.functionBreakpointCount).toBe(1);
			expect(snapshot.frameName).toBe("recordSample");
			expect(snapshot.source?.path).toBe(realProgram);
			expect(snapshot.line).toBe(3);
			expect((await manager.evaluate("sample.label", "repl", undefined, undefined, 10_000, { ownerId })).evaluation?.result).toBe("beta");
			expect((await manager.evaluate("total", "repl", undefined, undefined, 10_000, { ownerId })).evaluation?.result).toBe("2");

			const capabilities = manager.capabilities({ ownerId });
			expect(capabilities.supportsFunctionBreakpoints).toBe(true);
		} finally {
			await manager.terminate(undefined, 10_000, { ownerId }).catch(() => undefined);
			await fs.rm(cwd, { recursive: true, force: true });
		}
	}, 45_000);

	it("pauses on uncaught exceptions through Bun Inspector exception breakpoints", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "bun-dap-x-exception-"));
		const manager = new DapSessionManager();
		const ownerId = `bun-dap-exception-${Bun.randomUUIDv7()}`;
		try {
			const program = path.join(cwd, "exception.ts");
			await Bun.write(program, ["function explode() {", "  const marker = 'before throw';", "  throw new Error('boom');", "}", "explode();", ""].join("\n"));
			await manager.setExceptionBreakpoints(["uncaught"], undefined, 10_000, { ownerId });

			const snapshot = await manager.launch({ ownerId, adapter: requireBunAdapter(cwd), program, cwd }, undefined, 30_000);

			expect(snapshot.status).toBe("stopped");
			expect(snapshot.stopReason).toBe("exception");
			expect(snapshot.frameName).toBe("explode");
			expect(snapshot.line).toBe(3);
			expect((await manager.evaluate("marker", "repl", undefined, undefined, 10_000, { ownerId })).evaluation?.result).toBe("before throw");
			expect(
				manager
					.capabilities({ ownerId })
					.exceptionBreakpointFilters?.map((filter) => filter.filter)
					.sort((left, right) => left.localeCompare(right)),
			).toEqual(["all", "uncaught"]);
		} finally {
			await manager.terminate(undefined, 10_000, { ownerId }).catch(() => undefined);
			await fs.rm(cwd, { recursive: true, force: true });
		}
	}, 45_000);

	it("leaves data and instruction breakpoints unsupported without Bun Inspector backing", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "bun-dap-x-unsupported-breakpoints-"));
		const manager = new DapSessionManager();
		const ownerId = `bun-dap-unsupported-breakpoints-${Bun.randomUUIDv7()}`;
		try {
			const program = path.join(cwd, "unsupported-breakpoints.ts");
			await Bun.write(program, ["const value = 1;", "console.log(value);", "await new Promise(() => {});", ""].join("\n"));
			await manager.setBreakpoint(program, 2, undefined, undefined, 10_000, { ownerId });

			const snapshot = await manager.launch({ ownerId, adapter: requireBunAdapter(cwd), program, cwd }, undefined, 30_000);

			expect(snapshot.status).toBe("stopped");
			const capabilities = manager.capabilities({ ownerId });
			expect(capabilities.supportsDataBreakpoints).not.toBe(true);
			expect(capabilities.supportsInstructionBreakpoints).not.toBe(true);

			let dataInfoError = "";
			try {
				await manager.customRequest("dataBreakpointInfo", { name: "value" }, undefined, 10_000, { ownerId });
			} catch (error) {
				dataInfoError = error instanceof Error ? error.message : String(error);
			}
			expect(dataInfoError).toContain("data breakpoints");

			let dataSetError = "";
			try {
				await manager.customRequest("setDataBreakpoints", { breakpoints: [] }, undefined, 10_000, { ownerId });
			} catch (error) {
				dataSetError = error instanceof Error ? error.message : String(error);
			}
			expect(dataSetError).toContain("data breakpoints");

			let instructionError = "";
			try {
				await manager.customRequest("setInstructionBreakpoints", { breakpoints: [] }, undefined, 10_000, { ownerId });
			} catch (error) {
				instructionError = error instanceof Error ? error.message : String(error);
			}
			expect(instructionError).toContain("instruction breakpoints");
		} finally {
			await manager.terminate(undefined, 10_000, { ownerId }).catch(() => undefined);
			await fs.rm(cwd, { recursive: true, force: true });
		}
	}, 45_000);
	it("binds breakpoints in imported TypeScript files", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "bun-dap-x-import-"));
		const manager = new DapSessionManager();
		const ownerId = `bun-dap-import-${Bun.randomUUIDv7()}`;
		try {
			const program = path.join(cwd, "main.ts");
			const imported = path.join(cwd, "src", "imported.ts");
			const breakpointLine = 6;
			await Bun.write(
				imported,
				[
					"enum Mode {",
					"  Double = 'double',",
					"}",
					"export function importedScale(sample: { label: string; value: number }) {",
					"  if (Mode.Double !== 'double') throw new Error('bad mode');",
					"  const scaled = sample.value * 2;",
					"  return sample.label + ':' + scaled;",
					"}",
					"",
				].join("\n"),
			);
			await Bun.write(
				program,
				["import { importedScale } from './src/imported.ts';", "console.log(importedScale({ label: 'alpha', value: 2 }));", ""].join("\n"),
			);
			const realImported = await fs.realpath(imported);
			await manager.setBreakpoint(imported, breakpointLine, undefined, undefined, 10_000, { ownerId });

			const snapshot = await manager.launch({ ownerId, adapter: requireBunAdapter(cwd), program, cwd }, undefined, 30_000);

			expect(snapshot.status).toBe("stopped");
			expect(snapshot.source?.path).toBe(realImported);
			expect(snapshot.line).toBe(breakpointLine);
			expect((await manager.evaluate("sample.label", "repl", undefined, undefined, 10_000, { ownerId })).evaluation?.result).toBe("alpha");
		} finally {
			await manager.terminate(undefined, 10_000, { ownerId }).catch(() => undefined);
			await fs.rm(cwd, { recursive: true, force: true });
		}
	}, 45_000);

	it("steps over TypeScript call sites by source line", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "bun-dap-x-step-over-"));
		const manager = new DapSessionManager();
		const ownerId = `bun-dap-step-over-${Bun.randomUUIDv7()}`;
		try {
			const program = path.join(cwd, "step-over.ts");
			await Bun.write(
				program,
				[
					"function addOne(value: number) {",
					"  const next = value + 1;",
					"  return next;",
					"}",
					"function main() {",
					"  const before = 1;",
					"  let result = 0;",
					"  result = addOne(before);",
					"  const after = result + 1;",
					"}",
					"main();",
					"await new Promise(() => {});",
					"",
				].join("\n"),
			);
			await manager.setBreakpoint(program, 8, undefined, undefined, 10_000, { ownerId });

			const snapshot = await manager.launch({ ownerId, adapter: requireBunAdapter(cwd), program, cwd }, undefined, 30_000);
			expect(snapshot.status).toBe("stopped");
			expect(snapshot.frameName).toBe("main");
			expect(snapshot.line).toBe(8);

			const locations = await manager.customRequest(
				"breakpointLocations",
				{ source: { path: program, name: path.basename(program) }, line: 8, endLine: 9 },
				undefined,
				10_000,
				{ ownerId },
			);
			const locationBody = locations.body as { breakpoints?: { line?: number; column?: number }[] };
			expect(locationBody.breakpoints?.some((location) => location.line === 8 && (location.column ?? 0) > 0)).toBe(true);

			const stepped = await manager.stepOver(undefined, 10_000, { ownerId });
			expect(stepped.state).toBe("stopped");
			expect(stepped.snapshot.frameName).toBe("main");
			expect(stepped.snapshot.line).toBe(9);
		} finally {
			await manager.terminate(undefined, 10_000, { ownerId }).catch(() => undefined);
			await fs.rm(cwd, { recursive: true, force: true });
		}
	}, 45_000);

	it("keeps TypeScript loop step-over and step-out stops on source call sites", async () => {
		const source = [
			"type Sample = { label: string; value: number };",
			"",
			"function doubleValue(value: number): number {",
			"  const doubled = value * 2;",
			"  return doubled;",
			"}",
			"",
			"function summarize(samples: readonly Sample[]): number {",
			"  let total = 0;",
			"  for (let index = 0; index < samples.length; index += 1) {",
			"    const sample = samples[index];",
			"    total += doubleValue(sample.value);",
			"  }",
			"  return total;",
			"}",
			"",
			"const samples: Sample[] = [",
			"  { label: 'alpha', value: 2 },",
			"  { label: 'beta', value: 4 },",
			"  { label: 'gamma', value: 6 },",
			"];",
			"",
			"const total = summarize(samples);",
			"console.log('indexed-total=' + total);",
			"",
		].join("\n");
		for (const testCase of [
			{ ownerPrefix: "step-over-loop", breakpointLine: 12, action: "over" },
			{ ownerPrefix: "step-out-loop", breakpointLine: 4, action: "out" },
		] as const) {
			const cwd = await fs.mkdtemp(path.join(os.tmpdir(), `bun-dap-x-${testCase.ownerPrefix}-`));
			const manager = new DapSessionManager();
			const ownerId = `bun-dap-${testCase.ownerPrefix}-${Bun.randomUUIDv7()}`;
			try {
				const program = path.join(cwd, "indexed-loop.ts");
				await Bun.write(program, source);
				await manager.setBreakpoint(program, testCase.breakpointLine, undefined, undefined, 10_000, { ownerId });

				const snapshot = await manager.launch({ ownerId, adapter: requireBunAdapter(cwd), program, cwd }, undefined, 30_000);
				expect(snapshot.status).toBe("stopped");
				expect(snapshot.line).toBe(testCase.breakpointLine);

				const stepped =
					testCase.action === "over" ? await manager.stepOver(undefined, 10_000, { ownerId }) : await manager.stepOut(undefined, 10_000, { ownerId });
				expect(stepped.state).toBe("stopped");
				expect(stepped.snapshot.frameName).toBe("summarize");
				expect(stepped.snapshot.line).toBe(12);
				expect(
					(
						await manager.evaluate("String(index) + ':' + sample.label + ':' + String(total)", "watch", 1, undefined, 10_000, {
							ownerId,
						})
					).evaluation?.result,
				).toBe(testCase.action === "over" ? "2:gamma:12" : "1:beta:4");
			} finally {
				await manager.terminate(undefined, 10_000, { ownerId }).catch(() => undefined);
				await fs.rm(cwd, { recursive: true, force: true });
			}
		}
	}, 60_000);

	it("steps into local TypeScript call targets using temporary source breakpoints", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "bun-dap-x-step-in-local-"));
		const manager = new DapSessionManager();
		const ownerId = `bun-dap-step-in-local-${Bun.randomUUIDv7()}`;
		try {
			const program = path.join(cwd, "step-in.ts");
			await Bun.write(
				program,
				[
					"function addOne(value: number) {",
					"  const next = value + 1;",
					"  return next;",
					"}",
					"function main() {",
					"  const before = 1;",
					"  const result = addOne(before);",
					"  console.log(result);",
					"}",
					"main();",
					"await new Promise(() => {});",
					"",
				].join("\n"),
			);
			await manager.setBreakpoint(program, 7, undefined, undefined, 10_000, { ownerId });

			const snapshot = await manager.launch({ ownerId, adapter: requireBunAdapter(cwd), program, cwd }, undefined, 30_000);
			expect(snapshot.status).toBe("stopped");
			expect(snapshot.line).toBe(7);

			const stepped = await manager.stepIn(undefined, 10_000, { ownerId });
			expect(stepped.state).toBe("stopped");
			expect(stepped.snapshot.frameName).toBe("addOne");
			expect(stepped.snapshot.line).toBe(2);
			expect((await manager.evaluate("value", "repl", undefined, undefined, 10_000, { ownerId })).evaluation?.result).toBe("1");
		} finally {
			await manager.terminate(undefined, 10_000, { ownerId }).catch(() => undefined);
			await fs.rm(cwd, { recursive: true, force: true });
		}
	}, 45_000);

	it("maps pre-launch TypeScript loop breakpoints through Bun source maps", async () => {
		for (const testCase of [
			{
				ownerPrefix: "plain",
				condition: undefined,
				expectedIndex: "1",
				expectedSample: "beta",
				expectedTotal: "4",
			},
			{
				ownerPrefix: "condition",
				condition: "index === 1",
				expectedIndex: "1",
				expectedSample: "beta",
				expectedTotal: "4",
			},
		]) {
			const cwd = await fs.mkdtemp(path.join(os.tmpdir(), `bun-dap-x-index-${testCase.ownerPrefix}-`));
			const manager = new DapSessionManager();
			const ownerId = `bun-dap-index-${testCase.ownerPrefix}-${Bun.randomUUIDv7()}`;
			try {
				const program = path.join(cwd, "indexed-loop.ts");
				await Bun.write(
					program,
					[
						"type Sample = { label: string; value: number };",
						"",
						"function doubleValue(value: number): number {",
						"  const doubled = value * 2;",
						"  return doubled;",
						"}",
						"",
						"function summarize(samples: Sample[]): number {",
						"  let total = 0;",
						"  for (let index = 0; index < samples.length; index += 1) {",
						"    const sample = samples[index];",
						"    total += doubleValue(sample.value);",
						"  }",
						"  return total;",
						"}",
						"",
						"const samples: Sample[] = [",
						"  { label: 'alpha', value: 2 },",
						"  { label: 'beta', value: 4 },",
						"  { label: 'gamma', value: 6 },",
						"];",
						"",
						"const total = summarize(samples);",
						"console.log('total', total);",
						"",
					].join("\n"),
				);
				await manager.setBreakpoint(program, 12, testCase.condition, undefined, 10_000, { ownerId });

				const snapshot = await manager.launch({ ownerId, adapter: requireBunAdapter(cwd), program, cwd }, undefined, 30_000);

				expect(snapshot.status).toBe("stopped");
				expect(snapshot.frameName).toBe("summarize");
				expect(snapshot.line).toBe(12);
				expect((await manager.evaluate("total", "repl", undefined, undefined, 10_000, { ownerId })).evaluation?.result).toBe(testCase.expectedTotal);
				expect((await manager.evaluate("index", "repl", undefined, undefined, 10_000, { ownerId })).evaluation?.result).toBe(testCase.expectedIndex);
				expect((await manager.evaluate("sample.label", "repl", undefined, undefined, 10_000, { ownerId })).evaluation?.result).toBe(testCase.expectedSample);
			} finally {
				await manager.terminate(undefined, 10_000, { ownerId }).catch(() => undefined);
				await fs.rm(cwd, { recursive: true, force: true });
			}
		}
	}, 60_000);

	it("maps TypeScript function breakpoints back to source frames", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "bun-dap-x-source-map-"));
		const manager = new DapSessionManager();
		const ownerId = `bun-dap-source-map-${Bun.randomUUIDv7()}`;
		try {
			const program = path.join(cwd, "source-map.ts");
			await Bun.write(
				program,
				[
					"type Sample = { label: string; value: number };",
					"function doubleValue(value: number): number {",
					"  const doubled = value * 2;",
					"  return doubled;",
					"}",
					"function summarize(samples: Sample[]) {",
					"  return samples.map(sample => doubleValue(sample.value));",
					"}",
					"summarize([{ label: 'alpha', value: 2 }]);",
					"await new Promise(() => {});",
					"",
				].join("\n"),
			);
			await manager.setBreakpoint(program, 3, undefined, undefined, 10_000, { ownerId });

			const snapshot = await manager.launch({ ownerId, adapter: requireBunAdapter(cwd), program, cwd }, undefined, 30_000);

			expect(snapshot.status).toBe("stopped");
			expect(snapshot.frameName).toBe("doubleValue");
			expect(snapshot.line).toBe(3);
			expect((await manager.evaluate("value", "repl", undefined, undefined, 10_000, { ownerId })).evaluation?.result).toBe("2");
		} finally {
			await manager.terminate(undefined, 10_000, { ownerId }).catch(() => undefined);
			await fs.rm(cwd, { recursive: true, force: true });
		}
	}, 45_000);

	it("falls back to source-map binding when direct TypeScript lines are erased", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "bun-dap-x-erased-lines-"));
		const manager = new DapSessionManager();
		const ownerId = `bun-dap-erased-lines-${Bun.randomUUIDv7()}`;
		try {
			const program = path.join(cwd, "main.ts");
			const target = path.join(cwd, "erased-lines.ts");
			const erasedLines = Array.from({ length: 40 }, (_, index) => `interface Erased${index} { readonly value${index}: number; }`);
			const bootstrapLine = 2;
			const breakpointLine = erasedLines.length + 2;
			await Bun.write(
				target,
				[...erasedLines, "export function calculate(value: number): number {", "  const doubled = value * 2;", "  return doubled;", "}", ""].join("\n"),
			);
			await Bun.write(
				program,
				["import { calculate } from './erased-lines.ts';", "const boot = 0;", "console.log(calculate(21), boot);", "await new Promise(() => {});", ""].join(
					"\n",
				),
			);
			await manager.setBreakpoint(program, bootstrapLine, undefined, undefined, 10_000, { ownerId });

			const snapshot = await manager.launch({ ownerId, adapter: requireBunAdapter(cwd), program, cwd }, undefined, 30_000);

			expect(snapshot.status).toBe("stopped");
			expect(snapshot.line).toBe(bootstrapLine);

			const breakpointResponse = await manager.setBreakpoint(target, breakpointLine, undefined, undefined, 10_000, {
				ownerId,
			});
			expect(breakpointResponse.breakpoints[0]?.verified).toBe(true);

			const continued = await manager.continue(undefined, 10_000, { ownerId });
			expect(continued.state).toBe("stopped");
			expect(continued.snapshot.frameName).toBe("calculate");
			expect(continued.snapshot.line).toBe(breakpointLine);
			expect((await manager.evaluate("value", "repl", undefined, undefined, 10_000, { ownerId })).evaluation?.result).toBe("21");
		} finally {
			await manager.terminate(undefined, 10_000, { ownerId }).catch(() => undefined);
			await fs.rm(cwd, { recursive: true, force: true });
		}
	}, 45_000);

	it("binds pre-launch imported TypeScript breakpoints after erased lines", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "bun-dap-x-prelaunch-erased-lines-"));
		const manager = new DapSessionManager();
		const ownerId = `bun-dap-prelaunch-erased-lines-${Bun.randomUUIDv7()}`;
		try {
			const program = path.join(cwd, "main.ts");
			const target = path.join(cwd, "erased-import.ts");
			const erasedLines = Array.from({ length: 80 }, (_, index) => `interface PrelaunchErased${index} { readonly value${index}: number; }`);
			const breakpointLine = erasedLines.length + 4;
			await Bun.write(
				target,
				[
					...erasedLines,
					"const moduleReady = true;",
					"export function calculate(value: number): number {",
					"  if (!moduleReady) throw new Error('module not ready');",
					"  const doubled = value * 2;",
					"  return doubled;",
					"}",
					"",
				].join("\n"),
			);
			await Bun.write(program, ["import { calculate } from './erased-import.ts';", "console.log(calculate(21));", ""].join("\n"));
			await manager.setBreakpoint(target, breakpointLine, undefined, undefined, 10_000, { ownerId });

			const snapshot = await manager.launch({ ownerId, adapter: requireBunAdapter(cwd), program, cwd }, undefined, 30_000);

			expect(snapshot.status).toBe("stopped");
			expect(snapshot.frameName).toBe("calculate");
			expect(snapshot.line).toBe(breakpointLine);
			expect((await manager.evaluate("value", "repl", undefined, undefined, 10_000, { ownerId })).evaluation?.result).toBe("21");
		} finally {
			await manager.terminate(undefined, 10_000, { ownerId }).catch(() => undefined);
			await fs.rm(cwd, { recursive: true, force: true });
		}
	}, 45_000);

	it("stops at late top-level TypeScript call-site breakpoints", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "bun-dap-x-top-level-"));
		const manager = new DapSessionManager();
		const ownerId = `bun-dap-top-level-${Bun.randomUUIDv7()}`;
		try {
			const program = path.join(cwd, "top-level.ts");
			await Bun.write(
				program,
				[
					"type Sample = { label: string; value: number };",
					"",
					"function doubleValue(value: number): number {",
					"  const doubled = value * 2;",
					"  return doubled;",
					"}",
					"",
					"function summarize(samples: Sample[]): number {",
					"  let total = 0;",
					"  for (let index = 0; index < samples.length; index += 1) {",
					"    const sample = samples[index];",
					"    total += doubleValue(sample.value);",
					"  }",
					"  return total;",
					"}",
					"",
					"const samples: Sample[] = [",
					"  { label: 'alpha', value: 2 },",
					"  { label: 'beta', value: 4 },",
					"  { label: 'gamma', value: 6 },",
					"];",
					"",
					"const total = summarize(samples);",
					"console.log('total', total);",
					"",
				].join("\n"),
			);
			await manager.setBreakpoint(program, 23, undefined, undefined, 10_000, { ownerId });

			const snapshot = await manager.launch({ ownerId, adapter: requireBunAdapter(cwd), program, cwd }, undefined, 30_000);

			expect(snapshot.status).toBe("stopped");
			expect(snapshot.frameName).toBe("module code");
			expect(snapshot.line).toBe(23);
			expect((await manager.evaluate("samples.length", "repl", undefined, undefined, 10_000, { ownerId })).evaluation?.result).toBe("3");
		} finally {
			await manager.terminate(undefined, 10_000, { ownerId }).catch(() => undefined);
			await fs.rm(cwd, { recursive: true, force: true });
		}
	}, 45_000);

	it("does not stop before the previous top-level lexical initialization", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "bun-dap-x-top-level-lexical-"));
		const manager = new DapSessionManager();
		const ownerId = `bun-dap-top-level-lexical-${Bun.randomUUIDv7()}`;
		try {
			const program = path.join(cwd, "top-level-lexical.ts");
			await Bun.write(
				program,
				[
					'const label = "bun-dap-repro";',
					"const values = [2, 3, 5];",
					"const total = values.reduce((sum, value) => sum + value, 0);",
					"const payload = { label, values, total };",
					"console.log(`$" + "{payload.label}:$" + "{payload.total}`);",
					"",
				].join("\n"),
			);
			await manager.setBreakpoint(program, 5, undefined, undefined, 10_000, { ownerId });

			const snapshot = await manager.launch({ ownerId, adapter: requireBunAdapter(cwd), program, cwd }, undefined, 30_000);

			expect(snapshot.status).toBe("stopped");
			expect(snapshot.stopReason).toBe("breakpoint");
			expect(snapshot.frameName).toBe("module code");
			expect(snapshot.line).toBe(5);
			expect((await manager.evaluate("total", "repl", undefined, undefined, 10_000, { ownerId })).evaluation?.result).toBe("10");
			const payload = await manager.evaluate("payload", "repl", undefined, undefined, 10_000, { ownerId });
			expect(payload.evaluation?.result).toBe("Object");
			expect(payload.evaluation?.variablesReference ?? 0).toBeGreaterThan(0);
			const scopes = await manager.scopes(snapshot.frameId!, undefined, 10_000, { ownerId });
			const lexicalScope = scopes.scopes.find((scope) => scope.name === "globalLexicalEnvironment");
			expect(lexicalScope?.variablesReference ?? 0).toBeGreaterThan(0);
			const lexicalVariables = await manager.variables(lexicalScope!.variablesReference, undefined, 10_000, { ownerId });
			const variablesByName = new Map(lexicalVariables.variables.map((variable) => [variable.name, variable]));
			expect(variablesByName.get("label")?.value).toBe("bun-dap-repro");
			expect(variablesByName.get("values")?.value).toBe("Array");
			expect(variablesByName.get("total")?.value).toBe("10");
			expect(variablesByName.get("payload")?.value).toBe("Object");

			const stepped = await manager.stepOver(undefined, 10_000, { ownerId });
			expect(stepped.state).toBe("terminated");
		} finally {
			await manager.terminate(undefined, 10_000, { ownerId }).catch(() => undefined);
			await fs.rm(cwd, { recursive: true, force: true });
		}
	}, 45_000);

	it("supports setVariable, completions, and modules from Bun Inspector state", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "bun-dap-x-value-nav-"));
		const manager = new DapSessionManager();
		const ownerId = `bun-dap-value-nav-${Bun.randomUUIDv7()}`;
		try {
			const program = path.join(cwd, "value-nav.ts");
			await Bun.write(
				program,
				[
					"async function mutate(sample: { label: string; value: number }) {",
					"  let total = sample.value;",
					"  const holder = { count: total, nested: { label: sample.label } };",
					"  console.log('before', total, holder.count, holder.nested.label);",
					"  await Promise.resolve();",
					"  console.log('after', total, holder.count, holder.nested.label);",
					"}",
					"await mutate({ label: 'alpha', value: 2 });",
					"",
				].join("\n"),
			);
			const realProgram = await fs.realpath(program);
			await manager.setBreakpoint(program, 6, undefined, undefined, 10_000, { ownerId });

			const snapshot = await manager.launch({ ownerId, adapter: requireBunAdapter(cwd), program, cwd }, undefined, 30_000);
			expect(snapshot.status).toBe("stopped");
			expect(snapshot.source?.path).toBe(realProgram);
			expect(snapshot.line).toBe(6);

			const capabilities = manager.capabilities({ ownerId });
			expect(capabilities.supportsSetVariable).toBe(true);
			expect(capabilities.supportsCompletionsRequest).toBe(true);
			expect(capabilities.supportsModulesRequest).toBe(true);
			expect(capabilities.supportsReadMemoryRequest).not.toBe(true);
			expect(capabilities.supportsDisassembleRequest).not.toBe(true);

			const stack = await manager.stackTrace(1, undefined, 10_000, { ownerId });
			const frameId = stack.stackFrames[0]!.id;
			const scopes = await manager.scopes(frameId, undefined, 10_000, { ownerId });
			let localsReference = 0;
			for (const scope of scopes.scopes) {
				const variables = await manager.variables(scope.variablesReference, undefined, 10_000, { ownerId });
				const total = variables.variables.find((variable) => variable.name === "total");
				const holder = variables.variables.find((variable) => variable.name === "holder");
				if (total && holder) {
					localsReference = scope.variablesReference;
					expect(total.value).toBe("2");
				}
			}
			expect(localsReference).toBeGreaterThan(0);
			const holderReference = (await manager.evaluate("holder", "repl", frameId, undefined, 10_000, { ownerId })).evaluation?.variablesReference ?? 0;
			expect(holderReference).toBeGreaterThan(0);

			const totalSet = (
				await manager.customRequest("setVariable", { variablesReference: localsReference, name: "total", value: "41" }, undefined, 10_000, { ownerId })
			).body as { value?: string; type?: string };
			expect(totalSet.value).toBe("41");
			expect((await manager.evaluate("total", "repl", frameId, undefined, 10_000, { ownerId })).evaluation?.result).toBe("41");

			const holderSet = (
				await manager.customRequest("setVariable", { variablesReference: holderReference, name: "count", value: "total + 1" }, undefined, 10_000, { ownerId })
			).body as { value?: string; type?: string };
			expect(holderSet.value).toBe("42");
			expect((await manager.evaluate("holder.count", "repl", frameId, undefined, 10_000, { ownerId })).evaluation?.result).toBe("42");

			const localCompletions = (await manager.customRequest("completions", { frameId, text: "tot", column: 4 }, undefined, 10_000, { ownerId })).body as {
				targets?: { label?: string; start?: number; length?: number }[];
			};
			const totalCompletion = localCompletions.targets?.find((target) => target.label === "total");
			expect(totalCompletion?.start).toBe(1);
			expect(totalCompletion?.length).toBe(3);

			const memberCompletions = (await manager.customRequest("completions", { frameId, text: "sample.la", column: 10 }, undefined, 10_000, { ownerId }))
				.body as { targets?: { label?: string }[] };
			expect(memberCompletions.targets?.map((target) => target.label)).toContain("label");

			const globalCompletions = (await manager.customRequest("completions", { frameId, text: "Prom", column: 5 }, undefined, 10_000, { ownerId })).body as {
				targets?: { label?: string }[];
			};
			expect(globalCompletions.targets?.map((target) => target.label)).toContain("Promise");

			const modules = (await manager.customRequest("modules", { startModule: 0, moduleCount: 100 }, undefined, 10_000, { ownerId })).body as {
				modules?: { path?: string; name?: string }[];
				totalModules?: number;
			};
			expect(modules.totalModules).toBeGreaterThan(0);
			expect(modules.modules?.some((entry) => entry.path === realProgram || entry.name === path.basename(realProgram))).toBe(true);

			const continued = await manager.continue(undefined, 10_000, { ownerId });
			expect(continued.state).toBe("terminated");
			expect(manager.getOutput(undefined, { ownerId }).output).toContain("after 41 42 alpha");
		} finally {
			await manager.terminate(undefined, 10_000, { ownerId }).catch(() => undefined);
			await fs.rm(cwd, { recursive: true, force: true });
		}
	}, 45_000);
});
