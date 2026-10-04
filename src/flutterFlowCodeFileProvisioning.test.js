import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFinishPushFileMap,
  excludeProvisionedCodeFiles,
  findMissingCodeFiles,
  isDeployFinishable,
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

test("isDeployFinishable is true only when every attempted class landed", () => {
  const allLanded = partitionProvisionedCodeFiles(
    [
      { className: "Alpha", path: "lib/custom_code/alpha.dart" },
      { className: "Beta", path: "lib/custom_code/beta.dart" },
    ],
    new Map([
      ["lib/custom_code/alpha.dart", "class Alpha {}"],
      ["lib/custom_code/beta.dart", "class Beta {}"],
    ]),
  );
  assert.equal(isDeployFinishable(allLanded), true);

  const partlyLanded = partitionProvisionedCodeFiles(
    [
      { className: "Alpha", path: "lib/custom_code/alpha.dart" },
      { className: "Beta", path: "lib/custom_code/beta.dart" },
    ],
    new Map([["lib/custom_code/alpha.dart", "class Alpha {}"]]),
  );
  assert.equal(isDeployFinishable(partlyLanded), false);

  const nothingLanded = partitionProvisionedCodeFiles(
    [{ className: "Alpha", path: "lib/custom_code/alpha.dart" }],
    new Map(),
  );
  assert.equal(isDeployFinishable(nothingLanded), false);
});

// DONE CRITERION (client): a deploy whose step-2 response is lost must still
// be finishable — the classes are present and the finish action pushes the
// pubspec without re-provisioning them. These tests drive the exact pure
// decision path app.js uses after a timed-out provision: the re-read splits
// the attempted entries, finishability comes from all of them landing, and
// the finish file map carries only the merged pubspec.
test("finish action after an all-landed reconcile pushes the pubspec only", () => {
  const alphaPath = "lib/custom_code/alpha.dart";
  const fileMap = new Map([
    [
      "alpha.dart",
      {
        artifactName: "AlphaGen",
        content: "class AlphaGen {}",
        type: "C",
        path: alphaPath,
      },
    ],
  ]);
  const mergedYaml = "name: app\ndependencies:\n  intl: ^0.19.0\n";

  // Step 2's response was lost; a fresh project export shows the class landed.
  const partition = partitionProvisionedCodeFiles(
    [
      { className: "AlphaGen", path: alphaPath },
    ],
    new Map([[alphaPath, "class AlphaGen {}"]]),
  );

  assert.equal(isDeployFinishable(partition), true);

  const finishMap = buildFinishPushFileMap(
    fileMap,
    partition.landed,
    mergedYaml,
  );

  // The pubspec is present and is the merged yaml (the pubspec push happens)...
  assert.deepEqual(Array.from(finishMap.keys()), ["pubspec.yaml"]);
  assert.deepEqual(finishMap.get("pubspec.yaml"), {
    content: mergedYaml,
    type: "D",
    path: "pubspec.yaml",
  });
  // ...and the landed class is not re-provisioned (absent from the sync map).
  assert.equal(finishMap.has("alpha.dart"), false);
});

test("finish file map excludes every landed class but keeps not-yet-landed ones", () => {
  const alphaPath = "lib/custom_code/alpha.dart";
  const betaPath = "lib/custom_code/beta.dart";
  const fileMap = new Map([
    [
      "alpha.dart",
      { type: "C", path: alphaPath },
    ],
    [
      "beta.dart",
      { type: "C", path: betaPath },
    ],
  ]);

  const partition = partitionProvisionedCodeFiles(
    [{ path: alphaPath }, { path: betaPath }],
    new Map([[alphaPath, "class Alpha {}"]]),
  );

  const finishMap = buildFinishPushFileMap(
    fileMap,
    partition.landed,
    "name: app\n",
  );

  // The landed class is excluded; the not-yet-landed one stays so a retry can
  // still finish it, and the pubspec is added.
  assert.deepEqual(Array.from(finishMap.keys()).sort(), [
    "beta.dart",
    "pubspec.yaml",
  ]);
});

