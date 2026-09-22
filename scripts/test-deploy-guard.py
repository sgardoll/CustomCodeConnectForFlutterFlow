#!/usr/bin/env python3
"""Checks the deploy guard that keeps a half-built dist/ off production.

The FTP mirror prunes any remote file with no local counterpart, so deploying a
dist/index.html that names a bundle nobody built uploads the broken HTML *and*
deletes the bundle currently serving the site. dist/index.html is tracked while
dist/assets/ is gitignored, so a fresh clone reaches that state just by
skipping `npm run build`.

Run: python3 scripts/test-deploy-guard.py
"""
import importlib.util
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def load_deploy_module():
    spec = importlib.util.spec_from_file_location(
        "deploy_ftp", REPO_ROOT / "scripts" / "deploy_ftp.py",
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def expected_absent_bundles(deploy, html):
    """The absent bundle paths the guard must report for this document.

    Every assets/index-* reference in the HTML, rewritten to a hash nobody
    built, in the order missing_referenced_assets returns them. Derived from
    the document itself so the case holds however many bundles the build
    emits - the redesign adds a CSS bundle beside the JS one, and hard-coding
    a single expected file is exactly what broke the test on those branches.
    """
    rewritten = set()
    for pattern in (deploy.ASSET_REFERENCE, deploy.CSS_URL_REFERENCE):
        for match in pattern.finditer(html):
            ref = match.group("path").strip()
            if ref.startswith(("#", "//")) or deploy.URI_SCHEME.match(ref):
                continue
            rel = ref.split("?", 1)[0].split("#", 1)[0].lstrip("/")
            if rel.startswith("assets/index-"):
                rewritten.add(
                    rel.replace("assets/index-", "assets/index-absent-", 1)
                )
    return sorted(rewritten)


def main():
    deploy = load_deploy_module()
    built_html = (deploy.DIST / "index.html").read_text(encoding="utf-8")
    absent_html = built_html.replace("assets/index-", "assets/index-absent-")

    cases = [
        (
            "the committed dist references only files that exist",
            built_html,
            [],
        ),
        (
            "a bundle hash with no built file is caught",
            absent_html,
            expected_absent_bundles(deploy, built_html),
        ),
        (
            "external, protocol-relative, data and anchor refs are ignored",
            '<a href="#top"></a>'
            '<script src="https://cdn.tailwindcss.com"></script>'
            '<link href="//fonts.gstatic.com/x.css">'
            '<img src="data:image/png;base64,AA">'
            '<a href="mailto:someone@example.com">mail</a>',
            [],
        ),
        (
            "a query string does not hide a file that exists",
            '<script src="/assets/PLACEHOLDER?v=2"></script>',
            [],
        ),
        (
            "a relative reference is checked too",
            '<script src="assets/never-built.js"></script>',
            ["assets/never-built.js"],
        ),
        (
            "single-quoted attributes are checked",
            "<script src='/assets/never-built-2.js'></script>",
            ["assets/never-built-2.js"],
        ),
        # The stylesheet is inline, so the built font is reachable only through
        # CSS url() - a colon, not an `=`. Missing it would let the mirror prune
        # the production font while the guard stayed silent.
        (
            "a missing font in CSS url() is caught",
            "<style>@font-face{font-family:D;src:url('/assets/never-built.ttf');}</style>",
            ["assets/never-built.ttf"],
        ),
        (
            "an unquoted CSS url() is checked",
            "<style>@font-face{src:url(/assets/never-built-3.ttf);}</style>",
            ["assets/never-built-3.ttf"],
        ),
        (
            "SVG fragment and data: url() are ignored",
            "<style>.a{fill:url(#gem-grad)}"
            ".b{background:url(\"data:image/svg+xml,%3Csvg%3E%3C/svg%3E\")}</style>",
            [],
        ),
    ]

    # Resolve the real bundle name for the query-string case.
    real_bundle = next(
        (p.name for p in (deploy.DIST / "assets").glob("index-*.js")), None,
    )
    if real_bundle is None:
        sys.exit("No built bundle in dist/assets/. Run `npm run build` first.")

    failures = []
    for name, document, expected in cases:
        document = document.replace("PLACEHOLDER", real_bundle)
        actual = deploy.missing_referenced_assets(document)
        ok = actual == expected

        print(f"{'PASS' if ok else 'FAIL'}  {name}")
        if not ok:
            failures.append(f"{name}: expected {expected}, got {actual}")

    if failures:
        print("\n" + "\n".join(failures))
        sys.exit(1)
    print(f"\n{len(cases)}/{len(cases)} passed")


if __name__ == "__main__":
    main()
