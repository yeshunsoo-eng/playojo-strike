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

// Image proxy for cross-origin images (if needed)
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
const MAX_PLAYERS  = 12;
const ROUND_TIME   = 180; // 3 minute rounds
const RESPAWN_WAIT = 3;

// FFA Spawn Points (Extreme corners and edges, away from the center 'X' block)
const SPAWNS = [
  { x: -40, y: 0, z: -25 }, // Top-Left corner
  { x:  40, y: 0, z: -25 }, // Top-Right corner
  { x: -40, y: 0, z:  25 }, // Bottom-Left corner
  { x:  40, y: 0, z:  25 }, // Bottom-Right corner
  { x: -40, y: 0, z:   0 }, // Mid-Left edge
  { x:  40, y: 0, z:   0 }, // Mid-Right edge
  { x:  10, y: 0, z: -25 }, // Top-Mid edge
  { x: -10, y: 0, z:  25 }  // Bottom-Mid edge
];

const WEAPONS = {
  rifle:  { damage: 30,  fireRate: 150,  ammo: 30, reserve: 90,  reloadTime: 2000 },
  pistol: { damage: 25,  fireRate: 400,  ammo: 12, reserve: 48,  reloadTime: 1500 },
  sniper: { damage: 100, fireRate: 1200, ammo: 5,  reserve: 20,  reloadTime: 3000 }
};

// ── NEW MAP HITBOXES (Matches the HTML layout perfectly) ──
const COVER = [
  // CENTRAL CORE ('X' BLOCK)
  { w: 20, h: 16, d: 24, x: -8, y: 8, z: -2 },

  // Top Left Desks
  { w: 6,  h: 2, d: 5, x: -41, y: 1, z: -15 },
  { w: 16, h: 2, d: 5, x: -30, y: 1, z: -15 },
  
  // Mid Left Desks
  { w: 6,  h: 2, d: 5, x: -38, y: 1, z: 0 },
  { w: 6,  h: 2, d: 5, x: -28, y: 1, z: 0 },
  
  // Round Table area (Box approx)
  { w: 5,  h: 2, d: 5, x: -38, y: 1, z: 22 },
  
  // Bottom Row Desks (Left to right)
  { w: 5,  h: 2, d: 5, x: -25, y: 1, z: 22 },
  { w: 5,  h: 2, d: 5, x: -15, y: 1, z: 22 },
  { w: 5,  h: 2, d: 5, x: -5,  y: 1, z: 22 },
  { w: 5,  h: 2, d: 5, x: 5,   y: 1, z: 22 },
  { w: 6,  h: 2, d: 5, x: 16,  y: 1, z: 22 },
  
  // Right Side Desks (Purple & Ohad)
  { w: 5,  h: 2, d: 7, x: 12,  y: 1, z: -15 },
  { w: 5,  h: 2, d: 7, x: 12,  y: 1, z: 0 },
  { w: 4,  h: 2, d: 4, x: 30,  y: 1, z: -25 },
  
  // Phone Booths & Boardroom
  { w: 3,   h: 8, d: 6,   x: 28,   y: 4, z: -5 },
  { w: 0.5, h: 8, d: 20,  x: 30,   y: 4, z: 20 }, // Glass wall West
  { w: 15,  h: 8, d: 0.5, x: 37.5, y: 4, z: 10 }, // Glass wall North
  { w: 6,   h: 2, d: 8,   x: 38,   y: 1, z: 20 }, // BR Table
  
  // Pillars
  { w: 2, h: 8, d: 2, x: -35, y: 4, z: 30 },
  { w: 2, h: 8, d: 2, x: -10, y: 4, z: 30 },
  { w: 2, h: 8, d: 2, x: 8,   y: 4, z: 30 },
  { w: 2, h: 8, d: 2, x: 27,  y: 4, z: 30 },
  
  // Outer Walls (Encloses the map 90x60)
  { w: 90, h: 16, d: 1,  x: 0,   y: 8, z: -30 },
  { w: 90, h: 16, d: 1,  x: 0,   y: 8, z: 30 },
  { w: 1,  h: 16, d: 60, x: -45, y: 8, z: 0 },
  { w: 1,  h: 16, d: 60, x: 45,  y: 8, z: 0 }
];

// ── State ────────────────────────────────────────────────
let players     = {}; 
let roundActive = false;
let roundTimer  = ROUND_TIME;
let roundTick   = null;
let botInterval = null;
let killFeed    = [];

// ── Helpers ──────────────────────────────────────────────
function randSpawn() {
  return { ...SPAWNS[Math.floor(Math.random() * SPAWNS.length)] };
}

function publicPlayer(p) {
  return {
    id: p.id, name: p.name, skin: p.skin,
    health: p.health, alive: p.alive,
    x: p.x, y: p.y, z: p.z, rotY: p.rotY,
    kills: p.kills, deaths: p.deaths,
    weapon: p.weapon, ammo: p.ammo, reserve: p.reserve,
    isBot: p.isBot
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

  // Reset all players for new round
  Object.values(players).forEach(p => {
    const sp = randSpawn();
    p.health = 100; p.alive = true;
    p.x = sp.x; p.y = sp.y; p.z = sp.z;
    p.kills = 0; p.deaths = 0;
    
    // Reset inventory
    p.inventory = { 
      rifle:  { ammo: WEAPONS.rifle.ammo,  reserve: WEAPONS.rifle.reserve }, 
      pistol: { ammo: WEAPONS.pistol.ammo, reserve: WEAPONS.pistol.reserve }, 
      sniper: { ammo: WEAPONS.sniper.ammo, reserve: WEAPONS.sniper.reserve } 
    };
    p.ammo = p.inventory[p.weapon].ammo;
    p.reserve = p.inventory[p.weapon].reserve;
  });

  io.emit('roundStart', { players: allPublic() });

  roundTick = setInterval(() => {
    roundTimer--;
    io.emit('timerUpdate', roundTimer);
    
    if (roundTimer <= 0) {
      endRound();
    }
  }, 1000);
}

function endRound() {
  if (roundTick) { clearInterval(roundTick); roundTick = null; }
  roundActive = false;

  // Find the winner (highest kills)
  let winnerName = "NOBODY";
  let highestKills = -1;
  Object.values(players).forEach(p => {
    if (p.kills > highestKills) {
      highestKills = p.kills;
      winnerName = p.name;
    }
  });

  // Tell clients the round is over
  io.emit('matchOver', { winner: winnerName });

  // Wait 5 seconds, then restart
  setTimeout(() => {
    if (Object.keys(players).length > 0) startRound();
  }, 5000);
}

// ── Bots ────────────────────────────────────────────────
function addBots() {
  const names = ['BOT_Alpha', 'BOT_Bravo', 'BOT_Charlie', 'BOT_Delta'];
  for (let i = 0; i < 4; i++) {
    const id = 'bot_' + Math.random().toString(36).slice(2, 7);
    const sp = randSpawn();
    players[id] = {
      id, name: names[i], skin: Math.floor(Math.random()*6),
      health: 100, alive: true, x: sp.x, y: sp.y, z: sp.z, rotY: 0,
      kills: 0, deaths: 0, weapon: 'rifle', ammo: 30, reserve: 90,
      lastShot: 0, isBot: true, targetX: sp.x, targetZ: sp.z, moveTimer: 0
    };
  }
}

function tickBots() {
  if (!roundActive) return;
  const bots = Object.values(players).filter(b => b.isBot && b.alive);
  
  bots.forEach(bot => {
    bot.moveTimer -= 0.1;
    if (bot.moveTimer <= 0) {
      bot.targetX = (Math.random()-0.5)*70;
      bot.targetZ = (Math.random()-0.5)*40;
      bot.moveTimer = 2 + Math.random()*3;
    }
    const dx = bot.targetX - bot.x, dz = bot.targetZ - bot.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 0.5) {
      bot.x += (dx/dist)*0.3; bot.z += (dz/dist)*0.3;
      bot.rotY = Math.atan2(dx, dz);
    }
    
    // Bot Shooting Logic (FFA: target ANY alive player that isn't itself)
    const now = Date.now();
    if (now - bot.lastShot > 1200) {
      const target = Object.values(players).find(p => p.alive && p.id !== bot.id);
      
      if (target && Math.hypot(target.x - bot.x, target.z - bot.z) < 30) {
        bot.lastShot = now;
        
        // Aim direction
        let aimX = (target.x - bot.x) / 30;
        let aimY = 0;
        let aimZ = (target.z - bot.z) / 30;
        
        // Broadcast shot
        io.emit('playerShot', { id: bot.id, x: bot.x, y: bot.y, z: bot.z, dx: aimX, dy: aimY, dz: aimZ, skin: bot.skin });
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
    const sp = randSpawn();
    
    players[socket.id] = {
      id: socket.id, 
      name: name || 'Player', 
      skin: skin || 0,
      health: 100, alive: true, x: sp.x, y: sp.y, z: sp.z, rotY: 0,
      kills: 0, deaths: 0, weapon: 'rifle', ammo: 30, reserve: 90, lastShot: 0,
      inventory: { 
        rifle:  { ammo: 30, reserve: 90 }, 
        pistol: { ammo: 12, reserve: 48 }, 
        sniper: { ammo: 5,  reserve: 20 } 
      }
    };

    if (withBots && !botInterval) {
      addBots();
      botInterval = setInterval(tickBots, 100);
    }

    socket.emit('joined', { id: socket.id, player: publicPlayer(players[socket.id]), roundActive, roundTimer });
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
    if (!p || !p.alive || p.ammo <= 0 || !roundActive) return;
    
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
      // Free For All: Don't shoot yourself, but everyone else is fair game!
      if (t.id === socket.id || !t.alive) return;
      
      const dx = t.x - ox, dy = (t.y + 1) - oy, dz = t.z - oz;
      const dot = dx*dirX + dy*dirY + dz*dirZ;
      if (dot < 0 || dot > bDist) return; // Blocked by wall/box
      
      const perpX = ox + dirX*dot - t.x, perpY = oy + dirY*dot - (t.y+1), perpZ = oz + dirZ*dot - t.z;
      
      if (perpX*perpX + perpY*perpY + perpZ*perpZ < 0.8 && dot < minDist) {
        minDist = dot; hitP = t;
      }
    });

    if (hitP) {
      hitP.health -= wep.damage;
      io.emit('playerHit', { id: hitP.id, health: hitP.health });
      
      if (hitP.health <= 0) {
        hitP.alive = false; 
        hitP.deaths++; 
        p.kills++;
        
        killFeed.unshift({ killer: p.name, victim: hitP.name, weapon: p.weapon });
        if(killFeed.length > 5) killFeed.pop();
        
        io.emit('playerKilled', { id: hitP.id, killFeed });
        io.emit('scoreUpdate', allPublic());
        
        // Handle Respawn
        setTimeout(() => {
          if (!players[hitP.id]) return;
          const sp = randSpawn(); // Safely spawn them in an edge/corner
          hitP.health = 100; hitP.alive = true; hitP.x = sp.x; hitP.z = sp.z;
          
          // Give them some ammo back on respawn
          hitP.ammo = WEAPONS[hitP.weapon].ammo;
          hitP.inventory[hitP.weapon].ammo = hitP.ammo;
          
          io.emit('playerRespawned', { id: hitP.id, x: sp.x, y: sp.y, z: sp.z });
          io.emit('scoreUpdate', allPublic());
        }, RESPAWN_WAIT * 1000);
      }
    }
  });

  socket.on('reload', () => {
    const p = players[socket.id];
    if (!p || !p.alive || !roundActive) return;
    
    const wep = WEAPONS[p.weapon];
    if (p.ammo === wep.ammo || p.reserve <= 0) return;

    setTimeout(() => {
        if (!players[socket.id] || !players[socket.id].alive) return;
        const take = Math.min(wep.ammo - p.ammo, p.reserve);
        p.ammo += take; p.reserve -= take;
        p.inventory[p.weapon].ammo = p.ammo;
        p.inventory[p.weapon].reserve = p.reserve;
        socket.emit('ammoUpdate', { ammo: p.ammo, reserve: p.reserve });
    }, wep.reloadTime);
  });

  socket.on('switchWeapon', ({ weapon }) => {
    const p = players[socket.id];
    if (p && p.alive && WEAPONS[weapon]) {
      p.weapon = weapon;
      p.ammo = p.inventory[weapon].ammo;
      p.reserve = p.inventory[weapon].reserve;
      socket.emit('ammoUpdate', { ammo: p.ammo, reserve: p.reserve });
    }
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    
    // Check if humans are left
    const humansLeft = Object.values(players).filter(p => !p.isBot).length;
    if (humansLeft === 0) {
      if (botInterval) clearInterval(botInterval);
      if (roundTick) clearInterval(roundTick);
      botInterval = null;
      roundTick = null;
      roundActive = false;
      players = {}; // Clear out the bots
    }
    
    io.emit('playerList', allPublic());
  });
});

server.listen(PORT, '0.0.0.0', () => console.log('OJO Strike server listening on port ' + PORT));
