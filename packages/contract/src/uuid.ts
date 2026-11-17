/** UUID v7 (RFC 9562): 48-bit unix ms timestamp + random bits. Works in Node and browsers. */
let lastMs = 0;
let seq = 0;

export function uuidv7(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // Monotonic within the same millisecond: use a 12-bit counter in rand_a.
  if (now <= lastMs) {
    now = lastMs;
    seq = (seq + 1) & 0xfff;
    if (seq === 0) now = ++lastMs;
  } else {
    lastMs = now;
    seq = (bytes[6]! & 0x0f) * 256 + bytes[7]!;
    seq &= 0x7ff; // leave headroom for increments
  }
  const ms = BigInt(now);
  for (let i = 0; i < 6; i++) bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = 0x70 | ((seq >> 8) & 0x0f);
  bytes[7] = seq & 0xff;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function uuidv7Timestamp(id: string): number {
  return parseInt(id.replace(/-/g, '').slice(0, 12), 16);
}
