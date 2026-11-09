/** Extracts the token from a `Bearer <token>` header; null when absent or empty. */
export function bearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^bearer +(.*)$/i.exec(header);
  const token = match?.[1]?.trim();
  return token ? token : null;
}

type TimingSafeSubtle = SubtleCrypto & {
  timingSafeEqual(a: ArrayBufferView | ArrayBuffer, b: ArrayBufferView | ArrayBuffer): boolean;
};

async function sha256(value: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(value);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

/** Compares SHA-256 digests in constant time, so length and content do not leak. */
export async function tokensEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([sha256(a), sha256(b)]);
  return (crypto.subtle as TimingSafeSubtle).timingSafeEqual(da, db);
}
