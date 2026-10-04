/// Request-manifest validation for the FlutterFlow AI deploy runner.
///
/// The browser sends the verification manifest - the SDK packages, dependency
/// maps, version constraints and sources to compile - across a publicly
/// reachable route, and every field becomes a line the runner writes into a
/// pubspec it then runs `flutter pub get` against. Validation here is the
/// boundary that keeps a caller's data from turning into YAML structure, a
/// different package source, or a path outside the scratch package. The
/// functions are public so the contract tests in test/ can pin the exact
/// production behaviour, including the regression this helper used to cause:
/// sdkPackages is validated as package names, not against a stale allowlist,
/// so `flutter_web_plugins` and `flutter_localizations` are accepted.
///
/// This file uses no server primitives - it only parses and rejects - so it
/// can be exercised in isolation.
library;

import 'dart:convert';

const maxClassesPerRequest = 20;
const maxCodeBytes = 500000;
const maxDependenciesPerRequest = 200;
// pub.dev's own ceiling on a package name.
const maxPackageNameLength = 64;

const analysisPackageName = 'ccc_custom_code_analysis';
const defaultSdkConstraint = '>=3.0.0 <4.0.0';

// Pub package names are lower-case identifiers. Matching the whole string is
// what keeps a caller from smuggling YAML structure in through a key.
final _packageNamePattern = RegExp(r'^[a-z_][a-z0-9_]*$');

// A pub version constraint, and nothing else. The allowed characters exclude
// `:`, `#`, `{`, `}`, `/` and whitespace beyond single spaces, so `git:`,
// `path:`, a nested `hosted:` mapping, and comment injection are all
// unrepresentable rather than merely discouraged.
final _constraintPattern = RegExp(r'^[A-Za-z0-9^~<>=*+._ -]+$');

// Which packages the Flutter SDK supplies is not decided here. A caller names
// the packages its project declares as `sdk: flutter`, and this runner emits
// them as `name: {sdk: flutter}` - a value it writes itself, never one a caller
// sent. There was an allowlist of SDK package names here, and it refused good
// deploys: the client classified a package correctly by its pubspec source, and
// the runner rejected it for not appearing on a list that had gone stale.
// `_packageNamePattern` is what actually keeps a key from carrying YAML.

/// Reads a `{name: version-constraint}` map, rejecting anything that could
/// express more than a published package at a version.
///
/// This is the whole reason the manifest is sent as data rather than as
/// pubspec.yaml text. The runner writes this manifest to disk and runs
/// `flutter pub get` against it on a publicly reachable route, so a
/// caller-supplied document could otherwise name a `git:` or `path:` source and
/// have the runner fetch from a host of the caller's choosing. Only bare
/// `name: version` entries can be expressed here, and the runner emits those
/// lines itself, so no source directive can survive into the manifest.
Map<String, String> normalizeDependencyMap(Object? value, String field) {
  if (value == null) return const <String, String>{};
  if (value is! Map) {
    throw FormatException('verification.$field must be an object.');
  }
  if (value.length > maxDependenciesPerRequest) {
    throw FormatException('Too many entries in verification.$field.');
  }

  final result = <String, String>{};
  for (final entry in value.entries) {
    final name = '${entry.key}';
    if (!isValidPackageName(name)) {
      throw FormatException(
        'Invalid package name in verification.$field: $name.',
      );
    }
    final constraint = '${entry.value}'.trim();
    if (!_constraintPattern.hasMatch(constraint)) {
      throw FormatException(
        'Invalid version constraint for $name in verification.$field: $constraint.',
      );
    }
    result[name] = constraint;
  }
  return result;
}

/// Reads the SDK-supplied package names a caller's project declares.
///
/// Validated as package names rather than against a list of the packages the
/// Flutter SDK happens to ship: a name the SDK does not provide fails
/// `pub get` with an honest error, whereas a list refuses correct deploys the
/// moment it falls behind the SDK. The pattern is the load-bearing check - each
/// name becomes a key in the generated pubspec.
List<String> normalizeSdkPackages(Object? value, String field) {
  if (value == null) return const <String>[];
  if (value is! List) {
    throw FormatException('verification.$field must be an array.');
  }
  // Bounded like the dependency maps: each entry expands into the generated
  // pubspec, so an unbounded array is caller-controlled work before pub get
  // ever sees it.
  if (value.length > maxDependenciesPerRequest) {
    throw FormatException('Too many entries in verification.$field.');
  }

  final result = <String>{};
  for (final raw in value) {
    final name = '$raw';
    if (!isValidPackageName(name)) {
      throw FormatException('Invalid SDK package name: $name.');
    }
    result.add(name);
  }
  return result.toList();
}

bool isValidPackageName(String name) =>
    name.length <= maxPackageNameLength && _packageNamePattern.hasMatch(name);

String validateConstraint(
  String field,
  String value, {
  required String fallback,
}) {
  final constraint = value.trim();
  if (constraint.isEmpty) return fallback;
  if (!_constraintPattern.hasMatch(constraint)) {
    throw FormatException('Invalid $field: $constraint.');
  }
  return constraint;
}

/// Reads a required or optional string field, trimming it and bounding its
/// encoded size.
String stringField(
  Map<String, dynamic> source,
  String key, {
  required int maxLength,
  bool required = true,
}) {
  final value = source[key];
  if (value == null || value == '') {
    if (required) throw FormatException('Missing $key.');
    return '';
  }
  if (value is! String) {
    throw FormatException('$key must be a string.');
  }
  final trimmed = value.trim();
  if (required && trimmed.isEmpty) {
    throw FormatException('Missing $key.');
  }
  if (utf8.encode(trimmed).length > maxLength) {
    throw FormatException('$key is too long.');
  }
  return trimmed;
}

/// Reads the optional compile-check payload. Absent means the caller is an
/// older client that predates verification; its deploys keep working and are
/// reported as unverified rather than refused.
VerificationRequest? normalizeVerification(Object? value) {
  if (value == null) return null;
  if (value is! Map<String, dynamic>) {
    throw const FormatException('verification must be an object.');
  }

  // Clients deployed before the manifest became structured sent pubspec.yaml
  // text. Running it would reintroduce the caller-controlled-source problem, so
  // it is never executed - but rejecting the request outright would break every
  // deploy from a still-cached client during the rollout window. The deploy
  // goes ahead with the check reported as unavailable, which is exactly what
  // the deploy did before this feature existed, and the caller is told.
  if (value.containsKey('pubspec') && !value.containsKey('dependencies')) {
    return VerificationRequest.unavailable(
      'The compile check was skipped: this client sent a package manifest in '
      'the older format, which the runner no longer executes. Reload the app '
      'to pick up the current version.',
    );
  }

  final rawSources = value['sources'];
  if (rawSources is! List) {
    throw const FormatException('verification.sources must be an array.');
  }
  if (rawSources.length > maxClassesPerRequest) {
    throw const FormatException('Too many sources to verify in one request.');
  }

  final sources =
      rawSources.indexed.map((item) {
        final raw = item.$2;
        if (raw is! Map<String, dynamic>) {
          throw FormatException(
            'verification.sources[${item.$1}] must be an object.',
          );
        }
        final fileName = stringField(raw, 'fileName', maxLength: 200);
        // The name becomes a path inside the scratch package, so anything that
        // could climb out of it is a request to write somewhere else.
        if (!RegExp(r'^[a-z0-9_]+\.dart$').hasMatch(fileName)) {
          throw FormatException('Invalid verification file name: $fileName.');
        }
        return VerificationSource(
          fileName: fileName,
          content: stringField(raw, 'content', maxLength: maxCodeBytes),
        );
      }).toList();

  return VerificationRequest(
    sdkConstraint: validateConstraint(
      'verification.sdkConstraint',
      stringField(value, 'sdkConstraint', maxLength: 200, required: false),
      fallback: defaultSdkConstraint,
    ),
    dependencies: normalizeDependencyMap(value['dependencies'], 'dependencies'),
    overrides: normalizeDependencyMap(
      value['dependencyOverrides'],
      'dependencyOverrides',
    ),
    sdkPackages: normalizeSdkPackages(value['sdkPackages'], 'sdkPackages'),
    sdkOverrides: normalizeSdkPackages(value['sdkOverrides'], 'sdkOverrides'),
    sources: sources,
  );
}

/// Quotes a value for YAML when a plain scalar would be misread.
///
/// `>=1.0.0 <2.0.0` is an ordinary pub range, but it opens with an indicator
/// character and YAML would reject it as a plain scalar - the same reason
/// pubspecSync's `formatConstraint` quotes on the client side.
String _yamlScalar(String value) {
  if (RegExp(r'^[A-Za-z0-9][A-Za-z0-9._+-]*$').hasMatch(value)) return value;
  return "'${value.replaceAll("'", "''")}'";
}

final class VerificationSource {
  const VerificationSource({required this.fileName, required this.content});

  final String fileName;
  final String content;
}

final class VerificationRequest {
  const VerificationRequest({
    required this.sdkConstraint,
    required this.dependencies,
    required this.overrides,
    required this.sdkPackages,
    required this.sdkOverrides,
    required this.sources,
  }) : unavailableReason = null;

  /// A request the runner will not compile, carrying why.
  const VerificationRequest.unavailable(this.unavailableReason)
    : sdkConstraint = '',
      dependencies = const <String, String>{},
      overrides = const <String, String>{},
      sdkPackages = const <String>[],
      sdkOverrides = const <String>[],
      sources = const <VerificationSource>[];

  /// Why this request cannot be compiled, or null when it can.
  final String? unavailableReason;

  final String sdkConstraint;
  final Map<String, String> dependencies;
  final Map<String, String> overrides;
  final List<String> sdkPackages;
  final List<String> sdkOverrides;
  final List<VerificationSource> sources;

  /// Builds the pubspec the scratch package is compiled from.
  ///
  /// Emitted here rather than accepted from the caller: every line below is
  /// either a fixed literal or a value already matched against
  /// [_packageNamePattern] / [_constraintPattern], so nothing a caller sends
  /// can introduce a new YAML key, a nested mapping, or a comment.
  String toPubspec() {
    final lines = <String>[
      'name: $analysisPackageName',
      'description: Throwaway package used to compile generated custom code.',
      'publish_to: none',
      'version: 0.0.1',
      '',
      'environment:',
      '  sdk: ${_yamlScalar(sdkConstraint)}',
      '',
      'dependencies:',
      '  flutter:',
      '    sdk: flutter',
    ];

    // `flutter` is always present above; any other SDK package the project
    // declares is reproduced the same way.
    for (final name in sdkPackages) {
      if (name == 'flutter') continue;
      lines
        ..add('  $name:')
        ..add('    sdk: flutter');
    }

    for (final name in dependencies.keys.toList()..sort()) {
      lines.add('  $name: ${_yamlScalar(dependencies[name]!)}');
    }

    // SDK-sourced overrides belong in dependency_overrides, not in
    // `dependencies` with sdkPackages: an override can share its name with a
    // direct dependency, and emitting both under one map writes the key twice.
    if (overrides.isNotEmpty || sdkOverrides.isNotEmpty) {
      lines
        ..add('')
        ..add('dependency_overrides:');
      for (final name in overrides.keys.toList()..sort()) {
        lines.add('  $name: ${_yamlScalar(overrides[name]!)}');
      }
      for (final name in sdkOverrides.toList()..sort()) {
        lines
          ..add('  $name:')
          ..add('    sdk: flutter');
      }
    }

    return '${lines.join('\n')}\n';
  }
}
