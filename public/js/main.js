import { World } from './world.js';
import { Physics, draftFactor } from './physics.js';
import { Trainer, HeartRate, bluetoothAvailable } from './trainer.js';
import { Voice } from './voice.js';
import { Profile, MiniMap } from './hud.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
};

// ---------------- Lobby ----------------
const params = new URLSearchParams(location.search);
const invitedRoom = params.get('room');
$('name').value = store.get('name', '');
$('weight').value = store.get('weight', '75');
$('room').value = invitedRoom || store.get('room', '') || 'klub-' + Math.random().toString(36).slice(2, 6);
if (!bluetoothAvailable()) $('btWarn').classList.remove('hidden');
if (invitedRoom) {
  $('routeWrap').classList.add('hidden');
  $('routeInfo').textContent = 'Zaproszenie do przejazdu „' + invitedRoom + '” – trasa zostanie wczytana z grupy.';
}

let routes = [];
fetch('/api/routes').then((r) => r.json()).then((list) => {
  routes = list;
  $('route').innerHTML = list.map((r) => `<option value="${esc(r.id)}">${esc(r.name)} – ${(r.total / 1000).toFixed(1)} km, ↑${r.ascent} m${r.loop ? ' (pętla)' : ''}</option>`).join('');
  const saved = store.get('routeId', '');
  if (list.some((r) => r.id === saved)) $('route').value = saved;
});

$('joinBtn').onclick = join;
$('name').addEventListener('keydown', (e) => e.key === 'Enter' && join());

async function join() {
  const name = $('name').value.trim();
  const weight = Number($('weight').value) || 75;
  const room = $('room').value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
  if (!name) return ($('lobbyErr').textContent = 'Podaj imię');
  if (!room) return ($('lobbyErr').textContent = 'Podaj kod przejazdu');
  store.set('name', name); store.set('weight', weight); store.set('room', room); store.set('routeId', $('route').value);
  $('joinBtn').disabled = true;
  $('lobbyErr').textContent = '';

  const socket = io();
  const res = await new Promise((resolve) =>
    socket.emit('room:join', { room, name, weight, routeId: $('route').value }, resolve));
  if (res.error) {
    $('lobbyErr').textContent = res.error;
    $('joinBtn').disabled = false;
    socket.close();
    return;
  }
  history.replaceState(null, '', '/?room=' + encodeURIComponent(room));
  const [route, config] = await Promise.all([
    fetch('/api/routes/' + encodeURIComponent(res.room.routeId)).then((r) => r.json()),
    fetch('/api/config').then((r) => r.json()),
  ]);
  startRide({ socket, me: res.you, room: res.room, route, config, weight });
}

// ---------------- Ride ----------------
function startRide({ socket, me, room, route, config, weight }) {
  $('lobby').classList.add('hidden');
  $('ride').classList.remove('hidden');
  $('roomCode').textContent = room.code;
  $('sDistTotal').textContent = '/ ' + (route.total / 1000).toFixed(1) + ' km';

  const world = new World($('view'), route);
  const track = world.track;
  const profile = new Profile($('profile'), route);
  const minimap = new MiniMap($('minimap'), route);
  const physics = new Physics({ riderKg: weight });
  const trainer = new Trainer();
  const hrm = new HeartRate();
  const voice = new Voice(socket, config.iceServers);
  window.gpxRide = { voice, trainer, physics, get state() { return state; } }; // handy for debugging in the console

  const state = {
    dist: 0, lap: 0, power: 0, cadence: 0, hr: 0, elapsed: 0,
    frozenUntil: 0, finished: false, finishTime: 0, hostId: room.hostId,
    manual: 0, difficulty: 0.5, draft: 0,
  };
  let others = new Map(); // id -> { ...server data, disp, recvAt }
  let clockOffset = 0;

  // ---- Server events ----
  socket.on('room:state', (msg) => {
    clockOffset = msg.now - Date.now();
    const now = performance.now();
    const next = new Map();
    for (const r of msg.riders) {
      if (r.id === me.id) { me = { ...me, ...r, dist: state.dist }; continue; }
      const prev = others.get(r.id);
      const abs = r.lap * route.total + r.dist;
      const o = { ...r, abs, recvAt: now - Math.min(r.age, 2000), disp: prev ? prev.disp : abs };
      if (Math.abs(o.disp - abs) > 200) o.disp = abs; // teleport after reset
      next.set(r.id, o);
    }
    others = next;
  });
  socket.on('room:host', ({ hostId }) => { state.hostId = hostId; updateHostUi(); });
  socket.on('room:start', ({ startAt, serverNow }) => {
    const offset = serverNow - Date.now();
    state.frozenUntil = startAt - offset;
    state.dist = 0; state.lap = 0; state.elapsed = 0; state.finished = false;
    physics.v = 0;
    for (const o of others.values()) o.disp = 0;
  });
  socket.on('chat', (m) => addChat(m));
  socket.on('disconnect', () => addChat({ system: true, text: 'Utracono połączenie z serwerem – ponowne łączenie…' }));

  // ---- UI ----
  function updateHostUi() { $('startBtn').classList.toggle('hidden', state.hostId !== me.id); }
  updateHostUi();
  $('startBtn').onclick = () => socket.emit('room:start', { countdown: 10 });
  $('inviteBtn').onclick = async () => {
    const link = location.origin + '/?room=' + encodeURIComponent(room.code);
    try { await navigator.clipboard.writeText(link); $('inviteBtn').textContent = '✅ Skopiowano!'; }
    catch { prompt('Skopiuj link i wyślij znajomym:', link); }
    setTimeout(() => ($('inviteBtn').textContent = '🔗 Kopiuj link zaproszenia'), 2000);
  };

  $('difficulty').oninput = (e) => { state.difficulty = e.target.value / 100; $('diffVal').textContent = e.target.value + '%'; };
  $('manual').oninput = (e) => { state.manual = +e.target.value; $('manVal').textContent = e.target.value + ' W'; };
  window.addEventListener('keydown', (e) => {
    if (document.activeElement === $('chatIn')) return;
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
    if (m.system) { div.className = 'sys'; div.textContent = m.text; }
    else div.innerHTML = `<b style="color:${esc(m.color)}">${esc(m.from)}:</b> ${esc(m.text)}`;
    $('chatLog').appendChild(div);
    $('chatLog').scrollTop = 1e9;
  }

  // Trainer
  const trainerStatus = (t) => ($('trainerStatus').textContent = t);
  $('trainerBtn').onclick = async () => {
    if (!bluetoothAvailable()) return alert('Bluetooth niedostępny w tej przeglądarce. Użyj Chrome lub Edge.');
    if (trainer.connected) { trainer.disconnect(); return; }
    try {
      trainerStatus('Łączenie…');
      await trainer.connect();
    } catch (e) {
      trainerStatus('Nie połączono: ' + (e.message || e));
    }
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
    try { await voice.join(); }
    catch (e) { alert('Brak dostępu do mikrofonu: ' + (e.message || e)); }
  };
  $('muteBtn').onclick = () => voice.setMuted(!voice.muted);
  voice.addEventListener('change', () => {
    $('voiceBtn').classList.toggle('on', voice.active);
    $('voiceBtn').textContent = voice.active ? '📞 Rozłącz rozmowę' : '🎙️ Dołącz do rozmowy';
    $('muteBtn').classList.toggle('hidden', !voice.active);
    $('muteBtn').textContent = voice.muted ? '🎙️ Włącz mikrofon' : '🔇 Wycisz (M)';
  });
  voice.addEventListener('failed', () =>
    addChat({ system: true, text: 'Nie udało się zestawić połączenia głosowego z jedną z osób (sieć blokuje P2P). Admin może dodać serwer TURN – patrz README.' }));

  // Send grade to trainer
  let lastSentGrade = null, lastSentAt = 0;
  setInterval(() => {
    if (!trainer.canControl) return;
    const g = state.frozenUntil > Date.now() || state.finished ? 0 : track.gradeAt(state.dist) * state.difficulty;
    const now = Date.now();
    if (lastSentGrade === null || Math.abs(g - lastSentGrade) > 0.0015 || now - lastSentAt > 5000) {
      trainer.setSimulation(g);
      lastSentGrade = g; lastSentAt = now;
    }
  }, 1000);

  // Send own state to server
  setInterval(() => {
    socket.emit('rider:update', {
      dist: state.dist, lap: state.lap, speed: physics.v, power: state.power,
      cadence: state.cadence, hr: state.hr, finished: state.finished,
    });
  }, 250);

  // ---- Main loop ----
  let last = performance.now();
  let uiTimer = 0;
  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;

    // Power source
    const trainerLive = trainer.connected && now - trainer.lastData < 3000;
    state.power = trainerLive ? trainer.power : trainer.connected ? 0 : state.manual;
    state.cadence = trainerLive ? trainer.cadence : 0;
    state.hr = hrm.connected ? hrm.hr : 0;

    const myAbs = state.lap * route.total + state.dist;

    // Others: smooth extrapolation
    for (const o of others.values()) {
      const target = o.abs + (o.finished ? 0 : o.speed * (now - o.recvAt) / 1000);
      o.disp += (target - o.disp) * (1 - Math.exp(-dt * 3));
    }

    // Drafting: nearest rider ahead
    let gapAhead = Infinity;
    for (const o of others.values()) {
      const gap = o.disp - myAbs;
      if (gap > 0 && gap < gapAhead) gapAhead = gap;
    }
    state.draft = draftFactor(gapAhead);

    const frozen = Date.now() < state.frozenUntil;
    if (!frozen && !state.finished) {
      const grade = track.gradeAt(state.dist);
      const moved = physics.step(state.power, grade, dt, state.draft);
      state.dist += moved;
      if (state.dist >= route.total) {
        if (route.loop) { state.dist -= route.total; state.lap++; }
        else { state.dist = route.total; state.finished = true; state.finishTime = state.elapsed; physics.v = 0; }
      }
      if (physics.v > 0.1 || state.elapsed > 0) state.elapsed += dt;
    } else if (frozen) physics.v = 0;

    // Render 3D
    const riders = [{ id: me.id, name: me.name, color: me.color, dist: state.dist, speed: physics.v, cadence: state.cadence, me: true }];
    for (const o of others.values()) {
      riders.push({ id: o.id, name: o.name, color: o.color, dist: ((o.disp % route.total) + route.total) % route.total, speed: o.speed, cadence: o.cadence });
    }
    world.render(dt, riders);

    // HUD (throttled)
    uiTimer += dt;
    if (uiTimer > 0.2) {
      uiTimer = 0;
      $('sPower').textContent = Math.round(state.power);
      $('sSpeed').textContent = (physics.v * 3.6).toFixed(1);
      $('sCad').textContent = state.cadence ? Math.round(state.cadence) : '–';
      $('sHr').textContent = state.hr || '–';
      $('sDist').textContent = ((state.lap * route.total + state.dist) / 1000).toFixed(2);
      $('sGrade').textContent = (track.gradeAt(state.dist) * 100).toFixed(1);
      $('sTime').textContent = fmtTime(state.elapsed);
      $('sWkg').textContent = (state.power / weight).toFixed(1);
      $('draft').classList.toggle('hidden', state.draft < 0.05);

      const banner = $('banner');
      const left = (state.frozenUntil - Date.now()) / 1000;
      if (left > 0) { banner.innerHTML = Math.ceil(left) + '<small>Start za chwilę…</small>'; banner.classList.remove('hidden'); }
      else if (left > -2) { banner.innerHTML = 'START!'; banner.classList.remove('hidden'); }
      else if (state.finished) { banner.innerHTML = '🏁 Meta!<small>Czas: ' + fmtTime(state.finishTime) + '</small>'; banner.classList.remove('hidden'); }
      else banner.classList.add('hidden');

      renderRiderList(myAbs);
      profile.draw(riders);
      minimap.draw(riders);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  function renderRiderList(myAbs) {
    const list = [{ id: me.id, name: me.name, color: me.color, abs: myAbs, power: state.power, me: true,
      voice: voice.active, muted: voice.muted, speaking: voice.active && !voice.muted && voice.isSpeaking('me') }];
    for (const o of others.values()) {
      list.push({ id: o.id, name: o.name, color: o.color, abs: o.disp, power: o.power, weight: o.weight,
        voice: o.voice, muted: o.muted, speaking: voice.isSpeaking(o.id), finished: o.finished });
    }
    list.sort((a, b) => b.abs - a.abs);
    $('riders').innerHTML = list.map((r) => {
      const gap = r.me ? '' : (r.abs - myAbs >= 0 ? '+' : '') + Math.round(r.abs - myAbs) + ' m';
      const wkg = (r.power / (r.me ? weight : r.weight || 75)).toFixed(1);
      const v = r.voice ? (r.muted ? '🔇' : r.speaking ? '<span class="spk">🔊</span>' : '🎧') : '';
      return `<li class="${r.me ? 'me' : ''}"><span class="dot" style="background:${esc(r.color)}"></span>` +
        `<span class="nm">${v} ${esc(r.name)}${r.finished ? ' 🏁' : ''}</span>` +
        `<span class="gap">${gap}</span><span class="w">${wkg} W/kg</span></li>`;
    }).join('');
  }

  addChat({ system: true, text: `Jesteś w przejeździe „${room.code}”. Trasa: ${route.name}. Kliknij „Kopiuj link zaproszenia” i wyślij go znajomym.` });
}
