const express = require('express');
const http    = require('http');
const https   = require('https');
const { Server } = require('socket.io');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/proxy-image', (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('Missing url');
  const mod = url.startsWith('https') ? https : http;
  mod.get(url, imgRes => {
    res.setHeader('Content-Type', imgRes.headers['content-type'] || 'image/png');
    res.setHeader('Access-Control-Allow-Origin', '*');
    imgRes.pipe(res);
  }).on('error', () => res.status(500).send('Proxy error'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Config ───────────────────────────────────────────────
const MAX_PLAYERS  = 8;
const ROUND_TIME   = 120;
const RESPAWN_WAIT = 5;
const ROUNDS_TO_WIN= 5;

const SPAWNS = {
  OJO:    [{ x:-18,y:0,z:-18 },{ x:-15,y:0,z:-18 },{ x:-18,y:0,z:-15 },{ x:-12,y:0,z:-18 }],
  STRIKE: [{ x: 18,y:0,z: 18 },{ x: 15,y:0,z: 18 },{ x: 18,y:0,z: 15 },{ x: 12,y:0,z: 18 }]
};

const WEAPONS = {
  rifle:  { damage:30,  fireRate:150,  ammo:30, reserve:90,  reloadTime:2000 },
  pistol: { damage:25,  fireRate:400,  ammo:12, reserve:48,  reloadTime:1500 },
  sniper: { damage:100, fireRate:1200, ammo:5,  reserve:20,  reloadTime:3000 }
};

// Server-side hitboxes for the custom Office layout
const COVER = [
  // Top Left Desks
  { w:6,  h:2, d:5, x:-41, y:1, z:-15 },
  { w:16, h:2, d:5, x:-30, y:1, z:-15 },
  // Mid Left Desks
  { w:6,  h:2, d:5, x:-38, y:1, z:0 },
  { w:6,  h:2, d:5, x:-28, y:1, z:0 },
  // Round Table area (Box approx)
  { w:5,  h:2, d:5, x:-38, y:1, z:22 },
  // Bottom Row Desks (Left to right)
  { w:5,  h:2, d:5, x:-25, y:1, z:22 },
  { w:5,  h:2, d:5, x:-15, y:1, z:22 },
  { w:5,  h:2, d:5, x:-5,  y:1, z:22 },
  { w:5,  h:2, d:5, x:5,   y:1, z:22 },
  { w:6,  h:2, d:5, x:16,  y:1, z:22 },
  // Right Side Desks (Purple & Ohad)
  { w:5,  h:2, d:7, x:12,  y:1, z:-15 },
  { w:5,  h:2, d:7, x:12,  y:1, z:0 },
  { w:4,  h:2, d:4, x:30,  y:1, z:-25 },
  // Phone Booths
  { w:3,  h:8, d:6, x:28,  y:4, z:-5 },
  // Boardroom
  { w:0.5,h:8, d:20, x:30, y:4, z:20 }, // Glass wall West
  { w:15, h:8, d:0.5,x:37.5,y:4, z:10 }, // Glass wall North
  { w:6,  h:2, d:8, x:38,  y:1, z:20 }, // BR Table
  // Pillars
  { w:2,  h:8, d:2, x:-35, y:4, z:30 },
  { w:2,  h:8, d:2, x:-10, y:4, z:30 },
  { w:2,  h:8, d:2, x:8,   y:4, z:30 },
  { w:2,  h:8, d:2, x:27,  y:4, z:30 },
  // Outer Walls (Encloses the map 90x60)
  { w:90, h:16, d:1, x:0, y:8, z:-30 },
  { w:90, h:16, d:1, x:0, y:8, z:30 },
  { w:1, h:16, d:60, x:-45, y:8, z:0 },
  { w:1, h:16, d:60, x:45, y:8, z:0 }
];

// ── State ────────────────────────────────────────────────
let players     = {}; 
let scores      = { OJO: 0, STRIKE: 0 };
let roundActive = false;
let roundTimer  = ROUND_TIME;
let roundTick   = null;
let botInterval = null;
let killFeed    = [];

// ── Helpers ──────────────────────────────────────────────
function randSpawn(team) {
  const pts = SPAWNS[team] || SPAWNS.OJO;
  return { ...pts[Math.floor(Math.random() * pts.length)] };
}

function assignTeam() {
  const counts = { OJO: 0, STRIKE: 0 };
  Object.values(players).forEach(p => counts[p.team]++);
  return counts.OJO <= counts.STRIKE ? 'OJO' : 'STRIKE';
}

function publicPlayer(p) {
  return {
    id:p.id, name:p.name, team:p.team, skin:p.skin,
    health:p.health, alive:p.alive,
    x:p.x, y:p.y, z:p.z, rotY:p.rotY,
    kills:p.kills, deaths:p.deaths,
    weapon:p.weapon, ammo:p.ammo, reserve:p.reserve,
    isBot:p.isBot
  };
}

function allPublic() {
  const out = {};
  Object.values(players).forEach(p => { out[p.id] = publicPlayer(p); });
  return out;
}

function rayBox(ox, oy, oz, dx, dy, dz, box) {
  const eps = 1e-8;
  const minX = box.x - box.w/2, maxX = box.x + box.w/2;
  const minY = box.y - box.h/2, maxY = box.y + box.h/2;
  const minZ = box.z - box.d/2, maxZ = box.z + box.d/2;
  const ix = 1 / (Math.abs(dx) < eps ? eps : dx);
  const iy = 1 / (Math.abs(dy) < eps ? eps : dy);
  const iz = 1 / (Math.abs(dz) < eps ? eps : dz);
  const tx1 = (minX - ox) * ix, tx2 = (maxX - ox) * ix;
  const ty1 = (minY - oy) * iy, ty2 = (maxY - oy) * iy;
  const tz1 = (minZ - oz) * iz, tz2 = (maxZ - oz) * iz;
  const tmin = Math.max(Math.min(tx1,tx2), Math.min(ty1,ty2), Math.min(tz1,tz2));
  const tmax = Math.min(Math.max(tx1,tx2), Math.max(ty1,ty2), Math.max(tz1,tz2));
  return (tmax >= 0 && tmin <= tmax) ? Math.max(0, tmin) : Infinity;
}

function nearestBox(ox, oy, oz, dx, dy, dz) {
  let best = Infinity;
  COVER.forEach(b => {
    const t = rayBox(ox, oy, oz, dx, dy, dz, b);
    if (t < best) best = t;
  });
  return best;
}

// ── Round management ─────────────────────────────────────
function startRound() {
  if (roundActive) return;
  roundActive = true;
  roundTimer  = ROUND_TIME;
  killFeed    = [];

  Object.values(players).forEach(p => {
    const sp = randSpawn(p.team);
    p.health = 100; p.alive = true;
    p.x = sp.x; p.y = sp.y; p.z = sp.z;
    // Reset ammo for current weapon
    p.ammo = WEAPONS[p.weapon].ammo;
    p.reserve = WEAPONS[p.weapon].reserve;
  });

  io.emit('roundStart', { players: allPublic(), scores });

  roundTick = setInterval(() => {
    roundTimer--;
    io.emit('timerUpdate', roundTimer);
    if (roundTimer <= 0) endRound(null);
  }, 1000);
}

function endRound(winTeam) {
  if (roundTick) { clearInterval(roundTick); roundTick = null; }
  roundActive = false;

  if (winTeam) scores[winTeam]++;
  io.emit('roundEnd', { winner: winTeam || 'draw', scores });

  if (scores.OJO >= ROUNDS_TO_WIN || scores.STRIKE >= ROUNDS_TO_WIN) {
    const matchWinner = scores.OJO >= ROUNDS_TO_WIN ? 'OJO' : 'STRIKE';
    io.emit('matchOver', { winner: matchWinner });
    scores = { OJO: 0, STRIKE: 0 };
  }

  setTimeout(() => {
    if (Object.keys(players).length >= 1) startRound();
  }, 5000);
}

function checkRoundOver() {
  if (!roundActive) return;
  const ojoAlive = Object.values(players).filter(p => p.team === 'OJO' && p.alive).length;
  const strikeAlive = Object.values(players).filter(p => p.team === 'STRIKE' && p.alive).length;
  
  if (ojoAlive === 0 && strikeAlive > 0) endRound('STRIKE');
  else if (strikeAlive === 0 && ojoAlive > 0) endRound('OJO');
}

// ── Bots ────────────────────────────────────────────────
function addBots() {
  for (let i = 0; i < 4; i++) {
    const id = 'bot_' + Math.random().toString(36).slice(2, 7);
    const team = assignTeam();
    const sp = randSpawn(team);
    players[id] = {
      id, name: 'BOT', team, skin: Math.floor(Math.random()*6),
      health: 100, alive: true, x: sp.x, y: sp.y, z: sp.z, rotY: 0,
      kills: 0, deaths: 0, weapon: 'rifle', ammo: 30, reserve: 90,
      lastShot: 0, isBot: true, targetX: sp.x, targetZ: sp.z, moveTimer: 0
    };
  }
}

function tickBots() {
  const bots = Object.values(players).filter(b => b.isBot && b.alive);
  bots.forEach(bot => {
    bot.moveTimer -= 0.1;
    if (bot.moveTimer <= 0) {
      bot.targetX = (Math.random()-0.5)*60;
      bot.targetZ = (Math.random()-0.5)*60;
      bot.moveTimer = 3 + Math.random()*2;
    }
    const dx = bot.targetX - bot.x, dz = bot.targetZ - bot.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 0.5) {
      bot.x += (dx/dist)*0.3; bot.z += (dz/dist)*0.3;
      bot.rotY = Math.atan2(dx, dz);
    }
    // Bot Shooting Logic (Simplified)
    const now = Date.now();
    if (now - bot.lastShot > 1500) {
      const target = Object.values(players).find(p => p.alive && p.team !== bot.team && !p.isBot);
      if (target && Math.hypot(target.x - bot.x, target.z - bot.z) < 25) {
        bot.lastShot = now;
        io.emit('playerShot', { id: bot.id, x: bot.x, y: bot.y, z: bot.z, dx: (target.x-bot.x)/25, dy:0, dz:(target.z-bot.z)/25, skin: bot.skin });
      }
    }
    io.emit('playerMoved', { id: bot.id, x: bot.x, y: bot.y, z: bot.z, rotY: bot.rotY });
  });
}

// ── Socket Events ────────────────────────────────────────
io.on('connection', socket => {
  if (Object.keys(players).length >= MAX_PLAYERS) {
    socket.emit('serverFull');
    return socket.disconnect();
  }

  socket.on('join', ({ name, skin, withBots }) => {
    const team = assignTeam();
    const sp = randSpawn(team);
    players[socket.id] = {
      id: socket.id, name: name || 'Player', team, skin: skin || 0,
      health: 100, alive: true, x: sp.x, y: sp.y, z: sp.z, rotY: 0,
      kills: 0, deaths: 0, weapon: 'rifle', ammo: 30, reserve: 90, lastShot: 0,
      inventory: { 
        rifle: { ammo: 30, reserve: 90 }, 
        pistol: { ammo: 12, reserve: 48 }, 
        sniper: { ammo: 5, reserve: 20 } 
      }
    };

    if (withBots && !botInterval) {
      addBots();
      botInterval = setInterval(tickBots, 100);
    }

    socket.emit('joined', { id: socket.id, player: publicPlayer(players[socket.id]), scores, roundActive, roundTimer });
    io.emit('playerList', allPublic());
    if (!roundActive) startRound();
  });

  socket.on('move', (data) => {
    const p = players[socket.id];
    if (p && p.alive) {
      Object.assign(p, data);
      socket.broadcast.emit('playerMoved', { id: socket.id, ...data });
    }
  });

  socket.on('shoot', ({ dirX, dirY, dirZ }) => {
    const p = players[socket.id];
    if (!p || !p.alive || p.ammo <= 0) return;
    const wep = WEAPONS[p.weapon];
    const now = Date.now();
    if (now - p.lastShot < wep.fireRate) return;

    p.lastShot = now; p.ammo--;
    p.inventory[p.weapon].ammo = p.ammo;
    socket.emit('ammoUpdate', { ammo: p.ammo, reserve: p.reserve });
    socket.broadcast.emit('playerShot', { id: socket.id, x: p.x, y: p.y, z: p.z, dx: dirX, dy: dirY, dz: dirZ, skin: p.skin });

    const ox = p.x, oy = p.y + 1.5, oz = p.z;
    const bDist = nearestBox(ox, oy, oz, dirX, dirY, dirZ);
    let hitP = null, minDist = Infinity;

    Object.values(players).forEach(t => {
      if (t.id === socket.id || !t.alive) return;
      const dx = t.x - ox, dy = (t.y + 1) - oy, dz = t.z - oz;
      const dot = dx*dirX + dy*dirY + dz*dirZ;
      if (dot < 0 || dot > bDist) return;
      const perpX = ox + dirX*dot - t.x, perpY = oy + dirY*dot - (t.y+1), perpZ = oz + dirZ*dot - t.z;
      if (perpX*perpX + perpY*perpY + perpZ*perpZ < 0.8 && dot < minDist) {
        minDist = dot; hitP = t;
      }
    });

    if (hitP) {
      hitP.health -= wep.damage;
      io.emit('playerHit', { id: hitP.id, health: hitP.health });
      if (hitP.health <= 0) {
        hitP.alive = false; hitP.deaths++; p.kills++;
        killFeed.unshift({ killer: p.name, victim: hitP.name, weapon: p.weapon });
        io.emit('playerKilled', { id: hitP.id, killFeed });
        io.emit('scoreUpdate', allPublic());
        checkRoundOver();
        setTimeout(() => {
          if (!players[hitP.id]) return;
          const sp = randSpawn(hitP.team);
          hitP.health = 100; hitP.alive = true; hitP.x = sp.x; hitP.z = sp.z;
          io.emit('playerRespawned', { id: hitP.id, ...sp });
        }, RESPAWN_WAIT*1000);
      }
    }
  });

  socket.on('reload', () => {
    const p = players[socket.id];
    if (!p || !p.alive) return;
    const wep = WEAPONS[p.weapon];
    setTimeout(() => {
        if (!players[socket.id]) return;
        const take = Math.min(wep.ammo - p.ammo, p.reserve);
        p.ammo += take; p.reserve -= take;
        p.inventory[p.weapon].ammo = p.ammo;
        p.inventory[p.weapon].reserve = p.reserve;
        socket.emit('ammoUpdate', { ammo: p.ammo, reserve: p.reserve });
    }, wep.reloadTime);
  });

  socket.on('switchWeapon', ({ weapon }) => {
    const p = players[socket.id];
    if (p && WEAPONS[weapon]) {
      p.weapon = weapon;
      p.ammo = p.inventory[weapon].ammo;
      p.reserve = p.inventory[weapon].reserve;
      socket.emit('ammoUpdate', { ammo: p.ammo, reserve: p.reserve });
    }
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    if (Object.values(players).filter(p => !p.isBot).length === 0) {
      if (botInterval) clearInterval(botInterval);
      botInterval = null;
      players = {};
    }
    io.emit('playerList', allPublic());
  });
});

server.listen(PORT, () => console.log('OJO Strike on port ' + PORT));
