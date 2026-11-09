import { describe, expect, it } from 'vitest';
import { bearerToken, tokensEqual } from '../../src/http/auth';
import { errorBody, errorResponse } from '../../src/http/errors';

describe('bearerToken', () => {
  it.each([
    ['Bearer abc', 'abc'],
    ['bearer   abc  ', 'abc'],
    ['BEARER abc', 'abc'],
  ])('extracts %j', (header, expected) => {
    expect(bearerToken(header)).toBe(expected);
  });

  it.each(['Bearer ', 'Bearer', 'Basic abc', '', undefined, null])('returns null for %j', (header) => {
    expect(bearerToken(header)).toBeNull();
  });
});

describe('tokensEqual', () => {
  it('accepts equal tokens', async () => {
    expect(await tokensEqual('secret-value', 'secret-value')).toBe(true);
  });
  it('rejects different tokens of the same length', async () => {
    expect(await tokensEqual('secret-value', 'secret-valuf')).toBe(false);
  });
  it('rejects different lengths', async () => {
    expect(await tokensEqual('short', 'much-longer-value')).toBe(false);
  });
  it('rejects empty against non-empty', async () => {
    expect(await tokensEqual('', 'x')).toBe(false);
    expect(await tokensEqual('x', '')).toBe(false);
  });
});

describe('errors', () => {
  it('builds a body', () => {
    expect(errorBody('not_found', 'Not found')).toEqual({ error: 'not_found', message: 'Not found' });
  });
  it('builds a JSON response', async () => {
    const res = errorResponse(400, 'invalid_json', 'x');
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({ error: 'invalid_json', message: 'x' });
  });
});
