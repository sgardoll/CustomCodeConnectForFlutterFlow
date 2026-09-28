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

// The keys that say where a block-form dependency comes from. `version` is
// deliberately absent: it is a constraint, not a source, so a mapping whose
// only own key is `version:` describes a normal pub.dev dependency.
const SOURCE_KEYS = new Set(["sdk", "git", "path", "hosted"]);

/**
 * Reads where a block-form dependency comes from, scanning every key of its
 * own mapping.
 *
 * A block-form entry says where a package comes from on a following, more
 * deeply indented line: `sdk:`, `git:`, `path:`, a nested `hosted:`, or a
 * `version:` written on its own line. YAML mappings are unordered, so the
 * source key can sit after `version:` or between any other keys — reading
 * only the first key would classify a valid custom-hosted dependency whose
 * `version:` happens to come first as a plain pub.dev one, and the
 * verification runner would then compile against a different package source
 * than the project ships.
 *
 * That key is the only thing that distinguishes a package the Flutter SDK
 * supplies from one the analysis manifest cannot reproduce, so it is read
 * here rather than guessed from the package's name. A name list cannot work:
 * it goes stale the moment the SDK ships a package the list has not heard of,
 * and every project declaring that package then reads it as unreproducible.
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
 * @returns {{key: string|null, value: string|null, version: string|null}}
 *   The source directive's key and inline value — null when the mapping
 *   holds no sdk/git/path/hosted key — plus the entry's own `version:` value
 *   when one appears
 */
function readSourceDirective(lines, entryIndex, endIndex, parentIndent) {
  let ownIndent = null;
  let version = null;
  for (let i = entryIndex + 1; i < endIndex; i += 1) {
    const line = lines[i];
    if (isBlankOrComment(line)) continue;
    const indent = indentOf(line);
    // Shallower or equal indent means the entry's mapping has ended and this is
    // a sibling dependency, so there is nothing of this entry's own left to read.
    if (indent <= parentIndent) break;
    // The first mapping line fixes the own-key indent; anything deeper belongs
    // to one of the own-keys (`git:` -> `url:`) and is not a source itself, so a
    // nested `hosted:` inside an unrelated own-key cannot masquerade as the
    // entry's source.
    if (ownIndent === null) ownIndent = indent;
    if (indent !== ownIndent) continue;
    const trimmed = line.trim();
    const key = parseDependencyName(trimmed);
    if (!key) continue;
    const { value } = splitValueAndComment(
      trimmed.slice(trimmed.indexOf(":") + 1),
    );
    if (SOURCE_KEYS.has(key)) return { key, value, version };
    if (key === "version" && version === null) version = value;
  }
  return { key: null, value: null, version };
}

/**
 * Reads the source key of a dependency written as an inline flow mapping.
 *
 * YAML allows the same mapping inline that readSourceDirective reads in block
 * form: `name: {sdk: flutter}` is the same declaration as the block form, and
 * `name: {version: ^1.0.0, hosted: {name: x, url: y}}` puts version beside its
 * source exactly as the block form does. The same precedence applies: a source
 * key wins over `version:`.
 *
 * Without this an inline mapping looks scalar - its value is nonempty - and
 * gets forwarded as a version constraint, which the runner then rejects for
 * containing braces. A map whose members cannot be read yields key null, so
 * the entry is classified unrepresentable rather than sent downstream as
 * something it is not.
 *
 * @param {string} value - The text after `name:` on the dependency's own line
 * @returns {{key: string|null, value: string|null, version: string|null}|null}
 *   The source own-key and inline value — null when the mapping holds no
 *   sdk/git/path/hosted key — plus the `version:` member's value when one
 *   appears; key null for an unreadable mapping, or null when the value is
 *   not a flow mapping at all
 */
function parseFlowSourceDirective(value) {
  const text = String(value || "").trim();
  if (!text.startsWith("{")) return null;

  const end = findFlowMappingEnd(text);
  if (end === -1) return { key: null, value: null, version: null };

  // Split the members on top-level commas only - a comma inside a nested map
  // or a quote belongs to the member, not the map.
  const inner = text.slice(1, end);
  const segments = [];
  let quote = null;
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") depth -= 1;
    else if (char === "," && depth === 0) {
      segments.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  segments.push(inner.slice(start));

  let version = null;
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const key = parseDependencyName(trimmed);
    if (!key) return { key: null, value: null, version: null };
    const { value: memberValue } = splitValueAndComment(
      trimmed.slice(trimmed.indexOf(":") + 1),
    );
    if (SOURCE_KEYS.has(key)) return { key, value: memberValue, version };
    if (key === "version" && version === null) version = memberValue;
  }
  return { key: null, value: null, version };
}

/**
 * Finds the `}` closing the `{` at the start of the text, skipping nested
 * mappings and quoted text.
 *
 * @param {string} text - Text starting with `{`
 * @returns {number} Index of the closing brace, or -1 when unclosed
 */
function findFlowMappingEnd(text) {
  let quote = null;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return i;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

/**
 * Reassembles a flow mapping that wraps members onto following lines.
 *
 * YAML allows the same `{...}` members on subsequent lines - `name: {`, then
 * `sdk: flutter`, then `}` - and only the dependency's own line reaches
 * parseFlowSourceDirective, so a lone `{` reads as an unclosed, hence
 * unreadable, mapping and classifies the entry unrepresentable. Lines are
 * pulled in only while the map is still open - a map that closes but is
 * unreadable (`{sdk flutter}`) gets no more lines, so the dependencies after
 * it are still read as themselves - and a map that never closes stays
 * unreadable, which is the right answer for it anyway.
 *
 * @param {string[]} lines - All lines of the pubspec
 * @param {number} startIndex - Index of the dependency's own line
 * @param {number} endIndex - Index of the line that ends the block
 * @param {string} value - The text after `name:` on the dependency's own line
 * @returns {{text: string, lastIndex: number}} The joined flow text and the
 *   last line index consumed
 */
function collectFlowMappingText(lines, startIndex, endIndex, value) {
  let text = value;
  let i = startIndex;
  while (
    text.trimStart().startsWith("{") &&
    findFlowMappingEnd(text) === -1 &&
    i + 1 < endIndex
  ) {
    i += 1;
    text += "\n" + lines[i];
  }
  return { text, lastIndex: i };
}

/**
 * Reads every package declared under `dependencies:` with its constraint.
 *
 * A dependency written in block form (`sdk:`, `git:`, `path:`, a nested
 * `hosted:`, or a `version:` on its own line) or as an inline flow mapping
 * (`{sdk: flutter}`) has no scalar constraint and must never be rewritten as
 * one, so it is reported with `isScalar: false`. An entry whose own keys are
 * only `version:` is a normal pub.dev dependency: `sourceKey` is null and the
 * constraint travels in `version`.
 *
 * @param {string} yamlContent - Raw pubspec.yaml content
 * @returns {Map<string, {constraint: string, comment: string, lineIndex: number, isScalar: boolean, sourceKey: string|null, sourceValue: string|null, version: string|null}>}
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
    // An inline `{sdk: flutter}`-style mapping is not a constraint, so it is
    // read for its own source keys like a block entry is. Its members may
    // wrap onto following lines, which collectFlowMappingText reassembles.
    const nameIndex = i;
    const flow = collectFlowMappingText(lines, i, block.endIndex, value);
    const flowSource = parseFlowSourceDirective(flow.text);
    i = flow.lastIndex;
    const isScalar = value !== "" && flowSource === null;
    // A block-form entry carries its source on the next line down. A scalar one
    // has nothing deeper, and looking anyway would walk into whichever
    // dependency follows.
    const directive = isScalar
      ? null
      : (flowSource ??
        readSourceDirective(lines, nameIndex, block.endIndex, block.childIndent.length));

    declared.set(name, {
      constraint: value,
      comment,
      lineIndex: nameIndex,
      isScalar,
      sourceKey: directive ? directive.key : null,
      sourceValue: directive ? directive.value : null,
      version: directive ? directive.version : null,
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
 * @returns {Map<string, {constraint: string, comment: string, lineIndex: number, isScalar: boolean, sourceKey: string|null, sourceValue: string|null, version: string|null}>}
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
    const nameIndex = i;
    const flow = collectFlowMappingText(lines, i, block.endIndex, value);
    const flowSource = parseFlowSourceDirective(flow.text);
    i = flow.lastIndex;
    const isScalar = value !== "" && flowSource === null;
    // A block-form entry carries its source on the next line down. A scalar one
    // has nothing deeper, and looking anyway would walk into whichever
    // dependency follows.
    const directive = isScalar
      ? null
      : (flowSource ??
        readSourceDirective(lines, nameIndex, block.endIndex, block.childIndent.length));

    declared.set(name, {
      constraint: value,
      comment,
      lineIndex: nameIndex,
      isScalar,
      sourceKey: directive ? directive.key : null,
      sourceValue: directive ? directive.value : null,
      version: directive ? directive.version : null,
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

// A `version:` member sits inside a `{...}` map on the name line or on a
// deeper child line in block form; only its value is rewritten so the entry
// keeps its declared shape. The value is read as a complete YAML scalar -
// a quoted range like `'>=0.19.0 <0.20.0'` must go whole, or its suffix would
// be left behind - and a trailing `,`, `}`, or comment stays untouched.
// Returns false when no member was found, so the caller never reports an
// override it did not write.
function rewriteVersionMember(lines, entry, constraint) {
  const parentIndent = indentOf(lines[entry.lineIndex]);
  for (let j = entry.lineIndex; j < lines.length; j += 1) {
    const line = lines[j];
    if (j !== entry.lineIndex && indentOf(line) <= parentIndent) break;
    // YAML permits quoted keys - `{'version': 0.19.0}` declares the same
    // member as `{version: 0.19.0}`.
    const isMember =
      j === entry.lineIndex
        ? /\{[^}]*(?:'version'|"version"|\bversion)\s*:/.test(line)
        : /^\s*(?:'version'|"version"|version)\s*:/.test(line);
    if (!isMember) continue;
    // On the name line the member sits inside the `{...}` map - searching
    // from `{` stops a package literally named `version` from matching its
    // own key (`version: {version: x}` must rewrite the member, not the key).
    const searchStart = j === entry.lineIndex ? line.indexOf("{") : 0;
    const keyMatch = /(?:'version'|"version"|\bversion)\s*:\s*/.exec(
      line.slice(searchStart),
    );
    if (!keyMatch) continue;
    const valueStart = searchStart + keyMatch.index + keyMatch[0].length;
    let valueEnd = valueStart;
    const first = line[valueStart];
    if (first === "'" || first === '"') {
      valueEnd += 1;
      while (valueEnd < line.length) {
        if (line[valueEnd] === first) {
          // YAML escapes a single quote by doubling it; a double-quoted
          // scalar uses `\.` pairs.
          if (first === "'" && line[valueEnd + 1] === "'") {
            valueEnd += 2;
            continue;
          }
          valueEnd += 1;
          break;
        }
        if (first === '"' && line[valueEnd] === "\\") valueEnd += 1;
        valueEnd += 1;
      }
    } else {
      // Plain scalar: ends at a flow-map delimiter or a ` #` comment start.
      while (valueEnd < line.length && line[valueEnd] !== "," && line[valueEnd] !== "}") {
        if (line[valueEnd] === "#" && /\s/.test(line[valueEnd - 1] || " ")) break;
        valueEnd += 1;
      }
      while (valueEnd > valueStart && /\s/.test(line[valueEnd - 1])) {
        valueEnd -= 1;
      }
    }
    lines[j] =
      line.slice(0, valueStart) + formatConstraint(constraint) + line.slice(valueEnd);
    return true;
  }
  return false;
}

function formatDependencyLines(indent, name, version) {
  // An SDK-supplied package takes a block entry - `name:` then its own
  // `sdk:` key - not a version constraint.
  if (version && typeof version === "object" && version.sdk) {
    return [`${indent}${name}:`, `${indent}  sdk: ${version.sdk}`];
  }
  const constraint = String(version || "").trim();
  return [`${indent}${name}: ${constraint ? formatConstraint(constraint) : ">=0.0.0"}`];
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
 * @param {Object<string, string|{sdk: string}>} newDependencies - name ->
 *   version constraint, or `{sdk}` for a package the Flutter SDK supplies
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
    const insertions = added.flatMap(([name, version]) =>
      formatDependencyLines(block.childIndent, name, version),
    );
    lines.splice(block.endIndex, 0, ...insertions);
  } else {
    // No dependencies section at all: append one rather than guess at a slot.
    if (lines.length > 0 && lines[lines.length - 1].trim() !== "") lines.push("");
    lines.push("dependencies:");
    added.forEach(([name, version]) => {
      lines.push(...formatDependencyLines("  ", name, version));
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
    // `name: {version: 0.19.0}` (or a `version:` own-key in block form) is a
    // hosted pin in mapping shape: not isScalar, but raiseable - and only its
    // `version:` member is rewritten, so the entry keeps its declared form.
    const versionPinned =
      existing &&
      !existing.isScalar &&
      existing.sourceKey === null &&
      existing.version !== null;
    if (
      !existing ||
      (!existing.isScalar && !versionPinned) ||
      !String(constraint || "").trim()
    ) {
      skipped.push(name);
      continue;
    }
    if (versionPinned) {
      if (rewriteVersionMember(lines, existing, String(constraint).trim())) {
        overridden.push({ name, from: existing.version, to: constraint });
      } else {
        // No member rewrite means the old pin stays - reporting it applied
        // would let the deploy claim a raise the YAML never got.
        skipped.push(name);
      }
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
