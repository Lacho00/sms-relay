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

it('never serializes keys outside the whitelist', () => {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const row = { id: 7, sender: '+15551230000', body: 'secret code 123', status: 200 };
  log('ingest.stored', row as unknown as Parameters<typeof log>[1]);
  const line = spy.mock.calls[0]![0] as string;
  expect(JSON.parse(line)).toEqual({ event: 'ingest.stored', id: 7, status: 200 });
  expect(line).not.toMatch(/sender|body|secret code|555123/);
});

it('logs the alert and read events with a count', () => {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  log('alert.sent', { count: 2 });
  expect(spy.mock.calls[0]![0]).toBe('{"event":"alert.sent","count":2}');
});

it('keeps every whitelisted field', () => {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  const all = {
    id: 1, deliveryId: 2, destination: 'webhook', status: 500, error: 'http_500',
    attempt: 3, count: 4, ms: 5, variable: 'WEBHOOK_URL',
  } as const;
  log('delivery.retry', all);
  expect(JSON.parse(spy.mock.calls[0]![0] as string)).toEqual({ event: 'delivery.retry', ...all });
});
