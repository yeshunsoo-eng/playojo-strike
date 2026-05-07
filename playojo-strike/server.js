// PlayOJO Strike — Game Server
// Run with: node server.js
// Requires: npm install express socket.io

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, 'public')));

// ── Config ──────────────────────────────────────────────────────────────────
const CONFIG = {
  maxPlayers: 8,
  roundTime: 120,        // seconds
  respawnDelay: 5,       // seconds
  roundsToWin: 5,
  teams: ['OJO', 'STRIKE'],
  spawnPoints: {
    OJO: [
      { x: -18, y: 1, z: -18 }, { x: -15, y: 1, z: -18 },
      { x: -18, y: 1, z: -15 }, { x: -12, y: 1, z: -18 }
    ],
    STRIKE: [
      { x: 18, y: 1, z: 18 }, { x: 15, y: 1, z: 18 },
      { x: 18, y: 1, z: 15 }, { x: 12, y: 1, z: 18 }
    ]
  },
  weapons: {
    rifle:  { damage: 30, fireRate: 150, ammo: 30, reserve: 90, reloadTime: 2000, auto: true  },
    pistol: { damage: 25, fireRate: 400, ammo: 12, reserve: 48, reloadTime: 1500, auto: false },
    sniper: { damage: 100,fireRate: 1200,ammo: 5,  reserve: 20, reloadTime: 3000, auto: false }
  }
};

// ── State ───────────────────────────────────────────────────────────────────
let players = {};
let roundTimer = CONFIG.roundTime;
let roundActive = false;
let scores = { OJO: 0, STRIKE: 0 };
let roundInterval = null;
let killFeed = [];

function getSpawn(team) {
  const pts = CONFIG.spawnPoints[team];
  return pts[Math.floor(Math.random() * pts.length)];
}

function assignTeam() {
  const ojoCount   = Object.values(players).filter(p => p.team === 'OJO').length;
  const strikeCount= Object.values(players).filter(p => p.team === 'STRIKE').length;
  return ojoCount <= strikeCount ? 'OJO' : 'STRIKE';
}

function startRound() {
  roundActive = true;
  roundTimer = CONFIG.roundTime;
  killFeed = [];
  // Respawn everyone
  Object.values(players).forEach(p => {
    p.health = 100;
    p.alive = true;
    const sp = getSpawn(p.team);
    p.x = sp.x; p.y = sp.y; p.z = sp.z;
    p.ammo = CONFIG.weapons[p.weapon].ammo;
    p.reserve = CONFIG.weapons[p.weapon].reserve;
  });
  io.emit('roundStart', { players: sanitisePlayers(), scores });
  roundInterval = setInterval(tickRound, 1000);
}

function tickRound() {
  roundTimer--;
  io.emit('timerUpdate', roundTimer);
  if (roundTimer <= 0) endRound(null);
}

function endRound(winTeam) {
  clearInterval(roundInterval);
  roundActive = false;
  if (winTeam) {
    scores[winTeam]++;
    io.emit('roundEnd', { winner: winTeam, scores });
  } else {
    io.emit('roundEnd', { winner: 'draw', scores });
  }
  // Check match win
  if (scores.OJO >= CONFIG.roundsToWin || scores.STRIKE >= CONFIG.roundsToWin) {
    const matchWinner = scores.OJO >= CONFIG.roundsToWin ? 'OJO' : 'STRIKE';
    io.emit('matchOver', { winner: matchWinner, scores });
    scores = { OJO: 0, STRIKE: 0 };
  }
  setTimeout(startRound, 5000);
}

function checkRoundOver() {
  const ojoAlive    = Object.values(players).filter(p => p.team === 'OJO'    && p.alive).length;
  const strikeAlive = Object.values(players).filter(p => p.team === 'STRIKE' && p.alive).length;
  const ojoTotal    = Object.values(players).filter(p => p.team === 'OJO').length;
  const strikeTotal = Object.values(players).filter(p => p.team === 'STRIKE').length;
  if (ojoTotal === 0 || strikeTotal === 0) return;
  if (ojoAlive === 0)    { endRound('STRIKE'); return; }
  if (strikeAlive === 0) { endRound('OJO');    return; }
}

function sanitisePlayers() {
  return Object.fromEntries(
    Object.entries(players).map(([id, p]) => [id, {
      id, name: p.name, team: p.team, health: p.health, alive: p.alive,
      x: p.x, y: p.y, z: p.z, rotY: p.rotY, kills: p.kills, deaths: p.deaths,
      weapon: p.weapon, ammo: p.ammo, reserve: p.reserve
    }])
  );
}

// ── Socket events ────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('Player connected:', socket.id);

  if (Object.keys(players).length >= CONFIG.maxPlayers) {
    socket.emit('serverFull');
    socket.disconnect();
    return;
  }

  socket.on('join', ({ name }) => {
    const team = assignTeam();
    const sp   = getSpawn(team);
    players[socket.id] = {
      id: socket.id, name: name || 'OJO Player', team,
      health: 100, alive: true,
      x: sp.x, y: sp.y, z: sp.z, rotY: 0,
      kills: 0, deaths: 0,
      weapon: 'rifle',
      ammo: CONFIG.weapons.rifle.ammo,
      reserve: CONFIG.weapons.rifle.reserve,
      lastShot: 0
    };
    socket.emit('joined', {
      id: socket.id,
      player: players[socket.id],
      config: CONFIG,
      scores,
      roundActive,
      roundTimer
    });
    io.emit('playerList', sanitisePlayers());
    console.log(`${name} joined team ${team}`);
    if (!roundActive && Object.keys(players).length >= 2) startRound();
  });

  socket.on('move', ({ x, y, z, rotY }) => {
    const p = players[socket.id];
    if (!p || !p.alive) return;
    p.x = x; p.y = y; p.z = z; p.rotY = rotY;
    socket.broadcast.emit('playerMoved', { id: socket.id, x, y, z, rotY });
  });

  socket.on('shoot', ({ dirX, dirY, dirZ }) => {
    const shooter = players[socket.id];
    if (!shooter || !shooter.alive || !roundActive) return;
    const now = Date.now();
    const wep = CONFIG.weapons[shooter.weapon];
    if (now - shooter.lastShot < wep.fireRate) return;
    if (shooter.ammo <= 0) { socket.emit('noAmmo'); return; }
    shooter.lastShot = now;
    shooter.ammo--;
    socket.emit('ammoUpdate', { ammo: shooter.ammo, reserve: shooter.reserve });

    // Broadcast muzzle flash to others
    socket.broadcast.emit('playerShot', { id: socket.id });

    // Raycast hit detection (server-authoritative, simplified sphere check)
    const ox = shooter.x, oy = shooter.y + 0.8, oz = shooter.z;
    let hit = null, minT = Infinity;
    Object.values(players).forEach(target => {
      if (target.id === socket.id || !target.alive || target.team === shooter.team) return;
      // Sphere radius ~0.5, check ray-sphere intersection
      const dx = target.x - ox, dy = (target.y + 0.8) - oy, dz = target.z - oz;
      const dot = dx * dirX + dy * dirY + dz * dirZ;
      if (dot < 0) return;
      const cx = ox + dirX * dot - target.x;
      const cy = oy + dirY * dot - (target.y + 0.8);
      const cz = oz + dirZ * dot - target.z;
      const distSq = cx * cx + cy * cy + cz * cz;
      if (distSq < 0.6 && dot < minT) { minT = dot; hit = target; }
    });

    if (hit) {
      hit.health -= wep.damage;
      io.emit('playerHit', { id: hit.id, health: hit.health, shooterId: socket.id });
      if (hit.health <= 0) {
        hit.alive = false;
        hit.deaths++;
        shooter.kills++;
        const feedEntry = { killer: shooter.name, victim: hit.name, weapon: shooter.weapon, time: Date.now() };
        killFeed.unshift(feedEntry);
        if (killFeed.length > 5) killFeed.pop();
        io.emit('playerKilled', { id: hit.id, killerId: socket.id, killerName: shooter.name, victimName: hit.name, killFeed });
        io.emit('scoreUpdate', sanitisePlayers());
        checkRoundOver();
        // Respawn after delay
        setTimeout(() => {
          if (!players[hit.id]) return;
          const sp = getSpawn(hit.team);
          hit.health = 100; hit.alive = true;
          hit.x = sp.x; hit.y = sp.y; hit.z = sp.z;
          hit.ammo = CONFIG.weapons[hit.weapon].ammo;
          io.emit('playerRespawned', { id: hit.id, x: sp.x, y: sp.y, z: sp.z });
        }, CONFIG.respawnDelay * 1000);
      }
    }
  });

  socket.on('reload', () => {
    const p = players[socket.id];
    if (!p || !p.alive) return;
    const wep = CONFIG.weapons[p.weapon];
    const needed = wep.ammo - p.ammo;
    const take = Math.min(needed, p.reserve);
    p.ammo += take; p.reserve -= take;
    socket.emit('ammoUpdate', { ammo: p.ammo, reserve: p.reserve });
  });

  socket.on('switchWeapon', ({ weapon }) => {
    const p = players[socket.id];
    if (!p || !CONFIG.weapons[weapon]) return;
    p.weapon = weapon;
    p.ammo = CONFIG.weapons[weapon].ammo;
    p.reserve = CONFIG.weapons[weapon].reserve;
    socket.emit('ammoUpdate', { ammo: p.ammo, reserve: p.reserve });
    socket.broadcast.emit('weaponSwitch', { id: socket.id, weapon });
  });

  socket.on('disconnect', () => {
    const p = players[socket.id];
    if (p) { console.log(`${p.name} disconnected`); delete players[socket.id]; }
    io.emit('playerList', sanitisePlayers());
    checkRoundOver();
  });
});

server.listen(PORT, () => console.log(`\n🎮 PlayOJO Strike server running on http://localhost:${PORT}\n`));
