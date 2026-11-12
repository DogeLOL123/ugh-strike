#!/usr/bin/env node
'use strict';
/*
 * UGH-STRIKE multiplayer server  (no dependencies - just Node 16+)
 *
 *   node server.js            -> http://localhost:8080  (serves the game + WebSocket lobby)
 *   PORT=3000 node server.js  -> custom port
 *
 * Role: lobby + room manager + message relay. The room HOST's browser simulates the
 * enemies in co-op; every player reports their own hits in deathmatch. The server
 * validates rooms/hosts/sizes/rates but does not simulate gameplay.
 *
 * Put ugh-strike.html in the same folder as this file. Open http://<this-pc>:8080
 * in every player's browser (same URL = the game connects back to this server).
 * For internet play: host this on a VPS / Render / Fly / Railway (use wss:// behind HTTPS).
 */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

const PORT = +process.env.PORT || 8080;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 64 * 1024, MAX_ROOMS = 200, MAX_CONN = 600, COOP_MAX = 4, DM_MAX = 8;
const GAME_FILE = path.join(__dirname, 'ugh-strike.html');

// ---------- accounts (cloud saves) ----------
// Stored in DATA_DIR/accounts.json. NOTE: on hosts with an ephemeral disk (Render free tier)
// this file is wiped on redeploy/restart - attach a persistent disk and set DATA_DIR to it.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
const ACC_FILE = path.join(DATA_DIR, 'accounts.json');
let accounts = {};
try { accounts = JSON.parse(fs.readFileSync(ACC_FILE, 'utf8')); } catch (e) {}
let accTimer = null;
function saveAcc() {
  if (accTimer) return;
  accTimer = setTimeout(() => {
    accTimer = null; const tmp = ACC_FILE + '.tmp';
    fs.writeFile(tmp, JSON.stringify(accounts), err => { if (!err) fs.rename(tmp, ACC_FILE, () => {}); });
  }, 2000);
}
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const fails = new Map();
const ipOf = c => String(c.ip || '');
function rateOk(c) { const f = fails.get(ipOf(c)); return !(f && f.n >= 10 && Date.now() - f.t < 600000); }
function failed(c) { const k = ipOf(c), f = fails.get(k); if (!f || Date.now() - f.t > 600000) fails.set(k, { n: 1, t: Date.now() }); else f.n++; }
// ---------- storage: Upstash Redis (persistent, set 2 env vars) or local file fallback ----------
const envv = (...ns) => { for (const n of ns) { const v = (process.env[n] || '').trim().replace(/^["']|["']$/g, ''); if (v) return v; } return ''; };
let UP_URL = envv('UPSTASH_REDIS_REST_URL', 'KV_REST_API_URL', 'UPSTASH_REST_URL').replace(/\/+$/, '');
if (UP_URL && !/^https?:\/\//i.test(UP_URL)) UP_URL = 'https://' + UP_URL;
const UP_TOK = envv('UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_TOKEN', 'UPSTASH_REST_TOKEN');
const useDB = !!(UP_URL && UP_TOK && typeof fetch === 'function');
console.log('[storage check] node ' + process.version + ' | fetch: ' + (typeof fetch === 'function' ? 'yes' : 'NO (need Node 18+)') + ' | URL var: ' + (UP_URL ? 'found (' + UP_URL.slice(0, 22) + '...)' : 'MISSING') + ' | TOKEN var: ' + (UP_TOK ? 'found' : 'MISSING'));
if (useDB) dbCmd(['PING']).then(r => console.log('[storage check] Upstash connection OK: ' + r), e => console.log('[storage check] Upstash connection FAILED: ' + e.message + ' (check the URL and token are copied from the REST API section)'));
async function dbCmd(cmd) {
  const r = await fetch(UP_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + UP_TOK, 'content-type': 'application/json' }, body: JSON.stringify(cmd), signal: AbortSignal.timeout(8000) });
  const j = await r.json(); if (j.error) throw new Error(j.error); return j.result;
}
const cache = new Map(), dirty = new Set();
async function getAcc(k) {
  if (cache.has(k)) return cache.get(k);
  let a = null;
  if (useDB) { const r = await dbCmd(['GET', 'acc:' + k]); a = r ? JSON.parse(r) : null; } else a = accounts[k] || null;
  if (a) { if (cache.size > 2000) cache.delete(cache.keys().next().value); cache.set(k, a); }
  return a;
}
async function createAcc(k, a) {
  if (useDB) { const r = await dbCmd(['SET', 'acc:' + k, JSON.stringify(a), 'NX']); if (r !== 'OK') return false; }
  else { if (accounts[k]) return false; accounts[k] = a; saveAcc(); }
  cache.set(k, a); return true;
}
async function putAcc(k) {
  const a = cache.get(k) || accounts[k]; if (!a) return;
  if (useDB) await dbCmd(['SET', 'acc:' + k, JSON.stringify(a)]); else { accounts[k] = a; saveAcc(); }
}
async function flushDirty() { const ks = [...dirty]; dirty.clear(); for (const k of ks) { try { await putAcc(k); } catch (e) { dirty.add(k); console.error('save failed:', e.message); } } }
setInterval(flushDirty, 15000);
process.on('SIGTERM', () => { flushDirty().finally(() => process.exit(0)); });
const scryptP = (p, s) => new Promise((res, rej) => crypto.scrypt(p, s, 32, { N: 16384 }, (e, k) => e ? rej(e) : res(k)));
function cleanSV(o) {
  if (!o || typeof o !== 'object') return null;
  let s; try { s = JSON.stringify(o); } catch (e) { return null; }
  if (s.length > 30000) return null;
  const n = (v, lo, hi, d) => { v = Number(v); return Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.floor(v))) : d; };
  const arr = (a, max) => Array.isArray(a) ? a.slice(0, 200).map(v => n(v, 0, max, 0)) : [];
  const out = { xp: n(o.xp, 0, 1e7, 0), bones: n(o.bones, 0, 1e8, 0), prem: n(o.prem, 0, 1, 0), gs: n(o.gs, 0, 100, 0), as: n(o.as, 0, 100, 0),
    cx: n(o.cx, 0, 100, 0), fx: n(o.fx, 0, 100, 0), vib: n(o.vib, 0, 1, 1), gfx: n(o.gfx, 0, 1, 1), mute: n(o.mute, 0, 1, 0), sens: n(o.sens, 1, 10, 5),
    og: arr(o.og, 100), oa: arr(o.oa, 100), oc: arr(o.oc, 100), of: arr(o.of, 100), cf: arr(o.cf, 200), cp: arr(o.cp, 200), lo: arr(o.lo, 60).slice(0, 3) };
  out.L = (Array.isArray(o.L) ? o.L : []).slice(0, 40).map(l => ({ o: n(l && l.o, 0, 20, 0), b: n(l && l.b, 0, 20, 0), m: n(l && l.m, 0, 20, 0), g: n(l && l.g, 0, 20, 0), a: n(l && l.a, 0, 20, 0) }));
  if (out.lo.length !== 3) out.lo = [2, 1, 0];
  return out;
}

const rooms = new Map();
const conns = new Set();
let nextId = 1;

// ---------- HTTP (serves the game itself) ----------
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

// ---------- minimal RFC6455 WebSocket ----------
function frame(op, buf) {
  const n = buf.length; let h;
  if (n < 126) h = Buffer.from([0x80 | op, n]);
  else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(n, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeUInt32BE(0, 2); h.writeUInt32BE(n, 6); }
  return Buffer.concat([h, buf]);
}
function rawSend(c, buf) {
  if (c.sock.destroyed || !c.sock.writable) return;
  if (c.sock.writableLength > 2 * 1024 * 1024) return; // slow client: drop instead of buffering forever
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
  const c = { ip: String(req.headers['x-forwarded-for'] || sock.remoteAddress || '').split(',')[0].trim(), user: null, id: nextId++, sock, buf: Buffer.alloc(0), name: 'CAVEMAN', room: null, alive: true, frags: [], fop: 0, cnt: 0, said: false };
  conns.add(c);
  sock.on('data', d => { try { onData(c, d); } catch (e) { sock.destroy(); } });
  sock.on('error', () => sock.destroy());
  sock.on('close', () => { conns.delete(c); leaveRoom(c); if (c.user && dirty.has(c.user)) { dirty.delete(c.user); putAcc(c.user).catch(() => dirty.add(c.user)); } });
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

// ---------- lobby / rooms ----------
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  for (let t = 0; t < 50; t++) {
    let s = ''; for (let i = 0; i < 4; i++) s += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(s)) return s;
  }
  return null;
}
const clean = n => String(n == null ? '' : n).replace(/[^\w \-.!?]/g, '').trim().slice(0, 16) || 'CAVEMAN';
// Set OWNER_NAME (your account username) in Render's Environment tab to unlock everything for you only.
const OWNER = String(process.env.OWNER_NAME || '').trim().toLowerCase();
const isOwner = n => !!OWNER && String(n).toLowerCase() === OWNER;
console.log('[owner check] OWNER_NAME ' + (OWNER ? 'is set to "' + OWNER + '"' : 'is NOT set - owner unlock is off'));
function roomInfo(r) { return { t: 'room', code: r.code, host: r.host.id, players: r.players.map(p => ({ id: p.id, name: p.name })), mode: r.mode, map: r.map, started: r.started }; }
function bcastRoom(r) { const m = roomInfo(r); r.players.forEach(p => send(p, m)); }
function leaveRoom(c) {
  const r = c.room; if (!r) return;
  c.room = null;
  r.players = r.players.filter(p => p !== c);
  if (!r.players.length) { rooms.delete(r.code); return; }
  if (r.host === c) {
    if (r.started) { // the host runs the co-op simulation, so the match cannot outlive them
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
  if (c.cnt > 400) return; // per-second flood guard (counter reset below)
  let m; try { m = JSON.parse(text); } catch (e) { return; }
  if (!m || typeof m !== 'object') return;
  switch (m.t) {
    case 'hello': if (!c.user) c.name = clean(m.name); c.said = true; send(c, { t: 'welcome', id: c.id }); break;
    case 'reg': {
      const bad = e => send(c, { t: 'auth', ok: 0, mode: 'reg', err: e });
      if (!rateOk(c)) return bad('TOO MANY TRIES - WAIT A FEW MINUTES');
      const u = String(m.user || ''), p = String(m.pass || ''), k = u.toLowerCase();
      if (!/^[A-Za-z0-9_]{3,16}$/.test(u)) return bad('USERNAME: 3-16 LETTERS, NUMBERS OR _');
      if (p.length < 6 || p.length > 64) return bad('PASSWORD: 6-64 CHARACTERS');
      const sv = cleanSV(m.sv);
      (async () => {
        if (await getAcc(k)) return bad('USERNAME TAKEN');
        const salt = crypto.randomBytes(16).toString('hex'), key = await scryptP(p, salt);
        const tok = k + ':' + crypto.randomBytes(24).toString('hex');
        const a = { name: u, salt, hash: key.toString('hex'), sv, toks: [sha(tok)], created: Date.now() };
        if (!(await createAcc(k, a))) return bad('USERNAME TAKEN');
        c.user = k; c.name = u; send(c, { t: 'auth', ok: 1, mode: 'reg', user: u, tok, sv, owner: isOwner(u) });
      })().catch(e => { console.error('reg:', e.message); bad('SERVER ERROR - TRY AGAIN'); });
      break;
    }
    case 'login': {
      const bad = e => { failed(c); send(c, { t: 'auth', ok: 0, mode: 'login', err: e }); };
      if (!rateOk(c)) return send(c, { t: 'auth', ok: 0, mode: 'login', err: 'TOO MANY TRIES - WAIT A FEW MINUTES' });
      const k = String(m.user || '').toLowerCase().slice(0, 16), p = String(m.pass || '').slice(0, 64);
      (async () => {
        const a = await getAcc(k); if (!a) return bad('WRONG USERNAME OR PASSWORD');
        const key = await scryptP(p, a.salt);
        if (!crypto.timingSafeEqual(key, Buffer.from(a.hash, 'hex'))) return bad('WRONG USERNAME OR PASSWORD');
        const tok = k + ':' + crypto.randomBytes(24).toString('hex');
        a.toks = (a.toks || []).slice(-7).concat(sha(tok)); await putAcc(k);
        c.user = k; c.name = a.name; send(c, { t: 'auth', ok: 1, mode: 'login', user: a.name, tok, sv: a.sv, owner: isOwner(a.name) });
      })().catch(e => { console.error('login:', e.message); send(c, { t: 'auth', ok: 0, mode: 'login', err: 'SERVER ERROR - TRY AGAIN' }); });
      break;
    }
    case 'tok': {
      const tok = String(m.tok || '').slice(0, 100), k = tok.split(':')[0].slice(0, 16);
      (async () => {
        const a = await getAcc(k);
        if (a && (a.toks || []).includes(sha(tok))) { c.user = k; c.name = a.name; send(c, { t: 'auth', ok: 1, mode: 'tok', user: a.name, sv: a.sv, owner: isOwner(a.name) }); }
        else send(c, { t: 'auth', ok: 0, mode: 'tok', err: '' });
      })().catch(() => send(c, { t: 'auth', ok: 0, mode: 'tok', err: '', keep: 1 }));
      break;
    }
    case 'logout': {
      const tok = String(m.tok || '').slice(0, 100), k = c.user; c.user = null;
      if (k) (async () => { const a = await getAcc(k); if (a) { a.toks = (a.toks || []).filter(h => h !== sha(tok)); await putAcc(k); } })().catch(() => {});
      break;
    }
    case 'sv': {
      const k = c.user; if (!k) break; const sv = cleanSV(m.sv); if (!sv) break;
      (async () => { const a = await getAcc(k); if (a) { a.sv = sv; dirty.add(k); } })().catch(() => {});
      break;
    }
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
      r.mode = int(m.mode, 0, 3, 0); r.map = int(m.map, 0, 7, 0); bcastRoom(r); break;
    }
    case 'start': {
      const r = c.room; if (!r || r.host !== c || r.started) break;
      if (r.mode < 2 && r.players.length > COOP_MAX) { send(c, { t: 'err', m: 'CO-OP IS MAX ' + COOP_MAX + ' PLAYERS' }); break; }
      r.started = true;
      const msg = { t: 'start', mode: r.mode, map: r.map, seed: crypto.randomInt(1, 2 ** 31 - 1) };
      r.players.forEach(p => send(p, msg)); bcastRoom(r); break;
    }
    case 'end': {
      const r = c.room; if (!r || r.host !== c || !r.started) break;
      r.started = false; bcastRoom(r); break;
    }
    case 'm': { // relay to the rest of the room (or one player)
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

server.listen(PORT, () => console.log('UGH-STRIKE server on port ' + PORT + ' | accounts stored in: ' + (useDB ? 'Upstash Redis (persistent)' : 'local file (NOT persistent on free hosts)')));
