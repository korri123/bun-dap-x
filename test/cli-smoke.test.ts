import { expect, test } from "bun:test";
import * as path from "node:path";
import type { Subprocess } from "bun";
import type { DapEventMessage, DapRequestMessage, DapResponseMessage } from "../src/protocol.ts";

type DapMessage = DapEventMessage | DapResponseMessage;

interface BufferedReader {
	buffer: Buffer;
	reader: ReadableStreamDefaultReader<Uint8Array>;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	let timer: Timer | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(message)), timeoutMs);
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

async function writeDapRequest(child: Subprocess<"pipe", "pipe", "pipe">, message: DapRequestMessage): Promise<void> {
	const payload = JSON.stringify(message);
	await child.stdin.write(new TextEncoder().encode(`Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`));
}

async function readDapMessage(input: BufferedReader, timeoutMs: number): Promise<DapMessage> {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const headerEnd = input.buffer.indexOf("\r\n\r\n");
		if (headerEnd !== -1) {
			const header = input.buffer.subarray(0, headerEnd).toString("utf8");
			const match = /Content-Length:\s*(\d+)/i.exec(header);
			if (!match) throw new Error(`Malformed DAP header: ${header}`);
			const length = Number.parseInt(match[1]!, 10);
			const bodyStart = headerEnd + 4;
			const bodyEnd = bodyStart + length;
			if (input.buffer.length >= bodyEnd) {
				const payload = input.buffer.subarray(bodyStart, bodyEnd).toString("utf8");
				input.buffer = input.buffer.subarray(bodyEnd);
				return JSON.parse(payload) as DapMessage;
			}
		}

		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new Error("Timed out waiting for a DAP message");
		const result = await withTimeout(input.reader.read(), remaining, "Timed out waiting for DAP stdout");
		if (result.done) throw new Error("DAP adapter exited before sending a complete message");
		input.buffer = Buffer.concat([input.buffer, Buffer.from(result.value)]);
	}
}

async function readUntil<T extends DapMessage>(input: BufferedReader, predicate: (message: DapMessage) => message is T, timeoutMs = 5_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new Error("Timed out waiting for the expected DAP message");
		const message = await readDapMessage(input, remaining);
		if (predicate(message)) return message;
	}
}

function readResponse(input: BufferedReader, requestSeq: number): Promise<DapResponseMessage> {
	return readUntil(input, (message): message is DapResponseMessage => isResponse(message, requestSeq));
}

function readEvent(input: BufferedReader, event: string): Promise<DapEventMessage> {
	return readUntil(input, (message): message is DapEventMessage => isEvent(message, event));
}

function isResponse(message: DapMessage, requestSeq: number): message is DapResponseMessage {
	return message.type === "response" && message.request_seq === requestSeq;
}

function isEvent(message: DapMessage, event: string): message is DapEventMessage {
	return message.type === "event" && message.event === event;
}

test("package bin handles stdio DAP initialize and terminate", async () => {
	const repoRoot = path.resolve(import.meta.dir, "..");
	const child = Bun.spawn({
		cmd: [path.join(repoRoot, "dist", "bun-dap-x")],
		cwd: repoRoot,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...Bun.env, FORCE_COLOR: "0" },
	});
	const stdout: BufferedReader = { buffer: Buffer.alloc(0), reader: child.stdout.getReader() };
	const stderrPromise = new Response(child.stderr).text();
	let expectCleanExit = false;

	try {
		await writeDapRequest(child, {
			seq: 1,
			type: "request",
			command: "initialize",
			arguments: { adapterID: "bun", columnsStartAt1: true, linesStartAt1: true },
		});
		const initialize = await readResponse(stdout, 1);
		expect(initialize.success).toBe(true);
		expect(initialize.command).toBe("initialize");
		expect((initialize.body as { supportsTerminateRequest?: unknown }).supportsTerminateRequest).toBe(true);

		await writeDapRequest(child, { seq: 2, type: "request", command: "terminate" });
		const terminate = await readResponse(stdout, 2);
		expect(terminate.success).toBe(true);
		expect(terminate.command).toBe("terminate");
		expect((await readEvent(stdout, "terminated")).event).toBe("terminated");
		expectCleanExit = true;
	} finally {
		await Promise.resolve(child.stdin.end()).catch(() => undefined);
		if (expectCleanExit) {
			await withTimeout(child.exited, 2_000, "DAP adapter did not exit after stdin closed");
			expect(child.exitCode).toBe(0);
			expect(await stderrPromise).toBe("");
		} else {
			if (child.exitCode === null) child.kill();
			await child.exited.catch(() => undefined);
			await stderrPromise.catch(() => undefined);
		}
	}
});
