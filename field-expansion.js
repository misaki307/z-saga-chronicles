// Z-SAGA FIELD EXPANSION — data only / no automatic mutation
// 現在のゲーム機能を上書きせず、Claudeが既存のGameStateへ統合するための設定値。
(function () {
  const FIELDS = {
    azurlight: {
      id: 'azurlight', order: 1, name: 'アズライト大陸',
      background: 'assets/fields/field_azurlight_meadow.png', unlockAfter: null,
      enemyHpMultiplier: 1, enemyAttackMultiplier: 1, goldMultiplier: 1,
      encounterMultiplier: 1, killsToOpenBoss: 10,
      recommendedPartyLevel: 3,
      ambient: 'grass-wind',
      music: { id: 'field-meadow', bpm: 104, scale: [0, 2, 4, 7, 9], mood: 'bright-adventure' },
      boss: { key: 'treeent', name: '百着を呑む呪衣装棚', rank: 'S', hp: 580, attack: 34, gold: 240 }
    },
    wardrobe_gloomwood: {
      id: 'wardrobe_gloomwood', order: 2, name: '闇の森・クローゼット深部',
      background: 'assets/fields/field_wardrobe_gloomwood.png', unlockAfter: 'azurlight',
      enemyHpMultiplier: 1.65, enemyAttackMultiplier: 1.35, goldMultiplier: 1.45,
      encounterMultiplier: 1.12, killsToOpenBoss: 12,
      recommendedPartyLevel: 5,
      ambient: 'wardrobe-sway',
      music: { id: 'field-wardrobe', bpm: 74, scale: [0, 3, 5, 7, 10], mood: 'mysterious-closet' },
      boss: { key: 'wardrobe_lord', name: '無限袖のクローゼットロード', rank: 'SS', hp: 1350, attack: 52, gold: 700 }
    },
    laundry_abyss: {
      id: 'laundry_abyss', order: 3, name: '洗濯槽深層・ランドリーアビス',
      background: 'assets/fields/field_laundry_abyss.png', unlockAfter: 'wardrobe_gloomwood',
      enemyHpMultiplier: 2.6, enemyAttackMultiplier: 1.85, goldMultiplier: 2,
      encounterMultiplier: 1.18, killsToOpenBoss: 16,
      recommendedPartyLevel: 8,
      ambient: 'underwater-bubbles',
      music: { id: 'field-laundry', bpm: 92, scale: [0, 2, 5, 7, 9], mood: 'weightless-water' },
      boss: { key: 'spin_leviathan', name: '大渦布竜スピン・レヴィアタン', rank: 'SSS', hp: 2400, attack: 76, gold: 1200 }
    }
  };

  function levelUpCost(currentLevel) {
    return 120 + Math.max(1, currentLevel) * 100;
  }

  function scaleEnemy(baseEnemy, fieldId) {
    const field = FIELDS[fieldId] || FIELDS.azurlight;
    return {
      ...baseEnemy,
      hp: Math.round(baseEnemy.hp * field.enemyHpMultiplier),
      maxHp: Math.round((baseEnemy.maxHp || baseEnemy.hp) * field.enemyHpMultiplier),
      attack: Math.round((baseEnemy.attack || 12) * field.enemyAttackMultiplier),
      goldDrop: Math.round((baseEnemy.goldDrop || 30) * field.goldMultiplier)
    };
  }

  // 800x600の背景を描画し、その上に軽量なステージ固有アニメーションを重ねる。
  // 既存の草原drawMapと同じrequestAnimationFrameのtimeを渡すこと。
  function drawAnimatedField(ctx, image, fieldId, time) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(image, 0, 0, 800, 600);
    const t = time || 0;

    if (fieldId === 'azurlight') {
      // 草原の外周と大きな茂みだけを8pxグリッドで揺らす。地面と当たり判定は動かさない。
      const grassRegions = [
        { x: 0, y: 0, w: 800, h: 86, axis: 'x', phase: 0 },
        { x: 112, y: 138, w: 120, h: 115, axis: 'y', phase: 1.4 },
        { x: 548, y: 132, w: 112, h: 105, axis: 'y', phase: 3.2 }
      ];
      grassRegions.forEach(r => {
        const n = Math.round(Math.sin(t * .022 + r.phase)) * 8;
        const dx = r.axis === 'x' ? n : 0, dy = r.axis === 'y' ? n : 0;
        ctx.save(); ctx.beginPath(); ctx.rect(r.x,r.y,r.w,r.h); ctx.clip();
        ctx.drawImage(image,r.x,r.y,r.w,r.h,r.x+dx,r.y+dy,r.w,r.h); ctx.restore();
      });
      // 2つの池へ角張った波紋を追加。
      [[144,304],[624,304]].forEach((p,i) => {
        const w = 8 + ((Math.floor(t/9)+i*5)%4)*8;
        ctx.strokeStyle='rgba(190,255,246,.36)'; ctx.lineWidth=2;
        ctx.strokeRect(p[0]-w,p[1]-Math.floor(w/3),w*2,Math.floor(w/1.5));
      });
    }

    if (fieldId === 'wardrobe_gloomwood') {
      // 背景端の服の塊を1〜2pxだけ往復させ、木々が風で揺れるように見せる。
      const regions = [
        { x: 0, y: 55, w: 205, h: 420, phase: 0 },
        { x: 610, y: 70, w: 190, h: 410, phase: 1.7 },
        { x: 205, y: 0, w: 185, h: 210, phase: 3.1 }
      ];
      regions.forEach(r => {
        const dx = Math.round(Math.sin(t * 0.025 + r.phase)) * 8;
        ctx.save(); ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
        ctx.drawImage(image, r.x, r.y, r.w, r.h, r.x + dx, r.y, r.w, r.h); ctx.restore();
      });
      // ボタン蛍：点滅周期をずらし、同時点滅を避ける。
      const lights = [[118,126],[257,84],[653,145],[711,430],[164,505],[574,296]];
      lights.forEach((p, i) => {
        const a = 0.25 + (Math.sin(t * .06 + i * 1.8) + 1) * .3;
        ctx.fillStyle = `rgba(255,205,75,${a})`; ctx.fillRect(p[0], p[1], 8, 8);
        if (a > .65) { ctx.fillRect(p[0]-8,p[1],8,8); ctx.fillRect(p[0]+8,p[1],8,8); }
      });
    }

    if (fieldId === 'laundry_abyss') {
      // 小さな角張った泡。毎フレーム乱数を使わず、同じ軌道を再現する。
      for (let i = 0; i < 18; i++) {
        const travel = (t * (0.45 + (i % 3) * .08) + i * 79) % 680;
        const x = Math.round(((i * 97 + Math.sin(t * .025 + i) * 14) % 776 + 8) / 8) * 8;
        const y = Math.round((632 - travel) / 8) * 8; const s = 8 + (i % 3) * 8;
        ctx.strokeStyle = `rgba(184,245,255,${0.35 + (i % 4) * .12})`; ctx.lineWidth = 4;
        ctx.strokeRect(x, y, s, s);
        if (i % 5 === 0) ctx.fillRect(x + 8, y - 8, 8, 8);
      }
      // 水面から差す光をゆっくり横へ流す。
      ctx.save(); ctx.globalCompositeOperation = 'screen';
      ctx.fillStyle = 'rgba(80,220,255,.045)';
      for (let x = -120; x < 900; x += 180) {
        const drift = Math.round((t * .18) % 180); ctx.beginPath();
        ctx.moveTo(x + drift, 0); ctx.lineTo(x + 42 + drift, 0); ctx.lineTo(x + 165 + drift, 600); ctx.lineTo(x + 100 + drift, 600); ctx.fill();
      }
      ctx.restore();
    }
  }

  // ステージ移動完了時に必ず呼ぶBGM切替フック。
  // audioBridge.crossfadeTo(musicConfig, milliseconds) は既存Audio処理へ接続する。
  function switchFieldMusic(fieldId, audioBridge) {
    const field = FIELDS[fieldId] || FIELDS.azurlight;
    if (!audioBridge || typeof audioBridge.crossfadeTo !== 'function') return field.music;
    if (audioBridge.currentFieldMusicId === field.music.id) return field.music;
    audioBridge.crossfadeTo(field.music, 600);
    audioBridge.currentFieldMusicId = field.music.id;
    return field.music;
  }

  window.ZSAGA_FIELD_EXPANSION = Object.freeze({
    version: 1,
    fieldOrder: ['azurlight', 'wardrobe_gloomwood', 'laundry_abyss'],
    fields: FIELDS,
    levelUpCost,
    scaleEnemy,
    drawAnimatedField,
    switchFieldMusic
  });
})();
