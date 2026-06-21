# bun-dap-x

Standalone Debug Adapter Protocol (DAP) server for debugging Bun programs through the Bun Inspector.

`bun-dap-x` speaks DAP over stdin/stdout. Configure your editor or DAP client to spawn the adapter, then use a normal DAP `launch` or `attach` request.

## Install

```sh
bun add -d bun-dap-x
```

Use the published binary from a DAP client with:

```sh
bunx bun-dap-x
```

From a source checkout:

```sh
bun install
bun run start
```

`bun run start` starts the adapter and waits for DAP messages on stdin; it is not an interactive debugger UI.

## Launch and attach basics

For `launch`, pass the Bun program in `program`:

```json
{
	"type": "bun-dap-x",
	"request": "launch",
	"name": "Debug Bun file",
	"program": "${file}",
	"cwd": "${workspaceFolder}",
	"runtime": "bun",
	"args": [],
	"runtimeArgs": [],
	"env": {},
	"stopOnEntry": false
}
```

Supported launch arguments:

- `program` (required): script to run with Bun.
- `cwd`: working directory for the debuggee. Defaults to the adapter process cwd.
- `runtime` or `runtimeExecutable`: Bun executable. Defaults to `bun`.
- `runtimeArgs`: arguments before `program`.
- `args`: arguments after `program`.
- `env`: environment overrides.
- `strictEnv`: when `true`, use only `env`; otherwise merge with the adapter environment.
- `stopOnEntry`: when `true`, keep Bun's initial inspector pause.

For `attach`, start Bun with the inspector enabled and attach to the WebSocket URL that Bun prints:

```sh
bun --inspect=127.0.0.1:6499 ./src/index.ts
```

```json
{
	"type": "bun-dap-x",
	"request": "attach",
	"name": "Attach to Bun inspector",
	"url": "ws://127.0.0.1:6499/<inspector-id>"
}
```

Attach also accepts `inspectorUrl`, or `host`, `port`, and `path` fields. The default host is `127.0.0.1`; the default port is `6499`.

## VS Code

VS Code launch configurations require a debug extension to register the `bun-dap-x` debug type. The extension manifest should contribute the type:

```json
{
	"contributes": {
		"debuggers": [
			{
				"type": "bun-dap-x",
				"label": "Bun DAP X"
			}
		]
	}
}
```

Then register the standalone adapter executable from the extension:

```ts
import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext) {
	context.subscriptions.push(
		vscode.debug.registerDebugAdapterDescriptorFactory("bun-dap-x", {
			createDebugAdapterDescriptor() {
				return new vscode.DebugAdapterExecutable("bunx", ["bun-dap-x"]);
			},
		}),
	);
}
```

After the debug type is registered, use a `.vscode/launch.json` configuration such as:

```json
{
	"version": "0.2.0",
	"configurations": [
		{
			"type": "bun-dap-x",
			"request": "launch",
			"name": "Bun: current file",
			"program": "${file}",
			"cwd": "${workspaceFolder}",
			"runtime": "bun"
		},
		{
			"type": "bun-dap-x",
			"request": "attach",
			"name": "Bun: attach",
			"url": "ws://127.0.0.1:6499/<inspector-id>"
		}
	]
}
```

For a local checkout of this repository, point the descriptor at the source entrypoint instead:

```ts
new vscode.DebugAdapterExecutable("bun", ["/absolute/path/to/bun-dap-x/src/cli.ts"]);
```

## Neovim / nvim-dap

```lua
local dap = require("dap")

dap.adapters["bun-dap-x"] = {
	type = "executable",
	command = "bunx",
	args = { "bun-dap-x" },
}

dap.configurations.javascript = {
	{
		type = "bun-dap-x",
		request = "launch",
		name = "Bun: current file",
		program = "${file}",
		cwd = "${workspaceFolder}",
		runtime = "bun",
		args = {},
		runtimeArgs = {},
		stopOnEntry = false,
	},
	{
		type = "bun-dap-x",
		request = "attach",
		name = "Bun: attach",
		url = "ws://127.0.0.1:6499/<inspector-id>",
	},
}

dap.configurations.typescript = dap.configurations.javascript
```

For a local checkout:

```lua
dap.adapters["bun-dap-x"] = {
	type = "executable",
	command = "bun",
	args = { "/absolute/path/to/bun-dap-x/src/cli.ts" },
}
```

## Supported features

- Launch Bun programs and attach to Bun Inspector WebSocket sessions.
- Source breakpoints, including pending breakpoints set before launch.
- Conditional breakpoints, hit-count breakpoints, and logpoints.
- Continue, pause, step over, step in, step out, terminate, and disconnect.
- Stack traces, scopes, variables, hover evaluation, and REPL evaluation.
- Debuggee stdout, stderr, and console output as DAP output events.
- Loaded sources and breakpoint-location queries.
- Best-effort Bun source-map support for TypeScript/TSX/MTS/CTS/JSX sources, imported files, and generated lines that do not map directly back to source.

## Limitations

- One debug target and one DAP thread are exposed per adapter process.
- Attach requires a Bun Inspector WebSocket URL, or explicit `host`/`port`/`path`; PID attach and inspector discovery are not implemented.
- The adapter does not provide a terminal for debuggee stdin; launched processes run with stdin ignored.
- Function, data, instruction, and exception breakpoints are not implemented.
- Restart, set-variable, completions, modules, memory, and disassembly requests are not implemented.
- Source-map and source-level stepping behavior is best-effort and follows Bun Inspector output.

## Development

```sh
bun install
bun run start
bun run test
bun run typecheck
bun run check
bun run format
```

Additional maintenance scripts:

```sh
bun run knip
bun run jscpd
```
