// Phase 8 — encrypted storage of provider credentials.
'use strict';

require('../_support/env');

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const secretBox = require('../../utils/secretBox');

const SAMPLE_KEY = 'sk-test-1234567890abcdefghijklmnop';

describe('configuration', () => {
  test('is configured when AI_ENCRYPTION_KEY meets the length floor', () => {
    assert.equal(secretBox.isConfigured(), true);
  });

  test('is NOT configured when the key is absent or too short', () => {
    const original = process.env.AI_ENCRYPTION_KEY;
    try {
      process.env.AI_ENCRYPTION_KEY = '';
      assert.equal(secretBox.isConfigured(), false);
      process.env.AI_ENCRYPTION_KEY = 'short';
      assert.equal(secretBox.isConfigured(), false);
    } finally {
      process.env.AI_ENCRYPTION_KEY = original;
    }
  });

  test('encrypting without a key throws a clear, actionable error', () => {
    const original = process.env.AI_ENCRYPTION_KEY;
    try {
      process.env.AI_ENCRYPTION_KEY = '';
      assert.throws(() => secretBox.encrypt(SAMPLE_KEY), (err) => {
        assert.equal(err.code, 'ENCRYPTION_KEY_MISSING');
        assert.match(err.message, /AI_ENCRYPTION_KEY/);
        return true;
      });
    } finally {
      process.env.AI_ENCRYPTION_KEY = original;
    }
  });
});

describe('round trip', () => {
  test('decrypt(encrypt(x)) === x', () => {
    assert.equal(secretBox.decrypt(secretBox.encrypt(SAMPLE_KEY)), SAMPLE_KEY);
  });

  test('works for keys of every provider shape', () => {
    for (const key of [
      'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789',
      'gsk_abcdefghijklmnopqrstuvwxyz',
      'AIzaSyA-abcdefghijklmnopqrstuvwxyz123456',
      'x',
      'a'.repeat(500),
      'unicode-ключ-🔑',
    ]) {
      assert.equal(secretBox.decrypt(secretBox.encrypt(key)), key);
    }
  });

  test('the ciphertext never contains the plaintext', () => {
    const token = secretBox.encrypt(SAMPLE_KEY);
    assert.equal(token.includes(SAMPLE_KEY), false);
    assert.equal(token.includes('sk-test'), false);
  });

  test('encrypting twice yields different ciphertext (fresh IV each time)', () => {
    const a = secretBox.encrypt(SAMPLE_KEY);
    const b = secretBox.encrypt(SAMPLE_KEY);
    assert.notEqual(a, b);
    assert.equal(secretBox.decrypt(a), secretBox.decrypt(b));
  });

  test('the stored form is version-prefixed', () => {
    assert.match(secretBox.encrypt(SAMPLE_KEY), /^v1\./);
    assert.equal(secretBox.encrypt(SAMPLE_KEY).split('.').length, 4);
  });

  test('an empty value is refused rather than stored as an empty secret', () => {
    assert.throws(() => secretBox.encrypt(''), (err) => {
      assert.equal(err.code, 'ENCRYPT_EMPTY');
      return true;
    });
  });
});

describe('tamper detection (AES-GCM is authenticated)', () => {
  // Tamper at the BYTE level, not the character level. Flipping the last
  // base64url character is not reliably a change at all: when the encoded length
  // leaves spare bits, several characters decode to the same bytes, so the
  // "tampered" token can be byte-identical to the original.
  function flipByte(token, partIndex, byteIndex = 0) {
    const parts = token.split('.');
    const bytes = Buffer.from(parts[partIndex], 'base64url');
    bytes[byteIndex] ^= 0xff;
    parts[partIndex] = bytes.toString('base64url');
    return parts.join('.');
  }

  test('a modified ciphertext fails to decrypt instead of returning rubbish', () => {
    const tampered = flipByte(secretBox.encrypt(SAMPLE_KEY), 3);
    assert.throws(() => secretBox.decrypt(tampered), (err) => {
      assert.equal(err.code, 'DECRYPT_FAILED');
      return true;
    });
  });

  test('a modified auth tag fails', () => {
    const tampered = flipByte(secretBox.encrypt(SAMPLE_KEY), 2);
    assert.throws(() => secretBox.decrypt(tampered), /could not be decrypted/);
  });

  test('a modified IV fails', () => {
    const tampered = flipByte(secretBox.encrypt(SAMPLE_KEY), 1);
    assert.throws(() => secretBox.decrypt(tampered), /could not be decrypted/);
  });

  test('tampering is detected at EVERY byte position, not just the first', () => {
    const token = secretBox.encrypt(SAMPLE_KEY);
    const length = Buffer.from(token.split('.')[3], 'base64url').length;
    for (let i = 0; i < length; i += 1) {
      assert.throws(
        () => secretBox.decrypt(flipByte(token, 3, i)),
        /could not be decrypted/,
        `a flipped byte at position ${i} was not detected`
      );
    }
  });

  test('a DIFFERENT key cannot decrypt', () => {
    const token = secretBox.encrypt(SAMPLE_KEY);
    const original = process.env.AI_ENCRYPTION_KEY;
    try {
      process.env.AI_ENCRYPTION_KEY = 'a-completely-different-encryption-key-00001';
      assert.throws(() => secretBox.decrypt(token), /could not be decrypted/);
    } finally {
      process.env.AI_ENCRYPTION_KEY = original;
    }
  });

  test('a malformed or unknown-version token is refused', () => {
    for (const bad of ['', 'nonsense', 'v1.only.three', 'v2.a.b.c', 'v1...']) {
      assert.throws(() => secretBox.decrypt(bad));
    }
  });

  test('an error never contains the key material or the token', () => {
    const token = secretBox.encrypt(SAMPLE_KEY);
    const parts = token.split('.');
    parts[3] = 'AAAA';
    try {
      secretBox.decrypt(parts.join('.'));
      assert.fail('expected a throw');
    } catch (err) {
      assert.equal(err.message.includes(SAMPLE_KEY), false);
      assert.equal(err.message.includes(process.env.AI_ENCRYPTION_KEY), false);
      assert.equal(err.message.includes(parts[3]), false);
    }
  });
});

describe('masking', () => {
  test('shows only the last four characters', () => {
    assert.equal(secretBox.mask('sk-test-abcd1234'), '••••••••1234');
  });

  test('an empty value masks to an empty string', () => {
    assert.equal(secretBox.mask(''), '');
    assert.equal(secretBox.mask(undefined), '');
  });

  test('the mask length does not reveal the secret length', () => {
    const short = secretBox.mask('abcdef');
    const long = secretBox.mask('a'.repeat(200) + 'wxyz');
    assert.equal(short.length, long.length);
  });

  test('describe() reports configured + masked, never the secret', () => {
    const encrypted = secretBox.encrypt(SAMPLE_KEY);
    const described = secretBox.describe(encrypted);
    assert.equal(described.configured, true);
    assert.equal(described.masked, '••••••••mnop');
    assert.equal(JSON.stringify(described).includes(SAMPLE_KEY), false);
    assert.equal(JSON.stringify(described).includes(encrypted), false);
  });

  test('describe() of nothing reports not configured', () => {
    assert.deepEqual(secretBox.describe(''), { configured: false, masked: '' });
    assert.deepEqual(secretBox.describe(null), { configured: false, masked: '' });
  });

  test('describe() of an undecryptable value degrades instead of throwing', () => {
    const described = secretBox.describe('v1.AAAA.BBBB.CCCC');
    assert.equal(described.configured, true);
    assert.equal(described.unreadable, true);
    assert.equal(described.masked, '');
  });
});
