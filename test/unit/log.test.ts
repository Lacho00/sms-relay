import { afterEach, expect, it, vi } from 'vitest';
import { log } from '../../src/log';

afterEach(() => vi.restoreAllMocks());

it('writes exactly one JSON line with the event and fields', () => {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  log('ingest.stored', { id: 3 });
  expect(spy).toHaveBeenCalledTimes(1);
  expect(JSON.parse(spy.mock.calls[0]![0] as string)).toEqual({ event: 'ingest.stored', id: 3 });
});

it('works without fields', () => {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  log('retention.purged');
  expect(JSON.parse(spy.mock.calls[0]![0] as string)).toEqual({ event: 'retention.purged' });
});
