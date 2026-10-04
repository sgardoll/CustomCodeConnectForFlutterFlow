/// The deploy-run record: a per-request record the runner writes as a deploy
/// progresses, and the status endpoint that reads it back.
///
/// Why it exists: a deploy can outlive the browser's wait bound, and until now
/// the only way the browser could learn what happened was to re-read the whole
/// project and guess. A record that tracks the run's phases, terminal outcome,
/// per-class results and error string lets a client whose response was lost
/// ask the runner directly.
///
/// The record lives in Firestore in a fixed project (default `low-code-connect`)
/// because that project exists, its Firestore is enabled, and the runner's
/// service account already holds `roles/editor` there - so no IAM change and no
/// runtime pub dependency is needed. It is reached through the Firestore REST
/// API with an OAuth token borrowed from the GCE metadata server, all over
/// `dart:io`.
///
/// Two invariants are enforced from here because they are the point of the
/// feature:
///  - The API key is never stored - only its SHA-256 digest is. The status
///    endpoint requires the caller to present the same key and compares
///    digests, so a run id alone is never a bearer capability over
///    `--allow-unauthenticated`.
///  - Writing the record can never fail a deploy. Every Firestore call is
///    bounded and its failure is logged, not propagated. The status endpoint,
///    by contrast, must answer its caller, so a read failure surfaces as a
///    temporary-unavailable error the browser treats as "unknown" and falls
///    back to reconciling by re-reading the project.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:ccc_ffai_runner/sha256.dart';

/// The GCP project that owns the Firestore database holding run records. The
/// runner's service account holds roles/editor here, so no separate grant is
/// needed; overridden by FIRESTORE_PROJECT if the deployment ever relocates.
const defaultFirestoreProject = 'low-code-connect';

/// The Firestore collection (a sub-path of `databases/(default)/documents`)
/// that holds deploy-run records, keyed by the client-generated run id.
const runStatusCollection = 'deploy_runs';

/// Cap on a single record write. Writing must never hold up or fail a deploy,
/// so even the terminal write - the one a waiting client depends on - is
/// bounded to this and its failure swallowed.
const runRecordWriteTimeout = Duration(seconds: 2);

/// An HTTP response from the backing store, kept opaque so the real transport
/// (dart:io) and a test double share one shape.
class FirestoreHttpResponse {
  const FirestoreHttpResponse(this.status, this.body);

  final int status;
  final String body;
}

/// The transport the store talks to Firestore through. Injectable so tests can
/// exercise the store without a network or a metadata server.
typedef FirestoreTransport =
    Future<FirestoreHttpResponse> Function(
      String method,
      Uri uri, {
      Map<String, String>? headers,
      String? body,
    });

/// A Firestore lookup/update that did not succeed. Message is for the log
/// stream only; it is never shown to the caller of a deploy.
class RunStoreException implements Exception {
  RunStoreException(this.message);

  final String message;

  @override
  String toString() => 'RunStoreException: $message';
}

/// A dependency-free Firestore client scoped to one document path (the run
/// records), using the REST API and an OAuth token from the GCE metadata
/// server over dart:io. Both the token source and the HTTP transport are
/// injectable so the store is testable in isolation.
class FirestoreRunStore {
  FirestoreRunStore({
    String project = defaultFirestoreProject,
    String collection = runStatusCollection,
    FirestoreTransport? transport,
    Future<String> Function()? fetchAccessToken,
  }) : _project = project,
       _collection = collection,
       _transport = transport,
       _fetchAccessToken = fetchAccessToken;

  final String _project;
  final String _collection;
  final FirestoreTransport? _transport;
  final Future<String> Function()? _fetchAccessToken;

  String? _cachedToken;
  DateTime? _tokenExpiry;

  // Every field the runner writes, listed so the create-or-update PATCH
  // targets exactly this set and never clobbers fields another writer owns.
  static const _fieldKeys = [
    'runId',
    'projectId',
    'keyHash',
    'classNames',
    'status',
    'phase',
    'message',
    'error',
    'deployed',
    'dryRun',
    'updatedAt',
  ];

  Uri _documentUri(String docId) => Uri.parse(
    'https://firestore.googleapis.com/v1/projects/$_project'
    '/databases/(default)/documents/$_collection/$docId',
  );

  Uri _writeUri(String docId) => Uri.parse(
    '${_documentUri(docId)}?'
    '${_fieldKeys.map((k) => 'updateMask.fieldPaths=$k').join('&')}',
  );

  /// Writes a document, creating it if absent and otherwise updating only the
  /// fields the runner owns. Throws `RunStoreException` on any non-2xx.
  Future<void> put(String docId, Map<String, Object?> fields) async {
    final token = await _accessToken();
    final response = await _send(
      'PATCH',
      _writeUri(docId),
      headers: {'Authorization': 'Bearer $token'},
      body: jsonEncode({'fields': encodeFields(fields)}),
    );
    if (response.status < 200 || response.status >= 300) {
      throw RunStoreException('write returned HTTP ${response.status}');
    }
  }

  /// Reads a document, or returns null when it does not exist.
  Future<Map<String, dynamic>?> get(String docId) async {
    final token = await _accessToken();
    final response = await _send(
      'GET',
      _documentUri(docId),
      headers: {'Authorization': 'Bearer $token'},
    );
    if (response.status == 404) return null;
    if (response.status < 200 || response.status >= 300) {
      throw RunStoreException('read returned HTTP ${response.status}');
    }
    final decoded = jsonDecode(response.body);
    if (decoded is! Map<String, dynamic>) {
      throw RunStoreException('unexpected Firestore response shape');
    }
    return decodeFields(decoded['fields'] as Map? ?? const <String, dynamic>{});
  }

  Future<String> _accessToken() async {
    final now = DateTime.now();
    if (_cachedToken != null &&
        _tokenExpiry != null &&
        now.isBefore(_tokenExpiry!)) {
      return _cachedToken!;
    }
    // The real token source is the GCE metadata server; tests inject their own
    // so no metadata round trip happens in the test suite.
    final token = await (_fetchAccessToken ?? _metadataToken)();
    // Refresh comfortably ahead of the hour-long token lifetime.
    _cachedToken = token;
    _tokenExpiry = now.add(const Duration(minutes: 50));
    return token;
  }

  static Future<String> _metadataToken() async {
    final client = HttpClient();
    try {
      final request = await client.getUrl(
        Uri.parse(
          'http://metadata.google.internal/computeMetadata/v1/instance/'
          'service-accounts/default/token',
        ),
      );
      request.headers.set('Metadata-Flavor', 'Google');
      final response = await request.close();
      final body = await utf8.decoder.bind(response).join();
      final decoded = jsonDecode(body);
      final token = decoded is Map ? decoded['access_token'] : null;
      if (token is! String || token.isEmpty) {
        throw RunStoreException('metadata server returned no access token');
      }
      return token;
    } finally {
      client.close();
    }
  }

  Future<FirestoreHttpResponse> _send(
    String method,
    Uri uri, {
    Map<String, String>? headers,
    String? body,
  }) {
    if (_transport != null) {
      return _transport(method, uri, headers: headers, body: body);
    }
    return _dartIoSend(method, uri, headers: headers, body: body);
  }

  static Future<FirestoreHttpResponse> _dartIoSend(
    String method,
    Uri uri, {
    Map<String, String>? headers,
    String? body,
  }) async {
    final client = HttpClient();
    try {
      final request = await client.openUrl(method, uri);
      headers?.forEach((key, value) => request.headers.set(key, value));
      if (body != null) request.write(body);
      final response = await request.close();
      final text = await utf8.decoder.bind(response).join();
      return FirestoreHttpResponse(response.statusCode, text);
    } finally {
      client.close();
    }
  }
}

/// Encodes a flat/typed object map into Firestore REST `fields` values.
Map<String, Object?> encodeFields(Map<String, Object?> fields) {
  return {
    for (final entry in fields.entries) entry.key: _toFirestoreValue(entry.value),
  };
}

/// Decodes a Firestore REST `fields` map back into plain Dart values.
Map<String, dynamic> decodeFields(Map<dynamic, dynamic> fields) {
  final out = <String, dynamic>{};
  fields.forEach((key, value) => out['$key'] = _fromFirestoreValue(value));
  return out;
}

Object? _toFirestoreValue(Object? value) {
  if (value == null) return {'nullValue': null};
  if (value is bool) return {'booleanValue': value};
  if (value is String) return {'stringValue': value};
  if (value is int) return {'integerValue': '$value'};
  if (value is List) {
    return {
      'arrayValue': {
        'values': [for (final item in value) _toFirestoreValue(item)],
      },
    };
  }
  if (value is Map) {
    return {'mapValue': {'fields': encodeFields(Map<String, Object?>.from(value))}};
  }
  return {'nullValue': null};
}

Object? _fromFirestoreValue(Object? value) {
  if (value is! Map) return null;
  if (value.containsKey('stringValue')) return value['stringValue'];
  if (value.containsKey('booleanValue')) return value['booleanValue'];
  if (value.containsKey('integerValue')) {
    return int.tryParse('${value['integerValue']}');
  }
  if (value.containsKey('doubleValue')) return value['doubleValue'];
  final array = value['arrayValue'];
  if (array is Map) {
    final values = array['values'] as List? ?? const [];
    return [for (final item in values) _fromFirestoreValue(item)];
  }
  final map = value['mapValue'];
  if (map is Map) {
    return decodeFields(map['fields'] as Map? ?? const {});
  }
  return null;
}

/// Records a deploy run's progress to Firestore. Idempotent by run id: every
/// write targets the same document, so a phase update overwrites the previous
/// one rather than appending.
class RunRecorder {
  RunRecorder(
    this._store, {
    required this.runId,
    required this.projectId,
    required this.keyHash,
    required List<String> classNames,
  }) : _classNames = List.unmodifiable(classNames);

  final FirestoreRunStore _store;
  final String runId;
  final String projectId;
  final String keyHash;
  final List<String> _classNames;
  String _phase = 'connected';

  /// Records a non-terminal progress update. Fire-and-forget: never awaited,
  /// never able to stall or fail the deploy.
  void recordPhase(String phase, String message) {
    _phase = phase;
    _write({'status': 'running', 'phase': phase, 'message': message});
  }

  /// Records a successful terminal state. Awaited (bounded and swallowed
  /// internally) so a client that lost the response can reliably learn the run
  /// finished before its request returns.
  Future<void> recordDone(List<Map<String, String>> deployed, bool dryRun) {
    _phase = 'done';
    return _write(
      {'status': 'done', 'deployed': deployed, 'dryRun': dryRun},
    );
  }

  /// Records a terminal failure. The phase at failure is kept so the client can
  /// tell a refusal that preceded any write from a failure that may have
  /// followed classes already uploaded.
  Future<void> recordFailed(String error) {
    return _write({'status': 'failed', 'error': error});
  }

  Future<void> _write(Map<String, Object?> patch) async {
    final fields = <String, Object?>{
      'runId': runId,
      'projectId': projectId,
      'keyHash': keyHash,
      'classNames': _classNames,
      'phase': _phase,
      'updatedAt': DateTime.now().toUtc().toIso8601String(),
      ...patch,
    };
    try {
      await _store.put(runId, fields).timeout(runRecordWriteTimeout);
    } catch (error) {
      // The record is advisory: Firestore being slow, unreachable or
      // misconfigured must degrade to the pre-record behaviour, not turn a
      // good deploy into an error.
      stderr.writeln('[run record] failed to persist $runId: $error');
    }
  }
}

/// The terminal endpoint's answer to a status read.
class RunStatusLookup {
  const RunStatusLookup(this.statusCode, this.body);

  final int statusCode;
  final Map<String, Object?> body;
}

/// Looks up a run by its client-generated id for `GET /runStatus/<id>`.
///
/// A run id alone is deliberately not a capability: the caller must present
/// the same API key the run started with, compared by SHA-256 digest, so
/// anyone reading another project's class names still has to know its key.
///
/// Semantics the browser relies on:
///  - 404 for an id it generated itself proves the request never reached the
///    runner, so nothing was written and a retry is safe.
///  - 401/403 when the key is absent or does not match.
///  - 503 when Firestore itself cannot be read (the browser treats that as
///    "unknown" and falls back to re-reading the project).
///  - 200 with the record when found and authenticated.
Future<RunStatusLookup> fetchRunStatus({
  required String runId,
  required String? presentedKey,
  required FirestoreRunStore store,
}) async {
  if (presentedKey == null || presentedKey.isEmpty) {
    return const RunStatusLookup(401, {
      'success': false,
      'error': 'An API key is required to read a run.',
    });
  }

  final Map<String, dynamic>? document;
  try {
    document = await store.get(runId);
  } catch (error) {
    stderr.writeln('[run status] lookup failed for $runId: $error');
    return const RunStatusLookup(503, {
      'success': false,
      'error': 'Run status is temporarily unavailable.',
    });
  }
  if (document == null) {
    return const RunStatusLookup(404, {
      'success': false,
      'error': 'Unknown run.',
    });
  }

  if ('${document['keyHash']}' != sha256Hex(utf8.encode(presentedKey))) {
    return const RunStatusLookup(403, {
      'success': false,
      'error': 'The API key does not match this run.',
    });
  }

  return RunStatusLookup(200, {
    'runId': document['runId'],
    'projectId': document['projectId'],
    'status': document['status'],
    'phase': document['phase'],
    'message': document['message'],
    'error': document['error'],
    'deployed': document['deployed'],
    'dryRun': document['dryRun'] == true,
    'updatedAt': document['updatedAt'],
    'classNames': document['classNames'],
  });
}
