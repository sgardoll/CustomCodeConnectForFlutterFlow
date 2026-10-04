import assert from "node:assert/strict";
import test from "node:test";
import {
  excludeProvisionedCodeFiles,
  findMissingCodeFiles,
  partitionProvisionedCodeFiles,
} from "./flutterFlowCodeFileProvisioning.js";

test("plans provisioning for a standalone code file missing from FlutterFlow", () => {
  const fileMap = new Map([
    [
      "pipedream_nfc_models.dart",
      {
        artifactId: "models",
        artifactName: "PipedreamNfcModels",
        content: "class PipedreamNfcModels {}",
        type: "C",
        path: "lib/custom_code/pipedream_nfc_models.dart",
      },
    ],
  ]);

  assert.deepEqual(findMissingCodeFiles(fileMap), [
    {
      artifactId: "models",
      className: "PipedreamNfcModels",
      content: "class PipedreamNfcModels {}",
      fileName: "pipedream_nfc_models.dart",
      path: "lib/custom_code/pipedream_nfc_models.dart",
    },
  ]);
});

test("does not provision a code file that already exists remotely", () => {
  const path = "lib/custom_code/pipedream_nfc_models.dart";
  const fileMap = new Map([
    [
      "pipedream_nfc_models.dart",
      {
        artifactName: "PipedreamNfcModels",
        content: "class PipedreamNfcModels {}",
        type: "C",
        path,
      },
    ],
  ]);

  assert.deepEqual(
    findMissingCodeFiles(fileMap, new Map([[path, "class OldModels {}"]])),
    [],
  );
});

test("falls back to the declared class name when the file name is not a Dart class name", () => {
  const fileMap = new Map([
    [
      "123_model.dart",
      {
        content: "class DeclaredModel {}",
        type: "C",
        path: "lib/custom_code/123_model.dart",
      },
    ],
  ]);

  assert.equal(findMissingCodeFiles(fileMap)[0].className, "DeclaredModel");
});

test("derives the provisioning name from the expected file path", () => {
  const fileMap = new Map([
    [
      "pipedream_nfc_models.dart",
      {
        artifactName: "Pipedream NFC models",
        content: "class PipedreamResponse {}",
        type: "C",
        path: "lib/custom_code/pipedream_nfc_models.dart",
      },
    ],
  ]);

  assert.equal(
    findMissingCodeFiles(fileMap)[0].className,
    "PipedreamNfcModels",
  );
});

test("excludes provisioned code files from the subsequent custom-code sync", () => {
  const entries = [
    {
      fileName: "pipedream_nfc_models.dart",
      path: "lib/custom_code/pipedream_nfc_models.dart",
    },
  ];
  const fileMap = new Map([
    [
      "pipedream_nfc_models.dart",
      {
        type: "C",
        path: "lib/custom_code/pipedream_nfc_models.dart",
      },
    ],
    [
      "read_nfc_tag.dart",
      {
        type: "A",
        path: "lib/custom_code/actions/read_nfc_tag.dart",
      },
    ],
  ]);

  assert.deepEqual(
    Array.from(excludeProvisionedCodeFiles(fileMap, entries).keys()),
    ["read_nfc_tag.dart"],
  );
});

test("partitionProvisionedCodeFiles splits attempted entries by fresh export", () => {
  const attempted = [
    { className: "Alpha", path: "lib/custom_code/alpha.dart" },
    { className: "Beta", path: "lib/custom_code/beta.dart" },
  ];
  const remote = new Map([["lib/custom_code/alpha.dart", "class Alpha {}"]]);

  const { landed, notLanded } = partitionProvisionedCodeFiles(attempted, remote);

  assert.deepEqual(landed.map((e) => e.className), ["Alpha"]);
  assert.deepEqual(notLanded.map((e) => e.className), ["Beta"]);
  assert.deepEqual(
    partitionProvisionedCodeFiles(attempted).notLanded.length,
    2,
  );
});
