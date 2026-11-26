/* AES-GCM encryption. The passphrase itself is never sent or stored. */
const DuoCrypto = (() => {
  const encoder = new TextEncoder(), decoder = new TextDecoder();
  const SALT = encoder.encode('DuoChat/v1/passphrase-key'); // Protocol salt, not a secret.
  const to64 = bytes => { const view = new Uint8Array(bytes); let text = ''; for (let i = 0; i < view.length; i += 8192) text += String.fromCharCode(...view.subarray(i, i + 8192)); return btoa(text); };
  const from64 = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
  async function makeKey(passphrase, salt = SALT) {
    const material = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  // Slow down attempts to guess a room from its public signaling identifier.
  async function roomId(passphrase, pair) {
    const material = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveBits']);
    const salt = await crypto.subtle.digest('SHA-256', encoder.encode('Saumyaa/room/v3:' + pair));
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' }, material, 256);
    return 'saumyaa-' + Array.from(new Uint8Array(bits), b => b.toString(16).padStart(2, '0')).join('');
  }
  async function encrypt(key, value) { const iv = crypto.getRandomValues(new Uint8Array(12)); const data = encoder.encode(JSON.stringify(value)); const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data); return { iv: to64(iv), data: to64(cipher) }; }
  async function decrypt(key, packet) { const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: from64(packet.iv) }, key, from64(packet.data)); return JSON.parse(decoder.decode(plain)); }
  return { makeKey, roomId, encrypt, decrypt };
})();
