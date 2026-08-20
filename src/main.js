import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

// ================= 常量（模型实测尺寸，渲染单位） =================
// FBX 顶点数据是米单位（球员高 1.153、球场长 1.05、球直径 1.19），
// 但节点 transform 带 100 倍缩放（cm 化），导致渲染尺寸≈球场体量。
// 归一化 transform 后按真实比例设置缩放：球员 1.75m、球 0.22m、球场 105m。
const BALL_RADIUS = 0.44;                    // 足球半径（用户要求 ×4 → 直径 0.88m）
const PLAYER_HEIGHT = 3.5;                      // 球员目标高度 3.5m（用户要求 ×2）
const PLAYER_PART_SCALE = PLAYER_HEIGHT / 1.66; // 程序化小人高 1.66m → 缩放到 3.5m
const PLAYER_COLORS = [0xe63946, 0x2f80ed, 0xf2c94c, 0x27ae60]; // 4 人球衣颜色：红蓝黄绿
const PLAYER_SPAWNS = [[0, -12], [0, 12], [-15, 0], [15, 0]];   // 4 人出生点
const TEAMS = [0, 0, 1, 1]; // 按颜色顺序分队：红蓝=队0（守 x=-34），黄绿=队1（守 x=+34）
const TEAM_NAMES = ['红蓝', '黄绿'];
const STADIUM_SCALE = 1;                      // 新球场模型直接使用米单位（约 66×7×37m 小型球场）
let GROUND_Y = 0;                             // 场地表面高度（加载后用射线探测球场表面精确高度）

const BOUNDS = { xMin: -35, xMax: 35, zMin: -18, zMax: 18 };  // 球场边界（70×37m，球门在 x 两端）
const GOAL_HALF = 5.2;                       // 球门半宽(米)（实测球门柱在 z≈±5.4）
const GOAL_X = 34.0;                         // 球门线位置（球场长边 x 两端）
const DRIBBLE_DIST = 2.6;                    // 进入带球状态的距离
const DRIBBLE_OFF = 1.6;                     // 带球时球在身前距离
const GRAVITY = 9.8;
const FRICTION = 2.2;                        // 球地面摩擦减速度（调小让球滚更远）
const WALK_SPEED = 5.0, RUN_SPEED = 8.6;

// ================= 全局错误处理（避免无声黑屏） =================
function showFatal(msg) {
  const el = document.getElementById('loading');
  if (el) {
    el.style.display = 'flex';
    el.style.background = 'rgba(10,10,10,.92)';
    el.innerHTML = `<div style="color:#ff6666;font-size:15px;max-width:640px;padding:24px;text-align:center;background:rgba(0,0,0,.6);border-radius:10px;line-height:1.8">${msg}</div>`;
  }
  console.error('[game]', msg);
}
window.addEventListener('error', (e) => { showFatal('页面错误：' + (e.message || e.type || '未知错误')); });
window.addEventListener('unhandledrejection', (e) => {
  showFatal('加载错误：' + (e.reason && e.reason.message ? e.reason.message : String(e.reason || '未知')));
});

// ================= 渲染器 / 场景 / 相机 =================
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true });
} catch (e) {
  showFatal('无法创建 WebGL 渲染器（您的浏览器未开启硬件加速或版本过旧）。<br>请尝试：Chrome/Edge 设置 → 系统 → 打开「使用硬件加速」后重启浏览器；<br>或用 Chrome/Edge 打开本页面。错误：' + (e.message || e));
  throw e;
}
renderer.domElement.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  showFatal('图形加速上下文已丢失（可能显卡内存不足），请刷新页面重试。');
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fd7f7);
scene.fog = new THREE.Fog(0x9fd7f7, 160, 400);

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 1200);

// 无光照渲染：移除所有灯，材质全部转 MeshBasicMaterial（画面均匀明亮，无明暗）

// 转基本材质（保留贴图/颜色，不受光照影响）
function toBasicMaterial(mat) {
  return new THREE.MeshBasicMaterial({
    map: mat.map || null,
    color: mat.color ? mat.color.clone() : 0xffffff,
    side: mat.side || THREE.FrontSide,
  });
}

// ================= 加载模型（顺序加载控制内存峰值） =================
const loadManager = new THREE.LoadingManager();
let loadedCount = 0, totalCount = 3;
const fill = document.getElementById('loadFill');
const pctEl = document.getElementById('loadPct');
loadManager.onProgress = (url, loaded, total) => {
  const p = Math.min(1, (loadedCount + loaded / total) / totalCount);
  fill.style.width = (p * 100).toFixed(0) + '%';
  pctEl.textContent = (p * 100).toFixed(0) + '%';
};
loadManager.onLoad = () => {}; // 实际隐藏由 loadAll().then 完成（等所有模型就绪）

const fbx = new FBXLoader(loadManager);
const loadFBX = (url) => new Promise((res, rej) => fbx.load(url, res, undefined, rej));

// 草皮贴图：加载图片 → canvas 重绘 → CanvasTexture
// （TextureLoader 直传 JPEG 在本环境渲染白色，canvas 方案实测有效）
async function loadGrassTexture(url) {
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('草皮贴图加载失败'));
    i.src = url;
  });
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

// 归一化 FBX 节点变换：重置所有 mesh 的位置/旋转/缩放（顶点数据本身是米单位），
// 只保留干净的 scale —— 绕开 FBX 内可能异常的 transform（如 100 倍 cm 化缩放、坏旋转）。
function normalizeFBX(obj, targetScale) {
  obj.traverse((n) => {
    if (n.isMesh) {
      n.position.set(0, 0, 0);
      n.rotation.set(0, 0, 0);
      n.scale.setScalar(1);
      n.updateMatrix();
    }
  });
  obj.scale.setScalar(targetScale);
  obj.updateMatrix();
  obj.updateMatrixWorld(true);
}

// 关键修复：FBXLoader 生成的球员 mesh 在 WebGL 渲染时存在不渲染的问题
// （geometry/材质/矩阵/数据全部正常，draw 也提交，但光栅化无输出，原因在 FBX 数据本身）。
// 解决方案：
//   - 球员：Node 端用 mergeVertices 重建为索引化干净数据（player_rebuilt.bin），
//     与可正常渲染的几何同构，已实测验证能渲染；材质仍用 FBX 原材质（保留贴图）。
//   - 球场/足球：FBX 数据实测能正常渲染，保留原样（rebuildModel 仅重置变换）。
function rebuildModel(fbxObj, targetScale) {
  normalizeFBX(fbxObj, targetScale);
  const meshes = [];
  fbxObj.traverse((n) => { if (n.isMesh) meshes.push(n); });
  if (!meshes.length) return fbxObj;
  const m = meshes[0];
  // 脚底对齐 y=0 直接做进几何数据（永久），避免与 Group 位置逻辑冲突
  m.geometry.computeBoundingBox();
  const bb = m.geometry.boundingBox;
  if (bb && bb.min.y !== 0) {
    m.geometry.translate(0, -bb.min.y, 0);
    m.geometry.computeBoundingBox();
    m.geometry.computeBoundingSphere();
  }
  const clean = new THREE.Mesh(m.geometry, m.material);
  clean.scale.setScalar(targetScale);
  clean.name = m.name || 'model';
  if (m.material) m.material.side = THREE.DoubleSide;
  return clean;
}

// 从重建二进制数据构造 BufferGeometry（索引化、紧凑顶点）
async function loadBinaryGeometry(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('模型数据加载失败: ' + url);
  const arrBuf = await resp.arrayBuffer();
  const view = new DataView(arrBuf);
  const vCount = view.getUint32(0, true);
  const iCount = view.getUint32(4, true);
  const hasUV = view.getUint32(8, true);
  let off = 16;
  const pos = new Float32Array(arrBuf, off, vCount * 3); off += vCount * 3 * 4;
  const nor = new Float32Array(arrBuf, off, vCount * 3); off += vCount * 3 * 4;
  const uv = hasUV ? new Float32Array(arrBuf, off, vCount * 2) : null; off += hasUV ? vCount * 2 * 4 : 0;
  const idx = new Uint32Array(arrBuf, off, iCount);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos.slice(), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor.slice(), 3));
  if (uv) geo.setAttribute('uv', new THREE.BufferAttribute(uv.slice(), 2));
  geo.setIndex(new THREE.BufferAttribute(idx.slice(), 1));
  geo.computeBoundingSphere();
  return geo;
}

// 程序化生成球员部件（卡通小人，带跑动/踢球动画）。
// ⚠️ 关键：所有部件必须是「单层」—— 直接返回平铺的 Mesh 数组。
// 实测本环境 WebGL 对「Group→Group→Mesh」两层嵌套的网格不渲染（驱动层怪问题），
// 因此不用 pivot Group 做骨骼，改用「几何中心偏移」实现绕髋/肩摆动。
function makePlayerParts(shirtColor = 0xe63946) {
  const shirtMat = new THREE.MeshPhongMaterial({ color: shirtColor });  // 球衣颜色（可定制）
  const shortsMat = new THREE.MeshPhongMaterial({ color: 0x22223a }); // 深色短裤
  const skinMat = new THREE.MeshPhongMaterial({ color: 0xffd9b3 });   // 肤色

  // 身体（髋部 y=0.75 到肩 y=1.32）
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.57, 0.28), shirtMat);
  body.position.set(0, 1.035, 0);
  // 头
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 16, 12), skinMat);
  head.position.set(0, 1.52, 0);
  // 腿：几何中心下移 0.36 → mesh 原点在髋部，rotation.x 即绕髋摆动
  const legGeo = new THREE.BoxGeometry(0.16, 0.72, 0.18);
  legGeo.translate(0, -0.36, 0);
  const legL = new THREE.Mesh(legGeo, shortsMat);
  legL.position.set(-0.15, 0.75, 0);
  const legR = new THREE.Mesh(legGeo, shortsMat);
  legR.position.set(0.15, 0.75, 0);
  // 手臂：几何中心下移 0.26 → mesh 原点在肩部
  const armGeo = new THREE.BoxGeometry(0.13, 0.52, 0.15);
  armGeo.translate(0, -0.26, 0);
  const armL = new THREE.Mesh(armGeo, shirtMat);
  armL.position.set(-0.36, 1.28, 0);
  const armR = new THREE.Mesh(armGeo, shirtMat);
  armR.position.set(0.36, 1.28, 0);

  return { parts: [body, head, legL, legR, armL, armR], legL, legR, armL, armR, body };
}

// 椭圆阴影贴片（强化实体落地感，解决深度测试穿透造成的"半透明漂浮感"）
function makeShadow(size, opacity) {
  const canvas = document.createElement('canvas');
  canvas.width = 128; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(64, 64, 8, 64, 64, 64);
  grad.addColorStop(0, 'rgba(0,0,0,' + opacity + ')');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.02;
  mesh.renderOrder = 5;
  return mesh;
}

// 创建一个球员（球衣颜色 + 出生点），返回 { group, body, parts }
function createPlayer(shirtColor, spawnX, spawnZ) {
  const parts = makePlayerParts(shirtColor);
  parts.parts.forEach(p => { p.material = toBasicMaterial(p.material); }); // 无光照
  const group = new THREE.Group();
  const body = new THREE.Group(); // 身体容器（姿态：前倾/起伏作用于此）
  body.scale.setScalar(PLAYER_PART_SCALE);
  parts.parts.forEach(p => body.add(p));
  group.add(body);
  const shadow = makeShadow(4.2, 0.5);
  shadow.position.y = 0.02;
  group.add(shadow);
  group.position.set(spawnX, GROUND_Y, spawnZ);
  group.rotation.y = Math.PI / 2;
  group.traverse((n) => {
    if (n.isMesh && n.material && n.name !== 'shadow') {
      n.material.depthTest = true;
      n.material.depthWrite = true;
      n.material.side = THREE.FrontSide;
    }
  });
  scene.add(group);
  return { group, body, parts };
}

// 拆分球员网格 → 四肢可独立摆动（跑动/踢球动画）
// 按三角形质心分组：腿(y<0.48 按 x 分左右)、手臂(|x|>0.18)、身体(其余，覆盖髋肩接缝区)。
// 腿 pivot 在髋部(0.5)、手臂 pivot 在肩(0.95) —— 几何平移后 mesh 绕 pivot 旋转即自然摆动，
// pivot 藏在身体内部，摆动时接缝开口被身体遮挡，减少"脚身分离"感。
function splitPlayerModel(playerModel) {
  const geo = playerModel.geometry;
  const pos = geo.attributes.position.array;
  const nor = geo.attributes.normal.array;
  const uva = geo.attributes.uv ? geo.attributes.uv.array : null;
  const triCount = pos.length / 9;
  const groups = { legL: [], legR: [], armL: [], armR: [], body: [] };
  for (let t = 0; t < triCount; t++) {
    const i = t * 9;
    const cy = (pos[i + 1] + pos[i + 4] + pos[i + 7]) / 3;
    const cx = (pos[i] + pos[i + 3] + pos[i + 6]) / 3;
    let g;
    if (cy < 0.48) g = cx < 0 ? 'legL' : 'legR';
    else if (Math.abs(cx) > 0.18) g = cx < 0 ? 'armL' : 'armR';
    else g = 'body';
    groups[g].push(t);
  }
  const makePart = (tris) => {
    const g2 = new THREE.BufferGeometry();
    const n = tris.length * 9;
    const p = new Float32Array(n);
    const no = new Float32Array(n);
    const u = uva ? new Float32Array(tris.length * 6) : null;
    let pi = 0, ui = 0;
    for (const t of tris) {
      const i = t * 9;
      for (let v = 0; v < 9; v++) { p[pi] = pos[i + v]; no[pi] = nor[i + v]; pi++; }
      if (uva) for (let v = 0; v < 6; v++) u[ui++] = uva[t * 6 + v];
    }
    g2.setAttribute('position', new THREE.BufferAttribute(p, 3));
    g2.setAttribute('normal', new THREE.BufferAttribute(no, 3));
    if (u) g2.setAttribute('uv', new THREE.BufferAttribute(u, 2));
    g2.computeBoundingSphere();
    return g2;
  };
  const mat = playerModel.material;
  const s = playerModel.scale.x; // 继承整体缩放（1.153 → 3.5m）
  const mk = (key, pivotY) => {
    const g2 = makePart(groups[key]);
    if (pivotY) g2.translate(0, -pivotY, 0);
    const m = new THREE.Mesh(g2, mat);
    m.scale.setScalar(s);
    if (pivotY) m.position.y = pivotY * s;
    m.material.side = THREE.FrontSide;
    m.material.depthTest = true;
    m.material.depthWrite = true;
    return m;
  };
  return {
    legL: mk('legL', 0.5),
    legR: mk('legR', 0.5),
    armL: mk('armL', 0.95),
    armR: mk('armR', 0.95),
    body: mk('body', 0),
  };
}

// 四肢摆动动画（顶点着色器方案，不拆分网格 → 零接缝撕裂）
// 在 GPU 顶点着色器中按顶点位置旋转腿/臂顶点（绕髋部/肩部枢轴），
// 150 万顶点 GPU 并行处理无压力，且网格连续无缝。
function setupLimbs(mat) {
  const uniforms = {
    legSwing: { value: 0 },
    legSpreadL: { value: 0 },
    legSpreadR: { value: 0 },
    kneeAngle: { value: 0 },
    armSwing: { value: 0 },
    elbowAngle: { value: 0 },
  };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>',
        '#include <common>\nuniform float legSwing;\nuniform float legSpreadL;\nuniform float legSpreadR;\nuniform float kneeAngle;\nuniform float armSwing;\nuniform float elbowAngle;')
      .replace('#include <begin_vertex>', `
        vec3 p2 = position;
        // 小腿屈膝：y<0.32 的顶点绕膝盖(0,0.25,0)旋转（先膝后髋，两段骨骼）
        // ⚠️ 屈膝两腿同向后弯（不加左右反向——之前加了导致左腿前弯）
        float kneeW = smoothstep(0.32, 0.12, p2.y);
        if (kneeW > 0.001) {
          float ka = kneeAngle * kneeW;
          vec3 kp = p2 - vec3(0.0, 0.25, 0.0);
          float cs3 = cos(ka), sn3 = sin(ka);
          kp = vec3(kp.x, cs3 * kp.y - sn3 * kp.z, sn3 * kp.y + cs3 * kp.z);
          p2 = kp + vec3(0.0, 0.25, 0.0);
        }
        // 大腿前后摆动：y<0.55 绕髋(0,0.5,0)，左右腿反向
        float legW = smoothstep(0.55, 0.35, p2.y);
        if (legW > 0.001) {
          float la = legSwing * legW * (p2.x < 0.0 ? -1.0 : 1.0);
          vec3 lp = p2 - vec3(0.0, 0.5, 0.0);
          float cs = cos(la), sn = sin(la);
          lp = vec3(lp.x, cs * lp.y - sn * lp.z, sn * lp.y + cs * lp.z);
          p2 = lp + vec3(0.0, 0.5, 0.0);
        }
        // 双腿左右分开（油炸丸子跨步）：左右腿独立控制、各自向外张开（不交叉）
        // 左腿(x<0)用负角向外(-x)、右腿(x>0)用正角向外(+x)
        if (legW > 0.001) {
          float sp = (p2.x < 0.0 ? -legSpreadL : legSpreadR) * legW;
          vec3 sp2 = p2 - vec3(0.0, 0.5, 0.0);
          float c5 = cos(sp), s5 = sin(sp);
          sp2 = vec3(c5 * sp2.x - s5 * sp2.y, s5 * sp2.x + c5 * sp2.y, sp2.z);
          p2 = sp2 + vec3(0.0, 0.5, 0.0);
        }
        // 手臂：只选最外侧条带 |x|>0.145、y 0.56~0.95（排除头部 y>0.95 与身体侧面 |x|<0.145）
        // 绕腋下轴(±0.15, 0.85)摆动 → 肩到肘到前臂整体，身体不粘连
        float armW = smoothstep(0.56, 0.68, p2.y) * step(0.145, abs(p2.x)) * step(p2.y, 0.95);
        if (armW > 0.001) {
          // 前臂绕肘(±0.15, 0.68)弯曲（手腕跟随前臂）
          float foreW = smoothstep(0.74, 0.56, p2.y) * armW;
          if (foreW > 0.001) {
            vec3 ep = p2 - vec3(sign(p2.x) * 0.15, 0.68, 0.0);
            float ea = elbowAngle * foreW;
            float c4 = cos(ea), s4 = sin(ea);
            ep = vec3(ep.x, c4 * ep.y - s4 * ep.z, s4 * ep.y + c4 * ep.z);
            p2 = ep + vec3(sign(p2.x) * 0.15, 0.68, 0.0);
          }
          // 整臂绕腋下轴摆动
          float aa = armSwing * armW * sign(p2.x);
          vec3 ap = p2 - vec3(sign(p2.x) * 0.15, 0.85, 0.0);
          float cs2 = cos(aa), sn2 = sin(aa);
          ap = vec3(ap.x, cs2 * ap.y - sn2 * ap.z, sn2 * ap.y + cs2 * ap.z);
          p2 = ap + vec3(sign(p2.x) * 0.15, 0.85, 0.0);
        }
        vec3 transformed = p2;
      `);
  };
  mat.customProgramCacheKey = () => 'limbs-anim';
  return uniforms;
}

// 程序化生成足球（替代 115MB 的 ball.fbx，降低加载量/显卡负担，外观接近）
function makeSoccerBall() {
  const geo = new THREE.SphereGeometry(1, 48, 48);
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 512;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 512, 512);
  ctx.fillStyle = '#181818';
  const pent = (cx, cy, r, rot = -Math.PI / 2) => {
    ctx.beginPath();
    for (let i = 0; i < 5; i++) {
      const a = rot + (i * 2 * Math.PI) / 5;
      const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
  };
  pent(256, 110, 72);
  pent(100, 340, 72, -Math.PI / 2 + 0.6);
  pent(412, 340, 72, -Math.PI / 2 - 0.6);
  pent(256, 430, 62);
  pent(180, 190, 40, 0.4);
  pent(332, 190, 40, -0.4);
  // 连接线（简化图案）
  ctx.strokeStyle = '#181818';
  ctx.lineWidth = 10;
  ctx.lineCap = 'round';
  const lines = [[256, 110, 256, 38], [256, 110, 180, 190], [256, 110, 332, 190],
    [100, 340, 180, 190], [412, 340, 332, 190], [100, 340, 256, 430], [412, 340, 256, 430],
    [256, 110, 100, 268], [256, 110, 412, 268], [180, 190, 256, 492], [332, 190, 256, 492]];
  for (const [x1, y1, x2, y2] of lines) {
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshPhongMaterial({ map: tex, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.scale.setScalar(BALL_RADIUS); // 半径 1 → 0.11m（直径 0.22m）
  return mesh;
}

async function loadAll() {
  // 1. 球员：4 人混战（本地红色 + 3 个远程占位蓝黄绿，下面组装时创建）
  loadedCount = 1;

  // 2. 球场（"单元几何+transform 组装"式模型：保留内部变换，非均匀缩放 → 70×7×37m）
  //    模型实测 6635×701×3690 → 缩放 x=70/6635、y=7/701、z=37/3690（长度调小减少贴图拉伸）
  const stadium = await loadFBX('models/stadium.fbx');
  stadium.scale.set(70 / 6635.12, 7 / 700.95, 37 / 3689.72);
  stadium.updateMatrixWorld(true);
  const sBox = new THREE.Box3().setFromObject(stadium);
  stadium.position.y = -sBox.min.y; // 脚底对齐 y=0
  stadium.updateMatrixWorld(true);  // ⚠️ 更新后再探测（否则 raycast 用旧矩阵）
  // 草皮贴图：FBX 内引用了 base_color_texture 但图像缺失，补上用户提供的贴图（CanvasTexture 方案）
  const grassTex = await loadGrassTexture('models/grass.jpg');
  stadium.traverse((n) => {
    if (n.isMesh && n.material) {
      // 草皮面：名字含"平面"或材质引用了缺失的 base_color_texture
      const isGrass = n.name.includes('平面') || (n.material.map && n.material.map.name === 'base_color_texture');
      if (isGrass) {
        // 必须用全新材质替换（实测在 FBX 原材质上改 map 不渲染）；无光照用 Basic
        n.material = new THREE.MeshBasicMaterial({ map: grassTex, side: THREE.DoubleSide });
      } else {
        n.material = toBasicMaterial(n.material);
        n.material.side = THREE.DoubleSide;
      }
    }
  });
  scene.add(stadium);
  loadedCount = 2;

  // 射线探测场地实际表面高度（多采样点取最高，保证球员脚底不陷进草皮）
  const raycaster = new THREE.Raycaster();
  let surfaceMax = -Infinity;
  const samplePoints = [[0, -3], [0, 0], [5, 5], [-5, -10], [10, 10], [-10, 10], [0, 10]];
  for (const [sx, sz] of samplePoints) {
    raycaster.set(new THREE.Vector3(sx, 60, sz), new THREE.Vector3(0, -1, 0));
    const hits = raycaster.intersectObject(stadium, true); // 递归（球场是 Group）
    if (hits.length && hits[0].point.y > surfaceMax) surfaceMax = hits[0].point.y;
  }
  if (isFinite(surfaceMax) && surfaceMax > -10) GROUND_Y = surfaceMax + 0.03; // 探测值 + 3cm 保险垫高（防共面 z-fighting）
  else GROUND_Y = 0.65; // 回退：实测草皮平面 y=0.62 + 垫高
  console.log('[game] 探测场地表面高度:', GROUND_Y.toFixed(3), 'm');

  // 3. 足球（程序化生成，无需加载 FBX）
  const ballModel = makeSoccerBall();
  ballModel.material = toBasicMaterial(ballModel.material); // 无光照
  loadedCount = 3;

  // ---- 组装：4 个球员（红蓝黄绿），players[localPlayerId] 是本地 ----
  players = [];
  for (let i = 0; i < 4; i++) {
    players.push(createPlayer(PLAYER_COLORS[i], PLAYER_SPAWNS[i][0], PLAYER_SPAWNS[i][1]));
  }
  localPlayerId = 0; // 默认单机：本地=红
  const player = players[0].group;
  const playerModel = players[0].body;
  playerParts = players[0].parts;

  const ball = new THREE.Group();
  ball.add(ballModel);
  const ballShadow = makeShadow(1.5, 0.4);
  ballShadow.position.y = -BALL_RADIUS + 0.02; // 阴影贴地面（球心离地 BALL_RADIUS）
  ball.add(ballShadow);
  ball.position.set(0, GROUND_Y + BALL_RADIUS, 0); // 4 人混战：球放中场，各自去抢
  // 球正常深度测试 + 单面渲染（会被看台正确遮挡）
  ball.traverse((n) => {
    if (n.isMesh && n.material && n.name !== 'shadow') {
      n.material.depthTest = true;
      n.material.depthWrite = true;
      n.material.side = THREE.FrontSide;
    }
  });
  scene.add(ball);

  return { player, playerModel, ball, ballModel };
}

// ================= 游戏状态 =================
let player, playerModel, ball, ballModel;
let playerParts; // 本地玩家的四肢引用 { legL, legR, armL, armR, body }
let players = []; // 4 个球员对象 { group, body, parts }（players[localPlayerId] 是本地）
let localPlayerId = 0; // 本地球员索引（0=红,1=蓝,2=黄,3=绿）
let playerVel = new THREE.Vector3();
let ballVel = new THREE.Vector3();
let charging = false, charge = 0, kickT = 0, passT = 0, bobT = 0;
let passCharging = false, passCharge = 0; // 传球蓄力
let hasBall = false; // 球是否在脚下（带球状态；球离开后禁止射门/传球/油炸）
let croquetaT = 0; // 油炸丸子花式计时
let goalFreeze = 0;
let teamScores = [0, 0]; // 队比分 [红蓝, 黄绿]
let modelFlip = 0;
let camYaw = Math.PI / 2, camPitch = 0.28, camDist = 15; // 初始相机在球员身后（球员面向 +x）
let dragging = false;
const keys = {};
// 虚拟摇杆（轮盘）状态
let joyActive = false, joyMouse = false;
const joyVec = new THREE.Vector2();

const goalEl = document.getElementById('goal');
const goalsEl = document.getElementById('goals');
const powerbar = document.getElementById('powerbar');
const powerFill = document.getElementById('powerFill');
const fpsEl = document.getElementById('fps');

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function resetKickoff() {
  player.position.set(PLAYER_SPAWNS[0][0], GROUND_Y, PLAYER_SPAWNS[0][1]); // 回到出生点
  player.rotation.y = Math.PI / 2; // 面向 +x（球门方向）
  playerVel.set(0, 0, 0);
  ball.position.set(0, GROUND_Y + BALL_RADIUS, 0); // 球回中场
  ballVel.set(0, 0, 0);
  ball.quaternion.identity();
}

function onGoal(team) {
  teamScores[team]++;
  goalsEl.textContent = `${TEAM_NAMES[0]} ${teamScores[0]} : ${teamScores[1]} ${TEAM_NAMES[1]}`;
  goalEl.classList.add('show');
  ballVel.set(0, 0, 0);
  goalFreeze = 2.6;
  // 房主广播比分
  if (netHost && ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'score', scores: teamScores }));
  }
}

function doKick() {
  charging = false;
  powerbar.style.display = 'none';
  const ratio = charge / 1.15;
  const power = 10 + 30 * ratio; // 射门力度上限加大（10~40 m/s，射程更远）
  kickT = 0.28;
  if (netConnected && !netHost) {
    // 非房主：发送踢球动作给房主，球由房主权威
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'kick', x: player.position.x, z: player.position.z, rotY: player.rotation.y + modelFlip, power, ratio }));
    }
    return;
  }
  const f = new THREE.Vector3(Math.sin(player.rotation.y + modelFlip), 0, Math.cos(player.rotation.y + modelFlip));
  ballVel.copy(f).multiplyScalar(power);
  // 射门高度：短按=低平球（几乎贴地），长按=高飞球（明显飞起）
  ballVel.y = 2.0 + ratio * 7.0;
}

// 传球（只传地平球）：按下即传，球贴地滚出（不飞）
function doPass() {
  passCharging = false;
  powerbar.style.display = 'none';
  const ratio = passCharge / 1.0; // 蓄力进度 0~1
  const power = 5 + 6 * ratio; // 传球力度 5~11 m/s（地平球，蓄满约滚 27m）
  passT = 0.28;   // 短促的传球踢球动画
  if (netConnected && !netHost) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'pass', x: player.position.x, z: player.position.z, rotY: player.rotation.y + modelFlip, power }));
    }
    return;
  }
  const f = new THREE.Vector3(Math.sin(player.rotation.y + modelFlip), 0, Math.cos(player.rotation.y + modelFlip));
  ballVel.copy(f).multiplyScalar(power);
  ballVel.y = 0; // 地平球：无上抛速度，球贴地滚动
}

// ================= 输入 =================
addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (e.code === 'Space') {
    e.preventDefault();
    if (!charging && !passCharging && hasBall) { charging = true; charge = 0; powerbar.style.display = 'block'; }
  }
  if (e.code === 'KeyR') { resetKickoff(); }
  if (e.code === 'KeyC' && croquetaT <= 0 && hasBall) { croquetaT = 0.7; } // 油炸丸子花式
  if (e.code === 'KeyQ' && !passCharging && !charging && hasBall) { passCharging = true; passCharge = 0; powerbar.style.display = 'block'; } // 传球蓄力
  if (e.code === 'KeyF') { modelFlip = modelFlip ? 0 : Math.PI; if (playerModel) playerModel.rotation.y = modelFlip; }
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') e.preventDefault();
});
addEventListener('keyup', (e) => {
  keys[e.code] = false;
  if (e.code === 'Space' && charging) doKick();
  if (e.code === 'KeyQ' && passCharging) doPass();
});

// 视角控制（鼠标 + 触摸滑动，记录上次位置算增量）
let lastPX = 0, lastPY = 0;
renderer.domElement.addEventListener('mousedown', (e) => { dragging = true; lastPX = e.clientX; lastPY = e.clientY; });
addEventListener('mouseup', () => { dragging = false; });
addEventListener('mousemove', (e) => {
  if (!dragging) return;
  camYaw -= (e.clientX - lastPX) * 0.005;
  camPitch = clamp(camPitch + (e.clientY - lastPY) * 0.005, 0.12, 1.0);
  lastPX = e.clientX; lastPY = e.clientY;
});
// 手机：单指滑动转视角（任何时候都可滑，含移动中；双指操作时只响应画布上的触摸）
let camTouchId = null;
renderer.domElement.addEventListener('touchstart', (e) => {
  // ⚠️ 不检查 touches.length（双指操作=摇杆+画面时长度是 2）
  // 用 targetTouches 只记录"按在画布上的触摸"（摇杆手指不会误记录）
  if (camTouchId === null) {
    let t = e.targetTouches[0];
    if (!t) t = e.touches[0]; // 兜底（某些环境 targetTouches 不可用）
    if (t) {
      camTouchId = t.identifier;
      dragging = true; lastPX = t.clientX; lastPY = t.clientY;
    }
  }
}, { passive: false });
renderer.domElement.addEventListener('touchmove', (e) => {
  e.preventDefault();
  if (!dragging || camTouchId === null) return;
  for (const t of e.touches) {
    if (t.identifier === camTouchId) {
      camYaw -= (t.clientX - lastPX) * 0.005;
      camPitch = clamp(camPitch + (t.clientY - lastPY) * 0.005, 0.12, 1.0);
      lastPX = t.clientX; lastPY = t.clientY;
    }
  }
}, { passive: false });
renderer.domElement.addEventListener('touchend', (e) => {
  for (const t of e.changedTouches) {
    if (t.identifier === camTouchId) { camTouchId = null; dragging = false; }
  }
});
addEventListener('wheel', (e) => { camDist = clamp(camDist + e.deltaY * 0.012, 5, 22); }, { passive: true });
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ================= 主循环 =================
const clock = new THREE.Clock();
let fpsAcc = 0, fpsN = 0;

function update(dt) {
  dt = Math.min(dt, 0.05);

  // --- 移动输入（相对相机朝向） ---
  const fwd = new THREE.Vector3(Math.sin(camYaw), 0, Math.cos(camYaw));
  const right = new THREE.Vector3(-Math.cos(camYaw), 0, Math.sin(camYaw));
  const moveDir = new THREE.Vector3();
  if (joyActive && joyVec.lengthSq() > 0.01) {
    // 虚拟摇杆优先（任意方向）：上推=前进、右推=右移
    moveDir.addScaledVector(fwd, joyVec.y);
    moveDir.addScaledVector(right, joyVec.x);
  } else {
    if (keys['KeyW'] || keys['ArrowUp']) moveDir.add(fwd);
    if (keys['KeyS'] || keys['ArrowDown']) moveDir.sub(fwd);
    if (keys['KeyD'] || keys['ArrowRight']) moveDir.add(right);
    if (keys['KeyA'] || keys['ArrowLeft']) moveDir.sub(right);
  }
  const moving = moveDir.lengthSq() > 0.01;
  if (moving) moveDir.normalize();

  const run = keys['ShiftLeft'] || keys['ShiftRight'];
  const speed = run ? RUN_SPEED : WALK_SPEED;
  const target = moveDir.clone().multiplyScalar(speed);
  playerVel.lerp(target, 1 - Math.exp(-10 * dt));
  player.position.addScaledVector(playerVel, dt);
  player.position.x = clamp(player.position.x, -33, 33);
  player.position.z = clamp(player.position.z, -16, 16);

  // --- 转向移动方向 ---
  if (moving) {
    const targetYaw = Math.atan2(moveDir.x, moveDir.z);
    let dy = targetYaw - player.rotation.y;
    while (dy > Math.PI) dy -= 2 * Math.PI;
    while (dy < -Math.PI) dy += 2 * Math.PI;
    player.rotation.y += dy * Math.min(1, 14 * dt);
  }

  // --- 远程球员位置插值（联机） ---
  for (let i = 0; i < players.length; i++) {
    if (i === localPlayerId) continue;
    const rs = remoteStates[i];
    if (!rs) continue;
    const g = players[i].group;
    g.position.x += (rs.x - g.position.x) * Math.min(1, 14 * dt);
    g.position.z += (rs.z - g.position.z) * Math.min(1, 14 * dt);
    let dy = rs.rotY - g.rotation.y;
    while (dy > Math.PI) dy -= 2 * Math.PI;
    while (dy < -Math.PI) dy += 2 * Math.PI;
    g.rotation.y += dy * Math.min(1, 14 * dt);
  }

  // --- 蓄力 ---
  if (charging) {
    charge = Math.min(charge + dt, 1.15);
    powerFill.style.width = (charge / 1.15 * 100).toFixed(0) + '%';
    if (charge >= 1.15) doKick();
  } else if (passCharging) {
    passCharge = Math.min(passCharge + dt, 1.0);
    powerFill.style.width = (passCharge / 1.0 * 100).toFixed(0) + '%';
    if (passCharge >= 1.0) doPass();
  }

  // --- 球：带球 / 物理（谁近谁带球） ---
  const isBallAuthority = !netConnected || netHost; // 单机或房主才跑球物理
  const ballSpeed = ballVel.length();
  // 所有球员（本地 + 远程）
  const playersInGame = [];
  for (let i = 0; i < players.length; i++) {
    playersInGame.push({ group: players[i].group, team: TEAMS[i], isLocal: i === localPlayerId });
  }
  // 找带球者（球速慢时，最近的球员带球）
  let ballOwner = null;
  if (isBallAuthority && ballSpeed < 3.0) {
    let ownerDist = DRIBBLE_DIST;
    for (const p of playersInGame) {
      const d = Math.hypot(ball.position.x - p.group.position.x, ball.position.z - p.group.position.z);
      if (d < ownerDist) { ownerDist = d; ballOwner = p; }
    }
  }
  const toBall = new THREE.Vector3().subVectors(ball.position, player.position);
  toBall.y = 0;
  const dist2D = toBall.length();
  const facing = new THREE.Vector3(Math.sin(player.rotation.y + modelFlip), 0, Math.cos(player.rotation.y + modelFlip));

  // 油炸丸子花式（按 C 触发）：左脚先不动（支撑）→ 右脚向右迈出 → 左脚跟上并拢，整体向右移动 2m
  if (croquetaT > 0) {
    croquetaT -= dt;
    const t = 1.0 - croquetaT; // 0→1.0 进度
    const ss = (a, b, x) => { const k = clamp((x - a) / (b - a), 0, 1); return k * k * (3 - 2 * k); };
    const rDir = new THREE.Vector3(-facing.z, 0, facing.x); // 球员右侧方向
    // 阶段权重：前摇 0~0.24 / 右脚迈出 0.22~0.55（左脚不动）/ 左脚跟上 0.55~0.88 / 后摇 0.88~1.0
    const windup = ss(0, 0.18, t) * (1 - ss(0.18, 0.24, t));
    const stepR = ss(0.22, 0.34, t) * (1 - ss(0.45, 0.55, t));
    const stepL = ss(0.55, 0.68, t) * (1 - ss(0.78, 0.88, t));
    const recover = ss(0.88, 1.0, t);
    // 位移：右脚迈出 ~0.7m + 左脚跟上 ~1.3m = 总共 2m 向右
    player.position.addScaledVector(rDir, dt * (stepR * 2.5 + stepL * 6.0));
    // 球：右脚迈出时球拨向右前，左脚跟上时球回到身前随整体移动（房主/单机才做）
    if (isBallAuthority) {
      const ballSide = stepR * 0.8;
      const croTarget = new THREE.Vector3()
        .copy(player.position)
        .addScaledVector(rDir, ballSide * 0.5)
        .addScaledVector(facing, 0.7);
      croTarget.y = GROUND_Y + BALL_RADIUS;
      ball.position.lerp(croTarget, 1 - Math.exp(-26 * dt));
      ballVel.set(0, 0, 0);
    }
    // 横移边界保护
    player.position.x = clamp(player.position.x, -33, 33);
  }

  if (isBallAuthority && goalFreeze > 0) {
    // 进球冻结
    goalFreeze -= dt;
    hasBall = false;
    if (goalFreeze <= 0) { goalEl.classList.remove('show'); resetKickoff(); }
  } else if (isBallAuthority && ballOwner) {
    hasBall = ballOwner.isLocal; // 只有本地带球时本地才能操作射门/传球/油炸
    // 带球：球吸附到带球者身前（蓄力时也保持带球，松开才踢出）
    const ownerFacing = new THREE.Vector3(
      Math.sin(ballOwner.group.rotation.y + (ballOwner.isLocal ? modelFlip : 0)),
      0,
      Math.cos(ballOwner.group.rotation.y + (ballOwner.isLocal ? modelFlip : 0))
    );
    const dynOff = DRIBBLE_OFF + Math.sin(bobT * 0.9) * 0.6;
    const target = new THREE.Vector3()
      .copy(ballOwner.group.position)
      .addScaledVector(ownerFacing, dynOff);
    target.y = GROUND_Y + BALL_RADIUS;
    ball.position.lerp(target, 1 - Math.exp(-14 * dt));
    ballVel.set(0, 0, 0);
    // 滚动自转（随带球者速度，阶段 2 仅本地有速度）
    const pSpeed = ballOwner.isLocal ? playerVel.length() : 0;
    if (pSpeed > 0.5) {
      const axis = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), playerVel.clone().normalize());
      ball.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, (pSpeed / BALL_RADIUS) * dt));
    }
  } else if (isBallAuthority) {
    hasBall = false; // 球离开：禁止射门/传球/油炸
    // 自由物理
    ballVel.y -= GRAVITY * dt;
    ball.position.addScaledVector(ballVel, dt);

    const ballGround = GROUND_Y + BALL_RADIUS;
    if (ball.position.y < ballGround) {
      ball.position.y = ballGround;
      if (ballVel.y < 0) {
        if (ballVel.y < -1.0) { // 明显下落（弹跳）才反弹衰减；贴地滚动不衰减水平速度
          ballVel.y = -ballVel.y * 0.55;
          ballVel.x *= 0.85; ballVel.z *= 0.85;
        } else {
          ballVel.y = 0; // 贴地滚动：消除微小下落速度，正常滚
        }
      }
    }
    // 地面摩擦
    const hv = new THREE.Vector2(ballVel.x, ballVel.z);
    const sp = hv.length();
    if (sp > 0.001) {
      const ns = Math.max(0, sp - FRICTION * dt);
      hv.multiplyScalar(ns / sp);
      ballVel.x = hv.x; ballVel.z = hv.y;
    }
    // 球员触球（高速球弹开）
    if (dist2D < 1.0 && ballSpeed > 2.0) {
      const n = toBall.clone().normalize();
      n.y = 0;
      const dot = ballVel.dot(n);
      if (dot < 0) ballVel.addScaledVector(n, -dot * 1.6);
    }
    // z 方向边界反弹（宽度方向，无球门）
    if (ball.position.z < BOUNDS.zMin) { ball.position.z = BOUNDS.zMin; ballVel.z = Math.abs(ballVel.z) * 0.72; }
    if (ball.position.z > BOUNDS.zMax) { ball.position.z = BOUNDS.zMax; ballVel.z = -Math.abs(ballVel.z) * 0.72; }
    // x 方向球门判定：球越过球门线（±GOAL_X）且横向在球门范围内 → 进球；
    // 否则撞到球场两端反弹
    const inGoalX = Math.abs(ball.position.z) < GOAL_HALF;
    // 2v2：球进左边球门(x=-34，红蓝守) → 黄绿(队1)得分；进右边球门(x=+34，黄绿守) → 红蓝(队0)得分
    if (ball.position.x < -GOAL_X) {
      if (inGoalX) { ball.position.x = -GOAL_X - 1.5; onGoal(1); }
      else { ball.position.x = -GOAL_X; ballVel.x = Math.abs(ballVel.x) * 0.7; }
    }
    if (ball.position.x > GOAL_X) {
      if (inGoalX) { ball.position.x = GOAL_X + 1.5; onGoal(0); }
      else { ball.position.x = GOAL_X; ballVel.x = -Math.abs(ballVel.x) * 0.7; }
    }
    // 滚动自转
    const hsp = Math.hypot(ballVel.x, ballVel.z);
    if (hsp > 0.05) {
      const axis = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(ballVel.x, 0, ballVel.z).normalize());
      ball.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, (hsp / BALL_RADIUS) * dt));
    }
  } else {
    hasBall = false; // 非房主：球由房主权威广播，本地不跑物理
  }

  // --- 四肢摆动动画（程序化小人：直接旋转分体四肢关节） ---
  const kS = (v, t) => v + (t - v) * Math.min(1, 18 * dt);
  const applyPose = (legSwing, legSpreadL, legSpreadR, armSwing) => {
    const { legL, legR, armL, armR } = playerParts;
    // 符号约定（与 FBX 顶点着色器一致）：x<0 是屏幕右腿/右臂，x>0 是屏幕左
    legL.rotation.x = -legSwing;   // 大腿前后摆（左右反向）
    legR.rotation.x = legSwing;
    legL.rotation.z = -legSpreadL; // 左右张开（油炸丸子跨步）
    legR.rotation.z = legSpreadR;
    armL.rotation.x = -armSwing;   // 手臂前后摆（左右反向）
    armR.rotation.x = armSwing;
  };
  if (croquetaT > 0) {
    // 油炸丸子：左脚不动（支撑）→ 右脚向右迈出 → 左脚跟上并拢，身体不倾斜
    const t = 1.0 - croquetaT;
    const ss = (a, b, x) => { const k = clamp((x - a) / (b - a), 0, 1); return k * k * (3 - 2 * k); };
    const windup = ss(0, 0.18, t) * (1 - ss(0.18, 0.24, t));
    const stepR = ss(0.22, 0.34, t) * (1 - ss(0.45, 0.55, t));
    const stepL = ss(0.55, 0.68, t) * (1 - ss(0.78, 0.88, t));
    const recover = ss(0.88, 1.0, t);
    // 右脚(屏幕右=x<0=legL)向右迈出：legSpreadL 正；左脚(x>0=legR)合拢：legSpreadR 负
    applyPose(0, stepR * 1.0 - recover * 0.3, -stepL * 0.7 + recover * 0.2, 0);
    playerModel.rotation.x = windup * 0.12; // 微微前倾（不倾斜）
    playerModel.rotation.z = 0;
    playerModel.position.y = windup * 0.05; // 前摇下沉
  } else if (kickT > 0 || passT > 0) {
    if (kickT > 0) {
      kickT -= dt;
      const k = Math.max(0, kickT / 0.28);
      applyPose(1.3 * k, 0, 0, -1.0 * k); // 右腿前踢 + 手臂反摆
      playerModel.rotation.x = -0.2 * k; // 身体前倾
    } else {
      passT -= dt;
      const k = Math.max(0, passT / 0.28);
      applyPose(0.9 * k, 0, 0, -0.6 * k); // 传球：腿摆幅度小于射门
      playerModel.rotation.x = -0.12 * k; // 传球身体前倾较小
    }
  } else if (moving) {
    bobT += dt * speed * 2.6;
    const s = Math.sin(bobT);
    applyPose(s * 0.7, 0, 0, -s * 0.5); // 腿交替摆 + 手臂反相
    playerModel.position.y = kS(playerModel.position.y, Math.abs(s) * 0.12); // 起伏
    playerModel.rotation.x = kS(playerModel.rotation.x, 0.16 + s * 0.05);   // 前倾+节奏
    playerModel.rotation.z = kS(playerModel.rotation.z, s * 0.05);
  } else {
    // 静止：四肢缓缓归位
    const { legL, legR, armL, armR } = playerParts;
    legL.rotation.x *= 0.85; legR.rotation.x *= 0.85;
    legL.rotation.z *= 0.85; legR.rotation.z *= 0.85;
    armL.rotation.x *= 0.85; armR.rotation.x *= 0.85;
    playerModel.position.y = kS(playerModel.position.y, 0);
    playerModel.rotation.x = kS(playerModel.rotation.x, 0);
    playerModel.rotation.z = kS(playerModel.rotation.z, 0);
  }

  // --- 联机同步（上报位置 + 房主广播球） ---
  netSync(dt, moving);

  // --- 第三人称相机（大幅上移：瞄准球员脚踝、更平视 → 球员占据画面上半部） ---
  const camOff = new THREE.Vector3(-Math.sin(camYaw), 0, -Math.cos(camYaw));
  camera.position.copy(player.position).addScaledVector(camOff, camDist);
  camera.position.y = GROUND_Y + 1.8 + Math.tan(camPitch) * camDist;
  camera.lookAt(player.position.x, GROUND_Y + 0.3, player.position.z);
}

function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();
  if (!player) { renderer.render(scene, camera); return; }
  update(dt);
  renderer.render(scene, camera);

  fpsAcc += dt; fpsN++;
  if (fpsAcc >= 1) {
    fpsEl.textContent = Math.round(fpsN / fpsAcc) + ' FPS';
    fpsAcc = 0; fpsN = 0;
  }
}

// ============ 触屏操控（轮盘摇杆 + 动作按钮，PC 和手机都显示） ============
function initTouchControls() {
  const tc = document.getElementById('touch');
  if (!tc) return;
  tc.style.display = 'block';

  // 虚拟摇杆（轮盘）：触摸/鼠标拖动，任意方向移动
  const joyBase = document.getElementById('joyBase');
  const joyStick = document.getElementById('joyStick');
  if (joyBase && joyStick) {
    const JOY_R = 52; // 摇杆最大半径
    let joyTouchId = null;
    const setPos = (clientX, clientY) => {
      const rect = joyBase.getBoundingClientRect();
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      let dx = clientX - cx, dy = clientY - cy;
      const len = Math.hypot(dx, dy);
      if (len > JOY_R) { dx = (dx / len) * JOY_R; dy = (dy / len) * JOY_R; }
      // 保留 -50%,-50% 居中偏移（否则摇杆头会偏到圈外）
      joyStick.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      joyVec.set(dx / JOY_R, -dy / JOY_R); // 上推=前进(正y)
      joyActive = true;
    };
    const resetJoy = () => {
      joyActive = false; joyTouchId = null; joyMouse = false;
      joyVec.set(0, 0);
      joyStick.style.transform = 'translate(-50%, -50%)';
    };
    joyBase.addEventListener('touchstart', (e) => {
      e.preventDefault();
      joyTouchId = e.touches[0].identifier;
      setPos(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: false });
    window.addEventListener('touchmove', (e) => {
      for (const t of e.touches) {
        if (t.identifier === joyTouchId) { e.preventDefault(); setPos(t.clientX, t.clientY); }
      }
    }, { passive: false });
    window.addEventListener('touchend', (e) => {
      for (const t of e.changedTouches) if (t.identifier === joyTouchId) resetJoy();
    });
    // PC 鼠标兼容
    joyBase.addEventListener('mousedown', (e) => { joyMouse = true; setPos(e.clientX, e.clientY); });
    window.addEventListener('mousemove', (e) => { if (joyMouse) setPos(e.clientX, e.clientY); });
    window.addEventListener('mouseup', resetJoy);
  }

  const bind = (id, onStart, onEnd) => {
    const el = document.getElementById(id);
    if (!el) return;
    const press = () => { el.classList.add('pressed'); onStart(); };
    const release = () => { el.classList.remove('pressed'); onEnd(); };
    el.addEventListener('touchstart', (e) => { e.preventDefault(); press(); }, { passive: false });
    el.addEventListener('touchend', (e) => { e.preventDefault(); release(); }, { passive: false });
    el.addEventListener('touchcancel', (e) => { e.preventDefault(); release(); }, { passive: false });
    el.addEventListener('mousedown', press);
    el.addEventListener('mouseup', release);
    el.addEventListener('mouseleave', release);
  };
  // 加速（按住）
  bind('btnRun', () => { keys.ShiftLeft = true; }, () => { keys.ShiftLeft = false; });
  // 油炸丸子
  bind('btnCro', () => { if (hasBall) croquetaT = 1.0; }, () => {});
  // 传球（地平球，按住蓄力、松开传出）
  bind('btnPass',
    () => { if (!passCharging && !charging && hasBall) { passCharging = true; passCharge = 0; powerbar.style.display = 'block'; } },
    () => { if (passCharging) doPass(); });
  // 射门（按住蓄力、松开踢出）
  bind('btnShoot',
    () => { if (!charging && !passCharging && hasBall) { charging = true; charge = 0; powerbar.style.display = 'block'; } },
    () => { if (charging) doKick(); });
}
initTouchControls();

loadAll().then((r) => {
  player = r.player; playerModel = r.playerModel;
  ball = r.ball; ballModel = r.ballModel;
  document.getElementById('loading').style.display = 'none';
  // 调试/测试接口
  window.__game = {
    player, playerModel, ball, scene, camera, THREE, renderer,
    get ballVel() { return ballVel; },
    get playerVel() { return playerVel; },
    get teamScores() { return teamScores; },
    get loaded() { return true; },
    get localPlayerId() { return localPlayerId; },
    get netHost() { return netHost; },
    get netConnected() { return netConnected; },
    get playersPos() { return players.map(p => [+p.group.position.x.toFixed(2), +p.group.position.z.toFixed(2)]); },
  };
  animate();
}).catch((err) => {
  document.getElementById('loading').innerHTML =
    '<div style="color:#ff8888;font-size:18px">加载失败: ' + (err.message || err) + '</div>';
  console.error(err);
});

// ================= 局域网联机（2v2） =================
let ws = null;
let netConnected = false;
let netHost = false; // 房主 = playerId 0，负责球物理 + 比分
let remoteStates = {}; // playerId -> { x, z, rotY, moving }
let netStateAcc = 0, netBallAcc = 0;

const netPanel = document.getElementById('netPanel');
const roomInfoEl = document.getElementById('roomInfo');
const btnCreate = document.getElementById('btnCreate');
const btnJoin = document.getElementById('btnJoin');
const roomInput = document.getElementById('roomInput');

function setLocalPlayer(id) {
  localPlayerId = id;
  const lp = players[id];
  if (!lp) return;
  player = lp.group;
  playerModel = lp.body;
  playerParts = lp.parts;
}

function connectWs(onReady) {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  ws = new WebSocket(proto + location.host);
  ws.onopen = () => { netConnected = true; if (onReady) onReady(); };
  ws.onmessage = (e) => { try { handleNetMessage(JSON.parse(e.data)); } catch {} };
  ws.onclose = () => { netConnected = false; };
}

function handleNetMessage(msg) {
  switch (msg.type) {
    case 'joined': {
      netHost = (msg.playerId === 0);
      setLocalPlayer(msg.playerId);
      const colorName = ['红', '蓝', '黄', '绿'][msg.playerId];
      const teamName = TEAM_NAMES[msg.team];
      if (netHost) {
        roomInfoEl.innerHTML = `房间号：<div class="roomCode">${msg.roomId}</div><div class="hint">你是${colorName}色（${teamName}队）<br>朋友用同一 WiFi 打开本页，输入房间号加入</div>`;
        netPanel.onclick = () => { netPanel.style.display = 'none'; netPanel.onclick = null; };
      } else {
        roomInfoEl.innerHTML = `已加入房间 <b>${msg.roomId}</b><br>你是${colorName}色（${teamName}队）`;
        setTimeout(() => { netPanel.style.display = 'none'; }, 1500);
      }
      break;
    }
    case 'state': {
      remoteStates[msg.playerId] = { x: msg.x, z: msg.z, rotY: msg.rotY, moving: msg.moving };
      break;
    }
    case 'ball': {
      if (!netHost) { // 非房主：应用房主广播的球状态
        ball.position.set(msg.x, msg.y, msg.z);
        ballVel.set(msg.vx, msg.vy, msg.vz);
      }
      break;
    }
    case 'score': {
      teamScores[0] = msg.scores[0];
      teamScores[1] = msg.scores[1];
      goalsEl.textContent = `${TEAM_NAMES[0]} ${teamScores[0]} : ${teamScores[1]} ${TEAM_NAMES[1]}`;
      break;
    }
    case 'kick': { // 房主收到非房主的踢球动作
      if (netHost) {
        const f = new THREE.Vector3(Math.sin(msg.rotY), 0, Math.cos(msg.rotY));
        ballVel.copy(f).multiplyScalar(msg.power);
        ballVel.y = 2.0 + msg.ratio * 7.0;
        ball.position.set(msg.x + f.x * DRIBBLE_OFF, GROUND_Y + BALL_RADIUS, msg.z + f.z * DRIBBLE_OFF);
      }
      break;
    }
    case 'pass': { // 房主收到非房主的传球动作
      if (netHost) {
        const f = new THREE.Vector3(Math.sin(msg.rotY), 0, Math.cos(msg.rotY));
        ballVel.copy(f).multiplyScalar(msg.power);
        ballVel.y = 0;
        ball.position.set(msg.x + f.x * DRIBBLE_OFF, GROUND_Y + BALL_RADIUS, msg.z + f.z * DRIBBLE_OFF);
      }
      break;
    }
    case 'error': {
      roomInfoEl.innerHTML = `❌ ${msg.msg}`;
      break;
    }
  }
}

btnCreate.onclick = () => {
  roomInfoEl.innerHTML = '正在创建房间...';
  connectWs(() => { ws.send(JSON.stringify({ type: 'create' })); });
};
btnJoin.onclick = () => {
  const code = roomInput.value.trim().toUpperCase();
  if (!code) { roomInfoEl.innerHTML = '请输入房间号'; return; }
  roomInfoEl.innerHTML = '正在加入房间...';
  connectWs(() => { ws.send(JSON.stringify({ type: 'join', roomId: code })); });
};

// 每帧联机同步（由 update 调用）
function netSync(dt, moving) {
  if (!netConnected || !ws || ws.readyState !== 1) return;
  // 上报本地位置（20fps）
  netStateAcc += dt;
  if (netStateAcc > 0.05) {
    netStateAcc = 0;
    ws.send(JSON.stringify({ type: 'state', x: player.position.x, z: player.position.z, rotY: player.rotation.y, moving }));
  }
  // 房主广播球状态（20fps）
  if (netHost) {
    netBallAcc += dt;
    if (netBallAcc > 0.05) {
      netBallAcc = 0;
      ws.send(JSON.stringify({ type: 'ball', x: ball.position.x, y: ball.position.y, z: ball.position.z, vx: ballVel.x, vy: ballVel.y, vz: ballVel.z }));
    }
  }
}
