"""
agentmemory memory provider for Hermes Agent.

Drop this folder into ~/.hermes/plugins/agentmemory/
or install via: hermes plugin install agentmemory

Requires agentmemory server running: npx @agentmemory/agentmemory
"""

from __future__ import annotations

import json
import hashlib
import os
import re
import socket
import sys
import threading
import subprocess
import tempfile
from pathlib import PurePath


def _resolve_project(cwd: str) -> str:
    """Canonical project scope, matching the hooks' resolveProject order:
    AGENTMEMORY_PROJECT_NAME env override, git toplevel basename, cwd basename.
    Keeps Hermes sessions in the same project bucket as every other agent."""
    explicit = os.environ.get("AGENTMEMORY_PROJECT_NAME", "").strip()
    if explicit:
        return explicit
    try:
        top = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=5,
        ).stdout.strip()
        if top:
            return PurePath(top).name
    except Exception:
        pass
    return PurePath(cwd).name or cwd


def _resolve_project_id(cwd: str) -> str:
    def fingerprint(value: str) -> str:
        return "project:" + hashlib.sha256(value.encode()).hexdigest()

    explicit = os.environ.get("AGENTMEMORY_CONTEXT_PROJECT", "").strip()
    if explicit:
        return fingerprint(f"explicit:{explicit}")

    def git(*args: str) -> str:
        return subprocess.run(["git", *args], cwd=cwd, capture_output=True,
                              text=True, timeout=0.5, check=True).stdout.strip()

    try:
        remote = git("remote", "get-url", "origin")
        scp = None if re.match(r"^[A-Za-z]:[\\/]", remote) or "::" in remote else re.match(
            r"^(?:[^@/:]+@)?([^/:]+):(.+)$", remote)
        parsed = urlparse(remote if "://" in remote else
                          f"ssh://{scp.group(1)}/{scp.group(2)}" if scp else "file:///unshared")
        if parsed.scheme in ("https", "http", "ssh") and parsed.hostname:
            default_port = {"ssh": 22, "http": 80, "https": 443}[parsed.scheme]
            port = f":{parsed.port}" if parsed.port and parsed.port != default_port else ""
            path = parsed.path.rstrip("/")
            if path.endswith(".git"):
                path = path[:-4]
            return fingerprint(f"remote:{parsed.hostname.lower()}{port}{path}")
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    try:
        common = git("rev-parse", "--git-common-dir")
        path = os.path.realpath(os.path.join(cwd, common))
    except (OSError, subprocess.SubprocessError):
        path = os.path.realpath(cwd)
    return fingerprint(f"local:{socket.gethostname()}:{path}")
import time
from pathlib import Path
from contextlib import contextmanager
from typing import Any, Callable
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from urllib.error import URLError

if os.name == "nt":
    import msvcrt
else:
    import fcntl

try:
    from agent.memory_provider import MemoryProvider
except ImportError:
    from abc import ABC, abstractmethod

    class MemoryProvider(ABC):
        @property
        @abstractmethod
        def name(self) -> str: ...
        @abstractmethod
        def is_available(self) -> bool: ...
        @abstractmethod
        def initialize(self, session_id: str, **kwargs: Any) -> None: ...
        @abstractmethod
        def get_tool_schemas(self) -> list[dict]: ...
        @abstractmethod
        def handle_tool_call(self, name: str, args: dict) -> str: ...
        def get_config_schema(self) -> list[dict]: return []
        def save_config(self, values: dict, hermes_home: str) -> None: pass
        def system_prompt_block(self) -> str: return ""
        def prefetch(self, query: str, **kwargs: Any) -> str: return ""
        def queue_prefetch(self, query: str, **kwargs: Any) -> None: pass
        def sync_turn(self, user: str, assistant: str, **kwargs: Any) -> None: pass
        def on_session_end(self, messages: list, **kwargs: Any) -> None: pass
        def on_pre_compress(self, messages: list, **kwargs: Any) -> None: pass
        def on_memory_write(self, action: str, target: str, content: str, **kwargs: Any) -> None: pass
        def shutdown(self, **kwargs: Any) -> None: pass


DEFAULT_BASE_URL = "http://localhost:3111"
TIMEOUT = 5
PREFETCH_TIMEOUT = 7
PREFETCH_CONTEXT_LENGTH = 1600
LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}
_plaintext_bearer_warned = False

# agentmemory's documented runtime config lives at ~/.agentmemory/.env.
# When agentmemory is launched as a systemd user service (or any other
# process manager that loads that file directly), those values never
# reach an interactive shell. `hermes memory status` then reads
# os.environ in the Hermes CLI process, finds AGENTMEMORY_URL /
# AGENTMEMORY_SECRET unset, and reports the plugin as "Missing" even
# though the service is healthy and live sessions can use it (#250).
#
# Preload the file at plugin-import time using os.environ.setdefault so
# we never override anything the user explicitly set in the shell. The
# preload is best-effort and silent on any failure (file absent,
# unreadable, malformed) — the plugin falls back to its existing default
# (http://localhost:3111) and Hermes status reflects that.
def _preload_agentmemory_dotenv() -> None:
    candidates: list[Path] = []
    home = os.environ.get("HOME")
    if home:
        candidates.append(Path(home) / ".agentmemory" / ".env")
    xdg_config = os.environ.get("XDG_CONFIG_HOME")
    if xdg_config:
        candidates.append(Path(xdg_config) / "agentmemory" / ".env")
    for path in candidates:
        try:
            if not path.is_file():
                continue
            for raw in path.read_text(encoding="utf-8").splitlines():
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                key = key.strip()
                value = value.strip().strip('"').strip("'")
                if key:
                    os.environ.setdefault(key, value)
        except (OSError, UnicodeDecodeError):
            continue
    # Guarantee AGENTMEMORY_URL is set so `hermes memory status` never
    # reports it as Missing when a user runs agentmemory at the default
    # localhost:3111 (or via systemd with the URL line commented out in
    # ~/.agentmemory/.env because it matches the default). #520.
    os.environ.setdefault("AGENTMEMORY_URL", DEFAULT_BASE_URL)


_preload_agentmemory_dotenv()


def _validate_url(base: str) -> bool:
    if not base:
        return False
    try:
        parsed = urlparse(base)
        # .port raises ValueError on a non-numeric or out-of-range port
        _ = parsed.port
    except ValueError:
        return False
    if parsed.scheme not in ("http", "https"):
        return False
    return bool(parsed.hostname)


def _uses_plaintext_bearer_auth(base: str, secret: str = "") -> bool:
    if not secret:
        return False
    parsed = urlparse(base)
    return parsed.scheme == "http" and (parsed.hostname or "").lower() not in LOOPBACK_HOSTS


def _plaintext_bearer_auth_message(base: str) -> str:
    return f"agentmemory: AGENTMEMORY_SECRET is configured for plaintext HTTP to {base}. Bearer tokens and memory payloads can be observed on the network; use HTTPS or an SSH tunnel."


def _warn_plaintext_bearer_auth(message: str) -> None:
    print(message, file=sys.stderr)


def _check_plaintext_bearer_guard(
    base: str,
    secret: str = "",
    warn: Callable[[str], None] | None = None,
) -> None:
    global _plaintext_bearer_warned
    if not _uses_plaintext_bearer_auth(base, secret):
        return
    message = _plaintext_bearer_auth_message(base)
    if os.environ.get("AGENTMEMORY_REQUIRE_HTTPS") == "1":
        raise RuntimeError(message)
    if not _plaintext_bearer_warned:
        _plaintext_bearer_warned = True
        (warn or _warn_plaintext_bearer_auth)(message)


def _reset_plaintext_bearer_guard_for_tests() -> None:
    global _plaintext_bearer_warned
    _plaintext_bearer_warned = False


def _url_origin(value: str) -> tuple[str, str, int] | None:
    try:
        parsed = urlparse(value)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            return None
        return parsed.scheme.lower(), parsed.hostname.lower(), parsed.port or (443 if parsed.scheme == "https" else 80)
    except (TypeError, ValueError):
        return None


def _api(
    base: str,
    path: str,
    body: dict | None = None,
    method: str = "POST",
    secret: str = "",
    timeout: float = TIMEOUT,
) -> dict | None:
    if not _validate_url(base):
        return None
    if timeout <= 0:
        return None
    url = f"{base}/agentmemory/{path}"
    # Explicit UA: some corporate egress proxies 403 the default
    # "Python-urllib/x.y", which urlopen surfaces as a silent capture drop.
    headers = {
        "Content-Type": "application/json",
        "User-Agent": "agentmemory-hermes-plugin",
    }
    auth = secret or os.environ.get("AGENTMEMORY_SECRET", "")
    _check_plaintext_bearer_guard(base, auth)
    if auth:
        headers["Authorization"] = f"Bearer {auth}"

    if path == "selective-context":
        selective = os.environ.get("AGENTMEMORY_SELECTIVE_CONTEXT_SECRET", "")
        try:
            config_root = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
            settings = json.loads((config_root / "agentmemory" / "selective-context.json").read_text())
            if not isinstance(settings, dict) or _url_origin(settings.get("url", "")) != _url_origin(base):
                settings = {}
            selective = selective or settings.get("selectiveSecret", "")
            if not auth and settings.get("secret"):
                _check_plaintext_bearer_guard(base, settings["secret"])
                headers["Authorization"] = f"Bearer {settings['secret']}"
        except (OSError, TypeError, ValueError):
            pass
        if selective:
            _check_plaintext_bearer_guard(base, selective)
            headers["X-AgentMemory-Selective-Secret"] = selective

    data = json.dumps(body).encode() if body else None
    req = Request(url, data=data, headers=headers, method=method)
    try:
        with urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except (URLError, TimeoutError, json.JSONDecodeError):
        return None


def _api_bg(base: str, path: str, body: dict | None = None) -> None:
    t = threading.Thread(target=_api, args=(base, path, body), daemon=True)
    t.start()


def _observation_body(item: dict) -> dict:
    observation = item.get("observation")
    return observation if isinstance(observation, dict) else item


@contextmanager
def _mirror_file(home: str):
    path = Path(home) / "agentmemory-mirror.json"
    lock_path = Path(home) / "agentmemory-mirror.lock"
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    with os.fdopen(fd, "r+") as lock:
        if os.name == "nt":
            msvcrt.locking(fd, msvcrt.LK_LOCK, 1)
        else:
            fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            state = json.loads(path.read_text()) if path.exists() else {"version": 1, "records": {}}
        except (OSError, ValueError):
            state = None
        try:
            yield path, state
        finally:
            if os.name == "nt":
                msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock, fcntl.LOCK_UN)


def _save_mirror(path: Path, state: dict) -> None:
    fd, temporary = tempfile.mkstemp(prefix=".agentmemory-mirror-", dir=path.parent)
    try:
        if os.name != "nt":
            os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w") as stream:
            json.dump(state, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        if os.name != "nt":
            directory = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class AgentMemoryProvider(MemoryProvider):

    @property
    def name(self) -> str:
        return "agentmemory"

    def is_available(self) -> bool:
        # Hermes contract: no network calls in is_available.
        base = os.environ.get("AGENTMEMORY_URL", DEFAULT_BASE_URL)
        return _validate_url(base)

    def initialize(self, session_id: str, **kwargs: Any) -> None:
        self._base = os.environ.get("AGENTMEMORY_URL", DEFAULT_BASE_URL)
        self._session_id = session_id
        self._platform = kwargs.get("platform") or "cli"
        self._turn_lock = threading.Lock()
        self._generation = 0
        self._excluded_sessions = {session_id}
        self._cwd = kwargs.get("cwd", os.getcwd())
        self._project = _resolve_project(self._cwd)
        self._project_id = _resolve_project_id(self._cwd)
        self._hermes_home = str(kwargs.get("hermes_home") or "")
        if kwargs.get("chat_type") == "dm":
            owner = kwargs.get("user_id")
        elif self._platform == "cli":
            owner = "local"
        else:
            owner = None
        self._owner_id = self._owner(owner)
        if os.environ.get("AGENTMEMORY_REQUIRE_HTTPS") == "1":
            _check_plaintext_bearer_guard(self._base, os.environ.get("AGENTMEMORY_SECRET", ""))

        _api(self._base, "session/start", {
            "sessionId": session_id,
            "project": self._project,
            "cwd": self._cwd,
            **({"agentId": self._owner_id} if self._owner_id else {}),
        })

    def _owner(self, author_id: Any) -> str:
        if not self._hermes_home or not isinstance(author_id, str) or not author_id.strip():
            return ""
        digest = hashlib.sha256(f"{self._hermes_home}\0{author_id.strip()}".encode()).hexdigest()[:32]
        return f"hermes:{digest}"

    def get_config_schema(self) -> list[dict]:
        return [
            {
                "key": "url",
                "description": "agentmemory server URL",
                "default": DEFAULT_BASE_URL,
                "env_var": "AGENTMEMORY_URL",
            },
            {
                "key": "secret",
                "description": "agentmemory auth secret (optional)",
                "secret": True,
                "required": False,
                "env_var": "AGENTMEMORY_SECRET",
            },
        ]

    def save_config(self, values: dict, hermes_home: str) -> None:
        config_path = Path(hermes_home) / "agentmemory.json"
        config_path.write_text(json.dumps(values, indent=2))

    def system_prompt_block(self) -> str:
        return ""

    def on_session_switch(self, new_session_id: str, *, parent_session_id: str = "",
                          reset: bool = False, **kwargs: Any) -> None:
        with self._turn_lock:
            self._session_id = new_session_id
            self._generation += 1
            if reset:
                self._excluded_sessions = {new_session_id}
            else:
                self._excluded_sessions.add(new_session_id)
            if parent_session_id:
                self._excluded_sessions.add(parent_session_id)

    def prefetch(self, query: str, *, session_id: str = "", previous: str = "",
                 author_id: str = "", visibility: str = "",
                 verified_session_ids: list[str] | None = None) -> str:
        local_cli = self._platform == "cli" and not author_id
        owner_id = self._owner("local") if local_cli else self._owner(author_id)
        if local_cli and not visibility:
            visibility = "private"
        if visibility != "private" or not owner_id or owner_id != self._owner_id:
            return ""
        if not isinstance(query, str) or not query.strip() or len(query) > 12000:
            return ""
        requested_session = session_id or self._session_id
        with self._turn_lock:
            if requested_session != self._session_id:
                self._session_id = requested_session
                self._generation += 1
                self._excluded_sessions = {requested_session}
            generation = self._generation
            excluded = sorted(self._excluded_sessions)[:100]
        verified = [value for value in (verified_session_ids or [])[:100] if isinstance(value, str) and value]
        started = time.monotonic()
        result = _api(self._base, "selective-context", {
            "prompt": " ".join(query.split())[:1000],
            "previous": previous[:2000],
            "project": self._project,
            "projectId": self._project_id,
            "sessionId": requested_session, "recallHistory": True,
            "excludedSessionIds": excluded,
            "hermes": {"sessionId": requested_session, "ownerId": owner_id,
                       "visibility": "private", "verifiedSessionIds": verified},
        }, timeout=PREFETCH_TIMEOUT)
        with self._turn_lock:
            if self._generation != generation:
                return ""
        if time.monotonic() - started >= PREFETCH_TIMEOUT or not isinstance(result, dict) or result.get("status") != "selected":
            return ""
        spans = result.get("spans")
        if not isinstance(spans, list):
            return ""
        lines = []
        for span in spans[:2]:
            if not isinstance(span, dict):
                return ""
            text = span.get("text")
            source = span.get("knowledgeId")
            revision = span.get("revision")
            if not all(isinstance(value, str) and value for value in (text, source, revision)):
                return ""
            line = f"- {text} [source: {source}; revision: {revision}]"
            if len("\n".join(lines + [line])) <= PREFETCH_CONTEXT_LENGTH:
                lines.append(line)
        if not lines:
            return ""
        return "[agentmemory historical evidence]\n" + "\n".join(lines) + "\n[/agentmemory historical evidence]"

    def queue_prefetch(self, query: str, **kwargs: Any) -> None:
        return

    def get_tool_schemas(self) -> list[dict]:
        return [
            {
                "name": "memory_recall",
                "description": "Search agentmemory for past observations by keyword",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "Search query"},
                        "limit": {"type": "integer", "description": "Max results", "default": 10},
                    },
                    "required": ["query"],
                },
            },
            {
                "name": "memory_save",
                "description": "Save an insight, decision, or pattern to long-term memory",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "content": {"type": "string", "description": "What to remember"},
                        "type": {
                            "type": "string",
                            "enum": ["pattern", "preference", "architecture", "bug", "workflow", "fact"],
                            "description": "Memory type",
                        },
                    },
                    "required": ["content"],
                },
            },
            {
                "name": "memory_search",
                "description": "Hybrid semantic + keyword search across all memories",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string"},
                        "limit": {"type": "integer", "default": 5},
                    },
                    "required": ["query"],
                },
            },
        ]

    def handle_tool_call(self, name: str, args: dict) -> str:
        # Hermes stores the return value as the tool result `content` in the
        # session history. Anthropic-protocol providers reject non-string
        # content with a 400 on the next request, so always serialize to a
        # JSON string here — matches what agentmemory's main MCP server does
        # in src/mcp/standalone.ts (`{ type: "text", text: JSON.stringify(...) }`).
        if name == "memory_recall":
            result = _api(self._base, "search", {
                "query": args["query"],
                "limit": args.get("limit", 10),
            })
            if not result:
                return json.dumps({"results": []})
            items = []
            for r in result.get("results") or []:
                obs = r.get("observation", r)
                items.append({
                    "id": obs.get("id", ""),
                    "sessionId": obs.get("sessionId", r.get("sessionId", "")),
                    "sourceType": "memory" if str(obs.get("id", "")).startswith("mem_") else "observation",
                    "title": obs.get("title", ""),
                    "type": obs.get("type", ""),
                    "narrative": obs.get("narrative", ""),
                    "importance": obs.get("importance", 0),
                    "timestamp": obs.get("timestamp", ""),
                })
            return json.dumps({"results": items})

        if name == "memory_save":
            result = _api(self._base, "remember", {
                "content": args["content"],
                "type": args.get("type", "fact"),
            })
            return json.dumps(result or {"success": False})

        if name == "memory_search":
            requested_limit = args.get("limit", 5)
            limit = max(1, min(requested_limit, 10)) if isinstance(requested_limit, int) else 5
            result = _api(self._base, "smart-search", {
                "query": args["query"],
                "limit": limit,
                "includeLessons": True,
            })
            if not isinstance(result, dict):
                return json.dumps({"results": []})
            items = []
            compact = [r for r in result.get("results") or [] if isinstance(r, dict)]
            obs_ids = [{"obsId": r["obsId"], "sessionId": r["sessionId"]}
                       for r in compact if str(r.get("obsId", "")).startswith("obs_")
                       and isinstance(r.get("sessionId"), str) and r["sessionId"]]
            if obs_ids:
                expanded = _api(self._base, "smart-search", {"expandIds": obs_ids})
                for r in expanded.get("results", []) if isinstance(expanded, dict) else []:
                    obs = _observation_body(r)
                    if obs.get("narrative") and obs.get("id") in {entry["obsId"] for entry in obs_ids}:
                        items.append({"sourceType": "observation", "id": obs["id"],
                                      "sessionId": obs.get("sessionId", r.get("sessionId", "")),
                                      "title": obs.get("title", ""), "text": obs["narrative"]})
            mem_ids = {r.get("obsId") for r in compact if str(r.get("obsId", "")).startswith("mem_")}
            if mem_ids:
                full = _api(self._base, "search", {"query": args["query"], "limit": 20})
                for r in full.get("results", []) if isinstance(full, dict) else []:
                    obs = _observation_body(r)
                    if obs.get("id") in mem_ids and obs.get("narrative"):
                        items.append({"sourceType": "memory", "id": obs["id"],
                                      "title": obs.get("title", ""), "text": obs["narrative"]})
            lesson_ids = {r.get("lessonId") for r in result.get("lessons") or [] if isinstance(r, dict)}
            if lesson_ids:
                full = _api(self._base, "lessons/search", {"query": args["query"], "limit": 20})
                for lesson in full.get("lessons", []) if isinstance(full, dict) else []:
                    if lesson.get("id") in lesson_ids and lesson.get("content"):
                        items.append({"sourceType": "lesson", "id": lesson["id"], "text": lesson["content"]})
            return json.dumps({"results": items})

        return json.dumps({"error": f"Unknown tool: {name}"})

    def sync_turn(self, user: str, assistant: str, **kwargs: Any) -> None:
        _api_bg(self._base, "observe", {
            "hookType": "post_tool_use",
            "sessionId": kwargs.get("session_id", self._session_id),
            "project": self._project,
            "cwd": self._cwd,
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "data": {
                "tool_name": "conversation",
                "tool_input": user[:500],
                "tool_output": assistant[:2000],
            },
        })

    def on_session_end(self, messages: list, **kwargs: Any) -> None:
        _api(self._base, "session/end", {
            "sessionId": kwargs.get("session_id", self._session_id),
        })

    def on_pre_compress(self, messages: list, **kwargs: Any) -> str | None:
        retained = []
        for message in messages:
            if not isinstance(message, dict):
                continue
            content = message.get("api_content")
            if not isinstance(content, str):
                continue
            for match in re.finditer(r"\[agentmemory historical evidence\]\n(.*?)\n\[/agentmemory historical evidence\]",
                                     content, re.DOTALL):
                if len(match.group(1)) <= 3000 and match.group(1) not in retained:
                    retained.append(match.group(1))
        if retained:
            return "Previously adopted historical evidence (verify current validity):\n" + "\n".join(retained[-2:])
        return None

    def on_memory_write(self, action: str, target: str, content: str, **kwargs: Any) -> None:
        metadata = kwargs.get("metadata") or {}
        if not isinstance(metadata, dict):
            return
        if action not in ("add", "replace", "remove") or target not in ("user", "memory"):
            return
        if not self._hermes_home or not self._owner_id:
            return
        previous = metadata.get("previous_content")
        if action in ("replace", "remove") and not isinstance(previous, str):
            return
        if action in ("add", "replace") and not content:
            return
        if action == "replace" and content == previous:
            return
        mirror_owner = f"{self._owner_id}:{target}"

        def key(text: str) -> str:
            return hashlib.sha256(f"{target}\0{text}".encode()).hexdigest()

        with _mirror_file(self._hermes_home) as (path, state):
            if not isinstance(state, dict) or state.get("version") != 1 or not isinstance(state.get("records"), dict):
                return
            records = state["records"]
            old = records.get(key(previous)) if isinstance(previous, str) else None
            if action in ("replace", "remove") and (not isinstance(old, dict)
                or old.get("content") != previous or old.get("mirrorOwner") != mirror_owner
                or not isinstance(old.get("memoryId"), str)):
                return
            if action in ("add", "replace") and key(content) not in records:
                result = _api(self._base, "remember", {
                    "content": content, "type": "fact", "project": self._project,
                    "agentId": self._owner_id, "mirrorOwner": mirror_owner,
                })
                memory = result.get("memory") if isinstance(result, dict) else None
                memory_id = memory.get("id") if isinstance(memory, dict) else None
                if not result or result.get("success") is not True or not isinstance(memory_id, str) or not memory_id.startswith("mem_"):
                    return
                if memory.get("mirrorOwner") != mirror_owner:
                    return
                records[key(content)] = {"content": content, "memoryId": memory_id, "mirrorOwner": mirror_owner}
                _save_mirror(path, state)
            if action in ("replace", "remove"):
                result = _api(self._base, "forget", {"memoryId": old["memoryId"], "mirrorOwner": mirror_owner})
                if not isinstance(result, dict) or result.get("success") is not True or result.get("deleted") != 1:
                    return
                records.pop(key(previous), None)
                _save_mirror(path, state)

    def shutdown(self, **kwargs: Any) -> None:
        pass


def register(ctx: Any) -> None:
    ctx.register_memory_provider(AgentMemoryProvider())
