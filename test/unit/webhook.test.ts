import { describe, expect, it } from 'vitest';
import { sendWebhook, signWebhook, webhookBody } from '../../src/destinations/webhook';
import type { WebhookConfig } from '../../src/config';
import type { MessageRow } from '../../src/db/repo';

const SECRET = 'whsec_test_0123456789abcdef0123456789';
const cfg: WebhookConfig = { url: 'https://hook.example/in', secret: SECRET, filter: { senders: [], regex: null } };
const msg = (over: Partial<MessageRow> = {}): MessageRow => ({
  id: 7, sender: 'ACME', body: 'hello "x"', receivedAt: 1762697001000, sim: null, device: null, createdAt: 5, ...over,
});

describe('signWebhook', () => {
  it('matches the known vector', async () => {
    expect(await signWebhook(SECRET, 1762697001, '{"event":"sms.received"}')).toBe(
      'sha256=79f18f291569015e1599f13b7895bf0a385165d879d1e47509c73cb0db600cc0',
    );
  });
});

describe('webhookBody', () => {
  it('has the spec shape, compact, in key order', () => {
    const s = webhookBody(msg(), 3);
    expect(s).toBe(
      '{"event":"sms.received","delivery_id":3,"message":{"id":7,"sender":"ACME","body":"hello \\"x\\"","received_at":"2025-11-09T14:03:21.000Z","received_at_ms":1762697001000,"sim":null,"device":null}}',
    );
  });
  it('includes sim and device when present', () => {
    const j = JSON.parse(webhookBody(msg({ sim: 2, device: 'pixel' }), 1));
    expect(j.message.sim).toBe(2);
    expect(j.message.device).toBe('pixel');
    expect(j.message.createdAt).toBeUndefined();
  });
});

describe('sendWebhook', () => {
  it('signs the exact bytes sent', async () => {
    let got: { url: string; init: RequestInit } | undefined;
    const fn = (async (url: string, init: RequestInit) => {
      got = { url, init };
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;
    const now = 1762697001999;
    const r = await sendWebhook(fn, cfg, msg(), 9, now);
    expect(r).toMatchObject({ kind: 'response', status: 200 });
    const h = got!.init.headers as Record<string, string>;
    expect(got!.url).toBe(cfg.url);
    expect(h['X-Timestamp']).toBe('1762697001');
    expect(h['X-Delivery-Id']).toBe('9');
    expect(got!.init.body).toBe(webhookBody(msg(), 9));
    expect(h['X-Signature']).toBe(await signWebhook(SECRET, 1762697001, got!.init.body as string));
    expect(h['X-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
  });
  it('maps 503 Retry-After', async () => {
    const fn = (async () => new Response('', { status: 503, headers: { 'Retry-After': '120' } })) as unknown as typeof fetch;
    const r = await sendWebhook(fn, cfg, msg(), 1, 1762697001000);
    expect(r).toMatchObject({ kind: 'response', status: 503, retryAfterMs: 120000 });
  });
});
