import { timingSafeEqual } from "node:crypto";

const API_KEY_BYTE_LENGTH = 32;

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** 32 random bytes as hex — returned to the developer exactly once, never stored. */
export const generateApiKey = (): string => {
  const bytes = new Uint8Array(API_KEY_BYTE_LENGTH);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
};

export const hashApiKey = (key: string): string =>
  new Bun.CryptoHasher("sha256").update(key).digest("hex");

/** Compares SHA-256 digests via timingSafeEqual so equality does not leak secret timing. */
export const isTokenEqual = (presented: string, expected: string): boolean =>
  timingSafeEqual(
    Buffer.from(hashApiKey(presented), "hex"),
    Buffer.from(hashApiKey(expected), "hex"),
  );