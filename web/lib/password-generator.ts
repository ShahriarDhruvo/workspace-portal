// Temporary passwords: three groups of four characters from an alphabet without look-alikes
// (no 0/O, 1/l/I), about 70 bits of entropy. Uses Web Crypto, so it runs on the server and in the browser.
const ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const GROUPS = 3;
const GROUP_LENGTH = 4;
// Largest multiple of the alphabet size below 256; bytes above it are rejected to avoid modulo bias.
const UNBIASED_LIMIT = 256 - (256 % ALPHABET.length);

export function generateTemporaryPassword(): string {
  const chars: string[] = [];
  const bytes = new Uint8Array(32);
  while (chars.length < GROUPS * GROUP_LENGTH) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte < UNBIASED_LIMIT && chars.length < GROUPS * GROUP_LENGTH) {
        chars.push(ALPHABET[byte % ALPHABET.length]!);
      }
    }
  }
  const groups: string[] = [];
  for (let i = 0; i < GROUPS; i++) groups.push(chars.slice(i * GROUP_LENGTH, (i + 1) * GROUP_LENGTH).join(""));
  return groups.join("-");
}
