import { describe, expect, it } from 'vitest';
import type { Config, SenderFilter } from '../../src/config';
import { selectDestinations, senderAllowed } from '../../src/destinations/filter';

const f = (senders: string[], regex: RegExp | null = null): SenderFilter => ({ senders, regex });

describe('senderAllowed', () => {
  it('passes everything when neither list nor regex is set', () => {
    expect(senderAllowed('anyone', f([]))).toBe(true);
  });

  it('matches the list exactly on the normalized sender', () => {
    expect(senderAllowed('bank', f(['BANK']))).toBe(true);
    expect(senderAllowed(' b a n k ', f(['BANK']))).toBe(true);
    expect(senderAllowed('other', f(['BANK']))).toBe(false);
    expect(senderAllowed('BANKX', f(['BANK']))).toBe(false);
  });

  it('tests the regex on the sender as received', () => {
    expect(senderAllowed('+1555', f([], /^\+1/i))).toBe(true);
    expect(senderAllowed('+4455', f([], /^\+1/i))).toBe(false);
  });

  it('passes a sender that matches only the regex when both are set', () => {
    expect(senderAllowed('+1555', f(['BANK'], /^\+1/i))).toBe(true);
    expect(senderAllowed('bank', f(['BANK'], /^\+1/i))).toBe(true);
    expect(senderAllowed('other', f(['BANK'], /^\+1/i))).toBe(false);
  });

  it('rejects an empty normalized sender when a list is set', () => {
    expect(senderAllowed('   ', f(['BANK']))).toBe(false);
  });
});

describe('selectDestinations', () => {
  const base: Config = {
    ingestToken: 'x'.repeat(32),
    readToken: null,
    telegram: null,
    webhook: null,
    retentionDays: 30,
    maxAttempts: 10,
    displayTimeZone: 'UTC',
    telegramApiBase: 'https://api.telegram.org',
    alertsEnabled: true,
  };
  const telegram = (filter: SenderFilter) => ({ botToken: 't', chatId: '1', filter });
  const webhook = (filter: SenderFilter) => ({ url: 'https://h', secret: 's'.repeat(32), filter });

  it('returns nothing when no destination is configured', () => {
    expect(selectDestinations(base, 'BANK')).toEqual([]);
  });

  it('returns every configured destination whose filter matches, in a fixed order', () => {
    const config = { ...base, telegram: telegram(f([])), webhook: webhook(f([])) };
    expect(selectDestinations(config, 'BANK')).toEqual(['telegram', 'webhook']);
  });

  it('drops a destination whose filter does not match', () => {
    const config = { ...base, telegram: telegram(f(['OTHER'])), webhook: webhook(f(['BANK'])) };
    expect(selectDestinations(config, 'bank')).toEqual(['webhook']);
    const config2 = { ...base, telegram: telegram(f(['BANK'])), webhook: webhook(f(['OTHER'])) };
    expect(selectDestinations(config2, 'bank')).toEqual(['telegram']);
  });
});
