'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { buildRoute } = require('./lib/gpx');
const { tileHandler, MOCK: TILE_MOCK, setMockRoutes } = require('./lib/tiles');

const PORT = process.env.PORT || 3000;
const ROUTES_DIR = path.join(__dirname, 'routes');
const MAX_RIDERS = parseInt(process.env.MAX_RIDERS || '20', 10);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e5 });

// ---------- Routes (GPX) ----------
const routeCache = new Map();
function listRoutes() {
  if (!fs.existsSync(ROUTES_DIR)) return [];
  return fs
    .readdirSync(ROUTES_DIR)
    .filter((f) => f.toLowerCase().endsWith('.gpx'))
    .map((f) => {
      const id = f.replace(/\.gpx$/i, '');
      const r = getRoute(id);
      return r ? { id, name: r.name, total: r.total, ascent: r.ascent, loop: r.loop } : null;
    })
    .filter(Boolean)
    .sort((a, b) => (a.id === 'demo') - (b.id === 'demo') || a.name.localeCompare(b.name));
}
function getRoute(id) {
  if (!/^[\w.-]+$/.test(id)) return null;
  if (routeCache.has(id)) return routeCache.get(id);
  const file = path.join(ROUTES_DIR, id + '.gpx');
  if (!fs.existsSync(file)) return null;
  try {
    const route = buildRoute(fs.readFileSync(file, 'utf8'), id);
    route.id = id;
    routeCache.set(id, route);
    return route;
  } catch (e) {
    console.error(`Nie udało się wczytać ${file}:`, e.message);
    return null;
  }
}

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));
app.use('/vendor/three', express.static(path.join(__dirname, 'node_modules/three'), { maxAge: '7d' }));

app.get('/api/routes', (_req, res) => res.json(listRoutes()));
app.get('/api/routes/:id', (req, res) => {
  const r = getRoute(req.params.id);
  if (!r) return res.status(404).json({ error: 'Nie ma takiej trasy' });
  res.json(r);
});
app.get('/api/config', (_req, res) => {
  const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL.split(',').map((s) => s.trim()),
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }
  res.json({ iceServers });
});
app.get('/tiles/:src/:z/:x/:y', tileHandler);
app.get('/healthz', (_req, res) => res.send('ok'));

// ---------- Rooms ----------
const rooms = new Map();

const clean = (s, n) => String(s || '').replace(/[<>]/g, '').trim().slice(0, n);
const num = (v, min, max, def = 0) => {
  const x = Number(v);
  return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : def;
};
const HEX = /^#[0-9a-f]{6}$/i;
const AVATARS = ['🚴', '🚴‍♀️', '🦊', '🐻', '🐼', '🐯', '🦁', '🐸', '🐺', '🦅', '🐝', '🦄', '🐧', '🐙', '🐢', '⚡', '🔥', '⛰️'];
function cleanAppearance(a = {}) {
  const col = (v, d) => (HEX.test(v) ? v.toLowerCase() : d);
  return {
    avatar: AVATARS.includes(a.avatar) ? a.avatar : '🚴',
    jersey: col(a.jersey, '#e6194b'),
    shorts: col(a.shorts, '#151515'),
    socks: col(a.socks, '#ffffff'),
    headwear: a.headwear === 'cap' ? 'cap' : 'helmet',
    headColor: col(a.headColor, '#ffffff'),
    frame: col(a.frame, '#d0d0d0'),
    skin: col(a.skin, '#e8b896'),
    hair: a.hair === 'ponytail' ? 'ponytail' : 'none',
    hairColor: col(a.hairColor, '#5b3a1e'),
    kit: a.kit === 'uect' ? 'uect' : '',
  };
}
const KIT_COLORS = { uect: '#c8102e' };
const riderColor = (r) => KIT_COLORS[r.appearance.kit] || r.appearance.jersey;

function eventPublic(room) {
  const e = room.event;
  return e ? { startAt: e.startAt, hostId: e.hostId, participants: [...e.participants] } : null;
}
function riderPublic(p, now) {
  return {
    id: p.id, name: p.name, color: riderColor(p), appearance: p.appearance, weight: p.weight, height: p.height,
    dist: p.dist, lap: p.lap, speed: p.speed, power: p.power, cadence: p.cadence, hr: p.hr,
    voice: p.voice, muted: p.muted, finished: p.finished, age: now - p.t,
  };
}
function roomPublic(room) {
  const now = Date.now();
  return {
    code: room.code, routeId: room.routeId, hostId: room.hostId, now,
    event: eventPublic(room),
    riders: [...room.riders.values()].map((p) => riderPublic(p, now)),
  };
}

// Who is riding right now (lobby)
app.get('/api/rooms', (_req, res) => {
  const now = Date.now();
  res.json({
    now,
    rooms: [...rooms.values()].map((r) => {
      const route = getRoute(r.routeId);
      return {
        code: r.code, routeId: r.routeId, routeName: route ? route.name : r.routeId, total: route ? route.total : 0,
        hostId: r.hostId, event: eventPublic(r),
        riders: [...r.riders.values()].map((p) => ({
          id: p.id, name: p.name, avatar: p.appearance.avatar, color: riderColor(p),
          dist: p.dist, lap: p.lap, speed: p.speed, age: now - p.t,
        })),
      };
    }),
  });
});

io.on('connection', (socket) => {
  let room = null;

  socket.on('room:join', (msg, ack) => {
    if (room || !msg) return;
    const code = clean(msg.room, 32).toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!code) return ack && ack({ error: 'Brak kodu przejazdu' });
    let r = rooms.get(code);
    if (!r) {
      const routeId = clean(msg.routeId, 80);
      if (!getRoute(routeId)) return ack && ack({ error: 'Nie ma takiej trasy' });
      r = { code, routeId, hostId: socket.id, event: null, riders: new Map() };
      rooms.set(code, r);
    }
    if (r.riders.size >= MAX_RIDERS) return ack && ack({ error: 'Przejazd jest pełny' });
    room = r;
    socket.join(code);
    const p = msg.profile || {};
    const rider = {
      id: socket.id,
      name: clean(p.name, 24) || 'Kolarz',
      weight: num(p.weight, 30, 200, 75),
      height: num(p.height, 120, 220, 178),
      appearance: cleanAppearance(p.appearance),
      dist: num(msg.dist, 0, 1e7), lap: num(msg.lap, 0, 1000) | 0, speed: 0, power: 0, cadence: 0, hr: 0,
      voice: false, muted: false, finished: false, t: Date.now(),
    };
    r.riders.set(socket.id, rider);
    ack && ack({ ok: true, you: riderPublic(rider, Date.now()), room: roomPublic(r) });
    if (!msg.rejoin) io.to(code).emit('chat', { system: true, text: `${rider.name} dołącza do przejazdu` });
  });

  socket.on('rider:update', (u) => {
    if (!room || !u) return;
    const rider = room.riders.get(socket.id);
    if (!rider) return;
    rider.dist = num(u.dist, 0, 1e7);
    rider.lap = num(u.lap, 0, 1000) | 0;
    rider.speed = num(u.speed, 0, 40);
    rider.power = num(u.power, 0, 3000) | 0;
    rider.cadence = num(u.cadence, 0, 250) | 0;
    rider.hr = num(u.hr, 0, 250) | 0;
    rider.finished = !!u.finished;
    rider.t = Date.now();
  });

  // Change look / name during the ride
  socket.on('rider:profile', (p) => {
    const rider = room && room.riders.get(socket.id);
    if (!rider || !p) return;
    if (p.appearance) rider.appearance = cleanAppearance(p.appearance);
    if (p.name) rider.name = clean(p.name, 24) || rider.name;
  });

  // ---- Group ride event (host schedules a common start) ----
  socket.on('event:create', (msg) => {
    if (!room || room.hostId !== socket.id) return;
    const minutes = num(msg && msg.minutes, 0.5, 240, 5);
    room.event = { startAt: Date.now() + minutes * 60000, hostId: socket.id, participants: new Set([socket.id]) };
    const host = room.riders.get(socket.id);
    io.to(room.code).emit('chat', { system: true, event: true, text: `${host.name} planuje jazdę grupową – start za ${minutes < 1 ? Math.round(minutes * 60) + ' s' : Math.round(minutes) + ' min'}. Kliknij „Dołącz do eventu”.` });
  });
  socket.on('event:join', (_m, ack) => {
    if (!room || !room.event || Date.now() > room.event.startAt) return ack && ack({ error: 'Event już wystartował lub nie istnieje' });
    room.event.participants.add(socket.id);
    ack && ack({ ok: true, startAt: room.event.startAt, now: Date.now() });
  });
  socket.on('event:leave', () => { if (room && room.event) room.event.participants.delete(socket.id); });
  socket.on('event:cancel', () => {
    if (!room || !room.event || room.hostId !== socket.id) return;
    room.event = null;
    io.to(room.code).emit('chat', { system: true, text: 'Jazda grupowa została odwołana.' });
  });

  socket.on('chat', (text) => {
    if (!room) return;
    const rider = room.riders.get(socket.id);
    const t = clean(text, 300);
    if (rider && t) io.to(room.code).emit('chat', { from: rider.name, color: riderColor(rider), text: t });
  });

  // ---- Voice (WebRTC signalling, mesh) ----
  socket.on('voice:join', (_m, ack) => {
    if (!room) return;
    const rider = room.riders.get(socket.id);
    if (!rider) return;
    const peers = [...room.riders.values()].filter((p) => p.voice && p.id !== socket.id).map((p) => p.id);
    rider.voice = true;
    ack && ack({ peers });
  });
  socket.on('voice:leave', () => {
    if (!room) return;
    const rider = room.riders.get(socket.id);
    if (rider) rider.voice = false;
    socket.to(room.code).emit('voice:leave', { id: socket.id });
  });
  socket.on('voice:mute', (muted) => {
    const rider = room && room.riders.get(socket.id);
    if (rider) rider.muted = !!muted;
  });
  socket.on('voice:signal', (msg) => {
    if (!room || !msg || typeof msg.to !== 'string') return;
    if (!room.riders.has(msg.to)) return;
    io.to(msg.to).emit('voice:signal', { from: socket.id, data: msg.data });
  });

  socket.on('room:leave', () => leave(true));
  socket.on('disconnect', () => leave(false));

  function leave(explicit) {
    if (!room) return;
    const r = room;
    room = null;
    socket.leave(r.code);
    const rider = r.riders.get(socket.id);
    r.riders.delete(socket.id);
    if (r.event) r.event.participants.delete(socket.id);
    io.to(r.code).emit('room:left', { id: socket.id });
    io.to(r.code).emit('voice:leave', { id: socket.id });
    if (rider) io.to(r.code).emit('chat', { system: true, text: `${rider.name} ${explicit ? 'kończy jazdę' : 'rozłącza się'}` });
    if (r.riders.size === 0) rooms.delete(r.code);
    else if (r.hostId === socket.id) {
      r.hostId = r.riders.keys().next().value;
      if (r.event) r.event.hostId = r.hostId;
    }
  }
});

// Broadcast room state ~4x per second.
setInterval(() => {
  const now = Date.now();
  for (const r of rooms.values()) {
    if (r.event && now > r.event.startAt + 60000) r.event = null;
    io.to(r.code).emit('room:state', {
      now, hostId: r.hostId, event: eventPublic(r),
      riders: [...r.riders.values()].map((p) => riderPublic(p, now)),
    });
  }
}, 250);

if (TILE_MOCK) {
  const { parseGpx } = require('./lib/gpx');
  setMockRoutes(listRoutes().map((r) => parseGpx(fs.readFileSync(path.join(ROUTES_DIR, r.id + '.gpx'), 'utf8')).points));
}

server.listen(PORT, () => {
  console.log(`GPX Ride działa na http://localhost:${PORT}${TILE_MOCK ? ' (teren: dane testowe)' : ''}`);
  console.log('Trasy:', listRoutes().map((r) => `${r.id} (${(r.total / 1000).toFixed(1)} km)`).join(', ') || 'brak');
});
