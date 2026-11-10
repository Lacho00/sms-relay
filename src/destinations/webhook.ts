import type { WebhookConfig } from '../config';
import type { MessageRow } from '../db/repo';
import type { SendResult } from '../outbox/backoff';
import { sendJson } from './http';

export function webhookBody(m: MessageRow, deliveryId: number): string {
  return JSON.stringify({
    event: 'sms.received',
    delivery_id: deliveryId,
    message: {
      id: m.id,
      sender: m.sender,
      body: m.body,
      received_at: new Date(m.receivedAt).toISOString(),
      received_at_ms: m.receivedAt,
      sim: m.sim,
      device: m.device,
    },
  });
}

/** 'sha256=' + lowercase hex of HMAC-SHA256(secret, `${timestamp}.${body}`). */
export async function signWebhook(secret: string, timestamp: number, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${timestamp}.${body}`));
  const hex = Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256=${hex}`;
}

export async function sendWebhook(
  fetchFn: typeof fetch,
  cfg: WebhookConfig,
  m: MessageRow,
  deliveryId: number,
  now: number,
): Promise<SendResult> {
  const body = webhookBody(m, deliveryId);
  const timestamp = Math.floor(now / 1000);
  const headers = {
    'X-Timestamp': String(timestamp),
    'X-Delivery-Id': String(deliveryId),
    'X-Signature': await signWebhook(cfg.secret, timestamp, body),
  };
  const { result } = await sendJson(fetchFn, cfg.url, body, headers, now);
  return result;
}
