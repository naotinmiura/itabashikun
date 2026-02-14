const SHEET_URL = "https://opensheet.elk.sh/1NSJYoopyQnyA-yCGduNlLgUxxGqBYvI8h89xhahHaMQ/シート1";

/* ---------- Repositories / Services ---------- */
/**
 * SpotRepository
 * - スプレッドシート (SHEET_URL) からスポット一覧を取得し、正規化して返す
 * - 返却するオブジェクト: { id, name, desc, lat, lng, image, radius }
 */
const SpotRepository = {
    async getSpots() {
        try {
            const res = await fetch(SHEET_URL);
            const json = await res.json();
            // normalize: ensure lat/lng and image
            return json.map((s, i) => ({
                id: s.id || String(i),
                name: s.name || `スポット ${i + 1}`,
                desc: s.desc || "説明がありません",
                lat: parseFloat(s.lat),
                lng: parseFloat(s.lng),
                image: s.image || `https://picsum.photos/seed/${encodeURIComponent(s.name || i)}/400/300`,
                radius: parseFloat(s.radius) || 100
            }));
        } catch (e) {
            console.error("Spot fetch failed", e);
            return [];
        }
    }
};

const LocationRepository = {
    watchPosition(onUpdate, onError) {
        if (!('geolocation' in navigator)) {
            onError && onError(new Error('Geolocation not supported'));
            return null;
        }
        const id = navigator.geolocation.watchPosition(pos => {
            onUpdate(pos.coords);
        }, err => {
            onError && onError(err);
        }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 });
        return id;
    },
    clearWatch(id) {
        if (id != null && 'geolocation' in navigator) navigator.geolocation.clearWatch(id);
    }
};

/**
 * MeasurementRepository
 * - 計測値を保存するためのリポジトリ。WRITE_ENDPOINT が設定されていれば POST、
 *   なければ localStorage にフォールバックする
 */
const MeasurementRepository = {
    async saveMeasurement(spotId, payload) {
        try {
            const key = `measurement_${spotId}`;
            localStorage.setItem(key, JSON.stringify(payload));
            return true;
        } catch (e) {
            console.error('saveMeasurement failed', e);
            return false;
        }
    },
    getLastMeasurement(spotId) {
        try {
            const key = `measurement_${spotId}`;
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
    }
};

/**
 * AudioService
 * - ナビ時に使う簡易的な WebAudio ヘルパー
 */
const AudioService = {
    ctx: null,
    osc: null,
    gain: null,
    timer: null,
    async init() {
        if (this.ctx) return;
        try {
            const C = window.AudioContext || window.webkitAudioContext;
            this.ctx = new C();
            this.gain = this.ctx.createGain();
            this.gain.gain.value = 0.0;
            this.gain.connect(this.ctx.destination);
        } catch (e) {
            console.warn('WebAudio not available', e);
        }
    },
    playBeep({ freq = 880, duration = 0.12, volume = 0.6 } = {}) {
        if (!this.ctx) return;
        const o = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        o.type = 'sine';
        o.frequency.value = freq;
        g.gain.value = volume;
        o.connect(g);
        g.connect(this.ctx.destination);
        o.start();
        setTimeout(() => { o.stop(); o.disconnect(); g.disconnect(); }, duration * 1000 + 20);
    },
    startInterval(freq, intervalMs) {
        if (!this.ctx) return;
        this.stopInterval();
        this.timer = setInterval(() => this.playBeep({ freq }), Math.max(60, intervalMs));
    },
    stopInterval() {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
    }
};

/* ---------- UseCases ---------- */
/**
 * GetSpotsUseCase
 * - スポット一覧を取得して返すユースケース
 */
const GetSpotsUseCase = { execute: async () => await SpotRepository.getSpots() };

/**
 * UpdatePositionUseCase
 * - 現在位置とスポットの距離を計算し、音声パターンと到着判定を返す
 * - 戻り値: { distance, pattern, arrived }
 */
const UpdatePositionUseCase = {
    execute: (coords, spot) => {
        const d = calculateDistance(coords.latitude, coords.longitude, spot.lat, spot.lng);
        const pattern = decidePattern(d, spot.radius);
        return { distance: d, pattern, arrived: d <= (spot.radius || 50) };
    }
};

/**
 * decidePattern(distance, radius)
 * - 距離に応じたビープの間隔・周波数・音量を決定する
 */
function decidePattern(distance, radius) {
    const clamped = Math.max(1, distance);
    const interval = Math.max(180, clamped * 3);
    const freq = Math.min(1200, Math.max(400, 1200 - clamped));
    const volume = Math.min(0.9, Math.max(0.08, 1 - (clamped / Math.max(radius, 200))));
    return { interval, freq, volume };
}

/**
 * tryGetPositionOnce(options)
 * - 指定オプションで一度だけ getCurrentPosition を試すヘルパー
 * - 成功時は coords を返す、失敗時はエラーを投げる
 */
function tryGetPositionOnce(options) {
    return new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(p => resolve(p.coords), e => reject(e), options);
    });
}

/**
 * watchPositionFirst(timeoutMs)
 * - watchPosition を使って最初の位置を取得する（指定時間でタイムアウト）
 */
function watchPositionFirst(timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
        let done = false;
        const overallTimer = setTimeout(() => {
            if (done) return;
            done = true;
            try { if (watchId != null) navigator.geolocation.clearWatch(watchId); } catch (_) { }
            reject(new Error('Timeout expired'));
        }, timeoutMs);

        let watchId = navigator.geolocation.watchPosition(pos => {
            if (done) return;
            done = true;
            clearTimeout(overallTimer);
            try { navigator.geolocation.clearWatch(watchId); } catch (_) { }
            resolve(pos.coords);
        }, err => {
            if (done) return;
            done = true;
            clearTimeout(overallTimer);
            try { if (watchId != null) navigator.geolocation.clearWatch(watchId); } catch (_) { }
            reject(err);
        }, { enableHighAccuracy: false, maximumAge: 0 });
    });
}

/**
 * getCurrentPositionPromise()
 * - 高精度→低精度→watch の順で位置取得を試みる
 */
async function getCurrentPositionPromise() {
    if (!('geolocation' in navigator)) throw new Error('Geolocation not supported');
    try {
        return await tryGetPositionOnce({ enableHighAccuracy: true, timeout: 10000 });
    } catch (e1) {
        if (e1 && e1.code === 1) throw e1; // permission denied
    }
    try {
        return await tryGetPositionOnce({ enableHighAccuracy: false, timeout: 10000 });
    } catch (e2) {
        if (e2 && e2.code === 1) throw e2;
        return await watchPositionFirst(20000);
    }
}

const StartNavigationUseCase = {
    execute: (spot, onUpdate, onArrive, onError) => {
        const id = LocationRepository.watchPosition(async (coords) => {
            const res = UpdatePositionUseCase.execute(coords, spot);
            onUpdate && onUpdate(res, coords);
            if (res.arrived) {
                onArrive && onArrive();
            }
        }, err => {
            onError && onError(err);
        });
        return id;
    }
};

/* ---------- Controllers / UI wiring ---------- */
let appState = { spots: [], selectedIndex: null, watchId: null, lastRecordedDistance: null, beeping: false, lastMeasuredDistance: null };

const els = {
    titleScreen: document.getElementById('titleScreen'),
    selectionScreen: document.getElementById('selectionScreen'),
    navScreen: document.getElementById('navScreen'),
    startBtn: document.getElementById('startBtn'),
    backToTitle: document.getElementById('backToTitle'),
    spotsGrid: document.getElementById('spotsGrid'),
    toNavBtn: document.getElementById('toNavBtn'),
    backToSelection: document.getElementById('backToSelection'),
    navTitle: document.getElementById('navTitle'),
    navSpotImage: document.getElementById('navSpotImage'),
    navSpotName: document.getElementById('navSpotName'),
    navSpotDesc: document.getElementById('navSpotDesc'),
    deltaDisplay: document.getElementById('deltaDisplay'),
    recordDeltaBtn: document.getElementById('recordDeltaBtn')
};



function showScreen(name) {
    els.titleScreen.classList.toggle('hidden', name !== 'title');
    els.selectionScreen.classList.toggle('hidden', name !== 'selection');
    els.navScreen.classList.toggle('hidden', name !== 'nav');
}

async function init() {
    await AudioService.init();
    const spots = await GetSpotsUseCase.execute();
    appState.spots = spots;
    renderSpots(spots);
}



/**
 * renderSpots(spots)
 * - スポットの配列を受け取り、選択画面にスポットカードを表示する
 */
function renderSpots(spots) {
    els.spotsGrid.innerHTML = '';
    spots.forEach((s, i) => els.spotsGrid.appendChild(createSpotCard(s, i)));
    // preselect first
    if (spots.length > 0) {
        appState.selectedIndex = 0;
        document.querySelector('.spot-card')?.style.setProperty('outline', '3px solid rgba(3,82,89,0.14)');
    }
}

/**
 * createSpotCard(spot, index)
 * - スポットカード要素を作成して返す
 */
function createSpotCard(spot, index) {
    const card = document.createElement('div');
    card.className = 'spot-card';
    card.innerHTML = `
        <img src="${spot.image}" alt="${escapeHtml(spot.name)}" />
        <div class="meta">
            <div class="name">${escapeHtml(spot.name)}</div>
            <div class="desc">${escapeHtml(spot.desc)}</div>
        </div>`;
    card.addEventListener('click', () => {
        appState.selectedIndex = index;
        document.querySelectorAll('.spot-card').forEach((el, idx) => el.style.outline = idx === index ? '3px solid rgba(3,82,89,0.14)' : 'none');
    });
    return card;
}

/**
 * attachEvents
 * - Wire main UI buttons and the distance calculation button
 */
function attachEvents() {
    els.startBtn.addEventListener('click', handleStart);
    els.backToTitle.addEventListener('click', handleBackToTitle);
    els.toNavBtn.addEventListener('click', handleToNav);
    els.backToSelection.addEventListener('click', handleBackToSelection);
    els.recordDeltaBtn.addEventListener('click', handleRecordDelta);
}

/**
 * handleStart - タイトル画面のスタートボタン (選択画面へ遷移)
 */
function handleStart() { showScreen('selection'); }

/**
 * handleBackToTitle - 選択画面からタイトルへ戻る
 */
function handleBackToTitle() { showScreen('title'); }

/**
 * handleToNav - 選択したスポットでナビを開始する
 */
function handleToNav() {
    const idx = appState.selectedIndex;
    if (idx == null) { alert('スポットを選んでください'); return; }
    const spot = appState.spots[idx];
    startNavigation(spot);
}

/**
 * handleBackToSelection - ナビ画面から選択画面へ戻す（ナビ停止）
 */
function handleBackToSelection() { stopNavigation(); showScreen('selection'); }

/**
 * handleRecordDelta - 現在位置を取得してスポットまでの距離を計算し表示する
 */
async function handleRecordDelta() {
    const idx = appState.selectedIndex;
    if (idx == null) { els.deltaDisplay.textContent = 'スポットが選択されていません'; return; }
    const spot = appState.spots[idx];
    try {
        els.deltaDisplay.textContent = '測位中...';
        const coords = await getCurrentPositionPromise();
        const d = Math.floor(calculateDistance(coords.latitude, coords.longitude, spot.lat, spot.lng));
        els.deltaDisplay.textContent = `${d} m`;
    } catch (e) {
        console.error('position get failed', e);
        els.deltaDisplay.textContent = '現在位置の取得に失敗しました';
    }
}

/**
 * startNavigation(spot)
 * - Show nav UI and start watching position
 */
function startNavigation(spot) {
    showNavSpot(spot);
    showScreen('nav');
    appState.lastRecordedDistance = null;

    appState.watchId = StartNavigationUseCase.execute(spot, (res, coords) => {
        // store latest measured distance but DO NOT display it directly on UI
        appState.lastMeasuredDistance = Math.floor(res.distance);
        appState.lastPattern = res.pattern;
        if (appState.beeping) {
            AudioService.startInterval(res.pattern.freq, res.pattern.interval);
        }
    }, () => {
        // arrived
        AudioService.stopInterval();
        alert('到着しました！');
    }, (err) => {
        console.error('位置取得エラー', err);
        alert('位置情報の取得でエラーが発生しました');
    });
}

/**
 * stopNavigation
 * - Stop watchers and audio
 */
function stopNavigation() {
    if (appState.watchId) {
        LocationRepository.clearWatch(appState.watchId);
        appState.watchId = null;
    }
    AudioService.stopInterval();
    appState.beeping = false;
}

/**
 * showNavSpot(spot)
 * - Populate navigation screen with spot data
 */
/**
 * showNavSpot(spot)
 * - ナビ画面に選択スポットの情報を表示する
 */
function showNavSpot(spot) {
    if (els.navSpotImage) els.navSpotImage.src = spot.image;
    if (els.navSpotName) els.navSpotName.textContent = spot.name;
    if (els.navSpotDesc) els.navSpotDesc.textContent = spot.desc;
    if (els.navTitle) els.navTitle.textContent = 'ナビ — ' + spot.name;
    if (els.deltaDisplay) els.deltaDisplay.textContent = '-- m';
}

/**
 * escapeHtml(s)
 * - 簡易サニタイズ: テキストを HTML に挿入する前にエスケープする
 */
function escapeHtml(s) { return String(s).replace(/[&<>\"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/**
 * calculateDistance(lat1, lon1, lat2, lon2)
 * - ハーサイン（Haversine）式で 2 点間の距離（メートル）を返す
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

// boot
attachEvents();
init();
