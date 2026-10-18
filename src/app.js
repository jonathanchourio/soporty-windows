/* Soporty para Windows — interfaz del cliente.
 * Reusa el motor WebRTC de Soporty (SPRoom, en rtc.js). La parte nativa (Rust)
 * solo entra para aplicar el control del técnico. */
(function () {
  'use strict';
  const invoke = window.__TAURI__ && window.__TAURI__.core.invoke;
  const tauriEvent = window.__TAURI__ && window.__TAURI__.event;
  const $ = (id) => document.getElementById(id);

  const DEFAULT_SERVER = 'https://soporty.com';
  let SERVER = (localStorage.getItem('sp_server') || DEFAULT_SERVER).replace(/\/+$/, '');
  let AUTH = null; // "id:token"

  /* ---- fetch: solo las peticiones a NUESTRO servidor reciben cabeceras y URL absoluta.
   *      Las llamadas internas de Tauri (http://ipc.localhost) pasan intactas: si las tocáramos,
   *      Tauri perdería su Tauri-Invoke-Key y el control nativo fallaría. ---- */
  const rawFetch = window.fetch.bind(window);
  window.fetch = function (url, init) {
    let u = typeof url === 'string' ? url : (url && url.url) || '';
    const absolute = /^https?:\/\//i.test(u);
    if (absolute && u.indexOf(SERVER) !== 0) return rawFetch(url, init);
    if (!absolute) u = SERVER + '/' + String(u).replace(/^\//, '');
    init = Object.assign({}, init || {});
    const h = new Headers(init.headers || undefined);
    h.set('X-Soporty', '1');
    if (AUTH) h.set('X-Client-Auth', AUTH);
    init.headers = h;
    return rawFetch(u, init);
  };

  /* ---- SP: lo que SPRoom/rtc.js espera del entorno ---- */
  window.SP = {
    base: SERVER, csrf: '',
    url: (p) => SERVER + '/' + String(p).replace(/^\//, ''),
    esc: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    clock: (sec) => { sec = Math.max(0, Math.floor(sec)); const m = Math.floor(sec / 60), s = sec % 60; return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0'); },
    isMobile: () => false,
    canShareScreen: () => !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia),
    beep: (f = 880, ms = 150) => { try { const c = SP._ac || (SP._ac = new AudioContext()); const o = c.createOscillator(), g = c.createGain(); o.frequency.value = f; g.gain.value = .06; o.connect(g); g.connect(c.destination); o.start(); g.gain.exponentialRampToValueAtTime(.0001, c.currentTime + ms / 1000); o.stop(c.currentTime + ms / 1000 + .02); } catch (e) {} },
    toast: (m) => showToast(m),
    copy: () => {}, modal: () => {},
    api: async function (path, data) {
      const isForm = data instanceof FormData;
      const init = { method: data === undefined ? 'GET' : 'POST', cache: 'no-store' };
      if (data !== undefined) { init.body = isForm ? data : JSON.stringify(data); if (!isForm) init.headers = { 'Content-Type': 'application/json' }; }
      const res = await window.fetch(SP.url(path), init);
      let j = null; try { j = await res.json(); } catch (e) {}
      if (!res.ok || !j || j.ok === false) { const e = new Error((j && j.error) || ('Error ' + res.status)); e.status = res.status; throw e; }
      return j;
    }
  };

  function showToast(msg) {
    let b = document.querySelector('.toasts'); if (!b) { b = document.createElement('div'); b.className = 'toasts'; document.body.appendChild(b); }
    const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; b.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 4200);
  }

  /* ---- estado ---- */
  let room = null, mic = null, micOn = true, screen = null, techName = '', started = 0, skew = 0, ended = false, rating = 0;
  let controlling = false, screenW = 1920, screenH = 1080;
  const INPUT = new Set(['move', 'down', 'up', 'click', 'wheel', 'key', 'keydown', 'keyup', 'text']);
  let inBuf = [], flush = 0;

  document.addEventListener('DOMContentLoaded', () => {
    $('server').value = SERVER;
    $('name').value = localStorage.getItem('sp_name') || '';
    $('code').addEventListener('input', fmtCode);
    $('btnJoin').onclick = join;
    $('btnShare').onclick = () => (screen ? stopShare() : share());
    $('btnMic').onclick = toggleMic;
    $('chatForm').onsubmit = sendMsg;
    $('btnEnd').onclick = endSession;
    $('btnCtlYes').onclick = grantControl;
    $('btnCtlNo').onclick = () => { $('mControl').hidden = true; if (room) room.ctl({ t: 'rc-denied' }); };
    $('btnNew').onclick = () => { localStorage.removeItem('sp_sess'); location.reload(); };
    $('stars').addEventListener('click', (e) => { const s = e.target.closest('[data-r]'); if (!s) return; rating = +s.dataset.r; [...$('stars').children].forEach((x) => x.classList.toggle('on', +x.dataset.r <= rating)); $('btnRate').disabled = false; });
    $('btnRate').onclick = sendRating;
    if (tauriEvent) tauriEvent.listen('rc-stopped', () => onControlStopped());
    document.addEventListener('click', () => { const a = $('ra'); if (a.paused && a.srcObject) a.play().catch(() => {}); }, true);
    setInterval(tick, 1000);
    tryResume();
  });

  function fmtCode() { const d = $('code').value.replace(/\D/g, '').slice(0, 9); const f = d.replace(/(\d{3})(\d{0,3})(\d{0,3})/, (m, a, b, c) => [a, b, c].filter(Boolean).join(' ')); if (f !== $('code').value) $('code').value = f; }

  async function tryResume() {
    const saved = JSON.parse(localStorage.getItem('sp_sess') || 'null');
    if (!saved) return;
    AUTH = saved.id + ':' + saved.token;
    try {
      const r = await SP.api('api/app.php', { action: 'resume' });
      if (r.status === 'active' || r.status === 'waiting') startSession(saved);
      else { localStorage.removeItem('sp_sess'); AUTH = null; }
    } catch (e) { localStorage.removeItem('sp_sess'); AUTH = null; }
  }

  async function join() {
    $('joinErr').hidden = true;
    const code = $('code').value.replace(/\D/g, '');
    const name = $('name').value.trim();
    SERVER = ($('server').value.trim() || DEFAULT_SERVER).replace(/\/+$/, ''); localStorage.setItem('sp_server', SERVER); SP.base = SERVER;
    if (code.length !== 9) return joinErr('El código debe tener 9 números.');
    if (!name) return joinErr('Escribe tu nombre.');
    if (!$('consent').checked) return joinErr('Necesitamos tu autorización para continuar.');
    localStorage.setItem('sp_name', name);
    $('btnJoin').disabled = true;
    try {
      AUTH = null;
      const r = await SP.api('api/app.php', { action: 'join', code, name, platform: 'windows' });
      AUTH = r.id + ':' + r.token;
      const s = { id: r.id, token: r.token, code: r.code, company: r.company, name: r.name };
      localStorage.setItem('sp_sess', JSON.stringify(s));
      startSession(s);
    } catch (e) { joinErr(e.message || 'Sin conexión'); $('btnJoin').disabled = false; }
  }
  function joinErr(m) { $('joinErr').textContent = m; $('joinErr').hidden = false; }

  function startSession(s) {
    $('title').textContent = s.company || 'Soporty';
    $('sub').textContent = SERVER.replace(/^https?:\/\//, '');
    show('panelSession');
    room = new SPRoom({ sid: s.id, role: 'client' });
    room.on('status', (st) => { if (st === 'ended' || st === 'cancelled') return onEnded(); paint(); });
    room.on('poll', (d) => { if (d.started) { started = d.started; skew = d.now - Math.floor(Date.now() / 1000); } if (d.tech && d.tech.name) techName = d.tech.name; room.techOnline = d.peer_online; room.queuePos = d.queue_pos; paint(); });
    room.on('connected', (v) => { paint(); if (v) { room.ctl({ t: 'device', d: 'desktop', app: true, control: true }); room.ctl({ t: 'screen', on: !!screen }); } });
    room.on('track', (track) => { if (track.kind === 'audio') { $('ra').srcObject = new MediaStream([track]); $('ra').play().catch(() => {}); } });
    room.on('message', onMessage);
    room.on('ctl', onCtl);
    room.on('fatal', (m) => { showToast(m); });
    room.start();
    paint();
  }

  function paint() {
    if (!room) return;
    const st = room.status, t = techName || 'tu técnico';
    let txt;
    if (st === 'waiting') txt = room.queuePos ? 'Estás en la fila (lugar ' + room.queuePos + ').' : 'Un técnico te atenderá en un momento.';
    else if (!room.techOnline) txt = 'Esperando a tu técnico…';
    else if (!room.connected) txt = 'Conectando la llamada con ' + t + '…';
    else txt = 'En llamada con ' + t + (screen ? ' · está viendo tu pantalla' : '');
    $('statusText').textContent = txt;
    $('status').querySelector('.dot').style.background = room.connected ? '#3E7B56' : '#A86A12';
    $('btnShare').textContent = screen ? 'Dejar de compartir' : 'Compartir mi pantalla';
    $('btnShare').classList.toggle('danger', !!screen);
    $('btnMic').textContent = micOn ? 'Micrófono activo · tocar para silenciar' : 'Silenciado · tocar para hablar';
    $('btnMic').classList.toggle('danger', !micOn);
  }

  function tick() { if (started && !ended) { $('timer').hidden = false; $('timer').textContent = SP.clock(Math.floor(Date.now() / 1000) + skew - started); } }

  /* ---- voz ---- */
  async function ensureMic() {
    if (mic) return;
    try { const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); mic = s.getAudioTracks()[0]; mic.enabled = micOn; if (room) await room.setTrack('audio', mic); }
    catch (e) { showToast('No se pudo usar el micrófono. Puedes escribir por el chat.'); micOn = false; paint(); }
  }
  async function toggleMic() { if (!mic) { await ensureMic(); return; } micOn = !micOn; mic.enabled = micOn; paint(); }

  /* ---- pantalla ---- */
  async function share() {
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: false });
      const track = s.getVideoTracks()[0]; try { track.contentHint = 'detail'; } catch (e) {}
      screen = track; track.onended = () => stopShare();
      await ensureMic();
      await room.setTrack('video', track);
      room.ctl({ t: 'screen', on: true });
      paint();
    } catch (e) { if (e && e.name !== 'NotAllowedError') showToast('No se pudo compartir la pantalla.'); }
  }
  async function stopShare() {
    if (!screen) return;
    const t = screen; screen = null; try { t.stop(); } catch (e) {}
    annHide();
    if (controlling) stopControlLocal();
    if (room) { await room.setTrack('video', null); room.ctl({ t: 'screen', on: false }); }
    paint();
  }

  /* ---- chat ---- */
  function onMessage(m) {
    const log = $('chatLog');
    const who = m.sender === 'tech' ? (m.author || 'Técnico') : (m.sender === 'client' ? 'Tú' : '');
    const el = document.createElement('div');
    el.className = 'ln ' + m.sender;
    el.textContent = who ? who + ': ' + m.body : m.body;
    const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
    log.appendChild(el); if (stick) log.scrollTop = log.scrollHeight;
    if (m.sender === 'tech') { $('lastBox').hidden = false; $('lastWho').textContent = (m.author || 'Tu técnico') + ' dice:'; $('lastBody').textContent = m.body; SP.beep(760, 90); }
  }
  async function sendMsg(ev) { ev.preventDefault(); const v = $('msg').value.trim(); if (!v || !room) return; $('msg').value = ''; try { await room.api('message', { body: v }); } catch (e) { showToast(e.message); } }

  /* ---- control remoto ---- */
  /* ---- marcas del técnico (puntero y trazos) sobre el escritorio ---- */
  let annAt = 0;
  function annShow() { if (!invoke) return Promise.resolve(); const now = Date.now(); if (now - annAt < 800) return Promise.resolve(); annAt = now; return invoke('ann_show').catch(() => { annAt = 0; }); }
  function annHide() { annAt = 0; if (invoke) invoke('ann_hide').catch(() => {}); }
  function annPush(m) { annShow().then(() => { if (invoke) invoke('ann_push', { m }).catch(() => {}); }); }

  function onCtl(m) {
    const t = m.t;
    if (t === 'ptr' || t === 'stroke' || t === 'clear') { if (screen) annPush(m); return; }
    if (t === 'rc-request') { if (screen) $('mControl').hidden = false; else room.ctl({ t: 'rc-denied', why: 'sin pantalla' }); return; }
    if (t === 'rc-release') { if (controlling) { invoke('rc_stop'); } return; }
    if (t === 'hi' && m.name) { techName = m.name; paint(); return; }
    if (controlling && INPUT.has(t)) { queueInput(m); return; }
  }

  async function grantControl() {
    $('mControl').hidden = true;
    if (!invoke) { showToast('El control no está disponible en esta versión.'); return; }
    const dpr = window.devicePixelRatio || 1;
    let sz = null;
    try { sz = await invoke('rc_screen'); } catch (e) {}
    screenW = (sz && sz[0]) || Math.round(screen.width * dpr) || 1920;
    screenH = (sz && sz[1]) || Math.round(screen.height * dpr) || 1080;
    try { await invoke('rc_start'); }
    catch (e) { room.ctl({ t: 'rc-denied' }); showToast('No se pudo iniciar el control: ' + ((e && e.message) || e)); return; }
    controlling = true;
    room.ctl({ t: 'rc-granted' });
    showToast('Tu técnico está controlando tu equipo. Puedes detenerlo en la barra de arriba.');
  }

  // El overlay (barra roja) o el técnico detuvieron el control.
  function onControlStopped() { controlling = false; inBuf = []; if (room) room.ctl({ t: 'rc-stopped' }); }
  // Detener desde aquí (p. ej. al dejar de compartir).
  function stopControlLocal() { if (invoke) invoke('rc_stop'); }

  function queueInput(m) {
    let ev = null;
    switch (m.t) {
      case 'move': ev = { t: 'move', x: Math.round((m.x || 0) * screenW), y: Math.round((m.y || 0) * screenH) }; break;
      case 'down': case 'up': case 'click': ev = { t: m.t, b: m.b || 'left' }; break;
      case 'wheel': ev = { t: 'wheel', amount: m.amount || 0 }; break;
      case 'text': ev = { t: 'text', text: m.text || '' }; break;
      case 'key': case 'keydown': case 'keyup': ev = { t: m.t, k: m.k || '' }; break;
    }
    if (!ev) return;
    inBuf.push(ev);
    if (!flush) flush = requestAnimationFrame(doFlush);
  }
  function doFlush() { flush = 0; if (!inBuf.length || !controlling) { inBuf = []; return; } const batch = inBuf; inBuf = []; invoke('rc_apply', { events: batch }).catch(() => {}); }

  /* ---- fin ---- */
  async function endSession() {
    if (!confirm('¿Terminar la sesión de soporte?')) return;
    try { await room.api('end'); } catch (e) {}
    onEnded();
  }
  function onEnded() {
    if (ended) return; ended = true;
    if (controlling && invoke) invoke('rc_stop');
    annHide();
    if (screen) { try { screen.stop(); } catch (e) {} }
    if (mic) { try { mic.stop(); } catch (e) {} }
    if (room) room.stop();
    show('panelEnded');
  }
  async function sendRating() {
    $('btnRate').disabled = true;
    const saved = JSON.parse(localStorage.getItem('sp_sess') || 'null'); if (!saved) return;
    try { await SP.api('api/rtc.php', { action: 'rate', id: saved.id, role: 'client', rating, comment: '' }); showToast('¡Gracias por tu calificación!'); $('rate').style.display = 'none'; localStorage.removeItem('sp_sess'); }
    catch (e) { showToast(e.message); $('btnRate').disabled = false; }
  }

  function show(id) { ['panelJoin', 'panelSession', 'panelEnded'].forEach((p) => $(p).hidden = p !== id); }
})();
