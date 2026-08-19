// ==========================================
// BACKGROUND RENDERER（ラウンド3: 低解像度ピクセルアート方式）
// ==========================================
// main.js からは drawMap(ctx, frame) の形で1関数だけ呼び出す。
// 当たり判定に使われる座標(GRASS_ZONES/SHOP_DOOR/建物位置)は一切変更しない。
//
// ラウンド3の是正:
// - 800x600の1/4(200x150)のオフスクリーンCanvasに描画し、
//   imageSmoothingEnabled=false でニアレストネイバー拡大してblitする。
//   これにより輪郭が強制的にドットの階段になる。
// - arc()/createRadialGradient()/rotate()を使った滑らかな図形・グロー・ぼかしを全廃し、
//   すべて軸並行の矩形と、階調を段階的に切り替える塗りだけで構成した。
// - ハンガーラック相当は既に撤去済み(ラウンド2)。今回は道の直線的な縁・木の単調さ・
//   店先の色物・池の表現・パララックスの視認性・ロゴの寒色反映を是正した。
// - プレイヤー/仲間/モンスターの描画(main.js側)には触れていない。

// --- 当たり判定に使われる座標（変更しない・ワールド座標のまま） ---
const BG_GRASS_ZONES = [
  { x: 220, y: 170, w: 100, h: 60 },
  { x: 500, y: 200, w: 80, h: 100 },
  { x: 350, y: 300, w: 80, h: 120 },
  { x: 450, y: 470, w: 120, h: 50 }
];
const BG_SHOP_DOOR = { x: 550, y: 140, w: 20, h: 20 };
const BG_SHOP_BUILDING = { x: 530, y: 100, w: 60, h: 60 };
const BG_HOUSE = { x: 150, y: 100, w: 80, h: 110 };
const BG_HOUSE_DOOR = { x: 180, y: 170, w: 20, h: 40 };
const ROAD_TOP = { x: 200, y: 150, w: 400, h: 60 };
const ROAD_BOTTOM = { x: 200, y: 450, w: 400, h: 60 };
const ROAD_DIAG = [{ x: 600, y: 150 }, { x: 200, y: 450 }, { x: 260, y: 450 }, { x: 660, y: 150 }];
const POND = { cx: 660, cy: 275, r: 40 };

// --- 低解像度キャンバス設定（4倍拡大） ---
const SCALE = 4;
const LOW_W = 200, LOW_H = 150; // 800/4, 600/4
function L(v) { return Math.round(v / SCALE); } // ワールド座標 -> 低解像度座標

// --- パレット（ロゴの寒色: ターコイズ/淡いシアン/藤色を随所に混ぜる） ---
const COOL = { turquoise: '#40e0d0', cyan: '#b0f0f0', wisteria: '#9060a0' };
const COL = {
  fieldDark: '#3c6a44', fieldBase: '#4a7a4f', fieldLight: '#6fae76',
  fieldDew: COOL.cyan,
  roadDark: '#b39a6d', roadBase: '#d8c398', roadLight: '#efe3c0',
  pebble: '#8f7a58', deadgrass: '#9a8f52',
  grassDark: '#1f5c28', grassBase: '#2f7d32', grassLight: '#5fd6b8',
  trunk: '#5a3d24', trunkDark: '#3f2a18', trunkLight: '#7a5636',
  oak: ['#2f7d32', '#357a3a', '#276b30'], oakHi: '#6fd6a0', oakLo: '#1f4f26',
  pine: ['#1f4f3a', '#276642', '#2d7549'], pineHi: '#4fb590',
  deadwood: '#6b5a45',
  rockDark: '#525259', rockBase: '#75757e', rockLight: '#a3a3ac',
  ruinDark: '#5a564e', ruinBase: '#86806f', ruinLight: '#b0a894',
  mushCapA: '#c0392b', mushCapB: '#8e44ad', mushStem: '#f0ead6',
  flower: [COOL.cyan, '#ffe066', COOL.wisteria, '#f4a6c6'],
  waterDeep: '#0e3550', waterMid: '#1c6078', waterShallow: '#3fa0a8',
  waterHi: COOL.turquoise, wetSand: '#8a7a52',
  houseDark: '#171340', houseBase: '#241f6b', houseLight: '#3a2fa0', houseWindow: '#6a5fd1',
  houseGlowIn: '#ffe680', houseGlowOut: '#8a6a20',
  houseDoorDark: '#0d0a2e', houseDoorBase: '#130f40', houseHandle: '#f1c40f',
  roofDark: '#12102f', roofLight: '#201a52',
  shopWallDark: '#c8bc9e', shopWallBase: '#ece0c8', shopWallLight: '#fbf6ea',
  shopAwningDark: '#a33232', shopAwningBase: '#d94f4f',
  shopDoorBase: '#f1c40f', shopDoorDark: '#c99a0e', shopDoorLight: '#ffe066',
  barrel: '#7a4a25', barrelBand: '#4a3018', jar: '#b5714a', jarNeck: '#6b4028',
  lanternBody: '#3a3530', lanternGlow: '#ffdd66', scroll: '#e6d6a8', scrollDark: '#b89f6a',
  vignette: 'rgba(10,8,20,'
};

// ==========================================
// 値ノイズ（連続。市松を作らないための帯分けに使う。滑らかなブレンドには使わない）
// ==========================================
function makeNoise(seed, cell) {
  let s = seed >>> 0;
  function rnd() { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }
  const gw = Math.ceil(800 / cell) + 2, gh = Math.ceil(600 / cell) + 2;
  const lat = new Float32Array(gw * gh);
  for (let i = 0; i < lat.length; i++) lat[i] = rnd() * 2 - 1;
  function smooth(t) { return t * t * (3 - 2 * t); }
  return function (x, y) {
    const gx = x / cell, gy = y / cell;
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const tx = smooth(gx - x0), ty = smooth(gy - y0);
    const i00 = y0 * gw + x0, i10 = i00 + 1, i01 = i00 + gw, i11 = i01 + 1;
    const v00 = lat[i00] || 0, v10 = lat[i10] || 0, v01 = lat[i01] || 0, v11 = lat[i11] || 0;
    const a = v00 + (v10 - v00) * tx, b = v01 + (v11 - v01) * tx;
    return a + (b - a) * ty;
  };
}
const noiseCoarse = makeNoise(1337, 44);
const noiseFine = makeNoise(9001, 9);
const noiseGrit = makeNoise(555, 3);
function edgeJitter(seedKey, idx, maxSteps) {
  // 1次元の疑似乱数（境界を1〜3ドット単位で不規則に食い込ませるための整数ジッタ）
  let h = (seedKey * 374761393 + idx * 668265263) >>> 0;
  h = (h ^ (h >>> 13)) * 1274126177 >>> 0;
  return (h % (maxSteps * 2 + 1)) - maxSteps;
}

// ==========================================
// 領域判定（ワールド座標）
// ==========================================
function inRect(x, y, r) { return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h; }
function inPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}
// 道の判定に、行/列ごとの整数ジッタで不規則な縁を持たせる
function isRoadPx(x, y) {
  const topJit = edgeJitter(11, Math.floor(x / 4), 3) * 4;
  const botJit = edgeJitter(13, Math.floor(x / 4), 3) * 4;
  if (x >= ROAD_TOP.x && x < ROAD_TOP.x + ROAD_TOP.w && y >= ROAD_TOP.y - topJit && y < ROAD_TOP.y + ROAD_TOP.h + topJit) return true;
  if (x >= ROAD_BOTTOM.x && x < ROAD_BOTTOM.x + ROAD_BOTTOM.w && y >= ROAD_BOTTOM.y - botJit && y < ROAD_BOTTOM.y + ROAD_BOTTOM.h + botJit) return true;
  const dx = ROAD_DIAG[1].x - ROAD_DIAG[0].x, dy = ROAD_DIAG[1].y - ROAD_DIAG[0].y;
  const len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
  const relx = x - ROAD_DIAG[0].x, rely = y - ROAD_DIAG[0].y;
  const t = relx * ux + rely * uy;
  if (t < -10 || t > len + 10) return false;
  const perp = relx * nx + rely * ny; // 帯の中心線からの距離（符号あり）
  const halfWidth = 40 + Math.sin(t * 0.05) * 8; // 幅を揺らして「Z」感を崩す
  const jit = edgeJitter(17, Math.floor(t / 4), 3) * 4;
  return Math.abs(perp - 30) < halfWidth + jit; // 元の帯中心(法線方向+30)基準
}
function isWaterPx(x, y) {
  const dx = x - POND.cx, dy = y - POND.cy;
  const jitter = edgeJitter(19, Math.floor(Math.atan2(dy, dx) * 20), 2) * 4;
  const edge = POND.r + jitter;
  return (dx * dx + dy * dy) < edge * edge;
}
function distToRoadCenterOrField(x, y) { return isRoadPx(x, y); }

// ==========================================
// 低解像度キャンバス群
// ==========================================
const groundLow = document.createElement('canvas'); groundLow.width = LOW_W; groundLow.height = LOW_H;
const gctx = groundLow.getContext('2d');
const objectsLow = document.createElement('canvas'); objectsLow.width = LOW_W; objectsLow.height = LOW_H;
const octx = objectsLow.getContext('2d');
const frameLow = document.createElement('canvas'); frameLow.width = LOW_W; frameLow.height = LOW_H;
const fctx = frameLow.getContext('2d');
[gctx, octx, fctx].forEach(c => { c.imageSmoothingEnabled = false; });

// ==========================================
// 地面（field / road / water）を低解像度ピクセル単位で塗る。すべて離散階調。
// ==========================================
function fieldBandAt(wx, wy) {
  const n = noiseCoarse(wx, wy) + noiseFine(wx, wy) * 0.4;
  if (n < -0.28) return COL.fieldDark;
  if (n < 0.22) return COL.fieldBase;
  return COL.fieldLight;
}
function roadBandAt(wx, wy) {
  const n = noiseCoarse(wx, wy) * 0.9 + noiseGrit(wx, wy) * 0.5;
  if (n < -0.32) return COL.roadDark;
  if (n < 0.28) return COL.roadBase;
  return COL.roadLight;
}
function waterBandAt(wx, wy) {
  const dx = wx - POND.cx, dy = wy - POND.cy;
  const d = Math.sqrt(dx * dx + dy * dy) / POND.r;
  const ripple = noiseFine(wx, wy) * 0.06;
  const dd = d + ripple;
  if (dd > 0.92) return COL.wetSand;
  if (dd > 0.62) return COL.waterShallow;
  if (dd > 0.3) return COL.waterMid;
  return COL.waterDeep;
}

function buildGround() {
  for (let ly = 0; ly < LOW_H; ly++) {
    for (let lx = 0; lx < LOW_W; lx++) {
      const wx = lx * SCALE, wy = ly * SCALE;
      let col;
      const onWater = isWaterPx(wx, wy);
      const onRoad = !onWater && isRoadPx(wx, wy);
      if (onWater) {
        col = waterBandAt(wx, wy);
      } else if (onRoad) {
        col = roadBandAt(wx, wy);
        // 道と外側の境界1〜2ドットに、小石/土/剥げた草の遷移帯を混ぜる
        const edgeNoise = noiseGrit(wx, wy);
        if (!isRoadPx(wx - SCALE * 2, wy) || !isRoadPx(wx + SCALE * 2, wy) || !isRoadPx(wx, wy - SCALE * 2) || !isRoadPx(wx, wy + SCALE * 2)) {
          if (edgeNoise > 0.5) col = COL.pebble; else if (edgeNoise < -0.5) col = COL.deadgrass;
        }
      } else {
        col = fieldBandAt(wx, wy);
        // 道の外周1ドット分に遷移帯（土の粒・剥げた草）
        if (isRoadPx(wx - SCALE, wy) || isRoadPx(wx + SCALE, wy) || isRoadPx(wx, wy - SCALE) || isRoadPx(wx, wy + SCALE)) {
          const eg = noiseGrit(wx, wy);
          if (eg > 0.4) col = COL.pebble; else if (eg < -0.3) col = COL.deadgrass;
        } else if (noiseGrit(wx, wy) > 0.86) {
          col = COL.fieldDew; // ロゴの寒色を光の粒として散らす
        }
      }
      gctx.fillStyle = col;
      gctx.fillRect(lx, ly, 1, 1);
    }
  }
  // 踏み固め跡（線のみ・控えめ）
  gctx.fillStyle = 'rgba(253,246,227,0.35)';
  for (let lx = L(ROAD_TOP.x) + 2; lx < L(ROAD_TOP.x + ROAD_TOP.w) - 2; lx += 4) gctx.fillRect(lx, L(ROAD_TOP.y + ROAD_TOP.h / 2), 2, 1);
  for (let lx = L(ROAD_BOTTOM.x) + 2; lx < L(ROAD_BOTTOM.x + ROAD_BOTTOM.w) - 2; lx += 4) gctx.fillRect(lx, L(ROAD_BOTTOM.y + ROAD_BOTTOM.h / 2), 2, 1);
}

// ==========================================
// 草むら（不定形の房。矩形の重なりのみで表現）
// ==========================================
const thicketClusters = [];
(function precomputeThickets() {
  let seed = 91;
  function rnd() { seed = (seed * 1103515245 + 12345) >>> 0; return (seed % 10000) / 10000; }
  BG_GRASS_ZONES.forEach(z => {
    const lz = { x: L(z.x), y: L(z.y), w: L(z.w), h: L(z.h) };
    const blobs = [];
    const count = 5 + Math.floor(rnd() * 3);
    for (let i = 0; i < count; i++) {
      blobs.push({ dx: Math.round(rnd() * lz.w), dy: Math.round(rnd() * lz.h), r: 3 + Math.round(rnd() * 3), shade: rnd() });
    }
    thicketClusters.push({ lz, blobs });
  });
})();
function pixelBlob(c, cx, cy, r, colorFn) {
  for (let dy = -r; dy <= r; dy++) {
    const span = Math.round(Math.sqrt(Math.max(0, r * r - dy * dy)));
    for (let dx = -span; dx <= span; dx++) {
      c.fillStyle = colorFn(dx, dy);
      c.fillRect(cx + dx, cy + dy, 1, 1);
    }
  }
}
function drawThicket(entry) {
  const { lz, blobs } = entry;
  // 落ち影（硬い形。矩形の階段）
  gctx.fillStyle = 'rgba(8,20,12,0.4)';
  gctx.fillRect(lz.x + 1, lz.y + lz.h - 1, lz.w, 2);
  blobs.forEach(b => {
    const cx = lz.x + b.dx, cy = lz.y + b.dy;
    pixelBlob(gctx, cx, cy, b.r, (dx, dy) => {
      const rimLit = (dx <= 0 && dy <= 0);
      if (b.shade < 0.3) return COL.grassDark;
      if (rimLit && (dx + dy) < -b.r * 0.5) return COL.grassLight; // 寒色寄りのハイライト(#5fd6b8)
      return COL.grassBase;
    });
  });
}

// ブレード（毎フレーム波打つ。低解像度1ドット幅）
const grassBlades = [];
(function precomputeGrassBlades() {
  let idx = 0;
  BG_GRASS_ZONES.forEach(z => {
    const lz = { x: L(z.x), y: L(z.y), w: L(z.w), h: L(z.h) };
    for (let gx = lz.x + 1; gx < lz.x + lz.w - 1; gx += 2) {
      for (let gy = lz.y + 2; gy < lz.y + lz.h - 1; gy += 3) {
        idx++;
        grassBlades.push({ x: gx, y: gy, phase: ((gx + gy)) * 0.4, isLight: idx % 6 === 0 });
      }
    }
  });
})();

// ==========================================
// オブジェクト散布（木・岩・切り株・きのこ・花・遺構・焚き火跡）低解像度単位
// ==========================================
const OBSTACLES = [ROAD_TOP, ROAD_BOTTOM, BG_HOUSE, BG_SHOP_BUILDING, ...BG_GRASS_ZONES,
  { x: POND.cx - POND.r - 10, y: POND.cy - POND.r - 10, w: (POND.r + 10) * 2, h: (POND.r + 10) * 2 }];
function blockedByObstacle(x, y, pad) {
  for (const o of OBSTACLES) { if (x > o.x - pad && x < o.x + o.w + pad && y > o.y - pad && y < o.y + o.h + pad) return true; }
  if (isRoadPx(x, y)) return true;
  return false;
}
let rngState = 7331;
function rng() { rngState = (rngState * 1103515245 + 12345) >>> 0; return (rngState % 100000) / 100000; }

const decorations = [];
(function scatterDecorations() {
  const placed = [];
  function tryPlace(type, xr, yr, count, minPad, weights) {
    let attempts = 0, done = 0;
    while (done < count && attempts < count * 40) {
      attempts++;
      const x = xr[0] + rng() * (xr[1] - xr[0]);
      const y = yr[0] + rng() * (yr[1] - yr[0]);
      if (blockedByObstacle(x, y, 14)) continue;
      let tooClose = false;
      for (const p of placed) { if (Math.hypot(p.x - x, p.y - y) < (minPad + rng() * 10)) { tooClose = true; break; } }
      if (tooClose) continue;
      let subtype = type;
      if (weights) { const r = rng(); let acc = 0; for (const w of weights) { acc += w.p; if (r < acc) { subtype = w.t; break; } } }
      const item = { type: subtype, x, y, scale: 0.8 + rng() * 0.5, hue: rng(), flip: rng() < 0.5 ? -1 : 1 };
      placed.push(item); decorations.push(item); done++;
    }
  }
  const treeWeights = [{ t: 'oak', p: 0.5 }, { t: 'pine', p: 0.25 }, { t: 'dead', p: 0.1 }, { t: 'sapling', p: 0.15 }];
  tryPlace('tree', [8, 792], [8, 60], 12, 30, treeWeights);
  tryPlace('tree', [8, 792], [548, 592], 12, 30, treeWeights);
  tryPlace('tree', [8, 55], [8, 592], 9, 30, treeWeights);
  tryPlace('tree', [748, 792], [8, 592], 9, 30, treeWeights);
  tryPlace('ruin', [130, 280], [270, 350], 3, 34);
  tryPlace('campfire', [90, 200], [420, 540], 1, 34);
  tryPlace('tree', [90, 720], [70, 540], 15, 46, treeWeights);
  tryPlace('rock', [90, 720], [70, 540], 10, 34);
  tryPlace('stump', [90, 720], [70, 540], 6, 40);
  tryPlace('mushroom', [90, 720], [70, 540], 8, 22);
  tryPlace('flower', [90, 720], [70, 540], 10, 20);
  decorations.sort((a, b) => a.y - b.y);
})();

// --- 描画プリミティブ（矩形のみ。回転・円弧・グラデーション不使用） ---
function shadow(c, lx, ly, w, h) { c.fillStyle = 'rgba(8,18,10,0.38)'; c.fillRect(Math.round(lx - w / 2) + 1, Math.round(ly) + 1, Math.round(w), Math.max(1, Math.round(h))); }

function drawOak(c, lx, ly, s, hue) {
  const trunkH = Math.round(4 * s);
  shadow(c, lx, ly, 6 * s, 2);
  c.fillStyle = COL.trunkDark; c.fillRect(Math.round(lx - 1), ly - trunkH, 2, trunkH);
  c.fillStyle = COL.trunk; c.fillRect(Math.round(lx - 1), ly - trunkH, 1, trunkH);
  c.fillStyle = COL.trunkLight; c.fillRect(Math.round(lx), ly - 1, 1, 1); // 根元の広がり
  const clumps = [
    { dx: 0, dy: -Math.round(9 * s), r: Math.round(4 * s) },
    { dx: -Math.round(3 * s), dy: -Math.round(6 * s), r: Math.round(3 * s) },
    { dx: Math.round(3 * s), dy: -Math.round(6 * s), r: Math.round(3 * s) },
    { dx: 0, dy: -Math.round(5 * s), r: Math.round(3 * s) }
  ];
  const palette = [COL.oak[Math.floor(hue * 3) % 3], COL.oak[(Math.floor(hue * 3) + 1) % 3], COL.oak[(Math.floor(hue * 3) + 2) % 3]];
  clumps.forEach((b, i) => {
    pixelBlob(c, lx + b.dx, ly + b.dy, b.r, (dx, dy) => {
      if (dx <= -1 && dy <= -1) return i === 0 ? COL.oakHi : palette[0];
      if (dx >= 1 && dy >= 1) return COL.oakLo;
      return palette[i % palette.length];
    });
  });
}
function drawPine(c, lx, ly, s) {
  shadow(c, lx, ly, 5 * s, 2);
  const trunkH = Math.round(3 * s);
  c.fillStyle = COL.trunkDark; c.fillRect(Math.round(lx - 1), ly - trunkH, 2, trunkH);
  const tiers = [7, 6, 5, 3.6, 2.2];
  let cy = ly - trunkH;
  for (let i = 0; i < tiers.length; i++) {
    const w = Math.max(1, Math.round(tiers[i] * s));
    const h = Math.max(1, Math.round(2.4 * s));
    cy -= h;
    c.fillStyle = COL.pine[i % COL.pine.length];
    c.fillRect(Math.round(lx - w / 2), cy, w, h);
    c.fillStyle = COL.pineHi; c.fillRect(Math.round(lx - w / 2), cy, Math.max(1, Math.round(w * 0.3)), 1);
    c.fillStyle = COL.pine[0]; c.fillRect(Math.round(lx + w / 2 - Math.round(w * 0.3)), cy + h - 1, Math.round(w * 0.3), 1);
  }
}
function drawDeadTree(c, lx, ly, s, flip) {
  shadow(c, lx, ly, 4 * s, 2);
  let cx = lx;
  const segs = 5;
  for (let i = 0; i < segs; i++) {
    const h = Math.round(2.4 * s);
    c.fillStyle = i % 2 === 0 ? COL.deadwood : COL.trunkDark;
    c.fillRect(Math.round(cx - 1), ly - h * (i + 1), 2, h);
    cx += flip * (i % 2 === 0 ? 1 : 0);
  }
  // 枝
  c.fillStyle = COL.trunkDark;
  c.fillRect(Math.round(cx - 3), ly - Math.round(9 * s), 3, 1);
  c.fillRect(Math.round(cx + 1), ly - Math.round(6 * s), 3, 1);
}
function drawSapling(c, lx, ly, s) {
  shadow(c, lx, ly, 2.5 * s, 1);
  c.fillStyle = COL.trunk; c.fillRect(Math.round(lx), ly - Math.round(3 * s), 1, Math.round(3 * s));
  pixelBlob(c, lx, ly - Math.round(4 * s), Math.max(1, Math.round(2 * s)), (dx, dy) => dx <= 0 && dy <= 0 ? COL.oakHi : COL.oak[1]);
}
function drawTree(c, o) {
  const lx = L(o.x), ly = L(o.y), s = o.scale;
  if (o.type === 'pine') drawPine(c, lx, ly, s);
  else if (o.type === 'dead') drawDeadTree(c, lx, ly, s, o.flip);
  else if (o.type === 'sapling') drawSapling(c, lx, ly, s);
  else drawOak(c, lx, ly, s, o.hue);
}
function drawRock(c, o) {
  const lx = L(o.x), ly = L(o.y), s = o.scale;
  shadow(c, lx, ly, 5 * s, 2);
  const w = Math.max(2, Math.round(4 * s)), h = Math.max(2, Math.round(3 * s));
  c.fillStyle = COL.rockBase; c.fillRect(lx - Math.round(w / 2), ly - h, w, h);
  c.fillStyle = COL.rockDark; c.fillRect(lx - Math.round(w / 2) + Math.round(w * 0.5), ly - Math.round(h * 0.5), Math.round(w * 0.5), Math.round(h * 0.5));
  c.fillStyle = COL.rockLight; c.fillRect(lx - Math.round(w / 2), ly - h, Math.round(w * 0.5), Math.max(1, Math.round(h * 0.35)));
  c.fillStyle = COL.rockBase; c.fillRect(lx - Math.round(w / 2) - 1, ly - Math.round(h * 0.4), Math.round(w * 0.3) + 1, Math.round(h * 0.4));
}
function drawStump(c, o) {
  const lx = L(o.x), ly = L(o.y), s = o.scale;
  shadow(c, lx, ly, 4 * s, 1);
  const w = Math.max(2, Math.round(3.6 * s));
  c.fillStyle = COL.trunkDark; c.fillRect(lx - Math.round(w / 2), ly - Math.round(2 * s), w, Math.round(2 * s));
  c.fillStyle = '#caa46b'; c.fillRect(lx - Math.round(w / 2) + 1, ly - Math.round(2.4 * s), w - 2, Math.round(1.2 * s));
  c.fillStyle = COL.trunkDark; c.fillRect(lx - 1, ly - Math.round(2.2 * s), 2, 1);
}
function drawMushroom(c, o) {
  const lx = L(o.x), ly = L(o.y), s = o.scale;
  shadow(c, lx, ly, 2.5 * s, 1);
  c.fillStyle = COL.mushStem; c.fillRect(lx, ly - Math.round(2 * s), 1, Math.round(2 * s));
  const capColor = o.hue < 0.5 ? COL.mushCapA : COL.mushCapB;
  const rows = [3, 5, 5];
  let cy = ly - Math.round(2 * s) - rows.length;
  rows.forEach((w, i) => { c.fillStyle = capColor; c.fillRect(lx - Math.round(w * s / 2), cy + i, Math.max(1, Math.round(w * s)), 1); });
  c.fillStyle = '#fff'; c.fillRect(lx - 1, cy, 1, 1);
}
function drawFlower(c, o) {
  const lx = L(o.x), ly = L(o.y), s = o.scale;
  c.fillStyle = COL.grassBase; c.fillRect(lx, ly - Math.round(2 * s), 1, Math.round(2 * s));
  c.fillStyle = COL.flower[Math.floor(o.hue * COL.flower.length)];
  c.fillRect(lx - 1, ly - Math.round(2.6 * s), 1, 1); c.fillRect(lx + 1, ly - Math.round(2.6 * s), 1, 1);
  c.fillRect(lx, ly - Math.round(3.2 * s), 1, 1); c.fillRect(lx, ly - Math.round(2 * s), 1, 1);
}
function drawRuin(c, o) {
  const lx = L(o.x), ly = L(o.y), s = o.scale;
  shadow(c, lx, ly, 5 * s, 2);
  const blocks = [[0, 0, 5, 2], [1, -2, 4, 2], [-1, -4, 4, 2]];
  blocks.forEach((b, i) => {
    const bx = lx + Math.round(b[0] * s), by = ly + Math.round(b[1] * s);
    const bw = Math.max(1, Math.round(b[2] * s)), bh = Math.max(1, Math.round(b[3] * s));
    c.fillStyle = i % 2 === 0 ? COL.ruinBase : COL.ruinDark;
    c.fillRect(bx - Math.round(bw / 2), by - bh, bw, bh);
    c.fillStyle = COL.ruinLight; c.fillRect(bx - Math.round(bw / 2), by - bh, bw, 1);
  });
}
function drawCampfire(c, o) {
  const lx = L(o.x), ly = L(o.y), s = o.scale;
  shadow(c, lx, ly, 5 * s, 2);
  const positions = [[-3, 0], [3, 0], [-2, 1], [2, 1], [0, -1], [0, 2]];
  positions.forEach(p => { c.fillStyle = COL.rockBase; c.fillRect(lx + Math.round(p[0] * s) - 1, ly + Math.round(p[1] * s) - 1, 1, 1); });
  c.fillStyle = '#241f1a'; c.fillRect(lx - Math.round(1.6 * s), ly - 1, Math.round(3.2 * s), 2);
  c.fillStyle = '#d9822b'; c.fillRect(lx, ly - 1, 1, 1);
}
const DECOR_DRAW = { tree: drawTree, rock: drawRock, stump: drawStump, mushroom: drawMushroom, flower: drawFlower, ruin: drawRuin, campfire: drawCampfire };

// ==========================================
// 建物（低解像度・矩形のみ／窓明かりはグラデーションでなく二重矩形の階調で表現）
// ==========================================
function drawBrickWall(c, x, y, w, h, dark, base) {
  c.fillStyle = base; c.fillRect(x, y, w, h);
  c.fillStyle = dark;
  for (let ry = y; ry < y + h; ry += 2) {
    const offset = (Math.floor((ry - y) / 2) % 2 === 0) ? 0 : 2;
    for (let bx = x + offset; bx < x + w; bx += 4) c.fillRect(bx, ry, 1, 2);
  }
}
function drawCottage() {
  const h = { x: L(BG_HOUSE.x), y: L(BG_HOUSE.y), w: L(BG_HOUSE.w), h: L(BG_HOUSE.h) };
  octx.fillStyle = 'rgba(8,18,10,0.38)'; octx.fillRect(h.x, h.y + h.h, h.w, 2);
  drawBrickWall(octx, h.x, h.y, h.w, h.h, COL.houseDark, COL.houseBase);
  octx.fillStyle = COL.houseLight; octx.fillRect(h.x, h.y, 1, h.h);
  // 屋根（瓦の帯・矩形の階段で三角を近似）
  const roofRows = 8;
  for (let i = 0; i < roofRows; i++) {
    const w = h.w + 4 - i * Math.round((h.w + 4) / roofRows);
    octx.fillStyle = i % 2 === 0 ? COL.roofDark : COL.roofLight;
    octx.fillRect(h.x + h.w / 2 - w / 2, h.y - 2 - (roofRows - i), w, 1);
  }
  // 窓＋灯り（二重矩形の階調でグローを表現。控えめなサイズに）
  const wx = h.x + h.w - 7, wy = h.y + 8;
  octx.fillStyle = COL.houseGlowOut; octx.fillRect(wx - 1, wy - 1, 5, 5);
  octx.fillStyle = COL.houseWindow; octx.fillRect(wx, wy, 3, 3);
  octx.fillStyle = COL.houseGlowIn; octx.fillRect(wx, wy, 1, 1);
  octx.fillStyle = COL.houseDark; octx.fillRect(wx + 1, wy, 1, 3); octx.fillRect(wx, wy + 1, 3, 1);
  // 扉
  const d = { x: L(BG_HOUSE_DOOR.x), y: L(BG_HOUSE_DOOR.y), w: L(BG_HOUSE_DOOR.w), h: L(BG_HOUSE_DOOR.h) };
  octx.fillStyle = COL.houseDoorBase; octx.fillRect(d.x, d.y, d.w, d.h);
  octx.fillStyle = COL.houseDoorDark; octx.fillRect(d.x, d.y, 1, d.h);
  octx.fillStyle = COL.houseHandle; octx.fillRect(d.x + d.w - 1, d.y + Math.round(d.h / 2), 1, 1);
}
function drawStall() {
  const s = { x: L(BG_SHOP_BUILDING.x), y: L(BG_SHOP_BUILDING.y), w: L(BG_SHOP_BUILDING.w), h: L(BG_SHOP_BUILDING.h) };
  octx.fillStyle = 'rgba(8,18,10,0.32)'; octx.fillRect(s.x, s.y + s.h, s.w, 2);
  drawBrickWall(octx, s.x, s.y, s.w, s.h, COL.shopWallDark, COL.shopWallBase);
  octx.fillStyle = COL.shopWallLight; octx.fillRect(s.x, s.y, s.w, 1);
  // 日よけ庇（縦ストライプ、台形は矩形の階段で近似）
  for (let i = 0; i < 4; i++) {
    const yy = s.y - 4 + i;
    const inset = 3 - i;
    octx.fillStyle = '#000'; // placeholder overwritten below (avoid unused var warnings)
    for (let sx = s.x - inset; sx < s.x + s.w + inset; sx += 2) {
      octx.fillStyle = (Math.floor((sx - s.x) / 2)) % 2 === 0 ? COL.shopAwningBase : COL.shopWallLight;
      octx.fillRect(sx, yy, 2, 1);
    }
  }
  octx.fillStyle = COL.shopAwningDark; octx.fillRect(s.x - 3, s.y - 5, s.w + 6, 1);
  // 道具屋の品（樽・壺・ランタン・巻物。服のカラフルな縦棒は撤去）
  const gx = s.x + 2, gy = s.y + s.h - 5;
  octx.fillStyle = COL.barrel; octx.fillRect(gx, gy, 3, 4);
  octx.fillStyle = COL.barrelBand; octx.fillRect(gx, gy, 3, 1); octx.fillRect(gx, gy + 3, 3, 1);
  octx.fillStyle = COL.jar; octx.fillRect(gx + 4, gy + 1, 2, 3);
  octx.fillStyle = COL.jarNeck; octx.fillRect(gx + 4, gy, 2, 1);
  octx.fillStyle = COL.scroll; octx.fillRect(gx + 7, gy + 2, 3, 1);
  octx.fillStyle = COL.scrollDark; octx.fillRect(gx + 7, gy + 2, 1, 1); octx.fillRect(gx + 9, gy + 2, 1, 1);
  octx.fillStyle = COL.lanternBody; octx.fillRect(gx + 11, gy, 2, 3);
  octx.fillStyle = COL.lanternGlow; octx.fillRect(gx + 11, gy + 1, 2, 1);
  // 扉
  const d = { x: L(BG_SHOP_DOOR.x), y: L(BG_SHOP_DOOR.y), w: L(BG_SHOP_DOOR.w), h: L(BG_SHOP_DOOR.h) };
  octx.fillStyle = COL.shopDoorDark; octx.fillRect(d.x, d.y, d.w, Math.ceil(d.h / 3));
  octx.fillStyle = COL.shopDoorBase; octx.fillRect(d.x, d.y + Math.ceil(d.h / 3), d.w, Math.ceil(d.h / 3));
  octx.fillStyle = COL.shopDoorLight; octx.fillRect(d.x, d.y + Math.ceil(d.h * 2 / 3), d.w, d.h - Math.ceil(d.h * 2 / 3));
  octx.fillStyle = '#fff'; octx.font = "bold 4px DotGothic16"; octx.fillText("SHOP", s.x + 1, s.y - 6);
}

// ==========================================
// 遠景パララックス（オブジェクト層の後に描き、確実に視認できるようにする）
// ==========================================
let farOffset = 0, islandOffset = 0, dragonX = -30;
const MOUNTAIN_Y = 20; // UIの上部バー(実測 約66world px)の下、確実に見える位置
const farMountains = [{ x: 20, w: 34 }, { x: 70, w: 46 }, { x: 130, w: 30 }, { x: 175, w: 24 }];
const floatIslands = [{ side: 'l', y: 22, s: 1 }, { side: 'l', y: 44, s: 0.9 }, { side: 'r', y: 24, s: 1 }, { side: 'r', y: 46, s: 1.1 }];
function drawFarParallax(c, frame) {
  farOffset -= 0.02;
  c.fillStyle = COOL.wisteria; c.globalAlpha = 0.7;
  farMountains.forEach(m => {
    const mx = Math.round(((m.x + farOffset) % 220 + 220) % 220) - 20;
    const w = m.w, h = 8;
    for (let i = 0; i < h; i++) { const rw = w - i * Math.round(w / h); c.fillRect(mx + (w - rw) / 2, MOUNTAIN_Y + i, Math.max(1, rw), 1); }
  });
  c.fillStyle = COOL.turquoise; c.globalAlpha = 0.5;
  farMountains.forEach(m => {
    const mx = Math.round(((m.x + farOffset) % 220 + 220) % 220) - 20;
    c.fillRect(mx + Math.round(m.w / 2) - 1, MOUNTAIN_Y, 2, 1); // 稜線のハイライト(寒色)
  });
  c.globalAlpha = 1;
  islandOffset -= 0.01;
  floatIslands.forEach(is => {
    const drift = Math.round(Math.sin((islandOffset + is.y) * 0.02) * 2);
    const x = is.side === 'l' ? 6 + drift : LOW_W - 12 + drift;
    const w = Math.max(3, Math.round(7 * is.s)), h = Math.max(2, Math.round(3 * is.s));
    c.fillStyle = COOL.turquoise; c.globalAlpha = 0.6; c.fillRect(x, is.y, w, h);
    c.fillStyle = COOL.wisteria; c.globalAlpha = 0.6; c.fillRect(x + 1, is.y + h, Math.max(1, w - 2), 1);
    c.globalAlpha = 1;
  });
  dragonX += 0.12; if (dragonX > LOW_W + 30) dragonX = -30;
  const dy = MOUNTAIN_Y + 6 + Math.round(Math.sin(dragonX * 0.05) * 2);
  c.fillStyle = COOL.wisteria; c.globalAlpha = 0.55;
  c.fillRect(dragonX, dy, 6, 2);
  c.fillRect(dragonX - 4, dy - 1, 4, 1); c.fillRect(dragonX + 6, dy - 1, 4, 1);
  c.globalAlpha = 1;
}

// ==========================================
// 影の流れ（雲影）: 半透明の硬い矩形。ぼかし無し
// ==========================================
const bgShadowFlow = [];
for (let i = 0; i < 6; i++) bgShadowFlow.push({ x: Math.random() * LOW_W, y: Math.random() * LOW_H, w: 14 + Math.random() * 16, h: 6 + Math.random() * 6, speed: 0.06 + Math.random() * 0.1 });
function drawShadowFlow(c) {
  c.fillStyle = 'rgba(14,20,16,0.16)';
  bgShadowFlow.forEach(s => { s.x -= s.speed; if (s.x < -s.w) s.x = LOW_W + s.w; c.fillRect(Math.round(s.x), Math.round(s.y), Math.round(s.w), Math.round(s.h)); });
}

// ==========================================
// 水面の波紋・きらめき（階調のみ。硬いリング）
// ==========================================
function drawWaterDetail(c, frame) {
  const lcx = L(POND.cx), lcy = L(POND.cy), lr = L(POND.r);
  const ringR = Math.round((frame * 0.06) % lr);
  c.fillStyle = 'rgba(176,240,240,0.35)';
  for (let dy = -ringR; dy <= ringR; dy++) {
    const span = Math.round(Math.sqrt(Math.max(0, ringR * ringR - dy * dy)));
    if (span > 0) { c.fillRect(lcx - span, lcy + dy, 1, 1); c.fillRect(lcx + span, lcy + dy, 1, 1); }
  }
  const sparklePts = [[0.3, 0.2], [-0.3, -0.1], [0.1, -0.4], [-0.2, 0.35]];
  sparklePts.forEach((p, i) => {
    const tw = (Math.sin(frame * 0.1 + i * 2) + 1) / 2;
    if (tw > 0.6) { c.fillStyle = COOL.cyan; c.fillRect(lcx + Math.round(p[0] * lr), lcy + Math.round(p[1] * lr), 1, 1); }
  });
}

// ==========================================
// ビネット（グラデーション不使用。同心の額縁矩形で階調的に暗くする）
// ==========================================
function drawVignette(c) {
  const bands = [{ inset: 0, a: 0.55 }, { inset: 2, a: 0.34 }, { inset: 4, a: 0.2 }, { inset: 7, a: 0.1 }];
  bands.forEach(b => {
    c.fillStyle = COL.vignette + b.a + ')';
    c.fillRect(b.inset, b.inset, LOW_W - b.inset * 2, 1);
    c.fillRect(b.inset, LOW_H - b.inset - 1, LOW_W - b.inset * 2, 1);
    c.fillRect(b.inset, b.inset, 1, LOW_H - b.inset * 2);
    c.fillRect(LOW_W - b.inset - 1, b.inset, 1, LOW_H - b.inset * 2);
  });
  // 四隅を少し藤色寄りに（ロゴの寒色を影にも差し込む）
  c.fillStyle = 'rgba(90,60,110,0.18)';
  [[0, 0], [LOW_W - 6, 0], [0, LOW_H - 6], [LOW_W - 6, LOW_H - 6]].forEach(([x, y]) => c.fillRect(x, y, 6, 6));
}

// ==========================================
// 静的レイヤーの構築（一度だけ）
// ==========================================
buildGround();
thicketClusters.forEach(drawThicket);
decorations.forEach(o => { const fn = DECOR_DRAW[o.type]; if (fn) fn(octx, o); });
drawCottage();
drawStall();

/**
 * フィールド背景を描画する。
 * @param {CanvasRenderingContext2D} ctx - 描画先(800x600)のキャンバスコンテキスト
 * @param {number} frame - アニメーション用の経過フレーム数
 */
function drawMap(ctx, frame) {
  fctx.drawImage(groundLow, 0, 0);
  drawShadowFlow(fctx);
  fctx.drawImage(objectsLow, 0, 0);
  drawFarParallax(fctx, frame);

  grassBlades.forEach(b => {
    const wave = Math.round(Math.sin(frame * 0.05 + b.phase) * 0.6);
    fctx.fillStyle = COL.grassBase; fctx.fillRect(b.x + wave, b.y - 2, 1, 2);
    if (b.isLight) { fctx.fillStyle = COL.grassLight; fctx.fillRect(b.x + wave, b.y - 2, 1, 1); }
  });

  drawWaterDetail(fctx, frame);
  drawVignette(fctx);

  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(frameLow, 0, 0, LOW_W, LOW_H, 0, 0, 800, 600);
}
