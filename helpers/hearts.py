#!/usr/bin/python3
"""Record a marketplace heart id in the shared cache file.

Both plugin surfaces (popup and expanded) read this file, so a heart sent
from one is never posted again from the other. Usage:
    hearts.py <cache-file> <plugin-id>
Prints one JSON object: {"kind": "saved"}, {"kind": "already"} or
{"kind": "failed"}. Appends only, so concurrent writers never lose an id.
"""
import json
import os
import re
import sys

PLUGIN_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z")
RESERVED = frozenset({"__proto__", "constructor", "prototype"})
MAX_IDS = 65536
MAX_BYTES = 4 * 1024 * 1024


def valid_id(value):
    return (isinstance(value, str) and PLUGIN_ID.fullmatch(value) is not None
            and value.lower() not in RESERVED)


def record(path, plugin_id):
    if not valid_id(plugin_id):
        return {"kind": "failed"}
    if not isinstance(path, str) or not path or "\0" in path:
        return {"kind": "failed"}
    try:
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        try:
            with open(path, "r", encoding="utf-8", errors="strict") as handle:
                raw = handle.read(MAX_BYTES + 1)
        except FileNotFoundError:
            raw = ""
        if len(raw) > MAX_BYTES:
            return {"kind": "failed"}
        seen = set()
        for line in raw.split("\n"):
            item = line[:-1] if line.endswith("\r") else line
            if valid_id(item) and item not in seen:
                seen.add(item)
                if len(seen) >= MAX_IDS:
                    break
        if plugin_id in seen:
            return {"kind": "already"}
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(plugin_id + "\n")
        return {"kind": "saved"}
    except OSError:
        return {"kind": "failed"}


def main(args):
    result = record(args[0], args[1]) if len(args) == 2 else {"kind": "failed"}
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    main(sys.argv[1:])
