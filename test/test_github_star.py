import sys
sys.dont_write_bytecode = True
import importlib.util
import io
import json
import os
from contextlib import redirect_stdout
from pathlib import Path
import ssl
import subprocess
import unittest
from unittest.mock import patch

HELPER = Path(__file__).resolve().parents[1] / "helpers/github_star.py"
star = None
if HELPER.exists():
    spec = importlib.util.spec_from_file_location("github_star", HELPER)
    star = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(star)


class Response:
    def __init__(self, status):
        self.status = status
        self.drained = False
        self.read_limit = None

    def read(self, limit):
        self.drained = True
        self.read_limit = limit
        return b""


class Connection:
    def __init__(self, *statuses):
        self.responses = [Response(status) for status in statuses]
        self.requests = []
        self.closed = False

    def request(self, method, path, body=None, headers=None):
        if self.requests and not self.responses[len(self.requests) - 1].drained:
            raise AssertionError("previous response was not drained")
        self.requests.append((method, path, body, headers))

    def getresponse(self):
        return self.responses[len(self.requests) - 1]

    def close(self):
        self.closed = True


class AuthProcess:
    def __init__(self, token=b"private-token\n", code=0, timeout=False):
        self.stdout = io.BytesIO(token)
        self.code = code
        self.timeout = timeout

    def wait(self, timeout=None):
        if self.timeout:
            raise subprocess.TimeoutExpired("gh", timeout)
        return self.code

    def kill(self):
        self.timeout = False


class GithubStarTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(star, "the star helper has not been implemented")
        self.env = patch.dict(os.environ, {}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)

    def direct(self, *statuses):
        connection = Connection(*statuses)
        with patch.object(star.subprocess, "Popen", return_value=AuthProcess()) as popen, \
             patch.object(star.http.client, "HTTPSConnection", return_value=connection) as connect:
            result = star.toggle("acme/thing")
        popen.assert_called_once()
        args, kwargs = popen.call_args
        self.assertEqual(args[0], [star.GH_PATH, "auth", "token", "--hostname", "github.com"])
        self.assertEqual(kwargs["stdout"], subprocess.PIPE)
        self.assertEqual(kwargs["stderr"], subprocess.DEVNULL)
        self.assertEqual(kwargs["cwd"], "/")
        self.assertEqual(kwargs["env"]["PATH"], "/usr/bin:/bin")
        self.assertNotIn("GH_TOKEN", kwargs["env"])
        self.assertEqual(connect.call_count, 1)
        self.assertEqual(connect.call_args.args, ("api.github.com",))
        self.assertGreater(connect.call_args.kwargs["timeout"], 0)
        self.assertLessEqual(connect.call_args.kwargs["timeout"], 10)
        context = connect.call_args.kwargs["context"]
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)
        self.assertTrue(connection.closed)
        self.assertTrue(all(response.drained for response in connection.responses))
        self.assertTrue(all(response.read_limit == star.MAX_RESPONSE_BYTES + 1
                            for response in connection.responses))
        return result, connection

    def test_unstarred_repository_is_added_on_the_same_connection(self):
        result, connection = self.direct(404, 204)
        self.assertEqual(result, {"kind": "changed", "starred": True})
        self.assertEqual([r[:3] for r in connection.requests],
                         [("GET", "/user/starred/acme/thing", None),
                          ("PUT", "/user/starred/acme/thing", None)])
        for request in connection.requests:
            self.assertEqual(request[3]["Authorization"], "Bearer private-token")
        self.assertEqual(connection.requests[1][3]["Content-Length"], "0")

    def test_already_starred_repository_is_removed_on_the_same_connection(self):
        result, connection = self.direct(204, 204)
        self.assertEqual(result, {"kind": "changed", "starred": False})
        self.assertEqual(connection.requests[1][:3], ("DELETE", "/user/starred/acme/thing", None))
        self.assertEqual(connection.requests[1][3]["Content-Length"], "0")

    def test_auth_switch_and_external_change_are_observed_on_each_click(self):
        connections = [Connection(404, 204), Connection(204, 204)]
        auth = [AuthProcess((token + "\n").encode()) for token in ["account-one", "account-two"]]
        with patch.object(star.subprocess, "Popen", side_effect=auth), \
             patch.object(star.http.client, "HTTPSConnection", side_effect=connections):
            self.assertEqual(star.toggle("acme/thing"), {"kind": "changed", "starred": True})
            self.assertEqual(star.toggle("acme/thing"), {"kind": "changed", "starred": False})
        self.assertEqual(connections[0].requests[0][3]["Authorization"], "Bearer account-one")
        self.assertEqual(connections[1].requests[0][3]["Authorization"], "Bearer account-two")

    def test_signed_out_missing_gh_and_auth_timeout_fall_back_without_http(self):
        cases = [AuthProcess(b"", 1), AuthProcess(b"\n", 0),
                 FileNotFoundError("gh"), AuthProcess(timeout=True)]
        for case in cases:
            with self.subTest(case=type(case).__name__), \
                 patch.object(star.subprocess, "Popen", **({"side_effect": case} if isinstance(case, Exception) else {"return_value": case})), \
                 patch.object(star.http.client, "HTTPSConnection") as connect:
                self.assertEqual(star.toggle("acme/thing"), {"kind": "fallback"})
                connect.assert_not_called()

    def test_check_401_403_429_and_unexpected_statuses_never_mutate(self):
        for status in [401, 403, 429, 301, 200, 500]:
            with self.subTest(status=status):
                result, connection = self.direct(status)
                self.assertEqual(result, {"kind": "fallback"})
                self.assertEqual(len(connection.requests), 1)

    def test_failed_writes_do_not_report_a_change(self):
        for check in [204, 404]:
            for status in [401, 403, 429, 200, 500]:
                with self.subTest(check=check, status=status):
                    result, _ = self.direct(check, status)
                    self.assertEqual(result, {"kind": "failed"})

    def test_offline_check_falls_back_but_offline_write_reports_failure(self):
        for phase in [0, 1]:
            connection = Connection(404, 204)
            request = connection.request
            def offline(*args, **kwargs):
                if len(connection.requests) == phase:
                    raise OSError("private-token must not reach output")
                return request(*args, **kwargs)
            with self.subTest(phase=phase), \
                 patch.object(star.subprocess, "Popen", return_value=AuthProcess(b"private-token")), \
                 patch.object(star.http.client, "HTTPSConnection", return_value=connection), \
                 patch.object(connection, "request", side_effect=offline):
                output = io.StringIO()
                with redirect_stdout(output):
                    result = star.toggle("acme/thing")
                self.assertEqual(result, {"kind": "fallback" if phase == 0 else "failed"})
                self.assertEqual(output.getvalue(), "")
                self.assertTrue(connection.closed)

    def test_invalid_slugs_never_spawn_gh_or_open_a_connection(self):
        for slug in ["", None, "acme", "a/b/c", "-acme/repo", "acme-/repo", "acme/.", "acme/..",
                     "acme/a?x", "acme/a#x", "acme/%2e%2e", "acme/a\\b", "acme/a\n", "a" * 40 + "/b", "a/" + "b" * 101]:
            with self.subTest(slug=slug), patch.object(star.subprocess, "Popen") as run, \
                 patch.object(star.http.client, "HTTPSConnection") as connect:
                self.assertEqual(star.toggle(slug), {"kind": "failed"})
                run.assert_not_called()
                connect.assert_not_called()

    def test_endpoint_environment_cannot_retarget_the_direct_api(self):
        with patch.dict(os.environ, {"GH_HOST": "evil.example", "GITHUB_API_URL": "https://evil.example"}):
            result, _ = self.direct(404, 204)
        self.assertEqual(result, {"kind": "changed", "starred": True})

    def test_proxy_traffic_keeps_the_gh_check_and_mutation_transport(self):
        for proxy_var in ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]:
            for check, method, starred in [(0, "DELETE", False), (1, "PUT", True)]:
                responses = [(check, "gh: Not Found (HTTP 404)" if check else ""), (0, "")]
                with self.subTest(proxy=proxy_var, method=method), \
                     patch.dict(os.environ, {proxy_var: "http://proxy.example:8080"}), \
                     patch.object(star, "run_gh", side_effect=responses) as run, \
                     patch.object(star.http.client, "HTTPSConnection") as connect:
                    self.assertEqual(star.toggle("acme/thing"), {"kind": "changed", "starred": starred})
                    self.assertEqual(run.call_args_list[0].args[0],
                                     [star.GH_PATH, "api", "--hostname", "github.com", "--silent", "user/starred/acme/thing"])
                    self.assertEqual(run.call_args_list[1].args[0],
                                     [star.GH_PATH, "api", "--hostname", "github.com", "--silent", "-X", method, "user/starred/acme/thing"])
                    connect.assert_not_called()

    def test_configured_proxy_leaves_no_proxy_and_case_precedence_to_gh(self):
        for env in [{"HTTPS_PROXY": "http://proxy.example", "NO_PROXY": "api.github.com"},
                    {"HTTPS_PROXY": "http://proxy.example", "https_proxy": ""},
                    {"HTTPS_PROXY": "http://proxy.example", "NO_PROXY": "other.example", "no_proxy": "api.github.com"}]:
            responses = [(0, ""), (0, "")]
            with self.subTest(env=env), patch.dict(os.environ, env), \
                 patch.object(star, "run_gh", side_effect=responses) as run, \
                 patch.object(star.http.client, "HTTPSConnection") as connect:
                self.assertEqual(star.toggle("acme/thing"), {"kind": "changed", "starred": False})
                self.assertEqual(run.call_args_list[0].args[0],
                                 [star.GH_PATH, "api", "--hostname", "github.com", "--silent", "user/starred/acme/thing"])
                connect.assert_not_called()

    def test_proxy_check_failure_falls_back_and_write_failure_reports_failed(self):
        for responses, outcome in [([(1, "HTTP 401")], "fallback"),
                                  ([(1, "HTTP 403")], "fallback"),
                                  ([(1, "HTTP 429")], "fallback"),
                                  ([(1, "host not found")], "fallback"),
                                  ([None], "fallback"),
                                  ([(0, ""), (1, "HTTP 403")], "failed")]:
            with self.subTest(outcome=outcome, responses=len(responses)), \
                 patch.dict(os.environ, {"HTTPS_PROXY": "http://proxy.example"}), \
                  patch.object(star, "run_gh", side_effect=responses), \
                 patch.object(star.http.client, "HTTPSConnection") as connect:
                self.assertEqual(star.toggle("acme/thing"), {"kind": outcome})
                connect.assert_not_called()

    def test_cli_emits_only_the_known_result_without_diagnostics_or_tokens(self):
        output = io.StringIO()
        with patch.object(star, "toggle", return_value={"kind": "failed"}), redirect_stdout(output):
            star.main(["acme/thing"])
        self.assertEqual(output.getvalue(), '{"kind":"failed"}\n')
        self.assertEqual(json.loads(output.getvalue()), {"kind": "failed"})


if __name__ == "__main__":
    unittest.main()
