import { World } from './world.js';
import { RideAudio } from './audio.js';
import { TIMES, WEATHERS, WINDS } from './atmosphere.js';
import { Physics, draftFactor } from './physics.js';
import { Trainer, HeartRate, bluetoothAvailable } from './trainer.js';
import { Voice } from './voice.js';
import { Profile, MiniMap } from './hud.js';
import { cdaFor, saveProfile, appearanceEditor, zoneColor } from './profile.js';
import { VIEWS } from './camera.js';
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

  const world = new World($('view'), route, { lidar: config.lidar, seed: code });
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
    test: false, timeScale: 1, sprintTestUntil: 0, warp: 0, warpOn: false,
  };
  let others = new Map();
  let clockOffset = room.now - Date.now();
  world.atmo.clock = () => Date.now() + clockOffset; // shared weather in a group ride

  // ---------- Sound ----------
  const audio = new RideAudio();
  audio.start();
  const wakeAudio = () => audio.start();
  document.addEventListener('pointerdown', wakeAudio);
  document.addEventListener('keydown', wakeAudio);
  const soundUi = () => { $('soundBtn').textContent = audio.enabled ? '🔊 Dźwięk' : '🔈 Dźwięk: wył.'; $('soundBtn').classList.toggle('on', audio.enabled); };
  $('soundBtn').onclick = () => { audio.setEnabled(!audio.enabled); soundUi(); };
  soundUi();

  // ---------- Time of day, weather, wind ----------
  const wStore = (() => { try { return JSON.parse(localStorage.getItem('gpxride.weather') || '{}'); } catch { return {}; } })();
  Object.assign(world.atmo.settings, wStore);
  const fill = (id, list, key) => {
    $(id).innerHTML = list.map(([v, n]) => `<option value="${v}">${n}</option>`).join('');
    $(id).value = world.atmo.settings[key];
    $(id).onchange = () => {
      world.atmo.settings[key] = $(id).value;
      try { localStorage.setItem('gpxride.weather', JSON.stringify(world.atmo.settings)); } catch {}
    };
  };
  fill('wTime', TIMES, 'time'); fill('wWeather', WEATHERS, 'weather'); fill('wWind', WINDS, 'wind');
  $('weatherBtn').onclick = () => { $('weatherPanel').classList.toggle('hidden'); $('weatherBtn').classList.toggle('on', !$('weatherPanel').classList.contains('hidden')); };
  const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
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
    // jumped somewhere the world isn't loaded yet: wait for it instead of riding in an empty place
    const p = track.sample(state.dist);
    if (world.terrainMode !== 'google' && !world.terrain.status(p.x, p.z).ground) startLoading(`km ${(state.dist / 1000).toFixed(1)}`);
  }
  // ---------- Loading screen: don't start riding in an empty world ----------
  const loading = { on: false, t0: 0 };
  function startLoading(where) {
    loading.on = true; loading.t0 = performance.now();
    state.loading = true;
    const el = $('loading');
    el.classList.remove('hidden', 'fade');
    $('ldWhere').textContent = where || '';
    $('ldSkip').classList.add('hidden');
    for (const id of ['ldGround', 'ldObjects', 'ldGoogle']) $(id).classList.remove('done', 'active');
  }
  function endLoading() {
    if (!loading.on) return;
    loading.on = false; state.loading = false;
    const el = $('loading');
    el.classList.add('fade');
    setTimeout(() => { if (!loading.on) el.classList.add('hidden'); }, 650);
  }
  $('ldSkip').onclick = endLoading;
  setInterval(() => {
    if (!loading.on) return;
    const s = track.sample(state.dist);
    const mode = world.terrainMode || 'lidar';
    const st = world.terrain.status(s.x, s.z);
    const g = world.google, gWant = (mode === 'google' || mode === 'mix') && !!g;
    let gDone = true;
    if (gWant) {
      const gs = (g.tiles && g.tiles.stats) || {};
      gDone = g.errors > 0 || (g.loaded && (gs.downloading || 0) + (gs.parsing || 0) === 0 && (mode !== 'google' || g.calibrated));
    }
    const ground = mode === 'google' ? true : st.ground;
    const objects = mode === 'google' ? true : st.objects;
    const mark = (id, done, active) => { $(id).classList.toggle('done', done); $(id).classList.toggle('active', !done && active); };
    $('ldGround').classList.toggle('hidden', mode === 'google');
    $('ldObjects').classList.toggle('hidden', mode === 'google');
    $('ldGoogle').classList.toggle('hidden', !gWant);
    mark('ldGround', ground, true);
    mark('ldObjects', objects, ground);
    mark('ldGoogle', gDone, true);
    const parts = [ground, objects, gDone];
    const frac = parts.filter(Boolean).length / parts.length;
    $('ldBarIn').style.width = Math.max(4, Math.round(frac * 100 - (st.pending ? 3 : 0))) + '%';
    $('ldTiles').textContent = st.pending ? `pobieram dane: ${st.pending} w kolejce, ${st.loaded} gotowe` : (st.online ? '' : 'brak połączenia z serwerem map – teren zastępczy');
    const el = performance.now() - loading.t0;
    if (el > 12000) $('ldSkip').classList.remove('hidden');
    if ((ground && objects && gDone && el > 600) || el > 180000) endLoading();
  }, 250);

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
      state.manual = Math.max(0, Math.min(1500, state.manual + (e.key === 'ArrowUp' ? 10 : -10)));
      $('manual').value = state.manual; $('manVal').textContent = state.manual + ' W';
      e.preventDefault();
    } else if (e.key === 'c' || e.key === 'C') {
      world.rig.next();
    } else if (e.key === 'm' || e.key === 'M') {
      if (voice.active) voice.setMuted(!voice.muted);
    } else if ((e.key === 'PageUp' || e.key === 'PageDown') && world.google && world.terrainMode !== 'lidar') {
      const m = world.google.nudge(e.key === 'PageUp' ? 1 : -1);
      const g = world.google;
      addChat({ system: true, text: `Google 3D: ręczna korekta ${m > 0 ? '+' : ''}${m} m (auto ${g.yOffset.toFixed(1)} m, ostatni pomiar ${g.lastDiff != null ? g.lastDiff.toFixed(1) : '–'} m)` });
      e.preventDefault();
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

  // ---------- Terrain source: own LiDAR terrain or Google Photorealistic 3D Tiles ----------
  const tStore = { get() { try { return localStorage.getItem('gpxride.terrain'); } catch { return null; } }, set(v) { try { localStorage.setItem('gpxride.terrain', v); } catch { /* */ } } };
  const TMODES = { lidar: '🗺️ Teren: Lidar', mix: '🗺️ Teren: Lidar + Google', google: '🗺️ Teren: Google 3D' };
  let terrainMode = config.googleKey && (tStore.get() === 'google' || tStore.get() === 'mix') ? tStore.get() : 'lidar';
  const baseAttrib = $('attrib').textContent;
  async function applyTerrain() {
    const g = await world.setTerrainMode(terrainMode, config.googleKey);
    if (terrainMode !== 'lidar' && !g) {
      addChat({ system: true, text: `Google 3D Tiles: nie udało się załadować biblioteki (${world.googleLoadError || 'brak'}). Uruchom w folderze gry „npm install” i zrestartuj serwer. Wracam do terenu z lidaru.` });
      terrainMode = 'lidar'; tStore.set('lidar');
      return applyTerrain();
    }
    $('terrainBtn').textContent = TMODES[terrainMode];
    $('terrainBtn').classList.toggle('on', terrainMode !== 'lidar');
    if (g && !g._hooked) {
      g._hooked = true;
      g.addEventListener('error', (e) => {
        addChat({ system: true, text: `Google 3D Tiles: nie udało się wczytać (${e.detail}). Wracam do terenu z lidaru. Sprawdź klucz GOOGLE_MAPS_KEY, czy Map Tiles API jest włączone i czy w ograniczeniach klucza jest ten adres strony (np. http://localhost:3000/*). Szczegóły: F12 → Console.` });
        if (!g.loaded) { terrainMode = 'lidar'; applyTerrain(); }
      });
      g.addEventListener('ready', () => addChat({ system: true, text: 'Google 3D Tiles połączone ✔ (v4)' }));
    }
  }
  $('terrainBtn').onclick = () => {
    if (!config.googleKey) {
      addChat({ system: true, text: 'Google 3D Tiles: serwer nie ma klucza. Ustaw zmienną GOOGLE_MAPS_KEY i uruchom serwer ponownie (lokalnie: $env:GOOGLE_MAPS_KEY="…" przed npm start).' });
      return;
    }
    terrainMode = terrainMode === 'lidar' ? 'mix' : terrainMode === 'mix' ? 'google' : 'lidar';
    tStore.set(terrainMode);
    applyTerrain();
  };
  if (!config.googleKey) $('terrainBtn').title = 'Brak klucza Google (GOOGLE_MAPS_KEY)';
  applyTerrain();
  if (!loading.on) startLoading(state.dist > 100 ? `km ${(state.dist / 1000).toFixed(1)}` : 'Start trasy');
  setInterval(() => {
    if (terrainMode !== 'lidar' && world.google) {
      const a = world.google.attributions();
      $('attrib').textContent = 'Google' + (a ? ' · ' + a : '') + ' · ' + baseAttrib;
    } else $('attrib').textContent = baseAttrib;
  }, 2000);

  // ---------- Hyper focus (sprint) ----------
  const powerHist = []; // [t, W]
  function updateWarp(now) {
    powerHist.push([now, state.power]);
    while (powerHist.length && now - powerHist[0][0] > 3000) powerHist.shift();
    const avg = powerHist.reduce((s, p) => s + p[1], 0) / powerHist.length;
    const thr = (profile.ftp || 200) * (profile.sprintX || 3);
    const full = now - powerHist[0][0] > 2500; // at least ~3 s of data
    if (!state.warpOn && full && avg >= thr && !state.paused) state.warpOn = true;
    else if (state.warpOn && (avg < thr * 0.85 || state.paused)) state.warpOn = false;
  }

  // ---------- Test mode & camera ----------
  $('tView').innerHTML = VIEWS.map((v, i) => `<option value="${i}">${v.name}</option>`).join('');
  $('tView').onchange = (e) => world.rig.setView(Number(e.target.value));
  let toastTimer = 0;
  world.rig.addEventListener('view', (e) => {
    $('tView').value = world.rig.view;
    $('camToast').textContent = '🎥 ' + e.detail;
    $('camToast').classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('camToast').classList.add('hidden'), 1400);
  });
  setTimeout(() => $('camHint').classList.add('fade'), 9000);
  $('testBtn').onclick = () => {
    state.test = !state.test;
    $('testPanel').classList.toggle('hidden', !state.test);
    $('testBtn').classList.toggle('on', state.test);
    $('testBtn').textContent = state.test ? '🧪 Tryb testowy: WŁ.' : '🧪 Tryb testowy';
    if (state.test) {
      recorder.newSegment();
      if (!state.manual && !trainer.connected) { state.manual = 200; $('manual').value = 200; $('manVal').textContent = '200 W'; }
      addChat({ system: true, text: 'Tryb testowy: jazda nie jest nagrywana. Moc ustawisz suwakiem lub strzałkami ↑ ↓.' });
    } else {
      state.timeScale = 1; $('tSpeed').value = '1';
      recorder.newSegment();
    }
  };
  $('tSpeed').onchange = (e) => { state.timeScale = Number(e.target.value); };
  $('tJump').onclick = () => {
    const km = Number($('tKm').value);
    if (!Number.isFinite(km)) return;
    leaveEventIfWaiting();
    setAbs(Math.max(0, Math.min(route.total - 1, km * 1000)), physics.v);
  };
  $('tSprint').onclick = () => { state.sprintTestUntil = Date.now() + 8000; };

  // ---------- Timers ----------
  let lastSentGrade = null, lastSentAt = 0, lastSentWind = 0;
  setInterval(() => {
    if (!trainer.canControl) return;
    const idle = waitingForEvent() || state.finished || state.paused || state.loading;
    // look ~1 s ahead: the trainer's brake needs time to change, so the resistance arrives with the slope
    const ahead = Math.max(3, physics.v * 1.0);
    const g = idle ? 0 : track.gradeAt(state.dist + ahead) * state.difficulty;
    const wind = idle ? 0 : (state.headwind || 0) * (1 - state.draft);
    const now = Date.now();
    if (lastSentGrade === null || Math.abs(g - lastSentGrade) > 0.0015 || Math.abs(wind - (lastSentWind || 0)) > 0.4 || now - lastSentAt > 5000) {
      lastSentWind = wind;
      trainer.setSimulation(g, { wind });
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
    if (state.paused || waitingForEvent() || state.finished || state.test) return;
    if (physics.v < 0.1 && recorder.samples.length === 0) return;
    const s = track.sample(state.dist);
    recorder.add({ x: s.x, y: -s.z, ele: s.ele, power: state.power, hr: state.hr, cadence: state.cadence, speed: physics.v });
  }, 1000);
  setInterval(() => { if (!state.saved && recorder.samples.length > 30) saveDraft(recorder.toJSON()); }, 30000);
  // leaving the page: let go of the trainer and HR strap right away so another app (Zwift…) can pair
  window.addEventListener('pagehide', () => { try { trainer.disconnect(); } catch {} try { hrm.disconnect(); } catch {} });
  window.addEventListener('beforeunload', (e) => {
    if (!state.saved && recorder.samples.length > 30) { saveDraft(recorder.toJSON()); e.preventDefault(); }
  });

  // ---------- Simulation (runs even when the tab is in the background) ----------
  let simLast = performance.now();
  let wasWaiting = false;
  function simulate() {
    const now = performance.now();
    let total = Math.min(30, (now - simLast) / 1000) * (state.test ? state.timeScale : 1); // background tabs tick ~1/s
    simLast = now;

    const trainerLive = trainer.connected && now - trainer.lastData < 3000;
    state.power = trainerLive ? trainer.power : trainer.connected ? 0 : state.manual;
    if (Date.now() < state.sprintTestUntil) state.power = Math.round((profile.ftp || 200) * (profile.sprintX || 3) * 1.15);
    state.cadence = trainerLive ? trainer.cadence : 0;
    state.hr = hrm.connected ? hrm.hr : 0;
    updateWarp(now);
    { const h = track.sample(state.dist); state.headwind = world.atmo.headwind(h.dx, h.dz); }

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
      if (!waiting && !state.finished && !state.paused && !state.loading) {
        const moved = physics.step(state.power, track.gradeAt(state.dist), dt, state.draft, state.headwind || 0);
        state.dist += moved;
        recorder.addDistance(moved);
        if (state.dist >= route.total) {
          if (route.loop) { state.dist -= route.total; state.lap++; }
          else { state.dist = route.total; state.finished = true; state.finishTime = state.elapsed; physics.v = 0; }
        }
        if (physics.v > 0.1 || state.elapsed > 0) state.elapsed += dt;
      } else if (waiting || state.paused || state.loading) physics.v = 0;
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
      dist: state.dist, speed: physics.v, cadence: state.cadence || (state.power > 20 ? 80 : 0), wkg: state.power / (profile.weight || 75), me: true }];
    for (const o of others.values()) {
      riders.push({ id: o.id, name: o.name, appearance: o.appearance, height: o.height, color: o.color,
        dist: ((o.disp % route.total) + route.total) % route.total, speed: o.speed, cadence: o.cadence, wkg: (o.power || 0) / (o.weight || 75) });
    }
    state.warp += ((state.warpOn ? 1 : 0) - state.warp) * (1 - Math.exp(-dt * (state.warpOn ? 2.5 : 1.4)));
    if (state.warp < 0.002) state.warp = 0;
    world.render(dt, riders, { warp: state.warp, speed: physics.v });
    if (world.env) audio.update({ speed: physics.v, airspeed: physics.v + (state.headwind || 0), power: state.power, cadence: state.cadence || (state.power > 20 ? 80 : 0),
      rain: world.env.rain, wet: world.env.wet, day: world.env.day, windSpeed: world.atmo.state.windSpeed });
    $('ride').classList.toggle('warp', state.warp > 0.5);

    uiTimer += dt;
    if (uiTimer > 0.2) {
      uiTimer = 0;
      $('sPower').textContent = Math.round(state.power);
      $('sPower').style.color = zoneColor(state.power / (profile.ftp || 200));
      $('sSpeed').textContent = (physics.v * 3.6).toFixed(1);
      $('sCad').textContent = state.cadence ? Math.round(state.cadence) : '–';
      $('sHr').textContent = state.hr || '–';
      $('sDist').textContent = (me / 1000).toFixed(2);
      $('sGrade').textContent = (track.gradeAt(state.dist) * 100).toFixed(1);
      $('sTime').textContent = fmtTime(state.elapsed);
      $('sWkg').textContent = (state.power / profile.weight).toFixed(1);
      $('draft').classList.toggle('hidden', state.draft < 0.05);
      { // wind relative to the rider: arrow shows where it blows to, on screen "up" = ahead
        const ws = world.atmo.state, hdg = world.camAng || 0; // camAng: atan2(dx, dz)
        const bearing = Math.atan2(Math.sin(hdg), -Math.cos(hdg)); // heading as compass bearing (north = -Z)
        const rel = ws.windFrom + Math.PI - bearing;
        const hw = state.headwind || 0;
        const deg = Math.round(((ws.windFrom * 180 / Math.PI) % 360 + 360) % 360);
        $('windChip').innerHTML = ws.windSpeed < 0.5 ? '💨 bezwietrznie' :
          `💨 <span class="arrow" style="transform:rotate(${(rel * 180 / Math.PI).toFixed(0)}deg)">⬆</span> ${ws.windSpeed.toFixed(1)} m/s z ${COMPASS[Math.round(deg / 45) % 8]}` +
          (Math.abs(hw) > 0.7 ? ` · <span class="${hw > 0 ? 'head' : 'tail'}">${hw > 0 ? 'pod wiatr' : 'z wiatrem'}</span>` : ' · z boku');
      }
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
  addChat({ system: true, text: route.snap ? `Trasa dopasowana do dróg OSM: ${route.snap.coverage}% punktów, średnio ${route.snap.meanOffset} m korekty.` : 'Trasa NIE jest dopasowana do dróg OSM (sprawdź okno serwera).' });
}
