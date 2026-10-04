/// SHA-256 as a dependence-free pure-Dart implementation.
///
/// The runner keeps zero runtime dependencies so its image build stays fast,
/// and that constraint is exactly why this exists: the deploy-run record must
/// authenticate status reads without ever storing the callers' API key, so it
/// stores a digest of the key instead. Rather than pull in a pub package (the
/// one thing this codebase deliberately avoids at runtime), the digest is
/// computed here and pinned by tests against the standard FIPS-180-4 vectors.
///
/// The digest is used only as a capability the caller proves it knows the key
/// for, compared for equality in the status handler - it is not a MAC and is
/// never used to transit or key anything, so there is no secret material to
/// protect from timing side channels.
library;

/// Returns the SHA-256 digest of [bytes] as a lowercase hex string.
String sha256Hex(List<int> bytes) {
  final state = <int>[
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];

  final messageLengthBits = bytes.length * 8;
  // Padding: 0x80, zeros to a 56-byte residue, then the 64-bit length.
  final paddedLength = ((bytes.length + 1 + 8 + 63) ~/ 64) * 64;
  final padded = List<int>.filled(paddedLength, 0);
  for (var i = 0; i < bytes.length; i++) {
    padded[i] = bytes[i];
  }
  padded[bytes.length] = 0x80;
  final lengthHigh = (messageLengthBits >>> 32) & 0xFFFFFFFF;
  final lengthLow = messageLengthBits & 0xFFFFFFFF;
  padded[paddedLength - 8] = (lengthHigh >>> 24) & 0xFF;
  padded[paddedLength - 7] = (lengthHigh >>> 16) & 0xFF;
  padded[paddedLength - 6] = (lengthHigh >>> 8) & 0xFF;
  padded[paddedLength - 5] = lengthHigh & 0xFF;
  padded[paddedLength - 4] = (lengthLow >>> 24) & 0xFF;
  padded[paddedLength - 3] = (lengthLow >>> 16) & 0xFF;
  padded[paddedLength - 2] = (lengthLow >>> 8) & 0xFF;
  padded[paddedLength - 1] = lengthLow & 0xFF;

  final w = List<int>.filled(64, 0);
  for (var blockStart = 0; blockStart < paddedLength; blockStart += 64) {
    for (var i = 0; i < 16; i++) {
      final base = blockStart + i * 4;
      w[i] = (((padded[base] << 24) |
                  (padded[base + 1] << 16) |
                  (padded[base + 2] << 8) |
                  padded[base + 3]) &
              0xFFFFFFFF);
    }
    _compress(state, w);
  }

  return state
      .map((word) => word.toRadixString(16).padLeft(8, '0'))
      .join();
}

void _compress(List<int> h, List<int> w) {
  for (var i = 16; i < 64; i++) {
    final s0 = _rotr(w[i - 15], 7) ^ _rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
    final s1 = _rotr(w[i - 2], 17) ^ _rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) & 0xFFFFFFFF;
  }

  var a = h[0], b = h[1], c = h[2], d = h[3];
  var e = h[4], f = h[5], g = h[6], gh = h[7];

  for (var i = 0; i < 64; i++) {
    final bigS1 = _rotr(e, 6) ^ _rotr(e, 11) ^ _rotr(e, 25);
    final ch = (e & f) ^ ((~e) & g);
    final temp1 = (gh + bigS1 + ch + _roundConstants[i] + w[i]) & 0xFFFFFFFF;
    final bigS0 = _rotr(a, 2) ^ _rotr(a, 13) ^ _rotr(a, 22);
    final maj = (a & b) ^ (a & c) ^ (b & c);
    final temp2 = (bigS0 + maj) & 0xFFFFFFFF;

    gh = g;
    g = f;
    f = e;
    e = (d + temp1) & 0xFFFFFFFF;
    d = c;
    c = b;
    b = a;
    a = (temp1 + temp2) & 0xFFFFFFFF;
  }

  final tv = [a, b, c, d, e, f, g, gh];
  for (var i = 0; i < 8; i++) {
    h[i] = (h[i] + tv[i]) & 0xFFFFFFFF;
  }
}

int _rotr(int value, int bits) =>
    ((value >>> bits) | (value << (32 - bits))) & 0xFFFFFFFF;

// The first 32 bits of the fractional parts of the cube roots of the first 64
// primes. Inlined as data rather than generated so the loop can index it.
const List<int> _roundConstants = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
