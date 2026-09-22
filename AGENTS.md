# agentmemory — Agent Instructions

## Architecture

agentmemory is a persistent memory system for AI coding agents, built on iii-engine's three primitives (Worker/Function/Trigger). Everything goes through `registerFunction`/`registerTrigger`/`sdk.trigger()` — never bypass iii-engine with standalone SQLite or in-process alternatives.

- **Engine**: iii-sdk (WebSocket to iii-engine on port 49134)
- **State**: iii-engine StateWorker KV; `file_based` uses a directory at `./data/state_store.db/` with asynchronous snapshot writes, not a SQLite file.
- **Build**: TypeScript → ESM via tsdown, output to `dist/`
- **Test**: vitest (`npm test` excludes integration tests)

## Consistency Rules

**When adding or removing MCP tools, you MUST update ALL of the following:**
1. `src/mcp/tools-registry.ts` — tool definition + `getAllTools()` array
2. `src/mcp/server.ts` — handler case in the `mcp::tools::call` switch
3. `src/triggers/api.ts` — REST endpoint registration
4. `src/index.ts` — function registration + endpoint count in the log line
5. `test/mcp-standalone.test.ts` — tool count assertion
6. `README.md` — tool counts (search for "MCP tools")
7. `plugin/.claude-plugin/plugin.json` — tool count in description
8. `plugin/plugin.json` and `plugin/.mcp.copilot.json` (when present) — tool count or MCP exposure

**When adding REST endpoints, you MUST update:**
1. `src/triggers/api.ts` — endpoint registration
2. `src/index.ts` — endpoint count in the log line
3. `README.md` — endpoint count (search for "REST endpoints" and "endpoints on port")

**When bumping version, you MUST update ALL of the following:**
1. `package.json` — version field
2. `src/version.ts` — VERSION constant and type union
3. `src/types.ts` — ExportData version union
4. `src/functions/export-import.ts` — supportedVersions set
5. `test/export-import.test.ts` — version assertion
6. `plugin/.claude-plugin/plugin.json` — version field
7. `plugin/plugin.json` (when present) — version field

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
sdk.registerFunction("api::your-endpoint", async (req: ApiRequest) => {
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
- **Selective authentication**: The global API secret takes precedence over `AGENTMEMORY_SELECTIVE_CONTEXT_SECRET`. With only the latter configured, legacy telemetry remains unchanged but explicit-save observations and both selective endpoints require its bearer token. Client prompt hooks may opt in through private `~/.config/agentmemory/selective-context.json`.
- **Shared recall ownership**: With private config `owner: "agent-hooks"`, native adapters use `selective-client.mjs --stdin`; standalone prompt hooks retain telemetry but do not inject. `AGENTMEMORY_SHARED_CLIENT=1` is internal routing, not authorization. The shared client skips ordinary observation writes, but explicit saves still require authenticated, source-backed capture. Do not enable both native shared recall and separate extension recall.
- **Telemetry-only hooks** (`notification`, `post-tool-failure`, `prompt-submit` by default, `stop`, `session-end`, `subagent-start`, `subagent-stop`, `task-completed`) write nothing to stdout. These use fire-and-forget `fetch(..., { signal: AbortSignal.timeout(N) }).catch(() => {})` paired with an unref'd `setTimeout(() => process.exit(0), timeout)`. Use 1500ms whenever losing the request matters and the path may be slow: `prompt-submit`, `stop`, and `session-end` all qualify, because a remote `AGENTMEMORY_URL` can take more than 500ms to acknowledge. **Request count is not the criterion — delivery-path latency is.** A hook that sends one request to a slow host drops it just as readily as one that sends three; 500ms is only safe for hooks whose loss is inconsequential (`notification`, `post-tool-failure`, `subagent-start`, `subagent-stop`, `task-completed`). **`post-tool-use` is the delivery-guaranteed exception:** it MUST await its single observation request with the existing 3-second abort bound because exiting after a short timer can drop tool observations on higher-latency relays.

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

- All tests must pass before PR: `npm test` (1,596+ tests)
- Mock pattern: `vi.mock("iii-sdk")` with mock `sdk.trigger`, `kv.get/set/list`
- Test files go in `test/` with `.test.ts` extension
- Follow existing patterns in `test/crystallize.test.ts` for function tests

## Current Stats (v0.9.29)

- 54 MCP tools (8 visible by default, `AGENTMEMORY_TOOLS=all` for all)
- 132 REST endpoints
- 6 MCP resources, 3 MCP prompts
- 12 hooks, 17 skills
- 260+ iii functions
- 1,596+ tests
