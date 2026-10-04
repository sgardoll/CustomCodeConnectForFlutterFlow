import 'dart:convert';

import 'package:ccc_ffai_runner/run_record.dart';
import 'package:ccc_ffai_runner/sha256.dart';
import 'package:test/test.dart';

String _keyHash(String key) => sha256Hex(utf8.encode(key));

/// Builds a store whose transport is a canned responder and whose token is
/// injected, so no metadata server or network is touched.
FirestoreRunStore _store(
  Future<FirestoreHttpResponse> Function(
    String method,
    Uri uri, {
    Map<String, String>? headers,
    String? body,
  }) transport,
) {
  return FirestoreRunStore(
    transport: transport,
    fetchAccessToken: () async => 'test-token',
  );
}

Future<FirestoreHttpResponse> _jsonResponse(Object body) async =>
    FirestoreHttpResponse(200, jsonEncode(body));

void main() {
  final key = 'ff-key-123';
  final goodDoc = <String, Object?>{
    'runId': 'dr_abc',
    'projectId': 'ff-proj',
    'keyHash': _keyHash(key),
    'classNames': <String>['GaugeWidget'],
    'status': 'done',
    'phase': 'done',
    'message': 'done',
    'error': null,
    'deployed': <Object?>[
      {'className': 'GaugeWidget', 'artifactId': 'g'},
    ],
    'dryRun': false,
  };

  group('fetchRunStatus auth and identity', () {
    test('rejects a missing key before ever querying the store', () async {
      final store = _store((method, uri, {headers, body}) async {
        fail('store must not be queried without a key');
      });
      final lookup = await fetchRunStatus(
        runId: 'dr_abc',
        presentedKey: null,
        store: store,
      );
      expect(lookup.statusCode, 401);
    });

    test('404 for an unknown run id a client generated itself', () async {
      final store = _store(
        (method, uri, {headers, body}) async =>
            const FirestoreHttpResponse(404, ''),
      );
      final lookup = await fetchRunStatus(
        runId: 'dr_never-sent',
        presentedKey: key,
        store: store,
      );
      expect(lookup.statusCode, 404);
    });

    test('refuses a wrong key (hash mismatch)', () async {
      final store = _store(
        (method, uri, {headers, body}) async => _jsonResponse({
          'fields': {
            for (final f in {'keyHash': _keyHash(key)}.entries)
              f.key: {'stringValue': f.value},
          },
        }),
      );
      final lookup = await fetchRunStatus(
        runId: 'dr_abc',
        presentedKey: 'some-other-key',
        store: store,
      );
      expect(lookup.statusCode, 403);
    });

    test('returns the record for the matching key', () async {
      final store = _store(
        (method, uri, {headers, body}) async =>
            _jsonResponse({'fields': encodeFields(goodDoc)}),
      );
      final lookup = await fetchRunStatus(
        runId: 'dr_abc',
        presentedKey: key,
        store: store,
      );
      expect(lookup.statusCode, 200);
      expect(lookup.body['status'], 'done');
      expect(lookup.body['projectId'], 'ff-proj');
      expect(lookup.body['deployed'], isA<List>());
      // The stored digest is never returned to the caller.
      expect(lookup.body.containsKey('keyHash'), isFalse);
    });

    test('503 when Firestore cannot be read', () async {
      final store = _store(
        (method, uri, {headers, body}) async =>
            const FirestoreHttpResponse(500, 'server error'),
      );
      final lookup = await fetchRunStatus(
        runId: 'dr_abc',
        presentedKey: key,
        store: store,
      );
      expect(lookup.statusCode, 503);
    });
  });

  group('RunRecorder', () {
    test('never throws even when Firestore rejects every write', () async {
      final store = _store(
        (method, uri, {headers, body}) async =>
            const FirestoreHttpResponse(500, 'denied'),
      );
      final recorder = RunRecorder(
        store,
        runId: 'dr_abc',
        projectId: 'ff-proj',
        keyHash: _keyHash('key'),
        classNames: const ['GaugeWidget'],
      );
      // Intermediate progress is fire-and-forget.
      recorder.recordPhase('verifying', 'Compiling...');
      // The terminal write is awaited but must not throw or hang past its cap.
      await expectLater(
        recorder.recordDone(const [
          {'className': 'GaugeWidget', 'artifactId': 'g'},
        ], false),
        completes,
      );
      await expectLater(recorder.recordFailed('something broke'), completes);
    });
  });

  group('Firestore field codec', () {
    test('round-trips the record shape', () {
      final original = <String, Object?>{
        'runId': 'dr_abc',
        'status': 'done',
        'dryRun': false,
        'deployed': [
          {'className': 'GaugeWidget', 'artifactId': 'g'},
        ],
        'classNames': <String>['GaugeWidget'],
        'error': null,
      };
      final decoded = decodeFields(encodeFields(original));
      expect(decoded, original);
    });

    test('store.get returns null for a 404', () async {
      final store = _store(
        (method, uri, {headers, body}) async =>
            const FirestoreHttpResponse(404, 'not found'),
      );
      expect(await store.get('missing'), isNull);
    });
  });
}
