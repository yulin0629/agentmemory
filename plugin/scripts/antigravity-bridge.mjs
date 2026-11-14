#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform } from "node:os";
//#region src/cli-data-dir.ts
function argValue(args, name) {
	const equals = `${name}=`;
	const inline = args.find((arg) => arg.startsWith(equals));
	if (inline) return inline.slice(equals.length);
	const idx = args.indexOf(name);
	if (idx !== -1) return args[idx + 1];
}
function expandHome(pathValue, home) {
	if (pathValue === "~") return home;
	if (pathValue.startsWith("~/") || pathValue.startsWith("~\\")) return join(home, pathValue.slice(2));
	return pathValue;
}
function absoluteDataDir(pathValue, cwd, home) {
	const expanded = expandHome(pathValue, home);
	return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}
function platformDefaultDataDir(env, home, nodePlatform, useXdg = true) {
	if (nodePlatform === "darwin") return join(home, "Library", "Application Support", "agentmemory");
	if (nodePlatform === "win32") {
		const appData = env["APPDATA"];
		return appData ? join(appData, "agentmemory") : join(home, ".agentmemory");
	}
	const xdgDataHome = env["XDG_DATA_HOME"];
	if (useXdg && xdgDataHome && isAbsolute(xdgDataHome)) return join(xdgDataHome, "agentmemory");
	return join(home, ".local", "share", "agentmemory");
}
function nearestGitParent(pathValue) {
	let current = pathValue;
	while (true) {
		if (existsSync(join(current, ".git"))) return current;
		const parent = dirname(current);
		if (parent === current) return void 0;
		current = parent;
	}
}
function isWithin(parent, child) {
	const pathFromParent = relative(parent, child);
	return pathFromParent === "" || pathFromParent !== ".." && !pathFromParent.startsWith(`..${sep}`) && !isAbsolute(pathFromParent);
}
function resolveDataDir(options = {}) {
	const args = options.args ?? process.argv.slice(2);
	const env = options.env ?? process.env;
	const cwd = options.cwd ?? process.cwd();
	const home = options.home ?? homedir();
	const nodePlatform = options.platform ?? platform();
	const parsedInstance = parseInt(argValue(args, "--instance") ?? "0", 10);
	const instance = parsedInstance > 0 && parsedInstance <= 50 ? parsedInstance : 0;
	const forInstance = (dataDir) => instance ? join(dataDir, `instance-${instance}`) : dataDir;
	const flagValue = argValue(args, "--data-dir");
	if (flagValue) return {
		dataDir: forInstance(absoluteDataDir(flagValue, cwd, home)),
		source: "flag"
	};
	const envValue = env["AGENTMEMORY_DATA_DIR"];
	if (envValue) return {
		dataDir: forInstance(absoluteDataDir(envValue, cwd, home)),
		source: "env"
	};
	const legacyDir = resolve(cwd, "data");
	const hasLegacyStore = existsSync(join(legacyDir, "state_store.db")) || existsSync(join(legacyDir, "iii-config.yaml"));
	if (instance === 0 && hasLegacyStore) return {
		dataDir: legacyDir,
		source: "default"
	};
	const defaultDir = platformDefaultDataDir(env, home, nodePlatform);
	const gitParent = nearestGitParent(cwd);
	if (gitParent && isWithin(gitParent, defaultDir)) {
		const relocated = platformDefaultDataDir(env, home, nodePlatform, false);
		if (relocated !== defaultDir) return {
			dataDir: forInstance(relocated),
			source: "default",
			relocatedFrom: defaultDir
		};
	}
	return {
		dataDir: forInstance(defaultDir),
		source: "default"
	};
}
//#endregion
//#region src/hooks/antigravity-bridge.ts
const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
let promptStepKey;
const TOOL_NAME_MAP = {
	view_file: "read",
	view_line_range: "read",
	view_code_item: "read",
	read_file: "read",
	read_url_content: "read",
	edit_file: "edit",
	replace_file_content: "edit",
	propose_code: "edit",
	write_to_file: "write",
	create_file: "write",
	grep_search: "grep",
	codebase_search: "grep",
	find_by_name: "glob",
	list_dir: "glob"
};
const ARG_KEY_MAP = {
	AbsolutePath: "file_path",
	TargetFile: "file_path",
	DirectoryPath: "path",
	SearchDirectory: "path",
	Pattern: "pattern",
	Query: "pattern",
	CommandLine: "command"
};
function asObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function firstString(...values) {
	for (const v of values) if (typeof v === "string" && v.length > 0) return v;
}
function normalizeToolArgs(args) {
	if (!args) return {};
	const out = { ...args };
	for (const [from, to] of Object.entries(ARG_KEY_MAP)) if (out[to] === void 0 && args[from] !== void 0) out[to] = args[from];
	return out;
}
function normalizePayload(event, raw) {
	const toolCall = asObject(raw["toolCall"]);
	const workspacePaths = Array.isArray(raw["workspacePaths"]) ? raw["workspacePaths"] : [];
	const sessionId = firstString(raw["conversationId"], raw["session_id"], raw["sessionId"]) ?? "unknown";
	const cwd = firstString(raw["cwd"], workspacePaths[0]) ?? process.cwd();
	const out = {
		...raw,
		session_id: sessionId,
		cwd,
		hook_event_name: event
	};
	const transcriptPath = firstString(raw["transcript_path"], raw["transcriptPath"]);
	if (transcriptPath) out["transcript_path"] = transcriptPath;
	if (event === "PreInvocation" && transcriptPath && sessionId !== "unknown" && resolve(transcriptPath).split(/[/\\]/).includes(sessionId)) {
		let fd;
		try {
			fd = openSync(transcriptPath, "r");
			const size = fstatSync(fd).size;
			const buffer = Buffer.alloc(Math.min(size, 65536));
			const base = size - buffer.length;
			readSync(fd, buffer, 0, buffer.length, base);
			let end = buffer.length;
			while (end > 0) {
				const newline = buffer.lastIndexOf(10, end - 1);
				if (newline < 0 && base > 0) break;
				const line = buffer.toString("utf8", newline + 1, end);
				end = Math.max(newline, 0);
				if (!line.trim()) continue;
				const step = JSON.parse(line);
				if (step.type === "USER_INPUT" && step.source === "USER_EXPLICIT" && typeof step.content === "string") {
					const match = step.content.match(/<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>/);
					out["prompt"] = (match ? match[1] : step.content).trim();
					promptStepKey = `${sessionId}:${base + newline + 1}`;
					break;
				}
			}
		} catch {} finally {
			if (fd !== void 0) closeSync(fd);
		}
	}
	if (toolCall) {
		const args = normalizeToolArgs(asObject(toolCall["args"]) ?? asObject(toolCall["toolArgs"]));
		const rawName = firstString(toolCall["name"], toolCall["toolName"], args["ToolName"], args["toolName"]);
		if (rawName) {
			out["tool_name"] = TOOL_NAME_MAP[rawName] ?? rawName;
			out["native_tool_name"] = rawName;
		}
		out["tool_input"] = args;
		if (out["tool_use_id"] === void 0 && Number.isInteger(raw["stepIdx"]) && raw["stepIdx"] >= 0) out["tool_use_id"] = `step:${raw["stepIdx"]}`;
		const result = toolCall["result"] ?? raw["toolResult"] ?? raw["result"] ?? firstString(raw["error"]);
		if (result !== void 0) out["tool_result"] = result;
	}
	return out;
}
function targetsFor(event, raw) {
	switch (event) {
		case "PreInvocation": {
			const n = raw["invocationNum"];
			return typeof n !== "number" || n === 0 ? ["session-start.mjs"] : [];
		}
		case "PreToolUse": return ["pre-tool-use.mjs"];
		case "PostToolUse": return ["post-tool-use.mjs"];
		case "Stop": return raw["fullyIdle"] === false ? [] : ["session-end.mjs"];
		default: return [];
	}
}
function responseFor(event, context = "") {
	if (event === "PreInvocation" && context) return JSON.stringify({ injectSteps: [{ ephemeralMessage: context }] });
	return event === "PreToolUse" ? "{\"decision\":\"allow\"}" : "{}";
}
async function main() {
	const event = process.argv[2];
	if (!event) return;
	let input = "";
	for await (const chunk of process.stdin) input += chunk;
	let raw;
	try {
		raw = JSON.parse(input);
	} catch {
		return;
	}
	if (!raw || typeof raw !== "object") return;
	const normalized = normalizePayload(event, raw);
	const payload = JSON.stringify(normalized);
	let context = "";
	const targets = targetsFor(event, raw);
	const turnMarker = promptStepKey ? join(resolveDataDir({
		args: [],
		env: process.env
	}).dataDir, "antigravity-turns", createHash("sha256").update(String(normalized["session_id"])).digest("hex").slice(0, 32)) : "";
	if (event === "PreInvocation" && typeof normalized["prompt"] === "string" && normalized["prompt"].trim() && turnMarker && readMarker(turnMarker) !== promptStepKey) targets.push("prompt-submit.mjs");
	for (const script of targets) {
		const child = spawnSync(process.execPath, [join(SCRIPTS_DIR, script)], {
			input: payload,
			encoding: "utf8",
			timeout: 6500,
			stdio: [
				"pipe",
				"pipe",
				"ignore"
			],
			...script === "prompt-submit.mjs" ? { env: {
				...process.env,
				AGENTMEMORY_PROMPT_CAPTURE_ONLY: "1"
			} } : {}
		});
		if (event === "PreInvocation" && script === "session-start.mjs" && child.status === 0) context = child.stdout?.trim() ?? "";
		if (script === "prompt-submit.mjs" && child.status === 0) writeMarker(turnMarker, promptStepKey);
	}
	return context;
}
function readMarker(path) {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}
function writeMarker(path, value) {
	try {
		mkdirSync(dirname(path), {
			recursive: true,
			mode: 448
		});
		const staging = `${path}.${process.pid}.tmp`;
		writeFileSync(staging, value, { mode: 384 });
		renameSync(staging, path);
	} catch {}
}
if (process.argv[1] !== void 0 && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => void 0).then((context) => {
	process.stdout.write(responseFor(process.argv[2] ?? "", context));
	process.exit(0);
});
//#endregion
export { normalizePayload, responseFor, targetsFor };

//# sourceMappingURL=antigravity-bridge.mjs.map