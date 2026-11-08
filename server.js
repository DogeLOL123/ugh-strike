'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = +process.env.PORT || 8080;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 64 * 1024, MAX_ROOMS = 200, MAX_CONN = 600, COOP_MAX = 4, DM_MAX = 8;
const GAME_FILE = path.join(__dirname, 'ugh-strike.html');

const rooms = new Map();
const conns = new Set();
let nextId = 1;

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
  if (url === '/' || url === '/index.html' || url === '/ugh-strike.html') {
    fs.readFile(GAME_FILE, (err, data) => {
      if (err) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('ugh-strike.html not found next to server.js'); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(data);
    });
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found');
});

function frame(op, buf) {
  const n = buf.length; let h;
  if (n < 126) h = Buffer.from([0x80 | op, n]);
  else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(n, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeUInt32BE(0, 2); h.writeUInt32BE(n, 6); }
  return Buffer.concat([h, buf]);
}
function rawSend(c, buf) {
  if (c.sock.destroyed || !c.sock.writable) return;
  if (c.sock.writableLength > 2 * 1024 * 1024) return;
  c.sock.write(buf);
}
const send = (c, obj) => rawSend(c, frame(1, Buffer.from(JSON.stringify(obj))));

server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13' || conns.size >= MAX_CONN) {
    sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  sock.setNoDelay(true);
  const c = { id: nextId++, sock, buf: Buffer.alloc(0), name: 'CAVEMAN', room: null, alive: true, frags: [], fop: 0, cnt: 0, said: false };
  conns.add(c);
  sock.on('data', d => { try { onData(c, d); } catch (e) { sock.destroy(); } });
  sock.on('error', () => sock.destroy());
  sock.on('close', () => { conns.delete(c); leaveRoom(c); });
});

function onData(c, chunk) {
  c.alive = true;
  c.buf = Buffer.concat([c.buf, chunk]);
  if (c.buf.length > 4 * MAX_FRAME) { c.sock.destroy(); return; }
  for (;;) {
    const b = c.buf;
    if (b.length < 2) return;
    const fin = !!(b[0] & 128), op = b[0] & 15, masked = !!(b[1] & 128);
    let len = b[1] & 127, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; if (b.readUInt32BE(2)) { c.sock.destroy(); return; } len = b.readUInt32BE(6); off = 10; }
    if (!masked || len > MAX_FRAME) { c.sock.destroy(); return; }
    if (b.length < off + 4 + len) return;
    const mask = b.subarray(off, off + 4), data = Buffer.from(b.subarray(off + 4, off + 4 + len));
    for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
    c.buf = b.subarray(off + 4 + len);
    if (op === 8) { try { rawSend(c, frame(8, Buffer.alloc(0))); } catch (e) {} c.sock.end(); return; }
    if (op === 9) { rawSend(c, frame(10, data)); continue; }
    if (op === 10) continue;
    if (op === 1 || op === 2 || op === 0) {
      if (op !== 0) { c.fop = op; c.frags = [data]; } else c.frags.push(data);
      if (c.frags.reduce((a, x) => a + x.length, 0) > MAX_FRAME) { c.sock.destroy(); return; }
      if (fin) { const full = Buffer.concat(c.frags); c.frags = []; if (c.fop === 1) onMsg(c, full.toString('utf8')); }
    }
  }
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  for (let t = 0; t < 50; t++) {
    let s = ''; for (let i = 0; i < 4; i++) s += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(s)) return s;
  }
  return null;
}
const clean = n => String(n == null ? '' : n).replace(/[^\w \-.!?]/g, '').trim().slice(0, 16) || 'CAVEMAN';
function roomInfo(r) { return { t: 'room', code: r.code, host: r.host.id, players: r.players.map(p => ({ id: p.id, name: p.name })), mode: r.mode, map: r.map, started: r.started }; }
function bcastRoom(r) { const m = roomInfo(r); r.players.forEach(p => send(p, m)); }
function leaveRoom(c) {
  const r = c.room; if (!r) return;
  c.room = null;
  r.players = r.players.filter(p => p !== c);
  if (!r.players.length) { rooms.delete(r.code); return; }
  if (r.host === c) {
    if (r.started) {
      r.players.forEach(p => { p.room = null; send(p, { t: 'closed', m: 'HOST LEFT THE ROOM' }); });
      rooms.delete(r.code); return;
    }
    r.host = r.players[0];
  }
  bcastRoom(r);
}
const int = (v, lo, hi, d) => { v = Math.floor(+v); return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d; };

function onMsg(c, text) {
  if (++c.cnt > 2500) { c.sock.destroy(); return; }
  if (c.cnt > 400) return;
  let m; try { m = JSON.parse(text); } catch (e) { return; }
  if (!m || typeof m !== 'object') return;
  switch (m.t) {
    case 'hello': c.name = clean(m.name); c.said = true; send(c, { t: 'welcome', id: c.id }); break;
    case 'list': {
      const l = [];
      rooms.forEach(r => { if (!r.started && r.players.length < DM_MAX) l.push({ code: r.code, host: r.host.name, n: r.players.length, mode: r.mode, map: r.map }); });
      send(c, { t: 'rooms', l: l.slice(0, 40) }); break;
    }
    case 'create': {
      if (!c.said) return;
      leaveRoom(c);
      if (rooms.size >= MAX_ROOMS) { send(c, { t: 'err', m: 'SERVER FULL' }); break; }
      const code = newCode(); if (!code) { send(c, { t: 'err', m: 'TRY AGAIN' }); break; }
      const r = { code, host: c, players: [c], mode: 0, map: 0, started: false };
      rooms.set(code, r); c.room = r; bcastRoom(r); break;
    }
    case 'join': {
      if (!c.said) return;
      const r = rooms.get(String(m.code || '').toUpperCase().slice(0, 4));
      if (!r) { send(c, { t: 'err', m: 'NO SUCH ROOM' }); break; }
      if (r.started) { send(c, { t: 'err', m: 'MATCH ALREADY STARTED' }); break; }
      if (r.players.length >= DM_MAX) { send(c, { t: 'err', m: 'ROOM FULL' }); break; }
      if (c.room === r) break;
      leaveRoom(c); r.players.push(c); c.room = r; bcastRoom(r); break;
    }
    case 'leave': leaveRoom(c); break;
    case 'cfg': {
      const r = c.room; if (!r || r.host !== c || r.started) break;
      r.mode = int(m.mode, 0, 2, 0); r.map = int(m.map, 0, 3, 0); bcastRoom(r); break;
    }
    case 'start': {
      const r = c.room; if (!r || r.host !== c || r.started) break;
      if (r.mode !== 2 && r.players.length > COOP_MAX) { send(c, { t: 'err', m: 'CO-OP IS MAX ' + COOP_MAX + ' PLAYERS' }); break; }
      r.started = true;
      const msg = { t: 'start', mode: r.mode, map: r.map, seed: crypto.randomInt(1, 2 ** 31 - 1) };
      r.players.forEach(p => send(p, msg)); bcastRoom(r); break;
    }
    case 'end': {
      const r = c.room; if (!r || r.host !== c || !r.started) break;
      r.started = false; bcastRoom(r); break;
    }
    case 'm': {
      const r = c.room; if (!r || !r.started || !m.d || typeof m.d !== 'object') break;
      const out = frame(1, Buffer.from(JSON.stringify({ t: 'm', from: c.id, d: m.d })));
      if (m.to != null) { const p = r.players.find(q => q.id === m.to); if (p && p !== c) rawSend(p, out); }
      else r.players.forEach(p => { if (p !== c) rawSend(p, out); });
      break;
    }
  }
}

setInterval(() => conns.forEach(c => { c.cnt = 0; }), 1000);
setInterval(() => conns.forEach(c => {
  if (!c.alive) { c.sock.destroy(); return; }
  c.alive = false; rawSend(c, frame(9, Buffer.alloc(0)));
}), 25000);

server.listen(PORT, () => console.log('UGH-STRIKE server on port ' + PORT));
