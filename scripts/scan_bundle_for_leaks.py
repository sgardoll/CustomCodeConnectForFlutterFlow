#!/usr/bin/env python3
import os
import re
import sys

DIST_DIR = "dist"

# The PHP proxies under dist/api/ exist to forward same-origin browser calls
# to the provider endpoints, so naming an endpoint there is the architecture,
# not a leak. Everywhere else in the bundle a provider endpoint means client
# code is calling the provider directly - the credential exposure those
# proxies exist to prevent - so the endpoint patterns skip only that
# directory.
PROXY_DIR = os.path.join(DIST_DIR, "api")

# Every provider the app supports. The shipped client must reach all of them
# through the same-origin proxies, never by naming the provider's host.
ENDPOINT_PATTERNS = {
    "Groq endpoint": re.compile(r"api\.groq\.com"),
    "Google Gemini endpoint": re.compile(r"generativelanguage\.googleapis\.com"),
    "Anthropic endpoint": re.compile(r"api\.anthropic\.com"),
    "OpenAI endpoint": re.compile(r"api\.openai\.com"),
    "OpenRouter endpoint": re.compile(r"openrouter\.ai"),
}

# An identifier naming a credential (`apiKey`, `api_key`, `x-api-key`,
# `VITE_GEMINI_API_KEY`, `apiSecret`, ...) assigned a quoted string literal,
# in either `key: "value"` or `KEY="value"` form. The value must be at least
# 8 characters so empty placeholders like `apiKey: ""` do not trip the gate.
KEY_ASSIGNMENT = (
    r"[A-Za-z0-9_$-]*api[_-]?(?:key|secret)[A-Za-z0-9_$-]*['\"]?"
    r"\s*[:=]\s*['\"][^'\"\s]{8,}['\"]"
)

# Credential literals, matched by shape rather than by the property they are
# assigned to, so provider-specific or minified identifiers cannot hide them.
# A key baked into the bundle at build time (e.g. via a `define` replacement)
# carries no identifier, so only its format gives it away. The sk- prefix is
# anchored so ordinary kebab-case text ("task-...") does not match; a real
# key is a leak anywhere in dist/, the proxies included.
PROVIDER_KEY_FORMATS = {
    "OpenAI API key": re.compile(
        r"(?<![A-Za-z0-9])sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}"
    ),
    "OpenRouter API key": re.compile(r"sk-or-(?:v1-)?[A-Za-z0-9_-]{20,}"),
    "Anthropic API key": re.compile(r"sk-ant-[A-Za-z0-9_-]{20,}"),
    "Google API key": re.compile(r"AIza[0-9A-Za-z_-]{30,}"),
    "Groq API key": re.compile(r"gsk_[0-9A-Za-z]{20,}"),
    "Stripe secret key": re.compile(r"(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}"),
}

# Key material is checked in every bundled file, client or server-side alike:
# a credential does not belong in a shipped artifact wherever it sits.
KEY_PATTERNS = {
    "API key/secret assignment": re.compile(KEY_ASSIGNMENT, re.IGNORECASE),
    **PROVIDER_KEY_FORMATS,
}


def patterns_for(path):
    """The checks a file in dist/ must pass.

    Credential shapes are never legitimate anywhere. Endpoints are legitimate
    only inside the proxy directory, whose whole job is naming its upstream.
    """
    checks = dict(KEY_PATTERNS)
    if os.path.dirname(path) != PROXY_DIR:
        checks.update(ENDPOINT_PATTERNS)
    return checks


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
            for label, pattern in patterns_for(path).items():
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
