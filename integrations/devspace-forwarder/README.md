# DevSpace forwarder

DevSpace tool completion events flow through a local JSONL spool to `/agentmemory/observe`. Agent Memory owns compression, indexing and session summaries. This forwarder has no LLM client or additional database.

## Build

Use the existing Node.js (22.19 or newer) and npm. The integration sources, guide and service templates are included under `integrations/devspace-forwarder/` in the server package and repository; build this standalone bundle separately:

```sh
cd integrations/devspace-forwarder
npm install --ignore-scripts --no-audit --no-fund
npm run build
npm test
```

Deploy only `dist/forwarder.mjs`. The bundle uses only Node builtins at runtime.

## Deploy after server verification

Keep the example configuration disabled. First obtain authorization to deploy the Agent Memory server changes, preserve the reviewed deployment source, and verify duplicate UUIDs against that server. Only then enable this forwarder and DevSpace `events.enabled`.

Use `~/.config/agentmemory/devspace-forwarder.json`, mode `0600`, in a private directory. `config.example.json` defaults to `enabled: false`. Optional `tokenFile` points to a separate `0600` file containing the existing bearer token. Both must be regular files owned by the service user, without group/other access; symlinks are rejected. Credentials never belong in source control or service definitions.

The API defaults to `http://localhost:3111` and accepts only HTTP loopback origins. The three Macs reuse their existing SSH tunnels. Oracle connects directly. The forwarder never manages tunnel lifecycle.

Use the templates in `services/`. Replace `__NODE__` with the absolute output of `node -p process.execPath`, `__BUNDLE__` with the deployed bundle path, and `__CONFIG__` with the protected configuration path. For launchd also replace `__LOG__` with a local log path; XML-escape replacement strings. Use `~/Library/LaunchAgents/com.agentmemory.devspace-forwarder.plist` on each Mac and `~/.config/systemd/user/devspace-forwarder.service` on Oracle. Build does not install, bootstrap or enable services.

Run one forwarder per machine/state directory. After `401`/`403`, correct protected credentials and restart; the service pauses in place with its checkpoint preserved. Retry backoff starts at one second and caps at one minute; numeric `Retry-After` can extend it to five minutes. Alerts contain error classes/status codes, never request bodies or credentials.

## Delivery

The default spool is `~/.local/share/devspace/events/`. Reads include active segments, consume only newline-terminated records, and are snapshot-bounded. Records are limited to 16 KiB including the newline. Files are rechecked before idle closure.

The checkpoint is `~/.local/share/agentmemory/devspace-forwarder/checkpoint.json`. Random `segment_id` values are saved before delivery, including after a local persistence failure. Session IDs are `devspace:{machine_id}:{workspace_id}:{segment_id}`; identity components are percent-encoded so spaces/colons cannot change the component boundaries. The original UUID is sent as top-level `event_id`. Offsets advance only after acknowledgement or durable dead-letter quarantine. Checkpoint replacement syncs the file and its containing directory after atomic rename; initialization also syncs newly created directory entries. Filesystems that reject directory sync block delivery rather than weaken this barrier. State files are `0600`; their directory is `0700`.

Machine/workspace identities that need redaction use deterministic SHA-256 pseudonyms before session assignment; ordinary identifiers retain their original values. This matches the producer's identity filtering and avoids merging different secret-looking names. Neither request bodies nor checkpoints retain their plaintext.

Network errors, timeouts, `429` and `5xx` retry. Invalid JSON/schema/oversized lines and `400`/`404`/`413`/`422` observation rejections go to `dead-letter.jsonl`, allowing later events to proceed. Timestamps must be calendar-valid ISO UTC values ending in `Z`. Malformed raw input is never copied there; valid rejected events contain only sanitized whitelist fields. Acknowledgements must include the deterministic Observation ID for the submitted UUID; a UUID-unaware server pauses delivery without advancing the checkpoint. Unknown protocol failures also pause. Checkpoint entries for removed segments are pruned after a successful spool directory snapshot. Do not reset checkpoints to repair an incident.

Sessions with delivered observations end after 30 minutes without activity, once all valid complete events are acknowledged and rejected records quarantined. Incomplete tails or outstanding delivery failures defer closure. A later event starts a new segment. Outage backlogs also split at 30-minute event-time gaps: the preceding segment ends before the later event is sent, and a failed end keeps that later event uncheckpointed for retry. The forwarder calls the unchanged `/session/end`; existing server processing creates summaries.

## Privacy and limitations

Both producer and consumer enforce the six-tool whitelist. Other tools keep only the envelope and outcome. Bash retains recognized command names and selected subcommands without arguments; output keeps only short status/count lines. Other output becomes `[output omitted]`. Source, attachments and whole tool payloads are excluded. Filters redact known credential formats, assignments, auth headers, private keys and URL credentials. Secrets disguised as ordinary filenames cannot be reliably identified by pattern matching.

Spool retention (seven days or 1 GiB) can remove events during prolonged outages. A truncated non-newline tail stays unread and defers idle closure until completed or removed by retention. Dead-letter records need operator inspection. Concurrent independent forwarders do not coordinate checkpoints; run one instance per state directory.

UUID deduplication uses the existing observation row under its existing lock. A crash after that row is written, before compression/indexing/session side effects finish, can leave those effects incomplete. Retries return `deduplicated: true` and do not repair them. There is no persistent per-effect state machine. Forgetting or retention can remove the dedup record.

The pinned iii 0.22.1 file adapter also has an existing acknowledgement-to-disk window: `state::set` updates memory, and a save loop persists every five seconds by default. Engine/host crashes before that flush can lose acknowledged data. This change preserves the storage contract. See the pinned [KV implementation](https://github.com/iii-hq/iii/blob/iii%2Fv0.22.1/engine/src/builtins/kv.rs). The integration test checks disk contents before engine restart and separately tests immediate worker restart.

If `/session/end` succeeds but its response/checkpoint is lost, it may be called again. Existing summary fingerprint deduplication limits repeated summary work; other side effects remain unchanged.

## Isolated acceptance test

From the repository root, after building the forwarder:

```sh
AGENTMEMORY_TEST_III=/absolute/path/to/iii node node_modules/vitest/vitest.mjs run test/devspace-isolated.integration.test.ts
```

This uses the real pinned engine, temporary state, REST handlers, the bundle and a deterministic local summary provider. It does not contact production or a paid LLM. Production Oracle restart/provider summaries, Mac launchd and SSH tunnels remain deployment acceptance items.
