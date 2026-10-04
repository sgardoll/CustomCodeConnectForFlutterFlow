function firstDeclaredClassName(content) {
  return String(content || "").match(/\bclass\s+([A-Z][A-Za-z0-9_]*)\b/)?.[1];
}

function classNameFromFileName(fileName) {
  return String(fileName || "")
    .split("/")
    .pop()
    .replace(/\.dart$/, "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function resolveClassName(fileName, info) {
  const candidates = [
    classNameFromFileName(fileName),
    firstDeclaredClassName(info.content),
    info.artifactName,
  ];
  const className = candidates.find((candidate) =>
    /^[A-Z][A-Za-z0-9_]*$/.test(String(candidate || "")),
  );
  if (!className) {
    throw new Error(
      `Cannot derive a FlutterFlow custom class name for ${fileName}.`,
    );
  }
  return className;
}

export function findMissingCodeFiles(fileMap, remoteFiles = new Map()) {
  const missing = [];

  for (const [fileName, info] of fileMap.entries()) {
    if (info.type !== "C" || remoteFiles.has(info.path)) continue;
    missing.push({
      artifactId: info.artifactId || fileName,
      className: resolveClassName(fileName, info),
      content: info.content,
      fileName,
      path: info.path,
    });
  }

  return missing;
}

/**
 * Splits the entries a provisioning request was writing by whether a fresh
 * project export now contains them. Used after a lost or expired response to
 * say what actually happened instead of leaving the outcome unknown.
 * @param {Array<{path: string}>} entries - Entries the request attempted
 * @param {Map<string, string>} remoteFiles - Fresh project export, by path
 * @returns {{landed: Array, notLanded: Array}}
 */
export function partitionProvisionedCodeFiles(entries, remoteFiles = new Map()) {
  const landed = [];
  const notLanded = [];
  for (const entry of entries) {
    (remoteFiles.has(entry.path) ? landed : notLanded).push(entry);
  }
  return { landed, notLanded };
}

export function excludeProvisionedCodeFiles(fileMap, entries) {
  const provisionedPaths = new Set(entries.map((entry) => entry.path));
  return new Map(
    Array.from(fileMap.entries()).filter(
      ([, info]) => !provisionedPaths.has(info.path),
    ),
  );
}

/**
 * Whether every class a provisioning request attempted is now present in the
 * project's fresh export. When true the classes have landed and only step 3 —
 * the pubspec push — remains, so the interrupted deploy is finishable without
 * re-running the slower class write.
 *
 * A missing partition is `false`, not a crash. The reconcile re-read can fail
 * or time out, and it then returns the caller's original error, which carries
 * no partition — so an absent partition is an ordinary outcome here, not an
 * impossible one. Treating it as un-finishable is also the safe answer: without
 * a proven partition we cannot claim every class landed.
 * @param {{landed: Array, notLanded: Array}|undefined|null} partition - Outcome
 *   of `partitionProvisionedCodeFiles`, when one could be taken
 * @returns {boolean}
 */
export function isDeployFinishable(partition) {
  if (!partition) return false;
  return partition.notLanded.length === 0 && partition.landed.length > 0;
}

/**
 * Builds the file map for a "finish deploy" — the step-3 push that completes
 * a deploy whose classes have already landed but whose provisioning response
 * was lost. The landed classes are excluded: they are already in the project,
 * so re-writing them would needlessly run the class/dependency handling they
 * just went through. The merged pubspec is added as the remaining entry. This
 * mirrors what the normal step-3 request already does, since it also excludes
 * classes the runner wrote (see `provisionMissingCodeFiles`).
 * @param {Map<string, Object>} fileMap - Entries a provisioning request was writing
 * @param {Array<{path: string}>} landedEntries - Entries confirmed present in the project
 * @param {string} serializedYaml - Merged pubspec.yaml to push
 * @returns {Map<string, Object>} The finish-push file map
 */
export function buildFinishPushFileMap(fileMap, landedEntries, serializedYaml) {
  const remaining = excludeProvisionedCodeFiles(fileMap, landedEntries);
  const out = new Map(remaining);
  out.set("pubspec.yaml", {
    content: serializedYaml,
    type: "D",
    path: "pubspec.yaml",
  });
  return out;
}
