/* Small promise-based IndexedDB helpers. Everything here stays in this browser. */
const DuoDB = (() => {
  const DB_NAME = 'duochat-local', DB_VERSION = 1, STORE = 'messages', META = 'meta';
  let database;
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
  return {
    putMessage: message => transaction(STORE, 'readwrite', s => s.put(message)),
    getMessages: async () => { const d = await db(); return new Promise((resolve, reject) => { const r = d.transaction(STORE).objectStore(STORE).index('time').getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); },
    getPending: async () => (await DuoDB.getMessages()).filter(m => m.mine && m.state === 'queued'),
    updateState: async (id, state) => { const d = await db(); const msg = await new Promise((resolve, reject) => { const r = d.transaction(STORE).objectStore(STORE).get(id); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); if (msg) { msg.state = state; await DuoDB.putMessage(msg); } return msg; },
    clearMessages: () => transaction(STORE, 'readwrite', s => s.clear()),
    importMessages: async messages => { for (const message of messages) if (message && message.id && message.time) await DuoDB.putMessage(message); },
    getMeta: async key => { const d = await db(); return new Promise((resolve, reject) => { const r = d.transaction(META).objectStore(META).get(key); r.onsuccess = () => resolve(r.result?.value); r.onerror = () => reject(r.error); }); },
    setMeta: (key, value) => transaction(META, 'readwrite', s => s.put({ key, value }))
  };
})();
