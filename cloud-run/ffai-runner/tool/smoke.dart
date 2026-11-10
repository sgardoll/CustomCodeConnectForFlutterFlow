// Run inside the built image. Downloads public packages, never authenticates
// or executes the DSL: full workspace init and project validation need a canary.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

Future<void> main() async {
  final server = await Process.start('dart', ['run', 'bin/server.dart'],
      workingDirectory: '/app');
  final stdoutDone = server.stdout.transform(utf8.decoder).forEach(stdout.write);
  final stderrDone = server.stderr.transform(utf8.decoder).forEach(stderr.write);
  final scratch = await Directory.systemTemp.createTemp('ffai-smoke-');
  try {
    final health = await _waitForHealth();
    if (health['flutterflowCli'] == null ||
        health['flutterflowCli'] == '' ||
        health['flutterflowCli'] != health['minFlutterflowCli']) {
      throw StateError('Installed CLI does not match the runner: $health');
    }
    stdout.writeln('Runner health: ${jsonEncode(health)}');

    // This public command verifies the signed latest manifest, including its
    // min_router_version. A pinned CLI can become too old as upstream evolves.
    final report = await _run('flutterflow', ['ai', 'fetch-sdk', '--env', 'prod'],
        workingDirectory: scratch.path);
    final sdkPath = RegExp(r'^path: (.+)$', multiLine: true)
        .firstMatch(report)?.group(1)?.trim();
    if (sdkPath == null || !File('$sdkPath/pubspec.yaml').existsSync()) {
      throw StateError('fetch-sdk did not return an SDK package directory');
    }
    await File('${scratch.path}/pubspec.yaml').writeAsString('''
name: runner_sdk_smoke
environment:
  sdk: ">=3.7.0 <4.0.0"
dependencies:
  flutterflow_ai:
    path: ${jsonEncode(sdkPath)}
''');
    await File('${scratch.path}/smoke.dart').writeAsString(_dslContract);
    await _run('dart', ['pub', 'get'], workingDirectory: scratch.path);
    // Type-check the SDK APIs the generated deployment script relies on, but
    // do not run main (even validate/dry-run would require a real API key).
    await _run('dart', ['compile', 'kernel', 'smoke.dart', '-o', 'smoke.dill'],
        workingDirectory: scratch.path);
    stdout.writeln('Runner image and SDK compile smoke passed. No project accessed.');
  } finally {
    server.kill();
    await server.exitCode;
    await Future.wait([stdoutDone, stderrDone]);
    await scratch.delete(recursive: true);
  }
}

Future<Map<String, dynamic>> _waitForHealth() async {
  final client = HttpClient()..connectionTimeout = const Duration(seconds: 2);
  try {
    for (var attempt = 0; attempt < 60; attempt++) {
      try {
        final request = await client.getUrl(Uri.parse('http://127.0.0.1:8080/runnerHealth'));
        final response = await request.close().timeout(const Duration(seconds: 10));
        if (response.statusCode == HttpStatus.ok) {
          return jsonDecode(await response.transform(utf8.decoder).join())
              as Map<String, dynamic>;
        }
        await response.drain<void>();
      } on SocketException {
        // The real entrypoint is still starting.
      }
      await Future<void>.delayed(const Duration(seconds: 1));
    }
    throw StateError('Runner did not become healthy');
  } finally {
    client.close(force: true);
  }
}

Future<String> _run(String executable, List<String> args,
    {required String workingDirectory}) async {
  final result = await Process.run(executable, args,
      workingDirectory: workingDirectory);
  stdout.write(result.stdout);
  stderr.write(result.stderr);
  if (result.exitCode != 0) {
    throw StateError('$executable ${args.join(' ')} failed (${result.exitCode})');
  }
  return result.stdout as String;
}

// Keep this representative of _writeDeployScript in bin/server.dart. Compiling
// it catches SDK API/schema changes without calling FlutterFlow or needing keys.
const _dslContract = r'''
import 'package:flutterflow_ai/flutterflow_ai.dart';

Future<void> main() async {
  try {
    await flutterFlowAI((app) {
      app.raw((project) {
        if (findCustomClass(project, name: 'RunnerSmoke') == null) {
          addCustomClass(project, name: 'RunnerSmoke', code: 'class RunnerSmoke {}');
        } else {
          updateCustomClass(project, name: 'RunnerSmoke', code: 'class RunnerSmoke {}');
        }
        ensureFileName(project);
      });
    }, apiKey: null, baseUrl: null, projectId: null, dryRun: true,
       commitMessage: 'Compile-only runner smoke');
  } catch (error) {
    throw StateError(formatFlutterFlowAIError(error));
  }
}

void ensureFileName(FFProject project) {
  for (final file in project.customCode.customCodeFiles.customCodeFiles) {
    final holdsClass = file.customCodeEntities.any((entity) =>
        entity.hasInterface() && entity.interface.identifier.name == 'RunnerSmoke');
    if (holdsClass && !file.identifier.name.endsWith('.dart')) {
      file.identifier.name = '${file.identifier.name}.dart';
    }
  }
}
''';
