import { describe, expect, it } from 'vitest';
import { dedupKey, normalizeSender, sha256Hex } from '../../src/ingest/identity';

describe('normalizeSender', () => {
  it('removes spaces and keeps the plus sign', () => {
    expect(normalizeSender('+1 555 123 4567')).toBe('+15551234567');
  });

  it('removes tab, newline, U+2028 and U+3000', () => {
    expect(normalizeSender('a\tb\nc d　e')).toBe('ABCDE');
  });

  it('removes NBSP', () => {
    expect(normalizeSender('a b')).toBe('AB');
  });

  it('keeps U+FEFF (as Kotlin does)', () => {
    expect(normalizeSender('a﻿b')).toBe('A﻿B');
  });

  it('uppercases letters and maps ß to SS', () => {
    expect(normalizeSender('straße')).toBe('STRASSE');
  });

  it('returns an empty string for whitespace only', () => {
    expect(normalizeSender('  ')).toBe('');
  });
});

describe('sha256Hex', () => {
  it('returns the lowercase hex digest of the UTF-8 bytes', async () => {
    expect(await sha256Hex('hello')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });
});

describe('dedupKey', () => {
  it('matches the known vector for a plain SMS', async () => {
    expect(await dedupKey('+1 555 123 4567', 1762697001000, 'hello')).toBe(
      'cac5a4a5065e1b0c77f50c52da968622c70cfeee2ed5cf08b658337da8154b3e',
    );
  });

  it('matches the known vector for a non-ASCII body', async () => {
    expect(await dedupKey('acme bank', 1762697001000, 'Código: 1234')).toBe(
      '780d293f8472b87142b64782c527fefba76ba1f4782bb04642936f7c4e129463',
    );
  });

  it('treats sender case and whitespace as the same sender', async () => {
    expect(await dedupKey('ACME BANK', 1762697001000, 'x')).toBe(
      await dedupKey('acmebank', 1762697001000, 'x'),
    );
  });

  it('differs when the timestamp differs', async () => {
    expect(await dedupKey('a', 1, 'x')).not.toBe(await dedupKey('a', 2, 'x'));
  });
});
