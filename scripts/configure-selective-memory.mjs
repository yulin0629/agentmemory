import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, chmodSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
if (!["client", "server", "disable"].includes(mode)) {
  throw new Error("Usage: node scripts/configure-selective-memory.mjs client|server|disable [url]; secret is read from stdin");
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = join(homedir(), ".config/agentmemory/selective-context.json");
let input = "";
if (mode !== "disable") for await (const chunk of process.stdin) input += chunk;
const secret = input.trim();
if (mode !== "disable" && !/^[a-f0-9]{64}$/.test(secret)) throw new Error("Expected a 32-byte hex selective secret on stdin");
if (mode === "server") {
  const envPath = join(homedir(), ".agentmemory/.env");
  const key = readFileSync(join(homedir(), ".config/typesafe/api_key"), "utf8").trim();
  if (!key || /[\r\n]/.test(key)) throw new Error("Missing or malformed TypeSafe key");
  const env = readFileSync(envPath, "utf8");
  const updates = { AGENTMEMORY_SELECTIVE_CONTEXT: "true", AGENTMEMORY_CONTEXT_NAMESPACE: "personal",
    AGENTMEMORY_SELECTIVE_CONTEXT_SECRET: secret, TYPESAFE_API_KEY: key };
  copyFileSync(envPath, `${envPath}.before-selective-${Date.now()}`);
  const kept = env.split(/\r?\n/).filter(line => !Object.keys(updates).some(name => new RegExp(`^(?:export\\s+)?${name}\\s*=`).test(line)));
  writeFileSync(envPath, `${kept.join("\n").trimEnd()}\n${Object.entries(updates).map(([k, v]) => `${k}=${v}`).join("\n")}\n`, { mode: 0o600 });
  chmodSync(envPath, 0o600);
  console.log("Server selective settings written; existing global authentication unchanged. Restart required.");
} else {
  let previous = {};
  if (existsSync(configPath)) previous = JSON.parse(readFileSync(configPath, "utf8"));
  const clientScript = join(root, "plugin/scripts/selective-client.mjs");
  if (!existsSync(clientScript)) throw new Error("Build the selective client first");
  const url = process.argv[3] || previous.url || (process.platform === "win32"
    ? "https://m4-local-relay.yulin0629.workers.dev" : "http://localhost:3111");
  new URL(url);
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  if (existsSync(configPath)) copyFileSync(configPath, `${configPath}.before-${Date.now()}`);
  writeFileSync(configPath, JSON.stringify({ ...previous, enabled: mode === "client", owner: "agent-hooks",
    url, node: process.execPath, clientScript, ...(secret ? { selectiveSecret: secret } : {}) }, null, 2) + "\n", { mode: 0o600 });
  chmodSync(configPath, 0o600);
  if (mode === "client") {
    const registrations = [".claude/settings.json", ".cursor/hooks.json", ".gemini/config/hooks.json", ".grok/hooks/agentmemory.json",
      ...readdirSync(homedir()).filter(name => name.startsWith(".codex")).map(name => `${name}/hooks.json`)];
    const rewrite = value => {
      if (typeof value === "string") return value.replace(/(?:[A-Za-z]:)?[^\s\"'|]*[\\/]agentmemory[\\/]plugin[\\/]scripts[\\/]/g,
        join(root, "plugin/scripts/").replaceAll("\\", "/"));
      if (Array.isArray(value)) return value.map(rewrite);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, rewrite(val)]));
      return value;
    };
    for (const relative of registrations) {
      const file = join(homedir(), relative);
      if (!existsSync(file)) continue;
      const before = JSON.parse(readFileSync(file, "utf8"));
      const after = rewrite(before);
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      // Codex trust binds command definitions. Keep existing commands untouched;
      // its shared adapter already reads clientScript from the private config.
      if (relative.startsWith(".codex")) continue;
      copyFileSync(file, `${file}.before-selective-${Date.now()}`);
      writeFileSync(file, JSON.stringify(after, null, 2) + "\n");
      console.log(`Updated memory script paths only: ${relative}`);
    }
  }
  console.log(JSON.stringify({ configured: true, enabled: mode === "client", owner: "agent-hooks", url, clientScript }));
}
