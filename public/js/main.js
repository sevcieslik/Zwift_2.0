import { loadProfiles, saveProfile, deleteProfile, newProfile, lastProfileId, appearanceEditor } from './profile.js';
import { RiderPreview } from './preview.js';
import { kitsReady, KITS } from './kits.js';
import { loadRides, deleteRide, saveRide, summarize, download, loadDraft, clearDraft } from './recorder.js';
import { bluetoothAvailable } from './trainer.js';
import { startRide } from './ride.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
};
const km = (m) => (m / 1000).toFixed(1) + ' km';
const colorOf = (p) => (p.appearance.kit && KITS[p.appearance.kit] ? KITS[p.appearance.kit].color : p.appearance.jersey);

const params = new URLSearchParams(location.search);
const invitedRoom = (params.get('room') || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
let profile = null;
let preview = null;
let routes = [];

if (!bluetoothAvailable()) $('btWarn').classList.remove('hidden');
fetch('/api/routes').then((r) => r.json()).then((list) => {
  routes = list;
  $('nRoute').innerHTML = list.map((r) => `<option value="${esc(r.id)}">${esc(r.name)} – ${km(r.total)}, ↑${r.ascent} m${r.loop ? ' (pętla)' : ''}</option>`).join('');
  renderRooms();
});
$('nCode').value = invitedRoom || 'klub-' + Math.random().toString(36).slice(2, 6);

function show(id) {
  for (const v of ['pickProfile', 'editProfile', 'ridesView']) $(v).classList.toggle('hidden', v !== id);
  $('meChip').classList.toggle('hidden', id !== 'ridesView' || !profile);
}

// ---------------- Profiles ----------------
function showPicker() {
  const list = loadProfiles();
  if (!list.length) return editProfile(newProfile(), true);
  const last = lastProfileId();
  list.sort((a, b) => (b.id === last) - (a.id === last));
  $('profileList').innerHTML = list.map((p) => `
    <div class="pcard" data-pick="${esc(p.id)}">
      <button class="edit ghost" data-edit="${esc(p.id)}" title="Edytuj">✏️</button>
      <span class="big-av">${esc(p.appearance.avatar)}</span>
      <b>${esc(p.name)}</b>
      <span class="muted small">${p.weight} kg · ${p.height} cm · FTP ${p.ftp || 200} W</span>
      <span class="stripe" style="background:${esc(colorOf(p))}"></span>
    </div>`).join('') + '<div class="pcard new" data-new="1"><span class="big-av">➕</span><b>Nowy profil</b></div>';
  show('pickProfile');
}
$('profileList').onclick = (e) => {
  const list = loadProfiles();
  const ed = e.target.closest('[data-edit]');
  if (ed) return editProfile(list.find((p) => p.id === ed.dataset.edit), false);
  const pk = e.target.closest('[data-pick]');
  if (pk) return useProfile(list.find((p) => p.id === pk.dataset.pick));
  if (e.target.closest('[data-new]')) editProfile(newProfile(), true);
};

let editing = null, editorApi = null;
async function editProfile(p, isNew) {
  editing = JSON.parse(JSON.stringify(p));
  $('editTitle').textContent = isNew ? 'Nowy profil' : 'Edytuj profil';
  $('pDelete').classList.toggle('hidden', isNew);
  $('pCancel').classList.toggle('hidden', isNew && !loadProfiles().length);
  $('pName').value = editing.name;
  $('pWeight').value = editing.weight;
  $('pHeight').value = editing.height;
  $('pFtp').value = editing.ftp || 200;
  $('pSprint').value = editing.sprintX || 3;
  $('pErr').textContent = '';
  show('editProfile');
  await kitsReady;
  if (!preview) preview = new RiderPreview($('preview'));
  preview.set(editing.appearance, editing.height);
  editorApi = appearanceEditor($('pLook'), editing.appearance, (a) => { editing.appearance = a; preview.set(a, editing.height); });
}
$('pHeight').oninput = () => { if (preview && editing) preview.set(editing.appearance, Number($('pHeight').value) || 178); };
$('pCancel').onclick = showPicker;
$('pDelete').onclick = () => {
  if (!editing || !confirm(`Usunąć profil „${editing.name}”?`)) return;
  deleteProfile(editing.id);
  showPicker();
};
$('pSave').onclick = () => {
  const name = $('pName').value.trim();
  const weight = Number($('pWeight').value), height = Number($('pHeight').value);
  if (!name) return ($('pErr').textContent = 'Podaj imię');
  if (!(weight >= 30 && weight <= 200)) return ($('pErr').textContent = 'Waga 30–200 kg');
  if (!(height >= 120 && height <= 220)) return ($('pErr').textContent = 'Wzrost 120–220 cm');
  const ftp = Number($('pFtp').value), sprintX = Number($('pSprint').value);
  if (!(ftp >= 50 && ftp <= 600)) return ($('pErr').textContent = 'FTP 50–600 W');
  if (!(sprintX >= 1.2 && sprintX <= 5)) return ($('pErr').textContent = 'Próg hiper focus 1,2–5 × FTP');
  Object.assign(editing, { name, weight, height, ftp, sprintX, appearance: editorApi.get() });
  saveProfile(editing);
  useProfile(editing);
};

function useProfile(p) {
  profile = p;
  saveProfile(p); // marks as last used
  $('meChip').innerHTML = `<span class="av">${esc(p.appearance.avatar)}</span><b>${esc(p.name)}</b>
    <button id="chg" class="ghost small-btn">Zmień</button>`;
  $('chg').onclick = showPicker;
  show('ridesView');
  renderDraft();
  renderHistory();
  pollRooms();
}

// ---------------- Rooms ----------------
let roomsData = { rooms: [], now: Date.now() }, clockOffset = 0, pointerDown = false, lastRoomsHtml = '';
document.addEventListener('pointerdown', () => (pointerDown = true));
document.addEventListener('pointerup', () => setTimeout(() => (pointerDown = false), 0));

async function pollRooms() {
  try {
    roomsData = await fetch('/api/rooms').then((r) => r.json());
    clockOffset = roomsData.now - Date.now();
    renderRooms();
  } catch { /* offline */ }
}
setInterval(() => { if (!$('ridesView').classList.contains('hidden')) pollRooms(); }, 2500);
setInterval(() => { if (!$('ridesView').classList.contains('hidden')) renderRooms(); }, 1000);

function renderRooms() {
  if (pointerDown || $('ridesView').classList.contains('hidden')) return;
  const now = Date.now() + clockOffset;
  const rooms = [...roomsData.rooms].sort((a, b) => (b.code === invitedRoom) - (a.code === invitedRoom) || b.riders.length - a.riders.length);
  let html = '';
  if (invitedRoom && !rooms.some((r) => r.code === invitedRoom)) {
    html += `<div class="room highlight"><div class="room-head"><b>${esc(invitedRoom)}</b><span class="muted">Zaproszenie</span></div>
      <p class="empty">Nikt jeszcze nie jedzie w tym przejeździe. Wybierz trasę i rozpocznij go jako pierwszy.</p>
      <div class="acts"><button class="accent" data-create-invite="1">▶ Rozpocznij „${esc(invitedRoom)}”</button></div></div>`;
  }
  for (const r of rooms) {
    const ev = r.event;
    let evHtml = '';
    if (ev) {
      const left = (ev.startAt - now) / 1000;
      evHtml = left > 0
        ? `<div class="ev-box"><span>📅 Jazda grupowa · start za <span class="timer" data-at="${ev.startAt}"></span> · zapisanych: ${ev.participants.length}</span>
            <button class="accent" data-event="${esc(r.code)}">Dołącz do eventu</button></div>`
        : `<div class="ev-box"><span>🚴 Jazda grupowa trwa</span></div>`;
    }
    const riders = [...r.riders].sort((a, b) => (b.lap * r.total + b.dist) - (a.lap * r.total + a.dist));
    html += `<div class="room${r.code === invitedRoom ? ' highlight' : ''}">
      <div class="room-head"><b>${esc(r.code)}</b><span class="muted">${esc(r.routeName)} · ${km(r.total)} · ${r.riders.length} ${r.riders.length === 1 ? 'osoba' : 'osób'}</span></div>
      ${evHtml}
      <ul>${riders.map((p) => `<li><span class="av">${esc(p.avatar)}</span><span><b style="color:${esc(p.color)}">●</b> ${esc(p.name)}</span>
        <span class="km">${(p.dist / 1000).toFixed(1)} km${p.lap ? ` · okr. ${p.lap + 1}` : ''}</span>
        <button class="small-btn" data-join-rider="${esc(p.id)}" data-room="${esc(r.code)}">Dołącz do ${esc(p.name)}</button></li>`).join('')}</ul>
      <div class="acts"><button data-start="${esc(r.code)}">⏮ Jedź od startu</button></div></div>`;
  }
  if (!html) html = '<p class="empty">Nikt teraz nie jeździ. Utwórz nowy przejazd poniżej i wyślij znajomym link.</p>';
  if (html !== lastRoomsHtml) { $('roomList').innerHTML = html; lastRoomsHtml = html; }
  for (const t of $('roomList').querySelectorAll('.timer[data-at]')) t.textContent = fmtTime((Number(t.dataset.at) - now) / 1000);
  $('roomsInfo').textContent = rooms.length ? `${rooms.reduce((s, r) => s + r.riders.length, 0)} osób na trasach` : '';
  if (invitedRoom && !rooms.some((r) => r.code === invitedRoom)) $('newRide').open = true;
}

$('roomList').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.createInvite) return go({ code: invitedRoom, routeId: $('nRoute').value, start: { mode: 'start' } });
  const room = (code) => roomsData.rooms.find((r) => r.code === code);
  if (b.dataset.event) return go({ code: b.dataset.event, routeId: room(b.dataset.event).routeId, start: { mode: 'event' } });
  if (b.dataset.start) return go({ code: b.dataset.start, routeId: room(b.dataset.start).routeId, start: { mode: 'start' } });
  if (b.dataset.joinRider) return go({ code: b.dataset.room, routeId: room(b.dataset.room).routeId, start: { mode: 'rider', riderId: b.dataset.joinRider } });
};
$('nCreate').onclick = () => {
  const code = $('nCode').value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
  if (!code) return ($('joinErr').textContent = 'Podaj kod przejazdu');
  go({ code, routeId: $('nRoute').value, start: { mode: 'start' } });
};

async function go(opts) {
  if (!profile) return showPicker();
  $('joinErr').textContent = '';
  try {
    await kitsReady;
    if (preview) { preview.dispose(); preview = null; }
    await startRide({ ...opts, profile, onError: (msg) => { $('joinErr').textContent = msg; } });
  } catch (e) {
    $('joinErr').textContent = 'Nie udało się dołączyć: ' + (e.message || e);
  }
}

// ---------------- History & draft ----------------
function rideRow(r, actions) {
  const s = summarize(r);
  const d = new Date(r.date);
  return `<div class="hist"><div><b>${esc(r.routeName)}</b>
    <div class="meta">${d.toLocaleDateString('pl-PL')} ${d.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })} · ${esc(r.profile.name)} ·
    ${km(s.distance)} · ${fmtTime(s.moving)} · ${Math.round(s.avgPower)} W śr. · ↑${Math.round(s.ascent)} m</div></div>
    <div class="btns">${actions}</div></div>`;
}
function renderHistory() {
  const rides = loadRides();
  $('history').innerHTML = rides.length
    ? rides.map((r) => rideRow(r, `<button data-dl="gpx" data-id="${r.id}">GPX</button><button data-dl="tcx" data-id="${r.id}">TCX</button><button class="danger" data-del="${r.id}">🗑</button>`)).join('')
    : '<p class="empty">Brak zapisanych przejazdów. Po jeździe kliknij „Zakończ” → „Zapisz w historii”.</p>';
}
$('history').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const r = loadRides().find((x) => x.id === b.dataset.id || x.id === b.dataset.del);
  if (!r) return;
  if (b.dataset.dl) download(r, b.dataset.dl);
  if (b.dataset.del && confirm('Usunąć ten przejazd z historii?')) { deleteRide(r.id); renderHistory(); }
};
function renderDraft() {
  const d = loadDraft();
  const box = $('draftBox');
  if (!d || !d.samples || d.samples.length < 30) { box.classList.add('hidden'); return; }
  box.innerHTML = `<b>⚠️ Niezapisany przejazd</b> – jazda została przerwana (zamknięta karta lub awaria).` +
    rideRow(d, '<button data-d="save">💾 Zapisz</button><button data-d="gpx">GPX</button><button class="danger" data-d="drop">Odrzuć</button>');
  box.classList.remove('hidden');
  box.onclick = (e) => {
    const a = e.target.closest('button')?.dataset.d;
    if (a === 'save') { saveRide(d); clearDraft(); renderDraft(); renderHistory(); }
    if (a === 'gpx') download(d, 'gpx');
    if (a === 'drop' && confirm('Odrzucić ten przejazd?')) { clearDraft(); renderDraft(); }
  };
}

showPicker();
