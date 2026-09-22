#!/usr/bin/env python3
import os
import re
import sys

DIST_DIR = "dist"
PATTERNS = {
    "api.groq.com endpoint": re.compile(r"api\.groq\.com"),
    "apiKey assignment": re.compile(r"apiKey\s*[:=]\s*['\"][^'\"]+['\"]", re.IGNORECASE),
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
            for label, pattern in PATTERNS.items():
                for match in pattern.finditer(content):
                    snippet = content[max(0, match.start()-20):match.end()+20].replace("\n", " ")
                    leaks.append((path, label, snippet))

    if leaks:
        print("FAIL: Potential provider API key/endpoint leak detected in dist/", file=sys.stderr)
        for path, label, snippet in leaks:
            print(f"  {path} [{label}]: {snippet}", file=sys.stderr)
        return 1

    print("No API key/endpoint leaks found.")
    return 0

if __name__ == "__main__":
    sys.exit(main())
