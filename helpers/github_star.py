import http.client
import json
import os
import re
import ssl
import subprocess
import sys


def toggle_with_gh(slug):
    command = ["gh", "api", "--hostname", "github.com", "--silent"]
    endpoint = "user/starred/" + slug
    try:
        check = subprocess.run(command + [endpoint], stdout=subprocess.DEVNULL,
                               stderr=subprocess.PIPE, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return {"kind": "fallback"}
    if check.returncode == 0:
        starred = False
    elif re.search(r"\bHTTP 404\b", check.stderr):
        starred = True
    else:
        return {"kind": "fallback"}
    try:
        write = subprocess.run(command + ["-X", "PUT" if starred else "DELETE", endpoint],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return {"kind": "failed"}
    return {"kind": "changed", "starred": starred} if write.returncode == 0 else {"kind": "failed"}


def toggle(slug):
    if not isinstance(slug, str) or not re.fullmatch(r"[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/[A-Za-z0-9._-]+", slug):
        return {"kind": "failed"}
    owner, repo = slug.split("/")
    if len(owner) > 39 or len(repo) > 100 or repo in (".", ".."):
        return {"kind": "failed"}
    # gh owns proxy and NO_PROXY precedence, which differs from Python's.
    if any(os.environ.get(key) for key in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy")):
        return toggle_with_gh(slug)

    try:
        auth = subprocess.run(["gh", "auth", "token", "--hostname", "github.com"],
                              stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                              text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return {"kind": "fallback"}
    token = auth.stdout.strip()
    if auth.returncode != 0 or not token:
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
        response.read()
        if response.status not in (204, 404):
            return {"kind": "fallback"}
        starred = response.status == 404
        failure = "failed"
        headers["Content-Length"] = "0"
        connection.request("PUT" if starred else "DELETE", endpoint, headers=headers)
        response = connection.getresponse()
        response.read()
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
