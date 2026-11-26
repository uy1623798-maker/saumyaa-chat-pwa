/* AES-GCM encryption. The passphrase itself is never sent or stored. */
const DuoCrypto = (() => {
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  const SALT = encoder.encode('DuoChat/v1/passphrase-key'); // Protocol salt, not a secret.
  const to64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
  const from64 = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
  async function makeKey(passphrase) {
    const material = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: SALT, iterations: 250000, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function encrypt(key, value) { const iv = crypto.getRandomValues(new Uint8Array(12)); const data = encoder.encode(JSON.stringify(value)); const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data); return { iv: to64(iv), data: to64(cipher) }; }
  async function decrypt(key, packet) { const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: from64(packet.iv) }, key, from64(packet.data)); return JSON.parse(decoder.decode(plain)); }
  return { makeKey, encrypt, decrypt };
})();
