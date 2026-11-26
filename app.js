/* DuoChat application logic. PeerJS only brokers the initial WebRTC connection. */
(() => {
  const $ = id => document.getElementById(id);
  const el = { connect: $('connectScreen'), chat: $('chatScreen'), myId: $('myId'), friendId: $('friendId'), pass: $('passphrase'), connectBtn: $('connectButton'), error: $('connectError'), peerState: $('peerState'), status: $('connectionStatus'), typing: $('typingStatus'), messages: $('messages'), input: $('messageInput'), composer: $('composer'), file: $('fileInput'), preview: $('filePreview'), fileName: $('fileName'), toast: $('toast') };
  let peer, conn, key, typingTimer, selectedFile, lastTypingSent = 0, receivedFiles = Object.create(null), reconnectTimer, flushing = false, roomBase, peerSlot = 0;
  let mediaCall, localStream, pendingCall, callToken, callVideo = false, callReady;
  const MAX_FILE = 5 * 1024 * 1024, CHUNK_SIZE = 42 * 1024;

  const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  const escape = text => String(text).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;', "'":'&#039;' })[c]);
  function toast(text) { el.toast.textContent = text; el.toast.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => el.toast.classList.remove('show'), 2600); }
  function setStatus(text, online = false) { el.status.textContent = text; el.status.style.color = online ? '#169c5a' : ''; }
  function canSend() { return conn?.open && conn.ready && key; }
  function showError(message) { el.error.textContent = message; }
  function formatTime(time) { return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(time)); }
  function stateTick(state) { return state === 'read' ? '<span class="ticks read">✓✓</span>' : state === 'delivered' ? '<span class="ticks">✓✓</span>' : state === 'sent' ? '<span class="ticks">✓</span>' : '<span class="ticks">◷</span>'; }
  function attachmentMarkup(file) { const url = file.data ? URL.createObjectURL(new Blob([base64ToBytes(file.data)], { type: 'application/octet-stream' })) : ''; return `<a class="attachment" href="${url || '#'}" ${url ? `download="${escape(file.name)}"` : ''}><span class="file-icon">${file.type?.startsWith('image/') ? '▧' : '▣'}</span><span>${escape(file.name)}<br><small>${Math.ceil(file.size / 1024)} KB</small></span></a>`; }
  function messageNode(msg) { const node = document.createElement('article'); node.className = `bubble ${msg.mine ? 'mine' : ''}`; node.dataset.id = msg.id; node.innerHTML = `${msg.text ? `<div class="body">${escape(msg.text)}</div>` : ''}${msg.file ? attachmentMarkup(msg.file) : ''}<div class="meta"><span>${formatTime(msg.time)}</span>${msg.mine ? stateTick(msg.state) : ''}</div>`; return node; }
  async function renderMessages() { const messages = await DuoDB.getMessages(); el.messages.innerHTML = ''; if (!messages.length) el.messages.innerHTML = '<p class="empty">Your messages stay only on this device. Start the conversation when you are connected.</p>'; else messages.forEach(m => el.messages.append(messageNode(m))); scrollBottom(); }
  function scrollBottom() { requestAnimationFrame(() => { el.messages.scrollTop = el.messages.scrollHeight; }); }
  async function saveAndRender(message) { await DuoDB.putMessage(message); const empty = el.messages.querySelector('.empty'); if (empty) empty.remove(); el.messages.append(messageNode(message)); scrollBottom(); }
  async function replaceMessage(id) { const msg = (await DuoDB.getMessages()).find(m => m.id === id); const old = el.messages.querySelector(`[data-id="${CSS.escape(id)}"]`); if (msg && old) old.replaceWith(messageNode(msg)); }

  function initPeer(slot = 0) {
    if (!window.Peer) { showError('The PeerJS library could not load. Check your internet connection and refresh.'); return; }
    peerSlot = slot;
    peer = new Peer(`${roomBase}-${slot}`, { debug: 1 });
    peer.on('open', () => { setStatus('Waiting for your friend…'); if (slot === 1) scheduleReconnect(); });
    peer.on('connection', async incoming => {
      if (!key && el.pass.value.length >= 6) { try { await prepareKey(); } catch (_) {} }
      if (!key) { incoming.on('open', () => incoming.close()); toast('Incoming connection refused: enter your shared secret first.'); return; }
      if (conn?.ready) { incoming.on('open', () => incoming.close()); return; }
      if (conn) {
        // Both people may press Connect at once. Keep the same connection on both ends.
        if (peer.id < incoming.peer) { incoming.on('open', () => incoming.close()); return; }
        conn.close();
      }
      attachConnection(incoming);
    });
    peer.on('call', incoming => {
      if (!canSend() || incoming.peer !== conn.peer || !callToken || incoming.metadata?.token !== callToken || mediaCall || pendingCall) { incoming.close(); return; }
      callToken = null; pendingCall = incoming; callVideo = incoming.metadata.video === true;
      $('callPanel').classList.remove('hidden'); $('callStatus').textContent = `Incoming ${callVideo ? 'video' : 'voice'} call`;
      $('acceptCall').classList.remove('hidden');
      incoming.on('close', () => endCall(false)); incoming.on('error', () => endCall(false));
    });
    peer.on('disconnected', () => setStatus('Signaling offline'));
    peer.on('error', err => { console.warn('PeerJS:', err); if (err.type === 'unavailable-id' && slot === 0) { peer.destroy(); initPeer(1); return; } if (err.type === 'unavailable-id') { failConnection('This code already has two people connected.'); return; } if (err.type === 'peer-unavailable') { conn = null; setStatus('Waiting for your friend…'); scheduleReconnect(); return; } showError(`Connection error: ${err.type || err.message}`); setStatus('Offline'); });
  }
  async function prepareKey() { const pass = el.pass.value; if (pass.length < 12) throw new Error('Use a secret code of at least 12 characters.'); try { await DuoDB.unlock(pass); } catch (_) { throw new Error('Cannot unlock saved history. Use your original secret code; history has not been deleted.'); } key = await DuoCrypto.makeKey(pass); }
  async function startConnection() {
    showError('');
    try { if (!window.Peer) throw new Error('Could not load the connection service. Check your internet.'); const normalize = value => { let digits = value.replace(/\D/g, ''); if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2); return digits; }; const own = normalize($('ownNumber').value), friend = normalize($('friendNumber').value); if (!/^[6-9]\d{9}$/.test(own) || !/^[6-9]\d{9}$/.test(friend) || own === friend) throw new Error('Enter two different valid 10-digit Indian phone numbers.'); await prepareKey(); const pair = [own, friend].sort().join(':'); roomBase = await DuoCrypto.roomId(el.pass.value, pair); if (peer) peer.destroy(); clearTimeout(reconnectTimer); conn = null; setStatus('Connecting…'); initPeer(); }
    catch (err) { showError(err.message || 'Could not prepare secure connection.'); return false; }
    return true;
  }
  function attachConnection(connection) {
    if (conn && conn !== connection) conn.close(); conn = connection; conn.ready = false;
    conn.on('open', async () => { setStatus('Checking shared secret…'); try { connection.challenge = uid(); await sendEncrypted({ type: 'hello', version: 2, nonce: connection.challenge }); } catch (err) { failConnection('Could not start encrypted connection.'); } });
    let incomingQueue = Promise.resolve();
    conn.on('data', packet => { incomingQueue = incomingQueue.then(() => conn === connection ? receivePacket(packet) : undefined).catch(err => console.error('Packet error:', err)); });
    conn.on('close', () => { if (conn === connection) { endCall(false); conn = null; setStatus('Offline — messages will queue'); scheduleReconnect(); } });
    conn.on('error', () => failConnection('Connection dropped. Your unsent messages are safely queued.'));
  }
  function scheduleReconnect() { clearTimeout(reconnectTimer); if (!key || !peer || peer.destroyed || peerSlot !== 1) return; reconnectTimer = setTimeout(() => { if (!conn && peer.open) attachConnection(peer.connect(`${roomBase}-0`, { reliable: true, serialization: 'json' })); else if (!conn) scheduleReconnect(); }, 5000); }
  function failConnection(message) { if (message.includes('secrets do not match')) { key = null; clearTimeout(reconnectTimer); } if (conn) conn.close(); setStatus('Offline'); showError(message); toast(message); }
  async function sendEncrypted(payload) { if (!conn?.open || !key) throw new Error('Not connected'); conn.send(await DuoCrypto.encrypt(key, payload)); }
  async function receivePacket(packet) {
    let data; try { data = await DuoCrypto.decrypt(key, packet); } catch (_) { return failConnection('Shared secrets do not match. Connection rejected.'); }
    if (data.type === 'hello' && data.version === 2 && typeof data.nonce === 'string' && data.nonce.length <= 100) { await sendEncrypted({ type: 'hello-ok', nonce: data.nonce }); return; }
    if (data.type === 'hello-ok' && conn.challenge && data.nonce === conn.challenge) { conn.challenge = null; conn.ready = true; showError(''); setStatus('Online', true); await flushQueue(); return; }
    if (!conn.ready) return;
    if (data.type === 'call-offer' && typeof data.token === 'string' && !mediaCall && !pendingCall) { callToken = data.token; await sendEncrypted({ type: 'call-ready', token: data.token }); setTimeout(() => { if (callToken === data.token) callToken = null; }, 30000); }
    if (data.type === 'call-ready' && callReady?.token === data.token) callReady.resolve();
    if (data.type === 'call-end') endCall(false);
    if (data.type === 'message') { const input = data.message; if (!input || typeof input.id !== 'string' || input.id.length > 100 || typeof input.text !== 'string' || input.text.length > 4000 || !Number.isFinite(input.time) || Math.abs(input.time - Date.now()) > 31536000000) return; const msg = { id: input.id, text: input.text, time: input.time, mine: false, state: 'delivered' }; if (!(await DuoDB.getMessages()).some(m => m.id === msg.id)) { await saveAndRender(msg); notify(msg); } await sendEncrypted({ type: 'receipt', id: msg.id, state: document.visibilityState === 'visible' ? 'read' : 'delivered' }); }
    if (data.type === 'receipt' && ['delivered', 'read'].includes(data.state)) { const current = (await DuoDB.getMessages()).find(m => m.id === data.id && m.mine); if (current && !(current.state === 'read' && data.state === 'delivered')) { await DuoDB.updateState(data.id, data.state); await replaceMessage(data.id); } }
    if (data.type === 'typing') { el.typing.textContent = 'typing…'; clearTimeout(typingTimer); typingTimer = setTimeout(() => el.typing.textContent = '', 1400); }
    if (data.type === 'file-start' && typeof data.id === 'string' && data.id.length <= 100 && typeof data.name === 'string' && data.name.length <= 255 && typeof data.mime === 'string' && data.mime.length <= 100 && Number.isInteger(data.size) && data.size >= 0 && data.size <= MAX_FILE && Number.isFinite(data.time) && Math.abs(data.time - Date.now()) < 31536000000 && Object.keys(receivedFiles).length < 2) receivedFiles[data.id] = { ...data, chunks: [] };
    if (data.type === 'file-chunk' && Object.hasOwn(receivedFiles, data.id)) { const f = receivedFiles[data.id]; if (Number.isInteger(data.index) && data.index >= 0 && data.index < Math.ceil((MAX_FILE * 4 / 3 + 4) / CHUNK_SIZE) && typeof data.chunk === 'string' && data.chunk.length <= CHUNK_SIZE && data.index === f.chunks.length) f.chunks.push(data.chunk); }
    if (data.type === 'file-end' && Object.hasOwn(receivedFiles, data.id)) { const f = receivedFiles[data.id]; delete receivedFiles[data.id]; const data64 = f.chunks.join(''); const bytes = base64ToBytes(data64); if (bytes.length !== f.size || bytes.length > MAX_FILE) return; const file = { name: f.name, size: f.size, type: f.mime, data: data64 }; const msg = { id: f.id, time: f.time, mine: false, state: 'delivered', file }; if (!(await DuoDB.getMessages()).some(m => m.id === msg.id)) { await saveAndRender(msg); notify(msg); } await sendEncrypted({ type: 'receipt', id: msg.id, state: document.visibilityState === 'visible' ? 'read' : 'delivered' }); }
  }
  async function flushQueue() { if (!canSend() || flushing) return; flushing = true; try { for (const msg of await DuoDB.getPending()) { if (msg.room !== roomBase) continue; try { await transmit(msg); } catch { break; } } } finally { flushing = false; } }
  async function transmit(msg) { if (msg.file?.data) return sendFile(msg); await sendEncrypted({ type: 'message', message: { ...msg, state: 'sent' } }); }
  async function sendText(text) { const msg = { id: uid(), text, time: Date.now(), mine: true, state: 'queued', room: roomBase }; await saveAndRender(msg); if (canSend()) try { await transmit(msg); } catch { toast('Message queued until reconnection.'); } }
  const bytesToBase64 = bytes => { let out = ''; for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(out); };
  const base64ToBytes = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  async function queueFile(file) { const data = bytesToBase64(new Uint8Array(await file.arrayBuffer())); const msg = { id: uid(), time: Date.now(), mine: true, state: 'queued', room: roomBase, file: { name: file.name, size: file.size, type: file.type || 'application/octet-stream', data } }; await saveAndRender(msg); if (canSend()) try { await transmit(msg); } catch { toast('File queued until reconnection.'); } }
  async function sendFile(msg) { const f = msg.file; await sendEncrypted({ type: 'file-start', id: msg.id, messageId: msg.id, name: f.name, size: f.size, mime: f.type, time: msg.time }); for (let i = 0, n = 0; i < f.data.length; i += CHUNK_SIZE, n++) await sendEncrypted({ type: 'file-chunk', id: msg.id, index: n, chunk: f.data.slice(i, i + CHUNK_SIZE) }); await sendEncrypted({ type: 'file-end', id: msg.id, messageId: msg.id, time: msg.time }); }
  function notify(msg) { if (document.hidden && Notification.permission === 'granted') new Notification('Saumyaa', { body: msg.text || `Sent a file: ${msg.file?.name || 'attachment'}` }); }
  async function openMedia(video) { return navigator.mediaDevices.getUserMedia({ audio: true, video }); }
  function wireCall(call) { mediaCall = call; call.on('stream', stream => { $('remoteVideo').srcObject = stream; $('callStatus').textContent = 'Connected'; }); call.on('close', () => endCall(false)); call.on('error', () => { toast('Call failed. Please try again.'); endCall(false); }); }
  async function startCall(video) {
    if (!canSend()) return toast('Connect to your friend before calling.');
    if (mediaCall || pendingCall) return;
    $('callPanel').classList.remove('hidden'); $('callStatus').textContent = 'Allow microphone' + (video ? ' and camera' : '') + ' access…';
    try { localStream = await openMedia(video); $('localVideo').srcObject = localStream; $('localVideo').hidden = !video; $('muteCall').classList.remove('hidden'); const token = uid(); const ready = new Promise((resolve, reject) => { callReady = { token, resolve }; setTimeout(() => reject(new Error('Call timed out')), 10000); }); await sendEncrypted({ type: 'call-offer', token }); await ready; callReady = null; if (!localStream || !canSend()) return; wireCall(peer.call(conn.peer, localStream, { metadata: { token, video } })); $('callStatus').textContent = 'Calling…'; }
    catch (error) { toast('Unable to start call. Check microphone and camera permissions.'); endCall(true); }
  }
  function endCall(tellFriend = true) { if (tellFriend && canSend()) sendEncrypted({ type: 'call-end' }).catch(() => {}); const call = mediaCall || pendingCall; mediaCall = null; pendingCall = null; callToken = null; callReady = null; if (call) call.close(); if (localStream) localStream.getTracks().forEach(track => track.stop()); localStream = null; $('localVideo').srcObject = null; $('remoteVideo').srcObject = null; $('callPanel').classList.add('hidden'); $('acceptCall').classList.add('hidden'); $('muteCall').classList.add('hidden'); $('muteCall').textContent = 'Mute'; }
  $('voiceCall').addEventListener('click', () => startCall(false)); $('videoCall').addEventListener('click', () => startCall(true));
  $('endCall').addEventListener('click', () => endCall(true));
  $('muteCall').addEventListener('click', () => { const track = localStream?.getAudioTracks()[0]; if (track) { track.enabled = !track.enabled; $('muteCall').textContent = track.enabled ? 'Mute' : 'Unmute'; } });
  $('acceptCall').addEventListener('click', async () => { const call = pendingCall; if (!call) return; $('acceptCall').classList.add('hidden'); try { localStream = await openMedia(callVideo); if (pendingCall !== call) { localStream.getTracks().forEach(track => track.stop()); localStream = null; return; } $('localVideo').srcObject = localStream; $('localVideo').hidden = !callVideo; $('muteCall').classList.remove('hidden'); pendingCall = null; wireCall(call); call.answer(localStream); $('callStatus').textContent = 'Connecting…'; } catch (_) { toast('Microphone or camera permission was denied.'); endCall(true); } });
  function setFile(file) { if (!file) return; if (file.size > MAX_FILE) return toast('Files must be 5 MB or smaller.'); selectedFile = file; el.fileName.textContent = `${file.name} (${Math.ceil(file.size / 1024)} KB)`; el.preview.classList.remove('hidden'); }
  function openChat() { el.connect.classList.add('hidden'); el.chat.classList.remove('hidden'); renderMessages(); }
  async function importChat(file) { try { await DuoDB.restoreBackup(JSON.parse(await file.text()), el.pass.value); await renderMessages(); toast('Chat restored.'); } catch { toast('Cannot restore backup. Check the file and secret code.'); } }

  el.connectBtn.addEventListener('click', async () => { if (await startConnection()) openChat(); });
  $('backButton').addEventListener('click', () => { el.chat.classList.add('hidden'); el.connect.classList.remove('hidden'); });
  $('themeButton').addEventListener('click', () => { document.body.classList.toggle('dark'); $('themeButton').textContent = document.body.classList.contains('dark') ? '☀ Light mode' : '☾ Dark mode'; });
  el.composer.addEventListener('submit', async event => { event.preventDefault(); const text = el.input.value.trim(); if (!text && !selectedFile) return; if (text) { await sendText(text); el.input.value = ''; } if (selectedFile) { const file = selectedFile; selectedFile = null; el.preview.classList.add('hidden'); await queueFile(file); } });
  el.input.addEventListener('input', () => { el.input.style.height = 'auto'; el.input.style.height = `${Math.min(el.input.scrollHeight, 120)}px`; if (canSend() && Date.now() - lastTypingSent > 700) { lastTypingSent = Date.now(); sendEncrypted({ type: 'typing' }).catch(() => {}); } });
  $('attachButton').addEventListener('click', () => el.file.click()); el.file.addEventListener('change', () => setFile(el.file.files[0])); $('removeFile').addEventListener('click', () => { selectedFile = null; el.file.value = ''; el.preview.classList.add('hidden'); });
  $('exportButton').addEventListener('click', async () => { try { const backup = await DuoDB.exportBackup(); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: 'application/json' })); a.download = 'saumyaa-encrypted-backup.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); } catch { toast('Backup could not be created.'); } });
  $('importButton').addEventListener('click', () => $('importFile').click()); $('importFile').addEventListener('change', () => importChat($('importFile').files[0]));
  $('clearButton').addEventListener('click', async () => { if (confirm('Delete this local chat history from this device? This cannot be undone.')) { await DuoDB.clearMessages(); await renderMessages(); toast('Local chat cleared.'); } });
  document.addEventListener('visibilitychange', async () => { if (document.visibilityState === 'visible' && canSend()) { for (const m of (await DuoDB.getMessages()).filter(m => !m.mine && m.state === 'delivered')) await sendEncrypted({ type: 'receipt', id: m.id, state: 'read' }); } });
  (async () => { $('ownNumber').value = await DuoDB.getMeta('ownNumber') || ''; $('friendNumber').value = await DuoDB.getMeta('friendNumber') || ''; if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); await renderMessages(); })();
})();
