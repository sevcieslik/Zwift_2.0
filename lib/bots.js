// Server-side bot riders for testing group rides. They live in the room like normal riders,
// so every client sees the same bots, they draft and can be drafted, and they join group-ride events.
//
// Behaviours:
//  steady  – a pace partner: holds the target W/kg (a bit more uphill, eases off downhill)
//  group   – rides "with the bunch": pushes harder to close a gap to riders ahead, eases off when off the front
//  attack  – like group, but now and then launches a 20–40 s attack

const G = 9.81, RHO = 1.225;
const NAMES = ['Ania', 'Bartek', 'Celina', 'Darek', 'Ewa', 'Filip', 'Gosia', 'Henryk', 'Iza', 'Janek', 'Kasia', 'Leszek', 'Magda', 'Norbert', 'Ola', 'Piotr', 'Renata', 'Szymon', 'Tomek', 'Ula', 'Wojtek', 'Zosia'];
const JERSEYS = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#17becf', '#e6194b', '#f5c518', '#3cb44b', '#4363d8', '#911eb4', '#f58231'];
const SKINS = ['#f1c7a5', '#e8b896', '#d29b74', '#a8714c', '#7a4f33'];

function draftFactor(gap) {
  if (gap <= 0.3 || gap > 12) return 0;
  if (gap < 2) return 0.33;
  return 0.33 * (1 - (gap - 2) / 10);
}

let seq = 0;
const rnd = (a, b) => a + Math.random() * (b - a);

function makeBot(room, route, { wkg = 3, mode = 'group', dist = 0, index = 0 }) {
  const name = NAMES[(seq + index) % NAMES.length];
  const weight = Math.round(rnd(58, 88));
  const height = Math.round(150 + (weight - 50) * 0.9 + rnd(-5, 5));
  const uect = Math.random() < 0.35;
  const id = `bot-${++seq}`;
  return {
    id, bot: { mode, wkg, phase: Math.random() * 100, attackUntil: 0, nextAttack: Date.now() + rnd(60, 180) * 1000, v: 0 },
    name: `🤖 ${name} ${wkg.toFixed(1)}`,
    weight, height,
    appearance: {
      avatar: '🚴', jersey: JERSEYS[Math.floor(Math.random() * JERSEYS.length)], shorts: '#151515', socks: Math.random() < 0.5 ? '#ffffff' : '#111111',
      headwear: 'helmet', headColor: Math.random() < 0.5 ? '#ffffff' : '#222222', frame: ['#d0d0d0', '#111111', '#c8102e', '#1f4e9c'][Math.floor(Math.random() * 4)],
      skin: SKINS[Math.floor(Math.random() * SKINS.length)], hair: Math.random() < 0.3 ? 'ponytail' : 'none', hairColor: '#5b3a1e', kit: uect ? 'uect' : '',
    },
    dist: Math.max(0, Math.min(route.total - 1, dist)), lap: 0, speed: 0, power: 0, cadence: 0, hr: 0,
    voice: false, muted: false, finished: false, t: Date.now(),
  };
}

function gradeAt(route, d) {
  const n = route.dist.length;
  const i = Math.max(0, Math.min(n - 2, Math.floor(d / route.step)));
  return route.grade[i] || 0;
}

/** Advance all bots in a room by dt seconds. */
function stepBots(room, route, dt, now) {
  const riders = [...room.riders.values()];
  const humans = riders.filter((p) => !p.bot);
  const abs = (p) => p.lap * route.total + p.dist;
  const waiting = room.event && now < room.event.startAt;
  for (const b of riders) {
    if (!b.bot) continue;
    const B = b.bot;
    const me = abs(b);
    // nearest rider ahead (for drafting and for closing gaps)
    let gapAhead = Infinity;
    for (const o of riders) { if (o === b) continue; const g = abs(o) - me; if (g > 0.2 && g < gapAhead) gapAhead = g; }
    // where the humans are relative to me
    let nearestHuman = Infinity, humanAhead = false;
    for (const h of humans) { const g = abs(h) - me; if (Math.abs(g) < Math.abs(nearestHuman)) { nearestHuman = g; humanAhead = g > 0; } }

    const grade = gradeAt(route, b.dist);
    let target = B.wkg * b.weight;
    target *= 1 + Math.max(-0.7, Math.min(0.22, grade * 3)); // climbs harder, descents easier
    if (grade < -0.05 && B.v > 14) target *= 0.2;              // tuck and coast on fast descents
    target *= 1 + 0.06 * Math.sin(now / 1000 / 7 + B.phase) + 0.03 * Math.sin(now / 1000 / 2.3 + B.phase * 2); // human-ish wobble

    if (B.mode !== 'steady') {
      // stay with the bunch: close a gap of 3–60 m, ease off if 40–150 m clear of the humans behind
      if (gapAhead > 3 && gapAhead < 60) target *= 1 + Math.min(0.35, (gapAhead - 3) / 40);
      if (Number.isFinite(nearestHuman) && !humanAhead && -nearestHuman > 40 && -nearestHuman < 150) target *= 0.8;
    }
    if (B.mode === 'attack') {
      if (now > B.nextAttack && !B.attackUntil) { B.attackUntil = now + rnd(20, 40) * 1000; }
      if (B.attackUntil) {
        if (now < B.attackUntil) target = Math.max(target, B.wkg * b.weight * 1.9);
        else { B.attackUntil = 0; B.nextAttack = now + rnd(90, 240) * 1000; }
      }
    }
    if (waiting) target = 0;

    // power follows the target with some inertia (no instant jumps)
    b.power = Math.round(b.power + (target - b.power) * Math.min(1, dt * 1.5));

    // physics (same model as the client)
    const m = b.weight + 8, v = B.v, theta = Math.atan(grade);
    const A = (h, w) => 0.0293 * Math.pow(h, 0.725) * Math.pow(w, 0.425) + 0.0604;
    const cda = 0.32 * (A(b.height / 100, b.weight) / A(1.78, 75)); // same as the client (profile.js)
    const draft = draftFactor(gapAhead);
    const fDrive = b.power / Math.max(v, 1);
    const fAir = 0.5 * RHO * cda * (1 - draft) * v * v;
    const fRoll = 0.004 * m * G * Math.cos(theta);
    const fGrav = m * G * Math.sin(theta);
    const a = (fDrive - fAir - (v > 0.05 ? fRoll : 0) - fGrav) / (m + 1.2);
    B.v = waiting ? 0 : Math.max(0, Math.min(30, v + a * dt));
    b.dist += ((v + B.v) / 2) * dt;
    if (b.dist >= route.total) { b.dist -= route.total; b.lap++; } // keep riding: next lap
    b.speed = B.v;
    b.cadence = b.power > 20 ? Math.round(82 + B.wkg * 3 + Math.sin(now / 3000 + B.phase) * 4) : 0;
    b.hr = Math.round(95 + (b.power / b.weight) * 22 + Math.sin(now / 9000 + B.phase) * 3);
    b.t = now;
  }
}

module.exports = { makeBot, stepBots };
