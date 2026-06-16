import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

// SHA-256 the env key so any length input → a valid 32-byte AES key.
// Set ENCRYPTION_KEY in .env to a random string (e.g. `openssl rand -hex 32`).
const KEY = createHash("sha256")
  .update(process.env.ENCRYPTION_KEY ?? "dev-fallback-key-set-ENCRYPTION_KEY-in-prod")
  .digest();

export function encrypt(plaintext: string): string {
  if (!plaintext) return "";
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${iv.toString("hex")}:${enc.toString("hex")}`;
}

export function decrypt(ciphertext: string): string {
  if (!ciphertext) return "";
  // Plain-text fallback: old values stored before encryption was added.
  if (!ciphertext.includes(":")) return ciphertext;
  try {
    const split   = ciphertext.indexOf(":");
    const iv      = Buffer.from(ciphertext.slice(0, split), "hex");
    const enc     = Buffer.from(ciphertext.slice(split + 1), "hex");
    const decipher = createDecipheriv("aes-256-cbc", KEY, iv);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}
