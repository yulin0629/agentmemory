# agentmemory — Agent Instructions

## Architecture

agentmemory is a persistent memory system for AI coding agents, built on iii-engine's three primitives (Worker/Function/Trigger). Everything goes through `registerFunction`/`registerTrigger`/`sdk.trigger()` — never bypass iii-engine with standalone SQLite or in-process alternatives.

- **Engine**: iii-sdk 0.25.1 with @iii-dev/helpers 0.25.1 (Worker Compose-managed iii-engine 0.25.1 on port 49134; the client type is `IIIClient`, HTTP requests are `HttpRequest` from `@iii-dev/helpers/http`)
- **State**: iii-engine StateWorker KV; `file_based` uses a directory at `./data/state_store.db/` with asynchronous snapshot writes, not a SQLite file.
- **Build**: TypeScript → ESM via tsdown, output to `dist/`
- **Test**: vitest (`npm test` excludes integration tests)

## Consistency Rules

**Before every commit, run `npm run docs:sync` and commit what it changes.** It computes MCP tool counts (all, core, local fallback), REST endpoints, skills, hooks, tests, iii functions, source files, lines of code and KV scopes from the source, and rewrites them in README.md, the translated READMEs, AGENTS.md, INSTALL_FOR_AGENTS.md, plugin manifests, integration READMEs, the stat badges and the `src/index.ts` banner. The last synced values live in `scripts/docs-sync.state.json`; commit that file with the rest. `npm run docs:check` exits non-zero when anything is out of date. When the sync prints `check <fact> <old> left in <file>`, open that line: either fix it by hand or add its noun to the fact in `scripts/docs-sync.ts` so the next sync catches it. Never hand-edit these numbers or versions in the docs; change the source and sync.

**When adding or removing MCP tools, update:**
1. `src/mcp/tools-registry.ts` — tool definition + `getAllTools()` array
2. `src/mcp/server.ts` — handler case in the `mcp::tools::call` switch
3. `src/triggers/api.ts` — REST endpoint registration
4. `src/index.ts` — function registration
5. `test/mcp-standalone.test.ts` — tool count assertion

**When adding REST endpoints, update:**
1. `src/triggers/api.ts` — endpoint registration

**When bumping version, change only `package.json`.** `npm run docs:sync` carries the new version into `src/version.ts`, the `src/types.ts` ExportData union, the `supportedVersions` set in `src/functions/export-import.ts`, every plugin and package manifest that shared the old version, the deploy templates, the AGENTS.md stats heading, and CHANGELOG.md (the Unreleased section becomes the new version with today's date, plus its compare link).

**When adding new KV scopes:**
1. `src/state/schema.ts` — add to the KV object
2. `src/types.ts` — add the corresponding interface

**When adding new audit operations:**
1. `src/types.ts` — add to AuditEntry.operation union type

## Code Patterns

### Function Registration
```typescript
sdk.registerFunction(
  "mem::your-function",
  async (data: { ... }) => {
    // validate inputs
    // do work via kv.get/kv.set/kv.list
    // record audit via recordAudit()
    return { success: true, ... };
  },
);
```

### REST Endpoint Registration
```typescript
import type { HttpRequest } from "@iii-dev/helpers/http";

sdk.registerFunction("api::your-endpoint", async (req: HttpRequest) => {
  const denied = checkAuth(req, secret);
  if (denied) return denied;
  const body = req.body as Record<string, unknown>;
  // validate + whitelist fields (never pass raw body to sdk.trigger)
  const result = await sdk.trigger({
    function_id: "mem::your-function",
    payload: { ... },
  });
  return { status_code: 200, body: result };
});
sdk.registerTrigger({
  type: "http",
  function_id: "api::your-endpoint",
  config: { api_path: "/agentmemory/your-path", http_method: "POST" },
});
```

### MCP Tool Handler
```typescript
case "memory_your_tool": {
  // validate args with typeof checks
  // parse CSV args: args.field.split(",").map(t => t.trim()).filter(Boolean)
  const result = await sdk.trigger({
    function_id: "mem::your-function",
    payload: { ... },
  });
  return { status_code: 200, body: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } };
}
```

### Hook Scripts
Hook scripts in `src/hooks/` are standalone Node.js scripts (no iii-sdk import). They read JSON from stdin, make HTTP calls to the REST API, and exit. There are two patterns depending on whether Claude Code consumes the script's stdout:

- **Context-injecting hooks** (`pre-tool-use`, `pre-compact`, `session-start`) write recalled context to stdout for Claude Code to inject. `prompt-submit` joins this group only when `AGENTMEMORY_SELECTIVE_CONTEXT_INJECT=true`; it must await the bounded selective-context response and otherwise remain silent. These paths MUST use `try/catch` with `await fetch(..., { signal: AbortSignal.timeout(N) })` — the timeout is the only bound on hang time.
- **Explicit saves/replacements**: An opted-in `prompt-submit` beginning with `記住：`, `請記住：`, or the three-line `確認取代：` form awaits `/observe` for at most 5 seconds and emits only its capture acknowledgement. Replacement syntax and limits are in README's Explicit project memory section. `mem::context-knowledge-capture` must read the stored user event before compression. Internal iii invocations include `_caller_worker_id`; allow that metadata only in internal schemas, never loosen the public HTTP schemas.
- **Selective project scope**: `_project.ts` keeps the legacy display label separate from `resolveContextProjectId`. New scoped recall requires identity equality, never basename equality. Backup validation/restoration is shared by export/import and Git snapshots in `state/context-knowledge-backup.ts`; keep record links and namespace revision invalidation intact.
- **Selective authentication**: The global API secret takes precedence over `AGENTMEMORY_SELECTIVE_CONTEXT_SECRET`. The server generates a global secret unless `AGENTMEMORY_AUTH=none` (fork switch in `secret-store.ts`, ignored when `AGENTMEMORY_SECRET` is set), so the selective-secret-only mode exists only under that switch. In that mode legacy telemetry remains unchanged but explicit-save observations and both selective endpoints require its bearer token or `X-AgentMemory-Selective-Secret` (separate from relay authentication). Client prompt hooks may opt in through private `~/.config/agentmemory/selective-context.json`.
- **Shared recall ownership**: With private config `owner: "agent-hooks"`, native adapters use `selective-client.mjs --stdin`; standalone prompt hooks retain telemetry but do not inject. `AGENTMEMORY_SHARED_CLIENT=1` is internal routing, not authorization. The shared client skips ordinary observation writes, but explicit saves still require authenticated, source-backed capture. Do not enable both native shared recall and separate extension recall.
- **Historical lessons**: `lessonId` links adoption evidence to an existing lesson without another mutable lesson copy. Filter approved IDs before BM25 top-k, verify exact text/project against KV, then recheck source versions and catalog revision after Jev. Missing provenance never implies global adoption. Shared ownership also suppresses broad startup/tool/precompact injection.
- **Telemetry-only hooks** (`notification`, `post-tool-failure`, `post-tool-use`, `prompt-submit` by default, `stop`, `session-end`, `subagent-start`, `subagent-stop`, `task-completed`) write nothing to stdout. A hook that posts an observation sends it with `captureObservation(...)` from `_capture.ts`, which spools the event on disk when the server does not acknowledge it, and pairs it with an unref'd `setTimeout(() => process.exit(0), EXIT_CAP_MS)`. `EXIT_CAP_MS` MUST exceed `OBSERVE_TIMEOUT_MS` so the request or the spool write can finish; `test/hook-exit-timing.test.ts` enforces this. `prompt-submit` uses the shared capture module only when its selective settings resolve the same URL and secret as `_capture.ts`; a private config that points elsewhere keeps the direct request. `stop` and `session-end` keep a 1500ms exit timer for their remaining fire-and-forget requests.

## Coding Standards

- TypeScript, ESM only (`"type": "module"`)
- No code comments explaining WHAT — use clear naming instead
- Use `fingerprintId()` for content-addressable dedup, `generateId()` for unique IDs
- Parallel operations where possible (`Promise.all` for independent kv writes/reads)
- Input validation at system boundaries (MCP handlers, REST endpoints)
- REST endpoints must whitelist fields — never pass raw request body to `sdk.trigger()`
- Use `recordAudit()` for state-changing operations
- Timestamps: capture once with `new Date().toISOString()` and reuse

## Testing

- Before every commit run, in order: `npm run build`, `npm run skills:gen`, `npm run docs:sync`, `npm run skills:check`, `npm test` (4,700+ tests). Commit anything the generators changed. CI runs the same build, skills check and tests.
- Before any npm publish: `npm run release:gate` must pass. It installs the packed tarballs into a clean home and runs capture, recovery, restart, export/import, MCP and status checks against the installed CLI (see CONTRIBUTING.md, Release process)
- Mock pattern: `vi.mock("iii-sdk")` with mock `sdk.trigger`, `kv.get/set/list`
- Test files go in `test/` with `.test.ts` extension
- Follow existing patterns in `test/crystallize.test.ts` for function tests

## Current Stats (v0.9.33)

- 54 MCP tools visible by default; `AGENTMEMORY_TOOLS=core` selects 8 essentials
- 149 REST endpoints
- 6 MCP resources, 3 MCP prompts
- 12 hooks, 17 skills
- 322+ iii functions
- 4,700+ tests
