// Rider profiles stored in the browser (several per device: e.g. you and your partner).

export const AVATARS = ['🚴', '🚴‍♀️', '🦊', '🐻', '🐼', '🐯', '🦁', '🐸', '🐺', '🦅', '🐝', '🦄', '🐧', '🐙', '🐢', '⚡', '🔥', '⛰️'];
export const SKINS = ['#f6d7c3', '#e8b896', '#c98e62', '#8d5a3b', '#5a3a26'];
export const JERSEYS = ['#e6194b', '#ff6a00', '#ffd400', '#3cb44b', '#00a6d6', '#4363d8', '#911eb4', '#f032e6', '#111111', '#ffffff'];

const KEY = 'gpxride.profiles';
const LAST = 'gpxride.lastProfile';

const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch { return false; } },
};

export function defaultAppearance() {
  return {
    avatar: AVATARS[0],
    jersey: JERSEYS[Math.floor(Math.random() * JERSEYS.length)],
    shorts: '#151515',
    socks: '#ffffff',
    headwear: 'helmet', // helmet | cap
    headColor: '#ffffff',
    frame: '#d0d0d0',
    skin: SKINS[1],
    hair: 'none', // none | ponytail
    hairColor: '#5b3a1e',
    kit: '', // '' = own colours, 'uect' = club kit
  };
}

export function newProfile() {
  return { id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: '', weight: 75, height: 178, ftp: 200, sprintX: 3, appearance: defaultAppearance() };
}

export function loadProfiles() {
  try {
    const list = JSON.parse(ls.get(KEY) || '[]');
    return Array.isArray(list) ? list.map((p) => ({ ...newProfile(), ...p, appearance: { ...defaultAppearance(), ...(p.appearance || {}) } })) : [];
  } catch { return []; }
}

export function saveProfile(p) {
  const list = loadProfiles().filter((x) => x.id !== p.id);
  list.unshift(p);
  ls.set(KEY, JSON.stringify(list));
  ls.set(LAST, p.id);
}

export function deleteProfile(id) {
  ls.set(KEY, JSON.stringify(loadProfiles().filter((x) => x.id !== id)));
}

export function lastProfileId() { return ls.get(LAST); }

/** Frontal-area based CdA estimate (Bassett et al.), relative to a 178 cm / 75 kg rider at 0.32. */
export function cdaFor(heightCm, weightKg) {
  const A = (h, m) => 0.0293 * Math.pow(h, 0.725) * Math.pow(m, 0.425) + 0.0604;
  return 0.32 * (A(heightCm / 100, weightKg) / A(1.78, 75));
}

/**
 * Appearance editor: renders controls into `root`, calls onChange(appearance) on every edit.
 */
export function appearanceEditor(root, appearance, onChange) {
  const a = { ...appearance };
  const sw = (key, colors) => `<div class="swatches" data-key="${key}">${colors.map((c) =>
    `<button type="button" class="sw${a[key] === c ? ' sel' : ''}" style="background:${c}" data-v="${c}" title="${c}"></button>`).join('')}
    <input type="color" value="${a[key]}" data-key="${key}" title="Własny kolor" /></div>`;
  root.innerHTML = `
    <div class="ed-row"><span>Strój</span><div class="seg" data-key="kit">
      <button type="button" data-v="" class="${!a.kit ? 'sel' : ''}">Własne kolory</button>
      <button type="button" data-v="uect" class="${a.kit === 'uect' ? 'sel' : ''}">🦅 Klubowy UECT</button></div></div>
    <p class="muted small kit-note">Strój klubowy zastępuje kolory koszulki, spodenek, skarpetek i nakrycia głowy.</p>
    <div class="ed-row"><span>Avatar</span><div class="avatars">${AVATARS.map((x) =>
      `<button type="button" class="av${a.avatar === x ? ' sel' : ''}" data-av="${x}">${x}</button>`).join('')}</div></div>
    <div class="ed-row"><span>Koszulka</span>${sw('jersey', JERSEYS)}</div>
    <div class="ed-row"><span>Spodenki</span>${sw('shorts', ['#151515', '#1e2a5a', '#5a1e1e', '#2b4a2b', '#ffffff'])}</div>
    <div class="ed-row"><span>Skarpetki</span>${sw('socks', ['#ffffff', '#111111', '#ff6a00', '#e6194b', '#ffd400', '#00a6d6'])}</div>
    <div class="ed-row"><span>Na głowie</span><div class="seg" data-key="headwear">
      <button type="button" data-v="helmet" class="${a.headwear === 'helmet' ? 'sel' : ''}">Kask</button>
      <button type="button" data-v="cap" class="${a.headwear === 'cap' ? 'sel' : ''}">Czapeczka</button></div>
      ${sw('headColor', ['#ffffff', '#111111', '#e6194b', '#ffd400', '#00a6d6', '#3cb44b'])}</div>
    <div class="ed-row"><span>Rama roweru</span>${sw('frame', ['#d0d0d0', '#111111', '#e6194b', '#ff6a00', '#00a6d6', '#3cb44b', '#ffd400'])}</div>
    <div class="ed-row"><span>Skóra</span>${sw('skin', SKINS)}</div>
    <div class="ed-row"><span>Włosy</span>${sw('hairColor', ['#2a1a10', '#5b3a1e', '#a8743a', '#e3c27a', '#9a9a9a'])}</div>`;

  const emit = () => onChange({ ...a });
  root.classList.toggle('has-kit', !!a.kit);
  root.onclick = (e) => {
    const av = e.target.closest('[data-av]');
    if (av) { a.avatar = av.dataset.av; root.querySelectorAll('.av').forEach((b) => b.classList.toggle('sel', b === av)); return emit(); }
    const b = e.target.closest('button[data-v]');
    if (!b) return;
    const box = b.parentElement;
    const key = box.dataset.key;
    a[key] = b.dataset.v;
    box.querySelectorAll('button').forEach((x) => x.classList.toggle('sel', x === b));
    const picker = box.querySelector('input[type=color]');
    if (picker) picker.value = b.dataset.v;
    root.classList.toggle('has-kit', !!a.kit);
    emit();
  };
  root.onchange = (e) => {
    if (e.target.tagName !== 'SELECT') return;
    a[e.target.dataset.key] = e.target.value;
    emit();
  };
  root.oninput = (e) => {
    if (e.target.type !== 'color') return;
    const key = e.target.dataset.key;
    a[key] = e.target.value;
    e.target.parentElement.querySelectorAll('button').forEach((x) => x.classList.remove('sel'));
    emit();
  };
  return { get: () => ({ ...a }) };
}

/** Zwift-style power zone colour for a fraction of FTP. */
export function zoneColor(frac) {
  if (!(frac > 0)) return '#9aa3ad';
  if (frac < 0.6) return '#9aa3ad';
  if (frac < 0.76) return '#3d8bfd';
  if (frac < 0.9) return '#3cc46a';
  if (frac < 1.05) return '#ffd21f';
  if (frac < 1.19) return '#ff8a1f';
  return '#ff3b30';
}
