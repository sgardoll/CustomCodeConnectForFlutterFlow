import 'dart:async';
import 'dart:convert';
import 'dart:io';

const maxClassesPerRequest = 20;
const maxCodeBytes = 500000;
const maxDependenciesPerRequest = 200;

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

Future<void> main() async {
  final port = int.tryParse(Platform.environment['PORT'] ?? '') ?? 8080;
  final server = await HttpServer.bind(InternetAddress.anyIPv4, port);
  stdout.writeln('FlutterFlow AI runner listening on $port');

  await for (final request in server) {
    unawaited(_handle(request));
  }
}

Future<void> _handle(HttpRequest request) async {
  final channel = _ResponseChannel(request.response);
  try {
    _writeCorsHeaders(request.response);

    if (request.method == 'OPTIONS') {
      request.response.statusCode = HttpStatus.noContent;
      await request.response.close();
      return;
    }

    if (request.method != 'POST' || request.uri.path != '/deployCustomClasses') {
      await channel.result(HttpStatus.notFound, {
        'success': false,
        'error': 'Not found.',
      });
      return;
    }

    final payload = await _readJson(request);
    final apiKey = _stringField(payload, 'apiKey', maxLength: 10000);
    final projectId = _stringField(payload, 'projectId', maxLength: 200);
    final baseUrl = _stringField(payload, 'baseUrl', maxLength: 500, required: false);
    final commitMessage = _stringField(
      payload,
      'commitMessage',
      maxLength: 300,
      required: false,
    );
    final dryRun = payload['dryRun'] == true;
    final classes = _normalizeClasses(payload['customClasses']);
    final verification = _normalizeVerification(payload['verification']);

    // Only stream for callers that asked for it, so older clients keep getting
    // the single JSON response they parse.
    if (payload['stream'] == true) {
      channel.beginStream();
    }
    channel.phase('connected', 'Connected to the FlutterFlow deploy runner.');

    final workspace = Directory(
      Platform.environment['FFAI_WORKSPACE'] ?? '/workspace/custom_code_connect',
    );
    final initResult = await _ensureWorkspace(workspace, apiKey, channel);
    if (initResult != null) {
      await channel.result(HttpStatus.badGateway, {
        'success': false,
        'error': initResult.timedOut
            ? 'Preparing the FlutterFlow AI workspace timed out.'
            : 'FlutterFlow AI workspace initialization failed.',
        'details': _trimOutput(initResult.output),
        'exitCode': initResult.exitCode,
      });
      return;
    }

    // Compile the generated classes before anything is written to the project.
    // FlutterFlow's own DSL only checks that the code is formattable, which
    // accepts a call to a named argument the package never declared - exactly
    // the class of error that otherwise lands in the project and breaks every
    // custom widget or action importing it.
    final analysis = await _verifyCustomCode(workspace, verification, channel);
    if (analysis != null && analysis.hasErrors) {
      await channel.result(HttpStatus.unprocessableEntity, {
        'success': false,
        'error': 'The generated custom code does not compile, so nothing was '
            'deployed to FlutterFlow.',
        'details': analysis.report,
        'analyzerErrors': analysis.errors,
      });
      return;
    }

    final scriptFile = await _writeDeployScript(workspace, classes);
    // Unlike `ai init`, `ai run`/`ai validate` are passthrough commands: the
    // CLI forwards these arguments verbatim to the vendored flutterflow_ai SDK,
    // so whether that SDK honours FF_API_KEY is not something this repo can
    // verify. Keep --api-key here until a live run proves the env var alone
    // authenticates; dropping it on assumption would either break every deploy
    // or, worse, silently fall through to a key left in the shared workspace by
    // an earlier request.
    final args = <String>[
      'ai',
      dryRun ? 'validate' : 'run',
      scriptFile.path,
      '--project-id',
      projectId,
      '--api-key',
      apiKey,
    ];
    if (baseUrl.isNotEmpty) {
      args.addAll(['--base-url', baseUrl]);
    }
    if (commitMessage.isNotEmpty) {
      args.addAll(['--commit-message', commitMessage]);
    }

    channel.phase(
      'deploy_start',
      classes.length == 1
          ? 'Deploying ${classes.single.className} to FlutterFlow...'
          : 'Deploying ${classes.length} custom classes to FlutterFlow...',
    );

    final result = await _runFlutterFlow(
      args,
      workingDirectory: workspace.path,
      apiKey: apiKey,
      channel: channel,
    );

    if (result.timedOut) {
      await channel.result(HttpStatus.gatewayTimeout, {
        'success': false,
        'error': 'FlutterFlow AI DSL deploy timed out.',
        'details': _trimOutput(result.output),
      });
      return;
    }

    if (result.exitCode != 0) {
      await channel.result(HttpStatus.badGateway, {
        'success': false,
        'error': 'FlutterFlow AI DSL deploy failed.',
        'details': _trimOutput(result.output),
        'exitCode': result.exitCode,
      });
      return;
    }

    await channel.result(HttpStatus.ok, {
      'success': true,
      'message': 'Custom classes upserted through FlutterFlow AI DSL.',
      'deployed': classes
          .map((entry) => {
                'artifactId': entry.artifactId,
                'className': entry.className,
              })
          .toList(),
      'dryRun': dryRun,
      'verified': analysis?.verifiedFiles ?? const <String>[],
      'verificationSkipped': analysis?.skippedReason,
    });
  } on FormatException catch (error) {
    await channel.result(HttpStatus.badRequest, {
      'success': false,
      'error': error.message,
    });
  } catch (error, stackTrace) {
    stderr.writeln(error);
    stderr.writeln(stackTrace);
    await channel.result(HttpStatus.internalServerError, {
      'success': false,
      'error': '$error',
    });
  }
}

Future<_RunOutcome?> _ensureWorkspace(
  Directory workspace,
  String apiKey,
  _ResponseChannel channel,
) async {
  final packageConfig = File('${workspace.path}/.dart_tool/package_config.json');
  if (packageConfig.existsSync()) {
    channel.phase('workspace_ready', 'Build environment is ready.');
    return null;
  }

  channel.phase('workspace_init', 'Preparing the FlutterFlow AI workspace...');
  final parent = workspace.parent;
  await parent.create(recursive: true);
  final workspaceName = workspace.path.split(Platform.pathSeparator).last;
  // The key goes via FF_API_KEY only: process arguments are readable from any
  // process listing and routinely end up in logs, and a FlutterFlow key carries
  // full project write access. `flutterflow ai init` reads FF_API_KEY directly
  // (flutterflow_cli ai_router.dart), and deliberately does NOT persist a key
  // that came from the environment to its credential store - which is what we
  // want here, because the workspace below is shared across requests.
  final result = await _runFlutterFlow(
    ['ai', 'init', workspaceName, '--yes'],
    workingDirectory: parent.path,
    apiKey: apiKey,
    channel: channel,
  );

  if (result.timedOut || result.exitCode != 0) {
    return result;
  }

  channel.phase('workspace_ready', 'Build environment is ready.');
  return null;
}

/// Runs the FlutterFlow CLI, forwarding its output line by line so the caller
/// can report real progress instead of guessing at it.
Future<_RunOutcome> _runFlutterFlow(
  List<String> args, {
  required String workingDirectory,
  required String apiKey,
  required _ResponseChannel channel,
  Duration timeout = const Duration(minutes: 5),
}) async {
  final process = await Process.start(
    'flutterflow',
    args,
    workingDirectory: workingDirectory,
    environment: {
      'FF_API_KEY': apiKey,
      'FLUTTERFLOW_API_KEY': apiKey,
    },
  );

  final output = StringBuffer();
  var timedOut = false;
  final timer = Timer(timeout, () {
    timedOut = true;
    process.kill(ProcessSignal.sigkill);
  });

  void consume(String rawLine) {
    final line = _redact(rawLine, apiKey).trimRight();
    if (line.isEmpty) return;

    // Markers are progress reporting, not output worth showing in an error.
    final marker = _readPhaseMarker(line);
    if (marker != null) {
      channel.phase(marker.phase, marker.message);
      return;
    }

    output.writeln(line);
    channel.log(line);
  }

  final stdoutDone = process.stdout
      .transform(utf8.decoder)
      .transform(const LineSplitter())
      .forEach(consume);
  final stderrDone = process.stderr
      .transform(utf8.decoder)
      .transform(const LineSplitter())
      .forEach(consume);

  final exitCode = await process.exitCode;
  await Future.wait([stdoutDone, stderrDone]);
  timer.cancel();

  return _RunOutcome(
    exitCode: exitCode,
    output: output.toString(),
    timedOut: timedOut,
  );
}

/// Phase markers the generated DSL script prints, so the deploy reports where
/// it actually is rather than one opaque "deploying" step.
const phaseMarkerPrefix = '__FFAI_PHASE__';

_PhaseMarker? _readPhaseMarker(String line) {
  if (!line.startsWith(phaseMarkerPrefix)) return null;
  final rest = line.substring(phaseMarkerPrefix.length);
  final separator = rest.indexOf(':', 1);
  if (!rest.startsWith(':') || separator == -1) return null;
  return _PhaseMarker(
    phase: rest.substring(1, separator),
    message: rest.substring(separator + 1),
  );
}

/// Removes the API key from CLI output, which is echoed back to the browser.
String _redact(String value, String apiKey) {
  if (apiKey.length < 8) return value;
  return value.replaceAll(apiKey, '***');
}

final class _PhaseMarker {
  const _PhaseMarker({required this.phase, required this.message});

  final String phase;
  final String message;
}

final class _RunOutcome {
  const _RunOutcome({
    required this.exitCode,
    required this.output,
    required this.timedOut,
  });

  final int exitCode;
  final String output;
  final bool timedOut;
}

/// Writes either a stream of NDJSON events or a single JSON body, depending on
/// what the caller asked for. Events are written through one chained future so
/// they can never interleave.
final class _ResponseChannel {
  _ResponseChannel(this._response);

  final HttpResponse _response;
  bool _streaming = false;
  bool _closed = false;
  Future<void> _writes = Future<void>.value();

  void beginStream() {
    _streaming = true;
    _response.statusCode = HttpStatus.ok;
    _response.headers.contentType = ContentType(
      'application',
      'x-ndjson',
      charset: 'utf-8',
    );
    _response.headers.set('Cache-Control', 'no-cache');
    // Tells fronting proxies to pass each chunk straight through.
    _response.headers.set('X-Accel-Buffering', 'no');
    _response.bufferOutput = false;
  }

  void phase(String phase, String message) {
    _write({'event': 'phase', 'phase': phase, 'message': message});
  }

  void log(String message) {
    _write({'event': 'log', 'message': message});
  }

  void _write(Map<String, Object?> event) {
    if (!_streaming || _closed) return;
    _writes = _writes.then((_) {
      _response.write('${jsonEncode(event)}\n');
      return _response.flush();
      // A disconnected client must not take down the deploy.
    }).catchError((Object _) {});
  }

  Future<void> result(int statusCode, Map<String, Object?> payload) async {
    if (_closed) return;

    if (_streaming) {
      _write({'event': 'result', ...payload});
      _closed = true;
      await _writes;
    } else {
      _closed = true;
      _response.statusCode = statusCode;
      _response.headers.contentType = ContentType.json;
      _response.write(jsonEncode(payload));
    }

    try {
      await _response.close();
    } catch (_) {}
  }
}

void _writeCorsHeaders(HttpResponse response) {
  final allowedOrigin = Platform.environment['ALLOWED_ORIGIN'] ?? '*';
  response.headers
    ..set('Access-Control-Allow-Origin', allowedOrigin)
    ..set('Access-Control-Allow-Methods', 'POST, OPTIONS')
    ..set('Access-Control-Allow-Headers', 'Content-Type')
    ..set('Vary', 'Origin');
}

Future<Map<String, dynamic>> _readJson(HttpRequest request) async {
  final raw = await utf8.decoder.bind(request).join();
  final decoded = jsonDecode(raw);
  if (decoded is! Map<String, dynamic>) {
    throw const FormatException('Request body must be a JSON object.');
  }
  return decoded;
}

String _stringField(
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
_VerificationRequest? _normalizeVerification(Object? value) {
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
    return _VerificationRequest.unavailable(
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

  final sources = rawSources.indexed.map((item) {
    final raw = item.$2;
    if (raw is! Map<String, dynamic>) {
      throw FormatException('verification.sources[${item.$1}] must be an object.');
    }
    final fileName = _stringField(raw, 'fileName', maxLength: 200);
    // The name becomes a path inside the scratch package, so anything that
    // could climb out of it is a request to write somewhere else.
    if (!RegExp(r'^[a-z0-9_]+\.dart$').hasMatch(fileName)) {
      throw FormatException('Invalid verification file name: $fileName.');
    }
    return _VerificationSource(
      fileName: fileName,
      content: _stringField(raw, 'content', maxLength: maxCodeBytes),
    );
  }).toList();

  return _VerificationRequest(
    sdkConstraint: _validateConstraint(
      'verification.sdkConstraint',
      _stringField(value, 'sdkConstraint', maxLength: 200, required: false),
      fallback: defaultSdkConstraint,
    ),
    dependencies: _normalizeDependencyMap(value['dependencies'], 'dependencies'),
    overrides: _normalizeDependencyMap(
      value['dependencyOverrides'],
      'dependencyOverrides',
    ),
    sdkPackages: _normalizeSdkPackages(value['sdkPackages']),
    sources: sources,
  );
}

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
Map<String, String> _normalizeDependencyMap(Object? value, String field) {
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
    if (!_packageNamePattern.hasMatch(name)) {
      throw FormatException('Invalid package name in verification.$field: $name.');
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
List<String> _normalizeSdkPackages(Object? value) {
  if (value == null) return const <String>[];
  if (value is! List) {
    throw const FormatException('verification.sdkPackages must be an array.');
  }
  if (value.length > maxDependenciesPerRequest) {
    throw const FormatException('Too many entries in verification.sdkPackages.');
  }

  final result = <String>{};
  for (final raw in value) {
    final name = '$raw';
    if (!_packageNamePattern.hasMatch(name)) {
      throw FormatException('Invalid SDK package name: $name.');
    }
    result.add(name);
  }
  return result.toList();
}

String _validateConstraint(
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

/// Quotes a value for YAML when a plain scalar would be misread.
///
/// `>=1.0.0 <2.0.0` is an ordinary pub range, but it opens with an indicator
/// character and YAML would reject it as a plain scalar - the same reason
/// pubspecSync's `formatConstraint` quotes on the client side.
String _yamlScalar(String value) {
  if (RegExp(r'^[A-Za-z0-9][A-Za-z0-9._+-]*$').hasMatch(value)) return value;
  return "'${value.replaceAll("'", "''")}'";
}

List<CustomClassEntry> _normalizeClasses(Object? value) {
  if (value is! List) {
    throw const FormatException('customClasses must be an array.');
  }
  if (value.isEmpty) {
    throw const FormatException('At least one custom class is required.');
  }
  if (value.length > maxClassesPerRequest) {
    throw const FormatException('Too many custom classes in one deploy request.');
  }

  return value.indexed.map((item) {
    final index = item.$1;
    final raw = item.$2;
    if (raw is! Map<String, dynamic>) {
      throw FormatException('customClasses[$index] must be an object.');
    }

    final className = _stringField(raw, 'className', maxLength: 120);
    if (!RegExp(r'^[A-Z][A-Za-z0-9_]*$').hasMatch(className)) {
      throw FormatException('Invalid custom class name: $className.');
    }

    final content = _stringField(raw, 'content', maxLength: maxCodeBytes);
    return CustomClassEntry(
      artifactId: _stringField(raw, 'artifactId', maxLength: 200, required: false),
      className: className,
      content: content,
    );
  }).toList();
}

/// Compiles the generated classes in a throwaway Flutter package before they
/// are pushed, so an error the FlutterFlow DSL would wave through is caught
/// while the project is still untouched.
///
/// Returns null when the caller sent nothing to compile. A run that cannot be
/// performed at all - no Flutter SDK on PATH, `pub get` unable to reach
/// pub.dev - reports itself as skipped rather than as errors: refusing a
/// deploy because the checker itself broke would block correct code, and the
/// caller states plainly what went unverified.
Future<_AnalysisOutcome?> _verifyCustomCode(
  Directory workspace,
  _VerificationRequest? verification,
  _ResponseChannel channel,
) async {
  if (verification == null) return null;
  if (verification.unavailableReason != null) {
    return _AnalysisOutcome.skipped(verification.unavailableReason!);
  }
  if (verification.sources.isEmpty) return null;

  channel.phase('verifying', 'Compiling your custom code...');

  final packageDir = Directory('${workspace.parent.path}/custom_code_analysis');
  final libDir = Directory('${packageDir.path}/lib');
  // Sources from an earlier request would otherwise be analysed alongside this
  // one and report errors against code the caller never sent.
  if (libDir.existsSync()) libDir.deleteSync(recursive: true);
  await libDir.create(recursive: true);

  await File('${packageDir.path}/pubspec.yaml')
      .writeAsString(verification.toPubspec());
  for (final source in verification.sources) {
    await File('${libDir.path}/${source.fileName}')
        .writeAsString(source.content);
  }

  final pubGet = await _runProcess(
    'flutter',
    ['pub', 'get'],
    workingDirectory: packageDir.path,
    timeout: const Duration(minutes: 4),
  );
  if (pubGet.exitCode != 0) {
    return _AnalysisOutcome.skipped(
      'The packages your code imports could not be resolved, so it was not '
      'compiled before deploying: ${_trimOutput(pubGet.output)}',
    );
  }

  final analyze = await _runProcess(
    'flutter',
    ['analyze', '--no-pub', '--no-fatal-infos', '--no-fatal-warnings'],
    workingDirectory: packageDir.path,
    timeout: const Duration(minutes: 4),
  );

  final errors = _analyzerErrors(analyze.output);

  // `flutter analyze` exits non-zero both when it reports errors and when it
  // fails to run at all - a missing toolchain, an unresolvable manifest, a
  // crash. A non-zero exit with nothing parsed therefore means the check did
  // not complete, and reporting that as verified would be a false assurance:
  // worse than no gate, because the deploy would claim the code had been
  // compiled. Only a clean exit is treated as a clean bill of health.
  if (errors.isEmpty && analyze.exitCode != 0) {
    return _AnalysisOutcome.skipped(
      analyze.timedOut
          ? 'Compiling your custom code timed out, so it was not verified '
              'before deploying.'
          : 'The Dart analyzer did not complete, so your custom code was not '
              'verified before deploying: ${_trimOutput(analyze.output)}',
    );
  }

  return _AnalysisOutcome(
    errors: errors,
    report: _trimOutput(analyze.output),
    verifiedFiles:
        verification.sources.map((source) => source.fileName).toList(),
  );
}

/// Pulls the `error` diagnostics out of `flutter analyze` output.
///
/// Lines look like:
///   error - The named parameter 'group' isn't defined - lib/x.dart:28:9 - ...
/// with the separator rendered as a bullet. Warnings and infos are left out:
/// they are style advice from whatever lint set the scratch package inherits,
/// not proof the code is broken, and blocking on them would refuse code that
/// compiles.
List<String> _analyzerErrors(String output) {
  final errors = <String>[];
  for (final line in const LineSplitter().convert(output)) {
    final trimmed = line.trim();
    if (trimmed.startsWith('error ')) errors.add(trimmed);
  }
  return errors;
}

Future<_RunOutcome> _runProcess(
  String executable,
  List<String> args, {
  required String workingDirectory,
  required Duration timeout,
}) async {
  final buffer = StringBuffer();
  try {
    final process = await Process.start(
      executable,
      args,
      workingDirectory: workingDirectory,
      runInShell: false,
    );
    final drained = Future.wait([
      process.stdout.transform(utf8.decoder).forEach(buffer.write),
      process.stderr.transform(utf8.decoder).forEach(buffer.write),
    ]);

    final exitCode = await process.exitCode.timeout(timeout, onTimeout: () {
      process.kill(ProcessSignal.sigkill);
      return -1;
    });
    await drained;
    return _RunOutcome(
      exitCode: exitCode,
      output: buffer.toString(),
      timedOut: exitCode == -1,
    );
  } on ProcessException catch (error) {
    return _RunOutcome(
      exitCode: -1,
      output: '$executable could not be started: ${error.message}',
      timedOut: false,
    );
  }
}

Future<File> _writeDeployScript(
  Directory workspace,
  List<CustomClassEntry> classes,
) async {
  final dslDir = Directory('${workspace.path}/dsl')..createSync(recursive: true);
  final calls = classes.map((entry) {
    final name = _dartSingleQuoted(entry.className);
    final code = _dartRawString(entry.content);
    return '''
          if (findCustomClass(project, name: $name) == null) {
            addCustomClass(
              project,
              name: $name,
              code: $code,
            );
          } else {
            updateCustomClass(
              project,
              name: $name,
              code: $code,
            );
          }
          _ensureDartFileName(project, $name);
''';
  }).join('\n');

  final script = '''
library;

import 'dart:io';

import 'package:flutterflow_ai/flutterflow_ai.dart';

Future<void> main(List<String> args) async {
  final options = _parseCliOptions(args);
  _phase('project_fetch', 'Opening your FlutterFlow project...');
  try {
    await flutterFlowAI(
      (app) {
        app.raw((project) {
          _phase('applying', 'Applying your custom classes...');
$calls          _phase('uploading', 'Saving the changes to FlutterFlow...');
        });
      },
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      projectId: options.projectId,
      dryRun: options.dryRun,
      commitMessage: options.commitMessage,
    );
  } catch (error) {
    stderr.writeln('Error: \${formatFlutterFlowAIError(error)}');
    exit(1);
  }
}

void _phase(String phase, String message) {
  stdout.writeln('$phaseMarkerPrefix:\$phase:\$message');
}

/// Gives the Code File holding [className] a name FlutterFlow can resolve.
///
/// `addCustomClass` names the containing `FFCustomCodeFile` `_snakeCase(name)`
/// with no extension, but FlutterFlow stores Code Files created in its own
/// editor WITH the extension (`groq_model_registry.dart`, verified by SDK
/// readback) and codegen builds `lib/custom_code/<identifier.name>` from it
/// verbatim. An extensionless name therefore emits a file no `import` can
/// resolve, so every custom widget or action that imports the class fails to
/// compile. Appending the extension here is the only lever the runner has -
/// the SDK helper exposes no file-name parameter.
///
/// Idempotent and non-destructive: a name that already ends in `.dart` is left
/// exactly as it is, so a file the author renamed in the FlutterFlow editor
/// survives a re-deploy untouched.
void _ensureDartFileName(FFProject project, String className) {
  for (final file in project.customCode.customCodeFiles.customCodeFiles) {
    final holdsClass = file.customCodeEntities.any(
      (entity) =>
          entity.hasInterface() &&
          entity.interface.identifier.name == className,
    );
    if (!holdsClass) continue;

    final current = file.identifier.name;
    if (current.endsWith('.dart')) return;
    file.identifier.name =
        current.isEmpty ? '\${_snakeCase(className)}.dart' : '\$current.dart';
    return;
  }
}

/// FlutterFlow's naive snake_case: an underscore before every capital, all
/// lowercased. Matches the SDK's own derivation so the repaired name is the
/// one FlutterFlow would have produced.
String _snakeCase(String name) {
  final buffer = StringBuffer();
  for (var i = 0; i < name.length; i++) {
    final char = name[i];
    final lower = char.toLowerCase();
    if (char != lower && i > 0) buffer.write('_');
    buffer.write(lower);
  }
  return buffer.toString();
}

final class _CliOptions {
  const _CliOptions({
    this.apiKey,
    this.baseUrl,
    this.projectId,
    this.commitMessage,
    this.dryRun = false,
  });

  final String? apiKey;
  final String? baseUrl;
  final String? projectId;
  final String? commitMessage;
  final bool dryRun;
}

_CliOptions _parseCliOptions(List<String> args) {
  String? apiKey;
  String? baseUrl;
  String? projectId;
  String? commitMessage;
  var dryRun = false;

  for (var i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--api-key':
        apiKey = _requireValue(args, ++i, '--api-key');
      case '--base-url':
        baseUrl = _requireValue(args, ++i, '--base-url');
      case '--project-id':
        projectId = _requireValue(args, ++i, '--project-id');
      case '--commit-message':
        commitMessage = _requireValue(args, ++i, '--commit-message');
      case '--dry-run':
        dryRun = true;
      default:
        stderr.writeln('Unknown option: \${args[i]}');
        exit(64);
    }
  }

  return _CliOptions(
    apiKey: apiKey,
    baseUrl: baseUrl,
    projectId: projectId,
    commitMessage: commitMessage,
    dryRun: dryRun,
  );
}

String _requireValue(List<String> args, int index, String flag) {
  if (index >= args.length) {
    stderr.writeln('Missing value for \$flag.');
    exit(64);
  }
  return args[index];
}
''';

  final file = File('${dslDir.path}/deploy_custom_classes.dart');
  await file.writeAsString(script);
  return file;
}

String _dartSingleQuoted(String value) {
  return "'${value.replaceAll(r'\', r'\\').replaceAll("'", r"\'")}'";
}

String _dartRawString(String value) {
  if (!value.contains("'''")) {
    return "r'''\n$value\n'''";
  }
  return '"""${value.replaceAll(r'\', r'\\').replaceAll(r'$', r'\$').replaceAll('"""', r'\"\"\"')}"""';
}

String _trimOutput(Object value) {
  final text = '$value'.trim();
  if (text.length <= 4000) return text;
  return '${text.substring(0, 4000)}...';
}

final class _VerificationSource {
  const _VerificationSource({required this.fileName, required this.content});

  final String fileName;
  final String content;
}

final class _VerificationRequest {
  const _VerificationRequest({
    required this.sdkConstraint,
    required this.dependencies,
    required this.overrides,
    required this.sdkPackages,
    required this.sources,
  }) : unavailableReason = null;

  /// A request the runner will not compile, carrying why.
  const _VerificationRequest.unavailable(this.unavailableReason)
      : sdkConstraint = '',
        dependencies = const <String, String>{},
        overrides = const <String, String>{},
        sdkPackages = const <String>[],
        sources = const <_VerificationSource>[];

  /// Why this request cannot be compiled, or null when it can.
  final String? unavailableReason;

  final String sdkConstraint;
  final Map<String, String> dependencies;
  final Map<String, String> overrides;
  final List<String> sdkPackages;
  final List<_VerificationSource> sources;

  /// Builds the pubspec the scratch package is compiled from.
  ///
  /// Emitted here rather than accepted from the caller: every line below is
  /// either a fixed literal or a value already matched against
  /// `_packageNamePattern` / `_constraintPattern`, so nothing a caller sends
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

    if (overrides.isNotEmpty) {
      lines
        ..add('')
        ..add('dependency_overrides:');
      for (final name in overrides.keys.toList()..sort()) {
        lines.add('  $name: ${_yamlScalar(overrides[name]!)}');
      }
    }

    return '${lines.join('\n')}\n';
  }
}

final class _AnalysisOutcome {
  const _AnalysisOutcome({
    required this.errors,
    required this.report,
    required this.verifiedFiles,
  }) : skippedReason = null;

  const _AnalysisOutcome.skipped(String reason)
      : errors = const <String>[],
        report = '',
        verifiedFiles = const <String>[],
        skippedReason = reason;

  final List<String> errors;
  final String report;
  final List<String> verifiedFiles;

  /// Why the compile check could not run, or null when it did run.
  final String? skippedReason;

  bool get hasErrors => errors.isNotEmpty;
}

final class CustomClassEntry {
  const CustomClassEntry({
    required this.artifactId,
    required this.className,
    required this.content,
  });

  final String artifactId;
  final String className;
  final String content;
}
