
/*
  Simple Clean-Architecture like structure inside one file
  - Repositories: SpotRepository, LocationRepository, AudioService
  - UseCases: GetSpotsUseCase, StartNavigationUseCase, UpdatePositionUseCase
  - Controllers: UI wiring and state
*/

const SHEET_URL = "https://opensheet.elk.sh/1NSJYoopyQnyA-yCGduNlLgUxxGqBYvI8h89xhahHaMQ/シート1";
// If you have a write endpoint (Google Apps Script WebApp or your API), put it here.
// Example: const WRITE_ENDPOINT = 'https://script.google.com/macros/s/XXX/exec';
const WRITE_ENDPOINT = '';

/* ---------- Repositories / Services ---------- */
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

/* Measurement repository: attempts to POST measurement to WRITE_ENDPOINT. If not configured,
   falls back to storing per-spot measurements in localStorage under key 'measurement_<spotId>'. */
const MeasurementRepository = {
    async saveMeasurement(spotId, payload) {
        try {
            if (WRITE_ENDPOINT) {
                const res = await fetch(WRITE_ENDPOINT, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ spotId, ...payload })
                });
                return res.ok;
            } else {
                // fallback: localStorage
                const key = `measurement_${spotId}`;
                localStorage.setItem(key, JSON.stringify(payload));
                return true;
            }
        } catch (e) {
            console.error('saveMeasurement failed', e);
            return false;
        }
    },
    getLastMeasurement(spotId) {
        try {
            if (WRITE_ENDPOINT) {
                // no read API implemented; caller should fetch from server if needed
                return null;
            }
            const key = `measurement_${spotId}`;
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
    }
};

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
const GetSpotsUseCase = {
    execute: async () => await SpotRepository.getSpots()
};

const UpdatePositionUseCase = {
    execute: (coords, spot) => {
        const d = calculateDistance(coords.latitude, coords.longitude, spot.lat, spot.lng);
        const pattern = decidePattern(d, spot.radius);
        return { distance: d, pattern, arrived: d <= (spot.radius || 50) };
    }
};

function decidePattern(distance, radius) {
    // closer -> faster and higher pitch
    const clamped = Math.max(1, distance);
    const interval = Math.max(180, clamped * 3); // ms
    const freq = Math.min(1200, Math.max(400, 1200 - clamped));
    const volume = Math.min(0.9, Math.max(0.08, 1 - (clamped / Math.max(radius, 200))));
    return { interval, freq, volume };
}

function getCurrentPositionPromise() {
    // Try strategies: 1) high accuracy getCurrentPosition (10s)
    // 2) low accuracy getCurrentPosition (10s)
    // 3) watchPosition until first fix (15s overall)
    return new Promise((resolve, reject) => {
        if (!('geolocation' in navigator)) return reject(new Error('Geolocation not supported'));

        const tryOnce = (options) => new Promise((res, rej) => {
            navigator.geolocation.getCurrentPosition(p => res(p.coords), e => rej(e), options);
        });

        (async () => {
            try {
                console.debug('[geo] try high-accuracy getCurrentPosition');
                const c = await tryOnce({ enableHighAccuracy: true, timeout: 10000 });
                console.debug('[geo] high-accuracy success');
                return resolve(c);
            } catch (e1) {
                console.debug('[geo] high-accuracy failed', e1 && e1.code, e1 && e1.message);
                // If user denied permission, stop immediately
                if (e1 && e1.code === 1) return reject(e1);
                // otherwise, fall through to try lower accuracy
            }

            try {
                console.debug('[geo] try low-accuracy getCurrentPosition');
                const c = await tryOnce({ enableHighAccuracy: false, timeout: 10000 });
                console.debug('[geo] low-accuracy success');
                return resolve(c);
            } catch (e2) {
                console.debug('[geo] low-accuracy failed', e2 && e2.code, e2 && e2.message);
                if (e2 && e2.code === 1) return reject(e2);
                // fallback to watchPosition: wait for first position or overall timeout
                let done = false;
                const overallTimer = setTimeout(() => {
                    if (done) return;
                    done = true;
                    try { if (watchId != null) navigator.geolocation.clearWatch(watchId); } catch (_) { }
                    reject(new Error('Timeout expired'));
                }, 20000);

                let watchId = navigator.geolocation.watchPosition(pos => {
                    if (done) return;
                    done = true;
                    clearTimeout(overallTimer);
                    try { navigator.geolocation.clearWatch(watchId); } catch (_) { }
                    console.debug('[geo] watchPosition got position');
                    resolve(pos.coords);
                }, err => {
                    if (done) return;
                    done = true;
                    clearTimeout(overallTimer);
                    try { if (watchId != null) navigator.geolocation.clearWatch(watchId); } catch (_) { }
                    console.debug('[geo] watchPosition error', err && err.code, err && err.message);
                    reject(err);
                }, { enableHighAccuracy: false, maximumAge: 0 });
            }
        })();
    });
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

function renderSpots(spots) {
    els.spotsGrid.innerHTML = '';
    spots.forEach((s, i) => {
        const card = document.createElement('div');
        card.className = 'spot-card';
        card.innerHTML = `
            <img src="${s.image}" alt="${escapeHtml(s.name)}" />
            <div class="meta">
                <div class="name">${escapeHtml(s.name)}</div>
                <div class="desc">${escapeHtml(s.desc)}</div>
            </div>`;
        card.addEventListener('click', () => {
            appState.selectedIndex = i;
            document.querySelectorAll('.spot-card').forEach((el, idx) => el.style.outline = idx === i ? '3px solid rgba(3,82,89,0.14)' : 'none');
        });
        els.spotsGrid.appendChild(card);
    });
    // preselect first
    if (spots.length > 0) {
        appState.selectedIndex = 0;
        document.querySelector('.spot-card')?.style.setProperty('outline', '3px solid rgba(3,82,89,0.14)');
    }
}

function attachEvents() {
    els.startBtn.addEventListener('click', () => showScreen('selection'));
    els.backToTitle.addEventListener('click', () => showScreen('title'));
    els.toNavBtn.addEventListener('click', () => {
        const idx = appState.selectedIndex;
        if (idx == null) { alert('スポットを選んでください'); return; }
        const spot = appState.spots[idx];
        startNavigation(spot);
    });
    els.backToSelection.addEventListener('click', () => {
        stopNavigation();
        showScreen('selection');
    });
    els.recordDeltaBtn.addEventListener('click', async () => {
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
    });
}

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

function stopNavigation() {
    if (appState.watchId) {
        LocationRepository.clearWatch(appState.watchId);
        appState.watchId = null;
    }
    AudioService.stopInterval();
    appState.beeping = false;
    // toggleBeepBtn was removed from UI; ensure we don't touch undefined elements
    if (els.toggleBeepBtn) els.toggleBeepBtn.textContent = 'ビープ開始';
}

function showNavSpot(spot) {
    if (els.navSpotImage) els.navSpotImage.src = spot.image;
    if (els.navSpotName) els.navSpotName.textContent = spot.name;
    if (els.navSpotDesc) els.navSpotDesc.textContent = spot.desc;
    if (els.navTitle) els.navTitle.textContent = 'ナビ — ' + spot.name;
    // distanceDisplay was removed from UI by design; do not attempt to set it.
    if (els.deltaDisplay) els.deltaDisplay.textContent = '-- m';
}

function escapeHtml(s) { return String(s).replace(/[&<>\"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

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

