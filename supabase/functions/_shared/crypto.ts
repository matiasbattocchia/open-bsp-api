/**
 * Compares two strings in time that depends only on their length, not on
 * where they first differ, so a signature or token check leaks nothing about
 * how much of a guess was right. Lengths are not secret here (a hex HMAC or a
 * configured token has a known length), so unequal lengths return early.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
