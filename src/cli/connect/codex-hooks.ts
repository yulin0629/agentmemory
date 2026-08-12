import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Shared merge engine for writing agentmemory's bundled hook scripts into
 * a host's global, user-scope hooks config. Originally built as a
 * workaround for openai/codex#16430 — Codex Desktop does not dispatch
 * plugin-local `hooks.json` even though both `CodexHooks` and `PluginHooks`
 * feature flags are stable + default-enabled in
 * `codex-rs/features/src/lib.rs`. Until upstream fixes plugin-scope
 * dispatch, the same hook commands can be mirrored into the global
 * `~/.codex/hooks.json`, which is loaded reliably.
 *
 * The same merge logic now also backs Claude Code's `--with-hooks`
 * fallback (`~/.claude/settings.json`, #508 workaround) and Droid's
 * native `~/.factory/hooks.json` install, since both hosts consume the
 * identical `{ hooks: { <event>: [{ matcher?, hooks: [{ type, command }] }] } }`
 * shape — only the bundled manifest file passed to `buildMergedHooks`
 * differs per host.
 *
 * This module builds that merge, with `${CLAUDE_PLUGIN_ROOT}` resolved to
 * the bundled `plugin/` directory so the user-scope file does not depend
 * on env-var expansion (only Claude Code actually injects
 * `CLAUDE_PLUGIN_ROOT` for plugin-scope hooks — the token is reused here
 * purely as an internal placeholder for "the bundled plugin/ dir").
 *
 * Identification on re-install: every command we write contains the
 * resolved `<pluginRoot>/scripts/` prefix, so subsequent installs can
 * strip our entries and re-add cleanly without touching the user's other
 * hook entries.
 */

type HookHandler = { type: string; command?: string; [key: string]: unknown };
type HookEntry = { matcher?: string; hooks: HookHandler[]; [key: string]: unknown };
export type HookManifest = { hooks: Record<string, HookEntry[]> };

// Keep removed scripts here so stale installations remain identifiable.
const KNOWN_AGENTMEMORY_HOOK_SCRIPT_NAMES = new Set([
  "notification.mjs",
  "post-commit.mjs",
  "post-tool-failure.mjs",
  "post-tool-use.mjs",
  "pre-compact.mjs",
  "pre-tool-use.mjs",
  "prompt-submit.mjs",
  "session-end.mjs",
  "session-start.mjs",
  "stop.mjs",
  "subagent-start.mjs",
  "subagent-stop.mjs",
  "task-completed.mjs",
]);

/**
 * Locate the bundled `plugin/` directory at runtime. Walks up from the
 * module's own location looking for `plugin/scripts/` + `plugin/hooks/`,
 * both shipped via the npm `files` field. Works for both `dist/cli.mjs`
 * (bundled) and `src/cli/connect/codex-hooks.ts` (dev) layouts.
 */
export function findPluginRoot(startUrl: string = import.meta.url): string {
  const here = dirname(fileURLToPath(startUrl));
  let dir = here;
  for (let i = 0; i < 12; i++) {
    if (
      existsSync(join(dir, "plugin", "scripts")) &&
      existsSync(join(dir, "plugin", "hooks"))
    ) {
      return resolve(join(dir, "plugin"));
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `agentmemory: could not locate bundled plugin/ directory (searched up from ${here})`,
  );
}

/**
 * Build the merged hooks.json content.
 *
 *   1. Strip AgentMemory command handlers from `existing`. This lets us
 *      re-install idempotently without leaving stale references while
 *      preserving command-less Claude Code prompt and agent handlers.
 *   2. Append fresh entries from the bundled Codex manifest with
 *      `${CLAUDE_PLUGIN_ROOT}` rewritten to the absolute plugin path.
 *      Matcher values from the bundled manifest are preserved so PreToolUse
 *      event routing keeps working.
 */
export function buildMergedHooks(
  existing: HookManifest | null,
  pluginRoot: string,
  manifestFile = "hooks.codex.json",
): HookManifest {
  const bundledManifestPath = join(pluginRoot, "hooks", manifestFile);
  const ours = JSON.parse(readFileSync(bundledManifestPath, "utf-8")) as HookManifest;
  const scriptsDir = join(pluginRoot, "scripts");

  const out: HookManifest = { hooks: {} };

  if (existing?.hooks) {
    for (const [event, entries] of Object.entries(existing.hooks)) {
      const kept = entries.flatMap((entry) => {
        const hooks = entry.hooks.filter(
          (handler) => !isAgentmemoryHandler(handler, scriptsDir),
        );
        return hooks.length > 0 ? [{ ...entry, hooks }] : [];
      });
      if (kept.length > 0) out.hooks[event] = kept;
    }
  }

  for (const [event, entries] of Object.entries(ours.hooks)) {
    const resolvedEntries: HookEntry[] = entries.map((entry) => {
      const next: HookEntry = {
        hooks: entry.hooks.map((handler) =>
          typeof handler.command === "string"
            ? {
                ...handler,
                command: handler.command.replace(
                  /\$\{CLAUDE_PLUGIN_ROOT\}/g,
                  pluginRoot,
                ),
              }
            : { ...handler },
        ),
      };
      if (entry.matcher !== undefined) next.matcher = entry.matcher;
      return next;
    });
    out.hooks[event] = [...(out.hooks[event] ?? []), ...resolvedEntries];
  }

  return out;
}

function isAgentmemoryHandler(handler: HookHandler, scriptsDir: string): boolean {
  if (typeof handler.command !== "string") return false;
  const normalizedScriptsDir = normalizePathForCommandMatch(scriptsDir);
  const command = normalizePathForCommandMatch(handler.command);
  if (command.includes(normalizedScriptsDir)) return true;
  return [...KNOWN_AGENTMEMORY_HOOK_SCRIPT_NAMES].some(
    (script) =>
      command.includes(`/@agentmemory/agentmemory/plugin/scripts/${script}`) ||
      command.includes(`/agentmemory/plugin/scripts/${script}`),
  );
}

function normalizePathForCommandMatch(value: string): string {
  return value.replace(/\\/g, "/");
}
