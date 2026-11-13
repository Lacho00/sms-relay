import { describe, expect, it } from 'vitest';
import { ALERT_BATCH, formatAlertText } from '../../src/alerts';

describe('formatAlertText', () => {
  it('formats one failed delivery', () => {
    const text = formatAlertText([
      { id: 1, messageId: 123, destination: 'webhook', lastError: 'http_404', attempts: 1 },
    ]);
    expect(text).toBe(
      [
        'sms-relay: 1 delivery failed',
        '',
        'message 123 · webhook · http_404 · 1 attempt',
        '',
        'GET /v1/messages/<id> for details.',
      ].join('\n'),
    );
  });

  it('formats several failed deliveries', () => {
    const text = formatAlertText([
      { id: 1, messageId: 123, destination: 'webhook', lastError: 'http_404', attempts: 1 },
      { id: 2, messageId: 124, destination: 'telegram', lastError: 'attempts_exhausted', attempts: 10 },
    ]);
    expect(text).toBe(
      [
        'sms-relay: 2 deliveries failed',
        '',
        'message 123 · webhook · http_404 · 1 attempt',
        'message 124 · telegram · attempts_exhausted · 10 attempts',
        '',
        'GET /v1/messages/<id> for details.',
      ].join('\n'),
    );
  });

  it('shows unknown when last_error is null', () => {
    const text = formatAlertText([{ id: 1, messageId: 7, destination: 'telegram', lastError: null, attempts: 3 }]);
    expect(text).toContain('message 7 · telegram · unknown · 3 attempts');
  });

  it('exports the batch size', () => {
    expect(ALERT_BATCH).toBe(20);
  });
});
