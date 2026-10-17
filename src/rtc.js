/* Soporty — motor de sesión en vivo
 * SPRoom: sondeo de estado + señalización por HTTP + WebRTC (negociación "perfecta").
 * SPMarks: dibuja puntero y trazos normalizados (0..1) sobre un canvas.
 * SPAnnotator: editor para marcar una imagen y enviarla.
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------ SPRoom */
  class SPRoom {
    constructor(opt) {
      this.sid = opt.sid;
      this.role = opt.role;               // 'tech' | 'client'
      this.polite = opt.role === 'client';
      this.pid = Math.random().toString(36).slice(2) + Date.now().toString(36);
      this.remotePid = null;
      this.after = 0; this.mAfter = 0; this.fAfter = 0;
      this.status = null;
      this.handlers = {};
      this.tracks = { audio: null, video: null };
      this.senders = {};
      this.outbox = []; this.flushing = false; this.flushTimer = null;
      this.sigChain = Promise.resolve();
      this.connected = false;
      this.stopped = false;
      this.iceServers = null;
      this.pc = null; this.dc = null;
      this.makingOffer = false; this.ignoreOffer = false;
      this.pendingIce = [];
      this.lastPtrSent = 0;
      this.usage = { total: 0, relay: 0 };
      this.pcGen = 0;
    }

    on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); return this; }
    emit(ev, ...a) { (this.handlers[ev] || []).forEach((fn) => { try { fn(...a); } catch (e) { console.error(e); } }); }

    api(action, extra = {}) {
      return SP.api('api/rtc.php', Object.assign({ action, id: this.sid, role: this.role }, extra));
    }

    async start() {
      try {
        const r = await fetch(SP.url('api/ice.php?id=' + this.sid), { credentials: 'same-origin', cache: 'no-store' });
        const j = await r.json();
        this.iceServers = (j && j.iceServers) || [];
        this.hasRelay = !!(j && j.relay);
      } catch (e) { this.iceServers = [{ urls: ['stun:stun.l.google.com:19302'] }]; }
      await this.poll(true);
      this.signal('hello', {});
      this.loop();
    }

    stop() {
      this.stopped = true;
      clearTimeout(this.pollTimer);
      clearInterval(this.statsTimer);
      try { if (this.pc) this.pc.close(); } catch (e) {}
      this.pc = null;
    }

    loop() {
      if (this.stopped) return;
      const wait = this.connected ? 1500 : 700;
      this.pollTimer = setTimeout(async () => {
        try { await this.poll(false); this.failures = 0; }
        catch (e) {
          this.failures = (this.failures || 0) + 1;
          if (e.status === 401 || e.status === 403) { this.emit('fatal', e.message); this.stop(); return; }
          if (this.failures === 3) this.emit('offline', true);
        }
        if (this.failures === 0 && this.wasOffline) { this.emit('offline', false); }
        this.wasOffline = this.failures >= 3;
        this.loop();
      }, wait);
    }

    async poll(init) {
      const d = await this.api('poll', { after: this.after, m_after: this.mAfter, f_after: this.fAfter, init: init ? 1 : 0 });
      this.after = d.cursor || this.after;
      if (d.status !== this.status) { const prev = this.status; this.status = d.status; this.emit('status', d.status, prev, d); }
      this.emit('poll', d);
      d.messages.forEach((m) => { this.mAfter = Math.max(this.mAfter, m.id); this.emit('message', m); });
      d.files.forEach((f) => { this.fAfter = Math.max(this.fAfter, f.id); this.emit('file', f); });
      for (const s of d.signals) { this.sigChain = this.sigChain.then(() => this.onSignal(s)).catch((e) => console.warn('señal', e)); }
      await this.sigChain;
      if (d.status === 'ended' || d.status === 'cancelled') { this.stop(); }
    }

    /* ---- señalización saliente: se agrupa para no saturar el servidor ---- */
    signal(type, payload) {
      if (this.stopped) return;
      this.outbox.push({ type, payload: Object.assign({ pid: this.pid }, payload) });
      if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 40);
    }
    async flush() {
      this.flushTimer = null;
      if (this.flushing || !this.outbox.length) return;
      this.flushing = true;
      const batch = this.outbox.splice(0, 80);
      try { await this.api('signal', { signals: batch }); }
      catch (e) { if (e.network) { this.outbox.unshift(...batch); await new Promise((r) => setTimeout(r, 1500)); } }
      this.flushing = false;
      if (this.outbox.length) this.flush();
    }

    async onSignal(s) {
      const p = s.payload || {};
      if (s.sender === 'system') {
        if (s.type === 'ended') { this.status = p.status || 'ended'; this.emit('status', this.status, null, {}); this.stop(); }
        return;
      }
      switch (s.type) {
        case 'hello':
          this.remotePid = p.pid;
          this.rebuild();
          this.signal('ack', {});
          break;
        case 'ack':
          if (p.pid !== this.remotePid) { this.remotePid = p.pid; this.rebuild(); }
          break;
        case 'desc':
          if (p.pid !== this.remotePid || !this.pc) return;
          await this.onDescription(p.sdp);
          break;
        case 'ice':
          if (p.pid !== this.remotePid || !this.pc) return;
          if (!this.pc.remoteDescription) { this.pendingIce.push(p.c); return; }
          try { await this.pc.addIceCandidate(p.c); } catch (e) { if (!this.ignoreOffer) console.warn(e); }
          break;
        case 'ctl':
          this.emit('ctl', p.data || {});
          break;
      }
    }

    /* ---- WebRTC ---- */
    rebuild() {
      if (this.pc) { try { this.pc.close(); } catch (e) {} }
      this.senders = {}; this.pendingIce = []; this.makingOffer = false; this.ignoreOffer = false;
      this.setConnected(false);
      this.pcGen++;
      const pc = this.pc = new RTCPeerConnection({ iceServers: this.iceServers || [] });

      pc.onnegotiationneeded = async () => {
        try {
          this.makingOffer = true;
          await pc.setLocalDescription();
          if (pc !== this.pc) return;
          this.signal('desc', { sdp: pc.localDescription && pc.localDescription.toJSON() });
        } catch (e) { console.warn('negociación', e); }
        finally { this.makingOffer = false; }
      };
      pc.onicecandidate = (ev) => { if (ev.candidate && pc === this.pc) this.signal('ice', { c: ev.candidate.toJSON() }); };
      pc.ontrack = (ev) => { if (pc === this.pc) this.emit('track', ev.track, ev.streams[0] || new MediaStream([ev.track])); };
      pc.onconnectionstatechange = () => {
        if (pc !== this.pc) return;
        const st = pc.connectionState;
        this.setConnected(st === 'connected');
        if (st === 'failed' && !this.polite) { try { pc.restartIce(); } catch (e) {} }
        this.emit('rtc', st);
      };
      pc.ondatachannel = (ev) => this.bindDC(ev.channel);
      if (!this.polite) this.bindDC(pc.createDataChannel('ctl', { ordered: true }));

      const stream = new MediaStream();
      ['audio', 'video'].forEach((k) => {
        const t = this.tracks[k];
        if (t && t.readyState === 'live') { stream.addTrack(t); this.senders[k] = pc.addTrack(t, stream); }
      });
      this.emit('rebuild');
    }

    async onDescription(sdp) {
      const pc = this.pc;
      const offerCollision = sdp.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');
      this.ignoreOffer = !this.polite && offerCollision;
      if (this.ignoreOffer) return;
      await pc.setRemoteDescription(sdp);
      while (this.pendingIce.length) { try { await pc.addIceCandidate(this.pendingIce.shift()); } catch (e) {} }
      if (sdp.type === 'offer') {
        await pc.setLocalDescription();
        this.signal('desc', { sdp: pc.localDescription.toJSON() });
      }
    }

    bindDC(dc) {
      this.dc = dc;
      dc.onopen = () => this.emit('dc', true);
      dc.onclose = () => this.emit('dc', false);
      dc.onmessage = (ev) => { try { this.emit('ctl', JSON.parse(ev.data)); } catch (e) {} };
    }

    /** Envía un mensaje de control. Por canal directo si está abierto; si no, por el servidor. */
    ctl(data, opt = {}) {
      if (this.dc && this.dc.readyState === 'open') { try { this.dc.send(JSON.stringify(data)); return; } catch (e) {} }
      if (opt.lossy) {
        const now = Date.now();
        if (now - this.lastPtrSent < 250) return;
        this.lastPtrSent = now;
      }
      this.signal('ctl', { data });
    }

    /** Asigna (o quita con null) la pista local de audio o video sin renegociar si ya existe. */
    async setTrack(kind, track) {
      this.tracks[kind] = track;
      if (!this.pc) return;
      const sender = this.senders[kind];
      if (sender) { try { await sender.replaceTrack(track); } catch (e) { console.warn(e); } }
      else if (track) { this.senders[kind] = this.pc.addTrack(track, new MediaStream([track])); }
    }

    /** Envía al servidor el consumo acumulado desde el último reporte (solo el técnico reporta). */
    async reportUsage(final = false) {
      if (this.role !== 'tech') return;
      if (final) await this.stats();
      const u = this.usage;
      if (!u.total && !u.relay) return;
      const body = { action: 'usage', id: this.sid, role: this.role, total: u.total, relay: u.relay };
      this.usage = { total: 0, relay: 0 };
      try {
        await fetch(SP.url('api/rtc.php'), { method: 'POST', keepalive: true, credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', 'X-CSRF': SP.csrf, 'X-Soporty': '1' }, body: JSON.stringify(body) });
      } catch (e) { this.usage.total += body.total; this.usage.relay += body.relay; }
    }

    setConnected(v) {
      if (v === this.connected) return;
      this.connected = v;
      clearInterval(this.statsTimer);
      if (v) this.statsTimer = setInterval(() => this.stats(), 3000);
      this.emit('connected', v);
    }

    async stats() {
      if (!this.pc) return;
      try {
        const rep = await this.pc.getStats();
        let pair = null; const cand = {};
        rep.forEach((r) => {
          if (r.type === 'transport' && r.selectedCandidatePairId) pair = rep.get(r.selectedCandidatePairId);
          if (r.type === 'local-candidate' || r.type === 'remote-candidate') cand[r.id] = r;
        });
        if (!pair) rep.forEach((r) => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
        if (!pair) return;
        const lc = cand[pair.localCandidateId] || {}, rc = cand[pair.remoteCandidateId] || {};
        const relay = lc.candidateType === 'relay' || rc.candidateType === 'relay';
        // Consumo: bytes de la conexión desde la última lectura (se reinicia si la conexión se rehízo)
        const cur = (pair.bytesSent || 0) + (pair.bytesReceived || 0);
        const key = pair.id + '|' + (this.pcGen || 0);
        const prev = this.lastBytes && this.lastBytes.key === key ? this.lastBytes.v : 0;
        const delta = Math.max(0, cur - prev);
        this.lastBytes = { key, v: cur };
        this.usage.total += delta;
        if (relay) this.usage.relay += delta;
        this.emit('net', { rtt: pair.currentRoundTripTime ? Math.round(pair.currentRoundTripTime * 1000) : null, relay });
      } catch (e) {}
    }
  }

  /* ------------------------------------------------------------ SPMarks */
  class SPMarks {
    constructor(canvas) {
      this.cv = canvas; this.ctx = canvas.getContext('2d');
      this.strokes = new Map(); this.ptr = null; this.raf = 0; this.extra = [];
      this.ro = new ResizeObserver(() => this.draw());
      this.ro.observe(canvas);
    }
    mirrorTo(canvas) { this.extra.push(canvas); this.draw(); }
    apply(m) {
      if (m.t === 'ptr') { this.ptr = { x: m.x, y: m.y, at: performance.now(), c: m.c || '#C96442' }; }
      else if (m.t === 'stroke') {
        let s = this.strokes.get(m.id);
        if (!s) { s = { c: m.c, w: m.w || 4, pts: [] }; this.strokes.set(m.id, s); }
        s.pts.push(...(m.p || []));
      } else if (m.t === 'clear') { this.strokes.clear(); this.ptr = null; }
      else return false;
      this.kick(); return true;
    }
    kick() { if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); }); }
    paint(cv) {
      const w = cv.clientWidth, h = cv.clientHeight;
      if (!w || !h) return false;
      const dpr = window.devicePixelRatio || 1;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
      const g = cv.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      g.lineCap = 'round'; g.lineJoin = 'round';
      this.strokes.forEach((s) => {
        if (s.pts.length < 1) return;
        g.strokeStyle = s.c; g.lineWidth = s.w * Math.max(0.6, w / 1000);
        g.beginPath();
        s.pts.forEach(([x, y], i) => (i ? g.lineTo(x * w, y * h) : g.moveTo(x * w, y * h)));
        if (s.pts.length === 1) g.lineTo(s.pts[0][0] * w + 0.1, s.pts[0][1] * h);
        g.stroke();
      });
      let anim = false;
      if (this.ptr) {
        const age = performance.now() - this.ptr.at;
        if (age < 2500) {
          anim = true;
          const a = 1 - age / 2500, x = this.ptr.x * w, y = this.ptr.y * h, pulse = 14 + 6 * Math.sin(age / 120);
          g.globalAlpha = a;
          g.fillStyle = this.ptr.c + '40'; g.beginPath(); g.arc(x, y, pulse + 8, 0, Math.PI * 2); g.fill();
          g.strokeStyle = this.ptr.c; g.lineWidth = 3; g.beginPath(); g.arc(x, y, pulse, 0, Math.PI * 2); g.stroke();
          g.fillStyle = this.ptr.c; g.beginPath(); g.arc(x, y, 4, 0, Math.PI * 2); g.fill();
          g.globalAlpha = 1;
        }
      }
      return anim;
    }
    draw() {
      let anim = this.paint(this.cv);
      this.extra = this.extra.filter((c) => c.isConnected || (c.ownerDocument && c.ownerDocument.defaultView && !c.ownerDocument.defaultView.closed));
      this.extra.forEach((c) => { anim = this.paint(c) || anim; });
      if (anim) this.kick();
    }
  }

  /* ------------------------------------------------------------ SPAnnotator */
  const SPAnnotator = {
    open(src, opt = {}) {
      const bg = document.createElement('div');
      bg.className = 'modal-bg open';
      bg.innerHTML = `
        <div class="modal wide">
          <div class="row between" style="margin-bottom:12px">
            <h2 style="margin:0">${SP.esc(opt.title || 'Marcar captura')}</h2>
            <button class="icon-btn" data-a="cancel" aria-label="Cerrar">✕</button>
          </div>
          <div class="row" style="margin-bottom:10px">
            <div class="colors">${['#E03C31', '#C96442', '#2F7DD1', '#2F9E58', '#111111'].map((c, i) => `<button type="button" data-c="${c}" style="background:${c}" class="${i === 0 ? 'on' : ''}" aria-label="Color"></button>`).join('')}</div>
            <select data-a="width" style="width:auto"><option value="4">Fino</option><option value="8" selected>Medio</option><option value="16">Grueso</option></select>
            <select data-a="tool" style="width:auto"><option value="pen">Lápiz</option><option value="rect">Recuadro</option><option value="arrow">Flecha</option></select>
            <button class="btn sec sm" data-a="undo" type="button">Deshacer</button>
            <button class="btn ghost sm" data-a="clear" type="button">Limpiar</button>
            <span style="flex:1"></span>
            ${opt.note ? `<input type="text" data-a="note" placeholder="Instrucción para el cliente (opcional)" style="max-width:320px">` : ''}
          </div>
          <div class="annot-wrap"><canvas></canvas></div>
          <div class="row between" style="margin-top:14px">
            <a class="btn ghost sm" data-a="download" href="#" download="captura.png">Descargar</a>
            <div class="row"><button class="btn sec" data-a="cancel" type="button">Cancelar</button><button class="btn" data-a="send" type="button">${SP.esc(opt.sendLabel || 'Enviar al cliente')}</button></div>
          </div>
        </div>`;
      document.body.appendChild(bg);
      const cv = bg.querySelector('canvas'), g = cv.getContext('2d');
      const img = new Image(); img.crossOrigin = 'anonymous';
      let color = '#E03C31', width = 8, tool = 'pen';
      const shapes = []; let cur = null;
      const redraw = () => {
        g.drawImage(img, 0, 0, cv.width, cv.height);
        const k = cv.width / 1000;
        [...shapes, cur].filter(Boolean).forEach((s) => {
          g.strokeStyle = s.c; g.lineWidth = s.w * Math.max(1, k); g.lineCap = 'round'; g.lineJoin = 'round';
          g.beginPath();
          if (s.t === 'pen') { s.p.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke(); }
          else if (s.t === 'rect') { const [a, b] = [s.p[0], s.p[s.p.length - 1]]; g.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]); }
          else if (s.t === 'arrow') {
            const [a, b] = [s.p[0], s.p[s.p.length - 1]];
            const ang = Math.atan2(b[1] - a[1], b[0] - a[0]), hl = 18 * Math.max(1, k) + s.w * 2;
            g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]);
            g.moveTo(b[0], b[1]); g.lineTo(b[0] - hl * Math.cos(ang - 0.45), b[1] - hl * Math.sin(ang - 0.45));
            g.moveTo(b[0], b[1]); g.lineTo(b[0] - hl * Math.cos(ang + 0.45), b[1] - hl * Math.sin(ang + 0.45));
            g.stroke();
          }
        });
      };
      img.onload = () => {
        const max = 2400, sc = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        cv.width = Math.round(img.naturalWidth * sc); cv.height = Math.round(img.naturalHeight * sc);
        redraw();
      };
      img.src = src;
      const pos = (ev) => { const r = cv.getBoundingClientRect(); return [(ev.clientX - r.left) * cv.width / r.width, (ev.clientY - r.top) * cv.height / r.height]; };
      cv.addEventListener('pointerdown', (ev) => { cv.setPointerCapture(ev.pointerId); cur = { t: tool, c: color, w: width, p: [pos(ev)] }; redraw(); });
      cv.addEventListener('pointermove', (ev) => { if (!cur) return; cur.p.push(pos(ev)); redraw(); });
      const up = () => { if (cur) { shapes.push(cur); cur = null; redraw(); } };
      cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
      const close = () => bg.remove();
      bg.addEventListener('click', async (ev) => {
        const c = ev.target.closest('[data-c]');
        if (c) { color = c.dataset.c; bg.querySelectorAll('[data-c]').forEach((b) => b.classList.toggle('on', b === c)); return; }
        const a = ev.target.closest('[data-a]'); if (!a) { if (ev.target === bg) close(); return; }
        const act = a.dataset.a;
        if (act === 'cancel') close();
        if (act === 'undo') { shapes.pop(); redraw(); }
        if (act === 'clear') { shapes.length = 0; redraw(); }
        if (act === 'download') { a.href = cv.toDataURL('image/png'); }
        if (act === 'send') {
          a.disabled = true; a.textContent = 'Enviando…';
          cv.toBlob(async (blob) => {
            const noteEl = bg.querySelector('[data-a=note]');
            try { await opt.onSend(blob, noteEl ? noteEl.value.trim() : ''); close(); }
            catch (e) { SP.toast(e.message, 'error'); a.disabled = false; a.textContent = opt.sendLabel || 'Enviar al cliente'; }
          }, 'image/png');
        }
      });
      bg.querySelector('[data-a=width]').onchange = (e) => (width = +e.target.value);
      bg.querySelector('[data-a=tool]').onchange = (e) => (tool = e.target.value);
      return { close };
    }
  };

  /* Utilidades de sesión compartidas por técnico y cliente */
  const SPChat = {
    render(log, m, myRole, fileMap) {
      const el = document.createElement('div');
      if (m.sender === 'system') { el.className = 'msg sys'; el.textContent = m.body; }
      else {
        el.className = 'msg' + (m.sender === myRole ? ' me' : '');
        const time = new Date(m.at * 1000).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
        el.innerHTML = `<small>${SP.esc(m.author)} · ${time}</small><span></span>`;
        el.querySelector('span').textContent = m.body;
        const f = m.file_id && fileMap[m.file_id];
        if (f) {
          if (/^image\//.test(f.mime)) { const im = document.createElement('img'); im.src = f.url; im.alt = f.name; im.dataset.full = f.url; el.appendChild(im); }
          else { const a = document.createElement('a'); a.className = 'file'; a.href = f.url + '&dl=1'; a.textContent = '⬇ ' + f.name + ' (' + SPChat.size(f.size) + ')'; el.appendChild(a); }
        }
      }
      const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
      log.appendChild(el);
      if (stick || m.sender === myRole) log.scrollTop = log.scrollHeight;
      return el;
    },
    size(b) { return b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; }
  };

  async function uploadToSession(sid, role, blob, kind, name) {
    const fd = new FormData();
    fd.append('id', sid); fd.append('role', role); fd.append('kind', kind);
    fd.append('file', blob, name || (kind + '-' + Date.now() + '.png'));
    return SP.api('api/upload.php', fd);
  }

  /** Medidor de nivel de micrófono. */
  function micMeter(track, el) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = ctx.createMediaStreamSource(new MediaStream([track]));
      const an = ctx.createAnalyser(); an.fftSize = 256; src.connect(an);
      const data = new Uint8Array(an.frequencyBinCount);
      const tick = () => {
        if (track.readyState !== 'live') { ctx.close(); return; }
        an.getByteFrequencyData(data);
        let sum = 0; for (const v of data) sum += v;
        el.style.width = Math.min(100, (track.enabled ? sum / data.length : 0) * 2.2) + '%';
        requestAnimationFrame(tick);
      };
      tick();
    } catch (e) {}
  }

  window.SPRoom = SPRoom; window.SPMarks = SPMarks; window.SPAnnotator = SPAnnotator; window.SPChat = SPChat;
  window.SPUpload = uploadToSession; window.SPMicMeter = micMeter;
})();
