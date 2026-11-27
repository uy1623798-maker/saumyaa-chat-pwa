/* Small promise-based IndexedDB helpers. Everything here stays in this browser. */
function createChatStore(DB_NAME) {
  const DB_VERSION = 1, STORE = 'messages', META = 'meta';
  let database, vaultKey;
  async function rows() { const d = await db(); return new Promise((resolve, reject) => { const r = d.transaction(STORE).objectStore(STORE).getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); }
  function db() {
    if (database) return Promise.resolve(database);
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const d = request.result;
        const messages = d.createObjectStore(STORE, { keyPath: 'id' });
        messages.createIndex('time', 'time'); messages.createIndex('state', 'state');
        d.createObjectStore(META, { keyPath: 'key' });
      };
      request.onsuccess = () => { database = request.result; resolve(database); };
      request.onerror = () => reject(request.error);
    });
  }
  async function transaction(store, mode, fn) {
    const d = await db(); return new Promise((resolve, reject) => {
      const tx = d.transaction(store, mode); const result = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(result); tx.onerror = () => reject(tx.error);
    });
  }
  const DuoDB = {
    unlock: passphrase => navigator.locks.request('saumyaa-vault-migration', async () => {
      const config = await DuoDB.getMeta('vault');
      const salt = config ? Uint8Array.from(config.salt) : crypto.getRandomValues(new Uint8Array(32));
      const candidate = await DuoCrypto.makeKey(passphrase, salt);
      if (config && (await DuoCrypto.decrypt(candidate, config.check)) !== 'Saumyaa vault') throw new Error('Wrong local history code');
      const existing = await rows();
      // Prepare every encrypted row before one atomic migration transaction.
      const encrypted = [];
      for (const row of existing) if (!row.encrypted) encrypted.push({ id: row.id, encrypted: await DuoCrypto.encrypt(candidate, row) });
      const check = await DuoCrypto.encrypt(candidate, 'Saumyaa vault');
      const d = await db();
      await new Promise((resolve, reject) => { const tx = d.transaction([STORE, META], 'readwrite'); for (const row of encrypted) tx.objectStore(STORE).put(row); tx.objectStore(META).delete('ownNumber'); tx.objectStore(META).delete('friendNumber'); tx.objectStore(META).put({ key: 'vault', value: { salt: Array.from(salt), check } }); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
      vaultKey = candidate;
    }),
    exportBackup: async () => {
      const { salt } = await DuoDB.getMeta('vault');
      return { format: 'saumyaa-encrypted-v1', salt, payload: await DuoCrypto.encrypt(vaultKey, await DuoDB.getMessages()) };
    },
    restoreBackup: async (backup, pass) => {
      let messages;
      if (backup.format === 'saumyaa-encrypted-v1' && backup.salt?.length === 32) {
        const backupKey = await DuoCrypto.makeKey(pass, Uint8Array.from(backup.salt));
        messages = await DuoCrypto.decrypt(backupKey, backup.payload);
      } else if (backup.app === 'DuoChat') messages = backup.messages;
      if (!Array.isArray(messages)) throw new Error('Invalid backup');
      const records = [];
      for (const m of messages) {
        if (!m || typeof m.id !== 'string' || !Number.isFinite(m.time) || !Number.isFinite(new Date(m.time).getTime())) throw new Error('Invalid message');
        if (m.file && (typeof m.file.name !== 'string' || typeof m.file.type !== 'string' || typeof m.file.data !== 'string' || atob(m.file.data).length !== m.file.size)) throw new Error('Invalid attachment');
        records.push({ id: m.id, encrypted: await DuoCrypto.encrypt(vaultKey, m) });
      }
      await transaction(STORE, 'readwrite', store => records.forEach(row => store.put(row)));
    },
    putMessage: async message => { if (!vaultKey) throw new Error('History is locked'); const encrypted = await DuoCrypto.encrypt(vaultKey, message); return transaction(STORE, 'readwrite', s => s.put({ id: message.id, encrypted })); },
    getMessages: async () => { if (!vaultKey) return []; const messages = []; for (const row of await rows()) messages.push(await DuoCrypto.decrypt(vaultKey, row.encrypted)); return messages.sort((a,b) => a.time - b.time); },
    getPending: async () => (await DuoDB.getMessages()).filter(m => m.mine && m.state === 'queued'),
    updateState: async (id, state) => { const msg = (await DuoDB.getMessages()).find(m => m.id === id); if (msg) { msg.state = state; await DuoDB.putMessage(msg); } return msg; },
    clearMessages: () => transaction(STORE, 'readwrite', s => s.clear()),
    importMessages: async messages => { for (const message of messages) if (message && message.id && message.time) await DuoDB.putMessage(message); },
    getMeta: async key => { const d = await db(); return new Promise((resolve, reject) => { const r = d.transaction(META).objectStore(META).get(key); r.onsuccess = () => resolve(r.result?.value); r.onerror = () => reject(r.error); }); },
    setMeta: (key, value) => transaction(META, 'readwrite', s => s.put({ key, value }))
  };
  return DuoDB;
}
let DuoDB = createChatStore('duochat-local');
