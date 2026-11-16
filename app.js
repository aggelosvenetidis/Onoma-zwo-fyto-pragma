// =====================================================================
// app.js — Frontend (vanilla JS, χωρίς build step).
// Ο server αποφασίζει για όλα· εδώ μόνο εμφανίζουμε και στέλνουμε.
// =====================================================================
(() => {
  'use strict';

  // ---------- Βοηθητικά ----------
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* */ } },
  };
  const tokenKey = (code) => `ozfp:token:${code}`;

  // ---------- Κατάσταση client ----------
  let cfg = null;              // /api/config
  let state = null;            // τελευταίο room:state
  let me = { playerId: null, code: null };
  let timeOffset = 0;          // serverTime - clientTime
  let builtRound = null;       // για να μη ξαναφτιάχνουμε τα inputs (χάνεται το focus)
  let locked = {};             // κατηγορίες που κλείδωσα σε αυτόν τον γύρο
  let autoSubmitted = false;
  let lastPhase = null;
  let lastTick = null;
  const prefs = store.get('ozfp:prefs', { theme: null, muted: false });
  const profile = store.get('ozfp:profile', { nick: '', avatar: null, color: null });
  const createSettings = { maxPlayers: 5, rounds: 5, timeSec: 90, categories: [] };

  const serverNow = () => Date.now() + timeOffset;

  // ---------- Θέμα & ήχος ----------
  function applyTheme() {
    const dark = prefs.theme ? prefs.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    $('themeBtn').textContent = dark ? '☀️' : '🌙';
  }
  $('themeBtn').onclick = () => {
    prefs.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    store.set('ozfp:prefs', prefs); applyTheme();
  };
  function applyMute() { $('muteBtn').textContent = prefs.muted ? '🔇' : '🔊'; }
  $('muteBtn').onclick = () => { prefs.muted = !prefs.muted; store.set('ozfp:prefs', prefs); applyMute(); };

  // Ήχοι με Web Audio (χωρίς αρχεία)
  let audioCtx = null;
  function tone(freq, dur = 0.12, type = 'sine', vol = 0.15) {
    if (prefs.muted) return;
    try {
      audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = type; o.frequency.value = freq;
      g.gain.setValueAtTime(vol, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
      o.connect(g).connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + dur);
    } catch { /* */ }
  }
  const sfx = {
    tick: () => tone(880, 0.06, 'square', 0.06),
    lock: () => { tone(660, 0.08); setTimeout(() => tone(990, 0.1), 70); },
    letter: () => [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => tone(f, 0.15, 'triangle'), i * 90)),
    end: () => [784, 523].forEach((f, i) => setTimeout(() => tone(f, 0.2, 'sawtooth', 0.08), i * 150)),
    win: () => [523, 659, 784, 1047, 1319].forEach((f, i) => setTimeout(() => tone(f, 0.18, 'triangle'), i * 110)),
  };
  const vibrate = (p) => { if (!prefs.muted && navigator.vibrate) navigator.vibrate(p); };

  // ---------- Toasts & confetti ----------
  function toast(text, type = '') {
    const el = document.createElement('div');
    el.className = `toast ${type}`; el.textContent = text;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), 2700);
  }
  function confetti() {
    const box = $('confetti');
    const colors = ['#ff5d73', '#ffb020', '#22c55e', '#3b82f6', '#a855f7'];
    for (let i = 0; i < 90; i++) {
      const c = document.createElement('i');
      c.style.left = Math.random() * 100 + 'vw';
      c.style.background = colors[i % colors.length];
      c.style.animationDuration = 2 + Math.random() * 2 + 's';
      c.style.animationDelay = Math.random() * 0.6 + 's';
      box.appendChild(c);
      setTimeout(() => c.remove(), 5000);
    }
  }

  // ---------- Οθόνες ----------
  const screens = ['home', 'lobby', 'game', 'validating', 'results', 'final'];
  function show(name) {
    for (const s of screens) $(`screen-${s}`).classList.toggle('hidden', s !== name);
  }

  // ---------- Socket ----------
  const socket = io({ transports: ['websocket', 'polling'] });

  function syncTime() {
    const t0 = Date.now();
    socket.emit('time:sync', {}, (res) => {
      const t1 = Date.now();
      if (res && res.serverNow) timeOffset = res.serverNow + (t1 - t0) / 2 - t1;
    });
  }

  socket.on('connect', () => {
    syncTime();
    // Αυτόματη επανασύνδεση στο δωμάτιο μετά από χάσιμο δικτύου
    if (me.code) {
      const token = store.get(tokenKey(me.code));
      if (token) joinRoom(me.code, token, true);
    }
  });
  socket.on('disconnect', () => toast('Χάθηκε η σύνδεση… προσπαθούμε ξανά', 'error'));
  socket.on('toast', (t) => toast(t.text, t.type));
  socket.on('room:expired', () => { toast('Το δωμάτιο έληξε λόγω αδράνειας', 'error'); goHome(); });

  socket.on('room:state', (s) => {
    state = s;
    render();
  });

  socket.on('round:progress', (p) => {
    if (p.playerId === me.playerId) return;
    const pl = state && state.players.find((x) => x.id === p.playerId);
    toast(`${pl ? pl.avatar : ''} ${p.nick} ολοκλήρωσε: ${p.label} ✓`);
  });

  socket.on('round:finishCountdown', (p) => {
    toast(`⏱️ ${p.by} τελείωσε! ${Math.round((p.deadline - p.serverNow) / 1000)} δευτ. για τους υπόλοιπους`);
    vibrate([80, 60, 80]);
  });

  // Μετά από reconnect: οι δικές μου κλειδωμένες λέξεις
  socket.on('you:answers', ({ round, words }) => {
    if (!state || !state.round || state.round.number !== round) return;
    locked = { ...words };
    builtRound = null; // ξαναχτίζουμε τα πεδία με τις τιμές
    render();
  });

  // ---------- Αρχική οθόνη ----------
  function buildHome() {
    // Avatars & χρώματα
    profile.avatar ||= cfg.avatars[Math.floor(Math.random() * cfg.avatars.length)];
    profile.color ||= cfg.colors[Math.floor(Math.random() * cfg.colors.length)];
    $('nickInput').value = profile.nick || '';

    const ap = $('avatarPicker');
    ap.innerHTML = cfg.avatars.map((a) => `<button type="button" class="pick ${a === profile.avatar ? 'selected' : ''}" data-v="${a}">${a}</button>`).join('');
    ap.onclick = (e) => {
      const b = e.target.closest('.pick'); if (!b) return;
      profile.avatar = b.dataset.v;
      ap.querySelectorAll('.pick').forEach((x) => x.classList.toggle('selected', x === b));
    };
    const cp = $('colorPicker');
    cp.innerHTML = cfg.colors.map((c) => `<button type="button" class="pick swatch ${c === profile.color ? 'selected' : ''}" data-v="${c}" style="background:${c}" aria-label="χρώμα"></button>`).join('');
    cp.onclick = (e) => {
      const b = e.target.closest('.pick'); if (!b) return;
      profile.color = b.dataset.v;
      cp.querySelectorAll('.pick').forEach((x) => x.classList.toggle('selected', x === b));
    };

    // Ρυθμίσεις δωματίου
    const seg = (id, values, key, fmt = (v) => v) => {
      const el = $(id);
      el.innerHTML = values.map((v) => `<button type="button" data-v="${v}" class="${v === createSettings[key] ? 'on' : ''}">${fmt(v)}</button>`).join('');
      el.onclick = (e) => {
        const b = e.target.closest('button'); if (!b) return;
        createSettings[key] = Number(b.dataset.v);
        el.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      };
    };
    const players = []; for (let i = cfg.minPlayers; i <= cfg.maxPlayers; i++) players.push(i);
    createSettings.maxPlayers = cfg.maxPlayers;
    createSettings.rounds = cfg.rounds[0];
    createSettings.timeSec = cfg.times[1] || cfg.times[0];
    createSettings.categories = cfg.categories.filter((c) => c.default).map((c) => c.id);
    seg('segPlayers', players, 'maxPlayers');
    seg('segRounds', cfg.rounds, 'rounds');
    seg('segTime', cfg.times, 'timeSec', (v) => `${v}″`);

    const chips = $('catChips');
    const drawChips = () => {
      chips.innerHTML = cfg.categories.map((c) => `<button type="button" class="chip ${createSettings.categories.includes(c.id) ? 'on' : ''}" data-v="${c.id}">${esc(c.label)}</button>`).join('');
    };
    drawChips();
    chips.onclick = (e) => {
      const b = e.target.closest('.chip'); if (!b) return;
      const id = b.dataset.v; const list = createSettings.categories;
      if (list.includes(id)) {
        if (list.length <= 2) return toast('Χρειάζονται τουλάχιστον 2 κατηγορίες');
        list.splice(list.indexOf(id), 1);
      } else list.push(id);
      drawChips();
    };

    // Tabs
    document.querySelectorAll('.tab').forEach((t) => {
      t.onclick = () => switchTab(t.dataset.tab);
    });
  }

  function switchTab(tab) {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
    $('panel-create').classList.toggle('hidden', tab !== 'create');
    $('panel-join').classList.toggle('hidden', tab !== 'join');
  }

  function readProfile() {
    const nick = $('nickInput').value.trim();
    if (!nick) { toast('Γράψε ένα ψευδώνυμο 🙂', 'error'); $('nickInput').focus(); return null; }
    profile.nick = nick;
    store.set('ozfp:profile', profile);
    return { nick, avatar: profile.avatar, color: profile.color };
  }

  $('createBtn').onclick = () => {
    const p = readProfile(); if (!p) return;
    $('createBtn').disabled = true;
    socket.emit('room:create', { ...p, settings: createSettings }, (res) => {
      $('createBtn').disabled = false;
      if (!res || !res.ok) return toast((res && res.error) || 'Σφάλμα', 'error');
      enterRoom(res);
    });
  };

  $('joinBtn').onclick = () => {
    const p = readProfile(); if (!p) return;
    const code = $('codeInput').value.trim().toUpperCase();
    if (code.length !== 4) return toast('Ο κωδικός έχει 4 χαρακτήρες', 'error');
    joinRoom(code, store.get(tokenKey(code)), false, p);
  };

  function joinRoom(code, token, silent, p = null) {
    const payload = { code, token, ...(p || { nick: profile.nick, avatar: profile.avatar, color: profile.color }) };
    socket.emit('room:join', payload, (res) => {
      if (!res || !res.ok) {
        if (token) store.del(tokenKey(code)); // παλιό token
        if (!silent) toast((res && res.error) || 'Σφάλμα', 'error');
        else { me.code = null; goHome(); toast((res && res.error) || 'Δεν βρέθηκε το δωμάτιο', 'error'); }
        return;
      }
      if (res.rejoined && silent) toast('Επανασυνδέθηκες ✓');
      enterRoom(res);
    });
  }

  function enterRoom(res) {
    me = { playerId: res.playerId, code: res.code };
    store.set(tokenKey(res.code), res.token);
    if (location.pathname !== `/room/${res.code}`) history.replaceState(null, '', `/room/${res.code}`);
    render(); // η κατάσταση μπορεί να ήρθε πριν το ack
  }

  function goHome() {
    me = { playerId: null, code: null };
    state = null; builtRound = null; locked = {};
    history.replaceState(null, '', '/');
    $('inviteText').textContent = 'Παίξε με 2–5 φίλους, online, σε πραγματικό χρόνο.';
    switchTab('create');
    show('home');
  }

  $('brandBtn').onclick = () => { if (!me.code || confirm('Θέλεις να βγεις από το δωμάτιο;')) leaveRoom(); };
  function leaveRoom() {
    if (me.code) { store.del(tokenKey(me.code)); socket.emit('room:leave', {}); }
    goHome();
  }

  // ---------- Lobby ----------
  const roomUrl = () => `${location.origin}/room/${me.code}`;
  $('shareBtn').onclick = async () => {
    const data = { title: 'Όνομα, Ζώο, Φυτό, Πράγμα', text: `Έλα να παίξουμε! Κωδικός: ${me.code}`, url: roomUrl() };
    if (navigator.share) { try { await navigator.share(data); } catch { /* ακύρωση */ } }
    else window.open(`https://wa.me/?text=${encodeURIComponent(`${data.text} ${data.url}`)}`, '_blank');
  };
  $('copyBtn').onclick = async () => {
    try { await navigator.clipboard.writeText(roomUrl()); toast('Το link αντιγράφηκε ✓'); }
    catch { prompt('Αντέγραψε το link:', roomUrl()); }
  };
  $('readyBtn').onclick = () => {
    const mine = state.players.find((p) => p.id === me.playerId);
    socket.emit('player:ready', { ready: !(mine && mine.ready) });
  };
  $('startBtn').onclick = () => {
    socket.emit('game:start', {}, (res) => { if (res && !res.ok) toast(res.error, 'error'); });
  };
  $('leaveBtn').onclick = leaveRoom;

  function playerRow(p, extra = '') {
    const host = p.id === state.hostId ? ' 👑' : '';
    const you = p.id === me.playerId ? ' <span class="muted">(εσύ)</span>' : '';
    return `<li>
      <span class="avatar" style="--pc:${esc(p.color)}">${esc(p.avatar)}</span>
      <span class="pname">${esc(p.nick)}${host}${you}</span>${extra}</li>`;
  }

  function renderLobby() {
    const isHost = state.hostId === me.playerId;
    const mine = state.players.find((p) => p.id === me.playerId);
    $('lobbyCode').textContent = state.code;
    $('lobbyCount').textContent = `${state.players.length}/${state.settings.maxPlayers}`;
    $('lobbyPlayers').innerHTML = state.players.map((p) => {
      let badge;
      if (!p.connected) badge = '<span class="badge off">εκτός</span>';
      else if (p.id === state.hostId) badge = '<span class="badge ok">host</span>';
      else badge = p.ready ? '<span class="badge ok">έτοιμος ✓</span>' : '<span class="badge">περιμένει</span>';
      return playerRow(p, badge);
    }).join('');
    const s = state.settings;
    $('lobbySettings').innerHTML =
      `<span class="badge">🔁 ${s.rounds} γύροι</span><span class="badge">⏱️ ${s.timeSec}″</span>` +
      state.categories.map((c) => `<span class="badge">${esc(c.label)}</span>`).join('');

    $('readyBtn').classList.toggle('hidden', isHost);
    $('readyBtn').textContent = mine && mine.ready ? 'Δεν είμαι έτοιμος ✋' : 'Είμαι έτοιμος ✋';
    $('readyBtn').classList.toggle('btn-primary', !(mine && mine.ready));
    $('startBtn').classList.toggle('hidden', !isHost);
    const others = state.players.filter((p) => p.id !== state.hostId && p.connected);
    const canStart = others.length >= 1 && others.every((p) => p.ready);
    $('startBtn').disabled = !canStart;
    $('startBtn').textContent = canStart ? 'Έναρξη ▶' : (others.length ? 'Περιμένουμε να είναι όλοι έτοιμοι…' : 'Περιμένουμε παίκτες…');
  }

  // ---------- Γύρος ----------
  function buildAnswers() {
    const form = $('answersForm');
    form.innerHTML = state.categories.map((c, i) => {
      const val = locked[c.id];
      const isLocked = val !== undefined;
      return `<div class="answer ${isLocked ? 'locked' : ''}" data-cat="${c.id}">
        <span class="cat">${esc(c.label)}</span>
        <input type="text" data-cat="${c.id}" data-i="${i}" value="${esc(val || '')}" ${isLocked ? 'disabled' : ''}
          lang="el" inputmode="text" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false"
          enterkeyhint="${i === state.categories.length - 1 ? 'done' : 'next'}" maxlength="30" placeholder="${esc(state.round.letter || '')}…" />
        <button type="button" class="lock-btn" data-cat="${c.id}" ${isLocked ? 'disabled' : ''} aria-label="Κλείδωμα">✓</button>
      </div>`;
    }).join('');

    form.querySelectorAll('input').forEach((inp) => {
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); lockCategory(inp.dataset.cat, true); }
      });
      // Το πληκτρολόγιο δεν πρέπει να κρύβει το ενεργό πεδίο
      inp.addEventListener('focus', () => setTimeout(() => inp.closest('.answer').scrollIntoView({ block: 'center', behavior: 'smooth' }), 250));
    });
    form.querySelectorAll('.lock-btn').forEach((b) => {
      b.onclick = () => lockCategory(b.dataset.cat, true);
    });
  }

  function focusNext() {
    const next = [...$('answersForm').querySelectorAll('input:not([disabled])')][0];
    if (next) next.focus({ preventScroll: true });
    else document.activeElement && document.activeElement.blur();
  }

  function lockCategory(cat, moveFocus) {
    if (locked[cat] !== undefined) return;
    const inp = $('answersForm').querySelector(`input[data-cat="${cat}"]`);
    const word = inp ? inp.value.trim() : '';
    locked[cat] = word; // αισιόδοξο κλείδωμα στο UI
    markLocked(cat);
    if (moveFocus) focusNext();
    sfx.lock(); vibrate(30);
    socket.emit('answer:submit', { category: cat, word }, (res) => {
      if (res && !res.ok && res.error !== 'Έχει ήδη κλειδώσει.') toast(res.error, 'error');
    });
  }

  function markLocked(cat) {
    const row = $('answersForm').querySelector(`.answer[data-cat="${cat}"]`);
    if (!row) return;
    row.classList.add('locked');
    row.querySelector('input').disabled = true;
    row.querySelector('button').disabled = true;
  }

  function renderOthers() {
    const total = state.categories.length;
    $('othersProgress').innerHTML = state.players.filter((p) => p.id !== me.playerId).map((p) =>
      `<span class="other" style="opacity:${p.connected ? 1 : 0.4}"><span class="avatar sm" style="--pc:${esc(p.color)}">${esc(p.avatar)}</span>${p.progress.length}/${total}</span>`
    ).join('');
  }

  function renderGame() {
    const r = state.round;
    $('roundInfo').textContent = `Γύρος ${r.number}/${r.total}`;
    if (builtRound !== r.number) {
      // Νέος γύρος (ή επανασύνδεση): χτίζουμε τα πεδία
      builtRound = r.number;
      autoSubmitted = false;
      const L = $('letterBig');
      L.textContent = r.letter; L.classList.remove('reveal'); void L.offsetWidth; L.classList.add('reveal');
      buildAnswers();
      sfx.letter(); vibrate([40, 40, 120]);
      setTimeout(() => { const f = $('answersForm').querySelector('input:not([disabled])'); if (f) f.focus({ preventScroll: true }); }, 400);
    }
    renderOthers();
    const fb = $('finishBanner');
    fb.classList.toggle('hidden', !r.finishDeadline);
  }

  // Ρολόι (requestAnimationFrame): μόνο εμφάνιση — ο server κρατά τον πραγματικό χρόνο
  function loop() {
    requestAnimationFrame(loop);
    if (!state || !state.round) return;
    const r = state.round;

    if (state.phase === 'countdown') {
      const left = Math.ceil((r.countdownEndsAt - serverNow()) / 1000);
      const n = Math.max(1, Math.min(3, left));
      const el = $('countdownNum');
      if (el.textContent !== String(n)) {
        el.textContent = n; el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
        tone(440 + (3 - n) * 120, 0.12, 'triangle'); vibrate(40);
      }
      return;
    }
    if (state.phase !== 'playing' || !r.endsAt) return;

    const end = Math.min(r.endsAt, r.finishDeadline || Infinity);
    const msLeft = Math.max(0, end - serverNow());
    const sec = Math.ceil(msLeft / 1000);
    const frac = Math.max(0, (r.endsAt - serverNow()) / r.durationMs);
    const fill = $('timerFill');
    fill.style.width = `${Math.min(frac, msLeft / r.durationMs) * 100}%`;
    fill.classList.toggle('warn', sec <= 20 && sec > 10);
    fill.classList.toggle('danger', sec <= 10);
    const ts = $('timerSec');
    ts.textContent = `${sec}″`;
    ts.classList.toggle('danger', sec <= 10);
    if (r.finishDeadline) $('finishBanner').textContent = `⏱️ Κάποιος τελείωσε — ${sec}″ ακόμα!`;

    if (sec <= 5 && sec > 0 && sec !== lastTick) { lastTick = sec; sfx.tick(); }

    // Στο 0: στέλνουμε ό,τι έχει γραφτεί αλλά δεν κλείδωσε (ο server το δέχεται στο grace)
    if (msLeft <= 0 && !autoSubmitted) {
      autoSubmitted = true;
      $('answersForm').querySelectorAll('input:not([disabled])').forEach((inp) => {
        if (inp.value.trim()) lockCategory(inp.dataset.cat, false);
      });
    }
  }
  requestAnimationFrame(loop);

  // Όταν ανοίγει/κλείνει το πληκτρολόγιο (iOS), κρατάμε ορατό το ενεργό πεδίο
  if (window.visualViewport) {
    visualViewport.addEventListener('resize', () => {
      const a = document.activeElement;
      if (a && a.tagName === 'INPUT' && a.closest('.answer')) a.closest('.answer').scrollIntoView({ block: 'center' });
    });
  }

  // ---------- Αποτελέσματα ----------
  function renderResults() {
    const res = state.results;
    if (!res) return;
    const isHost = state.hostId === me.playerId;
    const byId = Object.fromEntries(state.players.map((p) => [p.id, p]));
    const othersCount = state.players.length - 1;
    const needed = Math.floor(othersCount / 2) + 1;

    $('resultsLetter').textContent = res.letter;
    $('resultsTitle').textContent = `Γύρος ${state.round.number}/${state.round.total}`;

    $('resultsCats').innerHTML = state.categories.map((c) => {
      const rows = res.rows.map((row) => {
        const p = byId[row.playerId]; const a = row.cats[c.id];
        if (!p || !a) return '';
        const empty = a.status === 'empty';
        const mark = empty ? '➖' : a.valid ? (a.status === 'uncertain' && !a.flipped ? '❔' : '✅') : '❌';
        const why = empty ? 'κενό' : a.flipped ? '⚖️ αντιστράφηκε με ψηφοφορία' : esc(a.reason);
        const bonus = a.valid ? `<small>${a.base}+${a.speed}${a.first ? '+' + a.first + '🥇' : ''}</small>` : '';
        const canVote = !empty && row.playerId !== me.playerId;
        const voted = a.votes.includes(me.playerId);
        const vote = canVote
          ? `<button class="challenge ${voted ? 'on' : ''}" data-target="${row.playerId}" data-cat="${c.id}">⚖️ ${a.votes.length}/${needed}</button>`
          : (a.votes.length ? `<span class="badge">⚖️ ${a.votes.length}/${needed}</span>` : '');
        return `<div class="res-row">
          <span class="avatar sm" style="--pc:${esc(p.color)}">${esc(p.avatar)}</span>
          <span class="res-word ${a.valid ? '' : 'bad'}"><b>${empty ? '—' : esc(a.word)}</b><span class="why">${esc(p.nick)} · ${why}</span></span>
          ${vote}
          <span class="mark">${mark}</span>
          <span class="pts">${a.points}${bonus}</span>
        </div>`;
      }).join('');
      return `<div class="card cat-card"><h3>${esc(c.label)}</h3>${rows}</div>`;
    }).join('');

    $('resultsCats').querySelectorAll('.challenge').forEach((b) => {
      b.onclick = () => socket.emit('challenge:vote', { targetId: b.dataset.target, category: b.dataset.cat });
    });

    const gains = Object.fromEntries(res.rows.map((r) => [r.playerId, r.total]));
    $('standings').innerHTML = [...state.players].sort((a, b) => b.score - a.score).map((p) =>
      playerRow(p, `<span class="gain">+${gains[p.id] || 0}</span>&nbsp;<span class="score">${p.score}</span>`)
    ).join('');

    const last = state.round.number >= state.round.total;
    $('nextBtn').classList.toggle('hidden', !isHost);
    $('nextBtn').textContent = last ? 'Τελική κατάταξη 🏆' : 'Επόμενος γύρος ▶';
    $('waitHost').classList.toggle('hidden', isHost);
  }
  $('nextBtn').onclick = () => socket.emit('round:next', {});

  // ---------- Τελικό ----------
  function renderFinal() {
    const sorted = [...state.players].sort((a, b) => b.score - a.score);
    const top = sorted[0];
    const tie = sorted.filter((p) => p.score === top.score);
    $('winnerText').textContent = tie.length > 1 ? `Ισοπαλία: ${tie.map((p) => p.nick).join(' & ')}!` : `Νικητής: ${top.nick}!`;
    const order = [sorted[1], sorted[0], sorted[2]];
    $('podium').innerHTML = order.map((p, i) => {
      if (!p) return '<div class="step"></div>';
      const place = [2, 1, 3][i];
      return `<div class="step p${place}"><div class="avatar" style="--pc:${esc(p.color)};margin:0 auto">${esc(p.avatar)}</div>
        <div class="who">${esc(p.nick)}<br><span class="muted">${p.score}</span></div><div class="block">${place}</div></div>`;
    }).join('');
    $('finalStandings').innerHTML = sorted.map((p) => playerRow(p, `<span class="score">${p.score}</span>`)).join('');
    $('againBtn').classList.toggle('hidden', state.hostId !== me.playerId);
  }
  $('againBtn').onclick = () => socket.emit('game:restart', {});
  $('newRoomBtn').onclick = leaveRoom;

  // ---------- Κεντρικό render ----------
  function render() {
    if (!state || !me.code) return;
    const phase = state.phase;
    $('countdownOverlay').classList.toggle('hidden', phase !== 'countdown');

    if (phase !== lastPhase) {
      if (phase === 'countdown') { locked = {}; builtRound = null; lastTick = null; }
      if (phase === 'validating') { sfx.end(); vibrate(150); document.activeElement && document.activeElement.blur(); }
      if (phase === 'final') { sfx.win(); confetti(); }
    }

    switch (phase) {
      case 'lobby': show('lobby'); renderLobby(); break;
      case 'countdown': show('game'); $('letterBig').textContent = '?'; break;
      case 'playing': show('game'); renderGame(); break;
      case 'validating': show('validating'); break;
      case 'results': show('results'); renderResults(); break;
      case 'final': show('final'); renderFinal(); break;
    }
    lastPhase = phase;
  }

  // ---------- Εκκίνηση ----------
  async function init() {
    applyTheme(); applyMute();
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
    try { cfg = await (await fetch('/api/config')).json(); } catch { toast('Δεν φορτώθηκαν οι ρυθμίσεις', 'error'); return; }
    buildHome();

    const m = location.pathname.match(/^\/room\/([A-Za-z0-9]{4})$/);
    if (m) {
      const code = m[1].toUpperCase();
      const token = store.get(tokenKey(code));
      if (token) {
        // Είχα ήδη μπει: επανασύνδεση χωρίς φόρμα
        me.code = code;
        if (socket.connected) joinRoom(code, token, true);
        return;
      }
      // Πρόσκληση: φόρμα με έτοιμο κωδικό
      $('codeInput').value = code;
      $('inviteText').textContent = `Σε προσκάλεσαν στο δωμάτιο ${code}! Διάλεξε ψευδώνυμο και μπες.`;
      switchTab('join');
    }
    show('home');
  }
  init();

  // PWA service worker
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }
})();
