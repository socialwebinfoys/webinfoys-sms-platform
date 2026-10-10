// Authenticated encryption for secrets that must live in MongoDB (Phase 8).
//
// The only thing this currently protects is an AI provider API key, but nothing
// here is AI-specific.
//
// DESIGN
//   * AES-256-GCM, from Node's built-in crypto — no dependency is added.
//   * The 32-byte key is derived with HKDF-SHA256 from AI_ENCRYPTION_KEY, so the
//     environment variable can be any sufficiently long string rather than
//     having to be exactly 32 raw bytes.
//   * GCM is AEAD: a tampered ciphertext fails to decrypt instead of returning
//     rubbish, so a corrupted or half-rotated value is loud, not silent.
//   * A fresh random IV per encryption, so encrypting the same key twice does
//     not produce the same ciphertext.
//   * The stored form carries a version prefix, so a future scheme can be
//     introduced without guessing at what old rows contain.
//
// WHAT THIS IS NOT
// It protects a database dump from yielding usable credentials. It cannot
// protect against an attacker who already has both the database AND the
// environment. The key belongs in the host's secret store, never in the repo.
'use strict';

const crypto = require('crypto');

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96 bits, the standard GCM nonce size
const KEY_BYTES = 32;
const MIN_SECRET_LENGTH = 32;

// Fixed, application-specific HKDF inputs. These are not secrets; their job is
// domain separation, so the same AI_ENCRYPTION_KEY used elsewhere would derive
// a different key.
const HKDF_SALT = Buffer.from('webinfoys-sms-platform/secretbox/v1');
const HKDF_INFO = Buffer.from('provider-credential-encryption');

function rawSecret() {
  return process.env.AI_ENCRYPTION_KEY || '';
}

// True when a usable encryption key is configured. Callers check this before
// offering to store a secret, so the failure is a clear message rather than a
// crash deep inside a save.
function isConfigured() {
  return rawSecret().length >= MIN_SECRET_LENGTH;
}

function assertConfigured() {
  if (!isConfigured()) {
    const err = new Error(
      `AI_ENCRYPTION_KEY is not configured, or is shorter than ${MIN_SECRET_LENGTH} characters. ` +
        'Set it before storing a provider API key.'
    );
    err.code = 'ENCRYPTION_KEY_MISSING';
    err.statusCode = 503;
    throw err;
  }
}

// Derived per call. Cheap relative to a network round trip, and it means a key
// change takes effect without a restart.
function derivedKey() {
  assertConfigured();
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(rawSecret()), HKDF_SALT, HKDF_INFO, KEY_BYTES));
}

// plaintext -> "v1.<iv>.<authTag>.<ciphertext>", all base64url.
function encrypt(plaintext) {
  if (typeof plaintext !== 'string' || plaintext === '') {
    const err = new Error('Nothing to encrypt: expected a non-empty string');
    err.code = 'ENCRYPT_EMPTY';
    err.statusCode = 400;
    throw err;
  }
  const key = derivedKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

// Reverses encrypt(). Throws on a missing key, an unknown version, a malformed
// token, or any tampering (GCM tag mismatch).
//
// The error deliberately never includes the token or any part of the key.
function decrypt(token) {
  const key = derivedKey();
  const parts = String(token || '').split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    const err = new Error('Stored secret is not in a recognised format');
    err.code = 'DECRYPT_FORMAT';
    err.statusCode = 500;
    throw err;
  }
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(parts[1], 'base64url'));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(parts[3], 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch (e) {
    // A wrong key and a tampered value are indistinguishable here, and both mean
    // the same thing operationally: this value cannot be trusted.
    const err = new Error('Stored secret could not be decrypted (wrong key or altered value)');
    err.code = 'DECRYPT_FAILED';
    err.statusCode = 500;
    throw err;
  }
}

// What an API response may show: proof that something is stored, plus just
// enough to tell two keys apart. Never derived from the ciphertext, so it cannot
// leak length information about short secrets.
function mask(plaintext) {
  const value = String(plaintext || '');
  if (!value) return '';
  const tail = value.slice(-4);
  return `${'•'.repeat(8)}${tail}`;
}

// Convenience for controllers: describe a stored secret without revealing it.
// Decryption failure is reported as "configured but unreadable" rather than
// throwing, so a settings screen still renders after a key rotation.
function describe(encrypted) {
  if (!encrypted) return { configured: false, masked: '' };
  try {
    return { configured: true, masked: mask(decrypt(encrypted)) };
  } catch (e) {
    return { configured: true, masked: '', unreadable: true };
  }
}

module.exports = {
  encrypt,
  decrypt,
  mask,
  describe,
  isConfigured,
  assertConfigured,
  MIN_SECRET_LENGTH,
  VERSION,
};
