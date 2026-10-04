import 'dart:convert';

import 'package:ccc_ffai_runner/sha256.dart';
import 'package:test/test.dart';

void main() {
  // The first two are the canonical FIPS-180-4 examples; the rest exercise the
  // padding-length path (a message that ends exactly at a block boundary, and
  // messages that span two blocks). Expected values verified with `shasum`.
  final vectors = <(String, String)>[
    ('', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'),
    ('abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'),
    (
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ),
    ('${'a' * 64}', 'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb'),
    ('${'a' * 1000}', '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3'),
  ];

  for (final (input, expected) in vectors) {
    test('sha256Hex(${input.length} bytes)', () {
      expect(sha256Hex(utf8.encode(input)), expected);
    });
  }

  test('is deterministic and distinct for a close pair', () {
    final a = sha256Hex(utf8.encode('secret-key-abc'));
    final b = sha256Hex(utf8.encode('secret-key-abc'));
    final c = sha256Hex(utf8.encode('secret-key-abd'));
    expect(a, b);
    expect(a, isNot(c));
  });
}
