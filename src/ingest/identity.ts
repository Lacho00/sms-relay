const KOTLIN_WHITESPACE = /[\t\n\v\f\r\u001C-\u001F\p{Zs}\p{Zl}\p{Zp}]/gu;

/** Removes the characters Kotlin's Char.isWhitespace counts, then uppercases. */
export function normalizeSender(s: string): string {
  return s.replace(KOTLIN_WHITESPACE, '').toUpperCase();
}

/** SHA-256 of the UTF-8 bytes of `s`, as lowercase hex. */
export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Dedup key: the same sender, instant and body always produce the same key. */
export async function dedupKey(sender: string, receivedAtMs: number, body: string): Promise<string> {
  return sha256Hex(`${normalizeSender(sender)}|${receivedAtMs}|${await sha256Hex(body)}`);
}
