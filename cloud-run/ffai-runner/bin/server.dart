import 'dart:async';
import 'dart:convert';
import 'dart:io';

const maxClassesPerRequest = 20;
const maxCodeBytes = 500000;

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

  final pubspec = _stringField(value, 'pubspec', maxLength: 100000);
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

  return _VerificationRequest(pubspec: pubspec, sources: sources);
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
  if (verification == null || verification.sources.isEmpty) return null;

  channel.phase('verifying', 'Compiling your custom code...');

  final packageDir = Directory('${workspace.parent.path}/custom_code_analysis');
  final libDir = Directory('${packageDir.path}/lib');
  // Sources from an earlier request would otherwise be analysed alongside this
  // one and report errors against code the caller never sent.
  if (libDir.existsSync()) libDir.deleteSync(recursive: true);
  await libDir.create(recursive: true);

  await File('${packageDir.path}/pubspec.yaml')
      .writeAsString(verification.pubspec);
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
  if (errors.isEmpty && analyze.exitCode != 0 && analyze.timedOut) {
    return _AnalysisOutcome.skipped(
      'Compiling your custom code timed out, so it was not verified before '
      'deploying.',
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
  const _VerificationRequest({required this.pubspec, required this.sources});

  final String pubspec;
  final List<_VerificationSource> sources;
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
