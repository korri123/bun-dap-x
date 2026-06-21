import * as path from "node:path";
import type { Subprocess } from "bun";
import type {
	DapBreakpoint,
	DapCapabilities,
	DapEventMessage,
	DapRequestMessage,
	DapResponseMessage,
	DapScope,
	DapSourceBreakpoint,
	DapStackFrame,
	DapVariable,
} from "../../src/protocol.ts";

interface TestAdapter {
	command: string[];
	cwd: string;
	launchDefaults: Record<string, unknown>;
	name: string;
}

interface BreakpointRecord {
	verified: boolean;
	line: number;
	condition?: string;
	hitCondition?: string;
}

interface SessionSummary {
	id: string;
	ownerId: string;
	adapter: string;
	cwd: string;
	program: string;
	status: "configuring" | "running" | "stopped" | "terminated";
	threadId?: number;
	frameId?: number;
	stopReason?: string;
	frameName?: string;
	source?: { name?: string; path?: string };
	line?: number;
	column?: number;
	breakpointFiles: number;
	breakpointCount: number;
	functionBreakpointCount: number;
	outputBytes: number;
	outputTruncated: boolean;
	needsConfigurationDone: boolean;
}

interface SessionState {
	client: DapClient;
	adapter: TestAdapter;
	cwd: string;
	program: string;
	ownerId: string;
	status: SessionSummary["status"];
	stopReason?: string;
	threadId?: number;
	topFrame?: DapStackFrame;
	breakpoints: Map<string, BreakpointRecord[]>;
	capabilities?: DapCapabilities;
}

interface PendingRequest<T> {
	resolve(value: T): void;
	reject(error: Error): void;
	timer: Timer;
}

interface EventWaiter {
	events: Set<string>;
	resolve(message: DapEventMessage): void;
	reject(error: Error): void;
	timer: Timer;
}

interface DapLaunchOptions {
	ownerId: string;
	adapter: TestAdapter;
	program: string;
	cwd: string;
	args?: string[];
	extraLaunchArguments?: Record<string, unknown>;
}

function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

function normalizePath(file: string): string {
	return path.resolve(file);
}

function ownerIdFromTarget(target?: { ownerId?: string }): string {
	return target?.ownerId ?? "default";
}

function sourceName(file: string): string {
	return path.basename(file);
}

function responseBody<T>(message: DapResponseMessage): T {
	if (!message.success) throw new Error(message.message ?? `DAP request ${message.command} failed`);
	return message.body as T;
}

export function requireBunAdapter(cwd: string): TestAdapter {
	return {
		name: "bun",
		cwd: path.resolve(import.meta.dir, "..", ".."),
		command: [process.execPath, path.resolve(import.meta.dir, "..", "..", "src", "cli.ts")],
		launchDefaults: { runtime: process.execPath, cwd },
	};
}

interface DapInputSink {
	write(data: Uint8Array): number | Promise<number>;
	end(): void | Promise<void>;
}

class DapClient {
	#child: Subprocess<"pipe", "pipe", "pipe">;
	#writer: DapInputSink;
	#nextSeq = 1;
	#pending = new Map<number, PendingRequest<DapResponseMessage>>();
	#events: DapEventMessage[] = [];
	#waiters: EventWaiter[] = [];
	#buffer = Buffer.alloc(0);
	#encoder = new TextEncoder();
	#output = "";

	constructor(child: Subprocess<"pipe", "pipe", "pipe">) {
		this.#child = child;
		this.#writer = {
			write: (data) => child.stdin.write(data),
			end: () => {
				child.stdin.end();
			},
		};
		void this.#pumpStdout(child.stdout);
		void this.#pumpStderr(child.stderr);
	}

	static spawn(adapter: TestAdapter): DapClient {
		const child = Bun.spawn({
			cmd: adapter.command,
			cwd: adapter.cwd,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env: { ...Bun.env, FORCE_COLOR: "0" },
		});
		return new DapClient(child);
	}

	get output(): string {
		return this.#output;
	}

	async request<T>(command: string, args: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
		const seq = this.#nextSeq++;
		const message: DapRequestMessage = { seq, type: "request", command, arguments: args };
		const pending = Promise.withResolvers<DapResponseMessage>();
		const timer = setTimeout(() => {
			this.#pending.delete(seq);
			pending.reject(new Error(`DAP request '${command}' timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		this.#pending.set(seq, { resolve: pending.resolve, reject: pending.reject, timer });
		await this.#writeMessage(message);
		return responseBody<T>(await pending.promise);
	}

	waitForEvent(events: string[], timeoutMs = 30_000): Promise<DapEventMessage> {
		const eventSet = new Set(events);
		const queuedIndex = this.#events.findIndex((event) => eventSet.has(event.event));
		if (queuedIndex !== -1) {
			const [event] = this.#events.splice(queuedIndex, 1);
			if (event) return Promise.resolve(event);
		}
		const pending = Promise.withResolvers<DapEventMessage>();
		const timer = setTimeout(() => {
			this.#waiters = this.#waiters.filter((waiter) => waiter.resolve !== pending.resolve);
			pending.reject(new Error(`Timed out waiting for DAP event ${events.join("/")}`));
		}, timeoutMs);
		this.#waiters.push({ events: eventSet, resolve: pending.resolve, reject: pending.reject, timer });
		return pending.promise;
	}

	async close(): Promise<void> {
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("DAP client closed"));
		}
		this.#pending.clear();
		for (const waiter of this.#waiters) {
			clearTimeout(waiter.timer);
			waiter.reject(new Error("DAP client closed"));
		}
		this.#waiters = [];
		await Promise.resolve(this.#writer.end()).catch(() => undefined);
		if (this.#child.exitCode === null) this.#child.kill();
		await this.#child.exited.catch(() => undefined);
	}

	async #writeMessage(message: DapRequestMessage): Promise<void> {
		const payload = JSON.stringify(message);
		const bytes = this.#encoder.encode(`Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`);
		await this.#writer.write(bytes);
	}

	async #pumpStdout(stream: ReadableStream<Uint8Array>): Promise<void> {
		for await (const chunk of stream) {
			this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
			this.#drainMessages();
		}
	}

	async #pumpStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
		const decoder = new TextDecoder();
		for await (const chunk of stream) {
			const text = decoder.decode(chunk, { stream: true });
			if (text.length > 0) this.#output += text;
		}
		const tail = decoder.decode();
		if (tail.length > 0) this.#output += tail;
	}

	#drainMessages(): void {
		while (true) {
			const headerEnd = this.#buffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) return;
			const header = this.#buffer.subarray(0, headerEnd).toString("utf8");
			const match = /Content-Length:\s*(\d+)/i.exec(header);
			if (!match) {
				this.#buffer = Buffer.alloc(0);
				return;
			}
			const length = Number.parseInt(match[1] ?? "0", 10);
			const bodyStart = headerEnd + 4;
			const bodyEnd = bodyStart + length;
			if (this.#buffer.length < bodyEnd) return;
			const payload = this.#buffer.subarray(bodyStart, bodyEnd).toString("utf8");
			this.#buffer = this.#buffer.subarray(bodyEnd);
			this.#handleMessage(JSON.parse(payload) as DapResponseMessage | DapEventMessage);
		}
	}

	#handleMessage(message: DapResponseMessage | DapEventMessage): void {
		if (message.type === "response") {
			const pending = this.#pending.get(message.request_seq);
			if (!pending) return;
			clearTimeout(pending.timer);
			this.#pending.delete(message.request_seq);
			pending.resolve(message);
			return;
		}
		if (message.type !== "event") return;
		if (message.event === "output") {
			const body = message.body;
			if (typeof body === "object" && body !== null && "output" in body && typeof body.output === "string") {
				this.#output += body.output;
			}
		}
		const waiterIndex = this.#waiters.findIndex((waiter) => waiter.events.has(message.event));
		if (waiterIndex !== -1) {
			const [waiter] = this.#waiters.splice(waiterIndex, 1);
			if (waiter) {
				clearTimeout(waiter.timer);
				waiter.resolve(message);
			}
			return;
		}
		this.#events.push(message);
	}
}

export class DapSessionManager {
	#pendingBreakpoints = new Map<string, BreakpointRecord[]>();
	#session?: SessionState;
	#nextSessionId = 1;

	getOutput(_limit?: number, _target?: { ownerId?: string }): { output: string } {
		return { output: this.#session?.client.output ?? "" };
	}

	async launch(options: DapLaunchOptions, _signal?: AbortSignal, timeoutMs = 30_000): Promise<SessionSummary> {
		const client = DapClient.spawn(options.adapter);
		const session: SessionState = {
			client,
			adapter: options.adapter,
			cwd: options.cwd,
			program: options.program,
			ownerId: options.ownerId,
			status: "configuring",
			breakpoints: new Map(),
		};
		this.#session = session;
		try {
			session.capabilities = await client.request<DapCapabilities>("initialize", { adapterID: "bun" }, timeoutMs);
			await client.request(
				"launch",
				{
					...options.adapter.launchDefaults,
					...(options.extraLaunchArguments ?? {}),
					program: options.program,
					cwd: options.cwd,
					args: options.args,
				},
				timeoutMs,
			);
			await client.waitForEvent(["initialized"], timeoutMs);
			await this.#applyPendingBreakpoints(session, timeoutMs);
			await client.request("configurationDone", {}, timeoutMs);
			session.status = "running";
			await this.#waitForStopOrTermination(session, Math.min(timeoutMs, 10_000)).catch(() => undefined);
			return this.#summary(session);
		} catch (error) {
			await client.close().catch(() => undefined);
			this.#session = undefined;
			throw toError(error);
		}
	}

	async setBreakpoint(
		file: string,
		line: number,
		condition?: string,
		_signal?: AbortSignal,
		timeoutMs = 30_000,
		target?: { ownerId?: string },
		sourceOptions?: { hitCondition?: string },
	): Promise<{ snapshot?: SessionSummary; breakpoints: BreakpointRecord[]; sourcePath: string }> {
		const sourcePath = normalizePath(file);
		const current = this.#pendingBreakpoints.get(sourcePath) ?? [];
		const next = current.filter((entry) => entry.line !== line);
		next.push({ verified: false, line, condition, hitCondition: sourceOptions?.hitCondition });
		next.sort((left, right) => left.line - right.line);
		this.#pendingBreakpoints.set(sourcePath, next);
		const session = this.#sessionForTarget(target);
		if (session) await this.#sendBreakpoints(session, sourcePath, next, timeoutMs);
		const breakpoints = session?.breakpoints.get(sourcePath) ?? this.#pendingBreakpoints.get(sourcePath) ?? next;
		return { snapshot: session ? this.#summary(session) : undefined, breakpoints, sourcePath };
	}

	async removeBreakpoint(file: string, line: number, _signal?: AbortSignal, timeoutMs = 30_000, target?: { ownerId?: string }): Promise<void> {
		const sourcePath = normalizePath(file);
		const next = (this.#pendingBreakpoints.get(sourcePath) ?? []).filter((entry) => entry.line !== line);
		if (next.length === 0) this.#pendingBreakpoints.delete(sourcePath);
		else this.#pendingBreakpoints.set(sourcePath, next);
		const session = this.#sessionForTarget(target);
		if (session) await this.#sendBreakpoints(session, sourcePath, next, timeoutMs);
	}

	async terminate(_signal?: AbortSignal, timeoutMs = 30_000, target?: { ownerId?: string }): Promise<SessionSummary> {
		const session = this.#sessionForTarget(target);
		if (!session) throw new Error("No active debug session");
		await session.client.request("terminate", {}, timeoutMs).catch(() => undefined);
		await session.client.close();
		session.status = "terminated";
		return this.#summary(session);
	}

	async stackTrace(
		levels?: number,
		startFrame?: number,
		timeoutMs = 30_000,
		target?: { ownerId?: string },
	): Promise<{ stackFrames: DapStackFrame[]; totalFrames?: number }> {
		const session = this.#requiredSession(target);
		return await session.client.request("stackTrace", { threadId: session.threadId ?? 1, startFrame, levels }, timeoutMs);
	}

	async scopes(frameId: number, _signal?: AbortSignal, timeoutMs = 30_000, target?: { ownerId?: string }): Promise<{ scopes: DapScope[] }> {
		const session = this.#requiredSession(target);
		return await session.client.request("scopes", { frameId }, timeoutMs);
	}

	async variables(variablesReference: number, _signal?: AbortSignal, timeoutMs = 30_000, target?: { ownerId?: string }): Promise<{ variables: DapVariable[] }> {
		const session = this.#requiredSession(target);
		return await session.client.request("variables", { variablesReference }, timeoutMs);
	}

	async evaluate(
		expression: string,
		context?: string,
		frameId?: number,
		_signal?: AbortSignal,
		timeoutMs = 30_000,
		target?: { ownerId?: string },
	): Promise<{ evaluation?: { result?: string; type?: string; variablesReference?: number } }> {
		const session = this.#requiredSession(target);
		const evaluation = await session.client.request<{ result?: string; type?: string; variablesReference?: number }>(
			"evaluate",
			{ expression, context, frameId: frameId ?? session.topFrame?.id },
			timeoutMs,
		);
		return { evaluation };
	}

	async customRequest(
		command: string,
		args: Record<string, unknown>,
		_signal?: AbortSignal,
		timeoutMs = 30_000,
		target?: { ownerId?: string },
	): Promise<{ body: unknown }> {
		const session = this.#requiredSession(target);
		return { body: await session.client.request(command, args, timeoutMs) };
	}

	async continue(
		_signal?: AbortSignal,
		timeoutMs = 30_000,
		target?: { ownerId?: string },
	): Promise<{ state: SessionSummary["status"]; snapshot: SessionSummary; timedOut: boolean }> {
		return await this.#resumeWithRequest("continue", timeoutMs, target);
	}

	async stepOver(
		_signal?: AbortSignal,
		timeoutMs = 30_000,
		target?: { ownerId?: string },
	): Promise<{ state: SessionSummary["status"]; snapshot: SessionSummary; timedOut: boolean }> {
		return await this.#resumeWithRequest("next", timeoutMs, target);
	}

	async stepIn(
		_signal?: AbortSignal,
		timeoutMs = 30_000,
		target?: { ownerId?: string },
	): Promise<{ state: SessionSummary["status"]; snapshot: SessionSummary; timedOut: boolean }> {
		return await this.#resumeWithRequest("stepIn", timeoutMs, target);
	}

	async stepOut(
		_signal?: AbortSignal,
		timeoutMs = 30_000,
		target?: { ownerId?: string },
	): Promise<{ state: SessionSummary["status"]; snapshot: SessionSummary; timedOut: boolean }> {
		return await this.#resumeWithRequest("stepOut", timeoutMs, target);
	}

	async #resumeWithRequest(
		command: string,
		timeoutMs: number,
		target?: { ownerId?: string },
	): Promise<{ state: SessionSummary["status"]; snapshot: SessionSummary; timedOut: boolean }> {
		const session = this.#requiredSession(target);
		await session.client.request(command, {}, timeoutMs);
		let timedOut = false;
		await this.#waitForStopOrTermination(session, timeoutMs).catch(() => {
			timedOut = true;
		});
		return { state: session.status, snapshot: this.#summary(session), timedOut };
	}

	async #applyPendingBreakpoints(session: SessionState, timeoutMs: number): Promise<void> {
		for (const [sourcePath, breakpoints] of this.#pendingBreakpoints) {
			await this.#sendBreakpoints(session, sourcePath, breakpoints, timeoutMs);
		}
	}

	async #sendBreakpoints(session: SessionState, sourcePath: string, breakpoints: BreakpointRecord[], timeoutMs: number): Promise<void> {
		const response = await session.client.request<{ breakpoints?: DapBreakpoint[] }>(
			"setBreakpoints",
			{
				source: { path: sourcePath, name: sourceName(sourcePath) },
				breakpoints: breakpoints.map<DapSourceBreakpoint>((entry) => ({
					line: entry.line,
					...(entry.condition ? { condition: entry.condition } : {}),
					...(entry.hitCondition ? { hitCondition: entry.hitCondition } : {}),
				})),
			},
			timeoutMs,
		);
		const mapped = breakpoints.map((entry, index) => ({ ...entry, verified: response.breakpoints?.[index]?.verified ?? entry.verified }));
		session.breakpoints.set(sourcePath, mapped);
		this.#pendingBreakpoints.set(sourcePath, mapped);
	}

	async #waitForStopOrTermination(session: SessionState, timeoutMs: number): Promise<void> {
		const event = await session.client.waitForEvent(["stopped", "terminated", "exited"], timeoutMs);
		if (event.event === "terminated" || event.event === "exited") {
			session.status = "terminated";
			return;
		}
		const body = event.body;
		if (typeof body !== "object" || body === null) throw new Error("DAP stopped event missing body");
		const stopped = body as { threadId?: number; reason?: string };
		session.status = "stopped";
		session.threadId = stopped.threadId ?? 1;
		session.stopReason = stopped.reason;
		const stack = await this.stackTrace(1, undefined, timeoutMs, { ownerId: session.ownerId });
		session.topFrame = stack.stackFrames[0];
	}

	#sessionForTarget(target?: { ownerId?: string }): SessionState | undefined {
		const ownerId = ownerIdFromTarget(target);
		return this.#session?.ownerId === ownerId ? this.#session : undefined;
	}

	#requiredSession(target?: { ownerId?: string }): SessionState {
		const session = this.#sessionForTarget(target);
		if (!session) throw new Error("No active debug session");
		return session;
	}

	#summary(session: SessionState): SessionSummary {
		const breakpoints = Array.from(session.breakpoints.values()).flat();
		return {
			id: `debug-${this.#nextSessionId}`,
			ownerId: session.ownerId,
			adapter: session.adapter.name,
			cwd: session.cwd,
			program: session.program,
			status: session.status,
			threadId: session.threadId,
			frameId: session.topFrame?.id,
			stopReason: session.stopReason,
			frameName: session.topFrame?.name,
			source: session.topFrame?.source,
			line: session.topFrame?.line,
			column: session.topFrame?.column,
			breakpointFiles: session.breakpoints.size,
			breakpointCount: breakpoints.length,
			functionBreakpointCount: 0,
			outputBytes: Buffer.byteLength(session.client.output, "utf8"),
			outputTruncated: false,
			needsConfigurationDone: session.capabilities?.supportsConfigurationDoneRequest === true,
		};
	}
}
