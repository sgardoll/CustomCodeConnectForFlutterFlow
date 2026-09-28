#!/usr/bin/env python3
import os
import re
import sys

DIST_DIR = "dist"

# Provider hosts the client must never call directly - provider traffic is
# expected to go through the app's own proxies, so a bare endpoint in a
# client-side asset means a key is going over the wire unproxied. The hosts
# legitimately appear inside the `api/*-proxy.php` files, which are the
# proxies, so these patterns only apply to files a browser executes.
CLIENT_FILE_SUFFIXES = (".js", ".html", ".css")

PROVIDER_ENDPOINTS = {
    "api.groq.com endpoint": r"api\.groq\.com",
    "api.openai.com endpoint": r"api\.openai\.com",
    "api.anthropic.com endpoint": r"api\.anthropic\.com",
    "generativelanguage.googleapis.com endpoint": r"generativelanguage\.googleapis\.com",
}

# An identifier naming a credential (`apiKey`, `api_key`, `x-api-key`,
# `VITE_GEMINI_API_KEY`, `apiSecret`, ...) assigned a quoted string literal,
# in either `key: "value"` or `KEY="value"` form. The value must be at least
# 8 characters so empty placeholders like `apiKey: ""` do not trip the gate.
KEY_ASSIGNMENT = (
    r"[A-Za-z0-9_$-]*api[_-]?(?:key|secret)[A-Za-z0-9_$-]*['\"]?"
    r"\s*[:=]\s*['\"][^'\"\s]{8,}['\"]"
)

# Credential shapes for the providers this app works with. A key baked into
# the bundle at build time (e.g. via a `define` replacement) carries no
# identifier, so only its format gives it away.
PROVIDER_KEY_FORMATS = {
    "Google API key": r"AIza[0-9A-Za-z_-]{35}",
    "Anthropic API key": r"sk-ant-[0-9A-Za-z_-]{20,}",
    "OpenAI API key": r"sk-(?:proj-|svcacct-)?[0-9A-Za-z_-]{20,}",
    "Groq API key": r"gsk_[0-9A-Za-z]{20,}",
    "Stripe secret key": r"(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}",
}

ENDPOINT_PATTERNS = {
    label: re.compile(body) for label, body in PROVIDER_ENDPOINTS.items()
}

# Key material is checked in every bundled file, client or server-side alike:
# a credential does not belong in a shipped artifact wherever it sits.
KEY_PATTERNS = {
    "API key/secret assignment": re.compile(KEY_ASSIGNMENT, re.IGNORECASE),
    **{label: re.compile(body) for label, body in PROVIDER_KEY_FORMATS.items()},
}


def main() -> int:
    if not os.path.isdir(DIST_DIR):
        print(f"{DIST_DIR}/ directory not found; skipping scan.")
        return 0

    leaks = []
    for root, _dirs, files in os.walk(DIST_DIR):
        for name in files:
            if name.endswith(".map"):
                continue
            path = os.path.join(root, name)
            try:
                with open(path, "r", encoding="utf-8", errors="replace") as f:
                    content = f.read()
            except OSError as e:
                print(f"WARN: could not read {path}: {e}", file=sys.stderr)
                continue
            patterns = dict(KEY_PATTERNS)
            if name.endswith(CLIENT_FILE_SUFFIXES):
                patterns.update(ENDPOINT_PATTERNS)
            for label, pattern in patterns.items():
                for match in pattern.finditer(content):
                    line_no = content.count("\n", 0, match.start()) + 1
                    leaks.append((path, line_no, label))

    if leaks:
        print(
            "FAIL: Potential provider API key/endpoint leak detected in dist/",
            file=sys.stderr,
        )
        # Report the location and which pattern hit, never the match itself:
        # a hit can contain the credential it detected, and CI logs persist.
        for path, line_no, label in sorted(set(leaks)):
            print(f"  {path}:{line_no} [{label}]", file=sys.stderr)
        return 1

    print("No API key/endpoint leaks found.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
