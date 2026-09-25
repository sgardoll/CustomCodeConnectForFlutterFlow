// Merges generated package requirements into a project's real pubspec.yaml.
//
// The FlutterFlow VS Code extension pushes the project's actual pubspec.yaml
// verbatim as `serialized_yaml`, and the backend treats that text as the
// complete dependency set. Anything the pushed file omits is dropped from the
// project, so a merge has to start from the file already in the project and
// edit it in place rather than rebuild it.
//
// The edit is textual on purpose: it keeps comments, ordering, SDK constraints,
// hosted/git/path dependency forms, and every other section byte-for-byte
// intact, which a parse-and-reserialize round trip would not.

// A top-level `dependencies:` key. YAML allows space before the colon and a
// trailing comment after it, both of which appear in hand-edited pubspecs.
const DEPENDENCIES_HEADER_PATTERN = /^dependencies\s*:\s*(?:#.*)?$/;

// A dependency name as it appears at the start of a block entry. Package names
// are plain identifiers, but YAML permits the key to be quoted.
const DEPENDENCY_NAME_PATTERN =
  /^(?:"([^"]+)"|'([^']+)'|([A-Za-z_][A-Za-z0-9_-]*))\s*:/;

function parseDependencyName(trimmedLine) {
  const match = trimmedLine.match(DEPENDENCY_NAME_PATTERN);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3];
}

function isBlankOrComment(line) {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith("#");
}

function indentOf(line) {
  const match = line.match(/^(\s*)/);
  return match ? match[1].length : 0;
}

/**
 * Locates a top-level block by its header pattern.
 * @param {string[]} lines - pubspec.yaml split into lines
 * @param {RegExp} headerPattern - Matches the block's header line
 * @returns {{headerIndex: number, endIndex: number, childIndent: string}|null}
 *   endIndex is exclusive and excludes trailing blank/comment lines.
 */
function findBlock(lines, headerPattern) {
  const headerIndex = lines.findIndex((line) => headerPattern.test(line));
  if (headerIndex === -1) return null;

  let endIndex = headerIndex + 1;
  let lastContentIndex = headerIndex;
  let childIndent = null;

  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (isBlankOrComment(line)) {
      endIndex = i + 1;
      continue;
    }
    // A non-indented line starts the next top-level section.
    if (indentOf(line) === 0) break;
    if (childIndent === null) childIndent = line.match(/^(\s*)/)[1];
    lastContentIndex = i;
    endIndex = i + 1;
  }

  return {
    headerIndex,
    endIndex: lastContentIndex + 1,
    childIndent: childIndent ?? "  ",
  };
}

function findDependenciesBlock(lines) {
  return findBlock(lines, DEPENDENCIES_HEADER_PATTERN);
}

/**
 * Splits a dependency line's value from any trailing comment, so rewriting the
 * version keeps the note explaining why it was pinned.
 * @param {string} rest - Everything after the `name:` key
 * @returns {{value: string, comment: string}}
 */
function splitValueAndComment(rest) {
  const text = rest ?? "";
  let i = 0;
  let quote = null;

  while (i < text.length) {
    const char = text[i];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === "#") {
      break;
    }
    i += 1;
  }

  return {
    value: text.slice(0, i).trim(),
    comment: text.slice(i) ? `  ${text.slice(i).trim()}` : "",
  };
}

/**
 * Reads the source key of a block-form dependency's own mapping.
 *
 * A block-form entry says where a package comes from on a following, more
 * deeply indented line: `sdk:`, `git:`, `path:`, a nested `hosted:`, or a
 * `version:` written on its own line. That key is the only thing that
 * distinguishes a package the Flutter SDK supplies from one the analysis
 * manifest cannot reproduce, so it is read here rather than guessed from the
 * package's name. A name list cannot work: it goes stale the moment the SDK
 * ships a package the list has not heard of, and every project declaring that
 * package then reads it as unreproducible.
 *
 * YAML mapping order is not significant, so `version:` may precede `hosted:`.
 * Every own-key is read and a source key (anything other than `version:`)
 * wins over a bare `version:`; a constraint only stands on its own when no
 * source accompanies it.
 *
 * @param {string[]} lines - pubspec.yaml split into lines
 * @param {number} entryIndex - Index of the dependency entry's own line
 * @param {number} endIndex - Exclusive end of the enclosing block
 * @param {number} parentIndent - Indent of the dependency entry itself
 * @returns {{key: string, value: string}|null} Source own-key, else the
 *   `version:` own-key, or null if the entry has no mapping below it
 */
function readSourceDirective(lines, entryIndex, endIndex, parentIndent) {
  let ownIndent = null;
  let version = null;
  for (let i = entryIndex + 1; i < endIndex; i += 1) {
    const line = lines[i];
    if (isBlankOrComment(line)) continue;
    const indent = indentOf(line);
    // Shallower or equal indent means the entry's mapping has ended and this is
    // a sibling dependency, so there is nothing of this entry's own to read.
    if (indent <= parentIndent) break;
    // The first mapping line fixes the own-key indent; anything deeper belongs
    // to one of the own-keys (`git:` -> `url:`) and is not a source itself.
    if (ownIndent === null) ownIndent = indent;
    if (indent !== ownIndent) continue;
    const trimmed = line.trim();
    const key = parseDependencyName(trimmed);
    if (!key) continue;
    const { value } = splitValueAndComment(
      trimmed.slice(trimmed.indexOf(":") + 1),
    );
    if (key === "version") {
      version = { key, value };
      continue;
    }
    return { key, value };
  }
  return version;
}

/**
 * Reads every package declared under `dependencies:` with its constraint.
 *
 * A dependency written in block form (`sdk:`, `git:`, `path:`, or a nested
 * `version:`) has no scalar constraint and must never be rewritten as one, so
 * it is reported with `isScalar: false`.
 *
 * @param {string} yamlContent - Raw pubspec.yaml content
 * @returns {Map<string, {constraint: string, comment: string, lineIndex: number, isScalar: boolean, sourceKey: string|null, sourceValue: string|null}>}
 */
export function parseExistingDependencies(yamlContent) {
  const lines = String(yamlContent || "").split("\n");
  const block = findDependenciesBlock(lines);
  const declared = new Map();
  if (!block) return declared;

  for (let i = block.headerIndex + 1; i < block.endIndex; i += 1) {
    const line = lines[i];
    if (isBlankOrComment(line)) continue;
    // Only direct children are dependency names; deeper lines describe a
    // dependency's own keys (sdk:, git:, version:, ...), which
    // readSourceDirective reads separately below.
    if (indentOf(line) !== block.childIndent.length) continue;
    const trimmed = line.trim();
    const name = parseDependencyName(trimmed);
    if (!name) continue;

    const { value, comment } = splitValueAndComment(
      trimmed.slice(trimmed.indexOf(":") + 1),
    );
    const isScalar = value !== "";
    // A block-form entry carries its source on the next line down. A scalar one
    // has nothing deeper, and looking anyway would walk into whichever
    // dependency follows.
    const directive = isScalar
      ? null
      : readSourceDirective(lines, i, block.endIndex, block.childIndent.length);

    declared.set(name, {
      constraint: value,
      comment,
      lineIndex: i,
      isScalar,
      sourceKey: directive ? directive.key : null,
      sourceValue: directive ? directive.value : null,
    });
  }
  return declared;
}

/**
 * Extracts the names of the packages already declared under `dependencies:`.
 * @param {string} yamlContent - Raw pubspec.yaml content
 * @returns {string[]} Declared dependency names, in file order
 */
/**
 * Reads a top-level dependency block by name, e.g. `dependency_overrides`.
 *
 * Same shape as parseExistingDependencies, which is hard-wired to
 * `dependencies:`. Anything reproducing how a project actually resolves
 * packages has to carry overrides too: an override pinning a different version
 * changes the API the code is compiled against, so a manifest that drops it
 * can approve code the real project rejects (or the reverse).
 *
 * @param {string} yamlContent - Raw pubspec.yaml content
 * @param {string} blockName - Top-level key, e.g. "dependency_overrides"
 * @returns {Map<string, {constraint: string, comment: string, lineIndex: number, isScalar: boolean, sourceKey: string|null, sourceValue: string|null}>}
 */
export function parseDependencyBlock(yamlContent, blockName) {
  const lines = String(yamlContent || "").split("\n");
  const headerPattern = new RegExp(
    `^${blockName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*(?:#.*)?$`,
  );
  const block = findBlock(lines, headerPattern);
  const declared = new Map();
  if (!block) return declared;

  for (let i = block.headerIndex + 1; i < block.endIndex; i += 1) {
    const line = lines[i];
    if (isBlankOrComment(line)) continue;
    if (indentOf(line) !== block.childIndent.length) continue;
    const trimmed = line.trim();
    const name = parseDependencyName(trimmed);
    if (!name) continue;

    const { value, comment } = splitValueAndComment(
      trimmed.slice(trimmed.indexOf(":") + 1),
    );
    const isScalar = value !== "";
    // A block-form entry carries its source on the next line down. A scalar one
    // has nothing deeper, and looking anyway would walk into whichever
    // dependency follows.
    const directive = isScalar
      ? null
      : readSourceDirective(lines, i, block.endIndex, block.childIndent.length);

    declared.set(name, {
      constraint: value,
      comment,
      lineIndex: i,
      isScalar,
      sourceKey: directive ? directive.key : null,
      sourceValue: directive ? directive.value : null,
    });
  }
  return declared;
}

export function parseExistingDependencyNames(yamlContent) {
  return [...parseExistingDependencies(yamlContent).keys()];
}

// A top-level `environment:` key, which carries the Dart and Flutter SDK
// ranges the project is built against.
const ENVIRONMENT_HEADER_PATTERN = /^environment\s*:\s*(?:#.*)?$/;

/**
 * Reads the project's declared SDK ranges. These say what a newly added
 * package has to be compatible with.
 * @param {string} yamlContent - Raw pubspec.yaml content
 * @returns {{sdk: string|null, flutter: string|null}} Raw constraint text
 */
export function parseEnvironmentConstraints(yamlContent) {
  const lines = String(yamlContent || "").split("\n");
  const block = findBlock(lines, ENVIRONMENT_HEADER_PATTERN);
  const environment = { sdk: null, flutter: null };
  if (!block) return environment;

  for (let i = block.headerIndex + 1; i < block.endIndex; i += 1) {
    const line = lines[i];
    if (isBlankOrComment(line)) continue;
    if (indentOf(line) !== block.childIndent.length) continue;
    const trimmed = line.trim();
    const key = parseDependencyName(trimmed);
    if (key !== "sdk" && key !== "flutter") continue;
    const { value } = splitValueAndComment(trimmed.slice(trimmed.indexOf(":") + 1));
    if (value) environment[key] = value;
  }
  return environment;
}

// YAML would misread a plain scalar that opens with an indicator character, and
// `>=1.0.0 <2.0.0` — an ordinary pub range constraint — is a parse error rather
// than a string. Quote anything that isn't unambiguously plain.
export function formatConstraint(constraint) {
  if (/^[A-Za-z0-9^~][A-Za-z0-9^~+._-]*$/.test(constraint)) return constraint;
  return `'${constraint.replace(/'/g, "''")}'`;
}

function formatDependencyLine(indent, name, version) {
  const constraint = String(version || "").trim();
  return `${indent}${name}: ${constraint ? formatConstraint(constraint) : ">=0.0.0"}`;
}

/**
 * Adds any missing packages to an existing pubspec.yaml without disturbing
 * what is already there.
 *
 * Packages already declared in the project are left exactly as-is — the
 * project's own version constraint wins over a generated one, since the user
 * (or FlutterFlow) may have pinned it deliberately.
 *
 * @param {string} yamlContent - The project's current pubspec.yaml
 * @param {Object<string, string>} newDependencies - name -> version constraint
 * @returns {{yaml: string, added: string[], alreadyPresent: string[]}}
 */
export function mergeDependenciesIntoYaml(yamlContent, newDependencies = {}) {
  const original = String(yamlContent || "");
  const requested = Object.entries(newDependencies).filter(
    // The Flutter SDK entry is always present and is never a pub package.
    ([name]) => name && name !== "flutter",
  );

  if (requested.length === 0) {
    return { yaml: original, added: [], alreadyPresent: [] };
  }

  const lines = original.split("\n");
  const existingNames = new Set(parseExistingDependencyNames(original));

  const added = [];
  const alreadyPresent = [];
  for (const [name, version] of requested) {
    if (existingNames.has(name)) {
      alreadyPresent.push(name);
    } else {
      added.push([name, version]);
      existingNames.add(name);
    }
  }

  if (added.length === 0) {
    return { yaml: original, added: [], alreadyPresent };
  }

  const block = findDependenciesBlock(lines);
  if (block) {
    const insertions = added.map(([name, version]) =>
      formatDependencyLine(block.childIndent, name, version),
    );
    lines.splice(block.endIndex, 0, ...insertions);
  } else {
    // No dependencies section at all: append one rather than guess at a slot.
    if (lines.length > 0 && lines[lines.length - 1].trim() !== "") lines.push("");
    lines.push("dependencies:");
    added.forEach(([name, version]) => {
      lines.push(formatDependencyLine("  ", name, version));
    });
  }

  return {
    yaml: lines.join("\n"),
    added: added.map(([name]) => name),
    alreadyPresent,
  };
}

/**
 * Rewrites the constraint of packages already declared in the pubspec.
 *
 * Only ever used for a package whose current constraint genuinely cannot
 * resolve a version the new code needs — replacing a working constraint is a
 * change to how the whole app builds, not a detail of the custom code being
 * deployed.
 *
 * A dependency in block form (`sdk:`, `git:`, `path:`) is left untouched and
 * reported in `skipped`; rewriting it as a scalar would drop its source.
 *
 * @param {string} yamlContent - The project's current pubspec.yaml
 * @param {Object<string, string>} overrides - name -> replacement constraint
 * @returns {{yaml: string, overridden: Array<{name: string, from: string, to: string}>, skipped: string[]}}
 */
export function applyDependencyOverrides(yamlContent, overrides = {}) {
  const original = String(yamlContent || "");
  const entries = Object.entries(overrides).filter(([name]) => name && name !== "flutter");
  if (entries.length === 0) return { yaml: original, overridden: [], skipped: [] };

  const lines = original.split("\n");
  const declared = parseExistingDependencies(original);
  const overridden = [];
  const skipped = [];

  for (const [name, constraint] of entries) {
    const existing = declared.get(name);
    if (!existing || !existing.isScalar || !String(constraint || "").trim()) {
      skipped.push(name);
      continue;
    }
    const indent = " ".repeat(indentOf(lines[existing.lineIndex]));
    lines[existing.lineIndex] =
      `${indent}${name}: ${formatConstraint(String(constraint).trim())}${existing.comment}`;
    overridden.push({ name, from: existing.constraint, to: constraint });
  }

  return { yaml: lines.join("\n"), overridden, skipped };
}

/**
 * Checks that a pubspec.yaml looks like a real Flutter project manifest before
 * it is pushed back. Guards against sending a truncated or unrelated file,
 * which the backend would apply as a dependency wipe.
 * @param {string} yamlContent - pubspec.yaml content
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateProjectPubspec(yamlContent) {
  const content = String(yamlContent || "");
  const errors = [];

  if (!content.trim()) {
    errors.push("pubspec.yaml is empty");
    return { valid: false, errors };
  }
  if (!/^name:\s*\S+/m.test(content)) {
    errors.push("pubspec.yaml missing name field");
  }
  if (!findDependenciesBlock(content.split("\n"))) {
    errors.push("pubspec.yaml missing dependencies section");
  }
  if (!parseExistingDependencyNames(content).includes("flutter")) {
    errors.push("pubspec.yaml missing Flutter SDK dependency");
  }

  return { valid: errors.length === 0, errors };
}
