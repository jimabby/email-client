import * as Crypto from 'expo-crypto';

/**
 * What OpenPGP.js and postal-mime need from the JS runtime and Hermes may not
 * provide. Imported first, from index.ts.
 *
 * - crypto.getRandomValues: key generation, session keys, and padding all
 *   draw on it. expo-crypto supplies a CSPRNG-backed implementation. Nothing
 *   else is installed on `crypto`: OpenPGP.js v5 falls back to its own audited
 *   pure-JS primitives when WebCrypto's `subtle` is absent.
 * - TextDecoder: present in recent Hermes; a UTF-8-only fallback otherwise.
 */
const g = globalThis as any;

if (!g.crypto) g.crypto = {};
if (typeof g.crypto.getRandomValues !== 'function') {
  g.crypto.getRandomValues = <T extends ArrayBufferView | null>(array: T): T => Crypto.getRandomValues(array as any) as T;
}

if (typeof g.TextDecoder === 'undefined') {
  g.TextDecoder = class TextDecoderFallback {
    readonly encoding = 'utf-8';
    constructor(_label?: string) { /* every label decodes as UTF-8 here */ }
    decode(input?: ArrayBuffer | ArrayBufferView): string {
      if (!input) return '';
      const bytes = input instanceof Uint8Array ? input : new Uint8Array((input as ArrayBufferView).buffer ?? input, (input as ArrayBufferView).byteOffset ?? 0, (input as ArrayBufferView).byteLength ?? (input as ArrayBuffer).byteLength);
      let out = '';
      for (let i = 0; i < bytes.length;) {
        const b = bytes[i++];
        let cp: number;
        if (b < 0x80) cp = b;
        else if (b >= 0xc0 && b < 0xe0) cp = ((b & 0x1f) << 6) | (bytes[i++] & 0x3f);
        else if (b >= 0xe0 && b < 0xf0) cp = ((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
        else if (b >= 0xf0) cp = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
        else cp = 0xfffd;
        out += String.fromCodePoint(cp);
      }
      return out;
    }
  };
}
