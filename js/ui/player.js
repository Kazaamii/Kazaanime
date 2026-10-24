/**
 * Kazanime — ui/player.js
 * SATU-SATUNYA implementasi player di situs. Menggantikan modal #playerModal dan
 * "streaming page" di file asli (dua salinan logika: openPlayer/loadStream vs
 * openStreamingPage/loadStreamingPageStream).
 *
 * Tanggung jawab: iframe embed, status, tombol server, dan fallback OTOMATIS ke
 * server berikutnya bila:
 *   a) id yang dibutuhkan server tidak ada → server dilewati (🔒)
 *   b) iframe tidak selesai dimuat dalam PLAYER.loadTimeout
 *   c) player di dalam iframe mengirim event error lewat postMessage
 * Halaman error DI DALAM iframe (mis. "video tidak ditemukan", "Account Suspended")
 * tidak bisa dibaca browser karena lintas-domain — untuk itu ada tombol "⟳ Server Lain".
 * Urutan server (hasil scraping dulu, cadangan statis di belakang) ditentukan watch.js.
 *
 * Event postMessage dari player (format asli MegaPlay, plus variasi umum):
 *   {event:'complete'|'ended'}             → 'complete' (auto-next diurus watch.js)
 *   {event:'time', percent}                → progres di status bar
 *   {type:'watching-log', currentTime, duration}
 *   {event:'error'}                        → server dianggap gagal → server berikutnya
 * Hanya diterima dari iframe yang sedang aktif atau origin server tersebut.
 *
 * Bug file asli yang diperbaiki:
 *  - iframe.onerror tidak pernah terpanggil untuk iframe, dan timeout 15 dtk justru
 *    menulis "✅" → fallback otomatis sebenarnya tidak pernah berjalan.
 *  - Listener postMessage menerima pesan dari origin mana pun dan memanggil
 *    changeEpisode() milik modal (bukan halaman streaming yang sedang tampil).
 *  - Tombol server memakai onclick inline + `event` global; iframe loading="lazy";
 *    izin camera/microphone/display-capture yang tidak diperlukan.
 *
 * 22 Okt 2026:
 *  - Server `kind: 'hls'` (AniZone/AnimeOnsen) dan `kind: 'video'` (AnimeOnsen MP4/WebM) diputar di <video>
 *    bawaan. AniZone HLS: Safari/iOS dapat memakai URL direct; browser lain memakai hls.js lewat proxy.
 *    AnimeOnsen HLS/native video memakai proxy backend bertanda tangan. Soft subtitle = <track> WebVTT;
 *    Indonesia dipilih otomatis bila ada.
 *  - Server dengan `mirrors` (ReAnime HD-2/HD-1) mencoba mirror berikutnya sebelum pindah server.
 *  - Slot penyedia yang belum selesai dicari (`pending`) tampil "mencari…".
 *  - "Subtitle Indonesia (AI)": bila server HLS tidak punya subtitle Indonesia dan backend menawarkannya
 *    (`server.ai`), subtitle Inggris diterjemahkan Gemini saat video mulai diputar (ui/ai-subtitle.js).
 *    Track AI tampil otomatis & subtitle bawaan disembunyikan; subtitle asli tetap bisa dipilih di menu subtitle
 *    player (ikon CC di Firefox/Safari, menu titik tiga → Captions di Chrome).
 *  - Subtitle lokal `.srt`/`.vtt` hanya untuk video HLS/native: dikonversi/dipasang di browser sebagai Blob URL,
 *    tidak diunggah; track & object URL dibersihkan saat source berganti dan file dilupakan saat episode berganti.
 *
 * Putaran 11 (24 Okt 2026) — iklan yang memaksa tab baru:
 *  - **Mode Aman** (opt-in) memasang sandbox TANPA `allow-popups`/`allow-top-navigation`, jadi
 *    iklan di dalam embed tidak bisa membuka tab baru atau membajak halaman. Default MATI karena
 *    sebagian embed menolak sandbox; toggle-nya ada di bawah player dan pilihannya diingat.
 *  - **Deteksi pembajakan**: setiap navigasi ulang iframe dihitung. Bila iklan memindahkan
 *    pemutar (mis. halaman JSON "iclick link error"), bilah pemulihan muncul dengan tombol
 *    "Pulihkan pemutar" / "Server lain"; setelah beberapa kali server itu dianggap rusak.
 *
 * Tidak ada fetch di sini. Daftar server (StreamServer[]) datang dari js/api.
 */
import { PLAYER, LEGAL_PLATFORMS, STORAGE_KEYS } from '../config.js';
import { html, delegate } from './dom.js';
import { showToast } from './toast.js';
import { icon, hasIcon } from './icons.js';
import { createAiSubtitle, aiErrorText } from './ai-subtitle.js';
import { attachLocalSubtitleTrack, readLocalSubtitleFile } from './local-subtitle.js';
import { storage } from '../services/storage.js';
import { filterAdServers } from '../services/adblock.js';

/** @typedef {import('../api/streams.js').StreamServer} StreamServer */

/**
 * Overlay "memuat" paling lama segini (ms). Event `load` iframe menunggu SEMUA isi
 * halaman embed (termasuk iklan), jadi player yang sudah bisa dipakai jangan ditutupi
 * terlalu lama. Deteksi timeout (PLAYER.loadTimeout) tetap berjalan di latar.
 */
const OVERLAY_MAX_MS = 3000;
const COMPLETE_EVENTS = new Set(['complete', 'ended', 'finish', 'finished']);
/** Label bahasa subtitle server (StreamServer.lang) untuk status bar. */
const LANG_LABELS = { id: 'Sub Indo', en: 'Sub English', multi: 'Multi Sub' };
const SUBTITLE_TYPE_LABELS = { hard: 'Hardsub', soft: 'Softsub' };
const HLS_MIME = 'application/vnd.apple.mpegurl';
const ICON_LOCK = icon('lock');

/* ------------------------------------------------------------------ */
/* Iklan & tab baru dari host streaming (24 Okt 2026, putaran 8)       */
/* ------------------------------------------------------------------ */
/**
 * Permintaan pengguna: *"hapus tombol pop up block dan izinkan karna sudah tidak bekerja
 * bertuliskan Sandbox Not Allowed"* + *"untuk iklan dari host streaming kita buat agar tidak
 * berusaha membuka tab baru"*.
 *
 * Sandbox iframe DIHAPUS TOTAL. Penyebabnya nyata: banyak embed (mis. player dengan pesan
 * "Opss! Sandboxed our player is not allowed. Remove sandbox to use it.") menolak berjalan di
 * dalam iframe ber-sandbox, sehingga video tidak muncul sama sekali. Karena sandbox satu-satunya
 * cara teknis memblokir `window.open()` dari iframe lintas-domain, proteksi tab baru dilakukan
 * dengan dua cara yang tidak merusak pemutaran:
 *
 *  1. **Lapisan anti-iklan (ad shield).** Setelah embed selesai dimuat, satu lapisan transparan
 *     menutup area player sampai pengguna mengkliknya sekali. Klik pertama itu "dibuang" —
 *     tidak diteruskan ke iframe — sehingga popunder/pop-up yang dipicu klik pertama (pola iklan
 *     paling umum di host streaming) tidak pernah terjadi. Setelah itu pemutar dipakai normal.
 *     Matikan lewat PLAYER.adShield = false bila mengganggu.
 *  2. **Pemutar eksternal.** Tombol di bawah player membuka embed yang sama di tab baru
 *     (`noopener,noreferrer`); halaman Kazanime tidak bisa dibajak iklan karena tidak ada iframe
 *     yang berjalan di tab ini.
 *
 * Batas jujur: pop-up yang dipicu OTOMATIS saat embed dimuat tetap mungkin terjadi bila browser
 * mengizinkannya, dan pop-up dari klik SETELAH lapisan dilepas tidak bisa dicegah tanpa sandbox.
 * Karena itu tombol pemutar eksternal disediakan sebagai jalan aman.
 */
const AD_SHIELD_ID = 'playerAdShield';

/** Bersihkan sisa preferensi sandbox dari versi lama (kalau tidak, pengguna tetap terkunci). */
function dropLegacyGuardFlag() {
    try {
        window.localStorage?.removeItem(STORAGE_KEYS.popupGuard);
    } catch {
        // mode privat: tidak ada yang perlu dibersihkan
    }
}
dropLegacyGuardFlag();

/* ------------------------------------------------------------------ */
/* Mode Aman & deteksi pembajakan iklan (putaran 11)                    */
/* ------------------------------------------------------------------ */
/**
 * Apakah "Mode Aman" (sandbox tanpa pop-up) sedang aktif.
 * Pilihan disimpan di perangkat; default `PLAYER.safeFrame.defaultOn` (mati).
 * @returns {boolean}
 */
export function isSafeFrameOn() {
    const raw = storage.getRaw(STORAGE_KEYS.safeFrame);
    if (raw === '1') return true;
    if (raw === '0') return false;
    return Boolean(PLAYER.safeFrame?.defaultOn);
}

/** @param {boolean} on */
export function saveSafeFrame(on) {
    storage.setRaw(STORAGE_KEYS.safeFrame, on ? '1' : '0');
}

/**
 * Pasang/lepas sandbox pada iframe sesuai Mode Aman.
 *
 * Sandbox sengaja tidak memuat `allow-popups` maupun `allow-top-navigation`: `window.open()`
 * dari embed iklan gagal, dan tab Kazanime tidak bisa dialihkan. `allow-same-origin` +
 * `allow-scripts` dipertahankan supaya pemutar yang membutuhkan storage/worker tetap jalan.
 * @param {HTMLIFrameElement} iframe
 * @param {boolean} on
 */
function applyFramePolicy(iframe, on) {
    if (!on) {
        iframe.removeAttribute('sandbox');
        return;
    }
    // `iframe.sandbox` adalah DOMTokenList (PutForwards=value) → setara atribut sandbox.
    iframe.sandbox.value = PLAYER.safeFrame.policy;
}

/** hls.js (Apache-2.0) disimpan lokal; dimuat sekali saat server HLS pertama diputar. */
let hlsLoader = null;
function loadHlsJs() {
    if (window.Hls) return Promise.resolve(window.Hls);
    hlsLoader ||= new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = PLAYER.hlsScript;
        script.async = true;
        script.onload = () => (window.Hls ? resolve(window.Hls) : reject(new Error('hls.js tidak termuat')));
        script.onerror = () => {
            hlsLoader = null;
            reject(new Error('hls.js gagal dimuat'));
        };
        document.head.append(script);
    });
    return hlsLoader;
}
const PROGRESS_EVENTS = new Set(['time', 'timeupdate', 'progress', 'watching-log']);

const clamp01 = (n) => Math.min(1, Math.max(0, n));

/** Bahasa & jenis subtitle pada status bar — kosong bila sudah tertulis di nama server. */
function langSuffix(server) {
    const labels = [LANG_LABELS[server.lang], SUBTITLE_TYPE_LABELS[server.subtitleType]]
        .filter((label) => label && !String(server.name).includes(label));
    return labels.length ? ` | ${labels.join(' · ')}` : '';
}

/** Persentase tonton dari payload player (0–1), null bila tidak ada. */
function percentOf(data) {
    let p = Number(data.percent);
    if (Number.isFinite(p)) return clamp01(p > 1 ? p / 100 : p);
    const t = Number(data.currentTime ?? data.position);
    const d = Number(data.duration);
    if (Number.isFinite(t) && Number.isFinite(d) && d > 0) return clamp01(t / d);
    return null;
}

/**
 * Keterangan subtitle di status bar selama/sesudah terjemahan AI.
 * @param {{phase: string, done: number, total: number, label: string}} s
 * @param {{label: string}|undefined} def subtitle bawaan yang dipilih
 */
function aiNote(s, def) {
    const orig = def?.label || 'subtitle asli';
    switch (s.phase) {
        case 'translating':
            return s.done ? `${s.label} · menerjemahkan ${s.done}/${s.total}` : `${orig} · menerjemahkan ke ${s.label}…`;
        case 'ready': return s.label;
        case 'partial': return `${s.label}, sebagian ${orig}`;
        case 'kept': return `${s.showing || 'Subtitle mati'} · ${s.label} siap di menu subtitle`;
        default: return orig;
    }
}

/**
 * Toast sekali per kejadian penting.
 * @returns {{key: string, text: string, type: 'success'|'error'|'info', duration?: number}|null}
 */
function aiToast(s, def) {
    const orig = def?.label || 'asli';
    if (s.phase === 'translating' && s.first) {
        return { key: 'on', type: 'success', duration: 6000, text: `Subtitle ${s.label} aktif — terjemahan mesin, bisa kurang tepat. Subtitle ${orig} tetap bisa dipilih di menu subtitle player (ikon CC atau menu titik tiga).` };
    }
    if (s.phase === 'kept' && s.first) return { key: 'kept', type: 'info', text: `Subtitle ${s.label} siap — pilih lewat menu subtitle player (ikon CC atau menu titik tiga).` };
    if (s.phase === 'partial') return { key: 'partial', type: 'info', duration: 8000, text: `Sebagian subtitle belum bisa diterjemahkan AI — bagian itu memakai subtitle ${orig}. ${aiErrorText(s.error)}` };
    if (s.phase === 'failed') return { key: 'failed', type: 'info', duration: 8000, text: `Subtitle ${s.label} tidak tersedia. ${aiErrorText(s.error)} Subtitle ${orig} tetap dipakai.` };
    return null;
}

/**
 * @param {{
 *   stage: HTMLElement,          isi area player (#playerStage)
 *   serverBox: HTMLElement,      wadah tombol server (#serverButtons)
 *   status: HTMLElement,         status bar (#playerStatus) — kelas is-ok / is-error
 *   statusText: HTMLElement,     teks status (#playerStatusText)
 *   getTitle?: () => string,     judul anime (untuk title iframe & tautan platform legal)
 *   fetchAiSubtitle?: ((url: string, part: number, o: {signal?: AbortSignal}) => Promise<any>)|null,
 *                                bagian "Subtitle Indonesia (AI)" (js/api getAiSubtitlePart); null = fitur mati
 *   localSubtitleTools?: HTMLElement, localSubtitleButton?: HTMLButtonElement,
 *   clearLocalSubtitleButton?: HTMLButtonElement, localSubtitleInput?: HTMLInputElement,
 * }} opts
 */
export function createPlayer({
    stage,
    serverBox,
    status,
    statusText,
    getTitle = () => '',
    fetchAiSubtitle = null,
    localSubtitleTools = null,
    localSubtitleButton = null,
    clearLocalSubtitleButton = null,
    localSubtitleInput = null,
}) {
    /** @type {Record<string, Set<Function>>} */
    const handlers = { loaded: new Set(), complete: new Set(), progress: new Set(), exhausted: new Set(), retry: new Set(), servers: new Set(), adblock: new Set(), adguide: new Set(), safeFrame: new Set() };
    const emit = (name, detail) => handlers[name]?.forEach((fn) => {
        try { fn(detail); } catch (err) { console.error(`[player] handler "${name}" error:`, err); }
    });

    /** @type {StreamServer[]} */
    let servers = [];
    let currentId = null;
    let ep = 1;
    let failed = new Set();
    /** @type {HTMLIFrameElement|null} */
    let frame = null;
    /** @type {HTMLVideoElement|null} */
    let video = null;
    /** Instance hls.js aktif (server HLS di browser tanpa HLS native). */
    let hls = null;
    /** Pengendali "Subtitle Indonesia (AI)" untuk video yang sedang diputar. */
    let aiSub = null;
    /** Isi subtitle pilihan pengguna (hanya di memori browser, tidak pernah dikirim ke server). */
    let localSubtitle = null;
    let localSubtitleReadToken = 0;
    /** Melepas track lokal + object URL video aktif saat source berganti. */
    let disposeLocalSubtitleTrack = null;
    let localSubtitleToolsVisible = false;
    /** id server → indeks mirror yang sedang dicoba (direset per episode). */
    let mirror = new Map();
    const urlOf = (server) => server.mirrors?.[mirror.get(server.id) || 0] || server.url;
    let timer = 0;
    let overlayTimer = 0;
    /** @type {HTMLElement|null} lapisan anti-iklan di atas iframe (putaran 8) */
    let adShield = null;
    /** @type {HTMLElement|null} bilah pemulihan saat iklan memindahkan pemutar (putaran 11) */
    let adRecovery = null;
    /** Jumlah navigasi ulang iframe untuk server aktif (indikasi iklan membajak). */
    let frameLoads = 0;
    /** Waktu load terakhir (ms) — menahan event `load` ganda dari peramban. */
    let lastFrameLoadAt = 0;
    /** Mode Aman aktif? (sandbox tanpa pop-up) */
    let safeFrame = isSafeFrameOn();
    /** Tandai server aktif "termuat" (dipakai event load & pesan progres dari player). */
    let markLoaded = null;
    let token = 0;
    /** idle | waiting | loading | playing | exhausted | message */
    let state = 'idle';
    let completedFor = null;

    /**
     * Pengaman terakhir (putaran 11): buang server yang URL-nya jaringan iklan/gateway klik,
     * apa pun pemanggilnya. Ini yang dulu menampilkan halaman JSON "iclick link error" di
     * dalam pemutar. Server HLS/native tidak diperiksa (bukan iframe).
     * @param {StreamServer[]} list
     * @returns {StreamServer[]}
     */
    const keepPlayable = (list) => {
        const { servers: kept, blocked } = filterAdServers(Array.isArray(list) ? list : []);
        if (blocked.length) {
            const names = blocked.map((item) => item.name).filter(Boolean).join(', ');
            showToast(`${blocked.length} server dihapus karena mengarah ke jaringan iklan${names ? `: ${names}` : ''}.`, 'info', 7000);
        }
        return kept;
    };
    const available = () => servers.filter((s) => s.available);
    const byId = (id) => servers.find((s) => s.id === id) || null;
    const current = () => byId(currentId);

    /* ---------------------------------------------------------------- */
    /* Tampilan                                                          */
    /* ---------------------------------------------------------------- */
    /**
     * @param {string} text
     * @param {'loading'|'ok'|'error'} [kind]
     * @param {{quiet?: boolean}} [opts] quiet = jangan diumumkan screen reader (update progres berkala)
     */
    function setStatus(text, kind = 'loading', { quiet = false } = {}) {
        status.setAttribute('aria-live', quiet ? 'off' : 'polite');
        statusText.textContent = text;
        status.classList.toggle('is-ok', kind === 'ok');
        status.classList.toggle('is-error', kind === 'error');
    }

    function updateLocalSubtitleControls() {
        if (localSubtitleTools) localSubtitleTools.hidden = !localSubtitleToolsVisible;
        if (localSubtitleButton) {
            localSubtitleButton.hidden = !localSubtitleToolsVisible;
            localSubtitleButton.textContent = localSubtitle ? 'Ganti Sub' : 'Sub Lokal';
            localSubtitleButton.title = localSubtitle
                ? `Ganti subtitle lokal (${localSubtitle.label})`
                : 'Pilih berkas subtitle lokal .srt atau .vtt';
            localSubtitleButton.setAttribute('aria-label', localSubtitle
                ? `Ganti subtitle lokal: ${localSubtitle.label}`
                : 'Pilih berkas subtitle lokal');
        }
        if (clearLocalSubtitleButton) {
            clearLocalSubtitleButton.hidden = !localSubtitleToolsVisible || !localSubtitle;
        }
    }

    function setLocalSubtitleControlsVisible(visible) {
        localSubtitleToolsVisible = Boolean(visible);
        updateLocalSubtitleControls();
    }

    function detachLocalSubtitleTrack() {
        if (!disposeLocalSubtitleTrack) return;
        const dispose = disposeLocalSubtitleTrack;
        disposeLocalSubtitleTrack = null;
        try { dispose(); } catch (err) { console.warn('[player] subtitle lokal tidak dapat dilepas:', err); }
    }

    function forgetLocalSubtitle() {
        localSubtitleReadToken++;
        detachLocalSubtitleTrack();
        localSubtitle = null;
        if (localSubtitleInput) localSubtitleInput.value = '';
        updateLocalSubtitleControls();
    }

    function attachRememberedLocalSubtitle(targetVideo) {
        if (!localSubtitle) return true;
        try {
            disposeLocalSubtitleTrack = attachLocalSubtitleTrack(targetVideo, localSubtitle);
            return true;
        } catch (err) {
            console.warn('[player] subtitle lokal tidak dapat dipasang:', err);
            localSubtitle = null;
            updateLocalSubtitleControls();
            showToast('Subtitle lokal tidak dapat dipasang ke video ini.', 'error');
            return false;
        }
    }

    async function onLocalSubtitleChange() {
        const file = localSubtitleInput?.files?.[0];
        if (!file) return;
        const readToken = ++localSubtitleReadToken;
        const selectedEpisode = ep;
        try {
            const subtitle = await readLocalSubtitleFile(file);
            if (readToken !== localSubtitleReadToken) return;
            if (selectedEpisode !== ep) {
                showToast('Episode sudah berganti; subtitle lokal tidak diterapkan.', 'info');
                return;
            }
            detachLocalSubtitleTrack();
            localSubtitle = subtitle;
            if (video && !attachRememberedLocalSubtitle(video)) return;
            updateLocalSubtitleControls();
            showToast(video
                ? `Subtitle lokal "${subtitle.label}" aktif. Berkas tidak diunggah.`
                : `Subtitle lokal "${subtitle.label}" siap untuk pemutar HLS; tidak dapat dipakai di embed pihak ketiga.`, 'success');
        } catch (err) {
            showToast(err?.message || 'Berkas subtitle tidak dapat dimuat.', 'error');
        } finally {
            if (readToken === localSubtitleReadToken && localSubtitleInput) localSubtitleInput.value = '';
        }
    }

    function clearFrame() {
        setLocalSubtitleControlsVisible(false);
        detachLocalSubtitleTrack();
        clearTimeout(timer);
        clearTimeout(overlayTimer);
        timer = 0;
        overlayTimer = 0;
        markLoaded = null;
        if (frame) {
            frame.remove(); // melepas iframe = video/audio benar-benar berhenti
            frame = null;
        }
        if (aiSub) {
            aiSub.destroy(); // batalkan request terjemahan yang masih berjalan
            aiSub = null;
        }
        if (hls) {
            try { hls.destroy(); } catch { /* sudah dilepas */ }
            hls = null;
        }
        if (video) {
            video.pause();
            video.removeAttribute('src');
            video.load(); // hentikan unduhan segmen
            video.remove();
            video = null;
        }
        removeAdShield();
        removeAdRecovery();
        frameLoads = 0;
        lastFrameLoadAt = 0;
    }

    /**
     * Lapisan anti-iklan di atas iframe (lihat catatan di bagian atas file, putaran 8).
     * Klik pertama pada area player "dibuang" (tidak diteruskan ke iframe), sehingga pola
     * popunder/pop-up yang dipicu klik pertama tidak terjadi. Klik kedua (dan seterusnya)
     * diteruskan normal ke pemutar.
     * @param {number} my token pemutaran; lapisan hanya dipasang untuk pemutaran yang masih aktif
     */
    function mountAdShield(my) {
        removeAdShield();
        if (!PLAYER.adShield || my !== token) return;
        const shield = document.createElement('button');
        shield.type = 'button';
        shield.id = AD_SHIELD_ID;
        shield.className = 'player-ad-shield';
        shield.setAttribute('aria-label', 'Aktifkan pemutar (lapisan anti-iklan)');
        shield.innerHTML = String(html`<span class="player-ad-shield-pill">${icon('shield-check')} Klik untuk mengaktifkan pemutar <small>lapisan anti-iklan</small></span>`);
        shield.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            removeAdShield();
        }, { once: true });
        stage.append(shield);
        adShield = shield;
    }

    function removeAdShield() {
        if (!adShield) return;
        adShield.remove();
        adShield = null;
    }

    /**
     * Terapkan Mode Aman ke iframe yang sedang tampil (opt-in, disimpan di perangkat).
     * Dipakai tombol di halaman watch, tombol di bilah pemulihan, dan fallback saat timeout.
     * @param {boolean} on
     * @returns {boolean} nilai baru
     */
    function applySafeFrame(on) {
        safeFrame = Boolean(on);
        saveSafeFrame(safeFrame);
        if (frame) {
            applyFramePolicy(frame, safeFrame);
            frame.dataset.safeFrame = safeFrame ? 'on' : 'off';
            // Muat ulang dokumen supaya kebijakan sandbox benar-benar berlaku.
            try {
                frame.contentWindow?.location.reload();
            } catch {
                const src = frame.src;
                frame.src = 'about:blank';
                setTimeout(() => { if (frame) frame.src = src; }, 30);
            }
        }
        emit('safeFrame', { on: safeFrame });
        return safeFrame;
    }

    /**
     * Bilah pemulihan TIDAK menutupi seluruh pemutar (bukan layar penolakan seperti versi lama):
     * ia menempel di bawah area player supaya pengguna tetap bisa melihat apa yang sedang terjadi
     * dan memilih tindakan. Muncul saat iframe memuat ulang ke halaman lain (pola redirect iklan).
     * @param {number} my token pemutaran
     */
    function mountAdRecovery(my) {
        removeAdRecovery();
        if (my !== token) return;
        const active = current();
        const bar = document.createElement('div');
        bar.className = 'player-ad-recovery';
        bar.id = 'playerAdRecovery';
        bar.setAttribute('role', 'status');
        bar.innerHTML = String(html`
            <span class="player-ad-recovery-text">${icon('shield-check')} Iklan memindahkan pemutar. Video bisa dipulihkan.</span>
            <span class="player-ad-recovery-actions">
                <button type="button" class="player-ad-recovery-btn" data-ad-action="restore">Pulihkan pemutar</button>
                <button type="button" class="player-ad-recovery-btn" data-ad-action="next">Server lain</button>
                <button type="button" class="player-ad-recovery-btn" data-ad-action="safe"${safeFrame ? ' hidden' : ''}>Aktifkan Mode Aman</button>
                <button type="button" class="player-ad-recovery-btn player-ad-recovery-btn--ghost" data-ad-action="guide">Cara blokir iklan</button>
            </span>`);
        bar.addEventListener('click', (event) => {
            const btn = event.target instanceof Element ? event.target.closest('[data-ad-action]') : null;
            if (!btn) return;
            const action = btn.getAttribute('data-ad-action');
            if (action === 'restore') {
                if (active) play(active);
            } else if (action === 'next') {
                nextServer();
            } else if (action === 'safe') {
                // Iklan membajak → tawarkan pelindung satu klik, lalu muat ulang server yang sama.
                const on = applySafeFrame(true);
                showToast('Mode Aman aktif — iklan tidak bisa membuka tab baru.', 'success', 5000);
                if (on && active) play(active);
            } else if (action === 'guide') {
                emit('adguide', { server: active });
            }
        });
        stage.append(bar);
        adRecovery = bar;
    }

    function removeAdRecovery() {
        if (!adRecovery) return;
        adRecovery.remove();
        adRecovery = null;
    }

    /**
     * Navigasi ulang iframe = dugaan iklan membajak pemutar (mis. `/iclick?…` → halaman JSON).
     * Reaksi:
     *  - sekali  → tampilkan bilah pemulihan + kabari halaman (watch.js menampilkan toast);
     *  - berulang → server dianggap rusak, server berikutnya dicoba otomatis.
     * @param {number} my token pemutaran
     */
    function noteFrameReload(my) {
        if (my !== token) return;
        const now = Date.now();
        // Sebagian peramban memicu `load` dua kali untuk dokumen yang sama → abaikan duplikat.
        const duplicate = lastFrameLoadAt && now - lastFrameLoadAt < (PLAYER.adTakeover?.ignoreWithinMs || 1200);
        lastFrameLoadAt = now;
        if (duplicate) return;
        frameLoads += 1; // 1 = navigasi pertama setelah halaman embed termuat
        const active = current();
        emit('adblock', { type: 'takeover', server: active, count: frameLoads });
        mountAdRecovery(my);
        if (frameLoads >= (PLAYER.adTakeover?.maxTakeovers || 2) && active) {
            failed.add(active.id);
            emit('adblock', { type: 'skipped', server: active, count: frameLoads });
            const next = available().find((item) => item.id !== active.id && !failed.has(item.id));
            if (next) play(next);
            else setStatus('Iklan memindahkan pemutar. Coba server lain atau Pemutar Eksternal.', 'error');
        }
    }

    function renderServers() {
        if (!servers.length) {
            serverBox.innerHTML = '<p class="server-empty">Tidak ada server streaming yang dikonfigurasi.</p>';
            emit('servers', { count: 0 });
            return;
        }
        serverBox.innerHTML = String(html`${servers.map((s) => {
            const active = s.id === currentId && (state === 'loading' || state === 'playing');
            const isFailed = failed.has(s.id);
            const cls = ['server-btn', active ? 'active' : '', s.available ? '' : 'is-disabled', isFailed ? 'is-failed' : ''].filter(Boolean).join(' ');
            const lock = s.pending
                ? html` <span class="server-badge server-badge--pending">mencari…</span>`
                : s.available ? '' : html` <span class="server-lock" aria-label="tidak tersedia">${ICON_LOCK}</span>`;
            // Putaran 11: host yang ada di daftar blokir iklan diberi tanda ⚠ (tetap bisa dipilih).
            const adWarn = s.adRisk
                ? html` <span class="server-badge server-badge--ad" title="Host server ini ada di daftar blokir iklan (AdGuard DNS)">⚠</span>`
                : '';
            return html`<button type="button" class="${cls}${s.pending ? ' is-pending' : ''}" data-server="${s.id}" aria-pressed="${active ? 'true' : 'false'}" aria-disabled="${s.available ? 'false' : 'true'}" title="${s.available ? s.description : s.reason}">${s.flag ? `${s.flag} ` : ''}${s.name}${s.badge ? html` <span class="server-badge">${s.badge}</span>` : ''}${adWarn}${lock}${isFailed ? html` <span class="server-badge server-badge--failed">gagal</span>` : ''}</button>`;
        })}`);
        emit('servers', { count: available().length });
    }

    /** Elemen pesan di area player (aman: semua teks lewat html``). */
    function messageEl({ icon: iconName = '', title = '', text = '', sub = '', spinner = false, actions = [] }) {
        const box = document.createElement('div');
        box.className = 'player-message';
        box.innerHTML = String(html`
            ${spinner ? html`<div class="spinner" aria-hidden="true"></div>` : ''}
            ${iconName ? html`<p class="player-message-icon" aria-hidden="true">${hasIcon(iconName) ? icon(iconName) : iconName}</p>` : ''}
            ${title ? html`<p class="player-message-title">${title}</p>` : ''}
            ${text ? html`<p class="player-message-text">${text}</p>` : ''}
            ${sub ? html`<p class="player-message-sub">${sub}</p>` : ''}
            ${actions.length ? html`<div class="player-message-actions">${actions.map((a, i) => {
                if (!a.href) return html`<button type="button" class="${a.className || 'btn-ext'}" data-action-index="${i}">${a.label}</button>`;
                return a.newTab === false
                    ? html`<a class="${a.className || 'btn-ext'}" href="${a.href}">${a.label}</a>`
                    : html`<a class="${a.className || 'btn-ext'}" href="${a.href}" target="_blank" rel="noopener noreferrer">${a.label}</a>`;
            })}</div>` : ''}`);
        box.querySelectorAll('[data-action-index]').forEach((btn) => {
            const action = actions[Number(btn.dataset.actionIndex)];
            btn.addEventListener('click', () => action?.onClick?.());
        });
        return box;
    }

    /** Tombol platform legal (sama seperti showErrorInPlayer di file asli: Bstation + YouTube). */
    function legalActions() {
        const t = getTitle();
        if (!t) return [];
        const bstation = LEGAL_PLATFORMS.find((p) => p.id === 'bstation');
        const muse = LEGAL_PLATFORMS.find((p) => p.id === 'muse');
        return [
            bstation && { label: html`${icon(bstation.icon)} ${bstation.name}`, href: bstation.url(t), className: 'btn-bstation' },
            muse && { label: html`${icon('clapperboard')} YouTube`, href: muse.url(t), className: 'btn-youtube' },
        ].filter(Boolean);
    }

    /* ---------------------------------------------------------------- */
    /* Memutar & fallback                                                */
    /* ---------------------------------------------------------------- */
    /** @param {StreamServer} server */
    function play(server) {
        clearFrame();
        const my = ++token;
        currentId = server.id;
        state = 'loading';
        completedFor = null;
        renderServers();

        const overlay = messageEl({ spinner: true, text: `Memuat streaming Episode ${ep}...`, sub: `Server: ${server.flag ? `${server.flag} ` : ''}${server.name}` });
        overlay.classList.add('player-overlay');
        if (server.kind === 'hls' || server.kind === 'video') {
            playVideo(server, my, overlay);
            return;
        }
        const iframe = document.createElement('iframe');
        iframe.className = 'player-frame';
        iframe.title = `Player ${getTitle()} - Episode ${ep}`.trim();
        iframe.allow = PLAYER.allow;
        iframe.allowFullscreen = true;
        iframe.referrerPolicy = PLAYER.referrerPolicy;
        // Tanpa sandbox secara default (sejak putaran 8): sebagian embed menolak sandbox.
        // Mode Aman (putaran 11) memasang sandbox tanpa allow-popups/allow-top-navigation.
        iframe.dataset.popupGuard = 'off';
        iframe.dataset.safeFrame = safeFrame ? 'on' : 'off';
        applyFramePolicy(iframe, safeFrame);
        frameLoads = 0;
        lastFrameLoadAt = 0;
        const loaded = () => {
            if (my !== token || state !== 'loading') return;
            clearTimeout(timer);
            clearTimeout(overlayTimer);
            state = 'playing';
            overlay.remove();
            setStatus(`${server.name} | Episode ${ep}${langSuffix(server)}`, 'ok');
            renderServers();
            mountAdShield(my);
            emit('loaded', { ep, server });
        };
        markLoaded = loaded;
        let firstLoad = true;
        iframe.addEventListener('load', () => {
            if (my !== token) return;
            if (firstLoad) {
                firstLoad = false;
                lastFrameLoadAt = Date.now();
                loaded();
                return;
            }
            noteFrameReload(my);
        });
        iframe.src = urlOf(server); // src sebelum dipasang → event load hanya untuk dokumen embed
        stage.replaceChildren(iframe, overlay);
        frame = iframe;
        setStatus(`Memuat ${server.name} • Episode ${ep}...`);
        overlayTimer = setTimeout(() => {
            if (my === token) overlay.remove();
        }, Math.min(OVERLAY_MAX_MS, PLAYER.loadTimeout));
        timer = setTimeout(() => {
            if (my !== token || state !== 'loading') return;
            // Fokus sudah di dalam iframe = user sedang memakai player → jangan dipindah server.
            if (document.activeElement === iframe) {
                loaded();
                return;
            }
            fail(server, 'timeout');
        }, PLAYER.loadTimeout);
    }

    /**
     * Server HLS (AniZone/AnimeOnsen) atau video langsung (AnimeOnsen) di player video bawaan.
     * @param {StreamServer} server
     * @param {number} my token pemutaran
     * @param {HTMLElement} overlay
     */
    function playVideo(server, my, overlay) {
        setLocalSubtitleControlsVisible(true);
        const v = document.createElement('video');
        v.className = 'player-frame player-video';
        v.controls = true;
        v.playsInline = true;
        v.preload = 'auto';
        v.setAttribute('playsinline', '');
        v.title = `Player ${getTitle()} - Episode ${ep}`.trim();
        if (server.poster) v.poster = server.poster;
        const subs = server.subtitles || [];
        const pref = PLAYER.subtitlePriority || ['id', 'en'];
        const def = subs.find((t) => t.default) || pref.map((l) => subs.find((t) => t.lang.split('-')[0] === l)).find(Boolean);
        for (const t of subs) {
            const track = document.createElement('track');
            track.kind = 'subtitles';
            track.label = t.label;
            track.srclang = t.lang || 'und';
            track.src = t.url;
            if (t === def) {
                // Chrome (desktop & iPad) tidak selalu menyalakan track yang dipasang dinamis
                // hanya dari properti `default` — atribut HTML-nya ikut ditulis dan mode-nya
                // dinyalakan lagi saat metadata siap (lihat showDefaultSubtitle di bawah).
                track.default = true;
                track.setAttribute('default', '');
            }
            v.append(track);
        }
        /**
         * Chrome tidak menampilkan subtitle bila track default masih ber-mode 'disabled'
         * (umum saat <track> ditambahkan setelah elemen <video> dibuat). Aktifkan sekali
         * setelah metadata; subtitle AI / sub lokal tetap bisa menggantikannya nanti.
         */
        const showDefaultSubtitle = () => {
            if (!def) return;
            const tracks = Array.from(v.textTracks || []);
            const target = tracks.find((track) => track.label === def.label) || tracks[0];
            if (target && target.mode === 'disabled') target.mode = 'showing';
        };
        v.addEventListener('loadedmetadata', showDefaultSubtitle);
        // "Subtitle Indonesia (AI)": hanya bila subtitle Indonesia tidak ada & backend menawarkannya.
        let subNote = def ? def.label : '';
        let aiShown = false;
        let lastPct = 0;
        const statusLine = () => (lastPct > 0
            ? `${server.name} | EP ${ep} | ${Math.round(lastPct * 100)}%${aiShown && subNote ? ` | ${subNote}` : ''}`
            : `${server.name} | Episode ${ep} | ${LANG_LABELS.multi}${subNote ? ` (${subNote})` : ''}`);
        const hasIndo = subs.some((t) => t.lang.split('-')[0] === 'id');
        if (!hasIndo && server.ai && typeof fetchAiSubtitle === 'function' && PLAYER.aiSubtitle?.enabled !== false) {
            const ai = server.ai;
            const toasted = new Set();
            aiSub = createAiSubtitle({
                video: v,
                ai,
                fetchPart: (part, signal) => fetchAiSubtitle(ai.url, part, { signal }),
                retryDelays: PLAYER.aiSubtitle?.retryDelays,
                onState: (s) => {
                    if (my !== token) return;
                    aiShown = true;
                    subNote = aiNote(s, def);
                    const msg = aiToast(s, def);
                    if (msg && !toasted.has(msg.key)) {
                        toasted.add(msg.key);
                        showToast(msg.text, msg.type, msg.duration);
                    }
                    if (state === 'playing') setStatus(statusLine(), 'ok', { quiet: s.phase === 'translating' && !s.first });
                },
            });
            // Mulai saat video BENAR-BENAR diputar (bukan saat halaman dibuka) → kuota hanya untuk penonton.
            v.addEventListener('playing', () => {
                if (my === token) aiSub?.start();
            }, { once: true });
        }
        const loaded = () => {
            if (my !== token || state !== 'loading') return;
            clearTimeout(timer);
            clearTimeout(overlayTimer);
            state = 'playing';
            overlay.remove();
            setStatus(statusLine(), 'ok');
            renderServers();
            emit('loaded', { ep, server });
            v.play().catch(() => { /* autoplay ditolak browser → pengguna menekan play */ });
        };
        markLoaded = loaded;
        v.addEventListener('loadedmetadata', loaded, { once: true });
        v.addEventListener('ended', () => {
            if (my !== token || completedFor === ep) return;
            completedFor = ep;
            emit('complete', { ep, server });
        });
        v.addEventListener('timeupdate', () => {
            if (my !== token || !Number.isFinite(v.duration) || v.duration <= 0) return;
            const pct = clamp01(v.currentTime / v.duration);
            if (Math.abs(pct - lastPct) < 0.02 && pct < 0.99) return;
            lastPct = pct;
            setStatus(statusLine(), 'ok', { quiet: true });
            emit('progress', { ep, percent: pct });
        });

        // Jalur pemutaran:
        //  - Safari/WebKit (macOS & iOS): HLS native langsung dari CDN — media pipeline WebKit tidak butuh CORS,
        //    jadi tanpa proxy (hemat bandwidth); gagal → lewat proxy.
        //  - Safari/WebKit + ManagedMediaSource + episode bersubtitle (iPadOS 17.1+): hls.js (MSE) lewat proxy
        //    supaya <track> WebVTT ikut tampil — 24 Okt 2026, subtitle tidak muncul di Chrome iPad.
        //  - Browser lain: hls.js (MSE) lewat proxy. HLS native Chromium (Chrome ≥141) TIDAK dipakai untuk
        //    URL CDN langsung: diuji 22 Okt 2026, request-nya diblokir (CORS/CORP CDN dikunci ke anizone.to).
        //  - Tanpa MSE tetapi bisa HLS native → native lewat proxy.
        const isHls = server.kind === 'hls';
        const canNative = isHls && Boolean(v.canPlayType(HLS_MIME));
        const appleWebKit = /Apple/.test(navigator.vendor || '') && canNative;
        const hasMse = Boolean(window.MediaSource || window.ManagedMediaSource);
        /**
         * iPadOS 17.1+ (Chrome/Safari — semuanya WebKit) punya ManagedMediaSource, dan HLS
         * native WebKit TIDAK menampilkan <track> WebVTT di dalam pemutar inline. Bila episode
         * membawa subtitle dan MMS tersedia, pakai hls.js (MSE) supaya subtitle benar-benar
         * tampil di Chrome iPad; perangkat tanpa MMS tetap memakai HLS native.
         */
        const preferMseForSubtitles = appleWebKit && hasMse && subs.length > 0;
        const native = (appleWebKit && !preferMseForSubtitles) || (canNative && !hasMse);
        v.dataset.subtitleMode = preferMseForSubtitles ? 'mse' : native ? 'native' : 'mse';
        let usingDirect = isHls && appleWebKit && !preferMseForSubtitles && Boolean(server.direct);
        v.addEventListener('error', () => {
            if (my !== token) return;
            if (usingDirect) {
                // CDN langsung gagal di HLS native → coba lewat proxy sekali
                usingDirect = false;
                v.src = server.url;
                return;
            }
            if (!hls) fail(server, 'video error');
        });

        stage.replaceChildren(v, overlay);
        video = v;
        attachRememberedLocalSubtitle(v);
        setStatus(`Memuat ${server.name} • Episode ${ep}...`);
        overlayTimer = setTimeout(() => {
            if (my === token) overlay.remove();
        }, Math.min(OVERLAY_MAX_MS, PLAYER.loadTimeout));
        timer = setTimeout(() => {
            if (my !== token || state !== 'loading') return;
            if (v.readyState >= 1) loaded();
            else fail(server, 'timeout');
        }, PLAYER.loadTimeout + 5000); // manifest + key + segmen pertama lewat proxy → beri waktu lebih

        if (!isHls) {
            v.dataset.mode = 'native-video';
            v.src = server.url;
            return;
        }
        v.dataset.mode = native ? (usingDirect ? 'native-direct' : 'native-proxy') : 'hlsjs'; // diagnosa (devtools)
        if (native) {
            v.src = usingDirect ? server.direct : server.url;
            return;
        }
        loadHlsJs().then((Hls) => {
            if (my !== token) return;
            if (!Hls.isSupported()) {
                // hls.js tidak jalan di browser ini → kembali ke HLS native bila mungkin,
                // jangan langsung menghabiskan daftar server.
                if (canNative) {
                    v.dataset.mode = 'native-proxy';
                    v.src = server.url;
                    return;
                }
                fail(server, 'browser tidak mendukung HLS');
                return;
            }
            hls = new Hls({ capLevelToPlayerSize: true, maxBufferLength: 30, backBufferLength: 30, enableWorker: true });
            let recovered = false;
            hls.on(Hls.Events.ERROR, (_event, data) => {
                if (my !== token || !data?.fatal) return;
                if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) {
                    recovered = true;
                    hls.recoverMediaError();
                    return;
                }
                fail(server, `hls ${data.details || data.type}`);
            });
            hls.loadSource(server.url);
            hls.attachMedia(v);
        }).catch(() => {
            if (my === token) fail(server, 'hls.js gagal dimuat');
        });
    }

    /** Server berikutnya (melingkar) yang tersedia & belum gagal di episode ini. */
    function nextCandidate(afterId) {
        const list = available();
        const start = list.findIndex((s) => s.id === afterId);
        for (let i = 1; i <= list.length; i++) {
            const s = list[(start + i + list.length) % list.length];
            if (s.id !== afterId && !failed.has(s.id)) return s;
        }
        return null;
    }

    function fail(server, reason) {
        // Mode Aman bisa membuat embed menolak tampil ("Sandboxed our player is not allowed").
        // Playback tetap prioritas: pada kegagalan pertama, sandbox dilepas lalu server yang
        // sama dicoba ulang — server tidak langsung dibuang.
        if (reason === 'timeout' && safeFrame) {
            applySafeFrame(false);
            showToast('Mode Aman dimatikan otomatis: server ini tidak memuat video saat di-sandbox. Mencoba ulang tanpa Mode Aman.', 'info', 8000);
            play(server);
            return;
        }
        const idx = mirror.get(server.id) || 0;
        if (server.mirrors && idx < server.mirrors.length - 1) {
            // Mirror lain dari penyedia yang sama (mis. ReAnime HD-2 → HD-1) dicoba dulu.
            mirror.set(server.id, idx + 1);
            console.warn(`[player] ${server.name} mirror ${idx + 1} gagal (${reason}) — mencoba mirror ${idx + 2}`);
            play(server);
            return;
        }
        failed.add(server.id);
        console.warn(`[player] ${server.name} gagal (${reason}) — episode ${ep}`);
        const next = nextCandidate(server.id);
        if (next) {
            showToast(`${server.name} gagal, mencoba ${next.name}...`, 'info');
            play(next);
        } else {
            exhaust();
        }
    }

    /** Tidak ada server yang bisa dicoba lagi. */
    function exhaust() {
        clearFrame();
        token++;
        state = 'exhausted';
        renderServers();
        const hasAny = available().length > 0;
        stage.replaceChildren(messageEl({
            icon: 'triangle-alert',
            title: 'Streaming Tidak Tersedia',
            text: hasAny
                ? `Semua server gagal memuat Episode ${ep}.`
                : 'ID anime untuk server streaming tidak ditemukan.',
            sub: 'Gunakan platform streaming legal di bawah atau coba server lain',
            actions: [{ label: html`${icon('refresh-cw')} Coba lagi`, className: 'btn-ext btn-ext--retry', onClick: retry }, ...legalActions()],
        }));
        setStatus(`Streaming Episode ${ep} tidak tersedia`, 'error');
        emit('exhausted', { ep, hasAny });
    }

    function retry() {
        failed = new Set();
        const first = available()[0];
        if (first) play(first);
        else emit('retry', { ep }); // tidak ada id → watch.js mencari ulang data anime
    }

    /* ---------------------------------------------------------------- */
    /* postMessage dari player                                           */
    /* ---------------------------------------------------------------- */
    function onMessage(event) {
        if (!frame || (state !== 'loading' && state !== 'playing')) return;
        const server = current();
        if (!server) return;
        const fromFrame = event.source === frame.contentWindow;
        const fromOrigin = Boolean(event.origin) && server.origins.includes(event.origin);
        if (!fromFrame && !fromOrigin) return;

        let data = event.data;
        if (typeof data === 'string') {
            if (data.length > 20000 || !/^\s*\{/.test(data)) return;
            try { data = JSON.parse(data); } catch { return; }
        }
        if (!data || typeof data !== 'object') return;
        const name = String(data.event ?? data.type ?? '').toLowerCase();

        if (COMPLETE_EVENTS.has(name)) {
            if (completedFor === ep) return; // beberapa player mengirim 'complete' berkali-kali
            completedFor = ep;
            emit('complete', { ep, server });
        } else if (PROGRESS_EVENTS.has(name)) {
            const pct = percentOf(data);
            if (pct == null) return;
            if (state === 'loading') markLoaded?.(); // player sudah bicara → anggap termuat
            setStatus(`${server.name} | EP ${ep} | ${Math.round(pct * 100)}%`, 'ok', { quiet: true });
            emit('progress', { ep, percent: pct });
        } else if (name === 'error') {
            fail(server, 'error dari player');
        }
    }
    window.addEventListener('message', onMessage);

    const onLocalSubtitleButtonClick = () => {
        if (!localSubtitleInput) return;
        localSubtitleInput.value = '';
        localSubtitleInput.click();
    };
    const onClearLocalSubtitleClick = () => {
        if (!localSubtitle) return;
        forgetLocalSubtitle();
        showToast('Subtitle lokal dihapus dari pemutar.', 'info');
    };
    localSubtitleButton?.addEventListener('click', onLocalSubtitleButtonClick);
    clearLocalSubtitleButton?.addEventListener('click', onClearLocalSubtitleClick);
    localSubtitleInput?.addEventListener('change', onLocalSubtitleChange);
    updateLocalSubtitleControls();

    /* ---------------------------------------------------------------- */
    /* Klik tombol server                                                */
    /* ---------------------------------------------------------------- */
    delegate(serverBox, 'click', '.server-btn[data-server]', (_event, btn) => {
        const s = byId(btn.dataset.server);
        if (!s) return;
        if (!s.available) {
            showToast(s.pending ? `${s.name} masih dicari, tunggu sebentar…` : `${s.name} tidak tersedia untuk anime ini. Coba server lain.`, 'info');
            return;
        }
        failed.delete(s.id);
        mirror.delete(s.id);
        play(s);
        showToast(`Server: ${s.name}`, 'success');
    });

    /* ---------------------------------------------------------------- */
    /* API publik                                                        */
    /* ---------------------------------------------------------------- */
    return {
        /** Status saat ini (idle | waiting | loading | playing | exhausted | message). */
        get state() { return state; },
        get serverId() { return currentId; },
        get episode() { return ep; },
        hasServers: () => available().length > 0,

        /**
         * URL pemutar eksternal untuk server yang sedang dipakai (putaran 8).
         * Dipakai tombol "Pemutar Eksternal": embed dibuka di tab baru sehingga iklan host
         * tidak bisa membuka/membajak tab Kazanime. `kind: 'hls'/'video'` memakai URL media
         * langsungnya (bisa dibuka di tab baru juga).
         * @returns {string|null}
         */
        externalUrl() {
            const active = current();
            if (!active) return null;
            const url = active.kind === 'hls' || active.kind === 'video'
                ? (active.direct || urlOf(active))
                : urlOf(active);
            return /^https?:\/\//i.test(String(url || '')) ? url : null;
        },
        /** Nama server aktif (untuk label tombol pemutar eksternal). */
        currentServerName: () => current()?.name || '',

        /** Mode Aman (sandbox tanpa pop-up) sedang aktif? */
        isSafeFrame: () => safeFrame,

        /**
         * Nyalakan/matikan Mode Aman. Iframe yang sedang tampil langsung diperbarui;
         * bila embed menolak sandbox (video tidak muncul), panggil lagi dengan `false`.
         * @param {boolean} on
         * @returns {boolean} nilai baru
         */
        setSafeFrame: (on) => applySafeFrame(on),

        /**
         * Putar episode dengan daftar server baru. Server pilihan user sebelumnya
         * dipakai lebih dulu bila tersedia (pindah episode tidak mereset pilihan server).
         * @param {number} episode
         * @param {StreamServer[]} list
         */
        load(episode, list) {
            if (episode !== ep) forgetLocalSubtitle();
            ep = episode;
            servers = keepPlayable(list);
            failed = new Set();
            mirror = new Map();
            const first = (currentId && byId(currentId)?.available ? byId(currentId) : null) || available()[0];
            if (first) play(first);
            else exhaust();
        },

        /**
         * Perbarui daftar server TANPA memutus video yang sedang berjalan
         * (mis. id AniList baru diketahui, atau server backend datang belakangan).
         * Jika player sedang menunggu / semua server gagal, server baru langsung dicoba.
         * @param {StreamServer[]} list
         */
        setServers(list) {
            servers = keepPlayable(list);
            if (state === 'loading' || state === 'playing') {
                const cur = current();
                if (cur?.available) {
                    renderServers();
                    return;
                }
            }
            if (state === 'loading' || state === 'playing' || state === 'waiting' || state === 'idle' || state === 'exhausted') {
                const next = available().find((s) => !failed.has(s.id));
                if (next) play(next);
                else if (state !== 'exhausted') exhaust();
                else renderServers();
                return;
            }
            renderServers(); // state 'message': hanya perbarui tombol
        },

        /** Tombol "⟳ Server Lain": server berikutnya secara melingkar (termasuk yang tadi gagal). */
        nextServer() {
            const list = available();
            if (!list.length) {
                showToast('Tidak ada server yang tersedia untuk anime ini.', 'info');
                return;
            }
            const index = list.findIndex((s) => s.id === currentId);
            const next = list[(index + 1) % list.length];
            failed.delete(next.id);
            play(next);
            showToast(list.length > 1 ? `Server: ${next.name}` : `Memuat ulang ${next.name}`, 'success');
        },

        /** Tampilkan "menunggu" (mis. sedang mencari id anime). */
        showWaiting(text) {
            clearFrame();
            token++;
            state = 'waiting';
            stage.replaceChildren(messageEl({ spinner: true, text }));
            setStatus(text);
        },

        /**
         * Pesan bebas di area player (mis. anime belum tayang / tidak ditemukan).
         * @param {{icon?:string,title?:string,text?:string,sub?:string,actions?:{label:string,href?:string,newTab?:boolean,onClick?:()=>void,className?:string}[], legal?: boolean, statusText?: string}} msg
         */
        showMessage({ legal = false, statusText: st, ...msg }) {
            clearFrame();
            token++;
            state = 'message';
            renderServers();
            stage.replaceChildren(messageEl({ ...msg, actions: [...(msg.actions || []), ...(legal ? legalActions() : [])] }));
            setStatus(st || msg.title || '', 'error');
        },

        /**
         * @param {'loaded'|'complete'|'progress'|'exhausted'|'retry'|'servers'|'adblock'|'adguide'|'safeFrame'} name
         * @param {(detail: any) => void} fn
         */
        on(name, fn) {
            handlers[name]?.add(fn);
            return () => handlers[name]?.delete(fn);
        },

        /** Hentikan & lepaskan listener (tidak dipakai di watch.html, disediakan untuk kebersihan). */
        destroy() {
            clearFrame();
            forgetLocalSubtitle();
            token++;
            window.removeEventListener('message', onMessage);
            localSubtitleButton?.removeEventListener('click', onLocalSubtitleButtonClick);
            clearLocalSubtitleButton?.removeEventListener('click', onClearLocalSubtitleClick);
            localSubtitleInput?.removeEventListener('change', onLocalSubtitleChange);
            if (localSubtitleInput) localSubtitleInput.value = '';
        },
    };
}
