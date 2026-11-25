import { World } from './world.js';
import { Physics, draftFactor } from './physics.js';
import { Trainer, HeartRate, bluetoothAvailable } from './trainer.js';
import { Voice } from './voice.js';
import { Profile, MiniMap } from './hud.js';
import { cdaFor, saveProfile, appearanceEditor } from './profile.js';
import { RiderPreview } from './preview.js';
import { KITS } from './kits.js';
import { Recorder, summarize, download, saveRide, saveDraft, clearDraft } from './recorder.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
};
const colorOf = (a) => (a.kit && KITS[a.kit] ? KITS[a.kit].color : a.jersey);

/**
 * Join a room and start riding.
 * opts: { code, routeId, profile, start: { mode: 'start'|'rider'|'event', riderId } }
 */
export async function startRide({ code, routeId, profile, start, onError }) {
  const socket = io();
  const joinMsg = (extra = {}) => ({
    room: code, routeId,
    profile: { name: profile.name, weight: profile.weight, height: profile.height, appearance: profile.appearance },
    ...extra,
  });
  const res = await new Promise((resolve) => socket.emit('room:join', joinMsg(), resolve));
  if (res.error) { socket.close(); onError && onError(res.error); return; }

  const room = res.room;
  history.replaceState(null, '', '/?room=' + encodeURIComponent(room.code));
  const [route, config] = await Promise.all([
    fetch('/api/routes/' + encodeURIComponent(room.routeId)).then((r) => r.json()),
    fetch('/api/config').then((r) => r.json()),
  ]);
  routeId = route.id;

  $('lobby').classList.add('hidden');
  $('ride').classList.remove('hidden');
  $('roomCode').textContent = room.code;
  $('sDistTotal').textContent = '/ ' + (route.total / 1000).toFixed(1) + ' km';

  const world = new World($('view'), route, { lidar: config.lidar });
  const track = world.track;
  const profileHud = new Profile($('profile'), route);
  const minimap = new MiniMap($('minimap'), route);
  const physics = new Physics({ riderKg: profile.weight, cda: cdaFor(profile.height, profile.weight) });
  const trainer = new Trainer();
  const hrm = new HeartRate();
  const voice = new Voice(socket, config.iceServers);
  const recorder = new Recorder(route, profile);

  let myId = res.you.id;
  const state = {
    dist: 0, lap: 0, power: 0, cadence: 0, hr: 0, elapsed: 0,
    finished: false, finishTime: 0, hostId: room.hostId, event: room.event,
    manual: 0, difficulty: 0.5, draft: 0, paused: false, saved: false,
  };
  let others = new Map();
  let clockOffset = room.now - Date.now();
  window.gpxRide = { voice, trainer, physics, recorder, world, get state() { return state; } };

  // ---------- Positioning ----------
  function setAbs(abs, speed = null) {
    if (route.loop) {
      abs = Math.max(0, abs);
      state.lap = Math.floor(abs / route.total);
      state.dist = abs - state.lap * route.total;
    } else {
      state.lap = 0;
      state.dist = Math.max(0, Math.min(route.total - 1, abs));
    }
    state.finished = false;
    if (speed !== null) physics.v = speed;
    recorder.newSegment();
    world.resetCamera();
  }
  const myAbs = () => state.lap * route.total + state.dist;
  function absOf(r) { return r.lap * route.total + r.dist + r.speed * Math.min(r.age || 0, 2000) / 1000; }

  function teleportToRider(id) {
    const o = others.get(id) || room.riders.find((r) => r.id === id);
    if (!o) return;
    const abs = o.disp !== undefined ? o.disp : absOf(o);
    leaveEventIfWaiting();
    setAbs(abs - 4, o.speed || 0);
    addChat({ system: true, text: `Teleport do: ${o.name}` });
  }
  function teleportToStart() {
    leaveEventIfWaiting();
    setAbs(0, 0);
  }

  // ---------- Group ride event ----------
  let joinedEventAt = null;
  const isParticipant = () => !!(state.event && state.event.participants.includes(myId));
  const eventLeft = () => (state.event ? (state.event.startAt - clockOffset - Date.now()) / 1000 : -Infinity);
  const waitingForEvent = () => isParticipant() && eventLeft() > 0;
  async function joinEvent() {
    const r = await new Promise((resolve) => socket.emit('event:join', {}, resolve));
    if (r.error) return addChat({ system: true, text: r.error });
    if (state.event && !state.event.participants.includes(myId)) state.event.participants.push(myId);
    joinedEventAt = r.startAt;
    setAbs(0, 0);
    state.elapsed = 0;
    addChat({ system: true, event: true, text: 'Jesteś zapisany na jazdę grupową. Czekasz na starcie – możesz się rozgrzewać, a ruszysz razem z grupą.' });
  }
  function leaveEventIfWaiting() {
    if (!waitingForEvent()) return;
    socket.emit('event:leave');
    state.event.participants = state.event.participants.filter((x) => x !== myId);
  }

  // Initial position
  if (start && start.mode === 'rider') {
    const t = room.riders.find((r) => r.id === start.riderId);
    if (t) { setAbs(absOf(t) - 4, t.speed); addChat({ system: true, text: `Dołączasz do: ${t.name}` }); }
  } else if (start && start.mode === 'event') {
    await joinEvent();
  }

  // ---------- Server events ----------
  socket.on('room:state', (msg) => {
    clockOffset = msg.now - Date.now();
    state.hostId = msg.hostId;
    state.event = msg.event;
    if (isParticipant() && eventLeft() > 0 && joinedEventAt !== state.event.startAt) {
      joinedEventAt = state.event.startAt;
      setAbs(0, 0);
      state.elapsed = 0;
    }
    const now = performance.now();
    const next = new Map();
    for (const r of msg.riders) {
      if (r.id === myId) continue;
      const prev = others.get(r.id);
      const abs = r.lap * route.total + r.dist;
      const o = { ...r, abs, recvAt: now - Math.min(r.age, 2000), disp: prev ? prev.disp : abs };
      if (Math.abs(o.disp - abs) > 200) o.disp = abs; // teleport
      next.set(r.id, o);
    }
    others = next;
  });
  socket.on('chat', (m) => addChat(m));
  let firstConnect = true;
  socket.on('connect', async () => {
    if (firstConnect) { firstConnect = false; return; }
    // Reconnected (network blip / server restart): rejoin at the current position.
    const wasVoice = voice.active;
    if (wasVoice) voice.leave();
    const r = await new Promise((resolve) => socket.emit('room:join', joinMsg({ dist: state.dist, lap: state.lap, rejoin: true }), resolve));
    if (r.ok) {
      myId = r.you.id;
      addChat({ system: true, text: 'Połączono ponownie ✔' });
      if (wasVoice) voice.join().catch(() => {});
    }
  });
  socket.on('disconnect', () => addChat({ system: true, text: 'Utracono połączenie z serwerem – ponowne łączenie…' }));

  // ---------- UI ----------
  let pointerDown = false;
  $('ride').addEventListener('pointerdown', () => (pointerDown = true));
  window.addEventListener('pointerup', () => setTimeout(() => (pointerDown = false), 0));

  $('toStartBtn').onclick = () => { if (confirm('Przenieść Cię na start trasy?')) teleportToStart(); };
  $('riders').onclick = (e) => {
    const b = e.target.closest('[data-tp]');
    if (b) teleportToRider(b.dataset.tp);
  };
  $('inviteBtn').onclick = async () => {
    const link = location.origin + '/?room=' + encodeURIComponent(room.code);
    try { await navigator.clipboard.writeText(link); $('inviteBtn').textContent = '✅ Skopiowano'; }
    catch { prompt('Skopiuj link i wyślij znajomym:', link); }
    setTimeout(() => ($('inviteBtn').textContent = '🔗 Zaproś'), 2000);
  };
  $('evCreate').onclick = () => socket.emit('event:create', { minutes: Number($('evMinutes').value) });
  $('evCancel').onclick = () => { if (confirm('Odwołać jazdę grupową?')) socket.emit('event:cancel'); };
  $('eventBar').onclick = (e) => {
    const a = e.target.closest('button')?.dataset.a;
    if (a === 'join') joinEvent();
    if (a === 'leave') leaveEventIfWaiting();
  };

  $('difficulty').oninput = (e) => { state.difficulty = e.target.value / 100; $('diffVal').textContent = e.target.value + '%'; };
  $('manual').oninput = (e) => { state.manual = +e.target.value; $('manVal').textContent = e.target.value + ' W'; };
  const modalOpen = () => !$('wardrobe').classList.contains('hidden') || !$('endModal').classList.contains('hidden');
  window.addEventListener('keydown', (e) => {
    if (document.activeElement === $('chatIn') || modalOpen() || e.target.tagName === 'INPUT') return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      state.manual = Math.max(0, Math.min(600, state.manual + (e.key === 'ArrowUp' ? 10 : -10)));
      $('manual').value = state.manual; $('manVal').textContent = state.manual + ' W';
      e.preventDefault();
    } else if (e.key === 'm' || e.key === 'M') {
      if (voice.active) voice.setMuted(!voice.muted);
    } else if (e.key === 'Enter') {
      $('chatIn').focus(); e.preventDefault();
    }
  });
  $('chatIn').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const t = e.target.value.trim();
      if (t) socket.emit('chat', t);
      e.target.value = ''; e.target.blur();
    } else if (e.key === 'Escape') e.target.blur();
  });
  function addChat(m) {
    const div = document.createElement('div');
    if (m.system) { div.className = m.event ? 'sys ev' : 'sys'; div.textContent = m.text; }
    else div.innerHTML = `<b style="color:${esc(m.color)}">${esc(m.from)}:</b> ${esc(m.text)}`;
    $('chatLog').appendChild(div);
    $('chatLog').scrollTop = 1e9;
  }

  // Trainer & HR
  const trainerStatus = (t) => ($('trainerStatus').textContent = t);
  $('trainerBtn').onclick = async () => {
    if (!bluetoothAvailable()) return alert('Bluetooth niedostępny w tej przeglądarce. Użyj Chrome lub Edge.');
    if (trainer.connected) { trainer.disconnect(); return; }
    try { trainerStatus('Łączenie…'); await trainer.connect(); }
    catch (e) { trainerStatus('Nie połączono: ' + (e.message || e)); }
  };
  trainer.addEventListener('connected', () => {
    $('trainerBtn').classList.add('on');
    $('trainerBtn').textContent = '🔌 ' + trainer.name;
    trainerStatus(trainer.canControl
      ? `${trainer.name}: tryb symulacji – opór zmienia się z nachyleniem.`
      : `${trainer.name}: odczyt mocy (bez sterowania oporem).`);
    $('manualWrap').classList.add('hidden');
  });
  trainer.addEventListener('disconnected', () => {
    $('trainerBtn').classList.remove('on');
    $('trainerBtn').textContent = '🔌 Trener';
    trainerStatus('Trener rozłączony.');
    $('manualWrap').classList.remove('hidden');
  });
  $('hrBtn').onclick = async () => {
    if (!bluetoothAvailable()) return alert('Bluetooth niedostępny w tej przeglądarce. Użyj Chrome lub Edge.');
    try { await hrm.connect(); } catch (e) { console.warn(e); }
  };
  hrm.addEventListener('connected', () => $('hrBtn').classList.add('on'));
  hrm.addEventListener('disconnected', () => { $('hrBtn').classList.remove('on'); state.hr = 0; });

  // Voice
  $('voiceBtn').onclick = async () => {
    if (voice.active) { voice.leave(); return; }
    try { await voice.join(); } catch (e) { alert('Brak dostępu do mikrofonu: ' + (e.message || e)); }
  };
  $('muteBtn').onclick = () => voice.setMuted(!voice.muted);
  voice.addEventListener('change', () => {
    $('voiceBtn').classList.toggle('on', voice.active);
    $('voiceBtn').textContent = voice.active ? '📞 Rozłącz' : '🎙️ Rozmowa';
    $('muteBtn').classList.toggle('hidden', !voice.active);
    $('muteBtn').textContent = voice.muted ? '🎙️ Mikrofon' : '🔇 Wycisz';
  });
  voice.addEventListener('failed', () =>
    addChat({ system: true, text: 'Nie udało się zestawić połączenia głosowego z jedną z osób (sieć blokuje P2P). Admin może dodać serwer TURN – patrz README.' }));

  // Wardrobe (change look during the ride)
  let wPreview = null, wEditor = null;
  $('wardrobeBtn').onclick = () => {
    $('wardrobe').classList.remove('hidden');
    if (!wPreview) wPreview = new RiderPreview($('wPreview'));
    wPreview.set(profile.appearance, profile.height);
    wEditor = appearanceEditor($('wLook'), profile.appearance, (a) => wPreview.set(a, profile.height));
  };
  $('wCancel').onclick = () => $('wardrobe').classList.add('hidden');
  $('wSave').onclick = () => {
    profile.appearance = wEditor.get();
    saveProfile(profile);
    socket.emit('rider:profile', { appearance: profile.appearance });
    $('wardrobe').classList.add('hidden');
  };

  // End of ride
  function openEnd() {
    state.paused = true;
    physics.v = 0;
    const ride = recorder.toJSON();
    const s = ride.samples.length ? summarize(ride) : null;
    $('summary').innerHTML = s ? [
      [(s.distance / 1000).toFixed(2) + ' km', 'dystans'], [fmtTime(s.moving), 'czas jazdy'], [(s.avgSpeed * 3.6).toFixed(1) + ' km/h', 'śr. prędkość'],
      [Math.round(s.avgPower) + ' W', 'śr. moc'], [s.wkg.toFixed(2) + ' W/kg', 'śr. W/kg'], [s.maxPower + ' W', 'maks. moc'],
      ['↑ ' + Math.round(s.ascent) + ' m', 'przewyższenie'], [s.avgHr ? Math.round(s.avgHr) + ' bpm' : '–', 'śr. tętno'], [Math.round(s.kj) + ' kJ', 'praca'],
    ].map(([v, l]) => `<div><b>${v}</b><small>${l}</small></div>`).join('') : '<p class="muted">Za krótka jazda – nic nie zostało nagrane.</p>';
    for (const id of ['eSave', 'eGpx', 'eTcx']) $(id).disabled = !s;
    $('eMsg').textContent = state.saved ? 'Zapisano w historii ✔' : '';
    $('endModal').classList.remove('hidden');
  }
  $('endBtn').onclick = openEnd;
  $('eResume').onclick = () => { state.paused = false; $('endModal').classList.add('hidden'); };
  $('eSave').onclick = () => {
    if (saveRide(recorder.toJSON())) { state.saved = true; clearDraft(); $('eMsg').textContent = 'Zapisano w historii ✔ (znajdziesz go w menu w „Moje przejazdy”)'; }
    else $('eMsg').textContent = 'Brak miejsca w przeglądarce – pobierz plik GPX/TCX.';
  };
  $('eGpx').onclick = () => download(recorder.toJSON(), 'gpx');
  $('eTcx').onclick = () => download(recorder.toJSON(), 'tcx');
  $('eExit').onclick = () => {
    if (!state.saved && recorder.samples.length > 30 && !confirm('Przejazd nie jest zapisany. Wyjść bez zapisywania?')) return;
    if (!state.saved) clearDraft();
    socket.emit('room:leave');
    socket.close();
    location.href = '/';
  };

  // ---------- Timers ----------
  let lastSentGrade = null, lastSentAt = 0;
  setInterval(() => {
    if (!trainer.canControl) return;
    const g = waitingForEvent() || state.finished || state.paused ? 0 : track.gradeAt(state.dist) * state.difficulty;
    const now = Date.now();
    if (lastSentGrade === null || Math.abs(g - lastSentGrade) > 0.0015 || now - lastSentAt > 5000) {
      trainer.setSimulation(g);
      lastSentGrade = g; lastSentAt = now;
    }
  }, 1000);

  setInterval(() => {
    socket.emit('rider:update', {
      dist: state.dist, lap: state.lap, speed: physics.v, power: state.power,
      cadence: state.cadence, hr: state.hr, finished: state.finished,
    });
  }, 250);

  // Record 1 sample per second while riding
  setInterval(() => {
    if (state.paused || waitingForEvent() || state.finished) return;
    if (physics.v < 0.1 && recorder.samples.length === 0) return;
    const s = track.sample(state.dist);
    recorder.add({ x: s.x, y: -s.z, ele: s.ele, power: state.power, hr: state.hr, cadence: state.cadence, speed: physics.v });
  }, 1000);
  setInterval(() => { if (!state.saved && recorder.samples.length > 30) saveDraft(recorder.toJSON()); }, 30000);
  window.addEventListener('beforeunload', (e) => {
    if (!state.saved && recorder.samples.length > 30) { saveDraft(recorder.toJSON()); e.preventDefault(); }
  });

  // ---------- Simulation (runs even when the tab is in the background) ----------
  let simLast = performance.now();
  let wasWaiting = false;
  function simulate() {
    const now = performance.now();
    let total = Math.min(30, (now - simLast) / 1000); // background tabs tick ~1/s
    simLast = now;

    const trainerLive = trainer.connected && now - trainer.lastData < 3000;
    state.power = trainerLive ? trainer.power : trainer.connected ? 0 : state.manual;
    state.cadence = trainerLive ? trainer.cadence : 0;
    state.hr = hrm.connected ? hrm.hr : 0;

    const waiting = waitingForEvent();
    if (wasWaiting && !waiting && isParticipant()) state.elapsed = 0;
    wasWaiting = waiting;

    while (total > 0) {
      const dt = Math.min(0.05, total);
      total -= dt;
      for (const o of others.values()) {
        const target = o.abs + (o.finished ? 0 : o.speed * (now - o.recvAt) / 1000);
        o.disp += (target - o.disp) * (1 - Math.exp(-dt * 3));
      }
      const me = myAbs();
      let gapAhead = Infinity;
      for (const o of others.values()) {
        const gap = o.disp - me;
        if (gap > 0 && gap < gapAhead) gapAhead = gap;
      }
      state.draft = draftFactor(gapAhead);
      if (!waiting && !state.finished && !state.paused) {
        const moved = physics.step(state.power, track.gradeAt(state.dist), dt, state.draft);
        state.dist += moved;
        recorder.addDistance(moved);
        if (state.dist >= route.total) {
          if (route.loop) { state.dist -= route.total; state.lap++; }
          else { state.dist = route.total; state.finished = true; state.finishTime = state.elapsed; physics.v = 0; }
        }
        if (physics.v > 0.1 || state.elapsed > 0) state.elapsed += dt;
      } else if (waiting || state.paused) physics.v = 0;
    }
  }
  setInterval(simulate, 100);

  // ---------- Render loop ----------
  let last = performance.now();
  let uiTimer = 0;
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    simulate();
    const me = myAbs();
    const waiting = waitingForEvent();

    const riders = [{ id: 'me', name: profile.name, appearance: profile.appearance, height: profile.height, color: colorOf(profile.appearance),
      dist: state.dist, speed: physics.v, cadence: state.cadence || (waiting && state.power > 0 ? 80 : 0), me: true }];
    for (const o of others.values()) {
      riders.push({ id: o.id, name: o.name, appearance: o.appearance, height: o.height, color: o.color,
        dist: ((o.disp % route.total) + route.total) % route.total, speed: o.speed, cadence: o.cadence });
    }
    world.render(dt, riders);

    uiTimer += dt;
    if (uiTimer > 0.2) {
      uiTimer = 0;
      $('sPower').textContent = Math.round(state.power);
      $('sSpeed').textContent = (physics.v * 3.6).toFixed(1);
      $('sCad').textContent = state.cadence ? Math.round(state.cadence) : '–';
      $('sHr').textContent = state.hr || '–';
      $('sDist').textContent = (me / 1000).toFixed(2);
      $('sGrade').textContent = (track.gradeAt(state.dist) * 100).toFixed(1);
      $('sTime').textContent = fmtTime(state.elapsed);
      $('sWkg').textContent = (state.power / profile.weight).toFixed(1);
      $('draft').classList.toggle('hidden', state.draft < 0.05);
      updateEventUi();
      if (!pointerDown) renderRiderList(me);
      profileHud.draw(riders);
      minimap.draw(riders);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  function updateEventUi() {
    const amHost = state.hostId === myId;
    $('hostBox').classList.toggle('hidden', !amHost);
    const ev = state.event, left = eventLeft();
    $('evCancel').classList.toggle('hidden', !(amHost && ev && left > 0));
    $('evCreate').disabled = !!(ev && left > 0);

    const bar = $('eventBar');
    let barHtml = '';
    if (ev && left > 0) {
      barHtml = isParticipant()
        ? `<span>⏳ Czekasz na starcie · jazda grupowa za <span class="timer"></span> · ${ev.participants.length} os.</span><button data-a="leave">Wypisz się</button>`
        : `<span>📅 Jazda grupowa za <span class="timer"></span> · ${ev.participants.length} os.</span><button data-a="join">Dołącz do eventu</button>`;
    }
    if (bar.dataset.html !== barHtml && !pointerDown) { bar.innerHTML = barHtml; bar.dataset.html = barHtml; }
    const tm = bar.querySelector('.timer');
    if (tm) tm.textContent = fmtTime(left);
    bar.classList.toggle('hidden', !barHtml);

    const banner = $('banner');
    if (isParticipant() && left > 0 && left <= 10) { banner.innerHTML = Math.ceil(left) + '<small>Start jazdy grupowej</small>'; banner.classList.remove('hidden'); }
    else if (isParticipant() && left <= 0 && left > -2) { banner.innerHTML = 'START!'; banner.classList.remove('hidden'); }
    else if (state.finished) { banner.innerHTML = '🏁 Meta!<small>Czas: ' + fmtTime(state.finishTime) + ' · kliknij „Zakończ”, aby zapisać</small>'; banner.classList.remove('hidden'); }
    else banner.classList.add('hidden');
  }

  function renderRiderList(me) {
    const list = [{ id: myId, name: profile.name, color: colorOf(profile.appearance), avatar: profile.appearance.avatar, abs: me, power: state.power, me: true,
      voice: voice.active, muted: voice.muted, speaking: voice.active && !voice.muted && voice.isSpeaking('me') }];
    for (const o of others.values()) {
      list.push({ id: o.id, name: o.name, color: o.color, avatar: o.appearance.avatar, abs: o.disp, power: o.power, weight: o.weight,
        voice: o.voice, muted: o.muted, speaking: voice.isSpeaking(o.id), finished: o.finished });
    }
    list.sort((a, b) => b.abs - a.abs);
    const html = list.map((r) => {
      const gapM = r.abs - me;
      const gap = r.me ? '' : Math.abs(gapM) >= 1000 ? (gapM > 0 ? '+' : '−') + (Math.abs(gapM) / 1000).toFixed(1) + ' km' : (gapM >= 0 ? '+' : '−') + Math.abs(Math.round(gapM)) + ' m';
      const wkg = (r.power / (r.me ? profile.weight : r.weight || 75)).toFixed(1);
      const v = r.voice ? (r.muted ? '🔇' : r.speaking ? '<span class="spk">🔊</span>' : '🎧') : '';
      return `<li class="${r.me ? 'me' : ''}"><span class="dot" style="background:${esc(r.color)}"></span>` +
        `<span class="nm">${esc(r.avatar)} ${esc(r.name)} ${v}${r.finished ? ' 🏁' : ''}</span>` +
        `<span class="gap">${gap}</span><span class="w">${wkg} W/kg</span>` +
        (r.me ? '<span></span>' : `<button class="tp" data-tp="${esc(r.id)}" title="Dołącz do ${esc(r.name)}">↪</button>`) + '</li>';
    }).join('');
    if (html !== $('riders').dataset.html) { $('riders').innerHTML = html; $('riders').dataset.html = html; }
  }

  addChat({ system: true, text: `Jesteś w przejeździe „${room.code}”. Trasa: ${route.name}. Kliknij ↪ przy kolarzu, aby do niego dołączyć.` });
}
