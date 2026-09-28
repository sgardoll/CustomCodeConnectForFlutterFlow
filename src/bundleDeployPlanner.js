import { extractPackageImports } from "./dartPackageImports.js";

const CODE_TYPE = {
  ACTION: "A",
  WIDGET: "W",
  FUNCTION: "F",
  // Standalone custom code file, e.g. a plain Dart class. Missing files are
  // provisioned first, then synced with actions and widgets.
  CODE_FILE: "C",
  DEPENDENCIES: "D",
  OTHER: "O",
};

const ARTIFACT_TYPE_TO_CODE_TYPE = {
  CustomAction: CODE_TYPE.ACTION,
  CustomWidget: CODE_TYPE.WIDGET,
  CustomFunction: CODE_TYPE.FUNCTION,
  CustomClass: CODE_TYPE.CODE_FILE,
  CodeFile: CODE_TYPE.CODE_FILE,
};

export function getBundleFilePath(fileName, codeType) {
  switch (codeType) {
    case CODE_TYPE.ACTION:
      return `lib/custom_code/actions/${fileName}`;
    case CODE_TYPE.WIDGET:
      return `lib/custom_code/widgets/${fileName}`;
    case CODE_TYPE.FUNCTION:
      return "lib/flutter_flow/custom_functions.dart";
    case CODE_TYPE.CODE_FILE:
      // Standalone custom code files live flat under lib/custom_code/, never in
      // a subfolder.
      return `lib/custom_code/${fileName}`;
    case CODE_TYPE.DEPENDENCIES:
      return "pubspec.yaml";
    case CODE_TYPE.OTHER:
      return `lib/custom_code/${fileName}`;
    default:
      return fileName;
  }
}

function toFileName(artifact) {
  if (artifact.artifactType === "CustomFunction") return "custom_functions.dart";
  const source = artifact.fileName || artifact.artifactName || artifact.id || "generated_code";
  return source.endsWith(".dart") ? source : `${source}.dart`;
}

// name -> the minimum version the code genuinely needs, or "" for "just make
// sure this package is there". A version is only carried through when the
// generating stage flagged it as required; otherwise the deploy picks the
// version, since a package the project already has should keep its own.
function toDependencyMap(dependencies = []) {
  return dependencies.reduce((acc, dependency) => {
    const name = dependency.name || dependency.package;
    if (!name || name === "flutter") return acc;
    const required = dependency.versionRequired || dependency.required;
    acc[name] = required ? dependency.version || "" : "";
    return acc;
  }, {});
}

function getDuplicateTargetErrors(fileEntries) {
  const seenFileNames = new Map();
  const seenPaths = new Map();
  const errors = [];

  for (const entry of fileEntries) {
    if (seenFileNames.has(entry.fileName)) {
      errors.push(`Duplicate deploy file name "${entry.fileName}" for artifacts "${seenFileNames.get(entry.fileName)}" and "${entry.artifactId}".`);
    } else {
      seenFileNames.set(entry.fileName, entry.artifactId);
    }

    if (seenPaths.has(entry.path)) {
      errors.push(`Duplicate deploy path "${entry.path}" for artifacts "${seenPaths.get(entry.path)}" and "${entry.artifactId}".`);
    } else {
      seenPaths.set(entry.path, entry.artifactId);
    }
  }

  return errors;
}

export function buildBundleDeployPlan(bundle, options = {}) {
  const artifacts = Array.isArray(bundle?.artifacts) ? bundle.artifacts : [];
  const selectedIds = options.selectedArtifactIds || bundle?.deployOrder || artifacts.map((artifact) => artifact.id);
  const selected = selectedIds
    .map((id) => artifacts.find((artifact) => artifact.id === id))
    .filter(Boolean);

  const warnings = [...(bundle?.warnings || [])];
  let fileEntries = [];

  selected.forEach((artifact) => {
    const fileName = toFileName(artifact);
    const content = artifact.fixedCode || artifact.code || "";
    const codeType = artifact.codeType || ARTIFACT_TYPE_TO_CODE_TYPE[artifact.artifactType] || CODE_TYPE.OTHER;
    if (!content.trim()) {
      warnings.push(`${artifact.artifactName || artifact.id} has no generated code.`);
    }
    fileEntries.push({
      artifactId: artifact.id,
      artifactName: artifact.artifactName,
      artifactType: artifact.artifactType,
      fileName,
      content,
      type: codeType,
      // An explicit deployPath from the pipeline contract wins; otherwise the
      // path is inferred from the artifact type.
      path: artifact.deployPath || getBundleFilePath(fileName, codeType),
      deployPath: artifact.deployPath || "",
      deployMode: "customCodeSync",
    });
  });

  // FlutterFlow keeps every custom function in the single shared file
  // lib/flutter_flow/custom_functions.dart. Multiple function artifacts must
  // merge into that one entry rather than colliding, which previously blocked
  // the deploy with a duplicate-path error or silently dropped functions.
  const SHARED_FUNCTIONS_PATH = "lib/flutter_flow/custom_functions.dart";
  const functionEntries = fileEntries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.type === CODE_TYPE.FUNCTION && entry.path === SHARED_FUNCTIONS_PATH);
  if (functionEntries.length > 1) {
    const first = functionEntries[0];
    const merged = {
      ...first.entry,
      artifactId: functionEntries.map(({ entry }) => entry.artifactId).join("+"),
      artifactName: first.entry.artifactName,
      content: functionEntries
        .map(({ entry }) => `// ${entry.artifactId}\n${entry.content}`)
        .join("\n\n"),
    };
    const laterIndexes = new Set(functionEntries.slice(1).map(({ index }) => index));
    fileEntries = fileEntries.filter((_, index) => !laterIndexes.has(index));
    fileEntries[first.index] = merged;
  }

  const declaredDependencies = {
    ...toDependencyMap(bundle?.dependencies),
    ...selected.reduce((acc, artifact) => ({
      ...acc,
      ...toDependencyMap(artifact.dependencies),
    }), {}),
  };

  // A declared dependency list can miss a package the code actually imports.
  // FlutterFlow rejects a push whose pubspec.yaml omits an imported package,
  // so every artifact's code is also scanned directly as a safety net.
  //
  // A detected package carries no version: the deploy resolves one against the
  // project's own pubspec and SDK. Naming a version here would be a guess, and
  // the guess this replaced (`^1.0.0`) pinned every package to its first major.
  const detectedDependencies = {};
  selected.forEach((artifact) => {
    // The same expression that fills the file entry above - an import added by
    // a review fix must be discovered like any other.
    extractPackageImports(artifact.fixedCode || artifact.code || "").forEach((name) => {
      if (!(name in declaredDependencies)) {
        detectedDependencies[name] = "";
      }
    });
  });

  const dependencies = { ...detectedDependencies, ...declaredDependencies };

  const errors = getDuplicateTargetErrors(fileEntries);

  return {
    bundleId: bundle?.id || "bundle-current",
    title: bundle?.title || "Generated artifact bundle",
    fileEntries,
    dependencies,
    relationships: bundle?.relationships || [],
    warnings,
    errors,
  };
}
