import glob
import http.client
import json
import os
import re
import ssl
import stat
import subprocess
import sys
import threading

SYSTEM_GH = "/usr/bin/gh"
MAX_STDERR_BYTES = 4096
MAX_TOKEN_BYTES = 4096
MAX_RESPONSE_BYTES = 65536


def trusted_gh(path):
    real = os.path.realpath(path)
    try:
        info = os.stat(real)
    except (OSError, ValueError):
        return None
    if (not stat.S_ISREG(info.st_mode) or info.st_uid not in (0, os.getuid())
            or info.st_mode & 0o022 or not info.st_mode & stat.S_IXUSR):
        return None
    return real


def resolve_gh():
    # gh receives the user's token, so only fixed install locations are trusted, never PATH or mise shims.
    candidates = [SYSTEM_GH]
    data = os.environ.get("XDG_DATA_HOME", "")
    if os.path.isabs(data):
        data = os.path.join(data, "mise")
    else:
        home = os.environ.get("HOME", "")
        data = os.path.join(home, ".local/share/mise") if os.path.isabs(home) else None
    if data:
        for link in ("global", "latest"):
            candidates += sorted(glob.glob(os.path.join(glob.escape(data), "installs/gh", link, "gh_*/bin/gh")))[:1]
    for candidate in candidates:
        real = trusted_gh(candidate)
        if real:
            return real
    return None


def gh_environment():
    allowed = ("HOME", "XDG_CONFIG_HOME", "GH_CONFIG_DIR", "HTTPS_PROXY", "https_proxy",
               "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy")
    environment = {key: os.environ[key] for key in allowed if os.environ.get(key)}
    environment.update({"PATH": "/usr/bin:/bin", "GH_PROMPT_DISABLED": "1", "LC_ALL": "C"})
    return environment


def run_gh(command, timeout):
    try:
        process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                   env=gh_environment(), cwd="/")
    except OSError:
        return None

    captured = bytearray()

    def drain_stderr():
        while True:
            chunk = process.stderr.read(4096)
            if not chunk:
                return
            remaining = MAX_STDERR_BYTES - len(captured)
            if remaining > 0:
                captured.extend(chunk[:remaining])

    reader = threading.Thread(target=drain_stderr, daemon=True)
    reader.start()
    try:
        code = process.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        try:
            process.kill()
        except ProcessLookupError:
            pass
        process.wait()
        code = None
    reader.join()
    return (code, captured.decode("utf-8", errors="replace"))


def read_gh_token():
    gh = resolve_gh()
    if gh is None:
        return None
    try:
        process = subprocess.Popen([gh, "auth", "token", "--hostname", "github.com"],
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   env=gh_environment(), cwd="/")
    except OSError:
        return None
    captured = bytearray()

    def drain_stdout():
        while True:
            chunk = process.stdout.read(4096)
            if not chunk:
                return
            remaining = MAX_TOKEN_BYTES + 1 - len(captured)
            if remaining > 0:
                captured.extend(chunk[:remaining])

    reader = threading.Thread(target=drain_stdout, daemon=True)
    reader.start()
    try:
        code = process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
        code = None
    reader.join()
    if code != 0 or len(captured) > MAX_TOKEN_BYTES:
        return None
    return captured.decode("utf-8", errors="replace").strip()


def toggle_with_gh(slug):
    gh = resolve_gh()
    if gh is None:
        return {"kind": "fallback"}
    command = [gh, "api", "--hostname", "github.com", "--silent"]
    endpoint = "user/starred/" + slug
    check = run_gh(command + [endpoint], 10)
    if check is None or check[0] is None:
        return {"kind": "fallback"}
    if check[0] == 0:
        starred = False
    elif re.search(r"\bHTTP 404\b", check[1]):
        starred = True
    else:
        return {"kind": "fallback"}
    write = run_gh(command + ["-X", "PUT" if starred else "DELETE", endpoint], 10)
    if write is None or write[0] is None:
        return {"kind": "failed"}
    return {"kind": "changed", "starred": starred} if write[0] == 0 else {"kind": "failed"}


def toggle(slug):
    if not isinstance(slug, str) or not re.fullmatch(r"[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/[A-Za-z0-9._-]+", slug):
        return {"kind": "failed"}
    owner, repo = slug.split("/")
    if len(owner) > 39 or len(repo) > 100 or repo in (".", ".."):
        return {"kind": "failed"}
    # gh owns proxy and NO_PROXY precedence, which differs from Python's.
    if any(os.environ.get(key) for key in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy")):
        return toggle_with_gh(slug)

    token = read_gh_token()
    if not token:
        return {"kind": "fallback"}

    connection = None
    failure = "fallback"
    try:
        connection = http.client.HTTPSConnection("api.github.com", timeout=5,
                                               context=ssl.create_default_context())
        headers = {"Authorization": "Bearer " + token,
                   "Accept": "application/vnd.github+json",
                   "User-Agent": "omarchy-plugin-manager",
                   "X-GitHub-Api-Version": "2022-11-28"}
        endpoint = "/user/starred/" + slug
        connection.request("GET", endpoint, headers=headers)
        response = connection.getresponse()
        if len(response.read(MAX_RESPONSE_BYTES + 1)) > MAX_RESPONSE_BYTES:
            return {"kind": "fallback"}
        if response.status not in (204, 404):
            return {"kind": "fallback"}
        starred = response.status == 404
        failure = "failed"
        headers["Content-Length"] = "0"
        connection.request("PUT" if starred else "DELETE", endpoint, headers=headers)
        response = connection.getresponse()
        if len(response.read(MAX_RESPONSE_BYTES + 1)) > MAX_RESPONSE_BYTES:
            return {"kind": "failed"}
        if response.status != 204:
            return {"kind": "failed"}
        return {"kind": "changed", "starred": starred}
    except (OSError, http.client.HTTPException, ValueError):
        return {"kind": failure}
    finally:
        if connection is not None:
            connection.close()


def main(args):
    result = toggle(args[0]) if len(args) == 1 else {"kind": "failed"}
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    main(sys.argv[1:])
