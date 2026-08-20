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
// フィールド拡張: BGM出力ゲイン(musicBusの出口)。SE(playSound)はこれを経由せず
// audioCtx.destinationへ直結のままなので、BGM側だけを操作してもSEには影響しない。
const fieldMusicGain = audioCtx.createGain();
fieldMusicGain.gain.setValueAtTime(1, audioCtx.currentTime);
musicBus.connect(fieldMusicGain);
fieldMusicGain.connect(audioCtx.destination);

// ==========================================
// BGMManager: BGMを一元管理する。同時に再生できるBGMは常に1系統だけ。
// playBGM(trackId, startFn)がすべてのBGM切り替えの唯一の入口。
// 呼び出すたびに (1)現在のBGM停止 → (2)タイマー解除 → (3)oscillator/AudioNode切断 →
// (4)再生中BGM IDの更新 → (5)新しいBGMを1回だけ開始、の順で処理する。
// 同じtrackIdが既に再生中なら何もしない(二重再生防止)。
// SE(playSound)はこのマネージャの対象外で、audioCtx.destinationへ直結の別経路のまま。
// クロスフェードはしない: 古い曲は短いフェード(~80ms)ですぐ黙らせて切断し、
// その後(合計約150ms)に新しい曲を開始する。曲の内容・テンポ自体は一切変更しない。
// ==========================================
const BGMManager = {
    currentBgmId: null,
    isPlaying: false,
    _interval: null,       // 現在のBGMループのsetInterval ID
    _timeouts: new Set(),  // BGM切替に伴うsetTimeout ID群(遅延ループ開始など)
    _nodes: new Set(),     // BGM用に生成した{osc,gain,filter}(切替時に強制的に黙らせて切断する)
    _gen: 0,                // 世代カウンタ。古い遅延コールバックが後から発火するのを防ぐ。

    // synthVoice/synthDrum/synthTimpaniなど、BGM用の生oscillatorを作る箇所から呼ぶ。
    registerNode(osc, gain, filter) {
        const entry = { osc, gain, filter: filter || null };
        this._nodes.add(entry);
        // 自然に鳴り終わったノードは自動的に管理から外す(_nodesが際限なく増え続けないようにする)
        try { osc.addEventListener('ended', () => this._nodes.delete(entry), { once: true }); } catch (e) {}
        return entry;
    },
    // 現在の再生ループが使うsetIntervalのIDを登録する(startSequencer/shop/summonループから呼ぶ)
    trackInterval(id) { this._interval = id; return id; },
    // 遅延処理のsetTimeout IDを登録する(BGM切替時に必ずclearされる)
    trackTimeout(id) { this._timeouts.add(id); return id; },

    // 現在のBGMのタイマー・ノードをすべて止める。曲の内容には触れず、鳴っている音を黙らせるだけ。
    _hardStop() {
        if (this._interval) { clearInterval(this._interval); this._interval = null; }
        this._timeouts.forEach(id => clearTimeout(id));
        this._timeouts.clear();
        const now = audioCtx.currentTime;
        const nodesToDisconnect = Array.from(this._nodes);
        this._nodes.clear();
        nodesToDisconnect.forEach(entry => {
            try {
                entry.gain.gain.cancelScheduledValues(now);
                entry.gain.gain.setValueAtTime(Math.max(entry.gain.gain.value, 0.0001), now);
                entry.gain.gain.linearRampToValueAtTime(0.0001, now + 0.08); // 短いフェードでクリックを防ぎつつすぐ黙らせる
            } catch (e) { /* 既に停止済みのノードは無視 */ }
            try { entry.osc.stop(now + 0.09); } catch (e) { /* 既に停止予約済みなら無視 */ }
        });
        // oscillator/AudioNodeの切断: フェードが終わってから行う(即切断だとプツッと鳴ることがあるため)
        setTimeout(() => {
            nodesToDisconnect.forEach(entry => {
                try { entry.osc.disconnect(); } catch (e) {}
                try { entry.gain.disconnect(); } catch (e) {}
                if (entry.filter) { try { entry.filter.disconnect(); } catch (e) {} }
            });
        }, 100);
    },

    // BGMを1曲だけ再生する。同じtrackIdが既に再生中なら何もしない。
    playBGM(trackId, startFn) {
        if (this.currentBgmId === trackId && this.isPlaying) return; // 二重再生防止
        if (audioCtx.state === 'suspended') audioCtx.resume();
        this._gen++;
        const myGen = this._gen;
        this._hardStop();                 // 1.現在のBGM停止 2.タイマー解除 3.ノード切断(スケジュール)
        this.currentBgmId = trackId;      // 4.再生中BGM IDを更新
        this.isPlaying = true;
        // クロスフェードはしない。古い曲を約150ms内に止めてから、新しい曲を1回だけ開始する。
        const t = setTimeout(() => {
            this._timeouts.delete(t);
            if (myGen !== this._gen) return; // より新しい切替が既に発生していたら何もしない
            startFn();                        // 5.新しいBGMを1回だけ開始
        }, 150);
        this.trackTimeout(t);
    },

    // BGMを完全に停止する(次に何も再生しない)
    stop() {
        this._gen++;
        this._hardStop();
        this.currentBgmId = null;
        this.isPlaying = false;
    },

    // 確認用: 再生中のBGM ID・稼働中のタイマー数・BGM用AudioNode数を返す
    debugInfo() {
        return {
            currentBgmId: this.currentBgmId,
            isPlaying: this.isPlaying,
            hasInterval: !!this._interval,
            timeoutCount: this._timeouts.size,
            nodeCount: this._nodes.size
        };
    }
};

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
    let filter = null;
    if (filterHz) {
        filter = audioCtx.createBiquadFilter();
        filter.type = 'lowpass'; filter.frequency.setValueAtTime(filterHz, now); filter.Q.value = filterQ;
        osc.connect(filter); filter.connect(g);
    } else {
        osc.connect(g);
    }
    g.connect(musicBus);
    osc.start(now); osc.stop(now + dur + 0.05);
    BGMManager.registerNode(osc, g, filter);
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
// 打楽器風: 短時間でピッチを下げて「ドン」という胴鳴りの打撃音を作る(戦闘BGM専用)
function synthDrum(freq, dur, gain, start) {
    const now = audioCtx.currentTime + (start || 0);
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq * 0.35), now + dur);
    g.gain.setValueAtTime(gain, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(g); g.connect(musicBus);
    osc.start(now); osc.stop(now + dur + 0.02);
    BGMManager.registerNode(osc, g, null);
}
// ==========================================
// オーケストラ風BGM専用の追加音色ヘルパー(既存のSFX/synth*には触れず追加するだけ)
// ==========================================
// ピチカート: 弦をはじく短い音。速い減衰。
function synthPizzicato(freq, gain, start) {
    synthVoice(freq, { type: 'triangle', dur: 0.14, gain: gain, start: start, attack: 0.002, filterHz: 2600 });
}
// ハープ: つまびき音。基音+高次倍音のきらめきを短く添える。
function synthHarp(freq, dur, gain, start) {
    synthVoice(freq, { type: 'triangle', dur: dur, gain: gain, start: start, attack: 0.004 });
    synthVoice(freq * 2, { type: 'sine', dur: dur * 0.6, gain: gain * 0.3, start: start, attack: 0.004 });
}
// ファゴット風: 低い帯域のリードらしいうなりを持つ木管
function synthBassoon(freq, dur, gain, start) {
    synthVoice(freq, { type: 'sawtooth', dur: dur, gain: gain, start: start, attack: 0.03, filterHz: 900, filterQ: 3 });
}
// ティンパニ: 音程を持つ低い打楽器。synthDrumより低く・長く尾を引く。
function synthTimpani(freq, dur, gain, start) {
    const now = audioCtx.currentTime + (start || 0);
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq * 1.5, now);
    osc.frequency.exponentialRampToValueAtTime(freq, now + 0.06);
    g.gain.setValueAtTime(gain, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(g); g.connect(musicBus);
    osc.start(now); osc.stop(now + dur + 0.03);
    BGMManager.registerNode(osc, g, null);
}
// スネア風: 高めの帯域を2声デチューンで重ね、金属的な「ジャッ」という質感にする(ノイズ無しの近似)
function synthSnare(gain, start) {
    [1800, 2400, 3100].forEach((f, i) => {
        synthVoice(f, { type: 'square', dur: 0.07 - i * 0.01, gain: gain * (i === 0 ? 1 : 0.5), start: start, attack: 0.001, filterHz: 4000 });
    });
}
// シンバル風: 非整数倍音を重ねて減衰の長い金属音にする
function synthCymbal(gain, start) {
    [1, 1.63, 2.29, 3.4, 4.7].forEach((mul, i) => {
        synthVoice(2200 * mul, { type: 'square', dur: 0.5 - i * 0.05, gain: gain * (0.5 / (i + 1)), start: start, attack: 0.001, filterHz: 6000 });
    });
}
// ブラウザタブが非表示になったら音声を一時停止し、復帰したら再開する(BGM・SFX共通、既存のミュート/音量設定には触れない)
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        if (audioCtx.state === 'running') audioCtx.suspend();
    } else if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
});

// 一定間隔でstepFnを呼ぶ簡易シーケンサー。
// BGMManager.playBGM()から呼ばれるstartFnの中でのみ使う想定(現在のBGM停止は既にBGMManager側で済んでいる)。
function startSequencer(stepMs, stepFn, stepCount) {
    if (audioCtx.state === 'suspended') audioCtx.resume();
    let step = 0;
    const id = setInterval(() => {
        stepFn(step);
        step = (step + 1) % stepCount;
    }, stepMs);
    BGMManager.trackInterval(id);
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
    } else if (type === 'footstep') {
        // 移動中の足音。左右交互に少しピッチを変え、控えめな音量で鳴らす。
        footstepToggle = !footstepToggle;
        const baseFreq = footstepToggle ? 130 : 108;
        osc.type = 'triangle'; osc.frequency.setValueAtTime(baseFreq, now);
        osc.frequency.exponentialRampToValueAtTime(baseFreq * 0.55, now + 0.08);
        gainNode.gain.setValueAtTime(0.08, now); gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
        osc.start(now); osc.stop(now + 0.09);
    } else if (type === 'noise') {
        osc.type = 'square'; osc.frequency.setValueAtTime(100, now);
        for (let i = 0; i < 10; i++) osc.frequency.setValueAtTime(Math.random() * 800 + 100, now + (i * 0.05));
        gainNode.gain.setValueAtTime(0.5, now); gainNode.gain.linearRampToValueAtTime(0.01, now + 0.5);
        osc.start(now); osc.stop(now + 0.5);
    }
}

// フィールドBGM（オリジナル）: 現在地(GameState.currentFieldId)に応じて3曲を出し分ける。
// BGMManager.playBGM()を介して、常にそのフィールドの曲だけが1系統再生される。
function playFieldBGM() {
    const fieldId = GameState.currentFieldId || 'azurlight';
    if (fieldId === 'wardrobe_gloomwood') BGMManager.playBGM('field:wardrobe_gloomwood', playWardrobeFieldBGM);
    else if (fieldId === 'laundry_abyss') BGMManager.playBGM('field:laundry_abyss', playLaundryFieldBGM);
    else BGMManager.playBGM('field:azurlight', playMeadowFieldBGM);
}

// アズライト大陸(草原): 118BPM。オリジナルの壮大な冒険オーケストラ風。
// ホルン(synthBrass)の主旋律 + 弦の刻み + ハープのアルペジオ + フルートの短い返答。
// 有名曲の旋律・コード進行はコピーせず、D-durの短いオリジナルモチーフから作る。
function playMeadowFieldBGM() {
    const bpm = 118;
    const stepMs = 30000 / bpm; // 8分音符1ステップ(2ステップ=1拍)
    const stepDur = stepMs / 1000;
    // ホルンの主旋律(D5→A5→D5のオリジナルな山なりモチーフ、4拍子×2小節=16ステップ)
    const hornMelody = [587.33, 0, 659.25, 0, 739.99, 0, 880.00, 0, 783.99, 0, 739.99, 0, 659.25, 0, 0, 0];
    // ハープのアルペジオ(D4-F#4-A4-D5の分散和音を毎ステップ回す)
    const harpArp = [293.66, 369.99, 440.00, 587.33];
    // 弦の刻み(ルート音、4ステップごとに切替)
    const stringRoots = [146.83, 146.83, 146.83, 146.83, 220.00, 220.00, 220.00, 220.00, 146.83, 146.83, 146.83, 146.83, 196.00, 196.00, 220.00, 220.00];
    // フルートの短い返答(フレーズの最後だけ)
    const fluteTail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 739.99, 659.25, 587.33];

    startSequencer(stepMs, (step) => {
        synthHarp(harpArp[step % harpArp.length], stepDur * 1.3, 0.075, 0);
        if (step % 4 === 0) synthStrings(stringRoots[step], stepDur * 4.4, 0.05, 0);
        const horn = hornMelody[step];
        if (horn) synthBrass(horn, stepDur * 1.7, 0.13, 0);
        const tail = fluteTail[step];
        if (tail) synthFlute(tail, stepDur * 1.3, 0.12, 0);
    }, 16);
}

// 闇の森・クローゼット深部（オリジナル）: 88BPM。低い弦とファゴット風の音、不規則なピチカート、
// 小さなベルと低いティンパニ。怖すぎず、先へ進む緊張感を出す。
function playWardrobeFieldBGM() {
    const bpm = 88;
    const stepMs = 30000 / bpm;
    const stepDur = stepMs / 1000;
    // ファゴット風の低い短いモチーフ(D3→F3→E3→D3、休符主体で不穏さを出す)
    const bassoonMelody = [146.83, 0, 0, 174.61, 0, 0, 164.81, 0, 146.83, 0, 0, 0, 130.81, 0, 0, 0];
    // 不規則なピチカート(規則的な拍から少しずらして配置)
    const pizzSteps = [1, 3, 6, 9, 11, 14];
    const pizzNotes = [293.66, 349.23, 329.63, 293.66, 261.63, 293.66]; // D4 F4 E4 D4 C4 D4
    // 小さなベル(まばらに)
    const bellSteps = [5, 13];

    startSequencer(stepMs, (step) => {
        if (step === 0) synthStrings(73.42, stepDur * 8, 0.05, 0); // D2 低い弦のドローン
        if (step === 8) synthTimpani(65.41, stepDur * 3, 0.11, 0); // 低いティンパニ(C2)
        const bs = bassoonMelody[step];
        if (bs) synthBassoon(bs, stepDur * 1.8, 0.09, 0);
        const pIdx = pizzSteps.indexOf(step);
        if (pIdx >= 0) synthPizzicato(pizzNotes[pIdx], 0.08, 0);
        if (bellSteps.includes(step)) synthBell(1046.50, 1.1, 0.055, 0); // 小さなボタンベル
    }, 16);
}

// 洗濯槽深層・ランドリーアビス（オリジナル）: 104BPM。ハープと高い弦のアルペジオ、水中らしい
// ベルと柔らかなコーラス風パッド、ドラムの回転を感じる一定の低音リズム、気泡の短い高音。
function playLaundryFieldBGM() {
    const bpm = 104;
    const stepMs = 30000 / bpm;
    const stepDur = stepMs / 1000;
    // ハープ+高い弦のアルペジオ(A3-C#4-E4-A4-E4-C#4の分散和音)
    const arp = [220.00, 277.18, 329.63, 440.00, 329.63, 277.18, 220.00, 277.18, 329.63, 440.00, 329.63, 277.18, 220.00, 277.18, 329.63, 440.00];
    // 水中ベル(まばら)
    const bellSteps = [3, 11];
    // 気泡の短い高音(疎らに)
    const bubbleSteps = [2, 6, 9, 13];
    const bubbleNotes = [1567.98, 1864.66, 1318.51, 1760.00];

    startSequencer(stepMs, (step) => {
        if (step === 0) synthChoir(220.00, stepDur * 16, 0.04, 0); // 柔らかなコーラス風パッド
        synthHarp(arp[step], stepDur * 1.2, 0.06, 0); // ハープ+高い弦のアルペジオ
        if (step % 2 === 0) synthStrings(arp[step], stepDur * 1.0, 0.03, 0);
        synthTimpani(58.27, stepDur * 0.95, 0.05, 0); // ドラムの回転を感じる一定の低音リズム(毎ステップ均一)
        if (bellSteps.includes(step)) synthBell(1046.50 * 1.5, 1.0, 0.05, 0);
        const bi = bubbleSteps.indexOf(step);
        if (bi >= 0) synthVoice(bubbleNotes[bi], { type: 'sine', dur: 0.35, gain: 0.05, attack: 0.004 });
    }, 16);
}

// 戦闘BGM（オリジナル）: intensity='normal'(通常)/'a'(Aランク=厚み追加)/'boss'(Sランク=最も壮大)
// 戦闘BGM（オリジナル、既存曲・有名曲の旋律は使用しない）
// 通常戦=148BPM(速いドラム+低音+緊張感のある主旋律)
// 強敵戦=156BPM(通常戦へ重い低音+金管風の音を追加)
// ボス戦=166BPM(さらに厚いドラム+鐘+重い低音を追加)
// ボス戦開始時だけ鳴らす専用ファンファーレ(約2秒、ループの外の単発サウンド)
function playBossStartFanfare() {
    synthTimpani(65.41, 0.5, 0.20, 0);
    synthBrass(261.63, 0.45, 0.15, 0.05);
    synthBrass(329.63, 0.45, 0.16, 0.28);
    synthBrass(392.00, 0.5, 0.17, 0.50);
    synthBrass(523.25, 0.9, 0.20, 0.72);
    synthStrings(523.25, 0.9, 0.11, 0.72);
    synthCymbal(0.13, 0.72);
    synthTimpani(65.41, 0.7, 0.16, 1.15);
}

// 戦闘BGM（オリジナル、既存曲・有名曲の旋律・コード進行は使用しない）
// 通常戦=152BPM / 強敵戦=160BPM(低音弦・金管・シンバルを追加) / ボス戦=168BPM(重いティンパニ・
// 低音弦・金管の和音・高音弦の速い反復、開始時に約2秒の専用ファンファーレ)。
// 強敵戦は敵HPが少なくなると打楽器が強まり、ボス戦はHP50%以下で金管・打楽器を追加、
// 最終局面(HP20%以下)はテンポを変えず音の密度だけ上げる。
function playBattleBGM(intensity) {
    const bpm = intensity === 'boss' ? 168 : (intensity === 'a' ? 160 : 152);
    const stepMs = 30000 / bpm; // 8分音符1つ分(2ステップ=1拍)
    const stepDur = stepMs / 1000;
    // 速い弦の刻み(緊張感のあるオリジナルの土台)
    const stringPulse = [220.00, 220.00, 246.94, 220.00, 220.00, 220.00, 261.63, 246.94];
    // ホルンの力強い短い主旋律(拍の隙間に鳴る)
    const hornMotif = [0, 0, 659.25, 0, 0, 0, 783.99, 0];

    const runLoop = () => {
        startSequencer(stepMs, (step) => {
            // 速い弦の刻み
            synthStrings(stringPulse[step], stepDur * 0.85, 0.09, 0);
            // 打楽器: スネアとティンパニを交互に
            if (step % 2 === 0) synthTimpani(97.99, stepDur * 0.6, 0.12, 0);
            else synthSnare(0.09, 0);
            // ホルンの力強い短い主旋律
            const hm = hornMotif[step];
            if (hm) synthBrass(hm, stepDur * 1.3, 0.15, 0);

            const hpRatio = (currentEnemy && currentEnemy.maxHp) ? currentEnemy.hp / currentEnemy.maxHp : 1;

            if (intensity === 'a' || intensity === 'boss') {
                // 強敵戦: 通常戦へ低音弦・金管・シンバルを追加
                if (step % 4 === 0) synthSubBass(stringPulse[step] / 2, stepDur * 1.6, 0.10, 0);
                if (hm) synthBrass(hm / 2, stepDur * 1.0, 0.08, 0.02);
                if (step === 0) synthCymbal(0.07, 0);
                if (hpRatio < 0.35) synthSnare(0.06, stepDur * 0.5); // 敵のHPが少なくなったら打楽器を少し強くする
            }
            if (intensity === 'boss') {
                // ボス戦: 重いティンパニ・低音弦・金管の和音、高音弦の速い反復
                synthTimpani(55.00, stepDur * 1.1, 0.14, 0);
                synthSubBass(stringPulse[step] / 2, stepDur * 1.4, 0.10, 0);
                synthStrings(stringPulse[step] * 2, stepDur * 0.5, 0.05, stepDur * 0.5);
                if (hpRatio <= 0.5) {
                    // HP50%以下: 金管と打楽器を一段追加
                    synthBrass(392.00, stepDur * 0.9, 0.09, 0);
                    synthSnare(0.08, stepDur * 0.25);
                }
                if (hpRatio <= 0.2) {
                    // 最終局面: テンポは変えず、拍の合間に追加の打を挟んで密度だけ上げる
                    synthTimpani(55.00, stepDur * 0.4, 0.09, stepDur * 0.5);
                }
            }
        }, 8);
    };

    if (intensity === 'boss') {
        playBossStartFanfare();
        const t = setTimeout(() => { BGMManager._timeouts.delete(t); if (isBattling) runLoop(); }, 2000); // ファンファーレの後にループ開始(戦闘が続いている時だけ)
        BGMManager.trackTimeout(t); // 途中で別のBGMに切り替わったらこの遅延開始は自動的に無効化される
    } else {
        runLoop();
    }
}

// 召喚の祭壇の環境音(内容・テンポは変更しない)。BGMManager経由でtrackId='shop'として管理する。
function startShopBGM() {
    const shopNotes = [659.25, 880, 1046.5, 659.25, 880, 1046.5];
    const tempo = 180;
    let noteIdx = 0;
    const id = setInterval(() => {
        const osc = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();
        osc.type = 'sawtooth'; osc.frequency.value = shopNotes[noteIdx];
        osc.connect(gainNode); gainNode.connect(audioCtx.destination);
        const now = audioCtx.currentTime;
        gainNode.gain.setValueAtTime(0.04, now);
        gainNode.gain.exponentialRampToValueAtTime(0.001, now + (tempo / 1000));
        osc.start(now); osc.stop(now + (tempo / 1000));
        BGMManager.registerNode(osc, gainNode, null);
        noteIdx = (noteIdx + 1) % shopNotes.length;
    }, tempo);
    BGMManager.trackInterval(id);
}

// BGM切り替えの唯一の入口。isBattle引数から必要なtrackIdを決め、BGMManager.playBGM()へ委譲する。
// 曲の内容・テンポ・分岐条件(敵ランクによる戦闘BGMの厚み等)は一切変更しない。
function playFastEpicBGM(isBattle = false) {
    if (isBattle === 'shop') {
        BGMManager.playBGM('shop', startShopBGM);
        return;
    }
    if (isBattle) {
        // 敵ランク(C/A/S)に応じて戦闘BGMの厚みを変える。戦闘システム自体には触れない。
        const tier = currentEnemy && currentEnemy.tier;
        const intensity = tier === 'boss' ? 'boss' : (tier === 'mid' ? 'a' : 'normal');
        const trackId = intensity === 'boss' ? 'battle:boss' : (intensity === 'a' ? 'battle:elite' : 'battle:normal');
        BGMManager.playBGM(trackId, () => playBattleBGM(intensity));
        return;
    }
    playFieldBGM();
}
// 互換用: 既存の呼び出し箇所からはそのまま使える。BGMManager.stop()へ委譲する。
function stopBGM() { BGMManager.stop(); }

function startBattleBGM() {
    playFastEpicBGM(true); // 敵ランクに応じた戦闘BGMをBGMManager経由で1系統だけ再生する
}
// 戦闘終了時に呼ぶ: 現在のフィールド(currentFieldId)の曲へ、BGMManagerが1回だけ確実に切り替える。
function endBattleBGM() {
    playFieldBGM();
}

// フィールド拡張: field-expansion.jsのswitchFieldMusicが呼ぶブリッジ。
// クロスフェードはせず、BGMManager.playBGM()に委譲して現在のフィールド曲を1系統だけ再生する。
const audioBridge = {
    currentFieldMusicId: null,
    crossfadeTo(musicConfig, ms) {
        playFieldBGM(); // GameState.currentFieldIdを見て正しいフィールド曲をBGMManager経由で1回だけ再生する
    }
};

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
// BGMManager.playBGM()から呼ばれるstartFnの中でのみ使う想定(現在のBGM停止は既にBGMManager側で済んでいる)。
function playRankSummonBGM(rankKey) {
    const pattern = RANK_BGM_PATTERNS[rankKey] || RANK_BGM_PATTERNS.B;
    let noteIdx = 0;
    const id = setInterval(() => {
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
        BGMManager.registerNode(osc, gainNode, null);

        // レア度が高いほど同時に鳴る音を増やして豪華にする（テンポ・主旋律の周期は変えない）
        if (pattern.bass && noteIdx % 2 === 0) synthVoice(freq / 2, { type: 'triangle', dur: dur * 1.6, gain: 0.06, attack: 0.01 });
        if (pattern.harmony) synthVoice(freq * 1.5, { type: pattern.synthType, dur: dur * 0.8, gain: 0.04, attack: 0.005 });
        if (pattern.bell && noteIdx % 3 === 0) synthBell(freq * 2, dur * 2, 0.05, 0);

        noteIdx = (noteIdx + 1) % pattern.notes.length;
    }, pattern.tempo);
    BGMManager.trackInterval(id);
}

// ==========================================
// GAME STATE
// ==========================================
const GameState = {
    avatar: { name: '', job: '', style: '', color: '#fff', hp: 100, maxHp: 100, mp: 50, maxMp: 50, agi: 30, tension: 0 },
    party: [], // {name, job, style, color, isDragon, originItem} 所持している仲間全員(フィールド追従とは別)
    activePartyIds: [], // フィールドへ実際に同行させるパーティーのキー(勇者を含め最大4人、パーティー編成画面で選ぶ)
    leaderId: 'hero', // 現在フィールドで操作しているリーダーのキー(既定は勇者)
    listing: null, // {id, itemName, status:'listed'|'reviewed'|'completed', rewardClaimed}
    continents: ['封印の塔', 'カジュアル平原', '深淵の森', '荒野の砂漠', '古の山脈', 'アズライト中央大陸'],
    globalTime: 0,
    gold: 0,
    // 所持アイテム: 回復薬(戦闘中に「アイテム(回復)」で実際に使用してHPを回復する)
    items: { potion: 2 },
    // フィールド拡張: 現在地と、ボス撃破/討伐数などのワールド進行(localStorageへ保存)
    currentFieldId: 'azurlight',
    // laundry: 泡織りの洗濯広場用の追加セーブ項目(既存項目とは独立、既存の保存方式は変更しない)
    worldProgress: { defeatedBosses: {}, killCounts: {}, laundry: { detergent: 0, freeRestUsed: false, totalWins: 0, spotWinsAtGather: [null, null, null] } }
};
let currentTrend = 'なし';

// ==========================================
// フィールド拡張: ワールド進行の永続化(localStorage)
// ==========================================
const WORLD_PROGRESS_KEY = 'zsaga_world_progress_v1';
function saveWorldProgress() {
    try { localStorage.setItem(WORLD_PROGRESS_KEY, JSON.stringify(GameState.worldProgress)); } catch (e) { /* 保存できない環境では無視 */ }
}
function loadWorldProgress() {
    try {
        const raw = localStorage.getItem(WORLD_PROGRESS_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
            GameState.worldProgress.defeatedBosses = parsed.defeatedBosses || {};
            GameState.worldProgress.killCounts = parsed.killCounts || {};
            // laundry: 古いセーブデータ(この項目が無いもの)でも安全に初期値へフォールバックする
            const savedLaundry = parsed.laundry || {};
            GameState.worldProgress.laundry = {
                detergent: typeof savedLaundry.detergent === 'number' ? savedLaundry.detergent : 0,
                freeRestUsed: !!savedLaundry.freeRestUsed,
                totalWins: typeof savedLaundry.totalWins === 'number' ? savedLaundry.totalWins : 0,
                spotWinsAtGather: Array.isArray(savedLaundry.spotWinsAtGather) ? savedLaundry.spotWinsAtGather : [null, null, null]
            };
        }
    } catch (e) { /* 壊れた保存データは無視して初期状態を使う */ }
}
loadWorldProgress();

// ==========================================
// 仲間パーティの永続化(localStorage、新規キー。既存のzsaga_world_progress_v1は変更しない)
// characterId・portraitPath・Lv・重複強化値などを保存し、リロード後も同じ仲間が残るようにする。
// spriteはJSON化できないため保存せず、読み込み時に毎回作り直す。
// ==========================================
const PARTY_DATA_KEY = 'zsaga_party_v1';
function savePartyData() {
    try {
        const plain = GameState.party.map(p => {
            const { sprite, ...rest } = p; // spriteだけ除いた純データを保存する
            return rest;
        });
        localStorage.setItem(PARTY_DATA_KEY, JSON.stringify(plain));
    } catch (e) { /* 保存できない環境では無視 */ }
}
function loadPartyData() {
    try {
        const raw = localStorage.getItem(PARTY_DATA_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return;
        GameState.party = parsed.map(p => {
            if (p.job === '魔物') {
                return { ...p, sprite: new SpriteAnimator('enemy', p.enemyTypeKey || 'slime') };
            }
            // 承認済みキャラ(characterId持ち)は本人専用のフィールド歩行素材を復元する。
            // characterIdが無い旧セーブだけ、従来どおりjob基準の共通歩行素材にフォールバックする。
            if (p.characterId && SPRITE_MANIFEST.ally_field && SPRITE_MANIFEST.ally_field.files[p.characterId]) {
                return { ...p, sprite: new SpriteAnimator('ally_field', p.characterId) };
            }
            return { ...p, sprite: new SpriteAnimator('ally', p.job || '裁断戦士') };
        });
    } catch (e) { /* 壊れた保存データは無視して空のパーティのまま使う */ }
}

// フィールド背景画像の先読み(SPRITE_MANIFESTと同様、パス・並び順はfield-expansion.jsのものをそのまま使う)
const FIELD_BG_IMAGES = {};
(function preloadFieldBackgrounds() {
    const fx = window.ZSAGA_FIELD_EXPANSION;
    if (!fx) return;
    Object.keys(fx.fields).forEach(id => {
        const img = new Image();
        img.onerror = () => console.warn(`[field-expansion] 背景画像の読込に失敗: ${fx.fields[id].background}`);
        img.src = fx.fields[id].background;
        FIELD_BG_IMAGES[id] = img;
    });
})();

// ==========================================
// フィールド画像パック(探索背景4枚・戦闘背景3枚)。差分追加のみ。
// 既存のFIELD_BG_IMAGES/fx.drawAnimatedField(旧画像+既存の環境アニメーション)は変更・削除しない。
// これらの新画像が読み込めなかった場合は、既存の描画へ自動的にフォールバックする。
// 環境アニメーションは今回追加しない(静止画としてそのまま表示するだけ)。
// ==========================================
function loadBgImage(path) {
    const img = new Image();
    img.onerror = () => console.warn(`[field-visuals] 画像の読込に失敗: ${path}`);
    img.src = path;
    return img;
}
// 探索背景(800x600): fieldId → 新画像。回復の間(泡織りの洗濯広場)は別枠で持つ。
const NEW_FIELD_BG_IMAGES = {
    azurlight: loadBgImage('assets/backgrounds/field_grassland.png'),
    wardrobe_gloomwood: loadBgImage('assets/backgrounds/field_dark_closet.png'),
    laundry_abyss: loadBgImage('assets/backgrounds/field_washing_underwater.png')
};
const LAUNDRY_PLAZA_BG_IMG = loadBgImage('assets/backgrounds/field_recovery_room.png');
// 戦闘背景(800x450): fieldId → 新画像。回復の間では戦闘が発生しないため用意しない。
const BATTLE_BG_IMAGES = {
    azurlight: loadBgImage('assets/battle_backgrounds/battle_grassland.png'),
    wardrobe_gloomwood: loadBgImage('assets/battle_backgrounds/battle_dark_closet.png'),
    laundry_abyss: loadBgImage('assets/battle_backgrounds/battle_washing_underwater.png')
};
// CSSのbackground-size:coverと同じ考え方で、縦横比を保ったまま中央基準にトリミングして描画する
function drawCoverImage(ctxObj, img, dx, dy, dw, dh) {
    const scale = Math.max(dw / img.naturalWidth, dh / img.naturalHeight);
    const sw = dw / scale, sh = dh / scale;
    const sx = (img.naturalWidth - sw) / 2, sy = (img.naturalHeight - sh) / 2;
    ctxObj.imageSmoothingEnabled = false; // pixelatedを維持する
    ctxObj.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
}

// ==========================================
// 環境アニメーション専用レイヤー(FieldAmbientAnimation)
// 背景PNGの上・キャラクターと敵の下にだけ描画する共通管理処理。
// 4ステージ+回復の間をこの1つのオブジェクトで扱い、現在のfieldId/isInLaundryPlazaで
// 表示内容を切り替える。ゲーム機能・座標・当たり判定・BGM・セーブデータ・戦闘処理には
// 一切触れない。状態更新(tick)は6〜12fps相当に間引き、描画(draw)は既存のdrawGame()の
// 中で毎フレーム呼ばれる(＝キャラクター・敵より前へは描画されない)。
// ==========================================
const FieldAmbientAnimation = {
    rafId: null,
    currentKey: null, // 'azurlight' | 'wardrobe_gloomwood' | 'laundry_abyss' | 'laundry_plaza' | null
    lastTickAt: 0,
    tickMs: 110, // 約9fps相当のカクカクした更新間隔
    state: null,

    start(key) {
        if (this.currentKey === key && this.rafId !== null) return; // 同じステージなら再起動しない(重複防止)
        this.stop(); // ステージ移動時は前のrequestAnimationFrameを必ず止める
        this.currentKey = key;
        this.state = this._createState(key);
        this.lastTickAt = 0;
        const loop = (now) => {
            this.rafId = requestAnimationFrame(loop);
            // メニュー表示中・ショップ・凱旋の儀・タブ非表示中は状態更新を一時停止する(描画自体は既存のdrawGame任せ)
            if (isMenuOpen || isShopOpen || isFashionShow || document.hidden) return;
            if (now - this.lastTickAt < this.tickMs) return;
            this.lastTickAt = now;
            this._tick();
        };
        this.rafId = requestAnimationFrame(loop);
    },

    stop() {
        if (this.rafId !== null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
        this.currentKey = null;
        this.state = null;
    },

    _createState(key) {
        if (key === 'azurlight') return this._createGrasslandState();
        if (key === 'wardrobe_gloomwood') return this._createClosetState();
        if (key === 'laundry_abyss') return this._createUnderwaterState();
        if (key === 'laundry_plaza') return this._createPlazaState();
        return null;
    },

    _tick() {
        if (!this.state) return;
        if (this.currentKey === 'azurlight') this._tickGrassland();
        else if (this.currentKey === 'wardrobe_gloomwood') this._tickCloset();
        else if (this.currentKey === 'laundry_abyss') this._tickUnderwater();
        else if (this.currentKey === 'laundry_plaza') this._tickPlaza();
    },

    // ctxObj: 描画先。isBattling: 戦闘背景では粒子数を半分にする。
    draw(ctxObj, isBattling) {
        if (!this.state) return;
        ctxObj.imageSmoothingEnabled = false;
        if (this.currentKey === 'azurlight') this._drawGrassland(ctxObj, isBattling);
        else if (this.currentKey === 'wardrobe_gloomwood') this._drawCloset(ctxObj, isBattling);
        else if (this.currentKey === 'laundry_abyss') this._drawUnderwater(ctxObj, isBattling);
        else if (this.currentKey === 'laundry_plaza') this._drawPlaza(ctxObj);
    },

    // ------------------------------------------------------------
    // 草原(azurlight)
    // ------------------------------------------------------------
    _createGrasslandState() {
        // リボン草: 左右へ2〜3px、3段階で揺れる(開始タイミングをずらす)
        const ribbons = [
            { x: 310, y: 190, phase: 0 },
            { x: 563, y: 335, phase: 3 },
            { x: 293, y: 528, phase: 6 },
            { x: 30, y: 178, phase: 9 }
        ].map(r => ({ ...r, step: 0 }));
        // ボタン花: 1pxだけ上下する
        const buttonFlowers = [
            { x: 150, y: 22, phase: 1 }, { x: 365, y: 16, phase: 4 }, { x: 565, y: 26, phase: 2 },
            { x: 180, y: 226, phase: 7 }, { x: 700, y: 82, phase: 5 }, { x: 620, y: 531, phase: 8 }
        ].map(f => ({ ...f, up: false }));
        // 池: 短い水色ドットを周回させる
        const ponds = [
            { x: 545, y: 95, r: 46 }, { x: 120, y: 410, r: 56 }, { x: 635, y: 470, r: 34 }
        ].map(p => ({ ...p, dotAngle: Math.random() * Math.PI * 2 }));
        // 黄色い糸くず: 最大4個だけ漂う
        const threads = [];
        for (let i = 0; i < 4; i++) threads.push(this._spawnGrassThread(i * 40));
        return { ribbons, buttonFlowers, ponds, threads, frame: 0 };
    },

    _spawnGrassThread(delayTick) {
        return {
            x: 40 + Math.random() * 720, y: 40 + Math.random() * 520,
            vx: (Math.random() < 0.5 ? -1 : 1) * (0.6 + Math.random() * 0.6),
            vy: -(0.3 + Math.random() * 0.4),
            life: 60 + Math.floor(Math.random() * 40),
            delay: delayTick
        };
    },

    _tickGrassland() {
        const s = this.state; s.frame++;
        s.ribbons.forEach(r => { r.step = Math.floor((s.frame + r.phase) / 4) % 3; }); // 3段階(0,1,2)を順に
        s.buttonFlowers.forEach(f => { if ((s.frame + f.phase) % 6 === 0) f.up = !f.up; });
        s.ponds.forEach(p => { p.dotAngle += 0.35; });
        s.threads.forEach((th, i) => {
            if (th.delay > 0) { th.delay--; return; }
            th.x += th.vx; th.y += th.vy; th.life--;
            if (th.life <= 0 || th.x < -10 || th.x > 810 || th.y < -10) s.threads[i] = this._spawnGrassThread(0);
        });
    },

    _drawGrassland(ctxObj, isBattling) {
        const s = this.state;
        const densityScale = isBattling ? 0.5 : 1;

        // リボン草: 左右2〜3pxの3段階スイング(四角いドットで表現)
        ctxObj.fillStyle = '#2f6b2a';
        s.ribbons.forEach(r => {
            const dx = [-3, 0, 2][r.step];
            for (let i = 0; i < 4; i++) ctxObj.fillRect(r.x + dx + i * 3 - 6, r.y - i * 4, 3, 4);
        });

        // ボタン花: 1px上下
        ctxObj.fillStyle = '#ffe066';
        s.buttonFlowers.forEach(f => { ctxObj.fillRect(f.x - 2, f.y + (f.up ? -1 : 0), 4, 4); });

        // 池: 短い水色ドットの流れ(戦闘中は本数を半分にする)
        ctxObj.fillStyle = 'rgba(190,255,246,0.85)';
        s.ponds.forEach(p => {
            const dotCount = Math.max(1, Math.round(3 * densityScale));
            for (let i = 0; i < dotCount; i++) {
                const a = p.dotAngle + (i * Math.PI * 2) / dotCount;
                const px = p.x + Math.cos(a) * p.r * 0.6, py = p.y + Math.sin(a) * p.r * 0.35;
                ctxObj.fillRect(Math.round(px), Math.round(py), 2, 2);
            }
        });

        // 黄色い糸くず(最大4個、戦闘中は半分)
        ctxObj.fillStyle = '#f4d35e';
        const threadLimit = Math.max(1, Math.round(s.threads.length * densityScale));
        for (let i = 0; i < threadLimit; i++) {
            const th = s.threads[i];
            if (th.delay > 0) continue;
            ctxObj.fillRect(Math.round(th.x), Math.round(th.y), 3, 3);
        }
    },

    // ------------------------------------------------------------
    // 闇の森(wardrobe_gloomwood)
    // ------------------------------------------------------------
    _createClosetState() {
        // コートの裾・空の袖: 左右2pxスイング(開始をずらす)
        const hems = [
            { x: 40, y: 470, phase: 0 }, { x: 155, y: 495, phase: 2 }, { x: 65, y: 150, phase: 5 },
            { x: 700, y: 470, phase: 1 }, { x: 755, y: 150, phase: 4 }, { x: 625, y: 465, phase: 3 }
        ].map(h => ({ ...h }));
        // 金色のボタン光: 最大8個、漂う
        const buttonLightsBase = [
            { x: 300, y: 65 }, { x: 185, y: 155 }, { x: 135, y: 205 }, { x: 595, y: 190 },
            { x: 628, y: 340 }, { x: 105, y: 400 }, { x: 645, y: 470 }, { x: 315, y: 490 }
        ];
        const buttonLights = buttonLightsBase.map((b, i) => ({
            baseX: b.x, baseY: b.y, x: b.x, y: b.y, phase: i * 2, driftAngle: Math.random() * Math.PI * 2
        }));
        // 紫色の糸粒子: 最大6個、ゆっくり落ちる
        const purpleThreads = [];
        for (let i = 0; i < 6; i++) purpleThreads.push(this._spawnClosetThread(i * 30));
        return { hems, buttonLights, purpleThreads, doorGlow: 0.4, frame: 0 };
    },

    _spawnClosetThread(delayTick) {
        return {
            x: 40 + Math.random() * 720, y: -10,
            vy: 0.25 + Math.random() * 0.25,
            life: 140 + Math.floor(Math.random() * 60),
            delay: delayTick
        };
    },

    _tickCloset() {
        const s = this.state; s.frame++;
        s.hems.forEach(h => { h.step = Math.floor((s.frame + h.phase) / 5) % 3; });
        s.buttonLights.forEach(b => {
            b.driftAngle += 0.12;
            b.x = b.baseX + Math.round(Math.cos(b.driftAngle) * 3);
            b.y = b.baseY + Math.round(Math.sin(b.driftAngle) * 3);
        });
        s.purpleThreads.forEach((th, i) => {
            if (th.delay > 0) { th.delay--; return; }
            th.y += th.vy; th.life--;
            if (th.life <= 0 || th.y > 610) s.purpleThreads[i] = this._spawnClosetThread(0);
        });
        // 扉の隙間: 弱い明滅(サインカーブ)
        s.doorGlow = 0.25 + (Math.sin(s.frame * 0.15) + 1) / 2 * 0.35;
    },

    _drawCloset(ctxObj, isBattling) {
        const s = this.state;
        const densityScale = isBattling ? 0.5 : 1;

        // コートの裾・袖: 左右2pxスイング
        ctxObj.fillStyle = 'rgba(20,10,40,0.55)';
        s.hems.forEach(h => {
            const dx = [-2, 0, 2][h.step || 0];
            for (let i = 0; i < 3; i++) ctxObj.fillRect(h.x + dx - 3, h.y + i * 3, 6, 3);
        });

        // クローゼット扉の隙間の明滅
        ctxObj.save();
        ctxObj.globalAlpha = s.doorGlow;
        ctxObj.fillStyle = '#ffd76a';
        ctxObj.fillRect(398, 20, 4, 46);
        ctxObj.restore();

        // 金色のボタン光(最大8個、戦闘中は半分)
        ctxObj.fillStyle = '#ffcf4d';
        const lightLimit = Math.max(1, Math.round(s.buttonLights.length * densityScale));
        for (let i = 0; i < lightLimit; i++) {
            const b = s.buttonLights[i];
            ctxObj.fillRect(Math.round(b.x) - 2, Math.round(b.y) - 2, 4, 4);
        }

        // 紫色の糸粒子(最大6個、戦闘中は半分)
        ctxObj.fillStyle = '#b98cf0';
        const threadLimit = Math.max(1, Math.round(s.purpleThreads.length * densityScale));
        for (let i = 0; i < threadLimit; i++) {
            const th = s.purpleThreads[i];
            if (th.delay > 0) continue;
            ctxObj.fillRect(Math.round(th.x), Math.round(th.y), 3, 3);
        }
    },

    // ------------------------------------------------------------
    // 水中・洗濯機(laundry_abyss)
    // ------------------------------------------------------------
    _createUnderwaterState() {
        // 気泡: 画面下と排水口(中央上部のハブ)から上昇させる。探索中は最大20個。
        const bubbles = [];
        for (let i = 0; i < 20; i++) bubbles.push(this._spawnUnderwaterBubble(i * 8));
        // 泡の水流: ドラム中央の楕円パスに沿って回転方向(時計回り)へ流す
        const flowDots = [];
        for (let i = 0; i < 10; i++) flowDots.push({ angle: (i / 10) * Math.PI * 2 });
        // ドラム穴の光: 周囲に配置し、順番に明滅させる
        const drumLights = [
            { x: 60, y: 60 }, { x: 220, y: 25 }, { x: 400, y: 15 }, { x: 580, y: 25 },
            { x: 740, y: 60 }, { x: 40, y: 300 }, { x: 760, y: 300 }, { x: 400, y: 585 }
        ].map((d, i) => ({ ...d, idx: i }));
        // リボン状の布(4隅)
        const ribbons = [{ x: 90, y: 470 }, { x: 730, y: 470 }, { x: 90, y: 130 }, { x: 715, y: 130 }];
        return { bubbles, flowDots, drumLights, ribbons, litIndex: 0, frame: 0 };
    },

    _spawnUnderwaterBubble(delayTick) {
        const fromDrain = Math.random() < 0.25;
        return {
            x: fromDrain ? 385 + Math.random() * 30 : 20 + Math.random() * 760,
            y: fromDrain ? 65 : 590 + Math.random() * 10,
            vy: -(0.5 + Math.random() * 0.6),
            life: 90 + Math.floor(Math.random() * 60),
            delay: delayTick
        };
    },

    _tickUnderwater() {
        const s = this.state; s.frame++;
        s.bubbles.forEach((b, i) => {
            if (b.delay > 0) { b.delay--; return; }
            b.y += b.vy; b.life--;
            if (b.life <= 0 || b.y < -10) s.bubbles[i] = this._spawnUnderwaterBubble(0);
        });
        s.flowDots.forEach(f => { f.angle += 0.12; }); // ドラムの回転方向(時計回り)へ流す
        if (s.frame % 4 === 0) s.litIndex = (s.litIndex + 1) % s.drumLights.length; // 順番に明滅
    },

    _drawUnderwater(ctxObj, isBattling) {
        const s = this.state;
        const densityScale = isBattling ? 0.6 : 1; // 探索20個/戦闘12個 相当

        // 気泡(四角いドット)
        ctxObj.fillStyle = 'rgba(230,250,255,0.9)';
        const bubbleLimit = isBattling ? 12 : 20;
        for (let i = 0; i < Math.min(bubbleLimit, s.bubbles.length); i++) {
            const b = s.bubbles[i];
            if (b.delay > 0) continue;
            ctxObj.fillRect(Math.round(b.x), Math.round(b.y), 3, 3);
        }

        // 白い泡の水流: 中央の楕円パスをドラムの回転方向へ
        ctxObj.fillStyle = 'rgba(255,255,255,0.65)';
        const flowLimit = Math.max(1, Math.round(s.flowDots.length * densityScale));
        for (let i = 0; i < flowLimit; i++) {
            const f = s.flowDots[i];
            const fx = 400 + Math.cos(f.angle) * 190, fy = 300 + Math.sin(f.angle) * 130;
            ctxObj.fillRect(Math.round(fx), Math.round(fy), 2, 2);
        }

        // ドラム穴の光: 順番に明滅
        s.drumLights.forEach(d => {
            ctxObj.save();
            ctxObj.globalAlpha = d.idx === s.litIndex ? 0.9 : 0.25;
            ctxObj.fillStyle = '#bfe9ff';
            ctxObj.fillRect(d.x - 2, d.y - 2, 4, 4);
            ctxObj.restore();
        });

        // リボン状の布: 左右へゆっくり揺らす
        ctxObj.fillStyle = 'rgba(150,110,220,0.55)';
        s.ribbons.forEach((r, i) => {
            const dx = Math.round(Math.sin(s.frame * 0.05 + i) * 2);
            for (let j = 0; j < 3; j++) ctxObj.fillRect(r.x + dx - 4 + j * 3, r.y + j * 3, 3, 3);
        });
    },

    // ------------------------------------------------------------
    // 回復の間(laundry_plaza / 泡織りの洗濯広場)
    // ------------------------------------------------------------
    _createPlazaState() {
        const fountain = { x: 400, y: 190 };
        // 洗剤採取スポットは既存のLAUNDRY_SPOT_ZONES(座標は変更しない)を中心座標として再利用する
        const spots = (typeof LAUNDRY_SPOT_ZONES !== 'undefined' ? LAUNDRY_SPOT_ZONES : []).map(z => ({
            x: z.x + z.w / 2, y: z.y + z.h / 2
        }));
        const bubbles = [];
        for (let i = 0; i < 12; i++) bubbles.push(this._spawnPlazaBubble(i * 10));
        return { fountain, spots, bubbles, fountainFrame: 0, blinkIndex: 0, curtainStep: 0, frame: 0 };
    },

    _spawnPlazaBubble(delayTick) {
        const colors = ['#ffb3d9', '#a9e6ff', '#ffffff'];
        return {
            x: 340 + Math.random() * 120, y: 220 + Math.random() * 20,
            vy: -(0.4 + Math.random() * 0.5),
            color: colors[Math.floor(Math.random() * colors.length)],
            life: 70 + Math.floor(Math.random() * 50),
            delay: delayTick
        };
    },

    _tickPlaza() {
        const s = this.state; s.frame++;
        if (s.frame % 5 === 0) s.fountainFrame = (s.fountainFrame + 1) % 4; // 4コマ風に回転
        if (s.frame % 8 === 0) s.blinkIndex = (s.blinkIndex + 1) % Math.max(1, s.spots.length); // 3スポットを順番に明滅
        s.curtainStep = Math.floor(s.frame / 6) % 3;
        const healing = typeof laundryHealEffectTimer !== 'undefined' && laundryHealEffectTimer > 0;
        s.bubbles.forEach((b, i) => {
            if (b.delay > 0) { b.delay--; return; }
            b.y += b.vy * (healing ? 1.8 : 1); b.life--; // 回復実行中は泡の動きを少し速める
            if (b.life <= 0 || b.y < -10) s.bubbles[i] = this._spawnPlazaBubble(0);
        });
    },

    _drawPlaza(ctxObj) {
        const s = this.state;
        const healing = typeof laundryHealEffectTimer !== 'undefined' && laundryHealEffectTimer > 0;

        // 中央の回復泉: 4コマ風の回転(四角ドットを周回させて表現)
        ctxObj.fillStyle = '#bfe9ff';
        for (let i = 0; i < 4; i++) {
            const a = (s.fountainFrame / 4) * Math.PI * 2 + (i * Math.PI) / 2;
            const fx = s.fountain.x + Math.cos(a) * 20, fy = s.fountain.y + Math.sin(a) * 12;
            ctxObj.fillRect(Math.round(fx) - 2, Math.round(fy) - 2, 4, 4);
        }

        // 桃色・水色・白の泡(最大12個。回復実行時は少し数を増やす)
        const bubbleLimit = healing ? 12 : 9;
        for (let i = 0; i < Math.min(bubbleLimit, s.bubbles.length); i++) {
            const b = s.bubbles[i];
            if (b.delay > 0) continue;
            ctxObj.fillStyle = b.color;
            ctxObj.fillRect(Math.round(b.x), Math.round(b.y), 3, 3);
        }

        // 3つの洗剤採取スポットを順番に明滅
        s.spots.forEach((sp, i) => {
            ctxObj.save();
            ctxObj.globalAlpha = i === s.blinkIndex ? 0.9 : 0.35;
            ctxObj.fillStyle = '#fff6c9';
            ctxObj.fillRect(sp.x - 2, sp.y - 2, 4, 4);
            ctxObj.restore();
        });

        // 下のカーテン: 左右2pxスイング
        ctxObj.fillStyle = 'rgba(40,110,100,0.45)';
        const cdx = [-2, 0, 2][s.curtainStep];
        for (let i = 0; i < 6; i++) ctxObj.fillRect(340 + i * 20 + cdx - 3, 560, 6, 4);

        // 回復実行時だけ: 白い光の輪
        if (healing) {
            const p = 1 - laundryHealEffectTimer / 45;
            ctxObj.save();
            ctxObj.globalAlpha = 0.4 * (1 - p);
            ctxObj.strokeStyle = '#ffffff'; ctxObj.lineWidth = 3;
            ctxObj.beginPath(); ctxObj.arc(s.fountain.x, s.fountain.y, 20 + p * 90, 0, Math.PI * 2); ctxObj.stroke();
            ctxObj.restore();
        }
    }
};

function updateGold(amount) {
    GameState.gold += amount;
    document.getElementById('ui-gold').textContent = GameState.gold;
    document.getElementById('menu-gold').textContent = GameState.gold;
}

const ALL_STYLES = ['炎', '氷', '雷', '光', '闇']; // 新属性は増やさない(承認済みキャラクター仕様に合わせる)
// 属性の一方向循環: 炎→氷→雷→光→闇→炎。既存の敵障壁・通常耐性・スキル計算はそのまま、
// この関数の戻り値を最終倍率として1回だけ掛けて重複適用しない。
const ELEMENT_ADVANTAGE = { '炎': '氷', '氷': '雷', '雷': '光', '光': '闇', '闇': '炎' };
// 攻撃側の属性(attackerStyle)が防御側の属性(defenderStyle)に有利/不利かでダメージ倍率を返す。
// 既存の「属性一致連携(Perfect Fit)」とは別の仕組みで、通常攻撃・仲間の攻撃・敵の反撃すべてに適用する。
function getElementMultiplier(attackerStyle, defenderStyle) {
    if (!attackerStyle || !defenderStyle) return 1;
    if (ELEMENT_ADVANTAGE[attackerStyle] === defenderStyle) return 1.25; // 有利属性
    if (ELEMENT_ADVANTAGE[defenderStyle] === attackerStyle) return 0.85; // 不利属性
    return 1; // それ以外(同属性・無関係属性)は等倍
}
// 属性名の表示色(召喚結果・仲間一覧・ステータス・戦闘画面で共通して使う)
const STYLE_COLORS = { '炎': '#e74c3c', '氷': '#5dc8e8', '雷': '#f1c40f', '光': '#fff2a8', '闇': '#8e5bd6' };
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
            const rolledHp = Math.floor(Math.random() * 80) + 100;
            const rolledMp = Math.floor(Math.random() * 80) + 50;
            resolve({
                name: `${template.prefix}紋章・${baseNames[Math.floor(Math.random() * baseNames.length)]}`,
                job: template.job, style: template.style,
                hp: rolledHp, maxHp: rolledHp, mp: rolledMp, maxMp: rolledMp, agi: Math.floor(Math.random() * 80) + 50,
                color: template.color,
                tension: 0
            });
        }, 1200);
    });
}

// 召喚の祭壇: ユーザー承認済みキャラクター23人（C4/B4/A4/S4/SS4/SSS3）。
// id・job・weapon・style・portrait(256x256透過PNG)・colorはcharacters.jsonの正式データをそのまま使う。
// SSSはセラフィ・ノクターン・エデンの既存3人を維持しつつportraitを紐付け、
// SSはアステア・イグニス・モルガナの既存3人(Lv等は維持)に新規のヴェイルを追加する。
const CHARACTER_ROSTER = [
    { id: 'c_gail', rank: 'C', name: '街角の裁断戦士・ガイル', job: '裁断戦士', weapon: '大裁ち鋏', style: '炎', portrait: 'assets/portraits/C/gail.png', color: '#a95d37' },
    { id: 'c_roto', rank: 'C', name: '見習い縫い手・ロト', job: '縫い手', weapon: '長針の杖', style: '光', portrait: 'assets/portraits/C/roto.png', color: '#d6c39f' },
    { id: 'c_jin', rank: 'C', name: '旅する繕い手・ジン', job: '繕い手', weapon: '糸鉤', style: '雷', portrait: 'assets/portraits/C/jin.png', color: '#b96735' },
    { id: 'c_popo', rank: 'C', name: '新米仕立屋・ポポ', job: '仕立屋', weapon: '布槌', style: '雷', portrait: 'assets/portraits/C/popo.png', color: '#bd687b' },

    { id: 'b_bardo', rank: 'B', name: '鋏剣士・バルド', job: '鋏剣士', weapon: '鋏大剣', style: '炎', portrait: 'assets/portraits/B/bardo.png', color: '#9d3e32' },
    { id: 'b_fiona', rank: 'B', name: '糸占い師・フィオナ', job: '糸占い師', weapon: '紡錘振り子', style: '氷', portrait: 'assets/portraits/B/fiona.png', color: '#3b8e91' },
    { id: 'b_glen', rank: 'B', name: '釦盾士・グレン', job: '釦盾士', weapon: '大釦盾', style: '雷', portrait: 'assets/portraits/B/glen.png', color: '#6f7742' },
    { id: 'b_lily', rank: 'B', name: '布舞い・リリィ', job: '布舞士', weapon: '布刃リボン', style: '闇', portrait: 'assets/portraits/B/lily.png', color: '#9b67b7' },

    { id: 'a_leon', rank: 'A', name: '黒鋏の剣士・レオン', job: '黒鋏剣士', weapon: '鋏レイピア', style: '闇', portrait: 'assets/portraits/A/leon.png', color: '#ad3041' },
    { id: 'a_elena', rank: 'A', name: '白絹の縫術師・エレナ', job: '白絹縫術師', weapon: '銀針扇', style: '光', portrait: 'assets/portraits/A/elena.png', color: '#dbeaf2' },
    { id: 'a_shion', rank: 'A', name: '蒼布の追跡者・シオン', job: '蒼布追跡者', weapon: '糸巻き弩', style: '氷', portrait: 'assets/portraits/A/shion.png', color: '#29477d' },
    { id: 'a_valeria', rank: 'A', name: '紅釦の騎士・ヴァレリア', job: '紅釦騎士', weapon: '縫い目裂き槍', style: '炎', portrait: 'assets/portraits/A/valeria.png', color: '#8d3344' },

    { id: 's_kayen', rank: 'S', name: '黄金裁騎・カイエン', job: '黄金裁騎', weapon: '双刃裁ち鋏', style: '雷', portrait: 'assets/portraits/S/kayen.png', color: '#d9a22d' },
    { id: 's_mira', rank: 'S', name: '月紡ぎの賢女・ミラ', job: '月紡ぎ賢女', weapon: '月糸巻き杖', style: '氷', portrait: 'assets/portraits/S/mira.png', color: '#9dbbea' },
    { id: 's_luna', rank: 'S', name: '若葉布舞・ルーナ', job: '若葉布舞', weapon: '双布戦扇', style: '光', portrait: 'assets/portraits/S/luna.png', color: '#4da85c' },
    { id: 's_zex', rank: 'S', name: '閃針のゼクス', job: '閃針士', weapon: '双糸針', style: '闇', portrait: 'assets/portraits/S/zex.png', color: '#247985' },

    { id: 'ss_asteria', rank: 'SS', name: '虹染めの術師・アステア', job: '虹染術師', weapon: '虹染料の筆槍', style: '光', portrait: 'assets/portraits/SS/asteria.png', color: '#e85bb5' },
    { id: 'ss_ignis', rank: 'SS', name: '深紅の染色術師・イグニス', job: '深紅染術師', weapon: '蒸気アイロン大槌', style: '炎', portrait: 'assets/portraits/SS/ignis.png', color: '#e74c3c' },
    { id: 'ss_morgana', rank: 'SS', name: '夜布の染色術師・モルガナ', job: '夜布染術師', weapon: '糸車の大鎌', style: '闇', portrait: 'assets/portraits/SS/morgana.png', color: '#9b59b6' },
    { id: 'ss_veil', rank: 'SS', name: '銀型紙の魔導侯・ヴェイル', job: '型紙魔導侯', weapon: '型紙魔導書と六銀針', style: '氷', portrait: 'assets/portraits/SS/veil.png', color: '#b9d8ef' },

    { id: 'sss_seraphy', rank: 'SSS', name: '王室仕立師・セラフィ', job: '王室仕立師', weapon: '王針と金糸', style: '光', portrait: 'assets/portraits/SSS/seraphy.png', color: '#ffd45a' },
    { id: 'sss_nocturne', rank: 'SSS', name: '千色の染織王・ノクターン', job: '染織王', weapon: '千色織機', style: '闇', portrait: 'assets/portraits/SSS/nocturne.png', color: '#ee55d8' },
    { id: 'sss_eden', rank: 'SSS', name: '星布の創始者・エデン', job: '星布創始者', weapon: '星布の刃', style: '炎', portrait: 'assets/portraits/SSS/eden.png', color: '#e24e58' }
];
// ランクごとに抽出したプール(既存コードのCHARACTER_POOL[rankData.key]呼び出しをそのまま使えるようにする)
const CHARACTER_POOL = { C: [], B: [], A: [], S: [], SS: [], SSS: [] };
CHARACTER_ROSTER.forEach(c => CHARACTER_POOL[c.rank].push(c));

// 召喚結果の表示専用: 各portrait(256x256透過PNG)内で実際にキャラが描かれている範囲(bbox)。
// 画像ファイル自体は加工せず、この座標を元にCSSのbackground-size/positionをキャラごとに計算し、
// 透過余白の差(Sランクのみ約56〜66%、他は約86%で統一)を吸収して見た目の背丈を揃えるために使う。
const PORTRAIT_CANVAS_SIZE = 256;
const PORTRAIT_BBOX = {
    c_gail:       { x0: 39, y0: 18, x1: 217, y1: 238 },
    c_roto:       { x0: 47, y0: 18, x1: 208, y1: 238 },
    c_jin:        { x0: 46, y0: 18, x1: 209, y1: 238 },
    c_popo:       { x0: 47, y0: 18, x1: 208, y1: 238 },
    b_bardo:      { x0: 24, y0: 18, x1: 232, y1: 238 },
    b_fiona:      { x0: 32, y0: 18, x1: 223, y1: 238 },
    b_glen:       { x0: 32, y0: 18, x1: 223, y1: 238 },
    b_lily:       { x0: 18, y0: 18, x1: 238, y1: 238 },
    a_leon:       { x0: 30, y0: 18, x1: 225, y1: 238 },
    a_elena:      { x0: 24, y0: 18, x1: 231, y1: 238 },
    a_shion:      { x0: 29, y0: 18, x1: 227, y1: 238 },
    a_valeria:    { x0: 26, y0: 18, x1: 230, y1: 238 },
    s_kayen:      { x0: 43, y0: 46, x1: 215, y1: 208 },
    s_mira:       { x0: 37, y0: 50, x1: 209, y1: 206 },
    s_luna:       { x0: 66, y0: 55, x1: 222, y1: 196 },
    s_zex:        { x0: 38, y0: 59, x1: 196, y1: 195 },
    ss_asteria:   { x0: 34, y0: 18, x1: 222, y1: 238 },
    ss_ignis:     { x0: 40, y0: 18, x1: 216, y1: 238 },
    ss_morgana:   { x0: 38, y0: 18, x1: 217, y1: 238 },
    ss_veil:      { x0: 34, y0: 18, x1: 221, y1: 238 },
    sss_seraphy:  { x0: 48, y0: 18, x1: 207, y1: 238 },
    sss_nocturne: { x0: 43, y0: 18, x1: 212, y1: 238 },
    sss_eden:     { x0: 42, y0: 18, x1: 214, y1: 238 }
};
// 召喚結果ポートレートに、キャラごとのbboxを元にした background-size/position を適用する。
// 画像は一切加工せず、CSSのcustom propertyだけを書き換えて表示上の背丈・足元位置を揃える。
function applyPortraitCrop(el, characterId) {
    const bbox = PORTRAIT_BBOX[characterId];
    if (!el || !bbox) return;
    const stage = el.closest('.summon-portrait-stage');
    const cssTargetH = parseFloat(getComputedStyle(stage || document.documentElement).getPropertyValue('--portrait-target-h')) || 240;
    // stage自身のoffsetHeightは、この時点でまだally本体のサイズが未確定のため信用できない
    // (flex:1がally挿入前の空の状態を基準に伸びてしまい、確定後のカード高さとズレて全身が
    // 枠外にはみ出すことがあった)。代わりに.summon-area(外側のflex列で高さが確定済み)から
    // 実際のカード高さとgapを差し引いた「安全な残り高さ」を直接計算し、それを上限にする。
    const area = el.closest('.summon-area');
    const card = area ? area.querySelector('.gacha-card') : null;
    let safeH = cssTargetH;
    if (area && card && stage) {
        const gapPx = parseFloat(getComputedStyle(stage.parentElement).gap) || 0;
        safeH = area.offsetHeight - card.offsetHeight - gapPx - 18; // 18pxは丸め誤差・枠線・再計算タイミング差の安全バッファ
    }
    const targetH = safeH > 20 ? Math.min(safeH, cssTargetH) : cssTargetH;
    const bboxH = bbox.y1 - bbox.y0;
    const bboxW = bbox.x1 - bbox.x0;
    const scale = targetH / bboxH;
    const elW = bboxW * scale;
    const bgSize = PORTRAIT_CANVAS_SIZE * scale;
    el.style.width = `${elW}px`;
    el.style.height = `${targetH}px`;
    el.style.flex = `0 0 ${elW}px`;
    el.style.setProperty('--bg-w', `${bgSize}px`);
    el.style.setProperty('--bg-h', `${bgSize}px`);
    el.style.setProperty('--bg-x', `${-bbox.x0 * scale}px`);
    el.style.setProperty('--bg-y', `${-bbox.y0 * scale}px`);
}

// 23人分のportrait(256x256透過PNG)を先読みしておく。戦闘画面のcanvas描画(drawImage)で使う。
const PORTRAIT_IMAGES = {};
CHARACTER_ROSTER.forEach(c => {
    const img = new Image();
    img.onerror = () => console.warn(`[portrait] 画像の読込に失敗: ${c.portrait}`);
    img.src = c.portrait;
    PORTRAIT_IMAGES[c.portrait] = img;
});

// レア度が高いほど強いキャラが出るようにし、抽選演出の派手さも段階的に変える(合計100%: SSS1/SS4/S10/A20/B30/C35)
const RARITY_TABLE = [
    { key: 'SSS', cum: 0.01, flashClass: 'flash-sss', shakeLv: 4, buildupMs: 2800, sfx: 'gachasss', fanfare: 'fanfareEpic', title: 'SSS' },
    { key: 'SS', cum: 0.05, flashClass: 'flash-ss', shakeLv: 3, buildupMs: 2200, sfx: 'gachalegend', fanfare: 'fanfareGrand', title: 'SS' },
    { key: 'S', cum: 0.15, flashClass: 'flash-s', shakeLv: 2, buildupMs: 1700, sfx: 'gacha', fanfare: 'fanfareGrand', title: 'S' },
    { key: 'A', cum: 0.35, flashClass: 'flash-a', shakeLv: 1, buildupMs: 1200, sfx: 'gacha', fanfare: 'fanfare', title: 'A' },
    { key: 'B', cum: 0.65, flashClass: 'flash-b', shakeLv: 0, buildupMs: 700, sfx: 'select', fanfare: 'fanfare', title: 'B' },
    { key: 'C', cum: 1.00, flashClass: 'flash-b', shakeLv: 0, buildupMs: 420, sfx: 'select', fanfare: 'fanfare', title: 'C' } // Bより短く控えめな演出
];

// ランクが上がるたびに公開演出(光の粒・リング)を派手にする。数・大きさ・色をランクごとに変える。
const REVEAL_EFFECT_BY_RANK = {
    C: { sparkCount: 5, sparkColor: '#9aa5ab', sparkSize: 4, ringColor: '#5d6b73', ringScale: 8, rings: 1 },
    B: { sparkCount: 7, sparkColor: '#cfd8dc', sparkSize: 5, ringColor: '#95a5a6', ringScale: 10, rings: 1 },
    A: { sparkCount: 9, sparkColor: '#6fd0ff', sparkSize: 6, ringColor: '#3498db', ringScale: 12, rings: 1 },
    S: { sparkCount: 12, sparkColor: '#7cff9a', sparkSize: 7, ringColor: '#2ecc71', ringScale: 15, rings: 2 },
    SS: { sparkCount: 16, sparkColor: '#d18cff', sparkSize: 8, ringColor: '#9b59b6', ringScale: 18, rings: 2 },
    SSS: { sparkCount: 24, sparkColor: '#ffe98a', sparkSize: 9, ringColor: '#f1c40f', ringScale: 22, rings: 3 }
};
// 公開の瞬間に、ランクに応じた数・色の光の粒とリングを一瞬だけ表示する(既存の画面フラッシュ・シェイクとは別の演出)
function spawnRevealEffects(rankKey) {
    const cfg = REVEAL_EFFECT_BY_RANK[rankKey] || REVEAL_EFFECT_BY_RANK.C;
    const stage = document.querySelector('.summon-portrait-stage');
    if (!stage) return;
    for (let i = 0; i < cfg.sparkCount; i++) {
        const spark = document.createElement('span');
        spark.className = 'reveal-spark';
        const angle = (Math.PI * 2 * i) / cfg.sparkCount + (Math.random() * 0.4 - 0.2);
        const dist = 60 + Math.random() * 50;
        spark.style.setProperty('--spark-size', `${cfg.sparkSize}px`);
        spark.style.setProperty('--spark-color', cfg.sparkColor);
        spark.style.setProperty('--spark-x', `${Math.cos(angle) * dist}px`);
        spark.style.setProperty('--spark-y', `${Math.sin(angle) * dist - 30}px`);
        spark.style.setProperty('--spark-delay', `${Math.random() * 0.15}s`);
        spark.style.setProperty('--spark-dur', `${0.6 + Math.random() * 0.4}s`);
        stage.appendChild(spark);
        setTimeout(() => spark.remove(), 1300);
    }
    for (let r = 0; r < cfg.rings; r++) {
        const ring = document.createElement('span');
        ring.className = 'reveal-ring';
        ring.style.setProperty('--ring-color', cfg.ringColor);
        ring.style.setProperty('--ring-scale', cfg.ringScale + r * 4);
        ring.style.animationDelay = `${r * 0.15}s`;
        stage.appendChild(ring);
        setTimeout(() => ring.remove(), 1000);
    }
}

// 役職ごとに見た目・色・装備を明確に分けた仲間スプライト
const ALLY_VISUALS = {
    '染色術師': { path: 'assets/sprites/ally/ally_mage.png', roleClass: 'role-mage', label: '桃染めの染色術師' },
    '採寸弓師': { path: 'assets/sprites/ally/ally_archer.png', roleClass: 'role-archer', label: '黄金尺の採寸弓師' },
    '裁断戦士': { path: 'assets/sprites/ally/ally_warrior.png', roleClass: 'role-warrior', label: '双鋏の裁断戦士' }
};

// ==========================================
// アステア専用の通常表示画像（他の仲間・機能には影響させない）
// party_special_actions.png は6列×3行、1行目=アステア。先頭コマ(0,0)だけを通常表示に使う。
// 名前・ランク・レベル・能力値・セーブデータは変更しない。表示（見た目）だけを追加する。
// ==========================================
const ASTERIA_NAME = '虹染めの術師・アステア';
const ASTERIA_PORTRAIT_PATH = 'assets/sprites/actions/party_special_actions.png';
const ASTERIA_ATLAS_COLS = 6, ASTERIA_ATLAS_ROWS = 3;
const asteriaPortraitImg = new Image();
asteriaPortraitImg.onerror = () => console.warn(`[asteria] 画像の読込に失敗: ${ASTERIA_PORTRAIT_PATH}`);
asteriaPortraitImg.src = ASTERIA_PORTRAIT_PATH;

// ==========================================
// アステア専用スキル演出 (party_special_actions.png 1行目, 6コマ)
// 構え → 詠唱 → 魔力を溜める → 虹色の染料を回す → プリズム攻撃 → 復帰
// ダメージ計算式・MP消費・スキル効果自体はここでは一切変更しない。
// 「いつ・どう見せるか」の演出タイミングだけを追加し、命中(5コマ目)で1回だけダメージを適用する。
// ==========================================
const ASTERIA_SKILL_FRAMES = ['ready', 'charge_1', 'charge_2', 'action', 'impact', 'recover'];
const ASTERIA_SKILL_GLOW_COLORS = ['#ff8fd6', '#7fe0ff', '#ffe066']; // 桃色・水色・黄色
let asteriaSkillActive = false;      // true の間、連打による二重発動を防止する
let asteriaSkillFrameIndex = -1;     // -1: 通常表示(先頭コマ) / 0-5: 演出中の再生コマ
let asteriaSkillFloatY = 0;          // 浮遊オフセット(px)
let asteriaSkillGlowColor = null;    // 発光の現在色(null なら発光なし)

// アステアのスキル演出を再生し、5コマ目(プリズム攻撃 = impact)の命中時にだけ
// applyDamageToEnemy を1回呼び出す。既存のダメージ計算式(rawDmg)や貫通判定(isPiercing)は
// 呼び出し元(commandAllyAttack)からそのまま受け取るだけで変更しない。
function playAsteriaSkillSequence(ally, rawDmg, isPiercing, onComplete) {
    if (asteriaSkillActive) return; // 保険: 既に演出中なら何もしない(二重発動防止)
    asteriaSkillActive = true;
    asteriaSkillFrameIndex = 0;
    asteriaSkillFloatY = 14; // 少し浮く
    playSound('magic');

    const CHARGE_MS = 500;      // 約0.5秒、光を溜める
    const FRAME_MS = 140;       // 6コマ再生の1コマあたりの時間
    let glowStep = 0;
    asteriaSkillGlowColor = ASTERIA_SKILL_GLOW_COLORS[0];
    const glowInterval = setInterval(() => {
        glowStep++;
        asteriaSkillGlowColor = ASTERIA_SKILL_GLOW_COLORS[glowStep % ASTERIA_SKILL_GLOW_COLORS.length];
    }, Math.round(CHARGE_MS / ASTERIA_SKILL_GLOW_COLORS.length));

    setTimeout(() => {
        clearInterval(glowInterval);
        let damageApplied = false; // 5コマ目で1回だけダメージを適用するためのガード

        ASTERIA_SKILL_FRAMES.forEach((frameName, i) => {
            setTimeout(() => {
                if (!asteriaSkillActive) return; // 演出が既に終了していたら何もしない
                asteriaSkillFrameIndex = i;
                asteriaSkillGlowColor = ASTERIA_SKILL_GLOW_COLORS[i % ASTERIA_SKILL_GLOW_COLORS.length];

                if (frameName === 'action' && currentEnemy) {
                    // 敵の位置で虹色の円形エフェクト(3色を同位置から放射)
                    ASTERIA_SKILL_GLOW_COLORS.forEach(c => spawnMagicParticles(600, 380, 600, 380, c));
                    playSound('magic');
                }

                if (frameName === 'impact' && !damageApplied && currentEnemy) {
                    damageApplied = true; // ダメージは1回だけ
                    screenShakeTimer = Math.max(screenShakeTimer, 14);
                    const { dmg, blocked } = applyDamageToEnemy(currentEnemy, rawDmg, isPiercing);
                    updateHPUI();
                    if (currentEnemy.sprite) {
                        // hitStopFrames:5 ≈ 約85ms(60fps換算)、左右への揺れはknockback(toX)で表現
                        currentEnemy.sprite.triggerHit({ hitStopFrames: 5, flashFrames: 16, knockbackPower: 10, fromX: 0, fromY: 0, toX: 1, toY: -0.2 });
                    }
                    if (blocked) {
                        showDamage(600, 360, 0);
                        bMsg.textContent = `🛡️ ${ally.name}の攻撃は障壁に阻まれた！ スキルか属性連携で破れ！`;
                    } else {
                        showDamage(600, 360, dmg);
                        bMsg.textContent = isPiercing ? `✨${ally.name}の虹染めの奥義！ ${dmg}のダメージ！` : `✨${ally.name}の虹染めの奥義！ ${dmg}のダメージ！`;
                    }
                }
            }, FRAME_MS * i);
        });

        setTimeout(() => {
            // 演出終了: アステアを元の通常表示(先頭コマ)・位置へ戻す
            asteriaSkillActive = false;
            asteriaSkillFrameIndex = -1;
            asteriaSkillFloatY = 0;
            asteriaSkillGlowColor = null;
            onComplete();
        }, FRAME_MS * ASTERIA_SKILL_FRAMES.length + 80);
    }, CHARGE_MS);
}

// ==========================================
// ルーナ専用スキル演出 (party_special_actions.png 2行目, 6コマ。アステアの演出・画像処理には触れない)
// 構え → 弓を引く → 黄金の力を溜める → 採寸矢を放つ → 命中 → 復帰
// ダメージ計算式・MP消費・スキル効果自体はここでは一切変更しない。
// 「いつ・どう見せるか」の演出タイミングだけを追加し、命中(5コマ目)で1回だけダメージを適用する。
// ==========================================
const LUNA_NAME = '若葉布の採寸弓師・ルーナ';
const LUNA_ATLAS_ROW = 1; // 2行目 = ルーナ (0行目=アステア)
const LUNA_SKILL_FRAMES = ['ready', 'charge_1', 'charge_2', 'action', 'impact', 'recover'];
const LUNA_SKILL_GLOW_COLOR = '#ffe066'; // 黄色いメジャー状の光
let lunaSkillActive = false;       // true の間、連打による二重発動を防止する
let lunaSkillFrameIndex = -1;      // -1: 通常表示(ally_archer.png) / 0-5: 演出中の再生コマ
let lunaSkillGlowColor = null;     // 発光の現在色(null なら発光なし)
let lunaImpactEffectTimer = 0;     // 命中時、敵の位置に黄色い円+目盛りを描く残りフレーム数

function playLunaSkillSequence(ally, rawDmg, isPiercing, onComplete) {
    if (lunaSkillActive) return; // 保険: 既に演出中なら何もしない(二重発動防止)
    lunaSkillActive = true;
    lunaSkillFrameIndex = 0; // 構え
    lunaSkillGlowColor = LUNA_SKILL_GLOW_COLOR;
    playSound('select');

    const CHARGE_MS = 500;   // 約0.5秒、黄色いメジャー状の光を溜める
    const FRAME_MS = 140;    // 6コマ再生の1コマあたりの時間

    setTimeout(() => {
        if (!lunaSkillActive) return;
        lunaSkillFrameIndex = 1; // 弓を引く(溜め中の中間ポーズ)
    }, Math.round(CHARGE_MS / 2));

    setTimeout(() => {
        let damageApplied = false; // 5コマ目で1回だけダメージを適用するためのガード

        LUNA_SKILL_FRAMES.forEach((frameName, i) => {
            setTimeout(() => {
                if (!lunaSkillActive) return; // 演出が既に終了していたら何もしない
                lunaSkillFrameIndex = i;

                if (frameName === 'action' && currentEnemy) {
                    // 黄金の採寸矢を敵へ高速で飛ばす
                    playSound('slash');
                    spawnMagicParticles(200, 300, 600, 380, '#ffe066');
                }

                if (frameName === 'impact' && !damageApplied && currentEnemy) {
                    damageApplied = true; // ダメージは1回だけ
                    screenShakeTimer = Math.max(screenShakeTimer, 14);
                    lunaImpactEffectTimer = 16; // 敵の位置に黄色い円+目盛りエフェクト
                    const { dmg, blocked } = applyDamageToEnemy(currentEnemy, rawDmg, isPiercing);
                    updateHPUI();
                    if (currentEnemy.sprite) {
                        // hitStopFrames:5 ≈ 約85ms(60fps換算)、左右への揺れはknockback(toX)で表現
                        currentEnemy.sprite.triggerHit({ hitStopFrames: 5, flashFrames: 16, knockbackPower: 8, fromX: 0, fromY: 0, toX: 1, toY: -0.2 });
                    }
                    if (blocked) {
                        showDamage(600, 360, 0);
                        bMsg.textContent = `🛡️ ${ally.name}の攻撃は障壁に阻まれた！ スキルか属性連携で破れ！`;
                    } else {
                        showDamage(600, 360, dmg);
                        bMsg.textContent = isPiercing ? `🏹${ally.name}の採寸の奥義！ ${dmg}のダメージ！` : `🏹${ally.name}の採寸の奥義！ ${dmg}のダメージ！`;
                    }
                }
            }, FRAME_MS * i);
        });

        setTimeout(() => {
            // 演出終了: ルーナを元の通常表示(ally_archer.png)・位置へ戻す
            lunaSkillActive = false;
            lunaSkillFrameIndex = -1;
            lunaSkillGlowColor = null;
            onComplete();
        }, FRAME_MS * LUNA_SKILL_FRAMES.length + 80);
    }, CHARGE_MS);
}

// ==========================================
// ゾン専用スキル演出 (party_special_actions.png 3行目, 6コマ。アステア・ルーナの演出・画像処理には触れない)
// 構え → 低く溜める → 敵へ突進 → 双鋏で回転攻撃 → X字の裁断エフェクト → 復帰
// ダメージ計算式・MP消費・スキル効果自体はここでは一切変更しない。
// 「いつ・どう見せるか」の演出タイミングだけを追加し、命中(5コマ目)で1回だけダメージを適用する。
// 注意: 「ゾン」は現在 CHARACTER_POOL(召喚対象)に未登録のため、召喚では入手できない。
// 名前一致だけで発動するこの処理自体は既存の召喚・重複強化システムを一切変更しない。
// ==========================================
const ZON_NAME = '旅する縫い手・ゾン';
const ZON_ATLAS_ROW = 2; // 3行目 = ゾン (0行目=アステア, 1行目=ルーナ)
const ZON_SKILL_FRAMES = ['ready', 'charge_1', 'charge_2', 'action', 'impact', 'recover'];
const ZON_SKILL_GLOW_COLOR = '#ff6b32'; // 橙赤
const ZON_SKILL_LUNGE_BY_FRAME = [0, 0, 60, 110, 110, 0]; // 敵へ突進する横方向オフセット(px)
let zonSkillActive = false;        // true の間、連打による二重発動を防止する
let zonSkillFrameIndex = -1;       // -1: 通常表示(ally_warrior.png) / 0-5: 演出中の再生コマ
let zonSkillGlowColor = null;      // 発光の現在色(null なら発光なし)
let zonSkillLungeX = 0;            // 敵へ突進する横方向オフセット(px)
let zonImpactEffectTimer = 0;      // 命中時、敵の位置に橙赤のX字裁断エフェクトを描く残りフレーム数

function playZonSkillSequence(ally, rawDmg, isPiercing, onComplete) {
    if (zonSkillActive) return; // 保険: 既に演出中なら何もしない(二重発動防止)
    zonSkillActive = true;
    zonSkillFrameIndex = 0; // 構え
    zonSkillGlowColor = ZON_SKILL_GLOW_COLOR;
    zonSkillLungeX = 0;
    playSound('select');

    const CHARGE_MS = 450;   // 低く溜める(0.5秒弱)
    const FRAME_MS = 140;    // 6コマ再生の1コマあたりの時間

    setTimeout(() => {
        if (!zonSkillActive) return;
        zonSkillFrameIndex = 1; // 低く溜める(溜め中の中間ポーズ)
    }, Math.round(CHARGE_MS / 2));

    setTimeout(() => {
        let damageApplied = false; // 5コマ目で1回だけダメージを適用するためのガード

        ZON_SKILL_FRAMES.forEach((frameName, i) => {
            setTimeout(() => {
                if (!zonSkillActive) return; // 演出が既に終了していたら何もしない
                zonSkillFrameIndex = i;
                zonSkillLungeX = ZON_SKILL_LUNGE_BY_FRAME[i];

                if (frameName === 'charge_2') {
                    playSound('slash'); // 敵へ突進
                }

                if (frameName === 'impact' && !damageApplied && currentEnemy) {
                    damageApplied = true; // ダメージは1回だけ
                    screenShakeTimer = Math.max(screenShakeTimer, 16);
                    zonImpactEffectTimer = 14; // 敵の位置に橙赤のX字裁断エフェクト
                    const { dmg, blocked } = applyDamageToEnemy(currentEnemy, rawDmg, isPiercing);
                    updateHPUI();
                    if (currentEnemy.sprite) {
                        // hitStopFrames:5 ≈ 約85ms(60fps換算)、左右への揺れはknockback(toX)で表現
                        currentEnemy.sprite.triggerHit({ hitStopFrames: 5, flashFrames: 16, knockbackPower: 10, fromX: 0, fromY: 0, toX: 1, toY: -0.2 });
                    }
                    if (blocked) {
                        showDamage(600, 360, 0);
                        bMsg.textContent = `🛡️ ${ally.name}の攻撃は障壁に阻まれた！ スキルか属性連携で破れ！`;
                    } else {
                        showDamage(600, 360, dmg);
                        bMsg.textContent = isPiercing ? `✂️${ally.name}の双鋏奥義！ ${dmg}のダメージ！` : `✂️${ally.name}の双鋏奥義！ ${dmg}のダメージ！`;
                    }
                }
            }, FRAME_MS * i);
        });

        setTimeout(() => {
            // 演出終了: ゾンを元の通常表示(ally_warrior.png)・位置へ戻す
            zonSkillActive = false;
            zonSkillFrameIndex = -1;
            zonSkillGlowColor = null;
            zonSkillLungeX = 0;
            onComplete();
        }, FRAME_MS * ZON_SKILL_FRAMES.length + 80);
    }, CHARGE_MS);
}

// ==========================================
// フィールドボス専用表示・攻撃演出 (field_boss_actions.png 5列×2行)
// 上段=クローゼットロード(0行目) / 下段=スピン・レヴィアタン(1行目)
// 既存のdragon代用スプライトを「見た目だけ」専用画像へ差し替える。
// HP・攻撃力・出現条件・撃破判定・反撃確率・ダメージ計算式(dmg)は一切変更しない。
// ==========================================
const FIELD_BOSS_ATLAS_PATH = 'assets/sprites/bosses/field_boss_actions.png';
const FIELD_BOSS_ATLAS_COLS = 5, FIELD_BOSS_ATLAS_ROWS = 2;
const FIELD_BOSS_ROW = { wardrobe_lord: 0, spin_leviathan: 1 };
const FIELD_BOSS_WARNING_COLOR = { wardrobe_lord: '#b967ff', spin_leviathan: '#4fd8ff' };
const fieldBossActionsImg = new Image();
fieldBossActionsImg.onerror = () => console.warn(`[fieldBoss] 画像の読込に失敗: ${FIELD_BOSS_ATLAS_PATH}`);
fieldBossActionsImg.src = FIELD_BOSS_ATLAS_PATH;

let fieldBossAttackActive = false;   // true の間、連打・二重発動を防止する
let fieldBossFrameIndex = -1;        // -1: 待機(先頭コマ) / 0-4: 攻撃演出中の再生コマ
let fieldBossWarningTimer = 0;       // 攻撃前の予告表示(紫/水色)の残りフレーム数
let fieldBossWarningColor = null;

// クローゼットロード/スピン・レヴィアタンの反撃を専用演出付きで実行する。
// dmg・isSpecial は enemyCounterAttack で既存の計算式のまま算出済みの値をそのまま使う(ここでは変更しない)。
function playFieldBossAttackSequence(dmg, isSpecial, onDone, target) {
    if (fieldBossAttackActive || !currentEnemy) { if (onDone) onDone(); return; }
    fieldBossAttackActive = true;
    const bossKey = currentEnemy.bossKey;
    fieldBossWarningColor = FIELD_BOSS_WARNING_COLOR[bossKey] || '#b967ff';
    fieldBossWarningTimer = 30; // 予告表示(約0.5秒)

    const WARNING_MS = 500;
    const FRAME_MS = 180;
    const FRAMES = 5;

    setTimeout(() => {
        fieldBossWarningTimer = 0;
        for (let i = 0; i < FRAMES; i++) {
            setTimeout(() => {
                if (!fieldBossAttackActive) return;
                fieldBossFrameIndex = i;
                if (i === 3) {
                    // 攻撃コマ: 既存のダメージ計算式(dmg)をそのまま1回だけ、抽選済みの対象(勇者 or 仲間)へ適用する
                    applyCounterDamage(target, dmg, isSpecial);
                    if (bossKey === 'wardrobe_lord') {
                        // 長い袖の薙ぎ払い: 画面を少し横揺れさせる(既存のscreenShakeTimerを再利用)
                        screenShakeTimer = Math.max(screenShakeTimer, 18);
                    } else if (bossKey === 'spin_leviathan') {
                        // 渦潮攻撃: 気泡+渦巻きエフェクト(既存のパーティクル系を再利用)
                        screenShakeTimer = Math.max(screenShakeTimer, 12);
                        spawnMagicParticles(600, 380, 600, 380, '#4fd8ff');
                        spawnMagicParticles(600, 380, 600, 380, '#9be8ff');
                    }
                }
            }, FRAME_MS * i);
        }
        setTimeout(() => {
            fieldBossAttackActive = false;
            fieldBossFrameIndex = -1;
            if (onDone) onDone();
        }, FRAME_MS * FRAMES + 80);
    }, WARNING_MS);
}

// ==========================================
// パーティ重複判定・強化
// 召喚仲間は「役職(=スプライト)」単位、元・敵の仲間は「enemyTypeKey」単位で同一とみなす。
// 見た目が同じキャラクターをパーティに複数追加することはなく、必ずLv/攻撃補正/スキルLvが伸びる。
// ==========================================
function findExistingPartyMember(candidate) {
    if (candidate.job === '魔物') {
        return GameState.party.find(p => p.job === '魔物' && p.enemyTypeKey === candidate.enemyTypeKey);
    }
    if (candidate.characterId) {
        // characterIdを最優先で同一人物判定する。characterIdを持たない同名の旧仲間もここで一度だけ救済統合する。
        return GameState.party.find(p => p.job !== '魔物' && (p.characterId === candidate.characterId || (!p.characterId && p.name === candidate.name)));
    }
    return GameState.party.find(p => p.job !== '魔物' && p.job === candidate.job); // characterIdを持たない旧仲間同士は従来通りjobで判定
}

// 仲間の最大HP: 役職ごとに基準値を変え、Lv(重複強化・仕立工房と共通)に応じて伸びる
const ALLY_BASE_MAX_HP = { '染色術師': 70, '採寸弓師': 90, '裁断戦士': 120 };
function getAllyMaxHp(ally) {
    if (ally.job === '魔物') return getMonsterAllyBaseHp(ally) + ((ally.level || 1) - 1) * 8;
    const base = ALLY_BASE_MAX_HP[ally.job] || 80;
    const levelBonus = ((ally.level || 1) - 1) * 8;
    return base + levelBonus;
}

// ==========================================
// 「元・敵の仲間(job:'魔物')」用のHP・攻撃力の算出式。
// 仲間化する手段(敵を仲間にする機能)自体は未実装だが、addOrEnhancePartyMember /
// getAllyDamageMultiplier など既存の仲間強化の仕組みにそのまま乗るよう、
// 数値の算出方法だけを先に用意しておく。
//
// - 倒した敵の階級(ally.sourceTier: 'small'|'mid'|'boss')が高いほど基礎値が高くなる
// - 出身フィールド(ally.sourceFieldId)のenemyHpMultiplier/enemyAttackMultiplier
//   (field-expansion.jsの既存ステージ倍率)を反映するため、後半ステージの敵ほど
//   仲間になったときも強い
// - Lv成長(重複強化・仕立工房と共通のally.level)でさらに伸びる。
//   将来、敵を仲間にする処理を実装する際は candidate.sourceTier / candidate.sourceFieldId を
//   セットして addOrEnhancePartyMember に渡すだけでこの計算式がそのまま使われる。
// どちらの項目も未設定の場合は 'small' 階級・倍率なしとして扱う。
// ==========================================
const MONSTER_ALLY_BASE_HP_BY_TIER = { small: 60, mid: 110, boss: 200 };
const MONSTER_ALLY_BASE_ATK_BY_TIER = { small: 25, mid: 45, boss: 70 };

function getMonsterAllyBaseHp(ally) {
    const tierBase = MONSTER_ALLY_BASE_HP_BY_TIER[ally.sourceTier] || MONSTER_ALLY_BASE_HP_BY_TIER.small;
    const fx = window.ZSAGA_FIELD_EXPANSION;
    const fieldCfg = fx && ally.sourceFieldId && fx.fields[ally.sourceFieldId];
    const stageMult = fieldCfg ? (fieldCfg.enemyHpMultiplier || 1) : 1;
    return Math.round(tierBase * stageMult);
}
function getMonsterAllyBaseAtk(ally) {
    const tierBase = MONSTER_ALLY_BASE_ATK_BY_TIER[ally.sourceTier] || MONSTER_ALLY_BASE_ATK_BY_TIER.small;
    const fx = window.ZSAGA_FIELD_EXPANSION;
    const fieldCfg = fx && ally.sourceFieldId && fx.fields[ally.sourceFieldId];
    const stageMult = fieldCfg ? (fieldCfg.enemyAttackMultiplier || 1) : 1;
    return Math.round(tierBase * stageMult);
}

// 仲間の基礎攻撃力(役職ごと、既存3職の数値は変更しない)。
// context: 'select'(指名攻撃) / 'coop'(総追撃) / 'perfectfit'(属性連携)で使う基礎値を返す。
// 魔物だけは固定値ではなく、階級+出身ステージから動的に算出する。
function getAllyAttackBase(ally, context) {
    if (ally.job === '魔物') {
        const monsterBase = getMonsterAllyBaseAtk(ally);
        // 既存3職の比率(coop:select:perfectfit ≒ 0.8 : 1 : 1.2)に合わせて配分する
        if (context === 'coop') return Math.round(monsterBase * 0.8);
        if (context === 'perfectfit') return Math.round(monsterBase * 1.2);
        return monsterBase; // 'select'
    }
    if (context === 'coop') return ally.job === '染色術師' ? 80 : (ally.job === '採寸弓師' ? 50 : 20);
    if (context === 'perfectfit') return ally.job === '染色術師' ? 120 : (ally.job === '採寸弓師' ? 80 : 40);
    return ally.job === '染色術師' ? 100 : (ally.job === '採寸弓師' ? 65 : 30); // 'select'
}

function addOrEnhancePartyMember(candidate) {
    const existing = findExistingPartyMember(candidate);
    if (existing) {
        // characterIdを持たない旧仲間が名前一致で見つかった場合、ここで一度だけportraitPath/characterIdを補完する
        if (!existing.characterId && candidate.characterId) {
            existing.characterId = candidate.characterId;
            existing.portraitPath = candidate.portraitPath;
        }
        existing.level = (existing.level || 1) + 1;
        existing.duplicateCount = (existing.duplicateCount || 0) + 1;
        existing.atkBonusPct = (existing.atkBonusPct || 0) + 10;
        if (existing.duplicateCount % 2 === 0) existing.skillLevel = (existing.skillLevel || 1) + 1;
        existing.maxHp = getAllyMaxHp(existing);
        existing.hp = existing.maxHp; // レベルアップ時は全回復する(戦闘不能からも復帰する)
        savePartyData();
        return { merged: true, member: existing };
    }
    candidate.level = 1;
    candidate.duplicateCount = 0;
    candidate.atkBonusPct = 0;
    candidate.skillLevel = 1;
    candidate.maxHp = getAllyMaxHp(candidate);
    candidate.hp = candidate.maxHp;
    candidate.isNew = true; // 初獲得のみ立てる。パーティー編成画面でキャラ詳細を開いたら既読(false)にする
    GameState.party.push(candidate);
    savePartyData();
    // 新規獲得キャラは仲間一覧へ追加するだけで、現在の編成(activePartyIds)・フィールドの人数は
    // 一切変更しない(勇者は常にパーティー候補として存在するため、ここで自動編成する必要はない)。
    if (isPartyFormationOpen) renderPartyFormationScreen(); // 編成画面を開いたまま召喚した場合も一覧を再描画する
    return { merged: false, member: candidate };
}

// ==========================================
// パーティー(最大4人・勇者を含む)。
// 勇者(GameState.avatar)は仲間一覧・パーティーへ選択/除外できる特別なメンバーとして、
// 専用キー HERO_KEY で activePartyIds へ含められる(GameState.partyの配列自体には入れない)。
// GameState.party(所持している仲間全員)とは別に、キャラのキー配列(activePartyIds)とリーダー(leaderId)だけを保持する。
// characterIdが無い旧仲間(魔物・旧セーブ)も一意に指せるよう、フォールバックのキーを使う。
// ==========================================
const HERO_KEY = 'hero';
function getMemberKey(p) {
    if (!p) return null;
    if (p === GameState.avatar) return HERO_KEY;
    if (p.characterId) return p.characterId;
    if (p.job === '魔物' && p.enemyTypeKey) return `monster:${p.enemyTypeKey}`;
    return `legacy:${p.name}`;
}
// キーから実体(勇者 or 所持仲間)を引く
function resolvePartyMember(key) {
    if (key === HERO_KEY) return GameState.avatar;
    return GameState.party.find(p => getMemberKey(p) === key) || null;
}

// 現在のパーティー(勇者を含む場合がある)を、activePartyIdsの並び順のまま最大4人返す。
// パーティー編成画面(仲間一覧・4枠表示)で使う。
function getActivePartyResolved() {
    const result = [];
    GameState.activePartyIds.forEach(id => {
        const p = resolvePartyMember(id);
        if (p && !result.includes(p)) result.push(p);
    });
    return result.slice(0, 4);
}
// 戦闘は既存仕様どおり勇者(GameState.avatar)を別枠で扱うため、戦闘関連コード(仲間選択・総追撃・
// Perfect Fit・反撃対象・全滅判定など)からは、このgetActiveParty()を今までどおり「仲間(勇者を除く)」の
// 意味で呼ぶ。戦闘のロジック・計算式自体はこの関数の中身が変わっても一切変更しない。
function getActiveParty() {
    return getActivePartyResolved().filter(p => p !== GameState.avatar);
}
// フィールドで先頭に立ち、プレイヤーが操作するキャラ(勇者 or 仲間の誰か)を返す
function getFieldLeader() {
    let leader = resolvePartyMember(GameState.leaderId);
    if (!leader || !GameState.activePartyIds.includes(GameState.leaderId)) {
        const resolved = getActivePartyResolved();
        leader = resolved[0] || GameState.avatar;
        GameState.leaderId = getMemberKey(leader);
        saveActivePartyIds();
    }
    return leader;
}
// フィールドでリーダーの後ろへ追従する残りのパーティーメンバー(最大3人、編成順)
function getFieldFollowers() {
    const leader = getFieldLeader();
    return getActivePartyResolved().filter(p => p !== leader).slice(0, 3);
}

const ACTIVE_PARTY_KEY = 'zsaga_active_party_v1';
const LEADER_ID_KEY = 'zsaga_leader_id_v1';
function saveActivePartyIds() {
    try {
        localStorage.setItem(ACTIVE_PARTY_KEY, JSON.stringify(GameState.activePartyIds));
        localStorage.setItem(LEADER_ID_KEY, GameState.leaderId || HERO_KEY);
    } catch (e) { /* 保存できない環境では無視 */ }
}
// 存在しないID・未所持ID・重複IDを除外し、最大4人までに正規化する。保存済みの編成データが無い、
// または壊れている場合は、所持キャラ全員を編成せず「勇者1人だけ」を初期パーティーにする。
function loadActivePartyIds() {
    const validKeys = new Set([HERO_KEY, ...GameState.party.map(getMemberKey)]);
    let ids = [];
    let savedLeader = null;
    try {
        const raw = localStorage.getItem(ACTIVE_PARTY_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) ids = parsed;
        }
        savedLeader = localStorage.getItem(LEADER_ID_KEY);
    } catch (e) { /* 壊れた保存データは無視 */ }
    const seen = new Set();
    let sanitized = ids.filter(id => {
        if (typeof id !== 'string' || seen.has(id) || !validKeys.has(id)) return false;
        seen.add(id); return true;
    }).slice(0, 4);
    if (sanitized.length === 0) {
        // 編成データが無い/壊れている場合は、所持キャラ全員を編成せず勇者1人だけを初期パーティーにする
        sanitized = [HERO_KEY];
    }
    GameState.activePartyIds = sanitized;
    GameState.leaderId = (savedLeader && sanitized.includes(savedLeader)) ? savedLeader : sanitized[0];
    saveActivePartyIds();
}
// パーティー編成画面から呼ぶ。最大4人・重複なし・未所持除外を保証してから保存し、フィールド追従を即時更新する。
// preferredLeaderIdを渡すとリーダーもそれへ切り替える(編成内に無ければ無視)。
// リーダーが編成から外れた場合は、残ったメンバーの先頭を新しいリーダーにする。
function setActiveParty(ids, preferredLeaderId) {
    const validKeys = new Set([HERO_KEY, ...GameState.party.map(getMemberKey)]);
    const seen = new Set();
    const sanitized = ids.filter(id => {
        if (seen.has(id) || !validKeys.has(id)) return false;
        seen.add(id); return true;
    }).slice(0, 4);
    if (sanitized.length === 0) return false; // パーティーが0人になる操作は無効
    GameState.activePartyIds = sanitized;
    if (preferredLeaderId && sanitized.includes(preferredLeaderId)) {
        GameState.leaderId = preferredLeaderId;
    } else if (!sanitized.includes(GameState.leaderId)) {
        GameState.leaderId = sanitized[0]; // リーダーが編成から外れた場合、先頭を新リーダーにする
    }
    saveActivePartyIds();
    return true;
}

// 仲間の攻撃力にLv強化分の補正(攻撃補正% + スキルLvに応じた上乗せ)を掛ける
function getAllyDamageMultiplier(ally) {
    const atkBonus = (ally.atkBonusPct || 0) / 100;
    const skillBonus = ((ally.skillLevel || 1) - 1) * 0.05;
    // 仕立工房のLv(重複強化と同じ ally.level を共有)も攻撃力へ反映する
    const levelBonus = ((ally.level || 1) - 1) * 0.08;
    return 1 + atkBonus + skillBonus + levelBonus;
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
    // フィールド拡張: ステージごとの敵HP/獲得G倍率(設定がなければ×1のまま)
    const fieldCfg = window.ZSAGA_FIELD_EXPANSION && window.ZSAGA_FIELD_EXPANSION.fields[GameState.currentFieldId];
    const hpMult = fieldCfg ? fieldCfg.enemyHpMultiplier : 1;
    const goldMult = fieldCfg ? fieldCfg.goldMultiplier : 1;
    const hp = Math.round(randInt(cfg.hpMin, cfg.hpMax) * hpMult);
    return {
        name: `${enemyStyle}の${base.name}`,
        enemyTypeKey: base.key, tier, rankLabel: cfg.rankLabel,
        isDragon: !!base.isBoss, // ボス個体=凱旋の儀トリガー（既存ロジック互換のためフィールド名は維持）
        job: '魔物', style: enemyStyle,
        moveSpeed: base.moveSpeed, attackRange: base.attackRange,
        originItem: GameState.avatar.name || '伝説の遺物',
        hp: hp, maxHp: hp, goldDrop: Math.round(base.goldDrop * goldMult),
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
let footstepTimer = 0; let footstepToggle = false; // 移動中の足音(交互に鳴らして左右の足を表現)
const GRASS_ZONES = [{ x: 220, y: 170, w: 100, h: 60 }, { x: 500, y: 200, w: 80, h: 100 }, { x: 350, y: 300, w: 80, h: 120 }, { x: 450, y: 470, w: 120, h: 50 }];
const SHOP_DOOR = { x: 550, y: 140, w: 20, h: 20 };
const SHOP_TRIGGER_ZONE = { x: SHOP_DOOR.x + 10 - 30, y: SHOP_DOOR.y + 10 - 40, w: 60, h: 80 };
// フィールド拡張: 背景上部に配置するボスゲート(未解放時は「あと○体」表示、達成後は接触でボス戦)
const BOSS_GATE_ZONE = { x: 370, y: 25, w: 60, h: 50 };
let bossGateMsgCooldown = 0;

// フィールド拡張の3ステージ用: 背景画像(800x600)に配置されている大きな物の当たり判定(円形)。
// 座標・半径はおおよその中心位置。プレイヤーはこれらの物をすり抜けられず、壁沿いにスライドして進む。
const FIELD_OBSTACLES = {
    azurlight: [ // 草原: 四隅の糸巻き・池・石ボタン
        { x: 45, y: 55, r: 40 }, { x: 755, y: 45, r: 40 }, { x: 48, y: 485, r: 40 }, { x: 745, y: 495, r: 40 },
        { x: 525, y: 95, r: 52 }, { x: 105, y: 405, r: 62 }, { x: 615, y: 465, r: 52 },
        { x: 160, y: 145, r: 26 }, { x: 95, y: 320, r: 24 }, { x: 330, y: 555, r: 24 }, { x: 755, y: 270, r: 22 }
    ],
    wardrobe_gloomwood: [ // 闇の森: 中央のクローゼット扉・糸巻き・木箱
        { x: 400, y: 55, r: 55 },
        { x: 150, y: 310, r: 24 }, { x: 605, y: 220, r: 22 }, { x: 615, y: 335, r: 22 },
        { x: 150, y: 270, r: 20 }, { x: 190, y: 510, r: 24 }, { x: 660, y: 510, r: 24 }
    ],
    laundry_abyss: [ // 水中: ドラム内側の左右の羽根・上下のハブ
        { x: 75, y: 220, r: 42 }, { x: 62, y: 320, r: 42 },
        { x: 725, y: 220, r: 42 }, { x: 738, y: 320, r: 42 },
        { x: 400, y: 70, r: 50 }, { x: 400, y: 555, r: 42 }
    ]
};
const PLAYER_COLLISION_RADIUS = 10;

// 指定座標が現在フィールドの障害物に重なるかどうか(広場滞在中・未定義フィールドは常に通れる)
function isBlockedByObstacle(x, y) {
    if (isInLaundryPlaza) return false;
    const obstacles = FIELD_OBSTACLES[GameState.currentFieldId];
    if (!obstacles) return false;
    for (const o of obstacles) {
        const dx = x - o.x, dy = y - o.y;
        const rr = o.r + PLAYER_COLLISION_RADIUS;
        if (dx * dx + dy * dy < rr * rr) return true;
    }
    return false;
}

function rectsOverlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

// 承認済みキャラのportrait(256x256透過PNG)をcanvasへ描く。戦闘画面だけで使い、フィールド追従では使わない。
// centerX/centerYは足元(下端中央)を基準にする(drawSpriteと同じ座標系)。画像が未読込ならfalseを返す。
function drawCharacterPortrait(ctxObj, follower, centerX, centerY, heightPx) {
    const img = follower.portraitPath ? PORTRAIT_IMAGES[follower.portraitPath] : null;
    if (!img || !img.complete || img.naturalWidth === 0) return false;
    const kx = follower.sprite ? follower.sprite.knockback.x : 0;
    const ky = follower.sprite ? follower.sprite.knockback.y : 0;
    const dh = heightPx;
    const dw = dh * (img.naturalWidth / img.naturalHeight); // object-fit:contain相当(縦横比を保って全身を切らない)
    const dx = centerX + kx - dw / 2;
    const dy = centerY + ky - dh;
    ctxObj.save();
    ctxObj.imageSmoothingEnabled = false;
    if (follower.sprite && follower.sprite.flashFrames > 0 && Math.floor(follower.sprite.flashFrames / 2) % 2 === 0) {
        // 被弾中の白点滅(既存のdrawSpriteと同じsource-atop手法)
        ctxObj.drawImage(img, dx, dy, dw, dh);
        ctxObj.globalCompositeOperation = 'source-atop';
        ctxObj.fillStyle = 'rgba(255,255,255,0.85)';
        ctxObj.fillRect(dx, dy, dw, dh);
        ctxObj.globalCompositeOperation = 'source-over';
    } else {
        ctxObj.drawImage(img, dx, dy, dw, dh);
    }
    ctxObj.restore();
    return true;
}

// パーティ追従者(仲間 or 元・敵)をスプライトで描画する共通ヘルパー
function drawFollowerSprite(follower, x, y, scale, isBattleContext) {
    // 戦闘不能(HP0)の仲間は半透明で描く(既存の描画分岐は内側でそのまま使う)
    const isKnockedOut = typeof follower.hp === 'number' && follower.hp <= 0;
    ctx.save();
    if (isKnockedOut) ctx.globalAlpha = 0.35;
    try {
    // アステアだけ専用ポートレート(先頭コマ)を使う。フィールド追従・戦闘画面の両方がここを通る。
    if (follower.name === ASTERIA_NAME && asteriaPortraitImg.complete && asteriaPortraitImg.naturalWidth > 0) {
        const cellW = asteriaPortraitImg.naturalWidth / ASTERIA_ATLAS_COLS;
        const cellH = asteriaPortraitImg.naturalHeight / ASTERIA_ATLAS_ROWS;
        const baseCell = follower.sprite ? follower.sprite.cell : 48;
        const dh = baseCell * scale; // 他の仲間と高さを揃え、アスペクト比は保って歪ませない
        const dw = dh * (cellW / cellH);
        // スキル演出中(asteriaSkillActive)だけ該当コマ・浮遊・発光を適用する。通常時は先頭コマ・元位置のまま。
        const isSkilling = asteriaSkillActive && asteriaSkillFrameIndex >= 0;
        const srcCol = isSkilling ? asteriaSkillFrameIndex : 0;
        const drawY = y - (isSkilling ? asteriaSkillFloatY : 0);
        ctx.save();
        if (isSkilling && asteriaSkillGlowColor) {
            const glowR = dw * 0.85;
            const grad = ctx.createRadialGradient(x, drawY - dh / 2, 4, x, drawY - dh / 2, glowR);
            grad.addColorStop(0, asteriaSkillGlowColor);
            grad.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.globalAlpha = 0.55;
            ctx.fillStyle = grad;
            ctx.beginPath(); ctx.arc(x, drawY - dh / 2, glowR, 0, Math.PI * 2); ctx.fill();
            ctx.globalAlpha = 1;
        }
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(asteriaPortraitImg, srcCol * cellW, 0, cellW, cellH, x - dw / 2, drawY - dh, dw, dh);
        ctx.restore();
        return;
    }
    // ルーナはスキル演出中だけ専用アトラス(2行目)のコマを表示する。通常表示(ally_archer.png)は変更しない。
    if (follower.name === LUNA_NAME && lunaSkillActive && lunaSkillFrameIndex >= 0 && asteriaPortraitImg.complete && asteriaPortraitImg.naturalWidth > 0) {
        const cellW = asteriaPortraitImg.naturalWidth / ASTERIA_ATLAS_COLS;
        const cellH = asteriaPortraitImg.naturalHeight / ASTERIA_ATLAS_ROWS;
        const baseCell = follower.sprite ? follower.sprite.cell : 48;
        const dh = baseCell * scale;
        const dw = dh * (cellW / cellH);
        ctx.save();
        if (lunaSkillGlowColor) {
            const glowR = dw * 0.8;
            const grad = ctx.createRadialGradient(x, y - dh / 2, 4, x, y - dh / 2, glowR);
            grad.addColorStop(0, lunaSkillGlowColor);
            grad.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.globalAlpha = 0.5;
            ctx.fillStyle = grad;
            ctx.beginPath(); ctx.arc(x, y - dh / 2, glowR, 0, Math.PI * 2); ctx.fill();
            ctx.globalAlpha = 1;
        }
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(asteriaPortraitImg, lunaSkillFrameIndex * cellW, LUNA_ATLAS_ROW * cellH, cellW, cellH, x - dw / 2, y - dh, dw, dh);
        ctx.restore();
        return;
    }
    // ゾンはスキル演出中だけ専用アトラス(3行目)のコマを表示する。通常表示(ally_warrior.png)は変更しない。
    if (follower.name === ZON_NAME && zonSkillActive && zonSkillFrameIndex >= 0 && asteriaPortraitImg.complete && asteriaPortraitImg.naturalWidth > 0) {
        const cellW = asteriaPortraitImg.naturalWidth / ASTERIA_ATLAS_COLS;
        const cellH = asteriaPortraitImg.naturalHeight / ASTERIA_ATLAS_ROWS;
        const baseCell = follower.sprite ? follower.sprite.cell : 48;
        const dh = baseCell * scale;
        const dw = dh * (cellW / cellH);
        const drawX = x + zonSkillLungeX; // 敵へ突進する横方向オフセット
        ctx.save();
        if (zonSkillGlowColor) {
            const glowR = dw * 0.8;
            const grad = ctx.createRadialGradient(drawX, y - dh / 2, 4, drawX, y - dh / 2, glowR);
            grad.addColorStop(0, zonSkillGlowColor);
            grad.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.globalAlpha = 0.5;
            ctx.fillStyle = grad;
            ctx.beginPath(); ctx.arc(drawX, y - dh / 2, glowR, 0, Math.PI * 2); ctx.fill();
            ctx.globalAlpha = 1;
        }
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(asteriaPortraitImg, zonSkillFrameIndex * cellW, ZON_ATLAS_ROW * cellH, cellW, cellH, drawX - dw / 2, y - dh, dw, dh);
        ctx.restore();
        return;
    }
    // 承認済みキャラは戦闘画面だけportraitPathを使う(フィールド追従は既存の歩行アニメーションのまま)。
    // ボタンやHP表示を隠さないよう、既存の歩行スプライトとほぼ同じ高さに収める。
    if (isBattleContext && follower.portraitPath) {
        const baseCell = follower.sprite ? follower.sprite.cell : 48;
        if (drawCharacterPortrait(ctx, follower, x, y, baseCell * scale)) return;
    }
    if (!follower.sprite) return;
    drawSprite(ctx, follower.sprite, x, y, { scale });
    } finally {
        ctx.restore();
    }
}

const particles = []; const dmgTexts = []; let screenShakeTimer = 0; let battleViewState = 'idle'; let slashEffectTimer = 0;

function spawnParticles(targetX, targetY) {
    for (let i = 0; i < 30; i++) particles.push({ x: player.x, y: player.y - 20, tx: targetX, ty: targetY, vx: (Math.random() - 0.5) * 15, vy: (Math.random() - 0.5) * 15 - 5, life: 60, color: ['#00e5ff', '#f1c40f', '#ffffff'][i % 3] });
}
function spawnMagicParticles(sourceX, sourceY, targetX, targetY, color) {
    for (let i = 0; i < 30; i++) particles.push({ x: sourceX, y: sourceY, tx: targetX, ty: targetY, vx: (Math.random() - 0.5) * 8, vy: (Math.random() - 0.5) * 8 - 5, life: 30, color: color });
}
function showDamage(x, y, amount) { dmgTexts.push({ x: x + Math.random() * 40 - 20, y: y - 20 + Math.random() * 20 - 10, text: `${amount}!`, life: 45, vy: -3, color: 'red' }); }
// 回復量の表示(ダメージ表示と同じ仕組みを使い、色だけ緑にして区別する)
function showHeal(x, y, amount) { dmgTexts.push({ x: x + Math.random() * 40 - 20, y: y - 20 + Math.random() * 20 - 10, text: `+${amount}`, life: 45, vy: -3, color: '#4fd06a' }); }

// ==========================================
// GAME LOOP & TRIGGERS
// ==========================================
let isBattling = false; let currentEnemy = null; let isMenuOpen = false; let isShopOpen = false; let isFashionShow = false;
// 戦闘中の主戦力交代: nullなら勇者、仲間を選んで交代するとその仲間が「たたかう」を行う主戦力になる。
let activeFighter = null;

// ==========================================
// 安全エリア「泡織りの洗濯広場」(差分追加)
// 既存の草原・闇の森・水中フィールド、field-expansion.js、戦闘・召喚・BGM・セーブ方式は変更しない。
// GameState.currentFieldIdは滞在中も元のフィールドのまま維持し、isInLaundryPlazaで
// 描画・移動判定・BGMだけを切り替える。広場内では敵の出現・召喚・伝説の継承通知は発生しない。
// ==========================================
let isInLaundryPlaza = false;
let laundryReturnField = null;
let laundryReturnX = 190, laundryReturnY = 190;
let laundryTubCooldown = 0;
let laundryHealEffectTimer = 0; // 回復演出(泡が広がる・布が光る)の残りフレーム数

const LAUNDRY_ENTRANCE_ZONE = { x: 40, y: 480, w: 70, h: 70 }; // 3フィールド共通の入口位置
const LAUNDRY_EXIT_ZONE = { x: 40, y: 480, w: 70, h: 70 };     // 広場からフィールドへ戻る出口
const LAUNDRY_TUB_ZONE = { x: 365, y: 265, w: 70, h: 70 };     // 中央の洗濯槽(回復)
const LAUNDRY_SPOT_ZONES = [
    { x: 120, y: 160, w: 55, h: 55 },
    { x: 625, y: 170, w: 55, h: 55 },
    { x: 380, y: 460, w: 55, h: 55 }
];
const LAUNDRY_DETERGENT_MAX = 5;
const LAUNDRY_SPOT_RESPAWN_WINS = 5;

// 広場へ入る: 元のフィールドと座標を記憶し、フィールドBGMをフェードアウトしてから広場BGMへ切り替える
function enterLaundryPlaza() {
    if (isBattling || isMenuOpen || isShopOpen || isFashionShow || isInLaundryPlaza) return;
    laundryReturnField = GameState.currentFieldId;
    laundryReturnX = player.x; laundryReturnY = player.y;
    isInLaundryPlaza = true;
    player.x = 160; player.y = 430; historyLog.length = 0; // 出口ゾーンから十分離れた位置に出現させる(入場直後の誤反応防止)
    playSound('select');
    BGMManager.playBGM('field:laundry_plaza', playLaundryPlazaBGM); // 広場BGMへ1回だけ切り替える(重複再生はしない)
    showTransientFieldMessage('💭 泡織りの洗濯広場に着いた…');
    FieldAmbientAnimation.start('laundry_plaza');
}

// 広場から出る: 記憶していたフィールド・座標へ戻し、そのフィールドのBGMへ戻す(二重再生はしない)
function exitLaundryPlaza() {
    if (!isInLaundryPlaza) return;
    isInLaundryPlaza = false;
    GameState.currentFieldId = laundryReturnField || GameState.currentFieldId;
    player.x = laundryReturnX; player.y = laundryReturnY; historyLog.length = 0;
    playSound('select');
    endBattleBGM(); // フェードアウト後、現在のフィールドBGMへ戻す共通処理を再利用(戦闘専用ではない)
    const fx = window.ZSAGA_FIELD_EXPANSION;
    const fname = (fx && fx.fields[GameState.currentFieldId] && fx.fields[GameState.currentFieldId].name) || 'フィールド';
    showTransientFieldMessage(`🗺️ ${fname}へ戻った`);
    FieldAmbientAnimation.start(GameState.currentFieldId);
}

// 洗濯槽:「仕立て直して休む」。洗剤1個 → 最初の1回は無料 → 40G の優先順で全回復する。
function tubRestAction() {
    const laundry = GameState.worldProgress.laundry;
    let costLabel;
    if (!laundry.freeRestUsed) {
        laundry.freeRestUsed = true;
        costLabel = '無料(はじめての利用)';
    } else if (laundry.detergent > 0) {
        laundry.detergent--;
        costLabel = '洗剤1個';
    } else if (GameState.gold >= 40) {
        updateGold(-40);
        costLabel = '40G';
    } else {
        showTransientFieldMessage('洗剤もGも足りず、仕立て直せない…');
        return;
    }
    GameState.avatar.hp = GameState.avatar.maxHp || 100;
    GameState.avatar.mp = GameState.avatar.maxMp || 50;
    updateHeroHUD();
    // 戦闘不能の仲間も含め、パーティ全員のHPを全回復する
    GameState.party.forEach(p => { if (typeof p.hp === 'number') p.hp = p.maxHp || getAllyMaxHp(p); });
    laundryHealEffectTimer = 45;
    spawnMagicParticles(400, 300, 400, 220, '#ffffff');
    spawnMagicParticles(400, 300, 400, 220, '#bfeeff');
    spawnMagicParticles(400, 300, 400, 220, '#ffd6ea');
    playSound('crystal');
    playHealFanfare();
    saveWorldProgress();
    showTransientFieldMessage(`✨ 仕立て直して休んだ！ 仲間も含め全員HP・MPが全回復(${costLabel})`);
}

// 洗剤の泡: 採取して洗剤+1(上限5)。1回採取すると、通算5勝するまで復活しない。
function gatherLaundrySpot(index) {
    const laundry = GameState.worldProgress.laundry;
    const winsAtGather = laundry.spotWinsAtGather[index];
    if (winsAtGather !== null) {
        const remain = LAUNDRY_SPOT_RESPAWN_WINS - (laundry.totalWins - winsAtGather);
        if (remain > 0) {
            showTransientFieldMessage(`泡が再び満ちるには、あと${remain}回の勝利が必要`);
            return;
        }
    }
    if (laundry.detergent >= LAUNDRY_DETERGENT_MAX) {
        showTransientFieldMessage(`洗剤は上限(${LAUNDRY_DETERGENT_MAX}個)まで持っている`);
        return;
    }
    laundry.detergent++;
    laundry.spotWinsAtGather[index] = laundry.totalWins;
    saveWorldProgress();
    playSound('select');
    const z = LAUNDRY_SPOT_ZONES[index];
    spawnMagicParticles(z.x + z.w / 2, z.y + z.h / 2, player.x, player.y, '#e8f9ff');
    showTransientFieldMessage(`🧼 洗剤を1個手に入れた！ (所持: ${laundry.detergent}個)`);
}

// 広場内の当たり判定。敵の出現・召喚・ボスゲート等はここでは一切呼ばない。
function checkLaundryPlazaTriggers() {
    if (laundryTubCooldown > 0) laundryTubCooldown--;
    const feet = GameState.avatar.sprite
        ? GameState.avatar.sprite.getFeetHitbox(player.x, player.y)
        : { x: player.x - 5, y: player.y - 3, w: 10, h: 6 };
    if (!(keys['ArrowUp'] || keys['w'])) return;
    if (rectsOverlap(feet, LAUNDRY_EXIT_ZONE)) { exitLaundryPlaza(); return; }
    if (rectsOverlap(feet, LAUNDRY_TUB_ZONE)) {
        if (laundryTubCooldown <= 0) { tubRestAction(); laundryTubCooldown = 60; }
        return;
    }
    for (let i = 0; i < LAUNDRY_SPOT_ZONES.length; i++) {
        if (rectsOverlap(feet, LAUNDRY_SPOT_ZONES[i])) { gatherLaundrySpot(i); return; }
    }
}

// 広場の背景描画: 巨大な洗濯槽の噴水、物干し竿、揺れる布、糸巻きの椅子、洗剤ボトル型の灯り、気泡
function drawLaundryPlaza(ctxObj) {
    const t = GameState.globalTime;
    const tubX = 400, tubY = 300;
    // 新しい探索背景(静止画。環境アニメーションはまだ追加しない)を優先して使う。
    if (LAUNDRY_PLAZA_BG_IMG && LAUNDRY_PLAZA_BG_IMG.complete && LAUNDRY_PLAZA_BG_IMG.naturalWidth > 0) {
        ctxObj.imageSmoothingEnabled = false;
        ctxObj.drawImage(LAUNDRY_PLAZA_BG_IMG, 0, 0, 800, 600);
    } else {
        // 新画像が未読込の場合は既存の手描き背景へフォールバックする(挙動は変更しない)
        const grad = ctxObj.createLinearGradient(0, 0, 0, 600);
        grad.addColorStop(0, '#2a3f52'); grad.addColorStop(1, '#16232f');
        ctxObj.fillStyle = grad; ctxObj.fillRect(0, 0, 800, 600);

        // 床タイル(荒めの16bitドット風の市松模様)
        ctxObj.fillStyle = '#324a5e';
        for (let y = 0; y < 600; y += 32) {
            for (let x = 0; x < 800; x += 32) {
                if ((x / 32 + y / 32) % 2 === 0) ctxObj.fillRect(x, y, 32, 32);
            }
        }

        // 物干し竿+揺れる布(左右)
        [[80, 300], [700, 300]].forEach(([px, py], gi) => {
            ctxObj.strokeStyle = '#8a8a8a'; ctxObj.lineWidth = 4;
            ctxObj.beginPath(); ctxObj.moveTo(px, py - 90); ctxObj.lineTo(px, py); ctxObj.stroke();
            ctxObj.beginPath(); ctxObj.moveTo(px - 40, py - 80); ctxObj.lineTo(px + 40, py - 80); ctxObj.stroke();
            const clothColors = ['#ff9ecb', '#9ee3ff', '#fff3a0'];
            for (let c = 0; c < 3; c++) {
                const sway = Math.sin(t * 0.03 + c + gi) * 6;
                ctxObj.fillStyle = laundryHealEffectTimer > 0 ? '#ffffff' : clothColors[c];
                ctxObj.fillRect(px - 34 + c * 24 + sway, py - 78, 18, 34);
            }
        });

        // 糸巻きの椅子(2脚)
        [[180, 480], [610, 480]].forEach(([sx, sy]) => {
            ctxObj.fillStyle = '#c98b4a'; ctxObj.fillRect(sx - 16, sy - 10, 32, 10);
            ctxObj.fillStyle = '#a5672c'; ctxObj.fillRect(sx - 12, sy, 6, 16); ctxObj.fillRect(sx + 6, sy, 6, 16);
            ctxObj.strokeStyle = '#e8c290'; ctxObj.lineWidth = 2;
            ctxObj.beginPath(); ctxObj.arc(sx, sy - 15, 8, 0, Math.PI * 2); ctxObj.stroke();
        });

        // 洗剤ボトル型の灯り(4隅)
        [[40, 470], [760, 470], [40, 130], [760, 130]].forEach(([bx, by]) => {
            const glow = 0.5 + Math.sin(t * 0.05) * 0.15;
            ctxObj.save(); ctxObj.globalAlpha = glow;
            ctxObj.fillStyle = '#bff2ff'; ctxObj.fillRect(bx - 8, by - 20, 16, 26); ctxObj.fillRect(bx - 5, by - 28, 10, 8);
            ctxObj.restore();
            ctxObj.fillStyle = '#3a5b6e'; ctxObj.fillRect(bx - 9, by - 22, 18, 4);
        });

        // 中央の洗濯槽(噴水)
        ctxObj.fillStyle = '#4a4a4a';
        ctxObj.beginPath(); ctxObj.ellipse(tubX, tubY + 45, 78, 26, 0, 0, Math.PI * 2); ctxObj.fill();
        ctxObj.fillStyle = '#7fd6ff';
        ctxObj.beginPath(); ctxObj.ellipse(tubX, tubY + 20, 62, 20, 0, 0, Math.PI * 2); ctxObj.fill();
        ctxObj.fillStyle = '#cfeeff';
        ctxObj.beginPath(); ctxObj.ellipse(tubX, tubY + 14, 62, 16, 0, 0, Math.PI * 2); ctxObj.fill();

        // 水面から浮かぶ気泡(白・水色・桃色)
        const bubbleColors = ['#ffffff', '#a9e6ff', '#ffc9e6'];
        for (let i = 0; i < 14; i++) {
            const bx = tubX + Math.sin(i * 1.7) * 55;
            const cyclePos = (t * 1.1 + i * 37) % 130;
            ctxObj.fillStyle = bubbleColors[i % 3];
            ctxObj.globalAlpha = Math.max(0, 1 - cyclePos / 130);
            ctxObj.beginPath(); ctxObj.arc(bx, tubY + 10 - cyclePos, 3 + (i % 3), 0, Math.PI * 2); ctxObj.fill();
            ctxObj.globalAlpha = 1;
        }
    }

    // 回復演出: 白い泡が広がる輪
    if (laundryHealEffectTimer > 0) {
        const p = 1 - laundryHealEffectTimer / 45;
        ctxObj.save();
        ctxObj.globalAlpha = 0.5 * (1 - p);
        ctxObj.strokeStyle = '#ffffff'; ctxObj.lineWidth = 4;
        ctxObj.beginPath(); ctxObj.arc(tubX, tubY + 15, 30 + p * 150, 0, Math.PI * 2); ctxObj.stroke();
        ctxObj.restore();
    }

    // 洗剤の泡(採取ポイント): 復活済みだけ光らせる
    const laundry = GameState.worldProgress.laundry;
    LAUNDRY_SPOT_ZONES.forEach((z, i) => {
        const winsAtGather = laundry.spotWinsAtGather[i];
        const available = winsAtGather === null || (laundry.totalWins - winsAtGather) >= LAUNDRY_SPOT_RESPAWN_WINS;
        const cx = z.x + z.w / 2, cy = z.y + z.h / 2;
        ctxObj.save();
        if (available) {
            const pulse = 12 + Math.sin(t * 0.08 + i) * 3;
            ctxObj.globalAlpha = 0.7; ctxObj.fillStyle = '#eafcff';
            ctxObj.beginPath(); ctxObj.arc(cx, cy, pulse, 0, Math.PI * 2); ctxObj.fill();
            ctxObj.globalAlpha = 1; ctxObj.strokeStyle = '#ffffff'; ctxObj.lineWidth = 2;
            ctxObj.beginPath(); ctxObj.arc(cx, cy, pulse + 4, 0, Math.PI * 2); ctxObj.stroke();
        } else {
            ctxObj.globalAlpha = 0.25; ctxObj.fillStyle = '#88a0ac';
            ctxObj.beginPath(); ctxObj.arc(cx, cy, 8, 0, Math.PI * 2); ctxObj.fill();
        }
        ctxObj.restore();
    });

    // 出口の目印
    ctxObj.save();
    ctxObj.globalAlpha = 0.6; ctxObj.strokeStyle = '#ffe066'; ctxObj.lineWidth = 3;
    ctxObj.strokeRect(LAUNDRY_EXIT_ZONE.x, LAUNDRY_EXIT_ZONE.y, LAUNDRY_EXIT_ZONE.w, LAUNDRY_EXIT_ZONE.h);
    ctxObj.restore();
}

// 回復の間(洗濯広場)専用BGM: ハープ・フルート・柔らかい弦の小編成、安心感のある穏やかなオリジナル曲
// 72 BPM。打楽器は使わず、水音や気泡は柔らかいベル・高音で表現する。
function playLaundryPlazaBGM() {
    const bpm = 72;
    const stepMs = 60000 / bpm / 2; // 8分音符
    const stepDur = stepMs / 1000;
    const harpArp = [261.63, 329.63, 392.00, 329.63, 261.63, 329.63, 392.00, 493.88]; // C4-E4-G4-B4系の穏やかなアルペジオ
    const fluteMotif = [0, 0, 0, 523.25, 0, 0, 493.88, 0];
    startSequencer(stepMs, (step) => {
        synthHarp(harpArp[step], stepDur * 1.6, 0.07, 0); // ハープの小さなアルペジオ
        if (step === 0) synthStrings(196.00, stepDur * 8, 0.035, 0); // 柔らかい弦の持続音(G3)
        const fl = fluteMotif[step];
        if (fl) synthFlute(fl, stepDur * 1.8, 0.05, 0);
        if (step % 4 === 2) synthBell(1318.51, 1.2, 0.03, 0); // 気泡のような小さなベル
    }, 8);
}

// 回復時だけ鳴らす短いファンファーレ(ベル+上昇する弦、ループとは別の単発)
function playHealFanfare() {
    synthBell(1046.50, 0.9, 0.08, 0);
    synthStrings(392.00, 0.5, 0.07, 0);
    synthStrings(523.25, 0.5, 0.07, 0.12);
    synthStrings(659.25, 0.6, 0.08, 0.24);
    synthBell(1318.51, 1.0, 0.07, 0.30);
}

function checkTriggers() {
    // 広場滞在中は専用の当たり判定だけを使う(敵の出現・召喚・ボスゲートはここでは発生しない)
    if (isInLaundryPlaza) { checkLaundryPlazaTriggers(); return; }

    // 当たり判定は足元だけの小さな帯（スプライト矩形全体では判定しない）
    const feet = GameState.avatar.sprite
        ? GameState.avatar.sprite.getFeetHitbox(player.x, player.y)
        : { x: player.x - 5, y: player.y - 3, w: 10, h: 6 };

    const fx = window.ZSAGA_FIELD_EXPANSION;
    const field = fx && fx.fields[GameState.currentFieldId];

    let onGrass;
    let encounterMult = 1;
    if (field) {
        // フィールド拡張の3背景は通路のない全面自由歩行地帯のため、フィールド全体をエンカウント対象にする
        onGrass = true;
        encounterMult = field.encounterMultiplier || 1;
    } else {
        onGrass = false;
        for (let z of GRASS_ZONES) if (rectsOverlap(feet, z)) onGrass = true;
    }
    if (onGrass && Math.random() < 0.0105 * encounterMult) startEncounter();

    if (rectsOverlap(feet, SHOP_TRIGGER_ZONE)) {
        if ((keys['ArrowUp'] || keys['w']) && !isShopOpen) openShop();
    }

    if (bossGateMsgCooldown > 0) bossGateMsgCooldown--;
    if (field && rectsOverlap(feet, BOSS_GATE_ZONE) && (keys['ArrowUp'] || keys['w'])) {
        checkBossGateTrigger(field);
    }

    // 泡織りの洗濯広場への入口(3フィールド共通の位置。草原は最初から、他は解放後のみそこに到達できる)
    if (field && rectsOverlap(feet, LAUNDRY_ENTRANCE_ZONE) && (keys['ArrowUp'] || keys['w'])) {
        enterLaundryPlaza();
    }
}

// フィールド拡張: ボスゲートへの接触判定。討伐数未達なら残り体数を表示し、達成済みならボス戦へ入る。
function checkBossGateTrigger(field) {
    if (isBattling || isMenuOpen || isShopOpen || isFashionShow) return;
    if (GameState.worldProgress.defeatedBosses[field.id]) {
        if (bossGateMsgCooldown <= 0) { showTransientFieldMessage(`✨ ${field.name}の守護者は既に眠りについている`); bossGateMsgCooldown = 90; }
        return;
    }
    const kills = GameState.worldProgress.killCounts[field.id] || 0;
    if (kills < field.killsToOpenBoss) {
        if (bossGateMsgCooldown <= 0) { showTransientFieldMessage(`あと${field.killsToOpenBoss - kills}体倒すとボスの気配が強まる`); bossGateMsgCooldown = 90; }
        return;
    }
    startFieldBossEncounter(field.id);
}

// フィールド拡張: 探索中メッセージ欄へ一時的な短文を表示する(数秒後に元へ戻す)
function showTransientFieldMessage(msg, ms) {
    const dialogText = document.getElementById('dialog-text');
    if (!dialogText) return;
    const prev = dialogText.textContent;
    dialogText.textContent = msg;
    setTimeout(() => { if (dialogText.textContent === msg) dialogText.textContent = prev; }, ms || 2500);
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
    if (isMenuOpen || isShopOpen || isFashionShow || isGameOver) return;

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
    // 現在パーティーにいる仲間(リーダー・追従とも、勇者を除く)の歩行アニメーションを更新する
    getActiveParty().forEach(p => {
        if (!p.sprite) return;
        p.sprite.setDirection(player.vx, player.vy);
        p.sprite.setAction(isMoving ? 'walk' : 'idle');
    });

    if (isMoving) {
        const nextX = Math.max(20, Math.min(canvas.width - 20, player.x + player.vx));
        const nextY = Math.max(30, Math.min(canvas.height - 20, player.y + player.vy));
        // ステージに配置された物(糸巻き・池・扉など)は軸ごとに当たり判定し、壁沿いにスライドできるようにする
        if (!isBlockedByObstacle(nextX, player.y)) player.x = nextX;
        if (!isBlockedByObstacle(player.x, nextY)) player.y = nextY;
        historyLog.unshift({ x: player.x, y: player.y }); if (historyLog.length > 500) historyLog.pop();
        checkTriggers();
        // 移動中だけ足音を鳴らす。走行時は速いテンポ、通常歩行時はゆっくりめのテンポ。
        footstepTimer--;
        if (footstepTimer <= 0) { playSound('footstep'); footstepTimer = hasTrendBuff ? 10 : 18; }
    } else {
        footstepTimer = 0; // 止まったら次に動き出した瞬間から足音を鳴らす
    }
}

function updateBattleEffects() {
    if (screenShakeTimer > 0) screenShakeTimer--; if (slashEffectTimer > 0) slashEffectTimer--;
    if (lunaImpactEffectTimer > 0) lunaImpactEffectTimer--;
    if (zonImpactEffectTimer > 0) zonImpactEffectTimer--;
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

// フィールド拡張: 現在地の背景を描く。画像が未読込の間は既存のdrawMap(草原)へフォールバックする。
// field-expansion.jsのdrawAnimatedFieldをそのまま使い、8px刻みのアニメーションを含めて委譲する。
function drawFieldBackground(ctxObj) {
    if (isInLaundryPlaza) { drawLaundryPlaza(ctxObj); return; } // 広場滞在中は専用背景を描く
    const fieldId = GameState.currentFieldId;
    // 新しい探索背景(静止画。環境アニメーションはまだ追加しない)を優先して使う。
    const newImg = NEW_FIELD_BG_IMAGES[fieldId];
    if (newImg && newImg.complete && newImg.naturalWidth > 0) {
        ctxObj.imageSmoothingEnabled = false;
        ctxObj.drawImage(newImg, 0, 0, 800, 600);
        return;
    }
    // 新画像が未読込/未対応フィールドの場合は既存の描画へフォールバックする(挙動は変更しない)
    const fx = window.ZSAGA_FIELD_EXPANSION;
    const img = FIELD_BG_IMAGES[fieldId];
    if (fx && img && img.complete && img.naturalWidth > 0) {
        fx.drawAnimatedField(ctxObj, img, fieldId, GameState.globalTime);
    } else {
        drawMap(ctxObj, GameState.globalTime);
    }
}

// フィールド拡張: 背景上部のボスゲート表示。未達成は薄く静かに、達成後は金色に強く光らせる。
function drawBossGateIndicator(ctxObj) {
    if (isInLaundryPlaza) return; // 広場滞在中はフィールドのボスゲートを重ねて表示しない
    const fx = window.ZSAGA_FIELD_EXPANSION;
    const field = fx && fx.fields[GameState.currentFieldId];
    if (!field) return;
    if (GameState.worldProgress.defeatedBosses[field.id]) return; // 撃破済みのフィールドはゲート表示不要
    const kills = GameState.worldProgress.killCounts[field.id] || 0;
    const ready = kills >= field.killsToOpenBoss;
    const pulse = 8 + Math.sin(GameState.globalTime * (ready ? 0.15 : 0.05)) * 4;
    ctxObj.save();
    ctxObj.strokeStyle = ready ? 'rgba(255,215,80,0.9)' : 'rgba(170,170,200,0.45)';
    ctxObj.lineWidth = 3;
    ctxObj.strokeRect(BOSS_GATE_ZONE.x - pulse / 2, BOSS_GATE_ZONE.y - pulse / 2, BOSS_GATE_ZONE.w + pulse, BOSS_GATE_ZONE.h + pulse);
    ctxObj.fillStyle = ready ? 'rgba(255,215,80,0.22)' : 'rgba(170,170,200,0.10)';
    ctxObj.fillRect(BOSS_GATE_ZONE.x, BOSS_GATE_ZONE.y, BOSS_GATE_ZONE.w, BOSS_GATE_ZONE.h);
    ctxObj.restore();
}

// 横視点の戦闘背景（フィールドマップとは別の専用ステージ）
function drawBattleArena(ctxObj) {
    // ステージ別の戦闘背景(静止画)。キャラクター・敵・HP・メッセージ・コマンドボタンより
    // 必ず先(=後ろのレイヤー)に描く。background-size:coverと同じ考え方で中央基準にトリミングする。
    const battleImg = BATTLE_BG_IMAGES[GameState.currentFieldId];
    if (battleImg && battleImg.complete && battleImg.naturalWidth > 0) {
        drawCoverImage(ctxObj, battleImg, 0, 0, 800, 600);
    } else {
        // 新背景が未読込/未対応フィールドの場合は既存の描画へフォールバックする(挙動は変更しない)
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
    }

    // 主人公側・敵側の立ち位置を示す影(新背景でも既存位置のまま維持する)
    ctxObj.fillStyle = 'rgba(0,0,0,0.45)';
    ctxObj.beginPath(); ctxObj.ellipse(200, 412, 46, 14, 0, 0, Math.PI * 2); ctxObj.fill();
    ctxObj.beginPath(); ctxObj.ellipse(600, 397, 56, 16, 0, 0, Math.PI * 2); ctxObj.fill();
}

function updateAllSprites() {
    if (GameState.avatar.sprite) GameState.avatar.sprite.update();
    getActiveParty().forEach(p => { if (p.sprite) p.sprite.update(); });
    if (currentEnemy && currentEnemy.sprite) currentEnemy.sprite.update();
    if (fsBoss && fsBoss.sprite) fsBoss.sprite.update();
}

function drawGame() {
    ctx.save();
    if (screenShakeTimer > 0) ctx.translate((Math.random() - 0.5) * 15, (Math.random() - 0.5) * 15);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (isBattling) {
        drawBattleArena(ctx);
    } else {
        drawFieldBackground(ctx);
    }
    if (!isFashionShow) FieldAmbientAnimation.draw(ctx, isBattling); // 背景の上・キャラクターと敵の下

    let hasTrendBuff = (GameState.avatar.style === currentTrend);
    let hx = player.x, hy = player.y;

    if (!isBattling) {
        // 仲間の隊列: 3人ごとに1列(ランク)を組み、同じ列の仲間は進行方向に対して横並びになる。
        // 人数が増えても縦一列に間延びせず、隊列を組んで綺麗についてくる。
        const RANK_SIZE = 3;
        const RANK_GAP = 16; // ランクごとの追従遅延(historyLogのステップ数)
        const SLOT_OFFSET = [-16, 16, 0]; // ランク内の並び順(左・右・中央)
        getFieldFollowers().forEach((follower, idx) => {
            const rank = Math.floor(idx / RANK_SIZE);
            const slot = idx % RANK_SIZE;
            const delay = (rank + 1) * RANK_GAP;
            const pos = historyLog[delay] || historyLog[historyLog.length - 1] || player;
            const aheadPos = historyLog[Math.max(0, delay - 5)] || historyLog[historyLog.length - 1] || player;
            let dx = aheadPos.x - pos.x, dy = aheadPos.y - pos.y;
            const len = Math.hypot(dx, dy);
            if (len < 0.01) { dx = 0; dy = 1; } else { dx /= len; dy /= len; } // 停止中は縦向き基準で横並びにする
            const perpX = -dy, perpY = dx; // 進行方向に対して垂直(左右)のベクトル
            const off = SLOT_OFFSET[slot] || 0;
            drawFollowerSprite(follower, pos.x + perpX * off, pos.y + perpY * off, 0.9);
        });
        drawBossGateIndicator(ctx);
    } else if (isBattling && currentEnemy) {
        // 交代中は前衛(activeFighter)を後衛グリッドから外し、代わりにベンチの勇者をそこに並べる
        const activeParty = getActiveParty();
        const benchList = activeFighter ? [GameState.avatar, ...activeParty.filter(p => p !== activeFighter)] : activeParty;
        benchList.forEach((follower, i) => {
            let px = 100 - (Math.floor(i / 3) * 30), py = 300 + ((i % 3) * 60);
            drawFollowerSprite(follower, px, py, 0.9, true);
            // 仲間のHPバー(数値を持つ仲間のみ)。戦闘不能は赤いバーで示す。
            if (typeof follower.hp === 'number' && typeof follower.maxHp === 'number') {
                const barW = 40, barX = px - barW / 2, barY = py - 46;
                const pct = Math.max(0, follower.hp / follower.maxHp);
                ctx.fillStyle = '#3a1010'; ctx.fillRect(barX, barY, barW, 5);
                ctx.fillStyle = follower.hp <= 0 ? '#803030' : (pct < 0.3 ? '#e05a3a' : '#4fd06a');
                ctx.fillRect(barX, barY, barW * pct, 5);
                ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 1; ctx.strokeRect(barX, barY, barW, 5);
            }
            // 属性の対応色を小さな丸で示す(承認済みキャラのみ)
            if (follower.style && STYLE_COLORS[follower.style]) {
                ctx.fillStyle = STYLE_COLORS[follower.style];
                ctx.beginPath(); ctx.arc(px + 22, py - 43, 4, 0, Math.PI * 2); ctx.fill();
                ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 1; ctx.stroke();
            }
        });
        // 踏み込み攻撃: 構え位置(200)から敵側(550)へ滑らかに前進する
        hx = 200 + 350 * attackLungeT; hy = 400;
    }

    // 前衛(戦闘中の交代仲間・通常時の勇者は既存仕様のまま。フィールドだけは編成中のリーダーを表示する)
    const fieldLeader = isBattling ? null : getFieldLeader();
    const frontFighter = (isBattling && activeFighter) ? activeFighter : (isBattling ? GameState.avatar : fieldLeader);
    if (!isFashionShow && frontFighter && frontFighter.sprite) {
        if (hasTrendBuff && !activeFighter) {
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
        if (isBattling && activeFighter) {
            // 交代中の前衛は仲間用の共通ヘルパーを使う(アステア専用ポートレート等の優先順位も後衛グリッドと揃う)
            drawFollowerSprite(activeFighter, hx, hy, 1.5, true);
        } else if (!isBattling && fieldLeader !== GameState.avatar) {
            // フィールドのリーダーが仲間の場合も、他の追従仲間と同じヘルパーで描く(専用ポートレート等の優先順位を揃える)
            drawFollowerSprite(fieldLeader, hx, hy, 1, false);
        } else {
            drawSprite(ctx, frontFighter.sprite, hx, hy, { scale: isBattling ? 1.5 : 1 });
        }
        // 交代中は前衛の仲間にも小さなHPバーを出す(後衛グリッドと同じ見た目)
        if (isBattling && activeFighter && typeof activeFighter.hp === 'number' && typeof activeFighter.maxHp === 'number') {
            const barW = 50, barX = hx - barW / 2, barY = hy - 95;
            const pct = Math.max(0, activeFighter.hp / activeFighter.maxHp);
            ctx.fillStyle = '#3a1010'; ctx.fillRect(barX, barY, barW, 6);
            ctx.fillStyle = activeFighter.hp <= 0 ? '#803030' : (pct < 0.3 ? '#e05a3a' : '#4fd06a');
            ctx.fillRect(barX, barY, barW * pct, 6);
            ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 1; ctx.strokeRect(barX, barY, barW, 6);
            // 属性の対応色を小さな丸で示す(承認済みキャラのみ)
            if (activeFighter.style && STYLE_COLORS[activeFighter.style]) {
                ctx.fillStyle = STYLE_COLORS[activeFighter.style];
                ctx.beginPath(); ctx.arc(barX + barW + 8, barY + 3, 4, 0, Math.PI * 2); ctx.fill();
                ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 1; ctx.stroke();
            }
        }
    }

    if (isBattling && currentEnemy && !isFashionShow && currentEnemy.sprite) {
        let ex = 600, ey = 380;
        ctx.globalAlpha = currentEnemy.hp <= 0 ? .3 : 1;
        // クローゼットロード/スピン・レヴィアタンだけ、既存のdragon代用画像を専用アトラスへ差し替える
        const fieldBossRow = FIELD_BOSS_ROW[currentEnemy.bossKey];
        if (fieldBossRow !== undefined && fieldBossActionsImg.complete && fieldBossActionsImg.naturalWidth > 0) {
            const cellW = fieldBossActionsImg.naturalWidth / FIELD_BOSS_ATLAS_COLS;
            const cellH = fieldBossActionsImg.naturalHeight / FIELD_BOSS_ATLAS_ROWS;
            const col = fieldBossFrameIndex >= 0 ? fieldBossFrameIndex : 0;
            const dh = 170; const dw = dh * (cellW / cellH);
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(fieldBossActionsImg, col * cellW, fieldBossRow * cellH, cellW, cellH, ex - dw / 2, ey - dh, dw, dh);
        } else {
            drawSprite(ctx, currentEnemy.sprite, ex, ey, { scale: 1, flipX: true });
        }
        ctx.globalAlpha = 1;
        // ボス攻撃予告(紫=クローゼットロード / 水色=スピン・レヴィアタン)
        if (fieldBossWarningTimer > 0 && fieldBossWarningColor) {
            ctx.save();
            const pulse = 40 + Math.sin(GameState.globalTime * 0.5) * 10;
            ctx.globalAlpha = 0.5;
            ctx.strokeStyle = fieldBossWarningColor; ctx.lineWidth = 5;
            ctx.beginPath(); ctx.arc(ex, ey - 60, pulse, 0, Math.PI * 2); ctx.stroke();
            ctx.restore();
        }
        if (slashEffectTimer > 0) { ctx.lineWidth = 4; ctx.strokeStyle = 'white'; ctx.beginPath(); ctx.moveTo(ex - 30, ey - 30); ctx.lineTo(ex + 30, ey + 30); ctx.stroke(); ctx.beginPath(); ctx.moveTo(ex + 30, ey - 30); ctx.lineTo(ex - 30, ey + 30); ctx.stroke(); }
        // ルーナのスキル命中演出: 黄色い円 + 布の目盛り状の目盛り線(敵の位置)
        if (lunaImpactEffectTimer > 0) {
            const r = 34;
            ctx.save();
            ctx.globalAlpha = Math.min(1, lunaImpactEffectTimer / 16);
            ctx.strokeStyle = '#ffe066'; ctx.lineWidth = 3;
            ctx.beginPath(); ctx.arc(ex, ey, r, 0, Math.PI * 2); ctx.stroke();
            for (let t = 0; t < 12; t++) {
                const ang = (t / 12) * Math.PI * 2;
                const inner = r - (t % 3 === 0 ? 10 : 5);
                ctx.beginPath();
                ctx.moveTo(ex + Math.cos(ang) * r, ey + Math.sin(ang) * r);
                ctx.lineTo(ex + Math.cos(ang) * inner, ey + Math.sin(ang) * inner);
                ctx.stroke();
            }
            ctx.restore();
        }
        // ゾンのスキル命中演出: 橙赤のX字裁断エフェクト(敵の位置)
        if (zonImpactEffectTimer > 0) {
            ctx.save();
            ctx.globalAlpha = Math.min(1, zonImpactEffectTimer / 14);
            ctx.strokeStyle = '#ff6b32'; ctx.lineWidth = 6; ctx.lineCap = 'round';
            ctx.beginPath(); ctx.moveTo(ex - 34, ey - 34); ctx.lineTo(ex + 34, ey + 34); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(ex + 34, ey - 34); ctx.lineTo(ex - 34, ey + 34); ctx.stroke();
            ctx.restore();
        }
    }

    ctx.globalCompositeOperation = 'lighter';
    particles.forEach(p => { ctx.fillStyle = p.color; ctx.fillRect(p.x, p.y, 6, 6); });
    ctx.globalCompositeOperation = 'source-over';

    ctx.font = "bold 32px DotGothic16"; ctx.shadowColor = 'white'; ctx.shadowBlur = 4;
    dmgTexts.forEach(dt => { ctx.fillStyle = dt.color || 'red'; ctx.fillText(dt.text, dt.x, dt.y); }); ctx.shadowBlur = 0;
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
            const hpKnown = typeof p.hp === 'number' && typeof p.maxHp === 'number';
            const isKO = hpKnown && p.hp <= 0;
            const hpLabel = hpKnown ? ` / HP:${Math.max(0, p.hp)}/${p.maxHp}${isKO ? ' 💤戦闘不能' : ''}` : '';
            if (p.job === '魔物') {
                li.textContent = `${p.name} (元・${p.originItem}の主) ${growthLabel}${hpLabel}`;
            } else {
                const visual = ALLY_VISUALS[p.job] || ALLY_VISUALS['裁断戦士'];
                const isAsteria = p.name === ASTERIA_NAME;
                const styleColor = STYLE_COLORS[p.style] || '#fff';
                const styleLabel = p.style ? `<span style="color:${styleColor};">${p.style}</span> / ` : '';
                // 承認済みキャラは本人portraitPathを表示する。アステアは専用ポートレート、それ以外は歩行スプライトの先頭コマ。
                const imgTag = isAsteria
                    ? `<span class="party-sprite is-asteria-portrait" style="--ally-sprite:url('${ASTERIA_PORTRAIT_PATH}')"></span>`
                    : (p.portraitPath
                        ? `<img class="character-portrait" src="${p.portraitPath}" alt="${p.name}">`
                        : `<span class="party-sprite" style="--ally-sprite:url('${visual.path}')"></span>`);
                li.className = `party-member-row ${visual.roleClass}${isKO ? ' is-knocked-out' : ''}`;
                li.innerHTML = `${imgTag}<span>✨${p.name}<small>${p.job || visual.label} / ${styleLabel}${p.rarity} / ${growthLabel}${hpLabel}</small></span>`;
            }
            list.appendChild(li);
        });
        renderTailorWorkshop();
    } else { b.classList.add('hidden'); }
}
document.getElementById('btn-open-menu').addEventListener('click', toggleMenu); document.getElementById('btn-close-menu').addEventListener('click', toggleMenu);

// ==========================================
// フィールド拡張: 仕立工房（Gで仲間を1レベル上げる。重複強化のLvと同じ数値を共有する）
// ==========================================
function renderTailorWorkshop() {
    const list = document.getElementById('tailor-list');
    if (!list) return;
    list.innerHTML = '';
    if (GameState.party.length === 0) { list.innerHTML = '<li>まだ仲間がいません。</li>'; return; }
    const fx = window.ZSAGA_FIELD_EXPANSION;
    GameState.party.forEach(ally => {
        const level = ally.level || 1;
        const cost = fx ? fx.levelUpCost(level) : (120 + level * 100);
        const li = document.createElement('li');
        li.style.display = 'flex'; li.style.justifyContent = 'space-between'; li.style.alignItems = 'center'; li.style.margin = '5px 0';
        const label = document.createElement('span');
        label.style.display = 'flex'; label.style.alignItems = 'center';
        const koLabel = ally.hp <= 0 ? '(戦闘不能)' : '';
        const thumbTag = ally.portraitPath ? `<img class="character-portrait-thumb" src="${ally.portraitPath}" alt="${ally.name}">` : '';
        label.innerHTML = `${thumbTag}<span>${ally.name} Lv.${level} HP:${Math.max(0, ally.hp || 0)}/${ally.maxHp || getAllyMaxHp(ally)}${koLabel}</span>`;
        const btn = document.createElement('button');
        btn.className = 'retro-btn small-btn';
        btn.textContent = `▶ Lvアップ (${cost}G)`;
        btn.disabled = GameState.gold < cost;
        btn.addEventListener('click', () => levelUpAllyWithGold(ally));
        li.appendChild(label); li.appendChild(btn);
        list.appendChild(li);
    });
}

function levelUpAllyWithGold(ally) {
    const fx = window.ZSAGA_FIELD_EXPANSION;
    const level = ally.level || 1;
    const cost = fx ? fx.levelUpCost(level) : (120 + level * 100);
    if (GameState.gold < cost) { playSound('hit'); return; }
    updateGold(-cost);
    ally.level = level + 1;
    ally.maxHp = getAllyMaxHp(ally);
    ally.hp = ally.maxHp; // Lvアップで全回復する(戦闘不能からも復帰する)
    playSound('fanfare');
    savePartyData();
    renderTailorWorkshop();
}

function openShopDirect() {
    if (isBattling || isMenuOpen || isShopOpen || isFashionShow) return;
    openShop();
}

// ==========================================
// フィールド拡張: 3ステージ間の移動
// ==========================================
function updateFieldDialogText() {
    const fx = window.ZSAGA_FIELD_EXPANSION;
    const field = fx && fx.fields[GameState.currentFieldId];
    const dialogText = document.getElementById('dialog-text');
    if (dialogText && field) dialogText.textContent = `${field.name}を探索中...`;
}

function changeField(nextFieldId) {
    const fx = window.ZSAGA_FIELD_EXPANSION;
    if (!fx) return;
    const field = fx.fields[nextFieldId];
    if (!field) return;
    const unlocked = !field.unlockAfter || GameState.worldProgress.defeatedBosses[field.unlockAfter];
    if (!unlocked) return;

    GameState.currentFieldId = nextFieldId; // 背景はdrawGame()がcurrentFieldIdを見て次フレームから自動的に切り替わる
    player.x = 400; player.y = 500; historyLog.length = 0;
    updateFieldDialogText();
    fx.switchFieldMusic(nextFieldId, audioBridge); // 背景更新の直後に必ず1回だけ呼ぶ
    FieldAmbientAnimation.start(nextFieldId); // 前ステージの環境アニメーションを止めて切り替える
}

function openFieldTravel() {
    if (isBattling || isMenuOpen || isShopOpen || isFashionShow || isInLaundryPlaza) return;
    playSound('select');
    const fx = window.ZSAGA_FIELD_EXPANSION;
    const list = document.getElementById('field-travel-list');
    if (!fx || !list) return;
    list.innerHTML = '';
    fx.fieldOrder.forEach(id => {
        const field = fx.fields[id];
        const unlocked = !field.unlockAfter || GameState.worldProgress.defeatedBosses[field.unlockAfter];
        const li = document.createElement('li');
        li.style.margin = '6px 0';
        if (unlocked) {
            const btn = document.createElement('button');
            btn.className = 'retro-btn cmd-btn';
            btn.textContent = (id === GameState.currentFieldId ? '📍 ' : '▶ ') + field.name;
            btn.disabled = (id === GameState.currentFieldId);
            btn.addEventListener('click', () => { changeField(id); closeFieldTravel(); });
            li.appendChild(btn);
        } else {
            li.innerHTML = `<span style="opacity:.5; padding:8px; display:inline-block;">🔒 ${field.name}（未解放）</span>`;
        }
        list.appendChild(li);
    });
    // 回復アイテムを集められる「泡織りの洗濯広場」へ、どのフィールドからでもいつでも行けるようにする
    const plazaLi = document.createElement('li');
    plazaLi.style.margin = '6px 0';
    const plazaBtn = document.createElement('button');
    plazaBtn.className = 'retro-btn cmd-btn';
    plazaBtn.textContent = '▶ 💭 泡織りの洗濯広場(回復)';
    plazaBtn.addEventListener('click', () => { closeFieldTravel(); enterLaundryPlaza(); });
    plazaLi.appendChild(plazaBtn);
    list.appendChild(plazaLi);
    document.getElementById('field-travel-panel').classList.remove('hidden');
}
function closeFieldTravel() { document.getElementById('field-travel-panel').classList.add('hidden'); }
document.getElementById('btn-field-travel').addEventListener('click', openFieldTravel);
document.getElementById('btn-field-travel-close').addEventListener('click', closeFieldTravel);
document.getElementById('btn-open-shop-direct').addEventListener('click', openShopDirect);

window.addEventListener('keydown', e => {
    // 冒険開始前(祭壇/タイトル画面)ではショートカットを無効にする。
    // 特にG(召喚)は画面が隠れたまま裏で召喚BGMだけが鳴り続けてしまうバグの原因だった。
    if (!gameLoopId) return;
    if (!isMenuOpen && !isShopOpen && !isFashionShow && !isGameOver) keys[e.key] = true;
    if (isGameOver) return; // ゲームオーバー・回復の間ではメニュー等のショートカットも無効にする
    if ((e.key === 'm' || e.key === 'M') && !isShopOpen && !isPartyFormationOpen) toggleMenu();
    if (e.key === 'g' || e.key === 'G') openShopDirect();
    if (e.key === 'f' || e.key === 'F') openFieldTravel();
    if (e.key === 'Escape') { if (isPartyFormationOpen) closePartyFormation(); else if (isMenuOpen) toggleMenu(); }
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
    GameState.currentFieldId = 'azurlight'; // 新しい旅は常にアズライト大陸から(未解放フィールドはメニューから移動できる)
    audioBridge.currentFieldMusicId = 'field-meadow';
    updateFieldDialogText();
    playFastEpicBGM(false); player.x = 190; player.y = 190; historyLog.length = 0; GameState.party = []; updateGold(0);
    loadPartyData(); // 保存済みの仲間(characterId・portraitPath・Lv等)があれば復元する
    loadActivePartyIds(); // 保存済みの冒険メンバー(最大4人)を復元する。無ければ所持キャラの先頭4人を初期値にする
    GameState.avatar.sprite = new SpriteAnimator('hero', GameState.avatar.job);
    currentTrend = ALL_STYLES[Math.floor(Math.random() * ALL_STYLES.length)]; // Init trend
    FieldAmbientAnimation.start('azurlight');
    if (!gameLoopId) loop();
}
document.getElementById('btn-start-adventure').addEventListener('click', startGame);
document.getElementById('btn-skip').addEventListener('click', () => {
    GameState.avatar = { name: '伝説の紋章・ゼアル', job: '勇者', style: '炎', color: '#ff4500', hp: 150, maxHp: 150, mp: 100, maxMp: 100, agi: 80, tension: 50 };
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

    // 結果(C/B/A/S/SS/SSS)は先に抽選しておき、盛り上がりの演出だけを段階的に見せる
    const rand = Math.random();
    const rankData = RARITY_TABLE.find(r => rand < r.cum);
    const pool = CHARACTER_POOL[rankData.key];
    const picked = pool[Math.floor(Math.random() * pool.length)];
    const itemStyle = picked.style; // characters.jsonの正式属性をそのまま使う(ランダムにしない)
    const job = picked.job; // ジョブも本人の正式ジョブを使う(ランク一律ではない)
    const allyVisual = ALLY_VISUALS[job] || ALLY_VISUALS['裁断戦士']; // 歩行スプライトは既存3種のフォールバックのまま(portraitは別途表示)
    const total = rankData.buildupMs;
    clearGachaRankClasses();
    summonArea.classList.add(`summon-rank-${rankData.key.toLowerCase()}`);
    BGMManager.playBGM('summon:' + rankData.key, () => playRankSummonBGM(rankData.key)); // レア度別オリジナルBGMを召喚中ずっと再生

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
            // アステアだけ専用ポートレートを使う(名前一致時のみ。他キャラの表示は変更しない)
            const isAsteria = picked.name === ASTERIA_NAME;
            // 承認済み23人は本人のportraitPathを大きく表示する(役職共通画像には置き換えない)
            const spritePath = isAsteria ? ASTERIA_PORTRAIT_PATH : (picked.portrait || allyVisual.path);
            const spriteClass = isAsteria ? ' is-asteria-portrait' : (picked.portrait ? ' is-portrait-image' : '');
            const styleColor = STYLE_COLORS[itemStyle] || '#fff';
            document.getElementById('summon-result').innerHTML = `
              <div class="gacha-reveal rank-${rankData.key.toLowerCase()} ${allyVisual.roleClass}">
                <div class="summon-portrait-stage">
                  <div class="summoned-ally big${spriteClass} ${silhouette ? 'silhouette' : ''}" style="--ally-sprite:url('${spritePath}')"></div>
                </div>
                <div class="gacha-card rarity-${rankData.key.toLowerCase()}">
                  <div class="gacha-rank">${rankData.title}</div>
                  <h3 style="color:${picked.color}; margin-top:4px;">${picked.name}</h3>
                  <small>${job} / 属性: <span style="color:${styleColor};">${itemStyle}</span></small>
                </div>
              </div>`;
            // 承認済みportrait本人画像のみ、キャラごとの透明余白差を吸収するサイズ補正をかける
            // (アステアの専用スプライトシート表示や、旧来のsprite-sheet表示は対象外・従来通り)
            if (spriteClass === ' is-portrait-image') {
                applyPortraitCrop(document.querySelector('.summoned-ally.big'), picked.id);
            }
        };

        const finishReveal = () => {
            const baseMsg = rankData.shakeLv >= 3
                ? `✨${rankData.title}★ 超激レアの魂が舞い降りた！ ★${rankData.title}✨`
                : '召喚成功！新しい仲間がパーティに加わった！';

            // 承認済み23人は本人専用のフィールド歩行素材(ally_field/characterId)を使う。
            // 役職が同じ他キャラの画像を使い回さないよう、job基準の'ally'ではなくcharacterId基準で紐付ける。
            const fieldSprite = (SPRITE_MANIFEST.ally_field && SPRITE_MANIFEST.ally_field.files[picked.id])
                ? new SpriteAnimator('ally_field', picked.id)
                : new SpriteAnimator('ally', job);
            const result = addOrEnhancePartyMember({ name: picked.name, job, rarity: rankData.key, style: itemStyle, color: picked.color, visualPath: allyVisual.path, characterId: picked.id, portraitPath: picked.portrait, isDragon: false, originItem: '時環召喚', sprite: fieldSprite });
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
            spawnRevealEffects(rankData.key); // ランクが上がるほど豪華になる光の粒・リング演出
            finishReveal();
            // finishReveal()がshopMsgを最終文言へ書き換えると.summon-areaの実高さが変わることがあるため、
            // 確定後の高さで召喚結果ポートレートのサイズを再計算し、全身が枠外へはみ出さないようにする。
            const finalAlly = document.querySelector('.summoned-ally.big.is-portrait-image');
            if (finalAlly && picked.portrait && picked.name !== ASTERIA_NAME) applyPortraitCrop(finalAlly, picked.id);
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
    updateItemButtonLabel();
}

// 「アイテム(回復)」ボタンに現在の回復薬所持数を表示する
function updateItemButtonLabel() {
    const btn = document.getElementById('btn-item');
    if (btn) btn.textContent = `▶ アイテム(回復薬×${(GameState.items && GameState.items.potion) || 0})`;
}

// 敵の反撃。A/Sランクほど発生しやすく、専用技（通常反撃の強化版）が出ることもある。
// 対象は勇者+生存している仲間からランダムに1体を選ぶ(既存の反撃確率・ダメージ計算式は変更しない)。
const ENEMY_SPECIAL_NAMES = { mid: '服飾呪縛', boss: '百鬼衣装絶' };

// 反撃の対象をランダムに1体選ぶ({type:'hero'} または {type:'ally', ally})
function pickCounterTarget() {
    const livingAllies = getActiveParty().filter(p => typeof p.hp !== 'number' || p.hp > 0);
    if (activeFighter) {
        // 交代中: 矢面に立つ仲間を勇者の代わりに抽選プールへ入れ、ベンチの勇者は他の仲間と同列で混ぜる
        const benchAllies = livingAllies.filter(a => a !== activeFighter);
        const pool = [{ type: 'ally', ally: activeFighter }, { type: 'hero' }, ...benchAllies.map(a => ({ type: 'ally', ally: a }))];
        return pool[Math.floor(Math.random() * pool.length)];
    }
    const pool = [{ type: 'hero' }, ...livingAllies.map(a => ({ type: 'ally', ally: a }))];
    return pool[Math.floor(Math.random() * pool.length)];
}

// 抽選済みの対象(勇者 or 仲間)へ、既に算出済みのdmgを1回だけ適用する共通処理
function applyCounterDamage(target, dmg, isSpecial) {
    if (target && target.type === 'ally') {
        const ally = target.ally;
        dmg = Math.round(dmg * getElementMultiplier(currentEnemy.style, ally.style)); // 属性の三すくみ補正(敵→仲間)
        const before = typeof ally.hp === 'number' ? ally.hp : (ally.maxHp || getAllyMaxHp(ally));
        ally.hp = Math.max(0, before - dmg);
        if (ally.sprite) ally.sprite.triggerHit({ hitStopFrames: isSpecial ? 10 : 5, flashFrames: isSpecial ? 24 : 12, knockbackPower: isSpecial ? 10 : 5, fromX: 1, fromY: 0, toX: 0, toY: 0.15 });
        screenShakeTimer = Math.max(screenShakeTimer, isSpecial ? 24 : 12);
        playSound(isSpecial ? 'magic' : 'hit');
        showDamage(100, 330, dmg);
        const koText = ally.hp <= 0 ? `<br>⚠️ ${ally.name}は戦闘不能になった！` : '';
        bMsg.innerHTML += (isSpecial
            ? `<br>⚔️【${currentEnemy.name}の専用技「${ENEMY_SPECIAL_NAMES[currentEnemy.tier]}」】反撃！ ${ally.name}は${dmg}ダメージを受けた！`
            : `<br>${currentEnemy.name}の反撃！ ${ally.name}は${dmg}ダメージを受けた！`) + koText;
    } else {
        dmg = Math.round(dmg * getElementMultiplier(currentEnemy.style, GameState.avatar.style)); // 属性の三すくみ補正(敵→勇者)
        GameState.avatar.hp = Math.max(0, GameState.avatar.hp - dmg); // 0まで減る(ゲームオーバー判定に使う)
        updateHeroHUD();
        if (GameState.avatar.sprite) GameState.avatar.sprite.triggerHit({ hitStopFrames: isSpecial ? 10 : 5, flashFrames: isSpecial ? 24 : 12, knockbackPower: isSpecial ? 10 : 5, fromX: 1, fromY: 0, toX: 0, toY: 0.15 });
        screenShakeTimer = Math.max(screenShakeTimer, isSpecial ? 24 : 12);
        playSound(isSpecial ? 'magic' : 'hit');
        showDamage(200, 380, dmg);
        bMsg.innerHTML += isSpecial
            ? `<br>⚔️【${currentEnemy.name}の専用技「${ENEMY_SPECIAL_NAMES[currentEnemy.tier]}」】反撃！ 勇者は${dmg}ダメージを受けた！`
            : `<br>${currentEnemy.name}の反撃！ 勇者は${dmg}ダメージを受けた！`;
    }
}

function enemyCounterAttack(onDone) {
    if (!currentEnemy || currentEnemy.hp <= 0) { if (onDone) onDone(); return; }
    const counterChance = currentEnemy.tier === 'boss' ? 0.45 : (currentEnemy.tier === 'mid' ? 0.30 : 0.15);
    if (Math.random() > counterChance) { if (onDone) onDone(); return; }

    // 中型/ボスは専用技として通常反撃より強いダメージを出すことがある
    const isSpecial = (currentEnemy.tier === 'mid' || currentEnemy.tier === 'boss') && Math.random() < 0.4;
    const tierMulti = currentEnemy.tier === 'boss' ? 2.0 : (currentEnemy.tier === 'mid' ? 1.4 : 1.0);
    // フィールド拡張: ステージごとの敵攻撃倍率(設定がなければ×1のまま)
    const fieldCfg = window.ZSAGA_FIELD_EXPANSION && window.ZSAGA_FIELD_EXPANSION.fields[GameState.currentFieldId];
    const fieldAtkMult = fieldCfg ? fieldCfg.enemyAttackMultiplier : 1;
    const dmg = Math.max(1, Math.round(randInt(15, 30) * tierMulti * fieldAtkMult * (isSpecial ? 1.6 : 1)));
    const target = pickCounterTarget();

    // 反撃後、勇者のHPが0、または仲間が全滅していたらゲームオーバーへ切り替える(通常のonDoneは呼ばない)
    const finish = () => {
        if (GameState.avatar.hp <= 0) { triggerGameOver('hero'); return; }
        if (isPartyWiped()) { triggerGameOver('party'); return; }
        if (onDone) onDone();
    };

    // クローゼットロード/スピン・レヴィアタン専用の攻撃演出(確率・ダメージ計算式はすべて上と同じものを使う)
    if (currentEnemy.bossKey === 'wardrobe_lord' || currentEnemy.bossKey === 'spin_leviathan') {
        playFieldBossAttackSequence(dmg, isSpecial, finish, target);
        return;
    }

    applyCounterDamage(target, dmg, isSpecial);
    setTimeout(finish, 700);
}

// ==========================================
// ゲームオーバー → 回復の間
// 発生条件: (1)勇者のHPが0になった、または (2)仲間が1人以上いる状態で全員戦闘不能になった(全滅)。
// 既存の戦闘終了処理(逃げる・勝利)には触れない。
// ==========================================
let isGameOver = false;

// 仲間が1人以上いて、かつ全員が戦闘不能(HP0)かどうか。仲間がいない場合はfalse(全滅とはみなさない)。
function isPartyWiped() {
    const trackedAllies = getActiveParty().filter(p => typeof p.hp === 'number');
    if (trackedAllies.length === 0) return false;
    return trackedAllies.every(p => p.hp <= 0);
}

function triggerGameOver(reason) {
    if (isGameOver) return; // 二重発動防止
    isGameOver = true;
    isBattling = false; currentEnemy = null; battleViewState = 'idle'; activeFighter = null;
    battleDlg.classList.add('hidden');
    stopBGM(); // 戦闘BGMを止める(重複再生防止。回復の間・復帰後の再生は別途行う)
    playSound('hit');
    const gameoverText = document.getElementById('gameover-text');
    if (gameoverText) {
        gameoverText.textContent = reason === 'party'
            ? '仲間は全滅した…勇者だけが立ち尽くす…'
            : '勇者は力尽きた…意識が遠のいていく…';
    }
    document.getElementById('game-screen').classList.replace('active', 'hidden');
    document.getElementById('gameover-screen').classList.replace('hidden', 'active');
    setTimeout(enterRecoveryRoom, 2200);
}

function enterRecoveryRoom() {
    document.getElementById('gameover-screen').classList.replace('active', 'hidden');
    // 全回復(戦闘不能だった仲間も含む)。フィールドの位置は元のまま変更しない。
    GameState.avatar.hp = GameState.avatar.maxHp || 100;
    GameState.avatar.mp = GameState.avatar.maxMp || 50;
    GameState.party.forEach(p => { if (typeof p.hp === 'number') p.hp = p.maxHp || getAllyMaxHp(p); });
    updateHeroHUD();
    document.getElementById('recovery-screen').classList.replace('hidden', 'active');
}

document.getElementById('btn-recovery-return').addEventListener('click', () => {
    document.getElementById('recovery-screen').classList.replace('active', 'hidden');
    document.getElementById('game-screen').classList.replace('hidden', 'active');
    isGameOver = false;
    playFastEpicBGM(false); // 元いたフィールド(currentFieldIdは変更していない)のBGMを再生する
});

function startEncounter() {
    if (isMenuOpen || isShopOpen || isFashionShow) return; isBattling = true; keys['ArrowUp'] = keys['ArrowDown'] = keys['ArrowLeft'] = keys['ArrowRight'] = false;
    BGMManager.stop(); playSound('noise'); document.getElementById('game-screen').classList.add('screen-shake'); document.getElementById('encounter-effect').classList.remove('hidden');
    attackLungeT = 0; attackLungeDir = 0; skillChargeTimer = 0;
    setTimeout(() => {
        document.getElementById('game-screen').classList.remove('screen-shake'); document.getElementById('encounter-effect').classList.add('hidden');
        currentEnemy = generateEnemy(); battleViewState = 'idle'; updateHPUI(); updateHeroHUD(); // 敵の属性は勇者と同じにせず、毎回ランダムにする
        // 戦闘中は主人公・仲間とも敵側(右)を向かせる
        if (GameState.avatar.sprite) { GameState.avatar.sprite.dir = DIR.RIGHT; GameState.avatar.sprite.setAction('idle'); }
        GameState.party.forEach(p => { if (p.sprite) { p.sprite.dir = DIR.RIGHT; p.sprite.setAction('idle'); } });
        bName.textContent = `⚠️ 【${currentEnemy.name}】[${currentEnemy.rankLabel}ランク] が現れた！`; bMsg.textContent = `「その力、まだ我には及ばぬな…」`;
        bActions.classList.remove('hidden'); document.getElementById('ally-select-panel').classList.add('hidden'); battleDlg.classList.remove('hidden');
        startBattleBGM(); // 敵の種類が確定してから戦闘BGMをBGMManager経由で1回だけ開始する
    }, 1200);
}

// フィールド拡張: フィールド固有ボス(百着を呑む呪衣装棚 / 無限袖のクローゼットロード / 大渦布竜スピン・レヴィアタン)を
// 通常のcurrentEnemy形状で組み立てる。既存のボス障壁(cfg=ENEMY_TIER_CONFIG.boss)をそのまま使い、
// 新しいバリア数式は追加しない。専用スプライトが無い2体は既存のボス級スプライト(dragon)を代用する。
const FIELD_BOSS_SPRITE_KEY = { treeent: 'treeent', wardrobe_lord: 'dragon', spin_leviathan: 'dragon' };
function buildFieldBoss(fieldId) {
    const fx = window.ZSAGA_FIELD_EXPANSION;
    const field = fx.fields[fieldId];
    const b = field.boss;
    const cfg = ENEMY_TIER_CONFIG.boss; // 既存の耐性・障壁閾値をそのまま流用する
    const spriteKey = FIELD_BOSS_SPRITE_KEY[b.key] || 'treeent';
    return {
        name: b.name, enemyTypeKey: spriteKey, tier: 'boss', rankLabel: b.rank,
        isDragon: true, job: '魔物', style: ALL_STYLES[Math.floor(Math.random() * ALL_STYLES.length)],
        moveSpeed: 1.0, attackRange: 90,
        originItem: GameState.avatar.name || '伝説の遺物',
        hp: b.hp, maxHp: b.hp, goldDrop: b.gold,
        normalResist: cfg.normalResist, barrierThresholdPct: cfg.barrierThresholdPct,
        barrierActive: false, barrierBroken: false,
        isFieldBoss: true, fieldId: fieldId, bossKey: b.key, // bossKey: 専用演出の判定用に追加(既存フィールドは変更しない)
        sprite: new SpriteAnimator('enemy', spriteKey)
    };
}

function startFieldBossEncounter(fieldId) {
    if (isMenuOpen || isShopOpen || isFashionShow || isBattling) return;
    isBattling = true; keys['ArrowUp'] = keys['ArrowDown'] = keys['ArrowLeft'] = keys['ArrowRight'] = false;
    BGMManager.stop(); playSound('noise'); document.getElementById('game-screen').classList.add('screen-shake'); document.getElementById('encounter-effect').classList.remove('hidden');
    attackLungeT = 0; attackLungeDir = 0; skillChargeTimer = 0;
    setTimeout(() => {
        document.getElementById('game-screen').classList.remove('screen-shake'); document.getElementById('encounter-effect').classList.add('hidden');
        currentEnemy = buildFieldBoss(fieldId); battleViewState = 'idle'; updateHPUI(); updateHeroHUD();
        if (GameState.avatar.sprite) { GameState.avatar.sprite.dir = DIR.RIGHT; GameState.avatar.sprite.setAction('idle'); }
        GameState.party.forEach(p => { if (p.sprite) { p.sprite.dir = DIR.RIGHT; p.sprite.setAction('idle'); } });
        bName.textContent = `⚠️ 【${currentEnemy.name}】[${currentEnemy.rankLabel}ランク] が現れた！`;
        bMsg.textContent = `フィールドの守護者が立ちはだかる…`;
        bActions.classList.remove('hidden'); document.getElementById('ally-select-panel').classList.add('hidden'); battleDlg.classList.remove('hidden');
        startBattleBGM();
    }, 1200);
}

function executeAttack(damageMulti = 1, attackTypeStr = '攻撃', isPiercing = false) {
    if (battleViewState !== 'idle' || !currentEnemy) return;
    // 交代中の仲間が反撃で戦闘不能になっていたら、自動的に勇者へ戻す(戦闘不能のまま行動させない)
    if (activeFighter && typeof activeFighter.hp === 'number' && activeFighter.hp <= 0) activeFighter = null;
    battleViewState = 'attacking'; bActions.classList.add('hidden'); playSound('slash');
    slashEffectTimer = 15; screenShakeTimer = 20;
    attackLungeDir = 1; setTimeout(() => { attackLungeDir = -1; }, 260); // 踏み込み攻撃: 前進してから構え位置へ戻る

    // 交代中は「たたかう」を今の主戦力(仲間)が行う。ベンチの勇者は攻撃しない。
    const attacker = activeFighter || GameState.avatar;
    if (attacker.sprite) attacker.sprite.setAction('attack'); // 攻撃中は移動を制限(既にbattleViewStateで制限済み)

    // Check Perfect Fit Connect(主戦力と同じ仲間は連携に含めない)
    let perfectFitAllies = getActiveParty().filter(p => p !== activeFighter && (p.style === attacker.style || p.style === currentEnemy.style) && (typeof p.hp !== 'number' || p.hp > 0));

    let rawDmg;
    if (activeFighter) {
        const base = getAllyAttackBase(activeFighter, 'select');
        rawDmg = Math.round(base * getAllyDamageMultiplier(activeFighter) * damageMulti);
    } else {
        const tensionScore = GameState.avatar.tension || 0;
        rawDmg = Math.floor((Math.random() * 30 + 50) * damageMulti + (tensionScore / 5));
    }
    const elemMulti = getElementMultiplier(attacker.style, currentEnemy.style); // 属性の三すくみ補正
    rawDmg = Math.round(rawDmg * elemMulti);
    // 主人公スキル「衣装奥義・シームブレイク」(isPiercing)のみ、A/Sランクの障壁を貫通できる
    const { dmg, blocked } = applyDamageToEnemy(currentEnemy, rawDmg, isPiercing);
    updateHPUI();
    if (currentEnemy.sprite) currentEnemy.sprite.triggerHit({ hitStopFrames: 6, flashFrames: 16, knockbackPower: 8, fromX: 0, fromY: 0, toX: 1, toY: -0.2 });

    const elemLabel = elemMulti > 1 ? '(効果は抜群だ！)' : (elemMulti < 1 ? '(効果はいまひとつ…)' : '');
    if (blocked) {
        showDamage(600, 360, 0);
        bMsg.textContent = `🛡️ 障壁が攻撃を阻んだ！ スキルか属性連携で破れ！`;
    } else {
        showDamage(600, 360, dmg);
        bMsg.textContent = `${attacker.name}の${attackTypeStr}！ ${dmg} のダメージ！${elemLabel}`;
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
            let base = getAllyAttackBase(ally, 'perfectfit');
            let dmg = Math.round(base * getAllyDamageMultiplier(ally) * getElementMultiplier(ally.style, currentEnemy.style)); // 属性の三すくみ補正
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
    const coOpParty = getActiveParty();
    if (coOpParty.length === 0) {
        bMsg.textContent = `【${currentEnemy.name}】は渋っている...`;
        enemyCounterAttack(() => { battleViewState = 'idle'; bActions.classList.remove('hidden'); });
        return;
    }
    bMsg.textContent = `仲間の総攻撃（オート追撃）！`;
    let totalFollowDmg = 0;
    let anyBlocked = false;

    function attackAlly(index) {
        if (!currentEnemy || currentEnemy.hp <= 0 || index >= coOpParty.length) {
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
        let ally = coOpParty[index];
        if (typeof ally.hp === 'number' && ally.hp <= 0) { attackAlly(index + 1); return; } // 戦闘不能の仲間は追撃に参加しない
        if (ally === activeFighter) { attackAlly(index + 1); return; } // 交代中の主戦力は既に自分の攻撃を終えているので追撃には参加しない
        let base = getAllyAttackBase(ally, 'coop');
        let rawDmg = Math.round(base * getAllyDamageMultiplier(ally) * getElementMultiplier(ally.style, currentEnemy.style)); // 属性の三すくみ補正
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
    const activePartyForSelect = getActiveParty();
    if (activePartyForSelect.length === 0 && !activeFighter) { bMsg.textContent = `一緒に戦う仲間がいない…`; return; }
    // 戦闘不能(HP0)の仲間は選択できない(総追撃からも別途除外する)
    const availableAllies = activePartyForSelect.filter(a => typeof a.hp !== 'number' || a.hp > 0);
    if (availableAllies.length === 0 && !activeFighter) { bMsg.textContent = `仲間は全員戦闘不能で動けない…`; return; }
    playSound('select');
    bActions.classList.add('hidden');
    allySelectPanel.innerHTML = '';

    // 交代中は、勇者と完全に交代して戻すボタンを一番上に出す
    if (activeFighter) {
        const heroBtn = document.createElement('button');
        heroBtn.className = 'retro-btn cmd-btn';
        heroBtn.textContent = `🔄 ${GameState.avatar.name}(勇者)と交代する`;
        heroBtn.addEventListener('click', () => swapActiveFighter('hero'));
        allySelectPanel.appendChild(heroBtn);
    }

    availableAllies.forEach(ally => {
        const hpLabel = typeof ally.hp === 'number' ? ` HP:${ally.hp}/${ally.maxHp}` : '';
        const btn = document.createElement('button');
        btn.className = 'retro-btn cmd-btn';
        btn.textContent = `▶ ${ally.name} [${ally.job} Lv.${ally.level || 1}${hpLabel}]`;
        btn.addEventListener('click', () => commandAllyAttack(ally));
        allySelectPanel.appendChild(btn);

        if (ally !== activeFighter) {
            const swapBtn = document.createElement('button');
            swapBtn.className = 'retro-btn cmd-btn';
            swapBtn.textContent = `🔄 ${ally.name}と交代する`;
            swapBtn.addEventListener('click', () => swapActiveFighter(ally));
            allySelectPanel.appendChild(swapBtn);
        }
    });
    const backBtn = document.createElement('button');
    backBtn.className = 'retro-btn cmd-btn';
    backBtn.textContent = '▶ 戻る';
    backBtn.addEventListener('click', closeAllySelect);
    allySelectPanel.appendChild(backBtn);
    allySelectPanel.classList.remove('hidden');
}

// 「仲間を選ぶ」から仲間と完全に交代する: 以後「たたかう」はその仲間が行い、敵の反撃もその仲間を優先して狙う。
// もう一度開いて勇者(または他の仲間)を選べば交代し直せる。交代自体も1ターン使う(敵の反撃を受けうる)。
function swapActiveFighter(target) {
    if (battleViewState !== 'idle' || !currentEnemy) return;
    const nextFighter = (target === 'hero') ? null : target;
    if (nextFighter === activeFighter) { allySelectPanel.classList.add('hidden'); bActions.classList.remove('hidden'); return; }
    allySelectPanel.classList.add('hidden');
    battleViewState = 'attacking';
    playSound('select');
    activeFighter = nextFighter;
    const activeName = activeFighter ? activeFighter.name : GameState.avatar.name;
    if (GameState.avatar.sprite) { GameState.avatar.sprite.dir = DIR.RIGHT; GameState.avatar.sprite.setAction('idle'); }
    GameState.party.forEach(p => { if (p.sprite) { p.sprite.dir = DIR.RIGHT; p.sprite.setAction('idle'); } });
    bMsg.textContent = `🔄 ${activeName}と交代した！`;
    setTimeout(() => {
        enemyCounterAttack(() => {
            battleViewState = 'idle';
            bActions.classList.remove('hidden');
        });
    }, 700);
}

function closeAllySelect() {
    playSound('select');
    allySelectPanel.classList.add('hidden');
    bActions.classList.remove('hidden');
}

function commandAllyAttack(ally) {
    if (battleViewState !== 'idle' || !currentEnemy) return;
    if (typeof ally.hp === 'number' && ally.hp <= 0) return; // 戦闘不能の仲間は行動できない
    allySelectPanel.classList.add('hidden');
    battleViewState = 'attacking';
    playSound('select');

    // 指名攻撃は総追撃(coOpPhase)より一撃が重い
    const base = getAllyAttackBase(ally, 'select');
    const rawDmg = Math.round(base * getAllyDamageMultiplier(ally) * getElementMultiplier(ally.style, currentEnemy.style)); // 属性の三すくみ補正

    // アステア専用スキル演出(名前一致時のみ。ダメージ計算式・MP消費・スキル効果自体は変更しない。
    // アステア以外は以下の従来処理をそのまま使う)
    if (ally.name === ASTERIA_NAME) {
        const isPiercingAsteria = (ally.style === GameState.avatar.style || ally.style === currentEnemy.style);
        playAsteriaSkillSequence(ally, rawDmg, isPiercingAsteria, () => {
            if (currentEnemy.hp <= 0) { setTimeout(() => triggerCirculation(), 800); return; }
            setTimeout(() => {
                enemyCounterAttack(() => {
                    battleViewState = 'idle';
                    bActions.classList.remove('hidden');
                });
            }, 900);
        });
        return;
    }

    // ルーナ専用スキル演出(名前一致時のみ。ダメージ計算式・MP消費・スキル効果自体は変更しない。
    // アステア・ルーナ以外は以下の従来処理をそのまま使う)
    if (ally.name === LUNA_NAME) {
        const isPiercingLuna = (ally.style === GameState.avatar.style || ally.style === currentEnemy.style);
        playLunaSkillSequence(ally, rawDmg, isPiercingLuna, () => {
            if (currentEnemy.hp <= 0) { setTimeout(() => triggerCirculation(), 800); return; }
            setTimeout(() => {
                enemyCounterAttack(() => {
                    battleViewState = 'idle';
                    bActions.classList.remove('hidden');
                });
            }, 900);
        });
        return;
    }

    // ゾン専用スキル演出(名前一致時のみ。ダメージ計算式・MP消費・スキル効果自体は変更しない。
    // アステア・ルーナ・ゾン以外は以下の従来処理をそのまま使う)
    if (ally.name === ZON_NAME) {
        const isPiercingZon = (ally.style === GameState.avatar.style || ally.style === currentEnemy.style);
        playZonSkillSequence(ally, rawDmg, isPiercingZon, () => {
            if (currentEnemy.hp <= 0) { setTimeout(() => triggerCirculation(), 800); return; }
            setTimeout(() => {
                enemyCounterAttack(() => {
                    battleViewState = 'idle';
                    bActions.classList.remove('hidden');
                });
            }, 900);
        });
        return;
    }

    if (ally.sprite) { ally.sprite.setAction('attack'); setTimeout(() => ally.sprite.setAction('idle'), 400); }
    if (ally.job === '染色術師') { playSound('magic'); spawnMagicParticles(200, 300, 600, 380, '#e85bb5'); screenShakeTimer = Math.max(screenShakeTimer, 14); }
    else if (ally.job === '採寸弓師') { playSound('slash'); }
    else { playSound('hit'); }

    // 主人公の属性と一致するか、敵の属性と一致していれば属性連携とみなし障壁も貫通できる
    const isPiercing = (ally.style === GameState.avatar.style || ally.style === currentEnemy.style);
    const { dmg, blocked } = applyDamageToEnemy(currentEnemy, rawDmg, isPiercing);
    updateHPUI();
    if (currentEnemy.sprite) currentEnemy.sprite.triggerHit({ hitStopFrames: 6, flashFrames: 16, knockbackPower: 8, fromX: 0, fromY: 0, toX: 1, toY: -0.2 });

    const elemLabel = getElementMultiplier(ally.style, currentEnemy.style) > 1 ? '(効果は抜群だ！)' : (getElementMultiplier(ally.style, currentEnemy.style) < 1 ? '(効果はいまひとつ…)' : '');
    if (blocked) {
        showDamage(600, 360, 0);
        bMsg.textContent = `🛡️ ${ally.name}の攻撃は障壁に阻まれた！ スキルか属性連携で破れ！`;
    } else {
        showDamage(600, 360, dmg);
        bMsg.textContent = (isPiercing ? `${ally.name}の属性一致攻撃！ ${dmg}のダメージ！` : `${ally.name}の攻撃！ ${dmg}のダメージ！`) + elemLabel;
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
    if (activeFighter) { playSound('hit'); bMsg.textContent = `衣装奥義は勇者専用！ 交代中は使えない…`; return; } // 仲間と交代中は勇者専用の奥義は使えない
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
// アイテム(回復): 所持している回復薬を実際に消費してHP・MPを回復する(攻撃はしない)
document.getElementById('btn-item').addEventListener('click', () => {
    if (battleViewState !== 'idle' || !currentEnemy) return;
    if (!GameState.items || (GameState.items.potion || 0) <= 0) {
        playSound('hit');
        bMsg.textContent = `回復薬を持っていない…`;
        return;
    }
    playSound('select');
    battleViewState = 'attacking'; bActions.classList.add('hidden');
    GameState.items.potion--;
    const healAmount = Math.max(1, Math.round((GameState.avatar.maxHp || 100) * 0.5));
    const mpHealAmount = Math.max(1, Math.round((GameState.avatar.maxMp || 50) * 0.5));
    GameState.avatar.hp = Math.min(GameState.avatar.maxHp || 100, GameState.avatar.hp + healAmount);
    GameState.avatar.mp = Math.min(GameState.avatar.maxMp || 50, GameState.avatar.mp + mpHealAmount);
    updateHeroHUD();
    playHealFanfare();
    spawnMagicParticles(200, 400, 200, 220, '#66ffaa');
    showHeal(200, 380, healAmount);
    bMsg.textContent = `回復薬を使った！ HPが${healAmount}・MPが${mpHealAmount}回復した！(残り${GameState.items.potion}個)`;

    setTimeout(() => {
        enemyCounterAttack(() => {
            battleViewState = 'idle';
            bActions.classList.remove('hidden');
        });
    }, 900);
});
document.getElementById('btn-run').addEventListener('click', () => {
    playSound('select'); battleDlg.classList.add('hidden'); isBattling = false; currentEnemy = null; activeFighter = null; endBattleBGM();
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

    // 勝利のたびに一定確率で回復薬を1個入手する(戦闘中の「アイテム(回復)」で実際に使える)
    const gotPotion = Math.random() < 0.3;
    if (gotPotion) { GameState.items.potion = (GameState.items.potion || 0) + 1; updateItemButtonLabel(); }

    // 泡織りの洗濯広場: 敵の種類を問わず、勝利のたびに通算勝利数を1つ加算する(洗剤の泡の復活条件に使う)
    GameState.worldProgress.laundry.totalWins++;
    saveWorldProgress();

    // フィールド拡張: フィールド固有ボス以外の撃破だけをボスゲート討伐数に加算する
    if (currentEnemy && !currentEnemy.isFieldBoss) {
        const fid = GameState.currentFieldId;
        GameState.worldProgress.killCounts[fid] = (GameState.worldProgress.killCounts[fid] || 0) + 1;
        saveWorldProgress();
    }

    setTimeout(() => { bMsg.textContent = `敵の魂がGへと変換された！ (獲得: ${reward} G)${gotPotion ? ' 💊回復薬を1個手に入れた！' : ''}`; playSound('crystal'); }, 1500);

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
            currentEnemy = null; isBattling = false; battleViewState = 'idle'; activeFighter = null;
            endBattleBGM();
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

        // フィールド拡張: フィールド固有ボスなら撃破フラグを保存し、次のフィールドを解放する
        let unlockMsg = null;
        if (fsBoss.isFieldBoss) {
            GameState.worldProgress.defeatedBosses[fsBoss.fieldId] = true;
            saveWorldProgress();
            const fx = window.ZSAGA_FIELD_EXPANSION;
            const nextField = fx && Object.values(fx.fields).find(f => f.unlockAfter === fsBoss.fieldId);
            if (nextField) unlockMsg = `✨ ${nextField.name} が解放された！ (+${bonus} G)`;
        }

        const dialogText = document.getElementById('dialog-text');
        if (dialogText) {
            const prevText = dialogText.textContent;
            dialogText.textContent = unlockMsg || `💰 凱旋の儀が終わり、ボスの魂がGに変換された！ (+${bonus} G)`;
            setTimeout(() => { dialogText.textContent = prevText; }, 4000);
        }
        currentEnemy = null; isBattling = false; battleViewState = 'idle'; activeFighter = null;
        endBattleBGM();
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
    if (!isInLaundryPlaza) showLegacyReview(listing); // 広場滞在中は通知を表示しない(状態はここで保存済みなので後で確認できる)
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

// ==========================================
// パーティー編成画面
// フィールド・戦闘へ実際に同行する仲間(最大4人)を、所持キャラ全員(GameState.party)の中から選ぶUI。
// 見た目は既存の紺色HUD・シアン二重枠・金色アクセントに合わせ、文字は全てbodyの既存ドットフォント(DotGothic16)を
// そのまま継承する(新規フォント読込・画像化テキストなし)。
// ==========================================
let isPartyFormationOpen = false;
let pfSelectedKey = null; // 現在detail欄に表示中のキャラのキー(getMemberKeyの戻り値)
let pfSwapPendingKey = null; // 4人編成済みの状態で新しいキャラを追加しようとした時、交換先の枠選択待ちのキー
let pfRankFilter = 'ALL';
let pfStyleFilter = 'ALL';
let pfSortMode = 'rank';
const PF_RANK_ORDER = RARITY_TABLE.map(r => r.key); // ['SSS','SS','S','A','B','C'] (既存のガチャ確率テーブルの並びをそのまま使う)

// characterIdから、表示専用の役職・武器を仕入れる(CHARACTER_ROSTERは表示専用の参照元。既存の所持データ自体は書き換えない)
function getPfCharacterRef(p) {
    const def = p.characterId ? CHARACTER_ROSTER.find(c => c.id === p.characterId) : null;
    return { job: (def && def.job) || p.job || '', weapon: def ? def.weapon : null };
}

// パーティー編成の対象となる所持キャラ一覧(魔物の仲間は現状この画面の表示モデル対象外。既存データは変更しない)
function getPfRosterMembers() {
    return GameState.party.filter(p => p.job !== '魔物');
}
// 勇者を含めた表示用の一覧(勇者は常に先頭)。GameState.party自体には勇者を追加しない。
function getPfDisplayList() {
    return [GameState.avatar, ...getPfRosterMembers()];
}
function pfIsHero(p) { return p === GameState.avatar; }

function openPartyFormation() {
    if (isBattling || isShopOpen || isFashionShow) return;
    playSound('select');
    document.getElementById('status-menu').classList.add('hidden');
    document.getElementById('party-formation-screen').classList.remove('hidden');
    isPartyFormationOpen = true;
    pfSelectedKey = null;
    pfSwapPendingKey = null;
    renderPartyFormationScreen();
}
function closePartyFormation() {
    playSound('select');
    document.getElementById('party-formation-screen').classList.add('hidden');
    isPartyFormationOpen = false;
    if (isMenuOpen) document.getElementById('status-menu').classList.remove('hidden');
}
document.getElementById('btn-open-party-formation').addEventListener('click', openPartyFormation);
document.getElementById('btn-close-party-formation').addEventListener('click', closePartyFormation);

function renderPartyFormationScreen() {
    renderPfSlots();
    renderPfRoster();
    renderPfDetail();
}

function pfPortraitBg(p) {
    if (!p) return '';
    if (pfIsHero(p)) {
        // 勇者は専用portraitを持たないため、既存の.party-sprite等と同じく歩行スプライトシートの先頭コマを使う
        const files = (typeof SPRITE_MANIFEST !== 'undefined' && SPRITE_MANIFEST.hero) ? SPRITE_MANIFEST.hero.files : null;
        const path = files ? (files[p.job] || files['勇者']) : '';
        return path ? `background-image:url('${path}'); background-size:2000% 400%; background-position:0 0;` : '';
    }
    if (p.name === ASTERIA_NAME) return `background-image:url('${ASTERIA_PORTRAIT_PATH}'); background-size:600% 300%; background-position:0 0;`;
    if (!p.portraitPath) return '';
    return `background-image:url('${p.portraitPath}'); background-size:contain; background-position:center;`;
}

function renderPfSlots() {
    const wrap = document.getElementById('pf-slots');
    const activeParty = getActivePartyResolved();
    document.getElementById('pf-slot-count').textContent = `${activeParty.length}/4`;
    wrap.innerHTML = '';
    for (let i = 0; i < 4; i++) {
        const member = activeParty[i];
        const slot = document.createElement('div');
        const key = member ? getMemberKey(member) : null;
        const isLeader = member && key === GameState.leaderId;
        slot.className = 'pf-slot' + (member ? ' filled' : '') + (isLeader ? ' is-leader' : '') + (key && key === pfSelectedKey ? ' is-selected' : '');
        if (member) {
            const portraitStyle = pfPortraitBg(member);
            const rankBadge = pfIsHero(member) ? '主人公' : (member.rarity || '');
            slot.innerHTML = `
              <span class="pf-slot-num">${i + 1}</span>
              ${isLeader ? '<span class="pf-slot-leader-badge">👑リーダー</span>' : ''}
              ${rankBadge ? `<span class="pf-slot-rank-badge">${rankBadge}</span>` : ''}
              <div class="pf-slot-portrait" style="${portraitStyle}"></div>
              <div class="pf-slot-name">${member.name}</div>`;
            slot.addEventListener('click', () => {
                pfSelectedKey = key;
                pfSwapPendingKey = null;
                renderPfSlots(); renderPfRoster(); renderPfDetail();
            });
        } else {
            slot.innerHTML = `<span class="pf-slot-num">${i + 1}</span><div class="pf-slot-empty-label">＋<br>仲間を選ぶ</div>`;
            slot.addEventListener('click', () => {
                if (pfSelectedKey && !GameState.activePartyIds.includes(pfSelectedKey)) {
                    pfFormMember(pfSelectedKey);
                }
            });
        }
        wrap.appendChild(slot);
    }
}

function renderPfRoster() {
    const grid = document.getElementById('pf-roster-grid');
    const activeKeys = GameState.activePartyIds;
    let members = getPfDisplayList();
    // ランクフィルターは勇者(ランク概念なし)には適用しない → ALL以外を選んだ時だけ勇者を除外する
    if (pfRankFilter !== 'ALL') members = members.filter(p => !pfIsHero(p) && p.rarity === pfRankFilter);
    if (pfStyleFilter !== 'ALL') members = members.filter(p => p.style === pfStyleFilter);
    const heroEntry = members.find(pfIsHero);
    let rest = members.filter(p => !pfIsHero(p)).sort((a, b) => {
        if (pfSortMode === 'level') return (b.level || 1) - (a.level || 1);
        if (pfSortMode === 'name') return (a.name || '').localeCompare(b.name || '', 'ja');
        return PF_RANK_ORDER.indexOf(a.rarity) - PF_RANK_ORDER.indexOf(b.rarity);
    });
    members = heroEntry ? [heroEntry, ...rest] : rest; // 勇者は常に先頭に固定表示する
    grid.innerHTML = '';
    if (members.length === 0) {
        grid.innerHTML = '<div class="pf-empty-roster">条件に合う仲間がいません</div>';
        return;
    }
    members.forEach(p => {
        const key = getMemberKey(p);
        const portraitStyle = pfPortraitBg(p);
        const rankClass = pfIsHero(p) ? 'hero' : (p.rarity || 'c').toLowerCase();
        const rankLabel = pfIsHero(p) ? '主人公' : (p.rarity || '');
        const card = document.createElement('div');
        card.className = `pf-roster-card pf-rarity-${rankClass}${key === pfSelectedKey ? ' is-selected' : ''}`;
        card.innerHTML = `
          <span class="pf-card-rank">${rankLabel}</span>
          ${activeKeys.includes(key) ? '<span class="pf-card-check">✓</span>' : ''}
          ${p.isNew ? '<span class="pf-card-new">NEW</span>' : ''}
          <div class="pf-card-portrait" style="${portraitStyle}"></div>
          <div class="pf-card-name">${p.name}</div>`;
        card.addEventListener('click', () => {
            pfSelectedKey = key;
            pfSwapPendingKey = null;
            if (p.isNew) { p.isNew = false; savePartyData(); } // 詳細を開いたら既読にする
            renderPfSlots(); renderPfRoster(); renderPfDetail();
        });
        grid.appendChild(card);
    });
}

function renderPfDetail() {
    const col = document.getElementById('pf-detail-col');
    if (!pfSelectedKey) { col.innerHTML = '<div class="pf-detail-empty">キャラをタップすると詳細を確認できます</div>'; return; }
    const member = resolvePartyMember(pfSelectedKey);
    if (!member) { pfSelectedKey = null; col.innerHTML = '<div class="pf-detail-empty">キャラをタップすると詳細を確認できます</div>'; return; }
    const isHero = pfIsHero(member);

    const portraitStyle = pfPortraitBg(member);
    const styleColor = STYLE_COLORS[member.style] || '#fff';
    const activeParty = getActivePartyResolved();
    const isActive = GameState.activePartyIds.includes(pfSelectedKey);
    const isLeader = pfSelectedKey === GameState.leaderId;

    let html = `<div class="pf-detail-portrait" style="${portraitStyle}"></div>`;
    if (isHero) {
        const hpKnown = typeof member.hp === 'number' && typeof member.maxHp === 'number';
        const hpPct = hpKnown ? Math.max(0, Math.min(100, (member.hp / member.maxHp) * 100)) : 100;
        html += `
          <div class="pf-detail-rank">主人公</div>
          <div class="pf-detail-name">✨${member.name}</div>
          <div class="pf-detail-row">${member.job || ''}</div>
          <div class="pf-detail-row"><span style="color:${styleColor};">${member.style || ''}属性</span></div>`;
        if (hpKnown) {
            html += `<div class="pf-detail-row">HP ${Math.max(0, member.hp)}/${member.maxHp}</div>
              <div class="pf-detail-hpbar-bg"><div class="pf-detail-hpbar-fill" style="width:${hpPct}%; background:${member.hp <= 0 ? '#803030' : (hpPct < 30 ? '#e05a3a' : '#4fd06a')};"></div></div>`;
        }
        if (typeof member.mp === 'number' && typeof member.maxMp === 'number') {
            html += `<div class="pf-detail-row">MP ${member.mp}/${member.maxMp}</div>`;
        }
        if (typeof member.agi === 'number') html += `<div class="pf-detail-row">俊敏(AGI) ${member.agi}</div>`;
    } else {
        const ref = getPfCharacterRef(member);
        const hpKnown = typeof member.hp === 'number' && typeof member.maxHp === 'number';
        const hpPct = hpKnown ? Math.max(0, Math.min(100, (member.hp / member.maxHp) * 100)) : 100;
        const atk = Math.round(getAllyAttackBase(member, 'select') * getAllyDamageMultiplier(member));
        html += `
          <div class="pf-detail-rank">${member.rarity || ''}</div>
          <div class="pf-detail-name">✨${member.name}</div>
          <div class="pf-detail-row">${ref.job || ''}${ref.weapon ? ` / ${ref.weapon}` : ''}</div>
          <div class="pf-detail-row"><span style="color:${styleColor};">${member.style || ''}属性</span> ／ Lv.${member.level || 1}</div>`;
        if (hpKnown) {
            html += `<div class="pf-detail-row">HP ${Math.max(0, member.hp)}/${member.maxHp}</div>
              <div class="pf-detail-hpbar-bg"><div class="pf-detail-hpbar-fill" style="width:${hpPct}%; background:${member.hp <= 0 ? '#803030' : (hpPct < 30 ? '#e05a3a' : '#4fd06a')};"></div></div>`;
        }
        html += `<div class="pf-detail-row">攻撃力の目安 ${atk}</div>`;
        if (member.duplicateCount) {
            html += `<div class="pf-detail-row">継承${member.duplicateCount}回 / 攻撃+${member.atkBonusPct || 0}% / スキルLv${member.skillLevel || 1}</div>`;
        } else {
            html += `<div class="pf-detail-row">スキルLv${member.skillLevel || 1}</div>`;
        }
    }

    html += '<div class="pf-detail-actions">';
    if (isActive) {
        if (!isLeader) html += `<button id="pf-btn-leader" class="retro-btn small-btn">リーダーにする</button>`;
        const disabled = activeParty.length <= 1 ? 'disabled' : '';
        html += `<button id="pf-btn-remove" class="retro-btn small-btn" ${disabled}>外す</button>`;
        if (activeParty.length <= 1) html += `<div class="pf-swap-hint">※最低1人は必要です</div>`;
    } else if (pfSwapPendingKey === pfSelectedKey) {
        html += `<div class="pf-swap-hint">交換する枠を選んでください</div><div class="pf-swap-grid">`;
        activeParty.forEach((m, i) => { html += `<button data-slot="${i}">${i + 1}: ${m.name}</button>`; });
        html += `</div><button id="pf-btn-cancel-swap" class="retro-btn small-btn">キャンセル</button>`;
    } else {
        html += `<button id="pf-btn-form" class="retro-btn small-btn">編成する</button>`;
    }
    html += '</div>';
    col.innerHTML = html;

    const leaderBtn = document.getElementById('pf-btn-leader');
    if (leaderBtn) leaderBtn.addEventListener('click', () => pfSetLeader(pfSelectedKey));
    const removeBtn = document.getElementById('pf-btn-remove');
    if (removeBtn) removeBtn.addEventListener('click', () => pfRemoveMember(pfSelectedKey));
    const formBtn = document.getElementById('pf-btn-form');
    if (formBtn) formBtn.addEventListener('click', () => pfFormMember(pfSelectedKey));
    const cancelBtn = document.getElementById('pf-btn-cancel-swap');
    if (cancelBtn) cancelBtn.addEventListener('click', () => { pfSwapPendingKey = null; renderPfDetail(); });
    col.querySelectorAll('.pf-swap-grid button[data-slot]').forEach(btn => {
        btn.addEventListener('click', () => pfSwapSlot(parseInt(btn.dataset.slot, 10), pfSwapPendingKey));
    });
}

// 空き枠がある場合はそのまま追加、4人編成済みの場合は交換先の枠選択(pfSwapPendingKey)へ切り替える
function pfFormMember(key) {
    const current = GameState.activePartyIds.slice();
    if (current.includes(key)) return;
    if (current.length >= 4) {
        pfSwapPendingKey = key;
        renderPfDetail();
        return;
    }
    current.push(key);
    setActiveParty(current);
    playSound('select');
    pfSwapPendingKey = null;
    renderPartyFormationScreen();
}
function pfRemoveMember(key) {
    const current = GameState.activePartyIds.filter(id => id !== key);
    if (current.length === 0) return; // 最低1人は残す
    setActiveParty(current);
    playSound('select');
    renderPartyFormationScreen();
}
function pfSwapSlot(slotIndex, newKey) {
    const current = GameState.activePartyIds.slice();
    if (slotIndex < 0 || slotIndex >= current.length) return;
    current[slotIndex] = newKey;
    setActiveParty(current);
    playSound('select');
    pfSwapPendingKey = null;
    pfSelectedKey = newKey;
    renderPartyFormationScreen();
}
// 編成中のキャラから自由にリーダー(フィールドで操作するキャラ)を選ぶ
function pfSetLeader(key) {
    if (!GameState.activePartyIds.includes(key)) return;
    GameState.leaderId = key;
    saveActivePartyIds();
    playSound('select');
    renderPartyFormationScreen();
}

// ランク・属性フィルター、並び替えボタンの共通ハンドラ(ボタンの見た目切替+再描画のみ。既存の他機能には影響しない)
function pfWireFilterGroup(groupId, applyFn) {
    const group = document.getElementById(groupId);
    if (!group) return;
    group.querySelectorAll('.pf-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            group.querySelectorAll('.pf-filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            applyFn(btn.dataset.value);
            renderPfRoster();
        });
    });
}
pfWireFilterGroup('pf-rank-filter', v => { pfRankFilter = v; });
pfWireFilterGroup('pf-style-filter', v => { pfStyleFilter = v; });
pfWireFilterGroup('pf-sort-group', v => { pfSortMode = v; });
