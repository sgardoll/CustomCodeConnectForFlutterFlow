import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:ccc_ffai_runner/request_validation.dart';
import 'package:ccc_ffai_runner/run_record.dart';
import 'package:ccc_ffai_runner/sha256.dart';

// The lowest flutterflow_cli the vendored FlutterFlow AI snapshot accepts. The
// image pins FLUTTERFLOW_CLI_VERSION to this (see Dockerfile); it must be kept
// in lockstep there, and it is what /healthz reports as the required minimum.
const minCliVersion = '0.0.41';

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
  // Declared outside the try so the catch below can close the record out. A
  // variable declared inside a try block is not in scope in its catch, and an
  // unexpected mid-run failure would otherwise leave the record reporting
  // "running" forever — exactly the unknown state a record exists to remove.
  RunRecorder? recorder;
  try {
    _writeCorsHeaders(request.response);

    if (request.method == 'OPTIONS') {
      request.response.statusCode = HttpStatus.noContent;
      await request.response.close();
      return;
    }

    if (request.method == 'GET' && request.uri.path == '/healthz') {
      await _writeJsonBody(request.response, await _healthz());
      return;
    }

    // GET /runStatus/<runId> answers what happened to a deploy whose response
    // was lost. The id in the path is the one the client itself generated, so
    // a 404 is a proof the request never reached the runner (nothing was
    // written, a retry is safe), never an ambiguous "unknown". The caller must
    // present the same API key the run started with; see fetchRunStatus.
    final statusPath = RegExp(
      r'^/runStatus/([A-Za-z0-9_-]+)$',
    ).firstMatch(request.uri.path);
    if (request.method == 'GET' && statusPath != null) {
      await _handleRunStatus(request, statusPath.group(1)!);
      return;
    }

    if (request.method != 'POST' ||
        request.uri.path != '/deployCustomClasses') {
      await channel.result(HttpStatus.notFound, {
        'success': false,
        'error': 'Not found.',
        'preWrite': true,
      });
      return;
    }

    // Only request parsing/validation throws FormatException here — those are
    // provably pre-write. Decoding CLI output can raise the same exception
    // AFTER the deploy began, so it must fall to the generic catch below,
    // which does not claim preWrite.
    Map<String, dynamic> payload;
    String apiKey;
    String projectId;
    String baseUrl;
    String commitMessage;
    String runId;
    bool dryRun;
    List<CustomClassEntry> classes;
    VerificationRequest? verification;
    try {
      payload = await _readJson(request);
      apiKey = stringField(payload, 'apiKey', maxLength: 10000);
      projectId = stringField(payload, 'projectId', maxLength: 200);
      baseUrl = stringField(
        payload,
        'baseUrl',
        maxLength: 500,
        required: false,
      );
      commitMessage = stringField(
        payload,
        'commitMessage',
        maxLength: 300,
        required: false,
      );
      runId = stringField(payload, 'runId', maxLength: 120, required: false);
      dryRun = payload['dryRun'] == true;
      classes = _normalizeClasses(payload['customClasses']);
      verification = normalizeVerification(payload['verification']);
    } on FormatException catch (error) {
      await channel.result(HttpStatus.badRequest, {
        'success': false,
        'error': error.message,
        // Request validation precedes any work against the project.
        'preWrite': true,
      });
      return;
    }

    // The client generates the run id so a 404 on /runStatus proves the
    // request never arrived. It becomes a document id in Firestore, so it is
    // constrained to characters that are safe there (letters, digits, - and _).
    if (runId.isNotEmpty && !RegExp(r'^[A-Za-z0-9_-]+$').hasMatch(runId)) {
      await channel.result(HttpStatus.badRequest, {
        'success': false,
        'error': 'Invalid runId.',
        'preWrite': true,
      });
      return;
    }

    // A run record lets a client whose connection dropped or whose wait expired
    // ask what actually happened instead of re-reading the project and
    // guessing. Older clients send no runId; for them nothing is recorded and
    // the deploy behaves exactly as before.
    recorder = runId.isEmpty
        ? null
        : RunRecorder(
            FirestoreRunStore(
              project:
                  Platform.environment['FIRESTORE_PROJECT'] ??
                  defaultFirestoreProject,
            ),
            runId: runId,
            projectId: projectId,
            keyHash: sha256Hex(utf8.encode(apiKey)),
            classNames: classes.map((entry) => entry.className).toList(),
          );

    // Only stream for callers that asked for it, so older clients keep getting
    // the single JSON response they parse.
    if (payload['stream'] == true) {
      channel.beginStream();
    }
    _phase(channel, recorder, 'connected',
        'Connected to the FlutterFlow deploy runner.');

    final workspace = Directory(
      Platform.environment['FFAI_WORKSPACE'] ??
          '/workspace/custom_code_connect',
    );
    final initResult = await _ensureWorkspace(
      workspace,
      apiKey,
      channel,
      recorder,
    );
    if (initResult != null) {
      if (recorder != null) {
        await recorder.recordFailed(
          initResult.timedOut
              ? 'Preparing the FlutterFlow AI workspace timed out.'
              : 'FlutterFlow AI workspace initialization failed.',
        );
      }
      await channel.result(HttpStatus.badGateway, {
        'success': false,
        'error':
            initResult.timedOut
                ? 'Preparing the FlutterFlow AI workspace timed out.'
                : 'FlutterFlow AI workspace initialization failed.',
        'details': _trimOutput(initResult.output),
        'exitCode': initResult.exitCode,
        // Workspace setup precedes any write to FlutterFlow.
        'preWrite': true,
      });
      return;
    }

    // Compile the generated classes before anything is written to the project.
    // FlutterFlow's own DSL only checks that the code is formattable, which
    // accepts a call to a named argument the package never declared - exactly
    // the class of error that otherwise lands in the project and breaks every
    // custom widget or action importing it.
    final analysis = await _verifyCustomCode(
      workspace,
      verification,
      channel,
      recorder,
    );
    if (analysis != null && analysis.hasErrors) {
      if (recorder != null) {
        await recorder.recordFailed(
          'The generated custom code does not compile.',
        );
      }
      await channel.result(HttpStatus.unprocessableEntity, {
        'success': false,
        'error':
            'The generated custom code does not compile, so nothing was '
            'deployed to FlutterFlow.',
        'details': analysis.report,
        'analyzerErrors': analysis.errors,
        // The compile gate runs before the deploy script starts.
        'preWrite': true,
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

    _phase(
      channel,
      recorder,
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
      recorder: recorder,
      timeout: _deployTimeout(classes.length),
    );

    if (result.timedOut) {
      if (recorder != null) {
        await recorder.recordFailed('FlutterFlow AI DSL deploy timed out.');
      }
      await channel.result(HttpStatus.gatewayTimeout, {
        'success': false,
        'error': 'FlutterFlow AI DSL deploy timed out.',
        'details': _trimOutput(result.output),
        // The CLI may already have uploaded classes before timing out.
        'preWrite': false,
      });
      return;
    }

    if (result.exitCode != 0) {
      if (recorder != null) {
        await recorder.recordFailed('FlutterFlow AI DSL deploy failed.');
      }
      await channel.result(HttpStatus.badGateway, {
        'success': false,
        'error': 'FlutterFlow AI DSL deploy failed.',
        'details': _trimOutput(result.output),
        'exitCode': result.exitCode,
        'preWrite': false,
      });
      return;
    }

    final deployed = classes
        .map(
          (entry) => {
            'artifactId': entry.artifactId,
            'className': entry.className,
          },
        )
        .toList();

    // The terminal write is awaited (bounded and error-swallowed in the
    // recorder) so a client whose response was lost can learn the run finished.
    if (recorder != null) {
      await recorder.recordDone(deployed, dryRun);
    }

    await channel.result(HttpStatus.ok, {
      'success': true,
      'message': 'Custom classes upserted through FlutterFlow AI DSL.',
      'deployed': deployed,
      'dryRun': dryRun,
      'verified': analysis?.verifiedFiles ?? const <String>[],
      'verificationSkipped': analysis?.skippedReason,
    });
  } catch (error, stackTrace) {
    stderr.writeln(error);
    stderr.writeln(stackTrace);
    // Close the record out too, or an unexpected failure leaves it reporting
    // "running" forever and a later status query answers with a state that is
    // no longer true. Best effort: the write is bounded and swallows its own
    // failures, so it cannot take down the response below. Null when the throw
    // preceded the record being opened, which is why it is nullable.
    await recorder?.recordFailed('$error');
    await channel.result(HttpStatus.internalServerError, {
      'success': false,
      'error': '$error',
      // The stage is unknown — a FormatException from decoding CLI output can
      // land here after the upload began — so the write cannot be proven not
      // to have run.
      'preWrite': false,
    });
  }
}

/// Reports a phase to the streaming channel and, when a run is being recorded,
/// persists it to the run record so a disconnected client can later ask what
/// happened.
void _phase(
  _ResponseChannel channel,
  RunRecorder? recorder,
  String id,
  String message,
) {
  channel.phase(id, message);
  recorder?.recordPhase(id, message);
}

Future<_RunOutcome?> _ensureWorkspace(
  Directory workspace,
  String apiKey,
  _ResponseChannel channel,
  RunRecorder? recorder,
) async {
  final packageConfig = File(
    '${workspace.path}/.dart_tool/package_config.json',
  );
  if (packageConfig.existsSync()) {
    _phase(channel, recorder, 'workspace_ready', 'Build environment is ready.');
    return null;
  }

  _phase(channel, recorder, 'workspace_init',
      'Preparing the FlutterFlow AI workspace...');
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
    recorder: recorder,
  );

  if (result.timedOut || result.exitCode != 0) {
    return result;
  }

  _phase(channel, recorder, 'workspace_ready', 'Build environment is ready.');
  return null;
}

/// Caps a single deploy invocation, scaling with how many classes it must
/// upload. A fixed cap would have to be sized to the largest bundle, either
/// killing a big one or over-waiting a small one; starting at 5 minutes and
/// growing by 15s per class keeps even the maximum 20-class request at 10
/// minutes - comfortably under Cloud Run's 900s request timeout and inside the
/// browser's 840s wait, with headroom to spare.
Duration _deployTimeout(int classCount) {
  return const Duration(minutes: 5) + Duration(seconds: 15 * classCount);
}

/// Runs the FlutterFlow CLI, forwarding its output line by line so the caller
/// can report real progress instead of guessing at it.
///
/// The [timeout] default is the workspace-init cap: `flutterflow ai init`
/// fetches the SDK snapshot once and is deliberately given a tighter bound
/// than a deploy, which pays for the per-class upload on top.
Future<_RunOutcome> _runFlutterFlow(
  List<String> args, {
  required String workingDirectory,
  required String apiKey,
  required _ResponseChannel channel,
  RunRecorder? recorder,
  Duration timeout = const Duration(minutes: 5),
}) async {
  final process = await Process.start(
    'flutterflow',
    args,
    workingDirectory: workingDirectory,
    environment: {'FF_API_KEY': apiKey, 'FLUTTERFLOW_API_KEY': apiKey},
  );

  final output = StringBuffer();
  var timedOut = false;
  final timer = Timer(timeout, () {
    timedOut = true;
    process.kill(ProcessSignal.sigkill);
  });
  // A cold start can be silent for a minute or more (SDK download, `flutter
  // analyze`), which the caller cannot distinguish from a dead connection. Emit
  // a heartbeat every 15s while the CLI runs so liveness stays observable; the
  // channel drops it for callers that did not ask for a stream, so it costs a
  // non-streaming request nothing.
  final heartbeat = Timer.periodic(
    const Duration(seconds: 15),
    (_) => channel.heartbeat(),
  );

  void consume(String rawLine) {
    final line = _redact(rawLine, apiKey).trimRight();
    if (line.isEmpty) return;

    // Markers are progress reporting, not output worth showing in an error.
    final marker = _readPhaseMarker(line);
    if (marker != null) {
      _phase(channel, recorder, marker.phase, marker.message);
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
  heartbeat.cancel();

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

  /// Marks the runner as alive without claiming progress. Existing clients
  /// ignore unknown events, so this is invisible to them; it exists so a proxy
  /// or the browser can tell a long, silent step from a dead connection.
  void heartbeat() {
    _write({'event': 'heartbeat'});
  }

  void _write(Map<String, Object?> event) {
    if (!_streaming || _closed) return;
    _writes = _writes
        .then((_) {
          _response.write('${jsonEncode(event)}\n');
          return _response.flush();
          // A disconnected client must not take down the deploy.
        })
        .catchError((Object _) {});
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
    ..set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
    // x-ff-api-key lets the browser present the deploy key on GET /runStatus so
    // a run id is never a bearer capability on its own.
    ..set('Access-Control-Allow-Headers', 'Content-Type, x-ff-api-key')
    ..set('Vary', 'Origin');
}

/// Liveness and version probe, so a merged-but-never-deployed fix is
/// detectable in minutes rather than on the next failed deploy: the SHA the
/// image was built from (set by the deploy pipeline as RUNNER_GIT_SHA, absent
/// until then), the flutterflow_cli actually installed, and the minimum the
/// vendored snapshot requires.
Future<Map<String, Object>> _healthz() async {
  return {
    'sha': Platform.environment['RUNNER_GIT_SHA'] ?? '',
    'flutterflowCli': await _installedCliVersion(),
    'minFlutterflowCli': minCliVersion,
  };
}

Future<String> _installedCliVersion() async {
  try {
    final process = await Process.start('dart', ['pub', 'global', 'list']);
    final output = await process.stdout.transform(utf8.decoder).join();
    final exitCode = await process.exitCode;
    // A version we could not read is better reported as absent than used to
    // claim the deployed CLI matches the snapshot.
    if (exitCode != 0) return '';
    final regex = RegExp(r'^flutterflow_cli\s+(\S+)');
    for (final line in const LineSplitter().convert(output)) {
      final match = regex.firstMatch(line.trim());
      if (match != null) return match.group(1)!;
    }
    return '';
  } on ProcessException {
    return '';
  }
}

Future<void> _writeJsonBody(HttpResponse response, Object body) async {
  response.statusCode = HttpStatus.ok;
  response.headers.contentType = ContentType.json;
  response.write(jsonEncode(body));
  try {
    await response.close();
  } catch (_) {}
}

/// Serves `GET /runStatus/<runId>`: looks up the run record and enforces that
/// the caller presents the same API key the run started with.
Future<void> _handleRunStatus(HttpRequest request, String runId) async {
  final store = FirestoreRunStore(
    project:
        Platform.environment['FIRESTORE_PROJECT'] ?? defaultFirestoreProject,
  );
  final lookup = await fetchRunStatus(
    runId: runId,
    presentedKey: _apiKeyFromRequest(request),
    store: store,
  );
  await _writeJsonResponse(request.response, lookup.statusCode, lookup.body);
}

/// The API key the caller must present to read a run. Read from a header
/// (preferred, to keep it out of URLs and access logs) with a query-parameter
/// fallback for callers that cannot set a custom header.
String? _apiKeyFromRequest(HttpRequest request) {
  final header = request.headers.value('x-ff-api-key')?.trim();
  if (header != null && header.isNotEmpty) return header;
  final query = request.uri.queryParameters['key']?.trim();
  if (query != null && query.isNotEmpty) return query;
  return null;
}

Future<void> _writeJsonResponse(
  HttpResponse response,
  int statusCode,
  Object body,
) async {
  response.statusCode = statusCode;
  response.headers.contentType = ContentType.json;
  response.write(jsonEncode(body));
  try {
    await response.close();
  } catch (_) {}
}

Future<Map<String, dynamic>> _readJson(HttpRequest request) async {
  final raw = await utf8.decoder.bind(request).join();
  final decoded = jsonDecode(raw);
  if (decoded is! Map<String, dynamic>) {
    throw const FormatException('Request body must be a JSON object.');
  }
  return decoded;
}

List<CustomClassEntry> _normalizeClasses(Object? value) {
  if (value is! List) {
    throw const FormatException('customClasses must be an array.');
  }
  if (value.isEmpty) {
    throw const FormatException('At least one custom class is required.');
  }
  if (value.length > maxClassesPerRequest) {
    throw const FormatException(
      'Too many custom classes in one deploy request.',
    );
  }

  return value.indexed.map((item) {
    final index = item.$1;
    final raw = item.$2;
    if (raw is! Map<String, dynamic>) {
      throw FormatException('customClasses[$index] must be an object.');
    }

    final className = stringField(raw, 'className', maxLength: 120);
    if (!RegExp(r'^[A-Z][A-Za-z0-9_]*$').hasMatch(className)) {
      throw FormatException('Invalid custom class name: $className.');
    }

    final content = stringField(raw, 'content', maxLength: maxCodeBytes);
    return CustomClassEntry(
      artifactId: stringField(
        raw,
        'artifactId',
        maxLength: 200,
        required: false,
      ),
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
  VerificationRequest? verification,
  _ResponseChannel channel,
  RunRecorder? recorder,
) async {
  if (verification == null) return null;
  if (verification.unavailableReason != null) {
    return _AnalysisOutcome.skipped(verification.unavailableReason!);
  }
  if (verification.sources.isEmpty) return null;

  _phase(channel, recorder, 'verifying', 'Compiling your custom code...');

  final packageDir = Directory('${workspace.parent.path}/custom_code_analysis');
  final libDir = Directory('${packageDir.path}/lib');
  // Sources from an earlier request would otherwise be analysed alongside this
  // one and report errors against code the caller never sent.
  if (libDir.existsSync()) libDir.deleteSync(recursive: true);
  await libDir.create(recursive: true);

  await File(
    '${packageDir.path}/pubspec.yaml',
  ).writeAsString(verification.toPubspec());
  for (final source in verification.sources) {
    await File(
      '${libDir.path}/${source.fileName}',
    ).writeAsString(source.content);
  }

  final pubGet = await _runProcess(
    'flutter',
    ['pub', 'get'],
    workingDirectory: packageDir.path,
    timeout: const Duration(minutes: 4),
    channel: channel,
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
    channel: channel,
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
  required _ResponseChannel channel,
}) async {
  final buffer = StringBuffer();
  // Same reason as `_runFlutterFlow`: `flutter pub get` and `flutter analyze`
  // can be silent for a long while, and a heartbeat keeps the request visibly
  // alive to a streaming caller.
  final heartbeat = Timer.periodic(
    const Duration(seconds: 15),
    (_) => channel.heartbeat(),
  );
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

    final exitCode = await process.exitCode.timeout(
      timeout,
      onTimeout: () {
        process.kill(ProcessSignal.sigkill);
        return -1;
      },
    );
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
  } finally {
    heartbeat.cancel();
  }
}

Future<File> _writeDeployScript(
  Directory workspace,
  List<CustomClassEntry> classes,
) async {
  final dslDir = Directory('${workspace.path}/dsl')
    ..createSync(recursive: true);
  final calls = classes
      .map((entry) {
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
      })
      .join('\n');

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
