// ==========================================
// SPRITE ENGINE: 外部スプライトシートPNGの読込・アニメーション制御
// Canvas矩形やCSSでキャラクターを描く処理はここには一切ない。
// 画像が未着手/読み込み失敗の場合のみ、あえて「missing texture」の
// 市松模様（マゼンタ×黒）で明示的に代替表示する（キャラの完成絵として
// ごまかさないため）。
// ==========================================

// ---- 方向 / 行動の列挙 ----
const DIR = { DOWN: 0, LEFT: 1, RIGHT: 2, UP: 3 };
const DIR_FROM_VEC = (vx, vy) => {
    if (vx === 0 && vy === 0) return null;
    if (Math.abs(vx) > Math.abs(vy)) return vx > 0 ? DIR.RIGHT : DIR.LEFT;
    return vy > 0 ? DIR.DOWN : DIR.UP;
};

// ---- アクション定義: {開始列, フレーム数, 1フレームの表示時間(frame数), ループするか} ----
// 主人公/仲間(方向あり)用アクションセット
const HERO_ACTIONS = {
    idle: { col: 0, frames: 2, ticks: 20, loop: true },
    walk: { col: 2, frames: 4, ticks: 8, loop: true },
    run: { col: 6, frames: 6, ticks: 5, loop: true },
    attack: { col: 12, frames: 6, ticks: 4, loop: false },
    damage: { col: 18, frames: 2, ticks: 8, loop: false }
};
const ALLY_ACTIONS = {
    idle: { col: 0, frames: 2, ticks: 20, loop: true },
    walk: { col: 2, frames: 4, ticks: 8, loop: true },
    attack: { col: 6, frames: 4, ticks: 5, loop: false },
    damage: { col: 10, frames: 2, ticks: 8, loop: false }
};
// 敵(方向なし・常に主人公側=左向き固定)用アクションセット
const ENEMY_ACTIONS = {
    idle: { col: 0, frames: 2, ticks: 20, loop: true },
    walk: { col: 2, frames: 4, ticks: 8, loop: true },
    attack: { col: 6, frames: 4, ticks: 5, loop: false },
    damage: { col: 10, frames: 2, ticks: 8, loop: false },
    death: { col: 12, frames: 4, ticks: 6, loop: false }
};

// ==========================================
// SPRITE MANIFEST — 必要な画像ファイルの唯一の正本。
// ファイル名・セルサイズ・並び順はここで定義する。
// docs/sprite-assets.md に人間可読な仕様書として書き出してある。
// ==========================================
const SPRITE_MANIFEST = {
    hero: {
        cell: 48, rows: 4, actions: HERO_ACTIONS,
        files: {
            '仕立騎士': 'assets/sprites/hero/hero_darkknight.png',
            '染織師': 'assets/sprites/hero/hero_whitemage.png',
            '糸盗り': 'assets/sprites/hero/hero_thief.png',
            '装飾楽師': 'assets/sprites/hero/hero_bard.png',
            '鎧服職人': 'assets/sprites/hero/hero_heavyknight.png',
            '勇者': 'assets/sprites/hero/hero_heavyknight.png' // スキップ時の初期ジョブのフォールバック
        }
    },
    ally: {
        cell: 48, rows: 4, actions: ALLY_ACTIONS,
        files: {
            '染色術師': 'assets/sprites/ally/ally_mage.png',
            '採寸弓師': 'assets/sprites/ally/ally_archer.png',
            '裁断戦士': 'assets/sprites/ally/ally_warrior.png'
        }
    },
    enemy: {
        rows: 1, actions: ENEMY_ACTIONS,
        files: {
            slime: { path: 'assets/sprites/enemy/enemy_slime.png', cell: 48, tier: 'small' },
            goblin: { path: 'assets/sprites/enemy/enemy_goblin.png', cell: 48, tier: 'small' },
            mushroom: { path: 'assets/sprites/enemy/enemy_mushroom.png', cell: 48, tier: 'small' },
            plant: { path: 'assets/sprites/enemy/enemy_plant.png', cell: 64, tier: 'mid' },
            spider: { path: 'assets/sprites/enemy/enemy_spider.png', cell: 64, tier: 'mid' },
            dragon: { path: 'assets/sprites/enemy/enemy_dragon.png', cell: 96, tier: 'boss' },
            treeent: { path: 'assets/sprites/enemy/enemy_treeent.png', cell: 96, tier: 'boss' }
        }
    }
};

// ---- 画像キャッシュ + missing texture フォールバック検知 ----
const _imageCache = {};
function loadSpriteImage(path) {
    if (_imageCache[path]) return _imageCache[path];
    const img = new Image();
    img.src = path;
    img.__loaded = false;
    img.__failed = false;
    img.onload = () => { img.__loaded = true; };
    img.onerror = () => {
        img.__failed = true;
        console.warn(`[sprites.js] 画像の読込に失敗: ${path} — SPRITE_MANIFEST の仕様通りのPNGを配置してください。`);
    };
    _imageCache[path] = img;
    return img;
}

// ==========================================
// SpriteAnimator: 1体分のアニメーション状態を管理
// ==========================================
class SpriteAnimator {
    constructor(kind, key) {
        this.kind = kind; // 'hero' | 'ally' | 'enemy'
        this.key = key;   // job名 or enemy type key
        const def = SPRITE_MANIFEST[kind];
        this.def = def;
        this.actions = def.actions;
        if (kind === 'enemy') {
            const entry = def.files[key] || def.files.slime;
            this.cell = entry.cell;
            this.tier = entry.tier;
            this.img = loadSpriteImage(entry.path);
        } else {
            this.cell = def.cell;
            const path = def.files[key] || Object.values(def.files)[0];
            this.img = loadSpriteImage(path);
        }

        this.dir = DIR.DOWN;
        this.action = 'idle';
        this.frame = 0;
        this.tickTimer = 0;

        // ヒット演出(ヒットストップ / 白点滅 / ノックバック)
        this.hitStopFrames = 0;
        this.flashFrames = 0;
        this.knockback = { x: 0, y: 0, vx: 0, vy: 0, decay: 0.85 };
        this.dead = false;
    }

    setDirection(vx, vy) {
        const d = DIR_FROM_VEC(vx, vy);
        if (d !== null) this.dir = d; // 停止時は最後に向いていた方向を保持する
    }

    // action変更。ループしないアクション(attack/damage/death)は完了までフレームを保持
    setAction(action) {
        if (this.action === action) return;
        this.action = action;
        this.frame = 0;
        this.tickTimer = 0;
    }

    isBusy() {
        // attack/damage/death のようなノンループ動作を再生中は移動不可にするためのフラグ
        const a = this.actions[this.action];
        return a && !a.loop && !this.isActionFinished();
    }

    isActionFinished() {
        const a = this.actions[this.action];
        if (!a || a.loop) return false;
        return this.frame >= a.frames - 1 && this.tickTimer >= a.ticks - 1;
    }

    triggerHit({ hitStopFrames = 6, flashFrames = 16, knockbackPower = 6, fromX = 0, fromY = 0, toX = 0, toY = 0 } = {}) {
        this.hitStopFrames = hitStopFrames;
        this.flashFrames = flashFrames;
        const dx = toX - fromX, dy = toY - fromY;
        const len = Math.hypot(dx, dy) || 1;
        this.knockback.vx = (dx / len) * knockbackPower;
        this.knockback.vy = (dy / len) * knockbackPower;
        if (this.actions.damage) this.setAction('damage');
    }

    // 1フレーム分更新。ヒットストップ中はアニメーションフレームを進めない。
    update() {
        if (this.hitStopFrames > 0) { this.hitStopFrames--; return; }
        if (this.flashFrames > 0) this.flashFrames--;

        this.knockback.x += this.knockback.vx;
        this.knockback.y += this.knockback.vy;
        this.knockback.vx *= this.knockback.decay;
        this.knockback.vy *= this.knockback.decay;

        const a = this.actions[this.action];
        if (!a) return;
        this.tickTimer++;
        if (this.tickTimer >= a.ticks) {
            this.tickTimer = 0;
            if (this.frame < a.frames - 1) this.frame++;
            else if (a.loop) this.frame = 0;
            // ノンループの最終フレームはそのまま保持(呼び出し側がisActionFinished()を見て次状態へ遷移する)
        }
    }

    getSourceRect() {
        const a = this.actions[this.action] || this.actions.idle;
        const col = a.col + this.frame;
        const row = this.kind === 'enemy' ? 0 : this.dir;
        return { sx: col * this.cell, sy: row * this.cell, s: this.cell };
    }

    // 足元だけの当たり判定(スプライト矩形全体ではなく、足元の小さな帯)
    getFeetHitbox(centerX, centerY) {
        const w = Math.max(10, this.cell * 0.35);
        const h = Math.max(6, this.cell * 0.18);
        return { x: centerX - w / 2, y: centerY - h / 2, w, h };
    }
}

// ==========================================
// 描画: 画像補間を無効化してドットをぼかさず、等倍/拡大表示する
// ==========================================
function drawSprite(ctx, animator, centerX, centerY, opts = {}) {
    const scale = opts.scale || 1;
    const flipX = !!opts.flipX;
    ctx.imageSmoothingEnabled = false;

    const { sx, sy, s } = animator.getSourceRect();
    const dw = animator.cell * scale;
    const dh = animator.cell * scale;
    const dx = centerX + animator.knockback.x - dw / 2;
    const dy = centerY + animator.knockback.y - dh - (opts.groundOffset || 0);

    const img = animator.img;
    const ready = img.__loaded && !img.__failed;

    ctx.save();
    if (flipX) {
        ctx.translate(centerX + animator.knockback.x, 0);
        ctx.scale(-1, 1);
        ctx.translate(-(centerX + animator.knockback.x), 0);
    }

    if (ready) {
        if (animator.flashFrames > 0 && Math.floor(animator.flashFrames / 2) % 2 === 0) {
            // 被弾中の白点滅: 通常描画→白シルエットを重ねてsource-atomで抜く
            ctx.drawImage(img, sx, sy, s, s, dx, dy, dw, dh);
            ctx.globalCompositeOperation = 'source-atop';
            ctx.fillStyle = 'rgba(255,255,255,0.85)';
            ctx.fillRect(dx, dy, dw, dh);
            ctx.globalCompositeOperation = 'source-over';
        } else {
            ctx.drawImage(img, sx, sy, s, s, dx, dy, dw, dh);
        }
    } else {
        // missing texture: 明示的なプレースホルダー(市松模様)。キャラ絵の代用にはしない。
        drawMissingTexturePlaceholder(ctx, dx, dy, dw, dh);
    }
    ctx.restore();
}

function drawMissingTexturePlaceholder(ctx, x, y, w, h) {
    const tile = Math.max(4, Math.floor(w / 8));
    for (let yy = 0; yy < h; yy += tile) {
        for (let xx = 0; xx < w; xx += tile) {
            const on = (((xx / tile) | 0) + ((yy / tile) | 0)) % 2 === 0;
            ctx.fillStyle = on ? '#ff00ff' : '#141414';
            ctx.fillRect(x + xx, y + yy, tile, tile);
        }
    }
    ctx.strokeStyle = '#00e6e6'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}
