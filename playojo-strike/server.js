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

// Serve static files from /public
app.use(express.static(path.join(__dirname, 'public')));

// Image proxy — fetches external images server-side (no CORS)
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

// Fallback: serve index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Config ───────────────────────────────────────────────
const MAX_PLAYERS  = 8;
const ROUND_TIME   = 120;
const RESPAWN_WAIT = 5;
const ROUNDS_TO_WIN= 5;

const TEAMS = ['OJO', 'STRIKE'];

const SPAWNS = {
  OJO:    [{ x:-18,y:0,z:-18 },{ x:-15,y:0,z:-18 },{ x:-18,y:0,z:-15 },{ x:-12,y:0,z:-18 }],
  STRIKE: [{ x: 18,y:0,z: 18 },{ x: 15,y:0,z: 18 },{ x: 18,y:0,z: 15 },{ x: 12,y:0,z: 18 }]
};

const WEAPONS = {
  rifle:  { damage:30,  fireRate:150,  ammo:30, reserve:90,  reloadTime:2000 },
  pistol: { damage:25,  fireRate:400,  ammo:12, reserve:48,  reloadTime:1500 },
  sniper: { damage:100, fireRate:1200, ammo:5,  reserve:20,  reloadTime:3000 }
};

// Cover boxes — must match client COVER array
const COVER = [
  { w:4,  h:2,   d:4,  x:-8,  y:1,    z:0   },
  { w:4,  h:2,   d:4,  x: 8,  y:1,    z:0   },
  { w:2,  h:3,   d:8,  x: 0,  y:1.5,  z:-10 },
  { w:2,  h:3,   d:8,  x: 0,  y:1.5,  z: 10 },
  { w:8,  h:1.5, d:2,  x:-12, y:0.75, z:-6  },
  { w:8,  h:1.5, d:2,  x: 12, y:0.75, z: 6  },
  { w:3,  h:4,   d:3,  x:-15, y:2,    z:-5  },
  { w:3,  h:4,   d:3,  x: 15, y:2,    z: 5  },
  { w:2,  h:2,   d:10, x:-5,  y:1,    z:-18 },
  { w:2,  h:2,   d:10, x: 5,  y:1,    z: 18 }
];

// ── State ────────────────────────────────────────────────
let players    = {};   // id -> player object
let scores     = { OJO: 0, STRIKE: 0 };
let roundActive= false;
let roundTimer = ROUND_TIME;
let roundTick  = null;
let killFeed   = [];

// ── Helpers ──────────────────────────────────────────────
function randSpawn(team) {
  const pts = SPAWNS[team];
  return { ...pts[Math.floor(Math.random() * pts.length)] };
}

function assignTeam() {
  const ojoCount    = Object.values(players).filter(p => p.team === 'OJO').length;
  const strikeCount = Object.values(players).filter(p => p.team === 'STRIKE').length;
  return ojoCount <= strikeCount ? 'OJO' : 'STRIKE';
}

function publicPlayer(p) {
  return {
    id:p.id, name:p.name, team:p.team, skin:p.skin||0,
    health:p.health, alive:p.alive,
    x:p.x, y:p.y, z:p.z, rotY:p.rotY,
    kills:p.kills, deaths:p.deaths,
    weapon:p.weapon, ammo:p.ammo, reserve:p.reserve,
    isBot:p.isBot||false
  };
}

function allPublic() {
  const out = {};
  Object.values(players).forEach(p => { out[p.id] = publicPlayer(p); });
  return out;
}

// Ray vs AABB slab test — returns hit distance or Infinity
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
  roundActive = true;
  roundTimer  = ROUND_TIME;
  killFeed    = [];

  Object.values(players).forEach(p => {
    const sp = randSpawn(p.team);
    p.health = 100; p.alive = true;
    p.x = sp.x; p.y = sp.y; p.z = sp.z;
    p.ammo    = WEAPONS[p.weapon].ammo;
    p.reserve = WEAPONS[p.weapon].reserve;
  });

  io.emit('roundStart', { players: allPublic(), scores });
  console.log('Round started');

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
  console.log('Round ended. Winner:', winTeam || 'draw');

  if (scores.OJO >= ROUNDS_TO_WIN || scores.STRIKE >= ROUNDS_TO_WIN) {
    const matchWinner = scores.OJO >= ROUNDS_TO_WIN ? 'OJO' : 'STRIKE';
    io.emit('matchOver', { winner: matchWinner, scores });
    scores = { OJO: 0, STRIKE: 0 };
  }

  setTimeout(() => {
    if (Object.keys(players).length >= 1) startRound();
  }, 5000);
}

function checkRoundOver() {
  if (!roundActive) return;
  const ojoPlayers    = Object.values(players).filter(p => p.team === 'OJO');
  const strikePlayers = Object.values(players).filter(p => p.team === 'STRIKE');
  if (ojoPlayers.length === 0 || strikePlayers.length === 0) return;
  const ojoAlive    = ojoPlayers.filter(p => p.alive).length;
  const strikeAlive = strikePlayers.filter(p => p.alive).length;
  if (ojoAlive === 0)    endRound('STRIKE');
  else if (strikeAlive === 0) endRound('OJO');
}

// ── Bot config ───────────────────────────────────────────
const BOT_COUNT     = 4;   // bots added when player requests them
const BOT_SPEED     = 4;
const BOT_SHOOT_RANGE = 20;
const BOT_SHOOT_RATE  = 1200; // ms between shots
let   botInterval   = null;

function makeBotId() { return 'bot_' + Math.random().toString(36).slice(2, 7); }

function addBots() {
  for (let i = 0; i < BOT_COUNT; i++) {
    const id   = makeBotId();
    const team = assignTeam();
    const sp   = randSpawn(team);
    players[id] = {
      id, name: 'BOT', team,
      health: 100, alive: true,
      x: sp.x, y: sp.y, z: sp.z, rotY: 0,
      kills: 0, deaths: 0,
      weapon: 'rifle',
      ammo:    WEAPONS.rifle.ammo,
      reserve: WEAPONS.rifle.reserve,
      lastShot: 0,
      isBot: true,
      targetX: sp.x, targetZ: sp.z,
      moveTimer: 0
    };
  }
  io.emit('playerList', allPublic());
}

function removeBots() {
  Object.keys(players).forEach(id => { if (players[id].isBot) delete players[id]; });
  io.emit('playerList', allPublic());
}

function tickBots() {
  const botList = Object.values(players).filter(b => b.isBot && b.alive);
  if (!botList.length) return;

  const dt = 0.1; // called every 100ms

  botList.forEach(bot => {
    // Pick new random waypoint every few seconds
    bot.moveTimer -= dt;
    if (bot.moveTimer <= 0 || (Math.abs(bot.x - bot.targetX) < 1 && Math.abs(bot.z - bot.targetZ) < 1)) {
      bot.targetX  = (Math.random() - 0.5) * 70;
      bot.targetZ  = (Math.random() - 0.5) * 70;
      bot.moveTimer = 2 + Math.random() * 3;
    }

    // Move toward waypoint
    const dx = bot.targetX - bot.x;
    const dz = bot.targetZ - bot.z;
    const dist = Math.sqrt(dx*dx + dz*dz);
    if (dist > 0.5) {
      bot.x += (dx / dist) * BOT_SPEED * dt;
      bot.z += (dz / dist) * BOT_SPEED * dt;
      bot.rotY = Math.atan2(dx, dz);
    }

    // Clamp to arena
    bot.x = Math.max(-38, Math.min(38, bot.x));
    bot.z = Math.max(-38, Math.min(38, bot.z));

    // Find nearest enemy to shoot
    const now = Date.now();
    if (now - bot.lastShot >= BOT_SHOOT_RATE) {
      const enemies = Object.values(players).filter(p =>
        p.id !== bot.id && p.alive && p.team !== bot.team && !p.isBot
      );
      if (enemies.length) {
        // Pick closest
        let target = null, minD = Infinity;
        enemies.forEach(e => {
          const d = Math.hypot(e.x - bot.x, e.z - bot.z);
          if (d < minD) { minD = d; target = e; }
        });
        if (target && minD < BOT_SHOOT_RANGE) {
          bot.lastShot = now;
          if (bot.ammo <= 0) {
            bot.ammo = WEAPONS.rifle.ammo; // bots auto-reload
          }

          const ox = bot.x, oy = bot.y + 0.8, oz = bot.z;
          const tdx = target.x - ox, tdy = (target.y + 0.8) - oy, tdz = target.z - oz;
          const len = Math.sqrt(tdx*tdx + tdy*tdy + tdz*tdz);
          const dirX = tdx/len, dirY = tdy/len, dirZ = tdz/len;

          // Add some inaccuracy
          const spread = 0.08;
          const fDirX = dirX + (Math.random()-0.5)*spread;
          const fDirY = dirY + (Math.random()-0.5)*spread*0.3;
          const fDirZ = dirZ + (Math.random()-0.5)*spread;

          bot.ammo--;

          // Broadcast bot laser
          io.emit('playerShot', { id: bot.id, team: bot.team, x: ox, y: bot.y, z: oz, dx: fDirX, dy: fDirY, dz: fDirZ });

          // Check hit (simplified — no box occlusion for bots to keep it fair)
          const boxDist = nearestBox(ox, oy, oz, fDirX, fDirY, fDirZ);
          const ex = target.x - ox, ey = (target.y+0.8) - oy, ez = target.z - oz;
          const dot = ex*fDirX + ey*fDirY + ez*fDirZ;
          if (dot > 0 && dot < boxDist) {
            const cx = ox+fDirX*dot - target.x;
            const cy = oy+fDirY*dot - (target.y+0.8);
            const cz = oz+fDirZ*dot - target.z;
            if (cx*cx+cy*cy+cz*cz < 0.9) {
              target.health -= WEAPONS.rifle.damage;
              io.emit('playerHit', { id: target.id, health: target.health, shooterId: bot.id });
              if (target.health <= 0) {
                target.alive  = false;
                target.deaths++;
                bot.kills++;
                killFeed.unshift({ killer: 'BOT', victim: target.name, weapon: 'rifle' });
                if (killFeed.length > 5) killFeed.pop();
                io.emit('playerKilled', { id: target.id, killerId: bot.id, killerName: 'BOT', victimName: target.name, killFeed });
                io.emit('scoreUpdate', allPublic());
                checkRoundOver();
                const deadId = target.id;
                setTimeout(() => {
                  const dp = players[deadId];
                  if (!dp) return;
                  const sp = randSpawn(dp.team);
                  dp.health = 100; dp.alive = true;
                  dp.x = sp.x; dp.y = sp.y; dp.z = sp.z;
                  io.emit('playerRespawned', { id: deadId, x: sp.x, y: sp.y, z: sp.z });
                }, RESPAWN_WAIT * 1000);
              }
            }
          }
        }
      }
    }

    // Broadcast bot position
    io.emit('playerMoved', { id: bot.id, x: bot.x, y: bot.y, z: bot.z, rotY: bot.rotY });
  });
}


io.on('connection', socket => {
  console.log('Connected:', socket.id);

  if (Object.keys(players).length >= MAX_PLAYERS) {
    socket.emit('serverFull');
    socket.disconnect(true);
    return;
  }

  // ── join ──
  socket.on('join', ({ name }) => {
    const team = assignTeam();
    const sp   = randSpawn(team);
    const wep  = 'rifle';

    players[socket.id] = {
      id: socket.id,
      name: name || 'Player',
      team,
      health: 100,
      alive: true,
      x: sp.x, y: sp.y, z: sp.z,
      rotY: 0,
      kills: 0, deaths: 0,
      weapon: wep,
      ammo:    WEAPONS[wep].ammo,
      reserve: WEAPONS[wep].reserve,
      lastShot: 0
    };

    console.log(name, 'joined team', team);

    // Send confirmation back to THIS player
    socket.emit('joined', {
      id: socket.id,
      player: publicPlayer(players[socket.id]),
      scores,
      roundActive,
      roundTimer
    });

    // Tell everyone the updated player list
    io.emit('playerList', allPublic());

    // Start round if enough players and no round running
    if (!roundActive && Object.keys(players).length >= 1) {
      startRound();
    }
  });

  // ── move ──
  socket.on('move', ({ x, y, z, rotY }) => {
    const p = players[socket.id];
    if (!p) return;
    p.x = x; p.y = y; p.z = z; p.rotY = rotY;
    socket.broadcast.emit('playerMoved', { id: socket.id, x, y, z, rotY });
  });

  // ── shoot ──
  socket.on('shoot', ({ dirX, dirY, dirZ }) => {
    const shooter = players[socket.id];
    if (!shooter || !shooter.alive) return;

    const wep = WEAPONS[shooter.weapon];
    const now = Date.now();
    if (now - shooter.lastShot < wep.fireRate) return;
    if (shooter.ammo <= 0) { socket.emit('noAmmo'); return; }

    shooter.lastShot = now;
    shooter.ammo--;
    socket.emit('ammoUpdate', { ammo: shooter.ammo, reserve: shooter.reserve });

    // Broadcast laser to other players
    socket.broadcast.emit('playerShot', {
      id: socket.id, team: shooter.team,
      x: shooter.x, y: shooter.y, z: shooter.z,
      dx: dirX, dy: dirY, dz: dirZ
    });

    const ox = shooter.x, oy = shooter.y + 0.8, oz = shooter.z;
    const boxDist = nearestBox(ox, oy, oz, dirX, dirY, dirZ);
    let hit = null, minDist = Infinity;

    // FFA — everyone is a valid target except yourself
    Object.values(players).forEach(target => {
      if (target.id === socket.id) return;  // can't shoot yourself
      if (!target.alive) return;

      const dx = target.x - ox;
      const dy = (target.y + 0.8) - oy;
      const dz = target.z - oz;
      const dot = dx * dirX + dy * dirY + dz * dirZ;
      if (dot < 0 || dot >= boxDist) return; // box blocks

      const cx = ox + dirX * dot - target.x;
      const cy = oy + dirY * dot - (target.y + 0.8);
      const cz = oz + dirZ * dot - target.z;
      const distSq = cx*cx + cy*cy + cz*cz;
      if (distSq < 0.7 && dot < minDist) { minDist = dot; hit = target; }
    });

    if (hit) {
      hit.health -= wep.damage;
      io.emit('playerHit', { id: hit.id, health: hit.health, shooterId: socket.id });

      if (hit.health <= 0) {
        hit.alive  = false;
        hit.deaths++;
        shooter.kills++;

        killFeed.unshift({ killer: shooter.name, victim: hit.name, weapon: shooter.weapon });
        if (killFeed.length > 5) killFeed.pop();

        io.emit('playerKilled', {
          id: hit.id,
          killerId: socket.id,
          killerName: shooter.name,
          victimName: hit.name,
          killFeed
        });
        io.emit('scoreUpdate', allPublic());
        checkRoundOver();

        const deadId = hit.id;
        setTimeout(() => {
          const dp = players[deadId];
          if (!dp) return;
          const sp = randSpawn(dp.team);
          dp.health = 100; dp.alive = true;
          dp.x = sp.x; dp.y = sp.y; dp.z = sp.z;
          dp.ammo    = WEAPONS[dp.weapon].ammo;
          dp.reserve = WEAPONS[dp.weapon].reserve;
          io.emit('playerRespawned', { id: deadId, x: sp.x, y: sp.y, z: sp.z });
        }, RESPAWN_WAIT * 1000);
      }
    }
  });

  // ── reload ──
  socket.on('reload', () => {
    const p = players[socket.id];
    if (!p || !p.alive) return;
    const wep    = WEAPONS[p.weapon];
    const needed = wep.ammo - p.ammo;
    const take   = Math.min(needed, p.reserve);
    p.ammo    += take;
    p.reserve -= take;
    socket.emit('ammoUpdate', { ammo: p.ammo, reserve: p.reserve });
  });

  // ── switch weapon ──
  socket.on('switchWeapon', ({ weapon }) => {
    const p = players[socket.id];
    if (!p || !WEAPONS[weapon]) return;
    p.weapon  = weapon;
    p.ammo    = WEAPONS[weapon].ammo;
    p.reserve = WEAPONS[weapon].reserve;
    socket.emit('ammoUpdate', { ammo: p.ammo, reserve: p.reserve });
    socket.broadcast.emit('weaponSwitch', { id: socket.id, weapon });
  });

  // ── disconnect ──
  socket.on('disconnect', () => {
    const p = players[socket.id];
    if (p) console.log(p.name, 'disconnected');
    delete players[socket.id];
    // If no humans left, remove bots and stop bot tick
    const humans = Object.values(players).filter(p => !p.isBot);
    if (humans.length === 0) {
      removeBots();
      if (botInterval) { clearInterval(botInterval); botInterval = null; }
    }
    io.emit('playerList', allPublic());
    checkRoundOver();
  });
});

// ── Start server ─────────────────────────────────────────
server.listen(PORT, () => {
  console.log('');
  console.log('  PlayOJO Strike server running');
  console.log('  Local:   http://localhost:' + PORT);
  console.log('');
});
