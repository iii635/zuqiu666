// 静态服务器 + WebSocket 局域网联机中枢：托管 dist/，自动选空闲端口，局域网可访问
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, 'dist');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.fbx': 'application/octet-stream',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
};

// ===== 局域网联机：房间管理 + 消息转发 =====
// 房间：roomId -> Map(playerId -> ws)。房主 = playerId 0（第一个创建房间的），负责球物理 + 比分。
const rooms = new Map();

function broadcast(roomId, msg, exceptWs) {
  const room = rooms.get(roomId);
  if (!room) return;
  const text = JSON.stringify(msg);
  for (const [, client] of room) {
    if (client !== exceptWs && client.readyState === 1) {
      client.send(text);
    }
  }
}

function handleLeave(ws) {
  const u = ws.userData;
  if (!u || !u.roomId) return;
  const room = rooms.get(u.roomId);
  if (room) {
    room.delete(u.playerId);
    broadcast(u.roomId, { type: 'peer_left', playerId: u.playerId });
    if (room.size === 0) rooms.delete(u.roomId);
  }
}

function handleMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }
  switch (msg.type) {
    case 'create': {
      const roomId = Math.random().toString(36).slice(2, 8).toUpperCase();
      const room = new Map();
      ws.userData = { roomId, playerId: 0, color: 0, team: 0, isHost: true };
      room.set(0, ws);
      rooms.set(roomId, room);
      ws.send(JSON.stringify({ type: 'joined', roomId, playerId: 0, color: 0, team: 0 }));
      break;
    }
    case 'join': {
      const room = rooms.get(msg.roomId);
      if (!room) { ws.send(JSON.stringify({ type: 'error', msg: '房间不存在' })); break; }
      if (room.size >= 4) { ws.send(JSON.stringify({ type: 'error', msg: '房间已满（最多4人）' })); break; }
      let playerId = -1;
      for (let i = 1; i < 4; i++) { if (!room.has(i)) { playerId = i; break; } }
      const team = playerId < 2 ? 0 : 1; // 红蓝=队0，黄绿=队1
      ws.userData = { roomId: msg.roomId, playerId, color: playerId, team, isHost: false };
      room.set(playerId, ws);
      ws.send(JSON.stringify({ type: 'joined', roomId: msg.roomId, playerId, color: playerId, team }));
      broadcast(msg.roomId, { type: 'peer_joined', playerId, color: playerId, team }, ws);
      break;
    }
    case 'state': { // 玩家上报位置/朝向，广播给同房间其他人
      const u = ws.userData;
      if (!u) break;
      broadcast(u.roomId, { type: 'state', playerId: u.playerId, x: msg.x, z: msg.z, rotY: msg.rotY, moving: msg.moving }, ws);
      break;
    }
    case 'kick':
    case 'pass': { // 非房主的踢球/传球动作 → 转发给房主执行
      const u = ws.userData;
      if (!u || u.isHost) break;
      const room = rooms.get(u.roomId);
      const host = room && room.get(0);
      if (host && host.readyState === 1) {
        host.send(JSON.stringify({ type: msg.type, playerId: u.playerId, x: msg.x, z: msg.z, rotY: msg.rotY, power: msg.power, ratio: msg.ratio }));
      }
      break;
    }
    case 'ball': { // 房主广播球状态
      const u = ws.userData;
      if (!u || !u.isHost) break;
      broadcast(u.roomId, { type: 'ball', x: msg.x, y: msg.y, z: msg.z, vx: msg.vx, vy: msg.vy, vz: msg.vz }, null);
      break;
    }
    case 'score': { // 房主广播比分
      const u = ws.userData;
      if (!u || !u.isHost) break;
      broadcast(u.roomId, { type: 'score', scores: msg.scores }, null);
      break;
    }
  }
}

function serve(port) {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/') p = '/index.html';
    const file = path.normalize(path.join(root, p));
    if (!file.startsWith(root)) { res.writeHead(403); res.end('403'); return; }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404); res.end('404 Not Found'); return; }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      });
      fs.createReadStream(file).pipe(res);
    });
  });

  // WebSocket 联机中枢（noServer 模式，手动处理 upgrade，避免监听 server error 冲突）
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws) => {
    ws.on('message', (data) => handleMessage(ws, data));
    ws.on('close', () => handleLeave(ws));
  });
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') { console.log(`端口 ${port} 被占用，尝试 ${port + 1} ...`); serve(port + 1); }
    else console.error(e);
  });
  server.listen(port, '0.0.0.0', () => {
    console.log('');
    console.log('  ⚽ 足球游戏（2v2 局域网联机）已启动！');
    console.log(`  ➜ 电脑打开: http://localhost:${port}`);
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const n of nets[name] || []) {
        if (n.family === 'IPv4' && !n.internal) {
          console.log(`  ➜ 朋友(同 WiFi)打开: http://${n.address}:${port}`);
        }
      }
    }
    console.log('  关闭本窗口即可退出游戏服务器');
    console.log('');
  });
}

if (!fs.existsSync(path.join(root, 'index.html'))) {
  console.error('未找到 dist/index.html，请先运行 npm run build');
  process.exit(1);
}
serve(8000);
