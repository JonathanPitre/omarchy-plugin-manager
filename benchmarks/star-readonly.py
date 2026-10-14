import importlib.util
import json
from pathlib import Path
import resource
import subprocess
import sys
import time
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
ENDPOINT = "user/starred/cli/cli"


def helper_reads(profile=False):
    spec = importlib.util.spec_from_file_location("github_star", ROOT / "helpers/github_star.py")
    star = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(star)
    real_connection = star.http.client.HTTPSConnection
    real_run = star.subprocess.run
    phases = {}
    connections = []

    def auth_run(*args, **kwargs):
        start = time.perf_counter() if profile else 0
        result = real_run(*args, **kwargs)
        if profile:
            phases["auth_seconds"] = time.perf_counter() - start
        return result

    class ReadOnlyConnection(real_connection):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            self.statuses = []
            self.sockets = []
            self.connects = 0
            self.requests = 0
            connections.append(self)

        def connect(self):
            start = time.perf_counter() if profile else 0
            super().connect()
            self.connects += 1
            if profile:
                phases["connect_tls_seconds"] = time.perf_counter() - start

        def request(self, method, url, body=None, headers=None, **kwargs):
            if url != "/" + ENDPOINT or method not in ("GET", "PUT", "DELETE"):
                raise AssertionError("unexpected request")
            self.requests += 1
            start = time.perf_counter() if profile else 0
            super().request("GET", url, body=body, headers=headers, **kwargs)
            self.sockets.append(self.sock)
            if profile:
                phases[f"request_{self.requests}_seconds"] = time.perf_counter() - start
                self.response_start = time.perf_counter()

        def getresponse(self):
            response = super().getresponse()
            self.statuses.append(response.status)
            if profile:
                original_read = response.read
                def read(*args, **kwargs):
                    result = original_read(*args, **kwargs)
                    phases[f"response_{self.requests}_seconds"] = time.perf_counter() - self.response_start
                    return result
                response.read = read
            return response

    star.subprocess.run = auth_run
    star.http = SimpleNamespace(client=SimpleNamespace(HTTPSConnection=ReadOnlyConnection,
                                                      HTTPException=star.http.client.HTTPException))
    usage_before = resource.getrusage(resource.RUSAGE_SELF)
    child_before = resource.getrusage(resource.RUSAGE_CHILDREN)
    start = time.perf_counter()
    result = star.toggle("cli/cli")
    elapsed = time.perf_counter() - start
    assert len(connections) == 1, "proxy or auth failure prevented the direct read experiment"
    connection = connections[0]
    assert connection.statuses == [404, 404], connection.statuses
    assert connection.connects == 1
    assert connection.sockets[0] is connection.sockets[1]
    assert result == {"kind": "failed"}, result
    usage_after = resource.getrusage(resource.RUSAGE_SELF)
    child_after = resource.getrusage(resource.RUSAGE_CHILDREN)
    print(json.dumps({"statuses": connection.statuses, "actual_methods": ["GET", "GET"],
                      "connections": connection.connects, "socket_reused": True,
                      "toggle_seconds": elapsed, "phases": phases,
                      "cpu_user_seconds": usage_after.ru_utime - usage_before.ru_utime + child_after.ru_utime - child_before.ru_utime,
                      "cpu_system_seconds": usage_after.ru_stime - usage_before.ru_stime + child_after.ru_stime - child_before.ru_stime}))


def gh_reads():
    statuses = []
    for _ in range(2):
        result = subprocess.run(["gh", "api", "--silent", ENDPOINT],
                                stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, timeout=10)
        assert result.returncode == 1 and "HTTP 404" in result.stderr, "unexpected gh GET result"
        statuses.append(404)
    return {"statuses": statuses, "actual_methods": ["GET", "GET"]}


def sample(kind, profile=False):
    start = time.perf_counter()
    if kind == "gh":
        result = gh_reads()
    else:
        run = subprocess.run(["/usr/bin/python3", "-I", "-S", __file__, "profile" if profile else "helper"],
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=20)
        assert run.returncode == 0, "read-only helper probe failed"
        result = json.loads(run.stdout)
    result.update(kind=kind, seconds=time.perf_counter() - start)
    return result


if __name__ == "__main__":
    if sys.argv[1:] in (["helper"], ["profile"]):
        helper_reads(sys.argv[1] == "profile")
    else:
        output = Path(sys.argv[1]) if sys.argv[1:] else Path("/tmp/star-readonly-reuse-results.json")
        assert not output.exists(), "choose a fresh output path"
        profile = sample("helper", profile=True)
        gh_reads()
        samples = []
        for round_number in range(1, 11):
            for kind in ["gh", "helper"]:
                result = sample(kind)
                result["round"] = round_number
                samples.append(result)
                print(json.dumps(result), flush=True)
        artifact = {"endpoint": ENDPOINT, "profile_excluded": profile,
                    "samples": samples, "live_writes": 0,
                    "gh_version": subprocess.run(["gh", "--version"], stdout=subprocess.PIPE, text=True, check=True).stdout.splitlines()[0]}
        with output.open("x") as stream:
            stream.write(json.dumps(artifact, indent=2) + "\n")
