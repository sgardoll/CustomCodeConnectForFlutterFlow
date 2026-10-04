import 'package:ccc_ffai_runner/request_validation.dart';
import 'package:test/test.dart';

/// Contract tests for the runner's request-manifest validation.
///
/// The production regression this guards: sdkPackages was once validated
/// against a hardcoded allowlist that had gone stale, so a correct deploy
/// declaring `flutter_web_plugins` (or `flutter_localizations`) was rejected
/// with "Unsupported SDK package" and every such deploy failed for months. The
/// list is gone - names are validated as package names, not membership - and
/// these tests pin that so the regression cannot quietly come back.
void main() {
  group('normalizeSdkPackages', () {
    test('accepts flutter_web_plugins and flutter_localizations', () {
      final packages = normalizeSdkPackages([
        'flutter',
        'flutter_web_plugins',
        'flutter_localizations',
      ], 'sdkPackages');
      expect(packages, contains('flutter_web_plugins'));
      expect(packages, contains('flutter_localizations'));
    });

    test('rejects a name carrying a dash', () {
      expect(
        () => normalizeSdkPackages(['flutter-web'], 'sdkPackages'),
        throwsA(isA<FormatException>()),
      );
    });

    test('rejects a name carrying a colon', () {
      expect(
        () => normalizeSdkPackages(['foo:bar'], 'sdkPackages'),
        throwsA(isA<FormatException>()),
      );
    });

    test('rejects YAML punctuation (colon, braces, spaces) in a name', () {
      expect(
        () => normalizeSdkPackages(['foo: {bar: baz}'], 'sdkPackages'),
        throwsA(isA<FormatException>()),
      );
    });

    test('isValidPackageName reflects the same rule', () {
      expect(isValidPackageName('flutter_web_plugins'), isTrue);
      expect(isValidPackageName('flutter-localizations'), isFalse);
      expect(isValidPackageName('flutter:localizations'), isFalse);
    });
  });

  group('normalizeDependencyMap', () {
    test('accepts a bare name: constraint entry', () {
      final map = normalizeDependencyMap({'http': '^1.0.0'}, 'dependencies');
      expect(map, {'http': '^1.0.0'});
    });

    test('rejects an empty constraint', () {
      expect(
        () => normalizeDependencyMap({'http': ''}, 'dependencies'),
        throwsA(isA<FormatException>()),
      );
    });

    test('rejects a constraint that could smuggle a git, path or comment', () {
      for (final bad in [
        'git: https://example.com/repo.git',
        'path: ../somewhere',
        '^1.0.0 # a comment',
      ]) {
        expect(
          () => normalizeDependencyMap({'http': bad}, 'dependencies'),
          throwsA(isA<FormatException>()),
          reason: 'expected rejection for constraint: $bad',
        );
      }
    });

    test('rejects a non-object value and an oversized map', () {
      expect(
        () => normalizeDependencyMap('nope', 'dependencies'),
        throwsA(isA<FormatException>()),
      );
    });
  });

  group('validateConstraint', () {
    test('falls back to the default when the field is empty', () {
      expect(
        validateConstraint(
          'verification.sdkConstraint',
          '',
          fallback: '>=3.0.0 <4.0.0',
        ),
        '>=3.0.0 <4.0.0',
      );
    });

    test('rejects a constraint carrying a colon or slash', () {
      expect(
        () => validateConstraint(
          'verification.sdkConstraint',
          '>=3.0.0 git: x',
          fallback: '>=3.0.0 <4.0.0',
        ),
        throwsA(isA<FormatException>()),
      );
    });
  });

  group('normalizeVerification end-to-end', () {
    test('accepts a full manifest declaring flutter_web_plugins', () {
      final request = normalizeVerification({
        'sdkPackages': [
          'flutter',
          'flutter_web_plugins',
          'flutter_localizations',
        ],
        'dependencies': {'http': '^1.0.0'},
        'sources': [
          {'fileName': 'my_class.dart', 'content': 'class MyClass {}'},
        ],
      });
      expect(request, isNotNull);
      expect(request!.sdkPackages, contains('flutter_web_plugins'));
      expect(request.sdkPackages, contains('flutter_localizations'));
      expect(request.dependencies, {'http': '^1.0.0'});
    });

    test('toPubspec emits the sdk package as a source the runner writes', () {
      final request = normalizeVerification({
        'sdkPackages': ['flutter_web_plugins'],
        'sources': <String>[],
      });
      final pubspec = request!.toPubspec();
      expect(pubspec, contains('  flutter_web_plugins:'));
      expect(pubspec, contains('    sdk: flutter'));
    });
  });
}
