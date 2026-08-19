// ==========================================
// ロゴ表示: assets/logo.png があれば画像ロゴを、無ければテキストロゴを表示
// ==========================================
(function initLogo() {
    const img = document.getElementById('logo-img');
    const text = document.getElementById('logo-text');
    if (!img || !text) return;
    const probe = new Image();
    probe.onload = () => {
        img.src = probe.src;
        img.classList.remove('hidden');
        text.classList.add('hidden');
    };
    probe.onerror = () => { img.classList.add('hidden'); };
    probe.src = img.getAttribute('src');
})();

// ==========================================
// AUDIO SYSTEM: 16-bit Enhanced SFX
// ==========================================
const AudioContext = window.AudioContext || window.webkitAudioContext;
const audioCtx = new AudioContext();

// ==========================================
// BGM専用シンセ音源ヘルパー
// 既存のSFX(playSound内の各case)には一切触れず、
// フィールド/戦闘/召喚BGMと勝利ファンファーレだけで使用する。
// 複数ボイスが重なってもクリップしないよう、専用バスにコンプレッサーを挟む。
// ==========================================
const musicBus = audioCtx.createDynamicsCompressor();
musicBus.threshold.setValueAtTime(-14, audioCtx.currentTime);
musicBus.knee.setValueAtTime(18, audioCtx.currentTime);
musicBus.ratio.setValueAtTime(4, audioCtx.currentTime);
musicBus.attack.setValueAtTime(0.003, audioCtx.currentTime);
musicBus.release.setValueAtTime(0.15, audioCtx.currentTime);
musicBus.connect(audioCtx.destination);

function synthVoice(freq, opts) {
    opts = opts || {};
    const type = opts.type || 'sine';
    const start = opts.start || 0;
    const dur = opts.dur || 0.3;
    const gain = opts.gain != null ? opts.gain : 0.2;
    const attack = opts.attack != null ? opts.attack : 0.01;
    const filterHz = opts.filterHz || null;
    const filterQ = opts.filterQ || 1;
    const detune = opts.detune || 0;
    const now = audioCtx.currentTime + start;
    const osc = audioCtx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    if (detune) osc.detune.setValueAtTime(detune, now);
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(gain, now + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    if (filterHz) {
        const filter = audioCtx.createBiquadFilter();
        filter.type = 'lowpass'; filter.frequency.setValueAtTime(filterHz, now); filter.Q.value = filterQ;
        osc.connect(filter); filter.connect(g);
    } else {
        osc.connect(g);
    }
    g.connect(musicBus);
    osc.start(now); osc.stop(now + dur + 0.05);
}
// 弦楽器風: 2声をわずかにデチューンして重ねるアンサンブル効果
function synthStrings(freq, dur, gain, start) {
    synthVoice(freq, { type: 'sawtooth', dur: dur, gain: gain, start: start, attack: 0.05, detune: -6, filterHz: 2200 });
    synthVoice(freq, { type: 'sawtooth', dur: dur, gain: gain * 0.85, start: start, attack: 0.05, detune: 6, filterHz: 2200 });
}
// 金管風: ノコギリ波をローパスで丸めて明るい倍音だけ残す
function synthBrass(freq, dur, gain, start) {
    synthVoice(freq, { type: 'sawtooth', dur: dur, gain: gain, start: start, attack: 0.015, filterHz: 1800, filterQ: 2 });
}
// 笛風: サイン波中心に薄い倍音を足して息づかいを表現
function synthFlute(freq, dur, gain, start) {
    synthVoice(freq, { type: 'sine', dur: dur, gain: gain, start: start, attack: 0.03 });
    synthVoice(freq * 2, { type: 'sine', dur: dur, gain: gain * 0.15, start: start, attack: 0.03 });
}
// 鐘風: 基音+非整数倍音のクラスタで金属的な響きを作る
function synthBell(freq, dur, gain, start) {
    synthVoice(freq, { type: 'sine', dur: dur, gain: gain, start: start, attack: 0.002 });
    synthVoice(freq * 2.41, { type: 'sine', dur: dur * 0.7, gain: gain * 0.45, start: start, attack: 0.002 });
    synthVoice(freq * 3.8, { type: 'sine', dur: dur * 0.4, gain: gain * 0.25, start: start, attack: 0.002 });
}
// コーラス風: 複数のデチューンボイスを持続音として重ねる
function synthChoir(freq, dur, gain, start) {
    [0, -8, 7, -14].forEach((cents, i) => {
        synthVoice(freq, { type: i % 2 === 0 ? 'triangle' : 'sine', dur: dur, gain: gain * (i === 0 ? 1 : 0.55), start: start, attack: dur * 0.3, detune: cents });
    });
}
// 重低音: サブオクターブを重ねてボス戦にふさわしい重さを出す
function synthSubBass(freq, dur, gain, start) {
    synthVoice(freq, { type: 'square', dur: dur, gain: gain, start: start, attack: 0.005, filterHz: 300 });
    synthVoice(freq / 2, { type: 'sine', dur: dur, gain: gain * 0.8, start: start, attack: 0.005 });
}
// 一定間隔でstepFnを呼ぶ簡易シーケンサー。bgmIntervalを共有するのでstopBGM()で必ず止まる。
function startSequencer(stepMs, stepFn, stepCount) {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    stopBGM();
    let step = 0;
    bgmInterval = setInterval(() => {
        stepFn(step);
        step = (step + 1) % stepCount;
    }, stepMs);
}

function playSound(type) {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();
    osc.connect(gainNode); gainNode.connect(audioCtx.destination);
    const now = audioCtx.currentTime;

    if (type === 'select') {
        osc.type = 'sine'; osc.frequency.setValueAtTime(880, now);
        osc.frequency.exponentialRampToValueAtTime(1760, now + 0.1);
        gainNode.gain.setValueAtTime(0.3, now); gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.2);
        osc.start(now); osc.stop(now + 0.2);
    } else if (type === 'hit') {
        osc.type = 'square'; osc.frequency.setValueAtTime(150, now);
        osc.frequency.exponentialRampToValueAtTime(40, now + 0.2);
        gainNode.gain.setValueAtTime(0.5, now); gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.2);
        osc.start(now); osc.stop(now + 0.2);
    } else if (type === 'slash') {
        osc.type = 'sawtooth'; osc.frequency.setValueAtTime(1200, now);
        osc.frequency.exponentialRampToValueAtTime(300, now + 0.15);
        gainNode.gain.setValueAtTime(0.4, now); gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
        osc.start(now); osc.stop(now + 0.15);
    } else if (type === 'magic') {
        osc.type = 'sawtooth'; osc.frequency.setValueAtTime(400, now);
        for (let i = 0; i < 15; i++) osc.frequency.setValueAtTime(100 + Math.random() * 200, now + (i * 0.02));
        gainNode.gain.setValueAtTime(0.5, now); gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.4);
        osc.start(now); osc.stop(now + 0.4);
    } else if (type === 'fanfare') {
        // 勝利ファンファーレ（オリジナル）: 低音のパンチ+金管アルペジオで短く力強く
        synthSubBass(196.00, 0.22, 0.22, 0);
        synthBrass(523.25, 0.24, 0.22, 0.02);
        synthBrass(659.25, 0.24, 0.22, 0.13);
        synthBrass(783.99, 0.26, 0.22, 0.24);
        synthBrass(1046.50, 0.5, 0.26, 0.36);
        synthStrings(1046.50, 0.5, 0.10, 0.36);
    } else if (type === 'gacha') {
        osc.type = 'triangle'; osc.frequency.setValueAtTime(880, now);
        osc.frequency.exponentialRampToValueAtTime(1760, now + 0.5);
        gainNode.gain.setValueAtTime(0, now); gainNode.gain.linearRampToValueAtTime(0.3, now + 0.2);
        gainNode.gain.linearRampToValueAtTime(0, now + 1.5);
        osc.start(now); osc.stop(now + 1.5);
    } else if (type === 'gachalegend') {
        osc.type = 'triangle'; osc.frequency.setValueAtTime(660, now);
        osc.frequency.exponentialRampToValueAtTime(2200, now + 0.8);
        gainNode.gain.setValueAtTime(0, now); gainNode.gain.linearRampToValueAtTime(0.35, now + 0.3);
        gainNode.gain.linearRampToValueAtTime(0, now + 2.0);
        osc.start(now); osc.stop(now + 2.0);
    } else if (type === 'fanfareGrand') {
        // Sランク/SSランク召喚用（オリジナル）: fanfareより一段豪華なアルペジオ+コーラス
        synthSubBass(196.00, 0.3, 0.24, 0);
        synthBrass(523.25, 0.22, 0.22, 0.02);
        synthBrass(659.25, 0.22, 0.22, 0.12);
        synthBrass(783.99, 0.22, 0.22, 0.22);
        synthBrass(987.77, 0.26, 0.24, 0.32);
        synthBrass(1174.66, 0.6, 0.26, 0.43);
        synthStrings(1174.66, 0.6, 0.14, 0.43);
        synthChoir(587.33, 1.0, 0.07, 0.43);
    } else if (type === 'fanfareEpic') {
        // SSSランク召喚用（オリジナル）: 最も豪華。金管+弦+コーラス+鐘を重ねる
        synthSubBass(174.61, 0.32, 0.26, 0);
        synthBrass(523.25, 0.20, 0.22, 0.02);
        synthBrass(659.25, 0.20, 0.22, 0.10);
        synthBrass(783.99, 0.20, 0.22, 0.18);
        synthBrass(1046.50, 0.22, 0.24, 0.26);
        synthBrass(1318.51, 0.22, 0.26, 0.34);
        synthBrass(1567.98, 0.8, 0.28, 0.42);
        synthStrings(1567.98, 0.8, 0.16, 0.42);
        synthChoir(783.99, 1.3, 0.09, 0.42);
        synthBell(2093.00, 1.4, 0.12, 0.42);
    } else if (type === 'gachasss') {
        osc.type = 'sawtooth'; osc.frequency.setValueAtTime(220, now);
        osc.frequency.exponentialRampToValueAtTime(2800, now + 1.0);
        gainNode.gain.setValueAtTime(0, now); gainNode.gain.linearRampToValueAtTime(0.4, now + 0.4);
        gainNode.gain.linearRampToValueAtTime(0, now + 2.4);
        osc.start(now); osc.stop(now + 2.4);
    } else if (type === 'tick') {
        osc.type = 'square'; osc.frequency.setValueAtTime(1500, now);
        gainNode.gain.setValueAtTime(0.15, now); gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.05);
        osc.start(now); osc.stop(now + 0.05);
    } else if (type === 'noise') {
        osc.type = 'square'; osc.frequency.setValueAtTime(100, now);
        for (let i = 0; i < 10; i++) osc.frequency.setValueAtTime(Math.random() * 800 + 100, now + (i * 0.05));
        gainNode.gain.setValueAtTime(0.5, now); gainNode.gain.linearRampToValueAtTime(0.01, now + 0.5);
        osc.start(now); osc.stop(now + 0.5);
    }
}

let bgmInterval = null;

// フィールドBGM（オリジナル）: D dorian。前半8ステップは静か(笛のみ)、
// 後半8ステップは金管+弦+ベースで盛り上がる「静と動」を1周期で繰り返す。
function playFieldBGM() {
    const stepMs = 260;
    const stepDur = stepMs / 1000;
    const quietMelody = [440, 0, 587.33, 0, 523.25, 0, 440, 0]; // A4 . D5 . C5 . A4 .
    const climaxMelody = [587.33, 698.46, 880, 783.99, 698.46, 587.33, 523.25, 587.33]; // D5 F5 A5 G5 F5 D5 C5 D5
    const climaxBass = [146.83, 146.83, 220, 220, 146.83, 146.83, 196.00, 220]; // D3 D3 A3 A3 D3 D3 G3 A3
    const padChord = [293.66, 349.23, 440]; // D4 F4 A4

    startSequencer(stepMs, (step) => {
        if (step < 8) {
            if (step === 0) padChord.forEach(f => synthStrings(f, stepDur * 8, 0.045, 0));
            const n = quietMelody[step];
            if (n) synthFlute(n, stepDur * 1.6, 0.13, 0);
        } else {
            const i = step - 8;
            if (step === 8) padChord.forEach(f => synthStrings(f, stepDur * 8, 0.08, 0));
            synthBrass(climaxMelody[i], stepDur * 1.1, 0.15, 0);
            synthVoice(climaxBass[i], { type: 'triangle', dur: stepDur * 1.05, gain: 0.13, attack: 0.01 });
        }
    }, 16);
}

// 戦闘BGM（オリジナル）: intensity='normal'(通常)/'a'(Aランク=厚み追加)/'boss'(Sランク=最も壮大)
function playBattleBGM(intensity) {
    const stepMs = intensity === 'boss' ? 170 : (intensity === 'a' ? 140 : 150);
    const stepDur = stepMs / 1000;
    const bassNotes = [164.81, 164.81, 174.61, 164.81, 164.81, 164.81, 196.00, 174.61]; // E3系の緊張感あるベースライン
    const melodyNotes = [0, 659.25, 0, 783.99, 0, 659.25, 0, 698.46]; // E5 . G5 . E5 . F5 の短い旋律断片

    startSequencer(stepMs, (step) => {
        const bassFreq = bassNotes[step];
        synthVoice(bassFreq, { type: 'sawtooth', dur: stepDur * 0.9, gain: 0.15, attack: 0.005, filterHz: 500 });

        const mel = melodyNotes[step];
        if (mel) synthVoice(mel, { type: 'square', dur: stepDur * 0.5, gain: 0.10, attack: 0.005, filterHz: 2600 });

        if (intensity === 'a' || intensity === 'boss') {
            // Aランク以上: 短3度上のハーモニーと低いオクターブを重ねて音を厚くする
            if (mel) synthVoice(mel * 1.1892, { type: 'square', dur: stepDur * 0.5, gain: 0.06, attack: 0.005, filterHz: 2600 });
            if (step % 4 === 0) synthVoice(bassFreq / 2, { type: 'sawtooth', dur: stepDur * 1.6, gain: 0.08, attack: 0.02, filterHz: 400 });
        }
        if (intensity === 'boss') {
            // Sランク/ボス戦: 重い低音・鐘・コーラス風の音色を加えて最も壮大にする
            if (step % 2 === 0) synthSubBass(bassFreq / 2, stepDur * 1.4, 0.17, 0);
            if (step % 4 === 0) synthBell(1046.50, 1.0, 0.09, 0);
            if (step === 0) synthChoir(220.00, stepDur * 8, 0.045, 0);
        }
    }, 8);
}

function playFastEpicBGM(isBattle = false) {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    stopBGM();

    if (isBattle === 'shop') {
        // 召喚の祭壇の環境音（変更しない）
        const shopNotes = [659.25, 880, 1046.5, 659.25, 880, 1046.5];
        const tempo = 180;
        let noteIdx = 0;
        bgmInterval = setInterval(() => {
            const osc = audioCtx.createOscillator();
            const gainNode = audioCtx.createGain();
            osc.type = 'sawtooth'; osc.frequency.value = shopNotes[noteIdx];
            osc.connect(gainNode); gainNode.connect(audioCtx.destination);
            const now = audioCtx.currentTime;
            gainNode.gain.setValueAtTime(0.04, now);
            gainNode.gain.exponentialRampToValueAtTime(0.001, now + (tempo / 1000));
            osc.start(now); osc.stop(now + (tempo / 1000));
            noteIdx = (noteIdx + 1) % shopNotes.length;
        }, tempo);
        return;
    }

    if (isBattle) {
        // 敵ランク(C/A/S)に応じて戦闘BGMの厚みを変える。戦闘システム自体には触れない。
        const tier = currentEnemy && currentEnemy.tier;
        const intensity = tier === 'boss' ? 'boss' : (tier === 'mid' ? 'a' : 'normal');
        playBattleBGM(intensity);
        return;
    }

    playFieldBGM();
}
function stopBGM() { if (bgmInterval) { clearInterval(bgmInterval); bgmInterval = null; } }

// 召喚中: レア度が上がるほど音数が増え、テンポが速く、音色が豪華になるオリジナルBGM
// ※ tempo(=長さ・溜めの周期)とnotes(主旋律)は既存の演出タイミングに合わせて一切変更しない。
//    bass/harmony/bellは追加の重ね声のみで、B/Aランクは従来どおり単声のまま。
const RANK_BGM_PATTERNS = {
    B: { notes: [523.25, 659.25], tempo: 300, synthType: 'sine' },
    A: { notes: [523.25, 659.25, 783.99, 659.25], tempo: 240, synthType: 'sine' },
    S: { notes: [659.25, 783.99, 987.77, 783.99, 659.25, 987.77], tempo: 190, synthType: 'triangle', bass: true },
    SS: { notes: [783.99, 987.77, 1174.66, 987.77, 1318.51, 987.77, 1174.66, 880], tempo: 150, synthType: 'triangle', bass: true, harmony: true },
    SSS: { notes: [987.77, 1174.66, 1318.51, 1567.98, 1318.51, 1760, 1567.98, 1318.51, 1174.66, 1567.98, 1975.53, 1567.98], tempo: 110, synthType: 'sawtooth', bass: true, harmony: true, bell: true }
};
function playRankSummonBGM(rankKey) {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    stopBGM();
    const pattern = RANK_BGM_PATTERNS[rankKey] || RANK_BGM_PATTERNS.B;
    let noteIdx = 0;
    bgmInterval = setInterval(() => {
        const freq = pattern.notes[noteIdx];
        const dur = pattern.tempo / 1000;
        const osc = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();
        osc.type = pattern.synthType; osc.frequency.value = freq;
        osc.connect(gainNode); gainNode.connect(audioCtx.destination);
        const now = audioCtx.currentTime;
        gainNode.gain.setValueAtTime(0.05, now);
        gainNode.gain.exponentialRampToValueAtTime(0.001, now + dur);
        osc.start(now); osc.stop(now + dur);

        // レア度が高いほど同時に鳴る音を増やして豪華にする（テンポ・主旋律の周期は変えない）
        if (pattern.bass && noteIdx % 2 === 0) synthVoice(freq / 2, { type: 'triangle', dur: dur * 1.6, gain: 0.06, attack: 0.01 });
        if (pattern.harmony) synthVoice(freq * 1.5, { type: pattern.synthType, dur: dur * 0.8, gain: 0.04, attack: 0.005 });
        if (pattern.bell && noteIdx % 3 === 0) synthBell(freq * 2, dur * 2, 0.05, 0);

        noteIdx = (noteIdx + 1) % pattern.notes.length;
    }, pattern.tempo);
}

// ==========================================
// GAME STATE
// ==========================================
const GameState = {
    avatar: { name: '', job: '', style: '', color: '#fff', hp: 100, maxHp: 100, mp: 50, agi: 30, tension: 0 },
    party: [], // {name, job, style, color, isDragon, originItem}
    listing: null, // {id, itemName, status:'listed'|'reviewed'|'completed', rewardClaimed}
    continents: ['封印の塔', 'カジュアル平原', '深淵の森', '荒野の砂漠', '古の山脈', 'アズライト中央大陸'],
    globalTime: 0,
    gold: 0
};
let currentTrend = 'なし';

function updateGold(amount) {
    GameState.gold += amount;
    document.getElementById('ui-gold').textContent = GameState.gold;
    document.getElementById('menu-gold').textContent = GameState.gold;
}

const ALL_STYLES = ['炎', '氷', '雷', '光', '闇'];
const JOB_TEMPLATES = [
    { type: '影縫いの外套', job: '仕立騎士', style: '闇', color: '#2b2038', prefix: '影縫いの' },
    { type: '純白の星布', job: '染織師', style: '光', color: '#eeeeee', prefix: '純白の' },
    { type: '継ぎ接ぎの外套', job: '糸盗り', style: '氷', color: '#667a35', prefix: '継ぎ接ぎの' },
    { type: '旋律の装飾衣', job: '装飾楽師', style: '炎', color: '#245aa5', prefix: '旋律の' },
    { type: '金釦の鎧服', job: '鎧服職人', style: '雷', color: '#263e73', prefix: '金釦の' }
];

function analyzeImageFast() {
    return new Promise(resolve => {
        setTimeout(() => {
            const template = JOB_TEMPLATES[Math.floor(Math.random() * JOB_TEMPLATES.length)];
            const baseNames = ['アルテア', 'ヴァルム', 'シグナ', 'エルダー', 'ノクス', 'フィオル'];
            resolve({
                name: `${template.prefix}紋章・${baseNames[Math.floor(Math.random() * baseNames.length)]}`,
                job: template.job, style: template.style,
                hp: Math.floor(Math.random() * 80) + 100, maxHp: 100, mp: Math.floor(Math.random() * 80) + 50, agi: Math.floor(Math.random() * 80) + 50,
                color: template.color,
                tension: 0
            });
        }, 1200);
    });
}

// 召喚の祭壇：ランク別キャラクタープール（B/A/S/SS/SSSの5段階）
const CHARACTER_POOL = {
    SSS: [
        { name: '王室仕立師・セラフィ', color: '#ffd700' },
        { name: '千色の染織王・ノクターン', color: '#ff2ee6' },
        { name: '星布の創始者・エデン', color: '#e74c3c' }
    ],
    SS: [
        { name: '虹染めの術師・アステア', color: '#e85bb5' },
        { name: '深紅の染色術師・イグニス', color: '#e74c3c' },
        { name: '夜布の染色術師・モルガナ', color: '#9b59b6' }
    ],
    S: [
        { name: '黄金尺の採寸弓師・カイエン', color: '#c9c429' },
        { name: '月尺の採寸弓師・ミラ', color: '#94ad24' },
        { name: '若葉布の採寸弓師・ルーナ', color: '#78a52a' },
        { name: '早縫いの採寸弓師・ゼクス', color: '#aebd31' }
    ],
    A: [
        { name: '手練れの裁断戦士・ガロ', color: '#e85a2b' },
        { name: '荒布の裁断戦士・ディーン', color: '#d66a32' },
        { name: '鉄釦の裁断戦士・ブロード', color: '#c74a29' },
        { name: '双鋏の裁断戦士・カイル', color: '#ef7733' }
    ],
    B: [
        { name: '街角の裁断戦士・ガイル', color: '#b85d3b' },
        { name: '見習い縫い手・ロト', color: '#9e684d' },
        { name: '旅する繕い手・ジン', color: '#bd7852' },
        { name: '新米仕立屋・ポポ', color: '#a46f58' }
    ]
};

// レア度が高いほど強いジョブが出るようにし、抽選演出の派手さも段階的に変える
const RARITY_TABLE = [
    { key: 'SSS', cum: 0.01, job: '染色術師', flashClass: 'flash-sss', shakeLv: 4, buildupMs: 2800, sfx: 'gachasss', fanfare: 'fanfareEpic', title: 'SSS' },
    { key: 'SS', cum: 0.05, job: '染色術師', flashClass: 'flash-ss', shakeLv: 3, buildupMs: 2200, sfx: 'gachalegend', fanfare: 'fanfareGrand', title: 'SS' },
    { key: 'S', cum: 0.20, job: '採寸弓師', flashClass: 'flash-s', shakeLv: 2, buildupMs: 1700, sfx: 'gacha', fanfare: 'fanfareGrand', title: 'S' },
    { key: 'A', cum: 0.50, job: '裁断戦士', flashClass: 'flash-a', shakeLv: 1, buildupMs: 1200, sfx: 'gacha', fanfare: 'fanfare', title: 'A' },
    { key: 'B', cum: 1.00, job: '裁断戦士', flashClass: 'flash-b', shakeLv: 0, buildupMs: 700, sfx: 'select', fanfare: 'fanfare', title: 'B' }
];

// 役職ごとに見た目・色・装備を明確に分けた仲間スプライト
const ALLY_VISUALS = {
    '染色術師': { path: 'assets/sprites/ally/ally_mage.png', roleClass: 'role-mage', label: '桃染めの染色術師' },
    '採寸弓師': { path: 'assets/sprites/ally/ally_archer.png', roleClass: 'role-archer', label: '黄金尺の採寸弓師' },
    '裁断戦士': { path: 'assets/sprites/ally/ally_warrior.png', roleClass: 'role-warrior', label: '双鋏の裁断戦士' }
};

// ==========================================
// パーティ重複判定・強化
// 召喚仲間は「役職(=スプライト)」単位、元・敵の仲間は「enemyTypeKey」単位で同一とみなす。
// 見た目が同じキャラクターをパーティに複数追加することはなく、必ずLv/攻撃補正/スキルLvが伸びる。
// ==========================================
function findExistingPartyMember(candidate) {
    if (candidate.job === '魔物') {
        return GameState.party.find(p => p.job === '魔物' && p.enemyTypeKey === candidate.enemyTypeKey);
    }
    return GameState.party.find(p => p.job !== '魔物' && p.job === candidate.job);
}

function addOrEnhancePartyMember(candidate) {
    const existing = findExistingPartyMember(candidate);
    if (existing) {
        existing.level = (existing.level || 1) + 1;
        existing.duplicateCount = (existing.duplicateCount || 0) + 1;
        existing.atkBonusPct = (existing.atkBonusPct || 0) + 10;
        if (existing.duplicateCount % 2 === 0) existing.skillLevel = (existing.skillLevel || 1) + 1;
        return { merged: true, member: existing };
    }
    candidate.level = 1;
    candidate.duplicateCount = 0;
    candidate.atkBonusPct = 0;
    candidate.skillLevel = 1;
    GameState.party.push(candidate);
    return { merged: false, member: candidate };
}

// 仲間の攻撃力にLv強化分の補正(攻撃補正% + スキルLvに応じた上乗せ)を掛ける
function getAllyDamageMultiplier(ally) {
    const atkBonus = (ally.atkBonusPct || 0) / 100;
    const skillBonus = ((ally.skillLevel || 1) - 1) * 0.05;
    return 1 + atkBonus + skillBonus;
}

const ALL_GACHA_RANK_CLASSES = ['summon-rank-b','summon-rank-a','summon-rank-s','summon-rank-ss','summon-rank-sss'];
function clearGachaRankClasses() { summonArea.classList.remove(...ALL_GACHA_RANK_CLASSES); }

const SUSPENSE_LOW = ['魂を交信中...'];
const SUSPENSE_MID = ['魂を交信中...', '何かが呼応している…'];
const SUSPENSE_HIGH = ['魂を交信中...', '何かが呼応している…', '強い力を感じる…！', 'まさか…！？'];

// 敵キャラクター図鑑（小型48px/中型64px/ボス96px）。
// スプライトの実体は sprites.js の SPRITE_MANIFEST.enemy を参照。
// moveSpeed / attackRange / hp は敵ごとに個別設定できるようにしてある。
const ENEMY_TYPES = {
    small: [
        { key: 'slime', name: '暴れ毛玉・ボタンアイ', hp: 40, goldDrop: 30, moveSpeed: 2.0, attackRange: 40 },
        { key: 'goblin', name: '四腕のハンガー鬼', hp: 55, goldDrop: 40, moveSpeed: 3.0, attackRange: 50 },
        { key: 'mushroom', name: '針嘴のほつれ糸', hp: 45, goldDrop: 35, moveSpeed: 1.5, attackRange: 40 }
    ],
    mid: [
        { key: 'plant', name: '捕食コサージュ', hp: 90, goldDrop: 70, moveSpeed: 1.0, attackRange: 70 },
        { key: 'spider', name: '鋼針ミシングモ', hp: 85, goldDrop: 65, moveSpeed: 3.5, attackRange: 55 }
    ],
    boss: [
        { key: 'dragon', name: '継ぎ布の翼竜', hp: 150, goldDrop: 150, moveSpeed: 2.0, attackRange: 90, isBoss: true },
        { key: 'treeent', name: '百着を呑む呪衣装棚', hp: 170, goldDrop: 170, moveSpeed: 1.0, attackRange: 80, isBoss: true }
    ]
};

// ランク別のHP幅・通常攻撃耐性・突破バリア閾値。
// C(小型)はバリアなし、A(中型)は残20%で、S(ボス)は残35%で通常攻撃を止める。
const ENEMY_TIER_CONFIG = {
    small: { rankLabel: 'C', hpMin: 70, hpMax: 85, normalResist: 1.0, barrierThresholdPct: 0 },
    mid: { rankLabel: 'A', hpMin: 190, hpMax: 210, normalResist: 0.55, barrierThresholdPct: 0.20 },
    boss: { rankLabel: 'S', hpMin: 520, hpMax: 580, normalResist: 0.30, barrierThresholdPct: 0.35 }
};
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function generateEnemy(style) {
    const roll = Math.random();
    // 小型(C)52% / 中型(A)35% / ボス(S)13%
    const tier = roll < 0.52 ? 'small' : (roll < 0.87 ? 'mid' : 'boss');
    const base = ENEMY_TYPES[tier][Math.floor(Math.random() * ENEMY_TYPES[tier].length)];
    const cfg = ENEMY_TIER_CONFIG[tier];
    const enemyStyle = style || ALL_STYLES[Math.floor(Math.random() * ALL_STYLES.length)];
    const hp = randInt(cfg.hpMin, cfg.hpMax);
    return {
        name: `${enemyStyle}の${base.name}`,
        enemyTypeKey: base.key, tier, rankLabel: cfg.rankLabel,
        isDragon: !!base.isBoss, // ボス個体=凱旋の儀トリガー（既存ロジック互換のためフィールド名は維持）
        job: '魔物', style: enemyStyle,
        moveSpeed: base.moveSpeed, attackRange: base.attackRange,
        originItem: GameState.avatar.name || '伝説の遺物',
        hp: hp, maxHp: hp, goldDrop: base.goldDrop,
        // 通常攻撃耐性・突破バリア(A/Sのみ)。スキルまたは属性一致連携でのみ突破できる。
        normalResist: cfg.normalResist,
        barrierThresholdPct: cfg.barrierThresholdPct,
        barrierActive: false,
        barrierBroken: cfg.barrierThresholdPct === 0,
        sprite: new SpriteAnimator('enemy', base.key)
    };
}

// 通常攻撃 / 貫通攻撃(スキル・属性一致連携)に応じてダメージを補正し、
// A/Sランクのバリアで通常攻撃が止められる場合はダメージを0にする。
function applyDamageToEnemy(enemy, rawDmg, isPiercing) {
    let dmg = Math.max(0, Math.round(rawDmg));
    if (!isPiercing && enemy.normalResist) dmg = Math.round(dmg * enemy.normalResist);

    if (enemy.barrierThresholdPct > 0 && !enemy.barrierBroken) {
        const barrierHp = Math.ceil(enemy.maxHp * enemy.barrierThresholdPct);
        if (isPiercing) {
            enemy.barrierActive = false;
            enemy.barrierBroken = true; // 一度貫通すればそのバリアは以後発動しない
        } else if (enemy.hp <= barrierHp) {
            // 既にバリア発動中: 通常攻撃は完全に無効
            enemy.barrierActive = true;
            dmg = 0;
        } else if (enemy.hp - dmg <= barrierHp) {
            // バリア値までは削れるが、それ以上は通常攻撃では削れない
            dmg = enemy.hp - barrierHp;
            enemy.barrierActive = true;
        }
    }

    enemy.hp = Math.max(0, enemy.hp - dmg);
    return { dmg, blocked: !isPiercing && enemy.barrierActive && dmg === 0 };
}

// ==========================================
// 16-BIT RENDERER (Canvas)
// ==========================================
// フィールド背景の描画は background.js の drawMap(ctx, frame) に切り出してある。
const canvas = document.getElementById('game-canvas'); const ctx = canvas.getContext('2d');
canvas.width = 800; canvas.height = 600;
ctx.imageSmoothingEnabled = false; // ドットをぼかさない
const player = { x: 400, y: 300, vx: 0, vy: 0, speed: 5 }; const keys = {}; const historyLog = [];
const GRASS_ZONES = [{ x: 220, y: 170, w: 100, h: 60 }, { x: 500, y: 200, w: 80, h: 100 }, { x: 350, y: 300, w: 80, h: 120 }, { x: 450, y: 470, w: 120, h: 50 }];
const SHOP_DOOR = { x: 550, y: 140, w: 20, h: 20 };
const SHOP_TRIGGER_ZONE = { x: SHOP_DOOR.x + 10 - 30, y: SHOP_DOOR.y + 10 - 40, w: 60, h: 80 };

function rectsOverlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

// パーティ追従者(仲間 or 元・敵)をスプライトで描画する共通ヘルパー
function drawFollowerSprite(follower, x, y, scale) {
    if (!follower.sprite) return;
    drawSprite(ctx, follower.sprite, x, y, { scale });
}

const particles = []; const dmgTexts = []; let screenShakeTimer = 0; let battleViewState = 'idle'; let slashEffectTimer = 0;

function spawnParticles(targetX, targetY) {
    for (let i = 0; i < 30; i++) particles.push({ x: player.x, y: player.y - 20, tx: targetX, ty: targetY, vx: (Math.random() - 0.5) * 15, vy: (Math.random() - 0.5) * 15 - 5, life: 60, color: ['#00e5ff', '#f1c40f', '#ffffff'][i % 3] });
}
function spawnMagicParticles(sourceX, sourceY, targetX, targetY, color) {
    for (let i = 0; i < 30; i++) particles.push({ x: sourceX, y: sourceY, tx: targetX, ty: targetY, vx: (Math.random() - 0.5) * 8, vy: (Math.random() - 0.5) * 8 - 5, life: 30, color: color });
}
function showDamage(x, y, amount) { dmgTexts.push({ x: x + Math.random() * 40 - 20, y: y - 20 + Math.random() * 20 - 10, text: `${amount}!`, life: 45, vy: -3 }); }

// ==========================================
// GAME LOOP & TRIGGERS
// ==========================================
let isBattling = false; let currentEnemy = null; let isMenuOpen = false; let isShopOpen = false; let isFashionShow = false;

function checkTriggers() {
    // 当たり判定は足元だけの小さな帯（スプライト矩形全体では判定しない）
    const feet = GameState.avatar.sprite
        ? GameState.avatar.sprite.getFeetHitbox(player.x, player.y)
        : { x: player.x - 5, y: player.y - 3, w: 10, h: 6 };

    let onGrass = false;
    for (let z of GRASS_ZONES) if (rectsOverlap(feet, z)) onGrass = true;
    if (onGrass && Math.random() < 0.0105) startEncounter();

    if (rectsOverlap(feet, SHOP_TRIGGER_ZONE)) {
        if ((keys['ArrowUp'] || keys['w']) && !isShopOpen) openShop();
    }
}

// 伝説1: Trend Tailwind Logic
setInterval(() => {
    if (isBattling || isFashionShow) return;
    currentTrend = ALL_STYLES[Math.floor(Math.random() * ALL_STYLES.length)];
    const notif = document.getElementById('trend-notification');
    document.getElementById('trend-text').textContent = currentTrend;
    notif.classList.remove('hidden');

    // Toggle wind overlay
    if (GameState.avatar.style === currentTrend) {
        document.getElementById('trend-overlay').classList.remove('hidden');
    } else {
        document.getElementById('trend-overlay').classList.add('hidden');
    }

    setTimeout(() => notif.classList.add('hidden'), 4000);
}, 20000); // Change trend every 20s

function updateGame() {
    GameState.globalTime++;
    if (isMenuOpen || isShopOpen || isFashionShow) return;

    let currentSpeed = player.speed;
    let hasTrendBuff = false;
    if (GameState.avatar.style === currentTrend) { currentSpeed = player.speed * 2; hasTrendBuff = true; }

    if (keys['ArrowUp'] || keys['w']) player.vy = -currentSpeed; else if (keys['ArrowDown'] || keys['s']) player.vy = currentSpeed; else player.vy = 0;
    if (keys['ArrowLeft'] || keys['a']) player.vx = -currentSpeed; else if (keys['ArrowRight'] || keys['d']) player.vx = currentSpeed; else player.vx = 0;

    const isMoving = (player.vx !== 0 || player.vy !== 0);

    // 主人公の入力方向に対応する行を再生。停止時は最後に向いていた方向のIdleへ。
    // トレンド一致時(走行=Run)は歩行(Walk)より大きく腕脚が動くフレームを再生する。
    if (GameState.avatar.sprite) {
        GameState.avatar.sprite.setDirection(player.vx, player.vy);
        GameState.avatar.sprite.setAction(isMoving ? (hasTrendBuff ? 'run' : 'walk') : 'idle');
    }
    GameState.party.forEach(p => {
        if (!p.sprite) return;
        p.sprite.setDirection(player.vx, player.vy);
        p.sprite.setAction(isMoving ? 'walk' : 'idle');
    });

    if (isMoving) {
        player.x = Math.max(20, Math.min(canvas.width - 20, player.x + player.vx)); player.y = Math.max(30, Math.min(canvas.height - 20, player.y + player.vy));
        historyLog.unshift({ x: player.x, y: player.y }); if (historyLog.length > 500) historyLog.pop();
        checkTriggers();
    }
}

function updateBattleEffects() {
    if (screenShakeTimer > 0) screenShakeTimer--; if (slashEffectTimer > 0) slashEffectTimer--;
    if (skillChargeTimer > 0) skillChargeTimer--;
    updateLunge();
    for (let i = dmgTexts.length - 1; i >= 0; i--) { let dt = dmgTexts[i]; dt.y += dt.vy; dt.vy += 0.2; dt.life--; if (dt.life <= 0) dmgTexts.splice(i, 1); }
    for (let i = particles.length - 1; i >= 0; i--) { let p = particles[i]; p.vx += (p.tx - p.x) * 0.02; p.vy += (p.ty - p.y) * 0.02; p.vx *= 0.9; p.vy *= 0.9; p.x += p.vx; p.y += p.vy; p.life--; if (p.life <= 0) particles.splice(i, 1); }
}

// 踏み込み攻撃: 0(構え)〜1(踏み込み位置)をタイマーではなく毎フレーム補間して滑らかに動かす
let attackLungeT = 0; let attackLungeDir = 0;
// スキル溜め演出（衣装奥義・シームブレイク発動前のオーラ表示フレーム数）
let skillChargeTimer = 0;
function updateLunge() {
    const speed = 0.12;
    if (attackLungeDir > 0 && attackLungeT < 1) attackLungeT = Math.min(1, attackLungeT + speed);
    else if (attackLungeDir < 0 && attackLungeT > 0) attackLungeT = Math.max(0, attackLungeT - speed);
}

// 横視点の戦闘背景（フィールドマップとは別の専用ステージ）
function drawBattleArena(ctxObj) {
    const skyGrad = ctxObj.createLinearGradient(0, 0, 0, 340);
    skyGrad.addColorStop(0, '#1b1240'); skyGrad.addColorStop(1, '#4a2f6b');
    ctxObj.fillStyle = skyGrad; ctxObj.fillRect(0, 0, 800, 340);

    ctxObj.fillStyle = 'rgba(255,255,255,0.18)';
    for (let i = 0; i < 36; i++) {
        const x = (i * 97 + GameState.globalTime * 0.15) % 800;
        const y = (i * 53) % 300;
        ctxObj.fillRect(x, y, 2, 2);
    }

    const groundGrad = ctxObj.createLinearGradient(0, 340, 0, 600);
    groundGrad.addColorStop(0, '#33244f'); groundGrad.addColorStop(1, '#120c24');
    ctxObj.fillStyle = groundGrad; ctxObj.fillRect(0, 340, 800, 260);

    ctxObj.strokeStyle = 'rgba(255,255,255,0.10)'; ctxObj.lineWidth = 2;
    for (let i = 0; i < 6; i++) {
        const y = 340 + i * 44;
        ctxObj.beginPath(); ctxObj.moveTo(0, y); ctxObj.lineTo(800, y); ctxObj.stroke();
    }

    // 主人公側・敵側の立ち位置を示す影
    ctxObj.fillStyle = 'rgba(0,0,0,0.45)';
    ctxObj.beginPath(); ctxObj.ellipse(200, 412, 46, 14, 0, 0, Math.PI * 2); ctxObj.fill();
    ctxObj.beginPath(); ctxObj.ellipse(600, 397, 56, 16, 0, 0, Math.PI * 2); ctxObj.fill();
}

function updateAllSprites() {
    if (GameState.avatar.sprite) GameState.avatar.sprite.update();
    GameState.party.forEach(p => { if (p.sprite) p.sprite.update(); });
    if (currentEnemy && currentEnemy.sprite) currentEnemy.sprite.update();
    if (fsBoss && fsBoss.sprite) fsBoss.sprite.update();
}

function drawGame() {
    ctx.save();
    if (screenShakeTimer > 0) ctx.translate((Math.random() - 0.5) * 15, (Math.random() - 0.5) * 15);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (isBattling) drawBattleArena(ctx); else drawMap(ctx, GameState.globalTime);

    let hasTrendBuff = (GameState.avatar.style === currentTrend);
    let hx = player.x, hy = player.y;

    if (!isBattling) {
        [...GameState.party].reverse().forEach((follower, i) => {
            const delay = (GameState.party.length - i) * 12;
            const pos = historyLog[delay] || historyLog[historyLog.length - 1] || player;
            drawFollowerSprite(follower, pos.x, pos.y, 0.9);
        });
    } else if (isBattling && currentEnemy) {
        GameState.party.forEach((follower, i) => {
            let px = 100 - (Math.floor(i / 3) * 30), py = 300 + ((i % 3) * 60);
            drawFollowerSprite(follower, px, py, 0.9);
        });
        // 踏み込み攻撃: 構え位置(200)から敵側(550)へ滑らかに前進する
        hx = 200 + 350 * attackLungeT; hy = 400;
    }

    if (!isFashionShow && GameState.avatar.sprite) {
        if (hasTrendBuff) {
            ctx.fillStyle = 'rgba(255, 255, 0, 0.4)';
            ctx.beginPath(); ctx.arc(hx, hy - 5, 30 + Math.sin(GameState.globalTime * 0.2) * 5, 0, Math.PI * 2); ctx.fill();
        }
        if (skillChargeTimer > 0) {
            // スキル溜め演出: 主人公を包む発光オーラ
            const pulse = 26 + Math.sin(GameState.globalTime * 0.6) * 8;
            const grad = ctx.createRadialGradient(hx, hy - 15, 4, hx, hy - 15, pulse);
            grad.addColorStop(0, 'rgba(255, 235, 160, 0.9)'); grad.addColorStop(1, 'rgba(255, 235, 160, 0)');
            ctx.fillStyle = grad;
            ctx.beginPath(); ctx.arc(hx, hy - 15, pulse, 0, Math.PI * 2); ctx.fill();
        }
        drawSprite(ctx, GameState.avatar.sprite, hx, hy, { scale: isBattling ? 1.5 : 1 });
    }

    if (isBattling && currentEnemy && !isFashionShow && currentEnemy.sprite) {
        let ex = 600, ey = 380;
        ctx.globalAlpha = currentEnemy.hp <= 0 ? .3 : 1;
        drawSprite(ctx, currentEnemy.sprite, ex, ey, { scale: 1, flipX: true });
        ctx.globalAlpha = 1;
        if (slashEffectTimer > 0) { ctx.lineWidth = 4; ctx.strokeStyle = 'white'; ctx.beginPath(); ctx.moveTo(ex - 30, ey - 30); ctx.lineTo(ex + 30, ey + 30); ctx.stroke(); ctx.beginPath(); ctx.moveTo(ex + 30, ey - 30); ctx.lineTo(ex - 30, ey + 30); ctx.stroke(); }
    }

    ctx.globalCompositeOperation = 'lighter';
    particles.forEach(p => { ctx.fillStyle = p.color; ctx.fillRect(p.x, p.y, 6, 6); });
    ctx.globalCompositeOperation = 'source-over';

    ctx.fillStyle = 'red'; ctx.font = "bold 32px DotGothic16"; ctx.shadowColor = 'white'; ctx.shadowBlur = 4;
    dmgTexts.forEach(dt => ctx.fillText(dt.text, dt.x, dt.y)); ctx.shadowBlur = 0;
    ctx.restore();
}

let gameLoopId;
function loop() {
    if (!isBattling) updateGame();
    if (isBattling || particles.length > 0 || dmgTexts.length > 0) updateBattleEffects();
    updateAllSprites();
    drawGame();
    if (isFashionShow) drawFashionShow(); // Draw separate layer if active
    gameLoopId = requestAnimationFrame(loop);
}

// ==========================================
// SYSTEM UI LOGIC: MENU & START
// ==========================================
function toggleMenu() {
    if (isBattling || isShopOpen || isFashionShow) return;
    isMenuOpen = !isMenuOpen; playSound('select');
    const b = document.getElementById('status-menu');
    if (isMenuOpen) {
        b.classList.remove('hidden');
        document.getElementById('menu-avatar-name').textContent = `${GameState.avatar.name} (${GameState.avatar.job})`;
        updateListingUI();
        const list = document.getElementById('party-list'); list.innerHTML = '';
        if (GameState.party.length === 0) list.innerHTML = '<li>まだ魔物や召喚した魂はありません。</li>';
        GameState.party.forEach(p => {
            const li = document.createElement('li');
            // 重複召喚で強化された分(Lv/継承回数/攻撃補正/スキルLv)を共通表示する
            const growthLabel = `Lv.${p.level || 1}${p.duplicateCount ? ` (継承${p.duplicateCount}回 / 攻撃+${p.atkBonusPct || 0}% / スキルLv${p.skillLevel || 1})` : ''}`;
            if (p.job === '魔物') {
                li.textContent = `${p.name} (元・${p.originItem}の主) ${growthLabel}`;
            } else {
                const visual = ALLY_VISUALS[p.job] || ALLY_VISUALS['裁断戦士'];
                li.className = `party-member-row ${visual.roleClass}`;
                li.innerHTML = `<span class="party-sprite" style="--ally-sprite:url('${visual.path}')"></span><span>✨${p.name}<small>${visual.label} / ${p.style} / ${p.rarity} / ${growthLabel}</small></span>`;
            }
            list.appendChild(li);
        });
    } else { b.classList.add('hidden'); }
}
document.getElementById('btn-open-menu').addEventListener('click', toggleMenu); document.getElementById('btn-close-menu').addEventListener('click', toggleMenu);

function openShopDirect() {
    if (isBattling || isMenuOpen || isShopOpen || isFashionShow) return;
    openShop();
}
document.getElementById('btn-open-shop-direct').addEventListener('click', openShopDirect);

window.addEventListener('keydown', e => {
    if (!isMenuOpen && !isShopOpen && !isFashionShow) keys[e.key] = true;
    if ((e.key === 'm' || e.key === 'M') && !isShopOpen) toggleMenu();
    if (e.key === 'g' || e.key === 'G') openShopDirect();
    if (e.key === 'Escape' && isMenuOpen) toggleMenu();
}); window.addEventListener('keyup', e => { keys[e.key] = false; });

document.getElementById('clothing-upload').addEventListener('change', async (e) => {
    if (!e.target.files.length) return;
    playSound('crystal'); document.getElementById('upload-area').innerHTML = '<span class="blink">🔮 鑑定中（16bit解析）...</span>';
    const data = await analyzeImageFast(); playSound('fanfare'); GameState.avatar = data;
    document.getElementById('upload-area').classList.add('hidden'); document.getElementById('analysis-result').classList.remove('hidden');
    ['name', 'job', 'hp', 'mp', 'agi'].forEach(k => document.getElementById(`stat-${k}`) ? (document.getElementById(`stat-${k}`).textContent = data[k]) : null);
    document.getElementById('result-name').textContent = data.name; document.getElementById('ui-player-name').textContent = data.name; document.getElementById('ui-hp').textContent = data.hp;
});

function startGame() {
    playSound('select');
    document.getElementById('ritual-screen').classList.replace('active', 'hidden'); document.getElementById('game-screen').classList.replace('hidden', 'active');
    playFastEpicBGM(false); player.x = 190; player.y = 190; historyLog.length = 0; GameState.party = []; updateGold(0);
    GameState.avatar.sprite = new SpriteAnimator('hero', GameState.avatar.job);
    currentTrend = ALL_STYLES[Math.floor(Math.random() * ALL_STYLES.length)]; // Init trend
    if (!gameLoopId) loop();
}
document.getElementById('btn-start-adventure').addEventListener('click', startGame);
document.getElementById('btn-skip').addEventListener('click', () => {
    GameState.avatar = { name: '伝説の紋章・ゼアル', job: '勇者', style: '炎', color: '#ff4500', hp: 150, maxHp: 150, mp: 100, agi: 80, tension: 50 };
    startGame(); updateGold(500);
});

// ==========================================
// BOTTLE MAIL & SHOP GACHA (伝説のクローゼット)
// ==========================================
const shopScreen = document.getElementById('shop-screen');
const magicCir = document.getElementById('magic-circle');
const shopMsg = document.getElementById('shop-msg');
const bottleDialog = document.getElementById('bottle-mail-dialog');
const summonArea = document.querySelector('.summon-area');
const gachaRelic = document.getElementById('gacha-relic');

function openShop() {
    isShopOpen = true; keys['ArrowUp'] = keys['w'] = false; player.vy = 0;
    playFastEpicBGM('shop'); shopScreen.classList.remove('hidden');
    document.getElementById('summon-result').innerHTML = ''; magicCir.classList.add('hidden');
    summonArea.classList.remove('summoning');
    clearGachaRankClasses();
    gachaRelic.className = 'hidden';
    gachaRelic.src = 'assets/ui/chronoseed_dormant.png';
    document.getElementById('btn-summon').disabled = false; shopMsg.innerHTML = `新たな魂（仲間）を召喚しますか？<br>所持: ${GameState.gold} G  |  1回: <span style="color:#f1c40f;">100 G</span>`;
}
document.getElementById('btn-close-shop').addEventListener('click', () => { playSound('select'); isShopOpen = false; shopScreen.classList.add('hidden'); playFastEpicBGM(false); player.y += 20; });

const BGM_MOCK_PROMPTS = [
    "「この遺物は、かつての勇者が大事に持っていた伝説の一品だ！」",
    "「前の主と共に、カジュアル平原を100マイル旅した記憶が宿っている…」",
    "「大切に手放されたこの遺物は、君という新しい主を待っていた！」"
];

function showBottleMail(name) {
    playSound('crystal'); bottleDialog.classList.remove('hidden');
    const msg = BGM_MOCK_PROMPTS[Math.floor(Math.random() * BGM_MOCK_PROMPTS.length)];
    const textEl = document.getElementById('bottle-mail-text');
    textEl.style.animation = 'none'; void textEl.offsetWidth; // reset anim
    textEl.textContent = `【${name}の記憶】\n\n${msg}\n\nそして今、あなたと共に新たな循環の旅へ——。`;
    textEl.style.animation = 'typing 3s steps(40, end)';
}
document.getElementById('btn-close-mail').addEventListener('click', () => { bottleDialog.classList.add('hidden'); });

function shopScreenShake(strength) {
    shopScreen.classList.add('shop-shake');
    setTimeout(() => shopScreen.classList.remove('shop-shake'), strength * 200);
}

// S/SS/SSS共通のカットイン。ランクが上がるほど専用の色・長さになる
const RANK_CUTIN_CONFIG = {
    S: { text: '✨ S ランク 登場 ✨', cls: 's-cutin', dur: 700 },
    SS: { text: '✨ SS 超激レア 登場 ✨', cls: 'ss-cutin', dur: 850 },
    SSS: { text: '✨ SSS 超激レア降臨 ✨', cls: 'sss-cutin', dur: 1000 }
};
function triggerRankCutin(rankData, onDone) {
    const cfg = RANK_CUTIN_CONFIG[rankData.key];
    if (!cfg) { if (onDone) onDone(); return; }
    const cutin = document.getElementById('cutin-container');
    const cutinText = cutin.querySelector('.cutin-text');
    const prevText = cutinText.textContent;
    cutinText.textContent = cfg.text;
    cutin.classList.add(cfg.cls);
    cutin.classList.remove('hidden'); cutin.classList.add('animate-cutin');
    setTimeout(() => {
        cutin.classList.remove('animate-cutin'); cutin.classList.add('hidden'); cutin.classList.remove(cfg.cls);
        cutinText.textContent = prevText;
        if (onDone) onDone();
    }, cfg.dur);
}

document.getElementById('btn-summon').addEventListener('click', () => {
    if (GameState.gold < 100) { playSound('hit'); alert("Gが足りません！"); return; }
    updateGold(-100); playSound('noise');
    document.getElementById('btn-summon').disabled = true;
    document.getElementById('summon-result').innerHTML = '';
    summonArea.classList.add('summoning');
    gachaRelic.src = 'assets/ui/chronoseed_dormant.png';
    gachaRelic.className = 'relic-arrive';
    magicCir.className = ''; magicCir.classList.remove('hidden'); magicCir.classList.add('charging-1');

    // 結果(B/A/S/SS/SSS)は先に抽選しておき、盛り上がりの演出だけを段階的に見せる
    const rand = Math.random();
    const rankData = RARITY_TABLE.find(r => rand < r.cum);
    const pool = CHARACTER_POOL[rankData.key];
    const picked = pool[Math.floor(Math.random() * pool.length)];
    const itemStyle = ALL_STYLES[Math.floor(Math.random() * ALL_STYLES.length)];
    const job = rankData.job;
    const allyVisual = ALLY_VISUALS[job] || ALLY_VISUALS['裁断戦士'];
    const total = rankData.buildupMs;
    clearGachaRankClasses();
    summonArea.classList.add(`summon-rank-${rankData.key.toLowerCase()}`);
    playRankSummonBGM(rankData.key); // レア度別オリジナルBGMを召喚中ずっと再生

    const messages = rankData.shakeLv >= 3 ? SUSPENSE_HIGH : (rankData.shakeLv >= 1 ? SUSPENSE_MID : SUSPENSE_LOW);
    let msgIdx = 0;
    shopMsg.textContent = messages[0];
    const tickTimer = setInterval(() => {
        playSound('tick');
        msgIdx = (msgIdx + 1) % messages.length;
        shopMsg.textContent = messages[msgIdx];
    }, Math.max(220, Math.floor(total / 6)));

    setTimeout(() => {
        magicCir.classList.remove('charging-1'); magicCir.classList.add('charging-2');
        gachaRelic.src = 'assets/ui/chronoseed_awake.png';
        gachaRelic.className = 'relic-charge';
        if (rankData.shakeLv >= 1) shopScreenShake(rankData.shakeLv);
    }, total * 0.4);

    setTimeout(() => {
        magicCir.classList.remove('charging-2'); magicCir.classList.add('charging-3');
        if (rankData.shakeLv >= 2) shopScreenShake(rankData.shakeLv);
    }, total * 0.75);

    setTimeout(() => {
        clearInterval(tickTimer);

        playSound(rankData.sfx);
        const flash = document.getElementById('flash-effect');
        flash.className = rankData.flashClass; flash.classList.remove('hidden');
        magicCir.className = 'hidden';
        gachaRelic.src = 'assets/ui/chronoseed_release.png';
        gachaRelic.className = 'relic-release';

        setTimeout(() => flash.classList.add('hidden'), 900 + rankData.shakeLv * 400);

        // 召喚された仲間のスプライトを画面中央へ大きく表示するマークアップを組み立てる。
        // S以上は最初シルエット(黒塗り)で登場させ、カットインの後に本カラーへ切り替える。
        const buildResultMarkup = (silhouette) => {
            document.getElementById('summon-result').innerHTML = `
              <div class="gacha-reveal rank-${rankData.key.toLowerCase()} ${allyVisual.roleClass}">
                <div class="summoned-ally big ${silhouette ? 'silhouette' : ''}" style="--ally-sprite:url('${allyVisual.path}')"></div>
                <div class="gacha-card rarity-${rankData.key.toLowerCase()}">
                  <div class="gacha-rank">${rankData.title}</div>
                  <h3 style="color:${picked.color}; margin-top:4px;">${picked.name}</h3>
                  <small>${allyVisual.label} / 属性: ${itemStyle}</small>
                </div>
              </div>`;
        };

        const finishReveal = () => {
            const baseMsg = rankData.shakeLv >= 3
                ? `✨${rankData.title}★ 超激レアの魂が舞い降りた！ ★${rankData.title}✨`
                : '召喚成功！新しい仲間がパーティに加わった！';

            const result = addOrEnhancePartyMember({ name: picked.name, job, rarity: rankData.key, style: itemStyle, color: picked.color, visualPath: allyVisual.path, isDragon: false, originItem: '時環召喚', sprite: new SpriteAnimator('ally', job) });
            shopMsg.innerHTML = result.merged
                ? `${baseMsg}<br>💫 同じ魂が重なった！ Lv.${result.member.level} へ強化（攻撃+${result.member.atkBonusPct}%）`
                : baseMsg;
            document.getElementById('btn-summon').disabled = false;
            shopMsg.innerHTML += `<br><br>所持: ${GameState.gold} G`;

            // 伝説4: Bottle Mail Logic (10% chance to pop up)
            if (Math.random() < 0.1) setTimeout(() => showBottleMail(picked.name), 1000);

            // ファンファーレが鳴り終わる頃に観測室のBGMへ戻す
            setTimeout(() => { if (isShopOpen) playFastEpicBGM('shop'); }, 2400);
        };

        // キャラクター登場の瞬間にファンファーレを鳴らす
        const revealWithFanfare = (silhouetteWasShown) => {
            const sprite = document.querySelector('.summoned-ally.big');
            if (silhouetteWasShown && sprite) sprite.classList.remove('silhouette');
            stopBGM();
            playSound(rankData.fanfare);
            finishReveal();
        };

        // 時環の種子が展開する瞬間を見せてから、レアリティと仲間を表示する
        setTimeout(() => {
            summonArea.classList.remove('summoning');
            gachaRelic.classList.add('relic-faded');

            if (rankData.shakeLv >= 2) {
                // S/SS/SSS: まずシルエットで登場させ、間を溜めてからカットイン→本カラー公開
                buildResultMarkup(true);
                const silhouetteHoldMs = rankData.key === 'SSS' ? 750 : (rankData.key === 'SS' ? 550 : 380);
                setTimeout(() => {
                    triggerRankCutin(rankData, () => revealWithFanfare(true));
                }, silhouetteHoldMs);
            } else {
                // B/A: 溜めが短いのですぐカラーで登場
                buildResultMarkup(false);
                revealWithFanfare(false);
            }
        }, 520);

    }, total);
});

// ==========================================
// BATTLE & PERFECT FIT & FASHION SHOW
// ==========================================
const battleDlg = document.getElementById('battle-dialog'); const bName = document.getElementById('battle-monster-name'); const bMsg = document.getElementById('battle-msg'); const bActions = document.getElementById('battle-actions'); const hpFill = document.getElementById('enemy-hp-bar');
const heroHpFill = document.getElementById('hero-hp-bar'); const heroMpFill = document.getElementById('hero-mp-bar');
const heroHpText = document.getElementById('hero-hp-text'); const heroMpText = document.getElementById('hero-mp-text');

function updateHPUI() {
    if (!currentEnemy) return; const pct = Math.max(0, (currentEnemy.hp / currentEnemy.maxHp) * 100); hpFill.style.width = `${pct}%`; hpFill.style.background = pct > 50 ? '#00ff00' : (pct > 20 ? '#ffaa00' : '#ff0000');
}

// 戦闘HUD: 勇者のHP/MPバーを更新する
function updateHeroHUD() {
    const av = GameState.avatar;
    const hpPct = Math.max(0, Math.min(100, (av.hp / (av.maxHp || 100)) * 100));
    const mpPct = Math.max(0, Math.min(100, (av.mp / (av.maxMp || 50)) * 100));
    if (heroHpFill) heroHpFill.style.width = `${hpPct}%`;
    if (heroMpFill) heroMpFill.style.width = `${mpPct}%`;
    if (heroHpText) heroHpText.textContent = Math.round(av.hp);
    if (heroMpText) heroMpText.textContent = Math.round(av.mp);
    document.getElementById('ui-hp').textContent = Math.round(av.hp);
}

// 敵の反撃。A/Sランクほど発生しやすく、専用技（通常反撃の強化版）が出ることもある。
const ENEMY_SPECIAL_NAMES = { mid: '服飾呪縛', boss: '百鬼衣装絶' };
function enemyCounterAttack(onDone) {
    if (!currentEnemy || currentEnemy.hp <= 0) { if (onDone) onDone(); return; }
    const counterChance = currentEnemy.tier === 'boss' ? 0.45 : (currentEnemy.tier === 'mid' ? 0.30 : 0.15);
    if (Math.random() > counterChance) { if (onDone) onDone(); return; }

    // 中型/ボスは専用技として通常反撃より強いダメージを出すことがある
    const isSpecial = (currentEnemy.tier === 'mid' || currentEnemy.tier === 'boss') && Math.random() < 0.4;
    const tierMulti = currentEnemy.tier === 'boss' ? 2.0 : (currentEnemy.tier === 'mid' ? 1.4 : 1.0);
    const dmg = Math.max(1, Math.round(randInt(15, 30) * tierMulti * (isSpecial ? 1.6 : 1)));

    GameState.avatar.hp = Math.max(1, GameState.avatar.hp - dmg);
    updateHeroHUD();
    if (GameState.avatar.sprite) GameState.avatar.sprite.triggerHit({ hitStopFrames: isSpecial ? 10 : 5, flashFrames: isSpecial ? 24 : 12, knockbackPower: isSpecial ? 10 : 5, fromX: 1, fromY: 0, toX: 0, toY: 0.15 });
    screenShakeTimer = Math.max(screenShakeTimer, isSpecial ? 24 : 12);
    playSound(isSpecial ? 'magic' : 'hit');
    showDamage(200, 380, dmg);

    bMsg.innerHTML += isSpecial
        ? `<br>⚔️【${currentEnemy.name}の専用技「${ENEMY_SPECIAL_NAMES[currentEnemy.tier]}」】反撃！ 勇者は${dmg}ダメージを受けた！`
        : `<br>${currentEnemy.name}の反撃！ 勇者は${dmg}ダメージを受けた！`;

    setTimeout(() => { if (onDone) onDone(); }, 700);
}

function startEncounter() {
    if (isMenuOpen || isShopOpen || isFashionShow) return; isBattling = true; keys['ArrowUp'] = keys['ArrowDown'] = keys['ArrowLeft'] = keys['ArrowRight'] = false;
    stopBGM(); playSound('noise'); document.getElementById('game-screen').classList.add('screen-shake'); document.getElementById('encounter-effect').classList.remove('hidden');
    attackLungeT = 0; attackLungeDir = 0; skillChargeTimer = 0;
    setTimeout(() => {
        document.getElementById('game-screen').classList.remove('screen-shake'); document.getElementById('encounter-effect').classList.add('hidden');
        currentEnemy = generateEnemy(GameState.avatar.style); battleViewState = 'idle'; updateHPUI(); updateHeroHUD();
        // 戦闘中は主人公・仲間とも敵側(右)を向かせる
        if (GameState.avatar.sprite) { GameState.avatar.sprite.dir = DIR.RIGHT; GameState.avatar.sprite.setAction('idle'); }
        GameState.party.forEach(p => { if (p.sprite) { p.sprite.dir = DIR.RIGHT; p.sprite.setAction('idle'); } });
        bName.textContent = `⚠️ 【${currentEnemy.name}】[${currentEnemy.rankLabel}ランク] が現れた！`; bMsg.textContent = `「その力、まだ我には及ばぬな…」`;
        bActions.classList.remove('hidden'); document.getElementById('ally-select-panel').classList.add('hidden'); battleDlg.classList.remove('hidden'); playFastEpicBGM(true);
    }, 1200);
}

function executeAttack(damageMulti = 1, attackTypeStr = '攻撃', isPiercing = false) {
    if (battleViewState !== 'idle' || !currentEnemy) return;
    battleViewState = 'attacking'; bActions.classList.add('hidden'); playSound('slash');
    slashEffectTimer = 15; screenShakeTimer = 20;
    attackLungeDir = 1; setTimeout(() => { attackLungeDir = -1; }, 260); // 踏み込み攻撃: 前進してから構え位置へ戻る
    if (GameState.avatar.sprite) GameState.avatar.sprite.setAction('attack'); // 攻撃中は移動を制限(既にbattleViewStateで制限済み)

    // Check Perfect Fit Connect
    let perfectFitAllies = GameState.party.filter(p => p.style === GameState.avatar.style || p.style === currentEnemy.style);

    const tensionScore = GameState.avatar.tension || 0;
    const rawDmg = Math.floor((Math.random() * 30 + 50) * damageMulti + (tensionScore / 5));
    // 主人公スキル「衣装奥義・シームブレイク」(isPiercing)のみ、A/Sランクの障壁を貫通できる
    const { dmg, blocked } = applyDamageToEnemy(currentEnemy, rawDmg, isPiercing);
    updateHPUI();
    if (currentEnemy.sprite) currentEnemy.sprite.triggerHit({ hitStopFrames: 6, flashFrames: 16, knockbackPower: 8, fromX: 0, fromY: 0, toX: 1, toY: -0.2 });

    if (blocked) {
        showDamage(600, 360, 0);
        bMsg.textContent = `🛡️ 障壁が攻撃を阻んだ！ スキルか属性連携で破れ！`;
    } else {
        showDamage(600, 360, dmg);
        bMsg.textContent = `勇者の${attackTypeStr}！ ${dmg} のダメージ！`;
    }

    if (currentEnemy.hp <= 0) {
        setTimeout(() => triggerCirculation(), 800);
        return;
    }

    setTimeout(() => {
        if (perfectFitAllies.length > 0) perfectFitPhase(perfectFitAllies);
        else coOpPhase();
    }, 1200);
}

// 伝説2: Perfect Fit Connect
function perfectFitPhase(allies) {
    if (!currentEnemy || currentEnemy.hp <= 0) return;
    bMsg.textContent = `属性一致！ 完全なる連携攻撃（Perfect Fit!）`;
    const cutin = document.getElementById('cutin-container');
    cutin.classList.remove('hidden');
    cutin.classList.add('animate-cutin');
    playSound('fanfare');

    setTimeout(() => {
        if (!currentEnemy) return;
        screenShakeTimer = 30;
        let totalRawDmg = 0;
        allies.forEach(ally => {
            let base = ally.job === '染色術師' ? 120 : (ally.job === '採寸弓師' ? 80 : 40);
            let dmg = Math.round(base * getAllyDamageMultiplier(ally));
            totalRawDmg += dmg;
            if (ally.job === '染色術師') spawnMagicParticles(200, 300, 600, 380, '#e85bb5');
            for (let i = 0; i < 3; i++) showDamage(600 + (Math.random() * 60 - 30), 380 + (Math.random() * 60 - 30), Math.round(dmg / 3));
            if (ally.sprite) { ally.sprite.setAction('attack'); setTimeout(() => ally.sprite.setAction('idle'), 500); }
        });
        playSound('magic'); playSound('slash');
        // 属性一致の連携攻撃(Perfect Fit)は貫通攻撃: A/Sランクの障壁も破壊できる
        const { dmg: appliedDmg } = applyDamageToEnemy(currentEnemy, totalRawDmg, true);
        updateHPUI();
        if (currentEnemy.sprite) currentEnemy.sprite.triggerHit({ hitStopFrames: 8, flashFrames: 20, knockbackPower: 12, fromX: 0, fromY: 0, toX: 1, toY: -0.2 });

        setTimeout(() => {
            cutin.classList.remove('animate-cutin'); cutin.classList.add('hidden');
            if (currentEnemy && currentEnemy.hp <= 0) {
                triggerCirculation();
            } else {
                bMsg.textContent = `連携追撃で特大 ${appliedDmg}ダメージ！`;
                enemyCounterAttack(() => {
                    battleViewState = 'idle';
                    if (GameState.avatar.sprite) GameState.avatar.sprite.setAction('idle');
                    bActions.classList.remove('hidden');
                });
            }
        }, 1200);
    }, 1000);
}

function coOpPhase() {
    if (!currentEnemy || currentEnemy.hp <= 0) return;
    if (GameState.party.length === 0) {
        bMsg.textContent = `【${currentEnemy.name}】は渋っている...`;
        enemyCounterAttack(() => { battleViewState = 'idle'; bActions.classList.remove('hidden'); });
        return;
    }
    bMsg.textContent = `仲間の総攻撃（オート追撃）！`;
    let totalFollowDmg = 0;
    let anyBlocked = false;

    function attackAlly(index) {
        if (!currentEnemy || currentEnemy.hp <= 0 || index >= GameState.party.length) {
            setTimeout(() => {
                if (currentEnemy && currentEnemy.hp <= 0) triggerCirculation();
                else if (currentEnemy) {
                    bMsg.textContent = anyBlocked
                        ? `追撃で合計 ${totalFollowDmg}ダメージ！ 🛡️ 障壁は通常攻撃では破れない…スキルか属性連携で破れ！`
                        : `追撃で合計 ${totalFollowDmg}ダメージ！`;
                    enemyCounterAttack(() => {
                        battleViewState = 'idle';
                        if (GameState.avatar.sprite) GameState.avatar.sprite.setAction('idle');
                        bActions.classList.remove('hidden');
                    });
                }
            }, 600);
            return;
        }
        let ally = GameState.party[index];
        let base = ally.job === '染色術師' ? 80 : (ally.job === '採寸弓師' ? 50 : 20);
        let rawDmg = Math.round(base * getAllyDamageMultiplier(ally));
        if (ally.sprite) { ally.sprite.setAction('attack'); setTimeout(() => ally.sprite.setAction('idle'), 300); }
        if (ally.job === '染色術師') { playSound('magic'); spawnMagicParticles(200, 300, 600, 380, '#e85bb5'); screenShakeTimer = 10; }
        else if (ally.job === '採寸弓師') { playSound('slash'); showDamage(610, 350, 15); showDamage(590, 370, 15); showDamage(620, 380, 20); }
        else { playSound('hit'); }

        // 仲間の通常追撃も貫通不可: A/Sランクの障壁は破れない
        const { dmg, blocked } = applyDamageToEnemy(currentEnemy, rawDmg, false);
        if (blocked) anyBlocked = true;
        showDamage(600 + (Math.random() * 40 - 20), 380 + (Math.random() * 40 - 20), dmg);
        totalFollowDmg += dmg; updateHPUI();
        if (currentEnemy.sprite) currentEnemy.sprite.triggerHit({ hitStopFrames: 5, flashFrames: 14, knockbackPower: 6, fromX: 0, fromY: 0, toX: 1, toY: -0.15 });

        if (currentEnemy.hp <= 0) {
            setTimeout(() => { triggerCirculation(); }, 800);
        } else {
            setTimeout(() => attackAlly(index + 1), 400);
        }
    }
    attackAlly(0);
}

document.getElementById('btn-attack').addEventListener('click', () => executeAttack(1.0, '渾身の斬撃', false));

// ==========================================
// 戦闘中の仲間選択（ガチャで加入した仲間から1体を指名して攻撃させる）
// ==========================================
const allySelectPanel = document.getElementById('ally-select-panel');

function openAllySelect() {
    if (battleViewState !== 'idle' || !currentEnemy) return;
    if (GameState.party.length === 0) { bMsg.textContent = `一緒に戦う仲間がいない…`; return; }
    playSound('select');
    bActions.classList.add('hidden');
    allySelectPanel.innerHTML = '';
    GameState.party.forEach(ally => {
        const btn = document.createElement('button');
        btn.className = 'retro-btn cmd-btn';
        btn.textContent = `▶ ${ally.name} [${ally.job} Lv.${ally.level || 1}]`;
        btn.addEventListener('click', () => commandAllyAttack(ally));
        allySelectPanel.appendChild(btn);
    });
    const backBtn = document.createElement('button');
    backBtn.className = 'retro-btn cmd-btn';
    backBtn.textContent = '▶ 戻る';
    backBtn.addEventListener('click', closeAllySelect);
    allySelectPanel.appendChild(backBtn);
    allySelectPanel.classList.remove('hidden');
}

function closeAllySelect() {
    playSound('select');
    allySelectPanel.classList.add('hidden');
    bActions.classList.remove('hidden');
}

function commandAllyAttack(ally) {
    if (battleViewState !== 'idle' || !currentEnemy) return;
    allySelectPanel.classList.add('hidden');
    battleViewState = 'attacking';
    playSound('select');

    // 指名攻撃は総追撃(coOpPhase)より一撃が重い
    const base = ally.job === '染色術師' ? 100 : (ally.job === '採寸弓師' ? 65 : 30);
    const rawDmg = Math.round(base * getAllyDamageMultiplier(ally));
    if (ally.sprite) { ally.sprite.setAction('attack'); setTimeout(() => ally.sprite.setAction('idle'), 400); }
    if (ally.job === '染色術師') { playSound('magic'); spawnMagicParticles(200, 300, 600, 380, '#e85bb5'); screenShakeTimer = Math.max(screenShakeTimer, 14); }
    else if (ally.job === '採寸弓師') { playSound('slash'); }
    else { playSound('hit'); }

    // 主人公の属性と一致するか、敵の属性と一致していれば属性連携とみなし障壁も貫通できる
    const isPiercing = (ally.style === GameState.avatar.style || ally.style === currentEnemy.style);
    const { dmg, blocked } = applyDamageToEnemy(currentEnemy, rawDmg, isPiercing);
    updateHPUI();
    if (currentEnemy.sprite) currentEnemy.sprite.triggerHit({ hitStopFrames: 6, flashFrames: 16, knockbackPower: 8, fromX: 0, fromY: 0, toX: 1, toY: -0.2 });

    if (blocked) {
        showDamage(600, 360, 0);
        bMsg.textContent = `🛡️ ${ally.name}の攻撃は障壁に阻まれた！ スキルか属性連携で破れ！`;
    } else {
        showDamage(600, 360, dmg);
        bMsg.textContent = isPiercing ? `${ally.name}の属性一致攻撃！ ${dmg}のダメージ！` : `${ally.name}の攻撃！ ${dmg}のダメージ！`;
    }

    if (currentEnemy.hp <= 0) { setTimeout(() => triggerCirculation(), 800); return; }

    setTimeout(() => {
        enemyCounterAttack(() => {
            battleViewState = 'idle';
            bActions.classList.remove('hidden');
        });
    }, 900);
}

document.getElementById('btn-ally').addEventListener('click', openAllySelect);

document.getElementById('btn-skill').addEventListener('click', () => {
    if (battleViewState !== 'idle' || !currentEnemy) return;
    if (GameState.avatar.mp < 10) { playSound('hit'); bMsg.textContent = `MP不足！`; return; }
    GameState.avatar.mp -= 10; updateHeroHUD();

    // スキル溜め演出: 主人公が発光しながら少し溜めてから、衣装奥義を放つ(A/Sランクの障壁も貫通する)
    battleViewState = 'charging'; bActions.classList.add('hidden');
    bMsg.textContent = `✨ オーラを溜めている…`;
    skillChargeTimer = 40; screenShakeTimer = Math.max(screenShakeTimer, 6);
    playSound('magic');
    setTimeout(() => {
        battleViewState = 'idle';
        executeAttack(1.8, '衣装奥義・シームブレイク', true);
    }, 650);
});
document.getElementById('btn-item').addEventListener('click', () => { playSound('select'); executeAttack(0.8, '秘薬の一撃', false); });
document.getElementById('btn-run').addEventListener('click', () => {
    playSound('select'); battleDlg.classList.add('hidden'); isBattling = false; currentEnemy = null; playFastEpicBGM(false);
    attackLungeT = 0; attackLungeDir = 0; skillChargeTimer = 0;
    allySelectPanel.classList.add('hidden'); bActions.classList.remove('hidden');
});

let fsCanvas, fsCtx, fsTime = 0, fsBoss = null;

function triggerCirculation() {
    battleViewState = 'particleJoin'; stopBGM(); playSound('fanfare');
    attackLungeT = 0; attackLungeDir = 0; skillChargeTimer = 0;
    if (GameState.avatar.sprite) GameState.avatar.sprite.setAction('idle');
    if (currentEnemy && currentEnemy.sprite) currentEnemy.sprite.setAction('death');
    bMsg.textContent = `敵の体力が0になった！\n魂が光の粒子となって崩れていく…`;
    spawnParticles(600, 380);
    const reward = currentEnemy.goldDrop || 50; updateGold(reward);

    setTimeout(() => { bMsg.textContent = `敵の魂がGへと変換された！ (獲得: ${reward} G)`; playSound('crystal'); }, 1500);

    setTimeout(() => {
        battleDlg.classList.add('hidden');

        // 伝説3: Fashion Show for Boss（撃破後は仲間にはならず、凱旋ボーナスGに変換される）
        if (currentEnemy && currentEnemy.isDragon) {
            startFashionShow(currentEnemy);
            currentEnemy = null; // Fix memory leak and ensure draw mode properly works
        } else if (currentEnemy) {
            // 敵は仲間にはならず、そのままGに変換して終了する
            const bonus = Math.round((currentEnemy.goldDrop || 30) * 0.5);
            updateGold(bonus);
            const dialogText = document.getElementById('dialog-text');
            if (dialogText) {
                const prevText = dialogText.textContent;
                dialogText.textContent = `💰 敵の魂がGに変換された！ (+${bonus} G)`;
                setTimeout(() => { dialogText.textContent = prevText; }, 3000);
            }
            currentEnemy = null; isBattling = false; battleViewState = 'idle';
            playFastEpicBGM(false);
        }
    }, 4000);
}

// 伝説3: Fashion Show Logic
function startFashionShow(bossEnemy) {
    isFashionShow = true; fsBoss = bossEnemy; fsTime = 0;
    document.getElementById('fashion-show-screen').classList.remove('hidden');
    fsCanvas = document.getElementById('fs-canvas'); fsCtx = fsCanvas.getContext('2d');
    fsCtx.imageSmoothingEnabled = false; // ドットをぼかさない
    if (GameState.avatar.sprite) { GameState.avatar.sprite.dir = DIR.RIGHT; GameState.avatar.sprite.setAction('walk'); }
    if (fsBoss.sprite) fsBoss.sprite.setAction('walk');
    playSound('gacha'); // special fanfare
}

function drawFashionShow() {
    fsTime++;
    fsCtx.fillStyle = 'rgba(0,0,0,0.8)'; fsCtx.fillRect(0, 0, 800, 600); // Darken Layer

    // Draw Spotlights
    fsCtx.globalCompositeOperation = 'lighter';
    const spotX = 400 + Math.sin(fsTime * 0.02) * 100;
    let radGrad = fsCtx.createRadialGradient(spotX, 350, 0, spotX, 350, 200);
    radGrad.addColorStop(0, 'rgba(255,255,255,0.6)'); radGrad.addColorStop(1, 'rgba(0,0,0,0)');
    fsCtx.fillStyle = radGrad; fsCtx.fillRect(0, 0, 800, 600);
    fsCtx.globalCompositeOperation = 'source-over';

    // Draw Runway (Red carpet)
    fsCtx.fillStyle = '#c0392b'; fsCtx.fillRect(0, 380, 800, 100);
    fsCtx.fillStyle = '#f1c40f'; fsCtx.fillRect(0, 385, 800, 5); fsCtx.fillRect(0, 470, 800, 5);

    // Characters walking to center then posing
    let heroX = -100 + (fsTime * 3); if (heroX > 320) heroX = 320;
    let bossX = 900 - (fsTime * 3); if (bossX < 480) bossX = 480;

    if (heroX >= 320 && GameState.avatar.sprite) GameState.avatar.sprite.setAction('idle');
    if (bossX <= 480 && fsBoss.sprite) fsBoss.sprite.setAction('idle');

    if (GameState.avatar.sprite) drawSprite(fsCtx, GameState.avatar.sprite, heroX, 350, { scale: 2 });
    if (fsBoss.sprite) drawSprite(fsCtx, fsBoss.sprite, bossX, 350, { scale: 1.5, flipX: true });

    if (fsTime > 150 && fsTime < 250) {
        fsCtx.fillStyle = '#fff'; fsCtx.font = "italic bold 40px DotGothic16"; fsCtx.textAlign = "center";
        fsCtx.fillText("LEGENDARY CIRCULATION !!", 400, 200); fsCtx.textAlign = "left";
        if (fsTime === 160) spawnMagicParticles(400, 300, 400, 0, '#f1c40f');
    }

    if (fsTime > 300) {
        // End show（ボスも仲間にはならず、凱旋ボーナスGに変換される）
        isFashionShow = false; document.getElementById('fashion-show-screen').classList.add('hidden');
        const bonus = Math.round((fsBoss.goldDrop || 150) * 0.8);
        updateGold(bonus);
        const dialogText = document.getElementById('dialog-text');
        if (dialogText) {
            const prevText = dialogText.textContent;
            dialogText.textContent = `💰 凱旋の儀が終わり、ボスの魂がGに変換された！ (+${bonus} G)`;
            setTimeout(() => { dialogText.textContent = prevText; }, 3000);
        }
        currentEnemy = null; isBattling = false; battleViewState = 'idle';
        playFastEpicBGM(false);
    }
}

function triggerEnding() {
    stopBGM(); playSound('fanfare');
    document.getElementById('game-screen').classList.replace('active', 'hidden'); document.getElementById('ending-screen').classList.replace('hidden', 'active');
    document.getElementById('ending-text').innerHTML = `${GameState.avatar.name}の旅は終わり、<br>また新たな「巡礼」の物語が始まる...`;
}
document.getElementById('btn-restart').addEventListener('click', () => location.reload());

// ==========================================
// 伝説の継承：出品 → 購入者評価を受信した時だけ一度通知
// ==========================================
const legacyNotif = document.getElementById('legacy-notification');
const legacyText = document.getElementById('legacy-text');
const listingStatus = document.getElementById('listing-status');
const listClothingBtn = document.getElementById('btn-list-clothing');
let legacyActive = false;

const BUYER_REVIEWS = [
    { buyer: '星港の旅人', stars: 5, comment: '色の組み合わせが素敵で、冒険に出るのが楽しみです。' },
    { buyer: '月影通りの仕立師', stars: 4, comment: '大切に使われていたことが伝わる服でした。' },
    { buyer: '青晶区の探索者', stars: 5, comment: '届いた服から勇気をもらえました。ありがとう！' }
];

function updateListingUI() {
    if (!listingStatus || !listClothingBtn) return;
    const listing = GameState.listing;
    if (!listing || listing.status === 'completed') {
        listingStatus.textContent = listing ? '出品状況：評価受取済み' : '出品状況：未出品';
        listClothingBtn.textContent = listing ? 'もう一度出品する' : '現在の服を出品する';
        listClothingBtn.disabled = false;
    } else if (listing.status === 'listed') {
        listingStatus.textContent = `出品中：${listing.itemName}（評価待ち）`;
        listClothingBtn.textContent = '相手からの評価を待っています';
        listClothingBtn.disabled = true;
    } else if (listing.status === 'reviewed') {
        listingStatus.textContent = `評価到着：${listing.review.stars}★ ${listing.review.buyer}`;
        listClothingBtn.textContent = '届いた評価を確認する';
        listClothingBtn.disabled = false;
    }
}

function showLegacyReview(listing) {
    if (!listing || !listing.review || listing.rewardClaimed) return;
    legacyActive = true;
    legacyText.textContent = `「${listing.itemName}」に ${listing.review.buyer} から ${listing.review.stars}★ の評価：${listing.review.comment}`;
    legacyNotif.classList.remove('hidden');
    playSound('crystal');
    setTimeout(() => legacyNotif.classList.add('slide-down'), 50);
}

function receiveClothingReview(review) {
    const listing = GameState.listing;
    if (!listing || listing.status !== 'listed') return false;
    listing.status = 'reviewed';
    listing.review = review;
    updateListingUI();
    showLegacyReview(listing);
    return true;
}

// 将来バックエンドから評価イベントを受け取る時も、この関数を呼ぶだけでよい。
window.receiveClothingReview = receiveClothingReview;

function listCurrentClothing() {
    const current = GameState.listing;
    if (current && current.status === 'reviewed') { showLegacyReview(current); return; }
    if (current && current.status === 'listed') return;
    const listing = {
        id: `listing-${Date.now()}`,
        itemName: GameState.avatar.name || '名前のない遺物',
        status: 'listed', rewardClaimed: false
    };
    GameState.listing = listing;
    updateListingUI();
    playSound('select');

    // ローカル試作版では、出品後25秒で「相手から評価が届いた」イベントを一度だけ模擬する。
    // 実サービス化する場合はこのタイマーを外し、サーバー受信時にreceiveClothingReviewを呼ぶ。
    setTimeout(() => {
        if (!GameState.listing || GameState.listing.id !== listing.id || GameState.listing.status !== 'listed') return;
        const review = BUYER_REVIEWS[Math.floor(Math.random() * BUYER_REVIEWS.length)];
        receiveClothingReview(review);
    }, 25000);
}

listClothingBtn.addEventListener('click', listCurrentClothing);

function hideLegacyNotification() {
    legacyNotif.classList.remove('slide-down');
    setTimeout(() => { legacyNotif.classList.add('hidden'); legacyActive = false; }, 500);
}

legacyNotif.addEventListener('click', () => {
    const listing = GameState.listing;
    if (!legacyActive || !listing || listing.status !== 'reviewed' || listing.rewardClaimed) return;
    listing.rewardClaimed = true;
    listing.status = 'completed';
    playSound('fanfare');
    updateGold(100);
    legacyText.textContent = '✨ 評価を確認しました。継承報酬 100 G を受け取りました。 ✨';
    updateListingUI();
    setTimeout(hideLegacyNotification, 1800);
});

// ==========================================
// バーチャル十字キー（スマホ・マウス対応）
// ==========================================
const dpadBtnMap = {
    'btn-up': 'ArrowUp',
    'btn-down': 'ArrowDown',
    'btn-left': 'ArrowLeft',
    'btn-right': 'ArrowRight'
};

Object.keys(dpadBtnMap).forEach(id => {
    const btn = document.getElementById(id);
    if(btn) {
        // マウス用
        btn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            if(!isMenuOpen && !isShopOpen && !isFashionShow) keys[dpadBtnMap[id]] = true;
        });
        btn.addEventListener('mouseup', (e) => {
            e.preventDefault();
            keys[dpadBtnMap[id]] = false;
        });
        btn.addEventListener('mouseleave', (e) => {
            keys[dpadBtnMap[id]] = false;
        });
        // スマホのタッチ用
        btn.addEventListener('touchstart', (e) => {
            e.preventDefault();
            if(!isMenuOpen && !isShopOpen && !isFashionShow) keys[dpadBtnMap[id]] = true;
        }, {passive: false});
        btn.addEventListener('touchend', (e) => {
            e.preventDefault();
            keys[dpadBtnMap[id]] = false;
        }, {passive: false});
    }
});
