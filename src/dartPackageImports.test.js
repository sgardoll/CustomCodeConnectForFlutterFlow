import assert from "node:assert/strict";
import test from "node:test";
import {
  extractImportUris,
  extractPackageImports,
} from "./dartPackageImports.js";

test("detects a single third-party package import", () => {
  assert.deepEqual(
    extractPackageImports("import 'package:http/http.dart' as http;"),
    ["http"],
  );
});

test("detects the real packages from the reported deploy failure", () => {
  const code = [
    "import 'package:geolocator/geolocator.dart';",
    "import 'package:torch_light/torch_light.dart';",
    "import 'dart:convert';",
  ].join("\n");

  assert.deepEqual(extractPackageImports(code), ["geolocator", "torch_light"]);
});

test("deduplicates repeated imports of the same package", () => {
  const code = [
    "import 'package:http/http.dart' as http;",
    "import 'package:http/io_client.dart';",
  ].join("\n");

  assert.deepEqual(extractPackageImports(code), ["http"]);
});

test("ignores dart: sdk and FlutterFlow-managed local imports", () => {
  const code = [
    "import 'dart:convert';",
    "import 'dart:async';",
    "import '/flutter_flow/flutter_flow_theme.dart';",
    "import '/custom_code/actions/other_action.dart';",
  ].join("\n");

  assert.deepEqual(extractPackageImports(code), []);
});

test("ignores Flutter SDK packages that need no pubspec entry", () => {
  const code = [
    "import 'package:flutter/material.dart';",
    "import 'package:flutter_test/flutter_test.dart';",
  ].join("\n");

  assert.deepEqual(extractPackageImports(code), []);
});

test("returns an empty list for code with no package imports", () => {
  assert.deepEqual(extractPackageImports("Future<void> doThing() async {}"), []);
});

test("ignores an import mentioned only in a line comment", () => {
  const code = [
    "// import 'package:torch_light/torch_light.dart';",
    "Future<void> doThing() async {}",
  ].join("\n");

  assert.deepEqual(extractPackageImports(code), []);
});

test("ignores an import mentioned only in a block comment", () => {
  const code = [
    "/* import 'package:torch_light/torch_light.dart'; */",
    "Future<void> doThing() async {}",
  ].join("\n");

  assert.deepEqual(extractPackageImports(code), []);
});

test("reads every URI a directive carries, including conditional alternatives", () => {
  // `if (dart.library.io) 'x.dart'` selects another file the code needs, so
  // both URIs in the directive count.
  const code =
    "import 'package:public_api/public_api.dart' if (dart.library.io) 'package:private_types/private_types.dart';\n" +
    "export 'src/iface.dart' if (dart.library.html) 'package:web_impl/web_impl.dart';\n" +
    "class Conditional {}\n";

  assert.deepEqual(extractPackageImports(code), [
    "public_api",
    "private_types",
    "web_impl",
  ]);
  assert.deepEqual(extractImportUris(code), [
    "package:public_api/public_api.dart",
    "package:private_types/private_types.dart",
    "src/iface.dart",
    "package:web_impl/web_impl.dart",
  ]);
});

test("a conditional URI in a comment is not a dependency", () => {
  const code = [
    "// import 'package:a/a.dart' if (dart.library.io) 'package:b/b.dart';",
    "class Plain {}",
  ].join("\n");

  assert.deepEqual(extractPackageImports(code), []);
});

test("still detects a real import on the line after a comment mentioning a different package", () => {
  const code = [
    "// consider package:geocoding/geocoding.dart later",
    "import 'package:geolocator/geolocator.dart';",
  ].join("\n");

  assert.deepEqual(extractPackageImports(code), ["geolocator"]);
});
