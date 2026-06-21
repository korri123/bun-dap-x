import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import type { Subprocess } from "bun";
import type { LineRange, MappedPosition, RawSourceMap } from "source-map-js";
import { SourceMapConsumer } from "source-map-js";
import type {
	DapBreakpoint,
	DapCapabilities,
	DapEventMessage,
	DapFunctionBreakpoint,
	DapRequestMessage,
	DapResponseMessage,
	DapSource,
	DapSourceBreakpoint,
} from "./protocol.ts";

type DapBody = Record<string, unknown>;

type BunDebuggeeProcess = Subprocess<"ignore", "pipe", "pipe">;

interface InspectorMessage {
	id?: number;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { message?: string };
}

interface PendingInspectorRequest {
	resolve(value: unknown): void;
	reject(error: Error): void;
}

interface BunWebSocketInit {
	headers?: Record<string, string>;
}

interface BunWebSocketConstructor {
	new (url: string, init?: BunWebSocketInit): WebSocket;
}

interface InspectorLocation {
	scriptId: string;
	lineNumber: number;
	columnNumber?: number;
}

interface InspectorScript {
	scriptId: string;
	url?: string;
	sourceMap?: BunSourceMap;
	startLine?: number;
	startColumn?: number;
	endLine?: number;
	endColumn?: number;
}

interface InspectorRemoteObject {
	type?: string;
	subtype?: string;
	value?: unknown;
	unserializableValue?: string;
	description?: string;
	objectId?: string;
	size?: number;
}
interface InspectorCallArgument {
	value?: unknown;
	unserializableValue?: string;
	objectId?: string;
}

interface InspectorEvaluateResult {
	result?: InspectorRemoteObject;
	exceptionDetails?: unknown;
}

type TestTimeoutPolicy = "off" | "auto" | "required";

interface InspectorScope {
	type: string;
	name?: string;
	object: InspectorRemoteObject;
}

interface InspectorCallFrame {
	callFrameId: string;
	functionName?: string;
	location: InspectorLocation;
	scopeChain?: InspectorScope[];
}

interface InspectorSetBreakpointResult {
	breakpointId?: string;
	locations?: InspectorLocation[];
	actualLocation?: InspectorLocation;
}

interface InspectorBreakpointLocationsResult {
	locations?: InspectorLocation[];
}

interface SourceStopLocation {
	script: InspectorScript;
	sourcePath?: string;
	line: number;
	column: number;
}

interface StepInTarget {
	sourcePath: string;
	line: number;
	column: number;
}

interface FunctionTargetMatch {
	script?: InspectorScript;
	target: StepInTarget;
}

interface TemporaryInstalledBreakpoint {
	sourceKey: string;
	inspectorId: string;
}

interface InspectorProperty {
	name: string;
	value?: InspectorRemoteObject;
}

interface VariableHandle {
	objectId?: string;
	type?: string;
	subtype?: string;
	size?: number;
	frameId?: string;
	isScope?: boolean;
}

interface CompletionContext {
	receiverExpression?: string;
	prefix: string;
	start: number;
	length: number;
}

interface CompletionItem {
	label: string;
	type?: string;
	start: number;
	length: number;
	sortText?: string;
}

interface StoredBreakpoint {
	dapId: number;
	inspectorId?: string;
	sourceKey: string;
	request: DapSourceBreakpoint;
	verified: boolean;
	location?: InspectorLocation;
	message?: string;
}

interface StoredFunctionBreakpoint {
	dapId: number;
	request: DapFunctionBreakpoint;
	verified: boolean;
	entry?: StoredBreakpoint;
	message?: string;
}

interface TcpNotifyServer {
	url: string;
	wait(timeoutMs: number): Promise<void>;
	close(): void;
}

type InspectorPauseOnExceptionsState = "none" | "uncaught" | "all";

const THREAD_ID = 1;
const DEFAULT_ATTACH_PORT = 6499;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const CAPABILITIES: DapCapabilities = {
	supportsConfigurationDoneRequest: true,
	supportsFunctionBreakpoints: true,
	supportsConditionalBreakpoints: true,
	supportsHitConditionalBreakpoints: true,
	supportsLogPoints: true,
	supportsEvaluateForHovers: true,
	supportsSetVariable: true,
	supportsCompletionsRequest: true,
	supportsTerminateRequest: true,
	supportsLoadedSourcesRequest: true,
	supportsBreakpointLocationsRequest: true,
	supportsModulesRequest: true,
	exceptionBreakpointFilters: [
		{ filter: "uncaught", label: "Uncaught Exceptions", description: "Pause when an exception is not caught.", default: false },
		{ filter: "all", label: "All Exceptions", description: "Pause whenever an exception is thrown.", default: false },
	],
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toError(value: unknown): Error {
	if (value instanceof Error) return value;
	return new Error(String(value));
}

function toErrorMessage(value: unknown): string {
	return toError(value).message;
}

function stringArg(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArrayArg(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string");
}

function isBunExecutablePath(value: string): boolean {
	const name = path.basename(value).toLowerCase();
	return name === "bun" || name === "bun.exe";
}

function hasBunTestTimeoutArg(args: readonly string[]): boolean {
	return args.some((arg) => arg === "--timeout" || arg.startsWith("--timeout="));
}

function withDebuggerTestTimeout(args: readonly string[], disableTestTimeout: boolean): string[] {
	if (!disableTestTimeout || args[0] !== "test" || hasBunTestTimeoutArg(args)) return [...args];
	return ["test", "--timeout=0", ...args.slice(1)];
}

function booleanArg(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function isLikelyBunTestPath(value: string | undefined): boolean {
	return value !== undefined && /(?:^|[.-])(?:test|spec)\.[cm]?[jt]sx?$/i.test(path.basename(value));
}

function numberArg(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function numberIsValid(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function sourceKey(source: unknown): string {
	if (!isRecord(source)) return "unknown";
	const sourcePath = stringArg(source.path);
	if (sourcePath) return canonicalizeSourcePath(sourcePath);
	return stringArg(source.name) ?? String(source.sourceReference ?? "unknown");
}

function canonicalizeSourcePath(input: string): string {
	if (input.startsWith("file://")) {
		try {
			return url.fileURLToPath(input);
		} catch {
			return input;
		}
	}
	if (/^[a-z][a-z\d+.-]*:\/\//i.test(input)) return input;
	const resolved = path.resolve(input);
	try {
		return fs.realpathSync.native(resolved);
	} catch {
		try {
			return fs.realpathSync(resolved);
		} catch {
			return resolved;
		}
	}
}

function inspectorUrlForSource(key: string): string {
	if (/^[a-z][a-z\d+.-]*:\/\//i.test(key)) return key;
	return canonicalizeSourcePath(key);
}

function sourceNeedsGeneratedMapping(sourceKey: string): boolean {
	const extension = path.extname(sourceKey).toLowerCase();
	return extension === ".ts" || extension === ".tsx" || extension === ".mts" || extension === ".cts" || extension === ".jsx";
}

function defaultColumnForSourceLine(sourcePath: string, line: number): number {
	if (line <= 0 || /^[a-z][a-z\d+.-]*:\/\//i.test(sourcePath)) return 0;
	try {
		const text = fs.readFileSync(sourcePath, "utf8");
		let start = 0;
		for (let currentLine = 1; currentLine < line; currentLine++) {
			const next = text.indexOf("\n", start);
			if (next === -1) return 0;
			start = next + 1;
		}
		let end = text.indexOf("\n", start);
		if (end === -1) end = text.length;
		const match = /\S/.exec(text.slice(start, end).replace(/\r$/, ""));
		return match?.index ?? 0;
	} catch {
		return 0;
	}
}

function breakpointColumn(sourceKey: string, breakpoint: DapSourceBreakpoint): number {
	return breakpoint.column === undefined ? defaultColumnForSourceLine(sourceKey, breakpoint.line) : Math.max(breakpoint.column - 1, 0);
}

function sourceLines(sourcePath: string | undefined): string[] {
	if (!sourcePath || !path.isAbsolute(sourcePath)) return [];
	try {
		return fs.readFileSync(sourcePath, "utf8").split(/\r?\n/);
	} catch {
		return [];
	}
}

function sourceLine(sourcePath: string | undefined, line: number): string | undefined {
	return sourceLines(sourcePath)[line - 1];
}

function isSourceStepCandidate(line: string): boolean {
	const trimmed = line.trim();
	return trimmed.length > 0 && !trimmed.startsWith("//") && !/^[{}()[\];,]+$/.test(trimmed);
}

function isSourceMapSentinelCandidate(line: string): boolean {
	const trimmed = line.trim();
	return (
		isSourceStepCandidate(trimmed) && !/^(?:type|interface|declare)\b/.test(trimmed) && !/^(?:import|export)\s+type\b/.test(trimmed) && !/^[{[]/.test(trimmed)
	);
}

function previousSourceMapSentinelLine(sourcePath: string, line: number): number | undefined {
	const lines = sourceLines(sourcePath);
	for (let index = Math.max(line - 2, 0); index >= 0; index--) {
		if (isSourceMapSentinelCandidate(lines[index] ?? "")) return index + 1;
	}
	return undefined;
}

function sourceCanDriftBeforeLine(sourcePath: string, line: number): boolean {
	const lines = sourceLines(sourcePath);
	for (let index = 0; index < Math.max(line - 1, 0); index++) {
		const trimmed = (lines[index] ?? "").trim();
		if (trimmed.length === 0 || /^(?:type|interface|declare)\b/.test(trimmed) || /^(?:import|export)\s+type\b/.test(trimmed)) {
			return true;
		}
	}
	return false;
}

function nextSourceStepLine(sourcePath: string | undefined, afterLine: number): number | undefined {
	const lines = sourceLines(sourcePath);
	for (let index = Math.max(afterLine, 0); index < lines.length; index++) {
		if (isSourceStepCandidate(lines[index] ?? "")) return index + 1;
	}
	return undefined;
}

function sourceEnclosingLoopLine(sourcePath: string | undefined, line: number): number | undefined {
	const lines = sourceLines(sourcePath);
	for (let index = Math.max(line - 2, 0); index >= 0; index--) {
		const trimmed = (lines[index] ?? "").trim();
		if (/^(?:for|while)\b/.test(trimmed)) return index + 1;
		if (/^(?:function|export\s+function|const|let|var)\b/.test(trimmed) && trimmed.endsWith("{")) return undefined;
		if (trimmed === "}") return undefined;
	}
	return undefined;
}

function pendingSourceMapPlaceholderLine(sourcePath: string, line: number): number {
	return sourceEnclosingLoopLine(sourcePath, line) ?? previousSourceMapSentinelLine(sourcePath, line) ?? line;
}

function sourceLineIsInsideLoop(sourcePath: string | undefined, line: number): boolean {
	return sourceEnclosingLoopLine(sourcePath, line) !== undefined;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const STEP_IN_KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "function", "return", "typeof", "new", "await"]);

function callNamesFromLine(line: string | undefined): string[] {
	if (!line) return [];
	const names: string[] = [];
	const seen = new Set<string>();
	const regex = /\b([A-Za-z_$][\w$]*)\s*(?=\()/g;
	let match = regex.exec(line);
	while (match !== null) {
		const current = match;
		match = regex.exec(line);
		const name = current[1];
		if (!name || STEP_IN_KEYWORDS.has(name)) continue;
		const previous = current.index > 0 ? line[current.index - 1] : undefined;
		if (previous === ".") continue;
		if (seen.has(name)) continue;
		seen.add(name);
		names.push(name);
	}
	return names.reverse();
}

function firstFunctionBodyLine(lines: string[], declarationIndex: number): number {
	const declaration = lines[declarationIndex] ?? "";
	const braceIndex = declaration.lastIndexOf("{");
	if (braceIndex !== -1 && declaration.slice(braceIndex + 1).trim().length > 0) return declarationIndex + 1;
	if (braceIndex === -1 && declaration.includes("=>")) return declarationIndex + 1;
	return nextSourceStepLineFromLines(lines, declarationIndex + 1) ?? declarationIndex + 1;
}

function nextSourceStepLineFromLines(lines: string[], startIndex: number): number | undefined {
	for (let index = Math.max(startIndex, 0); index < lines.length; index++) {
		if (isSourceStepCandidate(lines[index] ?? "")) return index + 1;
	}
	return undefined;
}

function functionSearchName(name: string): string | undefined {
	const simpleName = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
	return /^[A-Za-z_$][\w$]*$/.test(simpleName) ? simpleName : undefined;
}

function findFunctionTargets(sourcePath: string, name: string, defaultExport: boolean): StepInTarget[] {
	const lines = sourceLines(sourcePath);
	const simpleName = functionSearchName(name);
	if (lines.length === 0 || !simpleName) return [];
	const escaped = escapeRegExp(simpleName);
	const declarations = [
		new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${escaped}\\s*\\(`),
		new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\s*=`),
		new RegExp(`^\\s*(?:(?:public|private|protected|static|async|get|set)\\s+)*${escaped}\\s*\\([^)]*\\)\\s*\\{`),
	];
	const defaultDeclaration = /^\s*export\s+default\s+(?:async\s+)?function(?:\s+[A-Za-z_$][\w$]*)?\s*\(/;
	const targets: StepInTarget[] = [];
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		if (!declarations.some((regex) => regex.test(line)) && !(defaultExport && defaultDeclaration.test(line))) continue;
		targets.push({ sourcePath, line: firstFunctionBodyLine(lines, index), column: 1 });
	}
	return targets;
}

function findFunctionTarget(sourcePath: string, name: string, defaultExport: boolean): StepInTarget | undefined {
	return findFunctionTargets(sourcePath, name, defaultExport)[0];
}

function resolveImportSource(importerPath: string, specifier: string): string | undefined {
	if (!specifier.startsWith(".") && !specifier.startsWith("/")) return undefined;
	const base = specifier.startsWith("/") ? specifier : path.resolve(path.dirname(importerPath), specifier);
	const candidates = path.extname(base)
		? [base]
		: [
				`${base}.ts`,
				`${base}.tsx`,
				`${base}.js`,
				`${base}.mjs`,
				`${base}.cjs`,
				path.join(base, "index.ts"),
				path.join(base, "index.tsx"),
				path.join(base, "index.js"),
			];
	for (const candidate of candidates) {
		try {
			return fs.realpathSync.native(candidate);
		} catch {
			try {
				return fs.realpathSync(candidate);
			} catch {}
		}
	}
	return undefined;
}

function findImportedFunctionTarget(sourcePath: string, localName: string): StepInTarget | undefined {
	for (const line of sourceLines(sourcePath)) {
		const named = /^\s*import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/.exec(line);
		if (named) {
			const importedPath = resolveImportSource(sourcePath, named[2] ?? "");
			if (!importedPath) continue;
			for (const specifier of (named[1] ?? "").split(",")) {
				const parts = specifier.trim().split(/\s+as\s+/);
				const importedName = parts[0]?.trim();
				const importedLocalName = (parts[1] ?? parts[0])?.trim();
				if (!importedName || importedLocalName !== localName) continue;
				const target = findFunctionTarget(importedPath, importedName, false);
				if (target) return target;
			}
		}
		const defaultImport = /^\s*import\s+([A-Za-z_$][\w$]*)\s+from\s*["']([^"']+)["']/.exec(line);
		if (defaultImport?.[1] === localName) {
			const importedPath = resolveImportSource(sourcePath, defaultImport[2] ?? "");
			if (!importedPath) continue;
			const target = findFunctionTarget(importedPath, "default", true);
			if (target) return target;
		}
	}
	return undefined;
}

function sourceFromPath(sourcePath: string | undefined): DapSource | undefined {
	if (!sourcePath) return undefined;
	if (sourcePath.startsWith("file://")) {
		try {
			const filePath = url.fileURLToPath(sourcePath);
			return { name: path.basename(filePath), path: filePath };
		} catch {
			return { name: path.basename(sourcePath), path: sourcePath };
		}
	}
	if (path.isAbsolute(sourcePath)) return { name: path.basename(sourcePath), path: sourcePath };
	return { name: sourcePath };
}

function normalizeForPathCompare(input: string): string {
	const value = canonicalizeSourcePath(input);
	return value.startsWith("/private/") ? value.slice("/private".length) : value;
}

function pathsLikelyMatch(left: string, right: string): boolean {
	const normalizedLeft = normalizeForPathCompare(left);
	const normalizedRight = normalizeForPathCompare(right);
	return normalizedLeft === normalizedRight || normalizedLeft.endsWith(normalizedRight) || normalizedRight.endsWith(normalizedLeft);
}

interface SourceMapSourceEntry {
	source: string;
	candidates: string[];
}

interface SourceMapLocation {
	line: number;
	column: number;
	source?: string;
}

class BunSourceMap {
	#consumer: SourceMapConsumer;
	#sources: SourceMapSourceEntry[];

	constructor(rawSourceMap: RawSourceMap, scriptUrl: string | undefined) {
		this.#consumer = new SourceMapConsumer(rawSourceMap);
		this.#sources = this.#consumer.sources.map((source) => ({
			source,
			candidates: sourceMapSourceCandidates(source, scriptUrl),
		}));
	}

	matchesSource(sourceKey: string): boolean {
		return this.#sources.some((entry) => entry.candidates.some((candidate) => pathsLikelyMatch(sourceKey, candidate)));
	}

	generatedLocation(sourceKey: string, line: number, column: number): SourceMapLocation | undefined {
		const source = this.#sourceFor(sourceKey);
		if (!source) return undefined;
		const candidates = [
			{ column, bias: SourceMapConsumer.GREATEST_LOWER_BOUND },
			{ column, bias: SourceMapConsumer.LEAST_UPPER_BOUND },
			{ column: 0, bias: SourceMapConsumer.LEAST_UPPER_BOUND },
			{ column: 0, bias: SourceMapConsumer.GREATEST_LOWER_BOUND },
		];
		for (const candidate of candidates) {
			let position: LineRange;
			try {
				position = this.#consumer.generatedPositionFor({
					source,
					line: line + 1,
					column: candidate.column,
					bias: candidate.bias,
				});
			} catch {
				continue;
			}
			if (!numberIsValid(position.line) || !numberIsValid(position.column)) continue;
			return { line: position.line - 1, column: position.column };
		}
		try {
			for (const position of this.#consumer.allGeneratedPositionsFor({ source, line: line + 1, column: 0 })) {
				if (!numberIsValid(position.line) || !numberIsValid(position.column)) continue;
				return { line: position.line - 1, column: position.column };
			}
		} catch {}
		return undefined;
	}

	originalLocation(line: number, column: number): SourceMapLocation | undefined {
		let position: MappedPosition;
		try {
			position = this.#consumer.originalPositionFor({
				line: line + 1,
				column,
			});
		} catch {
			return undefined;
		}
		if (!numberIsValid(position.line) || !numberIsValid(position.column)) return undefined;
		return {
			line: position.line - 1,
			column: position.column,
			source: this.#displaySource(position.source),
		};
	}

	sources(): string[] {
		return this.#sources.map((entry) => this.#displaySource(entry.source));
	}

	#sourceFor(sourceKey: string): string | undefined {
		for (const entry of this.#sources) {
			if (entry.candidates.some((candidate) => pathsLikelyMatch(sourceKey, candidate))) return entry.source;
		}
		return undefined;
	}

	#displaySource(source: string): string {
		const entry = this.#sources.find((candidate) => candidate.source === source);
		return entry?.candidates.find((candidate) => path.isAbsolute(candidate)) ?? entry?.candidates[0] ?? source;
	}
}

function sourceMapPathFromUrl(input: string | undefined): string | undefined {
	if (!input) return undefined;
	if (input.startsWith("file://")) {
		try {
			return url.fileURLToPath(input);
		} catch {
			return undefined;
		}
	}
	return path.isAbsolute(input) ? input : undefined;
}

function sourceMapSourceCandidates(source: string, scriptUrl: string | undefined): string[] {
	const candidates = new Set<string>([source]);
	const sourcePath = sourceMapPathFromUrl(source);
	if (sourcePath) candidates.add(sourcePath);
	const scriptPath = sourceMapPathFromUrl(scriptUrl);
	if (scriptPath && path.basename(source) === path.basename(scriptPath)) candidates.add(scriptPath);
	if (!sourcePath && scriptPath && !/^[a-z][a-z\d+.-]*:\/\//i.test(source)) {
		candidates.add(path.resolve(path.dirname(scriptPath), source));
	}
	return Array.from(candidates);
}

function rawSourceMapFromUnknown(value: unknown): RawSourceMap | undefined {
	if (!isRecord(value)) return undefined;
	const sources = stringArrayArg(value.sources);
	const mappings = stringArg(value.mappings);
	const version = value.version;
	if (!mappings || sources.length === 0 || (typeof version !== "string" && typeof version !== "number")) {
		return undefined;
	}
	const rawSourceMap: RawSourceMap = {
		version: String(version),
		sources,
		names: stringArrayArg(value.names),
		mappings,
	};
	if (typeof value.file === "string") rawSourceMap.file = value.file;
	if (typeof value.sourceRoot === "string") rawSourceMap.sourceRoot = value.sourceRoot;
	if (Array.isArray(value.sourcesContent)) {
		rawSourceMap.sourcesContent = value.sourcesContent.map((entry) => (typeof entry === "string" ? entry : ""));
	}
	return rawSourceMap;
}

function extractSourceMapUrl(sourceMapUrl: string): string {
	const trimmed = sourceMapUrl.trim();
	if (trimmed.startsWith("data:")) return trimmed;
	const match = trimmed.match(/\/\/[#@]\s*sourceMappingURL=(.*)$/m);
	return match?.[1]?.trim() ?? trimmed;
}

function parseBunSourceMap(sourceMapUrl: string | undefined, scriptUrl: string | undefined): BunSourceMap | undefined {
	if (!sourceMapUrl) return undefined;
	const extracted = extractSourceMapUrl(sourceMapUrl);
	if (!extracted.startsWith("data:")) return undefined;
	const comma = extracted.indexOf(",");
	if (comma === -1) return undefined;
	try {
		const metadata = extracted.slice(0, comma);
		const encoded = extracted.slice(comma + 1);
		const decoded = /;base64/i.test(metadata) ? Buffer.from(encoded, "base64url").toString("utf8") : decodeURIComponent(encoded);
		const rawSourceMap = rawSourceMapFromUnknown(JSON.parse(decoded));
		return rawSourceMap ? new BunSourceMap(rawSourceMap, scriptUrl) : undefined;
	} catch {
		return undefined;
	}
}

function sourceMatchesScript(sourceKey: string, script: InspectorScript): boolean {
	if (script.url && pathsLikelyMatch(sourceKey, script.url)) return true;
	return script.sourceMap?.matchesSource(sourceKey) ?? false;
}

function isArrayLikeRemoteObject(value: InspectorRemoteObject | VariableHandle | undefined): boolean {
	return value?.subtype === "array" || value?.subtype === "set" || value?.subtype === "weakset";
}

function variableType(value: InspectorRemoteObject | undefined): string | undefined {
	return value?.subtype ?? value?.type;
}

function remoteObjectToString(value: InspectorRemoteObject | undefined): string {
	if (!value) return "undefined";
	if (value.unserializableValue) return value.unserializableValue;
	if (value.value !== undefined) return String(value.value);
	if (value.description) return value.description;
	if (value.subtype) return value.subtype;
	return value.type ?? "undefined";
}

function isIdentifierName(value: string): boolean {
	return /^[A-Za-z_$][\w$]*$/.test(value);
}

function completionContextFromArgs(args: DapBody): CompletionContext {
	const text = typeof args.text === "string" ? args.text : "";
	const column = numberArg(args.column);
	const cursor = Math.min(text.length, Math.max((column ?? text.length + 1) - 1, 0));
	const beforeCursor = text.slice(0, cursor);
	const memberMatch = /((?:this|globalThis|[A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)*)\.\s*([A-Za-z_$][\w$]*)?$/.exec(beforeCursor);
	if (memberMatch?.[1]) {
		const prefix = memberMatch[2] ?? "";
		return {
			receiverExpression: memberMatch[1],
			prefix,
			start: cursor - prefix.length + 1,
			length: prefix.length,
		};
	}
	const nameMatch = /([A-Za-z_$][\w$]*)$/.exec(beforeCursor);
	const prefix = nameMatch?.[1] ?? "";
	return {
		prefix,
		start: cursor - prefix.length + 1,
		length: prefix.length,
	};
}

function breakpointOptions(breakpoint: DapSourceBreakpoint): Record<string, unknown> | undefined {
	const options: Record<string, unknown> = {};
	if (breakpoint.condition) options.condition = breakpoint.condition;
	if (breakpoint.hitCondition) {
		const hitCount = Number.parseInt(breakpoint.hitCondition, 10);
		if (Number.isFinite(hitCount) && hitCount > 0) options.ignoreCount = hitCount - 1;
	}
	if (breakpoint.logMessage) {
		options.actions = [{ type: "log", data: breakpoint.logMessage }];
		options.autoContinue = true;
	}
	return Object.keys(options).length > 0 ? options : undefined;
}

function stoppedReason(reason: string | undefined): string {
	switch (reason) {
		case "Breakpoint":
			return "breakpoint";
		case "PauseOnNextStatement":
		case "DebuggerStatement":
			return "step";
		case "exception":
		case "assert":
			return "exception";
		case "FunctionCall":
			return "function breakpoint";
		case undefined:
			return "pause";
		default:
			return reason;
	}
}

function readJsonEnv(value: unknown): Record<string, string | undefined> {
	if (!isRecord(value)) return {};
	const env: Record<string, string | undefined> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === "string" || entry === undefined) env[key] = entry;
	}
	return env;
}

function mergeEnv(extra: Record<string, string | undefined>, strict: boolean): Record<string, string> {
	const merged: Record<string, string | undefined> = strict ? { ...extra } : { ...Bun.env, ...extra };
	const clean: Record<string, string> = {};
	for (const [key, value] of Object.entries(merged)) {
		if (typeof value === "string") clean[key] = value;
	}
	return clean;
}

async function getFreeTcpPort(): Promise<number> {
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

function createTcpNotifyServer(): TcpNotifyServer {
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

function openBunWebSocket(inspectorUrl: string): WebSocket {
	const BunWebSocket = WebSocket as unknown as BunWebSocketConstructor;
	return new BunWebSocket(inspectorUrl, { headers: { "Ref-Event-Loop": "0" } });
}

class InspectorConnection {
	#nextId = 1;
	#pending = new Map<number, PendingInspectorRequest>();
	#socket?: WebSocket;
	#handlers = new Map<string, Set<(params: unknown) => void>>();

	on(method: string, handler: (params: unknown) => void): void {
		let handlers = this.#handlers.get(method);
		if (!handlers) {
			handlers = new Set();
			this.#handlers.set(method, handlers);
		}
		handlers.add(handler);
	}

	async connect(inspectorUrl: string, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<void> {
		this.close();
		const opened = Promise.withResolvers<void>();
		let settled = false;
		let socket: WebSocket;
		try {
			socket = openBunWebSocket(inspectorUrl);
		} catch (error) {
			throw toError(error);
		}
		this.#socket = socket;
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			opened.reject(new Error(`Timed out connecting to Bun inspector at ${inspectorUrl}`));
			this.close();
		}, timeoutMs);
		const cleanup = (): void => {
			clearTimeout(timeout);
			socket.removeEventListener("open", openHandler);
			socket.removeEventListener("error", errorHandler);
		};
		const openHandler = (): void => {
			if (settled) return;
			settled = true;
			cleanup();
			opened.resolve();
		};
		const errorHandler = (event: Event): void => {
			if (settled) return;
			settled = true;
			cleanup();
			opened.reject(new Error(`Bun inspector WebSocket error: ${event.type}`));
		};
		socket.addEventListener("open", openHandler);
		socket.addEventListener("error", errorHandler);
		socket.addEventListener("message", (event) => {
			void this.#handleMessage(event.data);
		});
		socket.addEventListener("close", () => {
			for (const pending of this.#pending.values()) pending.reject(new Error("Bun inspector connection closed"));
			this.#pending.clear();
			this.#emit("close", {});
		});
		await opened.promise;
	}

	close(): void {
		const socket = this.#socket;
		this.#socket = undefined;
		if (socket && socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) {
			socket.close();
		}
	}

	async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
		const socket = this.#socket;
		if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Bun inspector connection is not open");
		const id = this.#nextId++;
		const pending = Promise.withResolvers<T>();
		this.#pending.set(id, {
			resolve: (value) => pending.resolve(value as T),
			reject: pending.reject,
		});
		socket.send(JSON.stringify({ id, method, ...(params ? { params } : {}) }));
		return pending.promise;
	}

	sendNoWait(method: string, params?: Record<string, unknown>): void {
		const socket = this.#socket;
		if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Bun inspector connection is not open");
		socket.send(JSON.stringify({ id: this.#nextId++, method, ...(params ? { params } : {}) }));
	}

	async #handleMessage(data: unknown): Promise<void> {
		let payload: string;
		if (typeof data === "string") {
			payload = data;
		} else if (data instanceof ArrayBuffer) {
			payload = Buffer.from(data).toString("utf-8");
		} else if (data instanceof Blob) {
			payload = await data.text();
		} else {
			return;
		}
		let message: InspectorMessage;
		try {
			message = JSON.parse(payload) as InspectorMessage;
		} catch {
			return;
		}
		if (typeof message.id === "number") {
			const pending = this.#pending.get(message.id);
			if (!pending) return;
			this.#pending.delete(message.id);
			if (message.error) pending.reject(new Error(message.error.message ?? "Bun inspector error"));
			else pending.resolve(message.result);
			return;
		}
		if (message.method) this.#emit(message.method, message.params);
	}

	#emit(method: string, params: unknown): void {
		const handlers = this.#handlers.get(method);
		if (!handlers) return;
		for (const handler of handlers) handler(params);
	}
}

class BunDebugAdapter {
	#seq = 1;
	#inspector?: InspectorConnection;
	#process?: BunDebuggeeProcess;
	#notifyServer?: TcpNotifyServer;
	#scriptsById = new Map<string, InspectorScript>();
	#scriptsByUrl = new Map<string, InspectorScript>();
	#frames: InspectorCallFrame[] = [];
	#variableHandles = new Map<number, VariableHandle>();
	#nextVariableReference = 1;
	#breakpointsBySource = new Map<string, StoredBreakpoint[]>();
	#functionBreakpoints: StoredFunctionBreakpoint[] = [];
	#knownFunctionSourcePaths = new Set<string>();
	#breakpointsByInspectorId = new Map<string, StoredBreakpoint>();
	#placeholderBreakpointsByInspectorId = new Map<string, StoredBreakpoint>();
	#temporaryBreakpointIds = new Set<string>();
	#temporaryInstalledBreakpoints: TemporaryInstalledBreakpoint[] = [];
	#lastStepLocationOverride?: {
		scriptId: string;
		lineNumber: number;
		sourcePath: string;
		line: number;
		column: number;
	};
	#pendingStepLocationOverride?: { sourcePath: string; line: number; column: number };
	#pendingLoopSourceStep?: StepInTarget;
	#stepDisabledBreakpoints: StoredBreakpoint[] = [];
	#lastStopBreakpointId?: string;
	#nextBreakpointId = 1;
	#configurationDone = false;
	#terminatedSent = false;
	#exceptionPauseState: InspectorPauseOnExceptionsState = "none";
	#suppressInitialPause = false;
	#deferredInitialPause: unknown;
	#testTimeoutPolicy: TestTimeoutPolicy = "auto";

	async run(): Promise<void> {
		process.on("SIGTERM", () => this.dispose());
		process.on("SIGINT", () => this.dispose());
		let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
		for await (const chunk of Bun.stdin.stream()) {
			buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
			buffer = await this.#drainMessages(buffer);
		}
		this.dispose();
	}

	dispose(): void {
		this.#notifyServer?.close();
		this.#notifyServer = undefined;
		this.#inspector?.close();
		this.#inspector = undefined;
		const child = this.#process;
		this.#process = undefined;
		if (child && child.exitCode === null) child.kill("SIGTERM");
	}

	async #drainMessages(buffer: Buffer<ArrayBufferLike>): Promise<Buffer<ArrayBufferLike>> {
		let current = buffer;
		while (true) {
			const headerEnd = current.indexOf("\r\n\r\n");
			if (headerEnd === -1) return current;
			const header = current.subarray(0, headerEnd).toString("utf-8");
			const match = header.match(/Content-Length:\s*(\d+)/i);
			if (!match) return Buffer.alloc(0);
			const length = Number.parseInt(match[1], 10);
			const bodyStart = headerEnd + 4;
			const bodyEnd = bodyStart + length;
			if (current.length < bodyEnd) return current;
			const payload = current.subarray(bodyStart, bodyEnd).toString("utf-8");
			current = current.subarray(bodyEnd);
			let request: DapRequestMessage;
			try {
				request = JSON.parse(payload) as DapRequestMessage;
			} catch {
				continue;
			}
			if (request.type === "request") void this.#handleRequest(request);
		}
	}

	async #handleRequest(request: DapRequestMessage): Promise<void> {
		try {
			switch (request.command) {
				case "initialize":
					this.#sendResponse(request, CAPABILITIES);
					return;
				case "launch":
					await this.#launch(this.#args(request));
					this.#sendResponse(request, {});
					this.#sendEvent("initialized", {});
					return;
				case "attach":
					await this.#attach(this.#args(request));
					this.#sendResponse(request, {});
					this.#sendEvent("initialized", {});
					return;
				case "configurationDone":
					await this.#configurationDoneRequest();
					this.#sendResponse(request, {});
					return;
				case "setBreakpoints":
					this.#sendResponse(request, await this.#setBreakpoints(this.#args(request)));
					return;
				case "setFunctionBreakpoints":
					this.#sendResponse(request, await this.#setFunctionBreakpoints(this.#args(request)));
					return;
				case "setExceptionBreakpoints":
					this.#sendResponse(request, await this.#setExceptionBreakpoints(this.#args(request)));
					return;
				case "dataBreakpointInfo":
				case "setDataBreakpoints":
					this.#sendErrorResponse(request, "Bun Inspector does not support data breakpoints");
					return;
				case "setInstructionBreakpoints":
					this.#sendErrorResponse(request, "Bun Inspector does not support instruction breakpoints");
					return;
				case "threads":
					this.#sendResponse(request, { threads: [{ id: THREAD_ID, name: "bun" }] });
					return;
				case "stackTrace":
					this.#sendResponse(request, this.#stackTrace(this.#args(request)));
					return;
				case "scopes":
					this.#sendResponse(request, this.#scopes(this.#args(request)));
					return;
				case "variables":
					this.#sendResponse(request, await this.#variables(this.#args(request)));
					return;
				case "setVariable":
					this.#sendResponse(request, await this.#setVariable(this.#args(request)));
					return;

				case "evaluate":
					this.#sendResponse(request, await this.#evaluate(this.#args(request)));
					return;
				case "completions":
					this.#sendResponse(request, await this.#completions(this.#args(request)));
					return;

				case "continue":
					await this.#debuggerCommand("Debugger.resume");
					this.#sendResponse(request, { allThreadsContinued: true });
					return;
				case "next":
					if (!(await this.#sourceStepOver())) await this.#debuggerCommand("Debugger.stepNext");
					this.#sendResponse(request, {});
					return;
				case "stepIn":
					if (!(await this.#sourceStepIn())) await this.#debuggerCommand("Debugger.stepInto");
					this.#sendResponse(request, {});
					return;
				case "stepOut":
					if (!(await this.#sourceStepOut())) await this.#debuggerCommand("Debugger.stepOut");
					this.#sendResponse(request, {});
					return;
				case "pause":
					this.#debuggerCommandNoWait("Debugger.pause");
					this.#sendResponse(request, {});
					return;
				case "breakpointLocations":
					this.#sendResponse(request, await this.#breakpointLocations(this.#args(request)));
					return;
				case "loadedSources":
					this.#sendResponse(request, this.#loadedSources());
					return;
				case "modules":
					this.#sendResponse(request, this.#modules(this.#args(request)));
					return;
				case "terminate":
					this.dispose();
					this.#sendResponse(request, {});
					this.#sendTerminated();
					return;
				case "disconnect":
					this.dispose();
					this.#sendResponse(request, {});
					this.#sendTerminated();
					return;
				default:
					this.#sendErrorResponse(request, `Bun adapter does not support DAP request '${request.command}'`);
			}
		} catch (error) {
			this.#sendErrorResponse(request, toErrorMessage(error));
		}
	}

	#args(request: DapRequestMessage): DapBody {
		return isRecord(request.arguments) ? request.arguments : {};
	}

	#sendResponse(request: DapRequestMessage, body: unknown): void {
		const response: DapResponseMessage = {
			seq: this.#seq++,
			type: "response",
			request_seq: request.seq,
			success: true,
			command: request.command,
			body,
		};
		this.#writeMessage(response);
	}

	#sendErrorResponse(request: DapRequestMessage, message: string): void {
		const response: DapResponseMessage = {
			seq: this.#seq++,
			type: "response",
			request_seq: request.seq,
			success: false,
			command: request.command,
			message,
		};
		this.#writeMessage(response);
	}

	#sendEvent(event: string, body: unknown): void {
		const message: DapEventMessage = { seq: this.#seq++, type: "event", event, body };
		this.#writeMessage(message);
	}

	#writeMessage(message: DapResponseMessage | DapEventMessage): void {
		const payload = JSON.stringify(message);
		process.stdout.write(`Content-Length: ${Buffer.byteLength(payload, "utf-8")}\r\n\r\n${payload}`);
	}

	async #launch(args: DapBody): Promise<void> {
		const program = stringArg(args.program);
		if (!program) throw new Error("Bun launch requires program");
		const cwd = stringArg(args.cwd) ?? process.cwd();
		this.#rememberFunctionSourcePath(program, cwd);
		this.#testTimeoutPolicy = "off";
		const runtimeArg = stringArg(args.runtime) ?? stringArg(args.runtimeExecutable);
		const runtimeArgs = stringArrayArg(args.runtimeArgs);
		const programArgs = stringArrayArg(args.args);
		const programIsRuntime = runtimeArg === undefined && isBunExecutablePath(program);
		const runtime = programIsRuntime ? program : (runtimeArg ?? "bun");
		const disableTestTimeout = booleanArg(args.disableTestTimeout) ?? true;
		const processArgs = withDebuggerTestTimeout(
			programIsRuntime ? [...runtimeArgs, ...programArgs] : [...runtimeArgs, program, ...programArgs],
			disableTestTimeout,
		);
		const env = mergeEnv(readJsonEnv(args.env), args.strictEnv === true);
		const inspectorPort = await getFreeTcpPort();
		const inspectorUrl = `ws://127.0.0.1:${inspectorPort}/${crypto.randomUUID()}`;
		const notify = createTcpNotifyServer();
		this.#notifyServer = notify;
		this.#suppressInitialPause = args.stopOnEntry !== true;
		this.#deferredInitialPause = undefined;
		env.BUN_INSPECT = `${inspectorUrl}?break=1`;
		env.BUN_INSPECT_NOTIFY = notify.url;
		env.FORCE_COLOR = env.FORCE_COLOR ?? "1";
		env.BUN_QUIET_DEBUG_LOGS = "1";
		env.BUN_DEBUG_QUIET_LOGS = "1";
		let child: BunDebuggeeProcess;
		try {
			child = Bun.spawn({
				cmd: [runtime, ...processArgs],
				cwd,
				env,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				windowsHide: true,
			});
		} catch (error) {
			notify.close();
			throw toError(error);
		}
		this.#process = child;
		this.#pumpOutput(child.stdout, "stdout");
		this.#pumpOutput(child.stderr, "stderr");
		void child.exited.then((exitCode) => {
			this.#sendEvent("exited", { exitCode });
			this.#sendTerminated();
		});
		const earlyExit = child.exited.then<never>((exitCode) => {
			throw new Error(`Bun process exited before inspector attached (exit code ${exitCode})`);
		});
		try {
			await Promise.race([notify.wait(DEFAULT_REQUEST_TIMEOUT_MS), earlyExit]);
			await this.#connectInspector(inspectorUrl);
		} finally {
			notify.close();
			if (this.#notifyServer === notify) this.#notifyServer = undefined;
		}
	}

	async #attach(args: DapBody): Promise<void> {
		const program = stringArg(args.program);
		this.#rememberFunctionSourcePath(program, stringArg(args.cwd) ?? process.cwd());
		const disableTestTimeout = booleanArg(args.disableTestTimeout);
		this.#testTimeoutPolicy = disableTestTimeout === true ? "required" : disableTestTimeout === false ? "off" : isLikelyBunTestPath(program) ? "auto" : "off";
		const attachUrl = stringArg(args.url) ?? stringArg(args.inspectorUrl) ?? this.#buildAttachUrl(args);
		await this.#connectInspector(attachUrl);
	}

	#buildAttachUrl(args: DapBody): string {
		const host = stringArg(args.host) ?? "127.0.0.1";
		const port = numberArg(args.port) ?? DEFAULT_ATTACH_PORT;
		const rawPath = stringArg(args.path) ?? "";
		const inspectorPath = rawPath.replace(/^\/+/, "");
		return `ws://${host}:${port}/${inspectorPath}`;
	}

	async #connectInspector(inspectorUrl: string): Promise<void> {
		const inspector = new InspectorConnection();
		this.#inspector = inspector;
		inspector.on("Debugger.scriptParsed", (params) => this.#handleScriptParsed(params));
		inspector.on("Debugger.breakpointResolved", (params) => this.#handleBreakpointResolved(params));
		inspector.on("Debugger.paused", (params) => {
			void this.#handlePaused(params);
		});
		inspector.on("Debugger.resumed", () => {
			this.#frames = [];
			this.#lastStepLocationOverride = undefined;
			this.#sendEvent("continued", { threadId: THREAD_ID, allThreadsContinued: true });
		});
		inspector.on("Runtime.consoleAPICalled", (params) => this.#handleConsole(params));
		inspector.on("Inspector.disconnected", () => this.#sendTerminated());
		inspector.on("close", () => this.#sendTerminated());
		await inspector.connect(inspectorUrl);
		await inspector.send("Inspector.enable");
		await inspector.send("Runtime.enable");
		await inspector.send("Debugger.enable").catch((error) => {
			if (!/already enabled/i.test(toErrorMessage(error))) throw toError(error);
		});
		void inspector.send("Debugger.setAsyncStackTraceDepth", { depth: 200 }).catch(() => undefined);
		void inspector.send("Debugger.setPauseOnExceptions", { state: this.#exceptionPauseState }).catch(() => undefined);
	}

	async #configurationDoneRequest(): Promise<void> {
		this.#configurationDone = true;
		const inspector = this.#requiredInspector();
		await inspector.send("Debugger.setBreakpointsActive", { active: true });
		await this.#disableBunTestTimeoutBeforeResume(inspector);
		await inspector.send("Inspector.initialized");
		await this.#rebindBreakpointsForLoadedScripts();
		if (this.#suppressInitialPause && this.#deferredInitialPause !== undefined) {
			this.#deferredInitialPause = undefined;
			await inspector.send("Debugger.resume").catch(() => undefined);
		}
	}

	async #disableBunTestTimeoutBeforeResume(inspector: InspectorConnection): Promise<void> {
		if (this.#testTimeoutPolicy === "off") return;
		if (this.#testTimeoutPolicy === "auto" && !(await this.#targetMainLooksLikeBunTest(inspector))) return;
		const response = await inspector.send<InspectorEvaluateResult>("Runtime.evaluate", {
			expression: "import('bun:test').then((module) => { module.jest.setTimeout(0); return true; })",
			objectGroup: "bun-dap-x",
			awaitPromise: true,
			returnByValue: true,
			silent: true,
		});
		if (response.exceptionDetails) throw new Error("Failed to disable Bun test timeout through bun:test");
	}

	async #targetMainLooksLikeBunTest(inspector: InspectorConnection): Promise<boolean> {
		const response = await inspector.send<InspectorEvaluateResult>("Runtime.evaluate", {
			expression: "typeof Bun === 'object' && typeof Bun.main === 'string' ? Bun.main : ''",
			objectGroup: "bun-dap-x",
			returnByValue: true,
			silent: true,
		});
		if (response.exceptionDetails) return false;
		const main = response.result?.value;
		return isLikelyBunTestPath(typeof main === "string" ? main : undefined);
	}

	async #setBreakpoints(args: DapBody): Promise<{ breakpoints: DapBreakpoint[] }> {
		const key = sourceKey(args.source);
		const breakpoints = Array.isArray(args.breakpoints)
			? args.breakpoints.filter((entry): entry is DapSourceBreakpoint => isRecord(entry) && typeof entry.line === "number")
			: [];
		const old = this.#breakpointsBySource.get(key) ?? [];
		const inspector = this.#inspector;
		if (inspector) {
			const ids = old.flatMap((entry) => this.#breakpointIdsForEntry(entry));
			await Promise.allSettled(ids.map((id) => inspector.send("Debugger.removeBreakpoint", { breakpointId: id }).catch(() => undefined)));
		}
		for (const entry of old) {
			this.#forgetBreakpointIdsForEntry(entry);
		}
		const installed: StoredBreakpoint[] = [];
		for (const breakpoint of breakpoints) {
			installed.push(await this.#installBreakpoint(key, breakpoint));
		}
		this.#breakpointsBySource.set(key, installed);
		return { breakpoints: installed.map((entry) => this.#toDapBreakpoint(entry)) };
	}

	async #setFunctionBreakpoints(args: DapBody): Promise<{ breakpoints: DapBreakpoint[] }> {
		const breakpoints = Array.isArray(args.breakpoints)
			? args.breakpoints.filter((entry): entry is DapFunctionBreakpoint => isRecord(entry) && typeof entry.name === "string" && entry.name.length > 0)
			: [];
		for (const entry of this.#functionBreakpoints) {
			await this.#removeFunctionBreakpoint(entry);
		}
		this.#functionBreakpoints = [];
		for (const breakpoint of breakpoints) {
			const entry: StoredFunctionBreakpoint = {
				dapId: this.#nextBreakpointId++,
				request: breakpoint,
				verified: false,
			};
			await this.#installFunctionBreakpoint(entry);
			this.#functionBreakpoints.push(entry);
		}
		return { breakpoints: this.#functionBreakpoints.map((entry) => this.#toDapFunctionBreakpoint(entry)) };
	}

	async #setExceptionBreakpoints(args: DapBody): Promise<{ breakpoints: DapBreakpoint[] }> {
		const requested = this.#exceptionBreakpointRequests(args);
		const enabled = requested.filter((entry) => entry.condition === undefined && this.#isSupportedExceptionFilter(entry.filter)).map((entry) => entry.filter);
		this.#exceptionPauseState = this.#exceptionPauseStateForFilters(enabled);
		await this.#requiredInspector().send("Debugger.setPauseOnExceptions", { state: this.#exceptionPauseState });
		return {
			breakpoints: requested.map((entry) => {
				if (entry.condition !== undefined) {
					return { verified: false, message: "Bun Inspector exception breakpoints do not support conditions" };
				}
				if (!this.#isSupportedExceptionFilter(entry.filter)) {
					return { verified: false, message: `Unsupported exception breakpoint filter '${entry.filter}'` };
				}
				return { verified: true };
			}),
		};
	}

	#exceptionBreakpointRequests(args: DapBody): Array<{ filter: string; condition?: string }> {
		const requests: Array<{ filter: string; condition?: string }> = stringArrayArg(args.filters).map((filter) => ({ filter }));
		if (!Array.isArray(args.filterOptions)) return requests;
		for (const option of args.filterOptions) {
			if (!isRecord(option)) continue;
			const filter = stringArg(option.filterId);
			if (!filter) continue;
			const condition = stringArg(option.condition);
			requests.push({ filter, ...(condition ? { condition } : {}) });
		}
		return requests;
	}

	#isSupportedExceptionFilter(filter: string): boolean {
		return filter === "all" || filter === "uncaught";
	}

	#exceptionPauseStateForFilters(filters: string[]): InspectorPauseOnExceptionsState {
		if (filters.includes("all")) return "all";
		if (filters.includes("uncaught")) return "uncaught";
		return "none";
	}

	async #removeFunctionBreakpoint(entry: StoredFunctionBreakpoint): Promise<void> {
		const installed = entry.entry;
		if (!installed) return;
		const inspector = this.#inspector;
		if (inspector) {
			const ids = this.#breakpointIdsForEntry(installed);
			await Promise.allSettled(ids.map((id) => inspector.send("Debugger.removeBreakpoint", { breakpointId: id }).catch(() => undefined)));
		}
		this.#forgetBreakpointIdsForEntry(installed);
		entry.entry = undefined;
		entry.verified = false;
	}

	async #installFunctionBreakpoint(entry: StoredFunctionBreakpoint): Promise<boolean> {
		const matches = this.#functionTargetMatches(entry.request.name);
		if (matches.length !== 1) {
			entry.verified = false;
			entry.message =
				matches.length === 0
					? `No loaded function declaration named '${entry.request.name}' was found`
					: `Function breakpoint '${entry.request.name}' matched multiple loaded declarations`;
			return false;
		}
		await this.#removeFunctionBreakpoint(entry);
		const match = matches[0]!;
		const installed: StoredBreakpoint = {
			dapId: entry.dapId,
			sourceKey: match.target.sourcePath,
			request: {
				line: match.target.line,
				...(entry.request.condition ? { condition: entry.request.condition } : {}),
				...(entry.request.hitCondition ? { hitCondition: entry.request.hitCondition } : {}),
			},
			verified: false,
		};
		entry.entry = installed;
		await this.#installFunctionBreakpointByUrl(installed).catch((error) => {
			installed.message = toErrorMessage(error);
			return false;
		});
		this.#syncFunctionBreakpoint(entry);
		return entry.verified;
	}

	async #installFunctionBreakpointByUrl(entry: StoredBreakpoint): Promise<boolean> {
		return await this.#bindBreakpointByUrl(entry, this.#breakpointByUrlParams(entry));
	}

	#breakpointByUrlParams(entry: StoredBreakpoint): Record<string, unknown> {
		const params: Record<string, unknown> = {
			url: inspectorUrlForSource(entry.sourceKey),
			lineNumber: Math.max(entry.request.line - 1, 0),
			columnNumber: breakpointColumn(entry.sourceKey, entry.request),
		};
		const options = breakpointOptions(entry.request);
		if (options) params.options = options;
		return params;
	}

	async #bindBreakpointByUrl(entry: StoredBreakpoint, params: Record<string, unknown>): Promise<boolean> {
		const inspector = this.#inspector;
		if (!inspector) return false;
		const result = await inspector.send<InspectorSetBreakpointResult>("Debugger.setBreakpointByUrl", params);
		this.#applyBreakpointResult(entry, result);
		if (entry.inspectorId) this.#breakpointsByInspectorId.set(entry.inspectorId, entry);
		return entry.inspectorId !== undefined;
	}

	#syncFunctionBreakpoint(entry: StoredFunctionBreakpoint): void {
		entry.verified = entry.entry?.verified ?? false;
		entry.message = entry.entry?.message;
	}

	#rememberFunctionSourcePath(sourcePath: string | undefined, cwd: string): void {
		if (!sourcePath) return;
		this.#knownFunctionSourcePaths.add(canonicalizeSourcePath(path.isAbsolute(sourcePath) ? sourcePath : path.resolve(cwd, sourcePath)));
	}

	#functionTargetMatches(name: string): FunctionTargetMatch[] {
		const matches: FunctionTargetMatch[] = [];
		const seen = new Set<string>();
		for (const script of this.#scriptsById.values()) {
			for (const sourcePath of this.#sourcePathsForScript(script)) {
				this.#appendFunctionTargetMatches(matches, seen, sourcePath, name, script);
			}
		}
		for (const sourcePath of this.#knownFunctionSourcePaths) {
			this.#appendFunctionTargetMatches(matches, seen, sourcePath, name);
		}
		return matches;
	}

	#appendFunctionTargetMatches(matches: FunctionTargetMatch[], seen: Set<string>, sourcePath: string, name: string, script?: InspectorScript): void {
		for (const target of findFunctionTargets(sourcePath, name, name === "default")) {
			const key = `${target.sourcePath}:${target.line}:${target.column}`;
			if (seen.has(key)) continue;
			seen.add(key);
			matches.push(script ? { script, target } : { target });
		}
	}

	#sourcePathsForScript(script: InspectorScript): string[] {
		const paths = new Set<string>();
		for (const source of [script.url, ...(script.sourceMap?.sources() ?? [])]) {
			if (!source) continue;
			const sourcePath = sourceMapPathFromUrl(source) ?? (path.isAbsolute(source) ? source : undefined);
			if (sourcePath) paths.add(canonicalizeSourcePath(sourcePath));
		}
		return Array.from(paths);
	}

	async #installBreakpoint(key: string, breakpoint: DapSourceBreakpoint): Promise<StoredBreakpoint> {
		const entry: StoredBreakpoint = {
			dapId: this.#nextBreakpointId++,
			sourceKey: key,
			request: breakpoint,
			verified: false,
		};
		const inspector = this.#inspector;
		if (!inspector) return entry;
		const loadedScript = this.#findScriptForSource(key);
		const boundLoadedScript = loadedScript
			? await this.#tryBindLoadedScript(entry, loadedScript).catch((error) => {
					entry.message = toErrorMessage(error);
					return false;
				})
			: false;
		if (boundLoadedScript) return entry;
		const shouldDeferUntilSourceMap =
			!loadedScript && sourceNeedsGeneratedMapping(key) && breakpoint.line > 1 && sourceCanDriftBeforeLine(key, breakpoint.line);
		if (!shouldDeferUntilSourceMap) {
			try {
				await this.#bindBreakpointByUrl(entry, this.#breakpointByUrlParams(entry));
			} catch (error) {
				entry.message = entry.message ?? toErrorMessage(error);
			}
		}
		if (!loadedScript && breakpoint.line > 1) {
			await this.#installPendingSourceMapPlaceholder(entry).catch(() => undefined);
		}
		return entry;
	}

	#breakpointIdsForEntry(entry: StoredBreakpoint): string[] {
		const ids: string[] = [];
		if (entry.inspectorId) ids.push(entry.inspectorId);
		for (const [id, candidate] of this.#placeholderBreakpointsByInspectorId) {
			if (candidate === entry) ids.push(id);
		}
		return ids;
	}

	#forgetBreakpointIdsForEntry(entry: StoredBreakpoint): void {
		if (entry.inspectorId) this.#breakpointsByInspectorId.delete(entry.inspectorId);
		for (const [id, candidate] of this.#placeholderBreakpointsByInspectorId) {
			if (candidate === entry) this.#placeholderBreakpointsByInspectorId.delete(id);
		}
	}

	async #installPendingSourceMapPlaceholder(entry: StoredBreakpoint): Promise<void> {
		const inspector = this.#inspector;
		if (!inspector) return;
		const lines = new Set([1]);
		if (sourceCanDriftBeforeLine(entry.sourceKey, entry.request.line)) {
			lines.add(pendingSourceMapPlaceholderLine(entry.sourceKey, entry.request.line));
		}
		for (const line of lines) {
			const result = await inspector
				.send<InspectorSetBreakpointResult>("Debugger.setBreakpointByUrl", {
					url: inspectorUrlForSource(entry.sourceKey),
					lineNumber: Math.max(line - 1, 0),
					columnNumber: defaultColumnForSourceLine(entry.sourceKey, line),
				})
				.catch(() => undefined);
			if (result?.breakpointId) this.#placeholderBreakpointsByInspectorId.set(result.breakpointId, entry);
		}
	}

	#findScriptForSource(sourceKey: string): InspectorScript | undefined {
		const direct = this.#scriptsByUrl.get(sourceKey);
		if (direct) return direct;
		for (const script of this.#scriptsByUrl.values()) {
			if (script.url && pathsLikelyMatch(sourceKey, script.url)) return script;
		}
		for (const script of this.#scriptsByUrl.values()) {
			if (script.sourceMap?.matchesSource(sourceKey)) return script;
		}
		return undefined;
	}

	#sourceMappedLocationForBreakpoint(script: InspectorScript, breakpoint: DapSourceBreakpoint, sourceKey: string): SourceMapLocation | undefined {
		const line = Math.max(breakpoint.line - 1, 0);
		const column = breakpointColumn(sourceKey, breakpoint);
		return script.sourceMap?.generatedLocation(sourceKey, line, column);
	}

	#generatedLocationForBreakpoint(
		script: InspectorScript,
		breakpoint: DapSourceBreakpoint,
		sourceKey: string,
		options: { forceSourceMap?: boolean } = {},
	): InspectorLocation {
		const line = Math.max(breakpoint.line - 1, 0);
		const column = breakpointColumn(sourceKey, breakpoint);
		const mapped =
			options.forceSourceMap || !(script.url && pathsLikelyMatch(sourceKey, script.url))
				? this.#sourceMappedLocationForBreakpoint(script, breakpoint, sourceKey)
				: undefined;
		return {
			scriptId: script.scriptId,
			lineNumber: Math.max(mapped?.line ?? line, 0),
			columnNumber: Math.max(mapped?.column ?? column, 0),
		};
	}

	#sourceMapShouldMoveBreakpoint(script: InspectorScript, breakpoint: DapSourceBreakpoint, sourceKey: string, actualLineNumber: number): boolean {
		const mapped = this.#sourceMappedLocationForBreakpoint(script, breakpoint, sourceKey);
		if (mapped === undefined) return false;
		return Math.abs(mapped.line - actualLineNumber) > 1;
	}

	#locationMapsToSourceLine(script: InspectorScript, location: InspectorLocation, sourceKey: string, line: number): boolean {
		const original = this.#originalLocationForScript(script, location);
		return original.sourcePath !== undefined && pathsLikelyMatch(sourceKey, original.sourcePath) && original.line === line;
	}

	#originalLocationForScript(
		script: InspectorScript,
		location: InspectorLocation,
	): {
		sourcePath?: string;
		line: number;
		column: number;
	} {
		const column = location.columnNumber ?? 0;
		const mapped = script.sourceMap?.originalLocation(location.lineNumber, column);
		const scriptPath = sourceMapPathFromUrl(script.url);
		return {
			sourcePath: mapped?.source ?? scriptPath ?? script.url,
			line: (mapped?.line ?? location.lineNumber) + 1,
			column: (mapped?.column ?? column) + 1,
		};
	}

	#sourceStopLocation(frame = this.#frames[0]): SourceStopLocation | undefined {
		if (!frame) return undefined;
		const script = this.#scriptsById.get(frame.location.scriptId);
		if (!script) return undefined;
		const original = this.#breakpointOverrideForLocation(frame.location) ?? this.#originalLocationForScript(script, frame.location);
		return { script, sourcePath: original.sourcePath, line: original.line, column: original.column };
	}

	#allBreakpointEntries(): StoredBreakpoint[] {
		return [
			...Array.from(this.#breakpointsBySource.values()).flat(),
			...this.#functionBreakpoints.map((entry) => entry.entry).filter((entry): entry is StoredBreakpoint => entry !== undefined),
		];
	}

	#breakpointOverrideForLocation(location: InspectorLocation): { sourcePath: string; line: number; column: number } | undefined {
		const step = this.#lastStepLocationOverride;
		if (step?.scriptId === location.scriptId && step.lineNumber === location.lineNumber) {
			return { sourcePath: step.sourcePath, line: step.line, column: step.column };
		}
		for (const entry of this.#allBreakpointEntries()) {
			if (entry.location?.scriptId !== location.scriptId || entry.location.lineNumber !== location.lineNumber) {
				continue;
			}
			return {
				sourcePath: entry.sourceKey,
				line: entry.request.line,
				column: entry.request.column ?? 1,
			};
		}
		return undefined;
	}

	#breakpointEntriesForLocation(location: InspectorLocation): StoredBreakpoint[] {
		const entries: StoredBreakpoint[] = [];
		for (const entry of this.#allBreakpointEntries()) {
			if (entry.location?.scriptId === location.scriptId && entry.location.lineNumber === location.lineNumber) {
				entries.push(entry);
			}
		}
		return entries;
	}

	#breakpointEntriesForSourceLine(sourcePath: string, line: number): StoredBreakpoint[] {
		const entries: StoredBreakpoint[] = [];
		for (const entry of this.#allBreakpointEntries()) {
			if (pathsLikelyMatch(entry.sourceKey, sourcePath) && entry.request.line === line) entries.push(entry);
		}
		return entries;
	}

	async #temporarilyDisableBreakpoints(entries: StoredBreakpoint[]): Promise<void> {
		const inspector = this.#inspector;
		if (!inspector) return;
		for (const entry of entries) {
			if (this.#stepDisabledBreakpoints.includes(entry)) continue;
			const ids = this.#breakpointIdsForEntry(entry);
			if (ids.length > 0) {
				await Promise.allSettled(ids.map((id) => inspector.send("Debugger.removeBreakpoint", { breakpointId: id }).catch(() => undefined)));
				this.#forgetBreakpointIdsForEntry(entry);
				entry.inspectorId = undefined;
			}
			this.#stepDisabledBreakpoints.push(entry);
		}
	}

	async #temporarilyDisableSourceBreakpointsAt(sourcePath: string, line: number, frame?: InspectorCallFrame): Promise<void> {
		const entries = [...this.#breakpointEntriesForSourceLine(sourcePath, line)];
		if (frame) entries.push(...this.#breakpointEntriesForLocation(frame.location));
		await this.#temporarilyDisableBreakpoints(entries);
		if (!this.#lastStopBreakpointId) return;
		await this.#requiredInspector()
			.send("Debugger.removeBreakpoint", { breakpointId: this.#lastStopBreakpointId })
			.catch(() => undefined);
	}

	async #restoreStepDisabledBreakpoints(): Promise<void> {
		const entries = this.#stepDisabledBreakpoints.splice(0);
		for (const entry of entries) {
			await this.#tryRebindBreakpoint(entry);
		}
	}

	async #setTemporaryStepBreakpointBySource(sourcePath: string, line: number): Promise<boolean> {
		const result = await this.#requiredInspector().send<InspectorSetBreakpointResult>("Debugger.setBreakpointByUrl", {
			url: inspectorUrlForSource(sourcePath),
			lineNumber: Math.max(line - 1, 0),
			columnNumber: defaultColumnForSourceLine(sourcePath, line),
		});
		if (!result.breakpointId) return false;
		this.#temporaryBreakpointIds.add(result.breakpointId);
		return true;
	}

	async #setTemporaryStepBreakpointByInstalledSource(sourcePath: string, line: number): Promise<boolean> {
		const sourceKey = canonicalizeSourcePath(sourcePath);
		const entry = await this.#installBreakpoint(sourceKey, { line });
		if (!entry.inspectorId) return false;
		this.#breakpointsBySource.set(sourceKey, [...(this.#breakpointsBySource.get(sourceKey) ?? []), entry]);
		this.#temporaryInstalledBreakpoints.push({ sourceKey, inspectorId: entry.inspectorId });
		this.#temporaryBreakpointIds.add(entry.inspectorId);
		return true;
	}

	async #clearTemporaryStepBreakpoints(): Promise<void> {
		const inspector = this.#inspector;
		const ids = Array.from(this.#temporaryBreakpointIds);
		for (const { sourceKey, inspectorId } of this.#temporaryInstalledBreakpoints) {
			const remaining = (this.#breakpointsBySource.get(sourceKey) ?? []).filter((entry) => entry.inspectorId !== inspectorId);
			if (remaining.length === 0) this.#breakpointsBySource.delete(sourceKey);
			else this.#breakpointsBySource.set(sourceKey, remaining);
			this.#breakpointsByInspectorId.delete(inspectorId);
		}
		this.#temporaryInstalledBreakpoints = [];
		this.#temporaryBreakpointIds.clear();
		if (!inspector || ids.length === 0) return;
		await Promise.allSettled(ids.map((id) => inspector.send("Debugger.removeBreakpoint", { breakpointId: id }).catch(() => undefined)));
	}

	async #sourceStepOver(): Promise<boolean> {
		const current = this.#sourceStopLocation();
		if (!current?.sourcePath || !path.isAbsolute(current.sourcePath)) return false;
		const nextLine = nextSourceStepLine(current.sourcePath, current.line);
		if (!nextLine) return false;
		if (sourceLineIsInsideLoop(current.sourcePath, current.line)) {
			await this.#temporarilyDisableSourceBreakpointsAt(current.sourcePath, current.line, this.#frames[0]);
			this.#pendingLoopSourceStep = {
				sourcePath: current.sourcePath,
				line: current.line,
				column: current.column,
			};
			await this.#requiredInspector().send("Debugger.stepNext");
			return true;
		}
		this.#pendingStepLocationOverride = { sourcePath: current.sourcePath, line: nextLine, column: 1 };
		if (!(await this.#setTemporaryStepBreakpointBySource(current.sourcePath, nextLine))) return false;
		await this.#requiredInspector().send("Debugger.stepNext");
		return true;
	}

	async #sourceStepOut(): Promise<boolean> {
		const current = this.#sourceStopLocation();
		const caller = this.#sourceStopLocation(this.#frames[1]);
		if (!current?.sourcePath || !caller?.sourcePath || !path.isAbsolute(caller.sourcePath)) return false;
		if (!sourceLineIsInsideLoop(caller.sourcePath, caller.line)) return false;
		const entries = [...this.#breakpointEntriesForSourceLine(current.sourcePath, current.line)];
		const currentFrame = this.#frames[0];
		if (currentFrame) entries.push(...this.#breakpointEntriesForLocation(currentFrame.location));
		await this.#temporarilyDisableBreakpoints(entries);
		this.#pendingLoopSourceStep = { sourcePath: caller.sourcePath, line: caller.line, column: caller.column };
		await this.#requiredInspector().send("Debugger.stepOut");
		return true;
	}

	async #continuePendingLoopSourceStep(frame?: InspectorCallFrame): Promise<boolean> {
		const pending = this.#pendingLoopSourceStep;
		if (!pending || !frame) return false;
		const current = this.#sourceStopLocation(frame);
		const loopLine = sourceEnclosingLoopLine(pending.sourcePath, pending.line);
		if (!current?.sourcePath || loopLine === undefined || !pathsLikelyMatch(current.sourcePath, pending.sourcePath) || current.line !== loopLine) {
			this.#pendingLoopSourceStep = undefined;
			return false;
		}
		const targets = new Set([pending.line]);
		const fallbackLine = nextSourceStepLine(pending.sourcePath, pending.line);
		if (fallbackLine) targets.add(fallbackLine);
		await this.#temporarilyDisableBreakpoints(this.#breakpointEntriesForSourceLine(pending.sourcePath, pending.line));
		let installed = false;
		for (const line of targets) {
			installed = (await this.#setTemporaryStepBreakpointByInstalledSource(pending.sourcePath, line).catch(() => false)) || installed;
		}
		if (!installed) {
			this.#pendingLoopSourceStep = undefined;
			return false;
		}
		this.#pendingStepLocationOverride = pending;
		await this.#requiredInspector()
			.send("Debugger.resume")
			.catch(() => undefined);
		return true;
	}

	async #sourceStepIn(): Promise<boolean> {
		const current = this.#sourceStopLocation();
		if (!current?.sourcePath || !path.isAbsolute(current.sourcePath)) return false;
		const target = this.#stepInTargetForSourceLine(current.sourcePath, current.line);
		if (!target) return false;
		if (!this.#findScriptForSource(target.sourcePath)) return false;
		if (target.sourcePath === current.sourcePath) {
			await this.#temporarilyDisableSourceBreakpointsAt(current.sourcePath, current.line, this.#frames[0]);
		}
		if (!(await this.#setTemporaryStepBreakpointByInstalledSource(target.sourcePath, target.line))) return false;
		this.#pendingStepLocationOverride = { sourcePath: target.sourcePath, line: target.line, column: target.column };
		await this.#requiredInspector().send("Debugger.resume");
		return true;
	}

	#stepInTargetForSourceLine(sourcePath: string, line: number): StepInTarget | undefined {
		for (const name of callNamesFromLine(sourceLine(sourcePath, line))) {
			const local = findFunctionTarget(sourcePath, name, false);
			if (local) return local;
			const imported = findImportedFunctionTarget(sourcePath, name);
			if (imported) return imported;
		}
		return undefined;
	}

	async #breakpointLocations(args: DapBody): Promise<DapBody> {
		const key = sourceKey(args.source);
		const script = this.#findScriptForSource(key);
		if (!script) return { breakpoints: [] };
		const line = numberArg(args.line) ?? 1;
		const column = numberArg(args.column) ?? 1;
		const endLine = numberArg(args.endLine) ?? line + 1;
		const endColumn = numberArg(args.endColumn) ?? 1;
		const canUseMappedFallback = script.sourceMap?.matchesSource(key) === true || sourceLineIsInsideLoop(key, line);
		const sourceMapMovesStartLine = this.#sourceMapShouldMoveBreakpoint(script, { line, column }, key, Math.max(line - 1, 0));
		let usedDirect = true;
		let start = this.#generatedLocationForBreakpoint(script, { line, column }, key);
		let end = this.#generatedLocationForBreakpoint(script, { line: endLine, column: endColumn }, key);
		let result = await this.#requiredInspector().send<InspectorBreakpointLocationsResult>("Debugger.getBreakpointLocations", { start, end });
		const directLocations = result.locations ?? [];
		const directMapsToSourceLine = directLocations.some((location) => this.#locationMapsToSourceLine(script, location, key, line));
		if ((directLocations.length === 0 || sourceMapMovesStartLine || !directMapsToSourceLine) && canUseMappedFallback) {
			usedDirect = false;
			start = this.#generatedLocationForBreakpoint(script, { line, column }, key, { forceSourceMap: true });
			end = this.#generatedLocationForBreakpoint(script, { line: endLine, column: endColumn }, key, {
				forceSourceMap: true,
			});
			result = await this.#requiredInspector().send<InspectorBreakpointLocationsResult>("Debugger.getBreakpointLocations", { start, end });
		}
		const direct = usedDirect && script.url ? pathsLikelyMatch(key, script.url) : false;
		return {
			breakpoints: (result.locations ?? []).map((location) => {
				if (direct) return { line: location.lineNumber + 1, column: (location.columnNumber ?? 0) + 1 };
				const original = this.#originalLocationForScript(script, location);
				return { line: original.line, column: original.column };
			}),
		};
	}
	#applyBreakpointResult(entry: StoredBreakpoint, result: InspectorSetBreakpointResult, message?: string): void {
		entry.inspectorId = result.breakpointId;
		entry.location = result.actualLocation ?? result.locations?.[0];
		entry.verified = entry.location !== undefined;
		entry.message = entry.verified ? undefined : message;
	}

	async #tryRebindBreakpoint(entry: StoredBreakpoint, script?: InspectorScript): Promise<boolean> {
		const rebound = await this.#tryBindLoadedScript(entry, script).catch((error) => {
			entry.message = toErrorMessage(error);
			return false;
		});
		const functionEntry = this.#functionBreakpoints.find((candidate) => candidate.entry === entry);
		if (functionEntry) this.#syncFunctionBreakpoint(functionEntry);
		if (rebound) this.#sendEvent("breakpoint", { reason: "changed", breakpoint: this.#toDapBreakpoint(entry) });
		return rebound;
	}

	async #tryBindLoadedScript(entry: StoredBreakpoint, script = this.#findScriptForSource(entry.sourceKey)): Promise<boolean> {
		const inspector = this.#inspector;
		if (!inspector || !script) return false;
		if (entry.inspectorId) {
			await inspector.send("Debugger.removeBreakpoint", { breakpointId: entry.inspectorId }).catch(() => undefined);
			this.#breakpointsByInspectorId.delete(entry.inspectorId);
			entry.inspectorId = undefined;
		}
		const options = breakpointOptions(entry.request);
		const canUseSourceMapFallback = script.sourceMap?.matchesSource(entry.sourceKey) === true || sourceLineIsInsideLoop(entry.sourceKey, entry.request.line);
		let directErrorMessage: string | undefined;
		let result: InspectorSetBreakpointResult | undefined;
		try {
			result = await inspector.send<InspectorSetBreakpointResult>("Debugger.setBreakpoint", {
				location: this.#generatedLocationForBreakpoint(script, entry.request, entry.sourceKey),
				...(options ? { options } : {}),
			});
			this.#applyBreakpointResult(entry, result);
			if (entry.verified && canUseSourceMapFallback && entry.location) {
				if (this.#sourceMapShouldMoveBreakpoint(script, entry.request, entry.sourceKey, entry.location.lineNumber)) {
					entry.verified = false;
				}
			}
		} catch (error) {
			if (!canUseSourceMapFallback) throw error;
			directErrorMessage = toErrorMessage(error);
			entry.verified = false;
		}
		if (!entry.verified && canUseSourceMapFallback) {
			if (entry.inspectorId) {
				await inspector.send("Debugger.removeBreakpoint", { breakpointId: entry.inspectorId }).catch(() => undefined);
				entry.inspectorId = undefined;
			}
			const start = this.#generatedLocationForBreakpoint(script, entry.request, entry.sourceKey, {
				forceSourceMap: true,
			});
			const end = this.#generatedLocationForBreakpoint(script, { line: entry.request.line + 1, column: 1 }, entry.sourceKey, { forceSourceMap: true });
			const locations = await inspector.send<InspectorBreakpointLocationsResult>("Debugger.getBreakpointLocations", {
				start,
				end,
			});
			result = await inspector.send<InspectorSetBreakpointResult>("Debugger.setBreakpointByUrl", {
				url: script.url ?? inspectorUrlForSource(entry.sourceKey),
				...(locations.locations?.[0] ?? start),
				...(options ? { options } : {}),
			});
			this.#applyBreakpointResult(entry, result, directErrorMessage);
		}
		if (entry.verified) entry.message = undefined;
		if (entry.inspectorId) this.#breakpointsByInspectorId.set(entry.inspectorId, entry);
		return entry.verified;
	}

	async #rebindBreakpointsForScript(script: InspectorScript): Promise<void> {
		for (const entries of this.#breakpointsBySource.values()) {
			for (const entry of entries) {
				if (!sourceMatchesScript(entry.sourceKey, script)) continue;
				if (entry.verified && script.sourceMap?.matchesSource(entry.sourceKey) !== true) continue;
				await this.#tryRebindBreakpoint(entry, script);
			}
		}
	}
	async #rebindFunctionBreakpointsForLoadedScripts(): Promise<void> {
		for (const entry of this.#functionBreakpoints) {
			if (entry.entry?.verified) continue;
			if (entry.entry) {
				await this.#tryRebindBreakpoint(entry.entry);
				this.#syncFunctionBreakpoint(entry);
				continue;
			}
			if (await this.#installFunctionBreakpoint(entry)) {
				this.#sendEvent("breakpoint", { reason: "changed", breakpoint: this.#toDapFunctionBreakpoint(entry) });
			}
		}
	}

	async #rebindBreakpointsForLoadedScripts(): Promise<void> {
		for (const script of this.#scriptsById.values()) {
			await this.#rebindBreakpointsForScript(script);
		}
		await this.#rebindFunctionBreakpointsForLoadedScripts();
	}

	#toDapBreakpoint(entry: StoredBreakpoint): DapBreakpoint {
		return {
			id: entry.dapId,
			verified: entry.verified,
			...(entry.message ? { message: entry.message } : {}),
			source: sourceFromPath(entry.sourceKey),
			line: entry.request.line,
			column: entry.request.column,
		};
	}

	#toDapFunctionBreakpoint(entry: StoredFunctionBreakpoint): DapBreakpoint {
		return entry.entry
			? this.#toDapBreakpoint(entry.entry)
			: {
					id: entry.dapId,
					verified: entry.verified,
					...(entry.message ? { message: entry.message } : {}),
				};
	}

	#stackTrace(args: DapBody): DapBody {
		const startFrame = numberArg(args.startFrame) ?? 0;
		const levels = numberArg(args.levels) ?? this.#frames.length;
		const frames = this.#frames.slice(startFrame, startFrame + levels).map((frame, index) => {
			const script = this.#scriptsById.get(frame.location.scriptId);
			const original = this.#breakpointOverrideForLocation(frame.location) ?? (script ? this.#originalLocationForScript(script, frame.location) : undefined);
			return {
				id: startFrame + index + 1,
				name: frame.functionName || "(anonymous)",
				source: sourceFromPath(original?.sourcePath ?? script?.url),
				line: original?.line ?? frame.location.lineNumber + 1,
				column: original?.column ?? (frame.location.columnNumber ?? 0) + 1,
			};
		});
		return { stackFrames: frames, totalFrames: this.#frames.length };
	}

	#scopes(args: DapBody): DapBody {
		const frameId = numberArg(args.frameId);
		const frame = frameId ? this.#frames[frameId - 1] : undefined;
		return {
			scopes: (frame?.scopeChain ?? []).map((scope) => ({
				name: scope.name || scope.type,
				variablesReference: this.#createVariableReference(this.#variableHandleFromRemoteObject(scope.object, frame?.callFrameId, true)),
				expensive: scope.type === "global",
			})),
		};
	}

	async #variables(args: DapBody): Promise<DapBody> {
		const reference = numberArg(args.variablesReference);
		const handle = reference ? this.#variableHandles.get(reference) : undefined;
		if (!handle?.objectId) return { variables: [] };
		const result = await this.#requiredInspector().send<{ properties?: InspectorProperty[] }>("Runtime.getProperties", {
			objectId: handle.objectId,
			ownProperties: false,
			generatePreview: true,
		});
		const start = numberArg(args.start) ?? 0;
		const count = numberArg(args.count);
		const properties = result.properties ?? [];
		const visible = count === undefined ? properties.slice(start) : properties.slice(start, start + count);
		return {
			variables: visible.map((property) => {
				const value =
					handle.subtype === "array" && property.name === "length" && property.value?.type === "number" && handle.size !== undefined
						? { ...property.value, value: handle.size, description: String(handle.size) }
						: property.value;
				return {
					name: property.name,
					value: remoteObjectToString(value),
					type: variableType(value),
					variablesReference: value?.objectId ? this.#createVariableReference(this.#variableHandleFromRemoteObject(value, handle.frameId)) : 0,

					...(value && isArrayLikeRemoteObject(value) && value.size !== undefined ? { indexedVariables: value.size } : {}),
				};
			}),
		};
	}

	async #setVariable(args: DapBody): Promise<DapBody> {
		const reference = numberArg(args.variablesReference);
		const name = typeof args.name === "string" && args.name.length > 0 ? args.name : undefined;
		const valueExpression = typeof args.value === "string" ? args.value : undefined;
		if (reference === undefined || reference <= 0) throw new Error("setVariable requires variablesReference");
		if (!name) throw new Error("setVariable requires name");
		if (valueExpression === undefined) throw new Error("setVariable requires value");
		const handle = this.#variableHandles.get(reference);
		if (!handle) throw new Error(`Unknown variablesReference ${reference}`);
		const value =
			handle.isScope && handle.frameId && isIdentifierName(name)
				? await this.#setCallFrameVariable(handle.frameId, name, valueExpression)
				: await this.#setObjectProperty(handle, name, valueExpression);
		return this.#variableResponseFromRemoteObject(value, handle.frameId);
	}

	async #setCallFrameVariable(frameId: string, name: string, valueExpression: string): Promise<InspectorRemoteObject | undefined> {
		const result = await this.#requiredInspector().send<{ result?: InspectorRemoteObject }>("Debugger.evaluateOnCallFrame", {
			callFrameId: frameId,
			expression: `${name} = (${valueExpression})`,
			objectGroup: "bun-dap-x",
			includeCommandLineAPI: true,
			doNotPauseOnExceptionsAndMuteConsole: false,
		});
		return result.result;
	}

	async #setObjectProperty(handle: VariableHandle, name: string, valueExpression: string): Promise<InspectorRemoteObject | undefined> {
		if (!handle.objectId) throw new Error("setVariable target is not assignable");
		const value = await this.#evaluateAssignmentValue(valueExpression, handle.frameId);
		const result = await this.#requiredInspector().send<{ result?: InspectorRemoteObject }>("Runtime.callFunctionOn", {
			objectId: handle.objectId,
			functionDeclaration: "function(name, value) { this[name] = value; return this[name]; }",
			arguments: [{ value: name }, this.#callArgumentFromRemoteObject(value)],
			objectGroup: "bun-dap-x",
			awaitPromise: true,
			returnByValue: false,
		});
		return result.result;
	}

	async #evaluateExpression(expression: string, frameId: string | undefined, muteConsole = false): Promise<InspectorRemoteObject | undefined> {
		const result = frameId
			? await this.#requiredInspector().send<{ result?: InspectorRemoteObject }>("Debugger.evaluateOnCallFrame", {
					callFrameId: frameId,
					expression,
					objectGroup: "bun-dap-x",
					includeCommandLineAPI: true,
					doNotPauseOnExceptionsAndMuteConsole: muteConsole,
				})
			: await this.#requiredInspector().send<{ result?: InspectorRemoteObject }>("Runtime.evaluate", {
					expression,
					objectGroup: "bun-dap-x",
					includeCommandLineAPI: true,
				});
		return result.result;
	}

	async #evaluateAssignmentValue(expression: string, frameId: string | undefined): Promise<InspectorRemoteObject> {
		return (await this.#evaluateExpression(expression, frameId)) ?? { type: "undefined" };
	}

	#callArgumentFromRemoteObject(value: InspectorRemoteObject): InspectorCallArgument {
		if (value.objectId) return { objectId: value.objectId };
		if (value.unserializableValue) return { unserializableValue: value.unserializableValue };
		return { value: value.value };
	}

	#variableResponseFromRemoteObject(value: InspectorRemoteObject | undefined, frameId: string | undefined): DapBody {
		return {
			value: remoteObjectToString(value),
			type: variableType(value),
			variablesReference: value?.objectId ? this.#createVariableReference(this.#variableHandleFromRemoteObject(value, frameId)) : 0,
			...(value && isArrayLikeRemoteObject(value) && value.size !== undefined ? { indexedVariables: value.size } : {}),
		};
	}

	async #evaluate(args: DapBody): Promise<DapBody> {
		const expression = stringArg(args.expression);
		if (!expression) throw new Error("evaluate requires expression");
		const frame = this.#frameFromArgs(args);
		const value = await this.#evaluateExpression(expression, frame?.callFrameId);
		return {
			result: remoteObjectToString(value),
			type: variableType(value),
			variablesReference: value?.objectId ? this.#createVariableReference(this.#variableHandleFromRemoteObject(value, frame?.callFrameId)) : 0,
			...(value && isArrayLikeRemoteObject(value) && value.size !== undefined ? { indexedVariables: value.size } : {}),
		};
	}

	async #completions(args: DapBody): Promise<DapBody> {
		const context = completionContextFromArgs(args);
		const frame = this.#frameFromArgs(args);
		const targets = context.receiverExpression ? await this.#memberCompletions(context, frame) : await this.#scopeAndGlobalCompletions(context, frame);
		return { targets };
	}

	#frameFromArgs(args: DapBody): InspectorCallFrame | undefined {
		const frameId = numberArg(args.frameId);
		return frameId ? this.#frames[frameId - 1] : this.#frames[0];
	}

	async #memberCompletions(context: CompletionContext, frame: InspectorCallFrame | undefined): Promise<CompletionItem[]> {
		const expression = context.receiverExpression;
		if (!expression) return [];
		const value = await this.#evaluateCompletionExpression(expression, frame).catch(() => undefined);
		if (!value?.objectId) return [];
		const properties = await this.#propertiesForObject(value.objectId).catch(() => []);
		return this.#completionItemsFromProperties(properties, context);
	}

	async #scopeAndGlobalCompletions(context: CompletionContext, frame: InspectorCallFrame | undefined): Promise<CompletionItem[]> {
		const properties = new Map<string, InspectorRemoteObject | undefined>();
		for (const scope of frame?.scopeChain ?? []) {
			if (!scope.object.objectId) continue;
			this.#recordCompletionProperties(properties, await this.#propertiesForObject(scope.object.objectId).catch(() => []));
		}
		const global = await this.#evaluateExpression("globalThis", undefined, true).catch(() => undefined);
		if (global?.objectId) {
			this.#recordCompletionProperties(properties, await this.#propertiesForObject(global.objectId).catch(() => []));
		}
		return this.#completionItemsFromMap(properties, context);
	}

	async #evaluateCompletionExpression(expression: string, frame: InspectorCallFrame | undefined): Promise<InspectorRemoteObject | undefined> {
		return await this.#evaluateExpression(expression, frame?.callFrameId, true);
	}

	async #propertiesForObject(objectId: string): Promise<InspectorProperty[]> {
		const result = await this.#requiredInspector().send<{ properties?: InspectorProperty[] }>("Runtime.getProperties", {
			objectId,
			ownProperties: false,
			generatePreview: true,
		});
		return result.properties ?? [];
	}

	#completionItemsFromProperties(properties: InspectorProperty[], context: CompletionContext): CompletionItem[] {
		const mapped = new Map<string, InspectorRemoteObject | undefined>();
		this.#recordCompletionProperties(mapped, properties);
		return this.#completionItemsFromMap(mapped, context);
	}

	#recordCompletionProperties(target: Map<string, InspectorRemoteObject | undefined>, properties: InspectorProperty[]): void {
		for (const property of properties) {
			if (property.name.length === 0 || target.has(property.name)) continue;
			target.set(property.name, property.value);
		}
	}

	#completionItemsFromMap(properties: Map<string, InspectorRemoteObject | undefined>, context: CompletionContext): CompletionItem[] {
		return Array.from(properties.entries())
			.filter(([label]) => context.prefix.length === 0 || label.startsWith(context.prefix))
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([label, value]) => {
				const type = variableType(value);
				return {
					label,
					...(type ? { type } : {}),
					start: context.start,
					length: context.length,
					sortText: label,
				};
			});
	}

	#loadedSources(): DapBody {
		const sources = Array.from(this.#scriptsByUrl.values()).flatMap((script) => [script.url, ...(script.sourceMap?.sources() ?? [])]);
		return {
			sources: sources.map((source) => sourceFromPath(source)).filter((source): source is DapSource => source !== undefined),
		};
	}

	#modules(args: DapBody): DapBody {
		const modules = Array.from(this.#scriptsById.values()).map((script) => {
			const source = sourceFromPath(script.url);
			const scriptPath = source?.path ?? script.url;
			return {
				id: script.scriptId,
				name: source?.name ?? script.url ?? `script ${script.scriptId}`,
				...(scriptPath ? { path: scriptPath } : {}),
				isUserCode: Boolean(script.url),
			};
		});
		const start = numberArg(args.startModule) ?? 0;
		const count = numberArg(args.moduleCount);
		return {
			modules: count === undefined ? modules.slice(start) : modules.slice(start, start + count),
			totalModules: modules.length,
		};
	}

	async #debuggerCommand(command: string): Promise<void> {
		await this.#requiredInspector().send(command);
	}

	#debuggerCommandNoWait(command: string): void {
		this.#requiredInspector().sendNoWait(command);
	}

	#requiredInspector(): InspectorConnection {
		if (!this.#inspector) throw new Error("Bun inspector is not connected");
		return this.#inspector;
	}

	#variableHandleFromRemoteObject(value: InspectorRemoteObject, frameId?: string, isScope = false): VariableHandle {
		return {
			objectId: value.objectId,
			type: value.type,
			subtype: value.subtype,
			size: value.size,
			frameId,
			isScope,
		};
	}

	#createVariableReference(handle: VariableHandle): number {
		const reference = this.#nextVariableReference++;
		this.#variableHandles.set(reference, handle);
		return reference;
	}

	#handleScriptParsed(params: unknown): void {
		if (!isRecord(params) || typeof params.scriptId !== "string") return;
		const scriptUrl = stringArg(params.url);
		const script: InspectorScript = {
			scriptId: params.scriptId,
			url: scriptUrl,
			sourceMap: parseBunSourceMap(stringArg(params.sourceMapURL), scriptUrl),
			startLine: numberArg(params.startLine),
			startColumn: numberArg(params.startColumn),
			endLine: numberArg(params.endLine),
			endColumn: numberArg(params.endColumn),
		};
		this.#scriptsById.set(script.scriptId, script);
		if (script.url) this.#scriptsByUrl.set(script.url, script);
		void this.#rebindBreakpointsForScript(script);
		void this.#rebindFunctionBreakpointsForLoadedScripts();
	}

	#handleBreakpointResolved(params: unknown): void {
		if (!isRecord(params) || typeof params.breakpointId !== "string" || !isRecord(params.location)) return;
		if (this.#placeholderBreakpointsByInspectorId.has(params.breakpointId)) return;
		const entry = this.#breakpointsByInspectorId.get(params.breakpointId);
		if (!entry) return;
		const location = params.location;
		if (typeof location.scriptId !== "string" || typeof location.lineNumber !== "number") return;
		entry.location = {
			scriptId: location.scriptId,
			lineNumber: location.lineNumber,
			columnNumber: numberArg(location.columnNumber),
		};
		entry.verified = true;
		const functionEntry = this.#functionBreakpoints.find((candidate) => candidate.entry === entry);
		if (functionEntry) this.#syncFunctionBreakpoint(functionEntry);
		this.#sendEvent("breakpoint", { reason: "changed", breakpoint: this.#toDapBreakpoint(entry) });
	}

	async #handlePaused(params: unknown): Promise<void> {
		if (!isRecord(params)) return;
		if (!this.#configurationDone && this.#suppressInitialPause) {
			this.#deferredInitialPause = params;
			return;
		}
		const frames = Array.isArray(params.callFrames)
			? params.callFrames.filter((frame): frame is InspectorCallFrame => isRecord(frame) && typeof frame.callFrameId === "string")
			: [];
		this.#frames = frames;
		const data = isRecord(params.data) ? params.data : undefined;
		const breakpointId = stringArg(data?.breakpointId);
		this.#lastStopBreakpointId = breakpointId;
		const placeholder = breakpointId ? this.#placeholderBreakpointsByInspectorId.get(breakpointId) : undefined;
		if (breakpointId && placeholder) {
			await this.#handlePendingSourceMapPlaceholderPause(breakpointId, placeholder, frames[0]);
			return;
		}
		const locationEntries = frames[0] ? this.#breakpointEntriesForLocation(frames[0].location) : [];
		const locationTemporaryHit = locationEntries.find((entry) => entry.inspectorId !== undefined && this.#temporaryBreakpointIds.has(entry.inspectorId));
		const hit = breakpointId
			? this.#breakpointsByInspectorId.get(breakpointId)
			: locationEntries.find((entry) => entry !== locationTemporaryHit && entry.inspectorId !== undefined);
		const temporaryStep = breakpointId ? this.#temporaryBreakpointIds.has(breakpointId) : locationTemporaryHit !== undefined;
		const stepHit = temporaryStep ? (breakpointId ? hit : locationTemporaryHit) : undefined;
		const pendingStep = this.#pendingStepLocationOverride;
		if (!temporaryStep && (await this.#continuePendingLoopSourceStep(frames[0]))) return;
		if (!temporaryStep) this.#pendingLoopSourceStep = undefined;
		if (hit && !temporaryStep && frames[0]) {
			this.#lastStepLocationOverride = {
				scriptId: frames[0].location.scriptId,
				lineNumber: frames[0].location.lineNumber,
				sourcePath: hit.sourceKey,
				line: hit.request.line,
				column: hit.request.column ?? 1,
			};
		}
		if (temporaryStep && frames[0]) {
			this.#lastStepLocationOverride = {
				scriptId: frames[0].location.scriptId,
				lineNumber: frames[0].location.lineNumber,
				sourcePath: stepHit?.sourceKey ?? pendingStep?.sourcePath ?? "",
				line: stepHit?.request.line ?? pendingStep?.line ?? frames[0].location.lineNumber + 1,
				column: stepHit?.request.column ?? pendingStep?.column ?? 1,
			};
		}
		this.#pendingStepLocationOverride = undefined;
		this.#pendingLoopSourceStep = undefined;
		if (this.#temporaryBreakpointIds.size > 0) await this.#clearTemporaryStepBreakpoints();
		if (this.#stepDisabledBreakpoints.length > 0) await this.#restoreStepDisabledBreakpoints();
		this.#sendEvent("stopped", {
			reason: temporaryStep ? "step" : stoppedReason(stringArg(params.reason)),
			threadId: THREAD_ID,
			allThreadsStopped: true,
			...(hit && !temporaryStep ? { hitBreakpointIds: [hit.dapId] } : {}),
		});
	}

	async #handlePendingSourceMapPlaceholderPause(breakpointId: string, entry: StoredBreakpoint, frame?: InspectorCallFrame): Promise<void> {
		const inspector = this.#inspector;
		const placeholderIds = new Set([breakpointId]);
		for (const [id, candidate] of this.#placeholderBreakpointsByInspectorId) {
			if (candidate === entry) placeholderIds.add(id);
		}
		for (const id of placeholderIds) {
			this.#placeholderBreakpointsByInspectorId.delete(id);
		}
		if (!inspector) return;
		for (const id of placeholderIds) {
			await inspector.send("Debugger.removeBreakpoint", { breakpointId: id }).catch(() => undefined);
		}
		const script = frame ? this.#scriptsById.get(frame.location.scriptId) : undefined;
		if (!entry.verified) {
			await this.#tryRebindBreakpoint(entry, script);
		}
		const mapsToRequestedLine =
			frame !== undefined && script !== undefined && this.#locationMapsToSourceLine(script, frame.location, entry.sourceKey, entry.request.line);
		if (mapsToRequestedLine && !entry.request.condition && !entry.request.hitCondition) {
			this.#lastStepLocationOverride = {
				scriptId: frame.location.scriptId,
				lineNumber: frame.location.lineNumber,
				sourcePath: entry.sourceKey,
				line: entry.request.line,
				column: entry.request.column ?? 1,
			};
			this.#sendEvent("stopped", {
				reason: "breakpoint",
				threadId: THREAD_ID,
				allThreadsStopped: true,
				hitBreakpointIds: [entry.dapId],
			});
			return;
		}
		await inspector.send("Debugger.resume").catch(() => undefined);
	}

	#handleConsole(params: unknown): void {
		if (!isRecord(params) || !Array.isArray(params.args)) return;
		const output = params.args.map((entry) => remoteObjectToString(isRecord(entry) ? entry : undefined)).join(" ");
		if (output.length > 0) this.#sendEvent("output", { category: "console", output: `${output}\n` });
	}

	#pumpOutput(stream: ReadableStream<Uint8Array>, category: "stdout" | "stderr"): void {
		void (async () => {
			const decoder = new TextDecoder();
			for await (const chunk of stream) {
				const output = decoder.decode(chunk, { stream: true });
				if (output.length > 0) this.#sendEvent("output", { category, output });
			}
			const tail = decoder.decode();
			if (tail.length > 0) this.#sendEvent("output", { category, output: tail });
		})();
	}

	#sendTerminated(): void {
		if (this.#terminatedSent) return;
		this.#terminatedSent = true;
		this.#sendEvent("terminated", {});
	}
}

export async function runBunDapAdapter(): Promise<void> {
	await new BunDebugAdapter().run();
}
