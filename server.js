// 极简静态服务器：托管 dist/，自动选空闲端口，局域网可访问（手机同 WiFi 可玩）
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

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
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') { console.log(`端口 ${port} 被占用，尝试 ${port + 1} ...`); serve(port + 1); }
    else console.error(e);
  });
  server.listen(port, '0.0.0.0', () => {
    console.log('');
    console.log('  ⚽ 足球游戏已启动！');
    console.log(`  ➜ 电脑打开: http://localhost:${port}`);
    // 局域网地址（手机同 WiFi 可访问）
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const n of nets[name] || []) {
        if (n.family === 'IPv4' && !n.internal) {
          console.log(`  ➜ 手机打开: http://${n.address}:${port}`);
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
