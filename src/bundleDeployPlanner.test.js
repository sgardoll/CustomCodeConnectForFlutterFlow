import assert from "node:assert/strict";
import test from "node:test";
import { buildBundleDeployPlan } from "./bundleDeployPlanner.js";

test("builds deploy entries in deploy order", () => {
  const plan = buildBundleDeployPlan({
    id: "bundle-a",
    deployOrder: ["class-a", "widget-a"],
    artifacts: [
      {
        id: "widget-a",
        artifactType: "CustomWidget",
        artifactName: "WidgetA",
        fileName: "widget_a.dart",
        code: "class WidgetA extends StatelessWidget {}",
      },
      {
        id: "class-a",
        artifactType: "CustomClass",
        artifactName: "ModelA",
        fileName: "model_a.dart",
        code: "class ModelA {}",
      },
    ],
  });

  assert.deepEqual(plan.fileEntries.map((entry) => entry.artifactId), ["class-a", "widget-a"]);
  assert.equal(plan.fileEntries[0].type, "C");
  assert.equal(plan.fileEntries[0].path, "lib/custom_code/model_a.dart");
  assert.equal(plan.fileEntries[1].path, "lib/custom_code/widgets/widget_a.dart");
});

test("merges bundle and artifact dependencies", () => {
  const plan = buildBundleDeployPlan({
    dependencies: [{ name: "intl", version: "^0.20.0" }],
    artifacts: [
      {
        id: "action-a",
        artifactType: "CustomAction",
        artifactName: "loadThing",
        fileName: "load_thing.dart",
        code: "Future loadThing() async {}",
        dependencies: [{ package: "http" }],
      },
    ],
  });

  // An unflagged version is advisory only — the deploy resolves the real one
  // against the project's own pubspec — and a dependency without a version is
  // the normal case, not a warning.
  assert.deepEqual(plan.dependencies, { intl: "", http: "" });
  assert.deepEqual(plan.warnings, []);
});

test("carries through only a version the generator flagged as required", () => {
  const plan = buildBundleDeployPlan({
    artifacts: [
      {
        id: "action-a",
        artifactType: "CustomAction",
        artifactName: "loadThing",
        fileName: "load_thing.dart",
        code: "Future loadThing() async {}",
        dependencies: [
          { package: "intl", version: "^0.20.0", versionRequired: true },
          { package: "http", version: "^1.2.0" },
        ],
      },
    ],
  });

  assert.deepEqual(plan.dependencies, { intl: "^0.20.0", http: "" });
});

test("gives a package found only in the code no invented version", () => {
  const plan = buildBundleDeployPlan({
    artifacts: [
      {
        id: "action-a",
        artifactType: "CustomAction",
        artifactName: "record",
        fileName: "record_audio.dart",
        code: "import 'package:record/record.dart';\nFuture recordAudio() async {}",
      },
    ],
  });

  assert.deepEqual(plan.dependencies, { record: "" });
});

test("uses FlutterFlow custom functions file for function artifacts", () => {
  const plan = buildBundleDeployPlan({
    artifacts: [
      {
        id: "function-a",
        artifactType: "CustomFunction",
        artifactName: "formatThing",
        code: "String formatThing() => '';",
      },
    ],
  });

  assert.equal(plan.fileEntries[0].fileName, "custom_functions.dart");
  assert.equal(plan.fileEntries[0].path, "lib/flutter_flow/custom_functions.dart");
  assert.equal(plan.fileEntries[0].type, "F");
});

test("merges multiple function artifacts into the shared custom_functions.dart", () => {
  const plan = buildBundleDeployPlan({
    artifacts: [
      {
        id: "function-a",
        artifactType: "CustomFunction",
        artifactName: "formatA",
        code: "String formatA() => '';",
      },
      {
        id: "function-b",
        artifactType: "CustomFunction",
        artifactName: "formatB",
        code: "String formatB() => '';",
      },
    ],
  });

  assert.equal(plan.fileEntries.length, 1);
  assert.equal(plan.fileEntries[0].fileName, "custom_functions.dart");
  assert.equal(plan.fileEntries[0].path, "lib/flutter_flow/custom_functions.dart");
  assert.match(plan.fileEntries[0].content, /formatA/);
  assert.match(plan.fileEntries[0].content, /formatB/);
  assert.equal(plan.errors.length, 0);
});

test("honors an explicit deployPath and still flags true duplicate targets", () => {
  const plan = buildBundleDeployPlan({
    artifacts: [
      {
        id: "widget-a",
        artifactType: "CustomWidget",
        artifactName: "WidgetA",
        fileName: "widget_a.dart",
        deployPath: "lib/custom_code/actions/override_a.dart",
        code: "class WidgetA extends StatelessWidget {}",
      },
      {
        id: "widget-b",
        artifactType: "CustomWidget",
        artifactName: "WidgetB",
        fileName: "widget_b.dart",
        deployPath: "lib/custom_code/actions/override_a.dart",
        code: "class WidgetB extends StatelessWidget {}",
      },
    ],
  });

  assert.equal(plan.fileEntries[0].path, "lib/custom_code/actions/override_a.dart");
  assert.equal(plan.errors.length, 1);
  assert.match(plan.errors[0], /Duplicate deploy path/);
});

test("prefers artifact.fixedCode over artifact.code for deploy content", () => {
  const plan = buildBundleDeployPlan({
    artifacts: [
      {
        id: "widget-a",
        artifactType: "CustomWidget",
        artifactName: "WidgetA",
        fileName: "widget_a.dart",
        code: "class WidgetA extends StatelessWidget { main() {} }",
        fixedCode: "class WidgetA extends StatelessWidget {}",
      },
    ],
  });

  assert.equal(plan.fileEntries[0].content, "class WidgetA extends StatelessWidget {}");
});

test("discovers dependencies from fixedCode, the content actually deployed", () => {
  // A review fix can add an import the original code never had; scanning only
  // `code` would deploy the import while omitting its package.
  const plan = buildBundleDeployPlan({
    artifacts: [
      {
        id: "widget-a",
        artifactType: "CustomWidget",
        artifactName: "WidgetA",
        fileName: "widget_a.dart",
        code: "class WidgetA extends StatelessWidget {}",
        fixedCode:
          "import 'package:http/http.dart';\nclass WidgetA extends StatelessWidget {}",
      },
    ],
  });

  assert.equal(plan.dependencies.http, "");
});

test("falls back to artifact.code when fixedCode is absent", () => {
  const plan = buildBundleDeployPlan({
    artifacts: [
      {
        id: "widget-a",
        artifactType: "CustomWidget",
        artifactName: "WidgetA",
        fileName: "widget_a.dart",
        code: "class WidgetA extends StatelessWidget {}",
      },
    ],
  });

  assert.equal(plan.fileEntries[0].content, "class WidgetA extends StatelessWidget {}");
});
