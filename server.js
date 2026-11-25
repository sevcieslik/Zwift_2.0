'use strict';
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { buildRoute } = require('./lib/gpx');

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
app.get('/healthz', (_req, res) => res.send('ok'));

// ---------- Rooms ----------
const COLORS = ['#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#46f0f0', '#f032e6', '#bcf60c', '#fabebe', '#008080', '#e6beff', '#9a6324', '#fffac8', '#800000', '#aaffc3'];
const rooms = new Map();

const clean = (s, n) => String(s || '').replace(/[<>]/g, '').trim().slice(0, n);
const num = (v, min, max, def = 0) => {
  const x = Number(v);
  return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : def;
};

function roomPublic(room) {
  return {
    code: room.code,
    routeId: room.routeId,
    hostId: room.hostId,
    startAt: room.startAt,
    riders: [...room.riders.values()],
  };
}

io.on('connection', (socket) => {
  let room = null;

  socket.on('room:join', (msg, ack) => {
    if (room) return;
    const code = clean(msg && msg.room, 32).toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!code) return ack && ack({ error: 'Brak kodu przejazdu' });
    let r = rooms.get(code);
    if (!r) {
      const routeId = clean(msg.routeId, 80);
      if (!getRoute(routeId)) return ack && ack({ error: 'Nie ma takiej trasy' });
      r = { code, routeId, hostId: socket.id, startAt: null, riders: new Map(), colorIdx: 0 };
      rooms.set(code, r);
    }
    if (r.riders.size >= MAX_RIDERS) return ack && ack({ error: 'Przejazd jest pełny' });
    room = r;
    socket.join(code);
    const rider = {
      id: socket.id,
      name: clean(msg.name, 24) || 'Kolarz',
      weight: num(msg.weight, 30, 200, 75),
      color: COLORS[r.colorIdx++ % COLORS.length],
      dist: 0, lap: 0, speed: 0, power: 0, cadence: 0, hr: 0,
      voice: false, muted: false, finished: false, t: Date.now(),
    };
    r.riders.set(socket.id, rider);
    ack && ack({ ok: true, you: rider, room: roomPublic(r) });
    socket.to(code).emit('room:joined', rider);
    io.to(code).emit('chat', { system: true, text: `${rider.name} dołącza do przejazdu` });
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

  socket.on('room:start', (msg) => {
    if (!room || room.hostId !== socket.id) return;
    room.startAt = Date.now() + num(msg && msg.countdown, 3, 60, 10) * 1000;
    io.to(room.code).emit('room:start', { startAt: room.startAt, serverNow: Date.now() });
  });

  socket.on('chat', (text) => {
    if (!room) return;
    const rider = room.riders.get(socket.id);
    const t = clean(text, 300);
    if (rider && t) io.to(room.code).emit('chat', { from: rider.name, color: rider.color, text: t });
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

  socket.on('disconnect', () => {
    if (!room) return;
    const rider = room.riders.get(socket.id);
    room.riders.delete(socket.id);
    io.to(room.code).emit('room:left', { id: socket.id });
    socket.to(room.code).emit('voice:leave', { id: socket.id });
    if (rider) io.to(room.code).emit('chat', { system: true, text: `${rider.name} opuszcza przejazd` });
    if (room.riders.size === 0) rooms.delete(room.code);
    else if (room.hostId === socket.id) {
      room.hostId = room.riders.keys().next().value;
      io.to(room.code).emit('room:host', { hostId: room.hostId });
    }
  });
});

// Broadcast room state ~4x per second.
setInterval(() => {
  const now = Date.now();
  for (const r of rooms.values()) {
    io.to(r.code).emit('room:state', {
      now,
      riders: [...r.riders.values()].map((p) => ({
        id: p.id, name: p.name, color: p.color, weight: p.weight, dist: p.dist, lap: p.lap,
        speed: p.speed, power: p.power, cadence: p.cadence, hr: p.hr, voice: p.voice,
        muted: p.muted, finished: p.finished, age: now - p.t,
      })),
    });
  }
}, 250);

server.listen(PORT, () => {
  console.log(`GPX Ride działa na http://localhost:${PORT}`);
  console.log('Trasy:', listRoutes().map((r) => `${r.id} (${(r.total / 1000).toFixed(1)} km)`).join(', ') || 'brak');
});
