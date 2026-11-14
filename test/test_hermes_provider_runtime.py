import importlib.util
import json
import os
import hashlib
import socket
import subprocess
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch


class HermesProviderTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.home = tempfile.TemporaryDirectory()
        with patch.dict(os.environ, {"HOME": cls.home.name, "AGENTMEMORY_URL": "http://localhost:3111"}):
            spec = importlib.util.spec_from_file_location(
                "candidate_hermes_provider", Path(__file__).parents[1] / "integrations/hermes/__init__.py"
            )
            cls.module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(cls.module)

    @classmethod
    def tearDownClass(cls):
        cls.home.cleanup()

    def provider(self, home=None):
        provider = self.module.AgentMemoryProvider()
        scoped_home = home or self.home.name
        with patch.object(self.module, "_api", return_value={}):
            provider.initialize("current", cwd=scoped_home, hermes_home=scoped_home,
                                user_id="alice", chat_type="dm")
        return provider

    def test_startup_and_compression_do_not_fetch_broad_context_or_mutate_messages(self):
        provider = self.provider()
        messages = [{"role": "user", "content": "Current work"}]
        with patch.object(self.module, "_api", side_effect=AssertionError("unexpected API call")):
            self.assertEqual(provider.system_prompt_block(), "")
            self.assertIsNone(provider.on_pre_compress(messages, session_id="current"))
        self.assertEqual(messages, [{"role": "user", "content": "Current work"}])

    def test_compression_keeps_selected_claim_and_source_without_new_user_turn(self):
        provider = self.provider()
        messages = [{"role": "user", "content": "Continue repair", "api_content":
            "Continue repair\n<memory-context>\n[agentmemory historical evidence]\n"
            "- Router uses port 4180. [source: summary:old; revision: rev1]\n"
            "[/agentmemory historical evidence]\n</memory-context>"}]
        before = json.loads(json.dumps(messages))
        with patch.object(self.module, "_api", side_effect=AssertionError("unexpected API call")):
            checkpoint = provider.on_pre_compress(messages)
        self.assertIn("Router uses port 4180", checkpoint)
        self.assertIn("summary:old", checkpoint)
        self.assertIn("rev1", checkpoint)
        self.assertEqual(messages, before)

    def test_compression_keeps_complete_long_prefetched_fact(self):
        provider = self.provider()
        fact = "Synthetic routing fact: " + "route detail " * 105 + "END_CLAUSE"
        source = "summary:synthetic-ram-source"
        revision = "synthetic-ram-revision"
        with patch.object(self.module, "_api", return_value={"status": "selected", "spans": [{
                "text": fact, "knowledgeId": source, "revision": revision}]}):
            evidence = provider.prefetch("synthetic route", session_id="current",
                                         author_id="alice", visibility="private")
        self.assertIn("END_CLAUSE", evidence)
        messages = [{"role": "user", "api_content": evidence}]
        before = json.loads(json.dumps(messages))
        checkpoint = provider.on_pre_compress(messages)
        self.assertIn(f"{fact} [source: {source}; revision: {revision}]", checkpoint)
        self.assertEqual(messages, before)

    def test_compression_keeps_complete_restored_api_content(self):
        provider = self.provider()
        fact = "Synthetic restored fact: " + "stored detail " * 105 + "END_CLAUSE"
        source = "summary:synthetic-restored-source"
        revision = "synthetic-restored-revision"
        evidence = f"- {fact} [source: {source}; revision: {revision}]"
        self.assertLessEqual(len(evidence), self.module.PREFETCH_CONTEXT_LENGTH)
        messages = [{"role": "user", "api_content":
            f"[agentmemory historical evidence]\n{evidence}\n[/agentmemory historical evidence]"}]
        before = json.loads(json.dumps(messages))
        checkpoint = provider.on_pre_compress(messages)
        self.assertIn(evidence, checkpoint)
        self.assertEqual(messages, before)
        oversized = [{"api_content": "[agentmemory historical evidence]\n" + "x" * 3001 +
                      "\n[/agentmemory historical evidence]"}]
        self.assertIsNone(provider.on_pre_compress(oversized))

    def test_private_followup_uses_selective_result_and_group_fails_closed(self):
        provider = self.provider()
        calls = []
        def api(_base, path, body=None, **_kwargs):
            calls.append((path, body))
            return {"status": "selected", "spans": [{"knowledgeId": "summary:old", "revision": "rev1",
                "spanId": "narrative", "text": "The router uses port 4180.", "evidenceEventId": "summary:old"}]}
        with patch.object(self.module, "_api", side_effect=api):
            result = provider.prefetch("好啊，修啊", session_id="current", previous="user: Repair the router",
                                       author_id="alice", visibility="private")
            self.assertIn("4180", result)
            self.assertEqual(provider.prefetch("same", author_id="alice", visibility="group"), "")
        self.assertEqual([path for path, _ in calls], ["selective-context"])
        self.assertEqual(calls[0][1]["previous"], "user: Repair the router")
        self.assertEqual(calls[0][1]["projectId"], provider._project_id)

    def test_cli_without_author_uses_only_initialized_local_principal(self):
        provider = self.module.AgentMemoryProvider()
        with tempfile.TemporaryDirectory() as home, patch.object(self.module, "_api", return_value={}):
            provider.initialize("cli-current", cwd=home, hermes_home=home, platform="cli")
            calls = []
            with patch.object(self.module, "_api", side_effect=lambda _base, path, body=None, **_kw:
                              calls.append((path, body)) or {"status": "empty", "spans": []}):
                provider.prefetch("What was decided?", session_id="cli-current")
                provider.prefetch("What was decided?", session_id="cli-current", visibility="group")
            self.assertEqual([path for path, _ in calls], ["selective-context"])
            self.assertEqual(calls[0][1]["hermes"]["ownerId"], provider._owner_id)

    def test_none_platform_uses_local_cli_principal_only(self):
        with tempfile.TemporaryDirectory() as home, patch.object(self.module, "_api", return_value={}):
            provider = self.module.AgentMemoryProvider()
            provider.initialize("cli-current", cwd=home, hermes_home=home, platform=None)
            calls = []
            with patch.object(self.module, "_api", side_effect=lambda _base, path, body=None, **_kw:
                              calls.append((path, body)) or {"status": "empty", "spans": []}):
                provider.prefetch("Router rollback", session_id="cli-current")
                provider.prefetch("Router rollback", session_id="cli-current", visibility="group")
                provider.prefetch("Router rollback", session_id="cli-current", author_id="alice")
            self.assertEqual([path for path, _ in calls], ["selective-context"])
            self.assertTrue(provider._owner_id)
            self.assertEqual(calls[0][1]["hermes"]["ownerId"], provider._owner_id)
            remote = self.module.AgentMemoryProvider()
            remote.initialize("remote-current", cwd=home, hermes_home=home, platform="api")
            with patch.object(self.module, "_api", side_effect=AssertionError("unexpected API call")):
                self.assertEqual(remote.prefetch("Router rollback", session_id="remote-current"), "")

    def test_unlabelled_reply_never_deletes_legacy_server_memory(self):
        provider = self.provider()
        calls = []
        with patch.object(self.module, "_api", side_effect=lambda _base, path, body=None, **_kw:
                          calls.append(path) or {"success": True, "memory": {"id": "mem_foreign"}}):
            provider.on_memory_write("add", "memory", "Route A", metadata={})
        self.assertEqual(calls, ["remember"])

    def test_private_selective_secret_is_bound_to_configured_origin(self):
        class Response:
            def __enter__(self):
                return self
            def __exit__(self, *_args):
                return None
            def read(self):
                return b'{"status":"empty","spans":[]}'
        with tempfile.TemporaryDirectory() as home:
            config = Path(home) / "agentmemory"
            config.mkdir()
            (config / "selective-context.json").write_text(json.dumps({
                "url": "http://localhost:3111", "selectiveSecret": "fixture-selective-token"}))
            requests = []
            def capture(req, **_kwargs):
                requests.append(req)
                return Response()
            with patch.dict(os.environ, {"XDG_CONFIG_HOME": home, "AGENTMEMORY_URL": "http://localhost:3111",
                                      "AGENTMEMORY_SELECTIVE_CONTEXT_SECRET": "", "AGENTMEMORY_SECRET": ""}), \
                 patch.object(self.module, "urlopen", side_effect=capture):
                self.module._api("http://localhost:3111", "selective-context", {"prompt": "route"})
                self.module._api("http://other-host:3111", "selective-context", {"prompt": "route"})
            self.assertEqual(requests[0].get_header("X-agentmemory-selective-secret"), "fixture-selective-token")
            self.assertIsNone(requests[1].get_header("X-agentmemory-selective-secret"))

    def test_unavailable_empty_and_timeout_have_no_search_fallback(self):
        provider = self.provider()
        calls = []
        for response in (None, {"status": "empty", "spans": []},
                         {"status": "unavailable", "spans": []}):
            with patch.object(self.module, "_api", side_effect=lambda _base, path, *_args, **_kwargs:
                              calls.append(path) or response):
                self.assertEqual(provider.prefetch("router", author_id="alice", visibility="private"), "")
        self.assertEqual(calls, ["selective-context"] * 3)

    def test_owned_mirror_replacement_and_removal_are_exact_and_profile_scoped(self):
        provider = self.provider()
        calls = []
        counter = 0
        def api(_base, path, body=None, **_kwargs):
            nonlocal counter
            calls.append((path, body))
            if path == "remember":
                counter += 1
                return {"success": True, "memory": {"id": f"mem_{counter}", "mirrorOwner": body["mirrorOwner"]}}
            return {"success": True, "deleted": 1}
        with patch.object(self.module, "_api", side_effect=api):
            provider.on_memory_write("add", "memory", "Route A", metadata={})
            provider.on_memory_write("replace", "memory", "Route B", metadata={"previous_content": "Route A"})
            provider.on_memory_write("remove", "memory", "", metadata={"previous_content": "Route B"})
            provider.on_memory_write("remove", "memory", "", metadata={"previous_content": "Foreign"})
        self.assertEqual([path for path, _ in calls], ["remember", "remember", "forget", "forget"])
        self.assertEqual([body["memoryId"] for path, body in calls if path == "forget"], ["mem_1", "mem_2"])
        self.assertFalse(any(body.get("content") == "Foreign" for _, body in calls))

    def test_mirror_mapping_survives_new_provider_and_never_crosses_profiles_or_targets(self):
        with tempfile.TemporaryDirectory() as home_a, tempfile.TemporaryDirectory() as home_b:
            first = self.provider(home_a)
            restarted = self.provider(home_a)
            other = self.provider(home_b)
            calls = []
            def api(_base, path, body=None, **_kwargs):
                calls.append((path, body))
                return {"success": True, "memory": {"id": f"mem_{len(calls)}",
                        "mirrorOwner": body.get("mirrorOwner")}, "deleted": 1}
            with patch.object(self.module, "_api", side_effect=api):
                first.on_memory_write("add", "user", "Shared text", metadata={})
                restarted.on_memory_write("add", "memory", "Shared text", metadata={})
                other.on_memory_write("remove", "user", "", metadata={"previous_content": "Shared text"})
                restarted.on_memory_write("remove", "user", "", metadata={"previous_content": "Shared text"})
            self.assertEqual([path for path, _ in calls], ["remember", "remember", "forget"])
            self.assertNotEqual(calls[0][1]["mirrorOwner"], calls[1][1]["mirrorOwner"])
            self.assertEqual(calls[2][1]["memoryId"], "mem_1")

    def test_concurrent_mirror_writes_leave_one_valid_atomic_map(self):
        with tempfile.TemporaryDirectory() as home:
            provider = self.provider(home)
            def api(_base, path, body=None, **_kwargs):
                return {"success": True, "memory": {"id": "mem_" + body["content"],
                        "mirrorOwner": body["mirrorOwner"]}}
            with patch.object(self.module, "_api", side_effect=api):
                with ThreadPoolExecutor(max_workers=8) as pool:
                    list(pool.map(lambda i: provider.on_memory_write("add", "memory", f"item{i}", metadata={}), range(20)))
            state = json.loads((Path(home) / "agentmemory-mirror.json").read_text())
            self.assertEqual(len(state["records"]), 20)
            self.assertEqual({row["content"] for row in state["records"].values()},
                             {f"item{i}" for i in range(20)})

    def test_unlabelled_server_reply_is_not_mapped_or_deleted(self):
        with tempfile.TemporaryDirectory() as home:
            provider = self.provider(home)
            calls = []
            def api(_base, path, body=None, **_kwargs):
                calls.append((path, body))
                return {"success": True, "memory": {"id": "mem_new"}, "deleted": 1}
            with patch.object(self.module, "_api", side_effect=api):
                provider.on_memory_write("add", "memory", "Route C", metadata={})
            self.assertEqual([path for path, _ in calls], ["remember"])
            self.assertFalse((Path(home) / "agentmemory-mirror.json").exists())

    def test_project_identity_matches_selective_hook_for_local_and_remote_repo(self):
        with tempfile.TemporaryDirectory() as repo:
            subprocess.run(["git", "init", "-q", repo], check=True)
            git_dir = os.path.realpath(Path(repo) / ".git")
            local = "project:" + hashlib.sha256(f"local:{socket.gethostname()}:{git_dir}".encode()).hexdigest()
            self.assertEqual(self.module._resolve_project_id(repo), local)
            subprocess.run(["git", "-C", repo, "remote", "add", "origin",
                            "git@github.com:yulin/example.git"], check=True)
            remote = "project:" + hashlib.sha256(b"remote:github.com/yulin/example").hexdigest()
            self.assertEqual(self.module._resolve_project_id(repo), remote)
            subprocess.run(["git", "-C", repo, "remote", "set-url", "origin",
                            "https://github.com:443/yulin/example.git"], check=True)
            self.assertEqual(self.module._resolve_project_id(repo), remote)

    def test_manual_search_expands_observations_and_keeps_memory_and_lesson_sources(self):
        provider = self.provider()
        calls = []
        def api(_base, path, body=None, **_kwargs):
            calls.append((path, body))
            if path == "smart-search" and body.get("query"):
                return {"results": [{"obsId": "obs_1", "sessionId": "old", "title": "Route", "score": 0.8},
                                    {"obsId": "mem_1", "sessionId": "memory", "title": "Preference", "score": 0.7}],
                        "lessons": [{"lessonId": "lesson_1", "content": "preview"}]}
            if path == "smart-search" and body.get("expandIds"):
                return {"results": [{"obsId": "obs_1", "sessionId": "old",
                    "observation": {"id": "obs_1", "title": "Route", "narrative": "Full route evidence."}}]}
            if path == "search":
                return {"results": [{"observation": {"id": "mem_1", "title": "Preference",
                    "narrative": "Full saved preference."}}]}
            if path == "lessons/search":
                return {"lessons": [{"id": "lesson_1", "content": "Full lesson evidence."}]}
        with patch.object(self.module, "_api", side_effect=api):
            results = json.loads(provider.handle_tool_call("memory_search", {"query": "route"}))["results"]
        self.assertEqual({item["sourceType"] for item in results}, {"observation", "memory", "lesson"})
        self.assertEqual({item["text"] for item in results}, {"Full route evidence.",
                          "Full saved preference.", "Full lesson evidence."})
        self.assertEqual([item["obsId"] for item in calls[1][1]["expandIds"]], ["obs_1"])


if __name__ == "__main__":
    unittest.main()
