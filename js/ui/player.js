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
 *  - Server dengan `mirrors` (beberapa URL penyedia yang sama) mencoba mirror berikutnya sebelum pindah server.
 *  - Slot penyedia yang belum selesai dicari (`pending`) tampil "mencari…".
 *  - "Subtitle Indonesia (AI)": bila server HLS tidak punya subtitle Indonesia dan backend menawarkannya
 *    (`server.ai`), subtitle Inggris diterjemahkan Gemini saat video mulai diputar (ui/ai-subtitle.js).
 *    Track AI tampil otomatis & subtitle bawaan disembunyikan; subtitle asli tetap bisa dipilih di menu subtitle
 *    player (ikon CC di Firefox/Safari, menu titik tiga → Captions di Chrome).
 *  - Subtitle lokal `.srt`/`.vtt` hanya untuk video HLS/native: dikonversi/dipasang di browser sebagai Blob URL,
 *    tidak diunggah; track & object URL dibersihkan saat source berganti dan file dilupakan saat episode berganti.
 *
 * Putaran 12 (24 Okt 2026) — iklan, tab baru, dan layar penuh:
 *  - **Penahan pop-up selalu aktif** (bukan mode/tombol): iframe embed dipasang dengan sandbox
 *    tanpa `allow-popups`/`allow-top-navigation*` → `window.open()` iklan gagal total (tidak ada
 *    tab baru) dan tab Kazanime tidak bisa dibajak.
 *  - **Tidak ada tawaran melepas pengaman** (putaran 13, 24 Okt 2026): tautan
 *    "Muat ulang tanpa pengaman" dihapus karena sekali diklik iklan langsung bisa membuka tab
 *    lagi (dan host itu diingat tanpa sandbox sampai tab ditutup). Sekarang sandbox TIDAK PERNAH
 *    dilepas: bila sebuah embed menolak berjalan di dalam sandbox, iframe tidak mengirim `load`
 *    dalam `PLAYER.loadTimeout` → server itu dianggap gagal dan server berikutnya dicoba dengan
 *    perlindungan tetap aktif. Tidak ada jalur kode yang menghapus atribut sandbox.
 *  - **Layar penuh standar player**: `requestFullscreen` pada wadah player + kunci orientasi
 *    lanskap (Android), fallback fullscreen `<video>` (iOS). Tombol keluar + kontrol tetap
 *    tersedia; `Esc`/gestur peramban tetap bekerja.
 *  - Deteksi iklan yang memindahkan pemutar tetap ada (bilah "Pulihkan pemutar").
 *
 * Putaran 15 (24 Okt 2026) — sandbox hanya untuk server Sub Indo:
 *  - Pengguna menemukan penyebab video Sub Eng tidak muncul: *"server Yang sub English tidak boleh
 *    ada sandbox … untuk semua server selain dari anime ku dan oploverz ada tombol matikan fitur
 *    block nya khusus server luar seperti anilist dan kitsu"*.
 *  - Jadi sandbox dipasang **hanya** untuk server dari AnimeKu & Oploverz (Sub Indo). Server luar
 *    (AniList/Kitsu: MegaPlay, Vidnest, TryEmbed; juga embed scraping lain) dimuat **tanpa sandbox**
 *    supaya embed yang menolak sandbox tetap bisa diputar.
 *  - Sebagai gantinya, server luar mendapat tombol **"Matikan blokir"** di baris kontrol player:
 *    mematikan lapisan anti-iklan untuk server itu saja (diingat di `kz:adblock-off`).
 *
 * Putaran 24 (25 Okt 2026) — pengguna: *"di animeku kepotong tolong perbaiki dan sediakan tombol
 * blokir di animeku dan animeloverz juga"*:
 *  - Tombol **"Matikan blokir"** kini juga tampil untuk server Sub Indo (AnimeKu & Oploverz).
 *    Yang dimatikan hanya lapisan anti-iklan Kazanime; **sandbox tetap dipasang penuh** (tanpa
 *    `allow-popups`/`allow-top-navigation`), jadi iklan tetap tidak bisa membuka tab baru.
 *  - Kotak player dipaksa 16:9 oleh `aspect-ratio` (lihat css/watch.css) supaya pemutar tidak
 *    lagi memanjang/terpotong seperti laporan "kepotong".
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
    try {
        // "Mode Aman" (putaran 11) dihapus di putaran 12 — penahan pop-up kini selalu aktif.
        window.localStorage?.removeItem(STORAGE_KEYS.legacySafeFrame);
    } catch {
        // sama: tidak ada yang rusak bila gagal
    }
    try {
        // Putaran 13: daftar host "tanpa sandbox" dari versi sebelumnya dibuang. Kalau tidak,
        // host yang dulu pernah dilepas tetap dimuat tanpa penahan pop-up → iklan kembali muncul.
        window.localStorage?.removeItem(STORAGE_KEYS.legacyNoSandbox);
        window.sessionStorage?.removeItem(STORAGE_KEYS.legacyNoSandbox);
    } catch {
        // sama: tidak ada yang rusak bila gagal
    }
}
dropLegacyGuardFlag();

/* ------------------------------------------------------------------ */
/* Penahan pop-up (server Sub Indo) & layar penuh                      */
/* ------------------------------------------------------------------ */
/**
 * Terapkan kebijakan iframe pada server Sub Indo (AnimeKu & Oploverz).
 *
 * Putaran 13 (24 Okt 2026): pengguna meminta tawaran pelepas dihapus (membuat iklan keluar lagi),
 * jadi host memory `kz:no-sandbox` dan tautan pelepas dibuang. Untuk server Sub Indo sandbox tetap
 * dipasang dan tetap tidak bisa dilepas.
 *
 * Putaran 15 (24 Okt 2026): fungsi ini TIDAK dipanggil untuk server luar (AniList/Kitsu: MegaPlay,
 * Vidnest, TryEmbed) — mereka dimuat tanpa sandbox karena embed Sub Eng menolak sandbox. Penggantinya
 * tombol "Matikan blokir" per server (lihat `syncAdBlockToggle`).
 * @param {HTMLIFrameElement} iframe
 */
function applyFramePolicy(iframe) {
    // `iframe.sandbox` adalah DOMTokenList (PutForwards=value) → setara atribut sandbox.
    iframe.sandbox.value = PLAYER.frameGuard.policy;
    iframe.dataset.frameGuard = 'on';
}

/**
 * Putaran 19 (24 Okt 2026) — *"perkuat lagi untuk yang di animeku"*.
 *
 * Sandbox lebih ketat untuk situs di `PLAYER.frameGuard.strictSources` (AnimeKu): formulir
 * tersembunyi (`allow-forms`) dan unduhan otomatis (`allow-downloads`) dibuang, karena keduanya
 * jalur klasik lapisan iklan untuk membuka tab/jendela baru. Token yang dibutuhkan pemutar
 * (scripts, same-origin, presentation, orientasi) tetap dipasang supaya video tetap berputar.
 * Oploverz tetap memakai `policy` dasar — pola iklan kedua situs tetap SATU daftar yang sama.
 * @param {HTMLIFrameElement} iframe
 */
function applyStrictFramePolicy(iframe) {
    iframe.sandbox.value = PLAYER.frameGuard.strictPolicy || PLAYER.frameGuard.policy;
    iframe.dataset.adStrict = 'on';
}

/** Situs yang memakai sandbox & penanganan iklan lebih ketat (putaran 19: AnimeKu). */
function isStrictAdServer(server) {
    return (PLAYER.frameGuard?.strictSources || []).includes(siteOf(server))
        || (PLAYER.adTakeover?.strictSources || []).includes(siteOf(server));
}

/* ------------------------------------------------------------------ */
/* Sandbox: hanya untuk server Sub Indo (putaran 15)                   */
/* ------------------------------------------------------------------ */
/** Situs asal server: `backend:animeku` → `animeku`; server statis/AniList → `static`. */
function siteOf(server) {
    return String(server?.source || '').replace(/^backend:/, '').split('~')[0].toLowerCase();
}

/**
 * Server Sub Indo (AnimeKu & Oploverz)?
 * Hanya kelompok ini yang dipasang sandbox — lihat `PLAYER.frameGuard.subIndoSources`.
 * @param {{source?: string}|null} server
 */
function isSubIndoServer(server) {
    return (PLAYER.frameGuard.subIndoSources || []).includes(siteOf(server));
}

/**
 * Server luar (bukan AnimeKu/Oploverz) yang tampil sebagai iframe — AniList/Kitsu (MegaPlay,
 * Vidnest, TryEmbed) dan embed scraping bahasa lain. Server HLS/native tidak dihitung
 * karena tidak memakai iframe maupun sandbox.
 * @param {{source?: string, kind?: string}|null} server
 */
function isExternalServer(server) {
    if (!isFrameServer(server)) return false;
    return !isSubIndoServer(server);
}

/**
 * Server yang dimuat sebagai iframe (bukan HLS/video bawaan). Hanya kelompok ini yang punya
 * lapisan anti-iklan, jadi hanya mereka yang boleh menampilkan tombol blokir (putaran 24).
 * @param {{kind?: string}|null} server
 */
function isFrameServer(server) {
    return Boolean(server) && server.kind !== 'hls' && server.kind !== 'video';
}

/** Batas jumlah server yang pilihannya diingat (localStorage tetap kecil). */
const AD_BLOCK_OFF_LIMIT = PLAYER.externalGuard?.maxServers || 40;

/* ------------------------------------------------------------------ */
/* Ingatan "iklannya berulang" antar-halaman (putaran 19)             */
/* ------------------------------------------------------------------ */
/** Batas jumlah situs yang diingat (localStorage tetap kecil). */
const AD_REPEAT_LIMIT = 10;

/**
 * Situs bertanda yang masih berlaku: `{ [site]: kedaluwarsaMs }`, hanya untuk
 * `PLAYER.adTakeover.persistSources`. Entri kedaluwarsa dibuang saat dibaca.
 * @returns {{[site: string]: number}}
 */
function readAdRepeatBlock() {
    const raw = storage.get(STORAGE_KEYS.adRepeatBlock, {});
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const now = Date.now();
    const out = {};
    for (const [site, expires] of Object.entries(raw)) {
        // Hanya situs yang izinkan disimpan + belum kedaluwarsa.
        if (!(PLAYER.adTakeover?.persistSources || []).includes(site)) continue;
        const at = Number(expires);
        if (!Number.isFinite(at) || at <= now) continue;
        out[site] = at;
    }
    return out;
}

/** Nama situs yang sedang ditandai karena iklannya berulang (antar-halaman). */
function readAdRepeatSites() {
    return Object.keys(readAdRepeatBlock());
}

/**
 * Ingat bahwa situs ini berulang iklannya (hanya situs di `persistSources`).
 * @param {string} site
 */
function rememberAdRepeatSite(site) {
    if (!site || !(PLAYER.adTakeover?.persistSources || []).includes(site)) return;
    const all = readAdRepeatBlock();
    delete all[site];
    all[site] = Date.now() + (PLAYER.adTakeover?.persistMs || 21600000);
    const sites = Object.keys(all);
    if (sites.length > AD_REPEAT_LIMIT) {
        for (const stale of sites.slice(0, sites.length - AD_REPEAT_LIMIT)) delete all[stale];
    }
    storage.set(STORAGE_KEYS.adRepeatBlock, all);
}

/** Lepas tanda situs (dipakai saat pengguna meminta coba lagi / server terbukti sehat). */
function forgetAdRepeatSite(site) {
    const all = readAdRepeatBlock();
    if (!(site in all)) return;
    delete all[site];
    storage.set(STORAGE_KEYS.adRepeatBlock, all);
}

/** @returns {Record<string, true>} server luar yang blokir iklannya dimatikan pengguna. */
function readAdBlockOff() {
    const raw = storage.get(STORAGE_KEYS.adBlockOff, {});
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

/** @param {string|null} serverId */
function isAdBlockOff(serverId) {
    return Boolean(serverId) && readAdBlockOff()[serverId] === true;
}

/** @param {string} serverId @param {boolean} off */
function writeAdBlockOff(serverId, off) {
    const all = readAdBlockOff();
    if (off) all[serverId] = true;
    else delete all[serverId];
    const keys = Object.keys(all);
    if (keys.length > AD_BLOCK_OFF_LIMIT) {
        for (const stale of keys.slice(0, keys.length - AD_BLOCK_OFF_LIMIT)) delete all[stale];
    }
    storage.set(STORAGE_KEYS.adBlockOff, all);
}

/**
 * Status blokir untuk satu server (putaran 15, diperluas putaran 24).
 *  - Server HLS/native: selalu aktif (tidak memakai iframe/lapisan ini).
 *  - Server Sub Indo (AnimeKu & Animeloverz): mengikuti pilihan pengguna, bawaan
 *    `PLAYER.subIndoGuard.shieldDefault`. Sandbox TIDAK ikut dimatikan.
 *  - Server luar: mengikuti pilihan pengguna; bila belum pernah dipilih, dipakai
 *    `PLAYER.externalGuard.shieldDefault`.
 * @param {{id?: string, source?: string, kind?: string}|null} server
 * @returns {boolean} true = blokir/lapisan anti-iklan aktif
 */
function adBlockEnabled(server) {
    if (!server) return false;
    if (!isFrameServer(server)) return true;
    const saved = readAdBlockOff();
    if (Object.prototype.hasOwnProperty.call(saved, server.id)) return saved[server.id] !== true;
    if (isSubIndoServer(server)) return PLAYER.subIndoGuard?.shieldDefault !== false;
    return PLAYER.externalGuard?.shieldDefault !== false;
}

/* ------------------------------- layar penuh ------------------------------ */
const FULLSCREEN_EVENTS = ['fullscreenchange', 'webkitfullscreenchange'];

/**
 * Kunci orientasi lanskap saat layar penuh (Android Chrome/Firefox).
 * @returns {Promise<boolean>} true bila peramban benar-benar mengunci orientasi.
 */
function lockLandscape() {
    if (!PLAYER.fullscreen?.lockOrientation) return Promise.resolve(false);
    try {
        const orientation = screen.orientation;
        if (!orientation?.lock) return Promise.resolve(false);
        const result = orientation.lock(PLAYER.fullscreen?.orientation || 'landscape');
        return Promise.resolve(result).then(() => true).catch(() => false);
    } catch {
        // peramban menolak (bukan fullscreen / iOS) → pakai rotasi CSS
        return Promise.resolve(false);
    }
}

/**
 * Rotasi CSS 90° sebagai pengganti kunci orientasi (iOS Safari, Samsung Internet, Firefox
 * Android yang menolak `screen.orientation.lock`). Tanpa ini tombol "Layar Penuh" hanya
 * memperbesar video tegak di ponsel — keluhan pengguna "saat full screen dia tidak rotate".
 * @param {HTMLElement} target wadah player
 * @param {boolean} active sedang layar penuh?
 * @param {boolean} locked orientasi sudah dikunci peramban?
 */
function rotateFallback(target, active, locked) {
    if (!target) return;
    const portrait = window.innerHeight > window.innerWidth;
    target.dataset.fsLocked = locked ? '1' : '0';
    target.classList.toggle('is-fs-rotated', Boolean(active && !locked && portrait));
}

function unlockOrientation() {
    try {
        screen.orientation?.unlock?.();
    } catch {
        // tidak didukung
    }
}

const isFullscreenApiAvailable = () => Boolean(
    document.fullscreenEnabled
    || document.webkitFullscreenEnabled
    || Element.prototype.requestFullscreen
    || Element.prototype.webkitRequestFullscreen,
);

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
 *   adBlockBtn?: HTMLButtonElement,  tombol "Matikan blokir" untuk server luar (#btnAdBlockToggle)
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
    adBlockBtn = null,
}) {
    /** @type {Record<string, Set<Function>>} */
    const handlers = { loaded: new Set(), complete: new Set(), progress: new Set(), exhausted: new Set(), retry: new Set(), servers: new Set(), adblock: new Set(), adguide: new Set(), fullscreen: new Set(), retrysubindo: new Set() };
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
    /**
     * id server → indeks opsi (mirror) yang dipakai.
     *
     * Putaran 25 (25 Okt 2026): pilihan opsi situs (mis. Oploverz `HD-1` / `HD-2`) **diingat**
     * per server di localStorage `kz:mirror`, jadi berpindah episode tidak mengembalikannya ke
     * opsi pertama. Nilai di memori tetap dipakai lebih dulu (perubahan sesi ini).
     */
    const MIRROR_LIMIT = PLAYER.externalGuard?.maxServers || 40;
    function readMirrorChoice() {
        const raw = storage.get(STORAGE_KEYS.mirrorChoice, {});
        return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    }
    function writeMirrorChoice(serverId, index) {
        if (!serverId) return;
        const all = readMirrorChoice();
        if (Number.isInteger(index) && index > 0) all[serverId] = index;
        else delete all[serverId];
        const keys = Object.keys(all);
        if (keys.length > MIRROR_LIMIT) {
            for (const stale of keys.slice(0, keys.length - MIRROR_LIMIT)) delete all[stale];
        }
        storage.set(STORAGE_KEYS.mirrorChoice, all);
    }
    /** Indeks opsi satu server (memori sesi → localStorage → 0). */
    function optionIndex(server) {
        if (!server) return 0;
        if (mirror.has(server.id)) return mirror.get(server.id) || 0;
        const saved = Number(readMirrorChoice()[server.id]);
        const max = Array.isArray(server.options) ? server.options.length : Array.isArray(server.mirrors) ? server.mirrors.length : 1;
        return Number.isInteger(saved) && saved >= 0 && saved < max ? saved : 0;
    }
    let mirror = new Map();
    const urlOf = (server) => server.mirrors?.[optionIndex(server)] || server.url;
    let timer = 0;
    let overlayTimer = 0;
    /** @type {HTMLElement|null} lapisan anti-iklan di atas iframe (putaran 8) */
    let adShield = null;
    /** @type {HTMLElement|null} bilah pemulihan saat iklan memindahkan pemutar (putaran 11) */
    let adRecovery = null;
    /** Waktu load terakhir (ms) — menahan event `load` ganda dari peramban. */
    let lastFrameLoadAt = 0;
    /**
     * Putaran 18: server yang iklannya terbukti muncul BERULANG (popup yang sama kembali setelah
     * ditutup). Server tetap tampil di daftar dan bisa dipilih manual, tetapi tidak dipilih
     * otomatis lagi selama sesi ini — supaya popup yang sama tidak muncul lagi.
     * @type {Set<string>}
     */
    const adBlocked = new Set();
    /** id server → waktu (ms) pembajakan iklan; dipakai mengenali "popup yang sama". */
    const adTakeovers = new Map();
    /**
     * Putaran 19: situs yang iklannya berulang dan diingat antar-halaman (khusus
     * `PLAYER.adTakeover.persistSources`, yaitu AnimeKu). Isinya nama situs (`animeku`), bukan id
     * server, supaya tetap berlaku saat daftar server episode berikutnya berubah.
     * @type {Set<string>}
     */
    const adBlockedSites = new Set(readAdRepeatSites());
    /** id server → waktu (ms) popup lewat kehilangan fokus (putaran 19). */
    const popupEvents = new Map();
    /** Waktu (ms) pemutaran server aktif dimulai — dipakai membatasi pengawasan popup. */
    let playStartedAt = 0;
    /** Waktu pembajakan terakhir — mencegah popup yang sama dihitung dua kali. */
    let lastTakeoverAt = 0;
    /** Situs yang sudah diberi tahu "dilewati otomatis" pada sesi ini. */
    const rememberedNotified = new Set();
    /** Waktu (ms) tab baru dibuka oleh Kazanime sendiri (tombol Pemutar Eksternal). */
    let ownTabAt = 0;
    /** Timer pelepasan tanda setelah server bertanda berputar normal (putaran 19). */
    let healthyTimer = 0;
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

    /* ---------------- ingatan popup iklan (putaran 18) ---------------- */
    /** Jendela waktu untuk menganggap dua pembajakan sebagai "popup yang sama". */
    const adRepeatWindow = () => PLAYER.adTakeover?.repeatWindowMs || 120000;

    /** Catat pembajakan untuk satu server; hasilnya = jumlah pembajakan dalam jendela waktu. */
    function noteAdTakeover(serverId) {
        const now = Date.now();
        const list = (adTakeovers.get(serverId) || []).filter((at) => now - at < adRepeatWindow());
        list.push(now);
        adTakeovers.set(serverId, list.slice(-8));
        return list.length;
    }

    /** Server ini sudah membajak pemutar dalam jendela waktu sekarang? */
    const adRepeatSeen = (serverId) => (adTakeovers.get(serverId) || []).some((at) => Date.now() - at < adRepeatWindow());

    /**
     * Putaran 19: server ini dilewati otomatis? Dua sumber:
     *  1. `adBlocked` — id server yang membajak pada sesi ini (putaran 18);
     *  2. `adBlockedSites` — situs (AnimeKu) yang iklannya berulang, diingat antar-halaman.
     * Server tetap tampil & tetap bisa dipilih manual (permintaan putaran 16).
     * @param {StreamServer|null} server
     */
    function autoBlocked(server) {
        if (!server) return false;
        return adBlocked.has(server.id) || adBlockedSites.has(siteOf(server));
    }

    /** Batas pembajakan untuk server ini: AnimeKu lebih ketat (putaran 19). */
    const adTakeoverLimit = (server) => (isStrictAdServer(server)
        ? (PLAYER.adTakeover?.strictMaxTakeovers || 1)
        : (PLAYER.adTakeover?.maxTakeovers || 2));

    /**
     * Tandai server aktif sebagai "iklannya berulang", lepas bilah pemulihan, lalu pindah ke
     * server bersih berikutnya. Dipakai jalur navigasi-ulang iframe (putaran 18) DAN jalur
     * popup yang mencuri fokus (putaran 19).
     * @param {StreamServer} active
     * @param {{count?: number, popup?: boolean}} [opts]
     */
    function blockActiveServer(active, { count = 1, popup = false } = {}) {
        removeAdRecovery();
        failed.add(active.id);
        if (PLAYER.adTakeover?.blockRepeatServer !== false) adBlocked.add(active.id);
        adTakeovers.delete(active.id);
        popupEvents.delete(active.id);
        // Putaran 19: AnimeKu diingat antar-halaman supaya popup yang sama tidak menyambut lagi.
        rememberAdRepeatSite(siteOf(active));
        if ((PLAYER.adTakeover?.persistSources || []).includes(siteOf(active))) adBlockedSites.add(siteOf(active));
        emit('adblock', { type: 'skipped', server: active, count, repeat: true, popup });
        const next = available().find((item) => item.id !== active.id && !failed.has(item.id) && !autoBlocked(item));
        if (next) {
            play(next);
            return true;
        }
        setStatus('Iklan muncul lagi di server ini. Pilih server lain atau Pemutar Eksternal.', 'error');
        mountAdRecovery(token);
        return false;
    }

    /**
     * Putaran 19 — pengawas popup lewat kehilangan fokus (khusus `PLAYER.popupWatch.sources`).
     *
     * Popup/jendela iklan selalu mencuri fokus tab ini lalu mengembalikannya saat ditutup.
     * Tab yang BENAR-BENAR ditinggalkan pengguna tidak dihitung (`visibilityState` bukan
     * 'visible'), durasi blur dibatasi, dan tanda baru dipasang setelah `maxEvents` kejadian
     * dalam `windowMs` — supaya pindah aplikasi sekali tidak menghukum server.
     */
    function notePopupSignal() {
        const watch = PLAYER.popupWatch;
        const active = current();
        if (!watch || watch.enabled === false || !active) return;
        if (!(watch.sources || []).includes(siteOf(active))) return;
        if (state !== 'loading' && state !== 'playing') return;
        // Popup iklan muncul saat pemutar memuat / barusan dimulai — bukan menit-menit kemudian.
        if (!playStartedAt || Date.now() - playStartedAt > (watch.startWindowMs || 45000)) return;
        const now = Date.now();
        const list = (popupEvents.get(active.id) || []).filter((at) => now - at < (watch.windowMs || 120000));
        list.push(now);
        popupEvents.set(active.id, list.slice(-6));
        if (list.length < (watch.maxEvents || 2)) return;
        blockActiveServer(active, { count: list.length, popup: true });
    }

    /* Popup yang lolos sebagai jendela baru terdeteksi dari blur → focus saat pemutar memuat. */
    let blurAt = 0;
    const onWindowBlur = () => {
        blurAt = 0;
        const watch = PLAYER.popupWatch;
        const active = current();
        if (!watch || watch.enabled === false || !active) return;
        if (!(watch.sources || []).includes(siteOf(active))) return;
        // Pindah tab / aplikasi: dokumen tidak lagi terlihat → bukan popup iklan.
        if (typeof document !== 'undefined' && document.visibilityState && document.visibilityState !== 'visible') return;
        if (Date.now() - lastTakeoverAt < 1500) return; // sudah dihitung sebagai pembajakan iframe
        // Tab baru yang KITA buka sendiri (Pemutar Eksternal) juga mencuri fokus → bukan popup iklan.
        if (ownTabAt && Date.now() - ownTabAt < 6000) return;
        blurAt = Date.now();
    };
    const onWindowFocus = () => {
        if (!blurAt) return;
        const duration = Date.now() - blurAt;
        blurAt = 0;
        const watch = PLAYER.popupWatch || {};
        if (duration < (watch.minBlurMs || 350) || duration > (watch.maxBlurMs || 60000)) return;
        notePopupSignal();
    };
    window.addEventListener('blur', onWindowBlur);
    window.addEventListener('focus', onWindowFocus);

    /**
     * Putaran 19: server bertanda yang berhasil berputar normal selama `healthyClearMs` tidak
     * dihukum selamanya — tanda sesi & ingatan antar-halaman dilepas. Ini juga pemulih otomatis
     * bila pengawas popup salah menandai (mis. pengguna sempat membuka aplikasi lain).
     * @param {StreamServer} server
     */
    function armHealthyClear(server) {
        clearTimeout(healthyTimer);
        healthyTimer = 0;
        if (!autoBlocked(server)) return;
        healthyTimer = setTimeout(() => {
            if (current()?.id !== server.id || (state !== 'playing' && state !== 'loading')) return;
            adBlocked.delete(server.id);
            adBlockedSites.delete(siteOf(server));
            forgetAdRepeatSite(siteOf(server));
            renderServers();
        }, PLAYER.adTakeover?.healthyClearMs || 20000);
    }

    /**
     * Pilih server otomatis: lewati server ber-popup berulang (sesi & antar-halaman) **dan**
     * server yang sudah gagal. Server yang ditandai tetap bisa dipilih manual lewat tombolnya.
     * @param {StreamServer[]} list
     * @param {{skipFailed?: boolean, afterId?: string}} [opts]
     */
    function pickAuto(list, { skipFailed = false } = {}) {
        const usable = list.filter((s) => !autoBlocked(s));
        return usable.find((s) => !skipFailed || !failed.has(s.id)) || null;
    }

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
        clearTimeout(healthyTimer);
        healthyTimer = 0;
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
        // Putaran 15: server luar yang blokirnya dimatikan pengguna tidak diberi lapisan ini.
        if (!adBlockEnabled(current())) return;
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
                <button type="button" class="player-ad-recovery-btn player-ad-recovery-btn--ghost" data-ad-action="guide">Cara blokir iklan</button>
            </span>`);
        bar.addEventListener('click', (event) => {
            const btn = event.target instanceof Element ? event.target.closest('[data-ad-action]') : null;
            if (!btn) return;
            const action = btn.getAttribute('data-ad-action');
            if (action === 'restore') {
                if (!active) return;
                // Putaran 18: memuat ulang embed yang sudah membajak = memunculkan popup yang sama.
                // Bila server ini sudah membajak sekali, pindah ke server lain yang belum ditandai.
                if (adRepeatSeen(active.id) || autoBlocked(active)) {
                    adBlocked.add(active.id);
                    failed.add(active.id);
                    rememberAdRepeatSite(siteOf(active));
                    if ((PLAYER.adTakeover?.persistSources || []).includes(siteOf(active))) adBlockedSites.add(siteOf(active));
                    const clean = available().find((item) => item.id !== active.id && !failed.has(item.id) && !autoBlocked(item));
                    emit('adblock', { type: 'recover', server: active, next: clean || null });
                    if (clean) {
                        play(clean);
                        return;
                    }
                }
                play(active);
            } else if (action === 'next') {
                nextServer();
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
     *
     * Putaran 18 (24 Okt 2026) — permintaan pengguna untuk AnimeKu & Oploverz: popup yang sama
     * muncul lagi setelah ditutup. Karena itu pembajakan dihitung PER SERVER dalam jendela waktu
     * (`PLAYER.adTakeover.repeatWindowMs`): begitu batas tercapai, server ditandai `adBlocked`,
     * bilah pemulihan dilepas, dan pemutar pindah ke server lain. Server bertanda tidak dipilih
     * otomatis lagi selama sesi (bisa dipilih manual) dan tombol "Pulihkan pemutar" tidak lagi
     * memuat ulang embed yang sama — memuat ulang justru memunculkan popup yang sama.
     * @param {number} my token pemutaran
     */
    function noteFrameReload(my) {
        if (my !== token) return;
        const now = Date.now();
        // Sebagian peramban memicu `load` dua kali untuk dokumen yang sama → abaikan duplikat.
        const duplicate = lastFrameLoadAt && now - lastFrameLoadAt < (PLAYER.adTakeover?.ignoreWithinMs || 1200);
        lastFrameLoadAt = now;
        if (duplicate) return;
        const active = current();
        if (!active) return;
        // Putaran 18: hitung pembajakan per server. "Popup yang sama" = server yang sama membajak
        // lagi dalam jendela waktu — jangan pernah memuat ulang embed itu otomatis.
        const count = noteAdTakeover(active.id);
        lastTakeoverAt = Date.now();
        // Putaran 19: untuk AnimeKu lapisan anti-iklan dipasang LAGI setiap kali iframe membajak,
        // supaya klik berikutnya tidak diteruskan ke embed yang sedang menampilkan iklan — juga
        // saat tidak ada server lain sehingga pemutar tetap di sini.
        if (PLAYER.adTakeover?.strictRemountShield !== false && isStrictAdServer(active)) mountAdShield(my);
        // Putaran 19: AnimeKu lebih ketat — pembajakan PERTAMA sudah cukup untuk dilewati.
        const limit = adTakeoverLimit(active);
        // Server yang sudah pernah memunculkan popup (dipilih manual oleh pengguna) langsung
        // dipindahkan pada pembajakan pertama — popup yang sama tidak diberi kesempatan kedua.
        if (!autoBlocked(active) && count < limit) {
            emit('adblock', { type: 'takeover', server: active, count });
            mountAdRecovery(my);
            return;
        }
        // Popup kembali setelah ditutup (atau membajak berulang) → tandai server, jangan ulangi.
        blockActiveServer(active, { count });
    }

    /**
     * Putaran 19: beri tahu sekali per sesi bila AnimeKu dilewati otomatis karena ingatan
     * antar-halaman (iklannya berulang di perangkat ini). Tombolnya tetap ada & tetap bisa diklik.
     */
    function notifyRemembered() {
        for (const site of adBlockedSites) {
            if (rememberedNotified.has(site)) continue;
            if (!servers.some((s) => siteOf(s) === site && s.available && !s.placeholder)) continue;
            rememberedNotified.add(site);
            const name = PLAYER.siteLabels?.[site] || site;
            emit('adblock', { type: 'remembered', site, name });
            return;
        }
    }

    /**
     * Tombol satu server.
     * @param {StreamServer} s
     */
    function serverButton(s, currentIdValue) {
        const active = s.id === currentIdValue && (state === 'loading' || state === 'playing');
        const isFailed = failed.has(s.id);
        // Putaran 16: placeholder Sub Indo (sumber tidak terjangkau) tetap tampil & bisa diklik.
        const offline = Boolean(s.placeholder);
        const cls = ['server-btn', active ? 'active' : '', s.available ? '' : 'is-disabled', isFailed ? 'is-failed' : '', offline ? 'is-offline' : ''].filter(Boolean).join(' ');
        const lock = s.pending
            ? html` <span class="server-badge server-badge--pending">mencari…</span>`
            : s.available || offline ? '' : html` <span class="server-lock" aria-label="tidak tersedia">${ICON_LOCK}</span>`;
        const offlineBadge = offline
            ? html` <span class="server-badge server-badge--offline" title="Klik untuk mencari ulang">tidak terjangkau</span>`
            : '';
        // Putaran 11: host yang ada di daftar blokir iklan diberi tanda ⚠ (tetap bisa dipilih).
        const adWarn = s.adRisk
            ? html` <span class="server-badge server-badge--ad" title="Host server ini ada di daftar blokir iklan (AdGuard DNS)">⚠</span>`
            : '';
        // Putaran 19: server yang iklannya berulang diberi tanda, tetapi tombolnya tetap ada
        // dan tetap bisa diklik (permintaan putaran 16).
        const repeatBadge = autoBlocked(s) && !offline
            ? html` <span class="server-badge server-badge--adblock" title="Iklan server ini berulang — dilewati otomatis. Klik untuk tetap mencoba.">iklan</span>`
            : '';
        return html`<button type="button" class="${cls}${s.pending ? ' is-pending' : ''}" data-server="${s.id}" aria-pressed="${active ? 'true' : 'false'}" aria-disabled="${s.available || offline ? 'false' : 'true'}" title="${s.available || offline ? s.description : s.reason}">${s.flag ? `${s.flag} ` : ''}${s.name}${s.badge && !offline ? html` <span class="server-badge">${s.badge}</span>` : ''}${adWarn}${repeatBadge}${offlineBadge}${lock}${isFailed ? html` <span class="server-badge server-badge--failed">gagal</span>` : ''}</button>`;
    }

    /**
     * Baris opsi server situs (putaran 25).
     *
     * Permintaan pengguna: *"untuk Oploverz bisa di upayakan agar tidak bertabrakan kasih tombol
     * opsi saja jadi oploverz punya 2 server"*. Server yang punya lebih dari satu opsi (mis.
     * Oploverz `HD-1`/`HD-2`) tidak menambah tombol situs baru: pilihannya ada di dropdown ini.
     * @param {StreamServer[]} list
     */
    function optionRow(list) {
        const withOptions = list.filter((s) => Array.isArray(s.options) && s.options.length > 1 && s.available);
        if (!withOptions.length) return '';
        return html`<div class="server-options" role="group" aria-label="Pilihan server situs">
            ${withOptions.map((s) => {
                const active = optionIndex(s);
                return html`<label class="server-option">
                    <span class="server-option-label">${s.name} <small>opsi</small></span>
                    <select data-server-option="${s.id}" aria-label="Pilih server ${s.name}">
                        ${s.options.map((option, i) => html`<option value="${i}"${i === active ? ' selected' : ''}>${option.label}</option>`)}
                    </select>
                </label>`;
            })}
        </div>`;
    }

    /**
     * Kelompokkan server per baris bila sumbernya mengirim `group` (putaran 25, sumber baru
     * Aniwaves: SUB / S-Sub / DUB). Sumber lain tetap tampil datar seperti sebelumnya.
     * @param {StreamServer[]} list
     */
    function serverRows(list) {
        const rows = [];
        for (const server of list) {
            const key = String(server.group || '');
            const last = rows[rows.length - 1];
            if (last && last.key === key) last.list.push(server);
            else rows.push({ key, hint: key ? String(server.groupHint || '') : '', list: [server] });
        }
        return rows;
    }

    function renderServers() {
        if (!servers.length) {
            serverBox.innerHTML = '<p class="server-empty">Tidak ada server streaming yang dikonfigurasi.</p>';
            emit('servers', { count: 0 });
            return;
        }
        if (!servers.some((s) => s.group)) {
            serverBox.innerHTML = String(html`${servers.map((s) => serverButton(s, currentId))}${optionRow(servers)}`);
            emit('servers', { count: available().length });
            syncAdBlockToggle();
            return;
        }
        // Ada sumber yang memisahkan baris (Aniwaves): judul baris + tombolnya sendiri-sendiri.
        serverBox.innerHTML = String(html`${serverRows(servers).map((row) => (row.key
            ? html`<div class="server-group">
                    <p class="server-group-title">${row.key}${row.hint ? html` <small>${row.hint}</small>` : ''}</p>
                    <div class="server-group-buttons">${row.list.map((s) => serverButton(s, currentId))}</div>
                </div>`
            : row.list.map((s) => serverButton(s, currentId))))}${optionRow(servers)}`);
        emit('servers', { count: available().length });
        // Putaran 15: tombol blokir hanya muncul untuk server luar yang sedang diputar.
        syncAdBlockToggle();
    }

    /**
     * Tampilkan/sembunyikan tombol "Matikan blokir" (putaran 15, diperluas putaran 24).
     * Putaran 24: tombol kini juga tampil untuk server Sub Indo (AnimeKu & Animeloverz) sesuai
     * permintaan pengguna — *"sediakan tombol blokir di animeku dan animeloverz juga"*. Yang
     * diatur tombol ini hanya lapisan anti-iklan; sandbox tetap terpasang (tidak ada
     * `allow-popups`/`allow-top-navigation`), jadi mematikan blokir tidak membuka jalan tab baru.
     * Server HLS/native tetap tanpa tombol karena tidak memakai iframe/lapisan ini.
     */
    function syncAdBlockToggle() {
        if (!adBlockBtn) return;
        const server = current();
        const show = isFrameServer(server) && Boolean(server.url)
            && (state === 'loading' || state === 'playing');
        adBlockBtn.hidden = !show;
        if (!show) return;
        const off = !adBlockEnabled(server);
        const subIndo = isSubIndoServer(server);
        adBlockBtn.classList.toggle('is-off', off);
        adBlockBtn.setAttribute('aria-pressed', off ? 'false' : 'true');
        adBlockBtn.title = off
            ? `Blokir iklan untuk ${server.name} dimatikan. Klik untuk menyalakan lagi.`
            : subIndo
                ? `Server Sub Indo (${server.name}) tetap memakai sandbox; tombol ini hanya mematikan lapisan blokir iklan Kazanime bila pemutar tidak bisa diklik.`
                : `Server luar (${server.name}) dimuat tanpa sandbox. Klik untuk mematikan blokir iklan bila video tidak muncul.`;
        const label = adBlockBtn.querySelector('[data-toggle-label]');
        if (label) label.textContent = off ? 'Nyalakan blokir' : 'Matikan blokir';
    }

    /**
     * Tombol "Matikan blokir" (putaran 15, diperluas putaran 24).
     * Mematikan lapisan anti-iklan + ingatan pilihan per server. Untuk server Sub Indo sandbox
     * TIDAK ikut dilepas — tab baru tetap tidak bisa dibuka iklan; yang dilepas hanya lapisan
     * anti-iklan Kazanime (penahan klik pertama).
     */
    adBlockBtn?.addEventListener('click', () => {
        const server = current();
        if (!isFrameServer(server)) return;
        const off = adBlockEnabled(server); // sedang aktif → klik ini mematikannya
        writeAdBlockOff(server.id, off);
        if (off) removeAdShield();
        else if (state === 'playing') mountAdShield(token);
        syncAdBlockToggle();
        const subIndo = isSubIndoServer(server);
        showToast(off
            ? subIndo
                ? `Blokir iklan dimatikan untuk ${server.name}. Sandbox tetap aktif, jadi iklan tetap tidak bisa membuka tab baru.`
                : `Blokir iklan dimatikan untuk ${server.name}. Embed server luar bisa membuka tab baru — tutup tab yang tidak dikenal.`
            : `Blokir iklan dinyalakan lagi untuk ${server.name}.`, 'info', 7000);
    });

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
    /* Layar penuh                                                       */
    /* ---------------------------------------------------------------- */
    /** Elemen yang dimasukkan ke mode layar penuh (wadah player, bukan iframe). */
    const fullscreenTarget = () => stage.closest('.streaming-player-wrapper') || stage;
    /** Elemen yang sedang fullscreen (lintas vendor). */
    const fullscreenEl = () => document.fullscreenElement || document.webkitFullscreenElement || null;

    /** Tombol keluar saat layar penuh (peramban ponsel kadang menyembunyikan UI-nya). */
    let fsExit = null;

    function syncFullscreenUi() {
        const active = Boolean(fullscreenEl());
        const target = fullscreenTarget();
        target.classList.toggle('is-fullscreen', active);
        document.documentElement.classList.toggle('player-fullscreen', active);
        // Kunci orientasi ditolak/tiada → putar panggung 90° selama perangkat tegak.
        rotateFallback(target, active, target.dataset.fsLocked === '1');
        if (active && !fsExit) {
            fsExit = document.createElement('button');
            fsExit.type = 'button';
            fsExit.className = 'player-fs-exit';
            fsExit.id = 'playerFsExit';
            fsExit.setAttribute('aria-label', 'Keluar layar penuh');
            fsExit.innerHTML = String(html`${icon('x')}<span>Keluar</span>`);
            fsExit.addEventListener('click', () => { toggleFullscreen(); });
            target.append(fsExit);
        } else if (!active && fsExit) {
            fsExit.remove();
            fsExit = null;
        }
        emit('fullscreen', { on: active });
    }

    /**
     * Masuk/keluar layar penuh pada wadah player (bukan fullscreen bawaan embed), lalu kunci
     * orientasi lanskap supaya video berputar di ponsel. Fallback: fullscreen `<video>` (iOS,
     * yang tidak mengizinkan requestFullscreen pada elemen biasa).
     * @returns {Promise<boolean>}
     */
    async function toggleFullscreen() {
        try {
            if (fullscreenEl()) {
                if (document.exitFullscreen) await document.exitFullscreen();
                else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
                unlockOrientation();
                rotateFallback(fullscreenTarget(), false, false);
                return false;
            }
            const target = fullscreenTarget();
            const request = target.requestFullscreen?.bind(target)
                || target.webkitRequestFullscreen?.bind(target);
            if (request) {
                try {
                    await request({ navigationUI: 'hide' });
                } catch {
                    await request();
                }
                const locked = await lockLandscape();
                rotateFallback(fullscreenTarget(), Boolean(fullscreenEl()), locked);
                syncFullscreenUi();
                return Boolean(fullscreenEl());
            }
            // iOS: hanya elemen <video> yang bisa fullscreen.
            if (video?.webkitEnterFullscreen) {
                video.webkitEnterFullscreen();
                lockLandscape();
                return true;
            }
            showToast('Peramban ini tidak mendukung layar penuh halaman. Coba Pemutar Eksternal.', 'info', 6000);
            return false;
        } catch {
            showToast('Layar penuh ditolak peramban. Coba lagi setelah video berjalan.', 'info', 6000);
            return false;
        }
    }

    /* Pasang pendengar sekali; `fullscreenchange` juga dipicu saat pengguna menekan Esc. */
    if (isFullscreenApiAvailable()) {
        FULLSCREEN_EVENTS.forEach((name) => document.addEventListener(name, () => {
            if (!fullscreenEl()) unlockOrientation();
            syncFullscreenUi();
        }));
        // Perangkat diputar / jendela diubah ukurannya saat layar penuh → cek ulang rotasi.
        const recheckRotation = () => {
            if (!fullscreenEl()) return;
            const target = fullscreenTarget();
            rotateFallback(target, true, target.dataset.fsLocked === '1');
        };
        window.addEventListener('resize', recheckRotation);
        window.addEventListener('orientationchange', recheckRotation);
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
        // Putaran 15: sandbox HANYA untuk server Sub Indo (AnimeKu/Oploverz) — server luar
        // (AniList/Kitsu: MegaPlay, Vidnest, TryEmbed) menolak sandbox, jadi dimuat tanpa sandbox dan
        // mendapat tombol "Matikan blokir" di baris kontrol.
        const guarded = isSubIndoServer(server) || PLAYER.externalGuard?.sandbox === true;
        if (guarded) applyFramePolicy(iframe);
        else iframe.dataset.frameGuard = 'off';
        // Putaran 19: AnimeKu memakai sandbox lebih ketat (tanpa allow-forms/allow-downloads).
        if (guarded && isStrictAdServer(server)) applyStrictFramePolicy(iframe);
        syncAdBlockToggle();
        lastFrameLoadAt = 0;
        playStartedAt = Date.now();
        blurAt = 0;
        popupEvents.delete(server.id);
        armHealthyClear(server);
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
            // Putaran 13: sandbox tidak pernah dilepas. Embed yang menolak berjalan di dalam
            // sandbox tidak mengirim `load`; server ini dianggap gagal dan server berikutnya
            // dicoba dengan perlindungan tetap aktif (tanpa tawaran mematikan pengaman).
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
        // Putaran 18/19: server ber-popup berulang (sesi & antar-halaman) tidak dicoba otomatis lagi.
        const list = available().filter((s) => !autoBlocked(s));
        const start = list.findIndex((s) => s.id === afterId);
        for (let i = 1; i <= list.length; i++) {
            const s = list[(start + i + list.length) % list.length];
            if (s.id !== afterId && !failed.has(s.id)) return s;
        }
        return null;
    }

    function fail(server, reason) {
        const idx = optionIndex(server);
        if (server.mirrors && idx < server.mirrors.length - 1) {
            // Opsi lain dari penyedia yang sama (HD-1 → HD-2) dicoba dulu.
            mirror.set(server.id, idx + 1);
            console.warn(`[player] ${server.name} opsi ${idx + 1} gagal (${reason}) — mencoba opsi ${idx + 2}`);
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
        // Tindakan eksplisit: pengguna minta mencoba lagi, jadi ingatan popup ikut direset —
        // termasuk ingatan antar-halaman AnimeKu (putaran 19).
        adBlocked.clear();
        adTakeovers.clear();
        for (const site of [...adBlockedSites]) forgetAdRepeatSite(site);
        adBlockedSites.clear();
        popupEvents.clear();
        rememberedNotified.clear();
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
    /**
     * Pilih opsi (mirror) satu server — putaran 25.
     *
     * Dipakai dropdown `opsi` di panel server (Oploverz `HD-1`/`HD-2`). Bila server itu yang
     * sedang diputar, pemutar memuat ulang URL opsi terpilih; bila belum, pilihan disimpan
     * supaya saat server diputar nanti langsung memakai opsi tersebut.
     * @param {string} serverId
     * @param {number} index
     * @returns {boolean} true bila pilihan diterima
     */
    function setOption(serverId, index) {
        const s = byId(serverId);
        if (!s) return false;
        const total = Array.isArray(s.options) ? s.options.length : Array.isArray(s.mirrors) ? s.mirrors.length : 1;
        if (!Number.isInteger(index) || index < 0 || index >= total) return false;
        mirror.set(serverId, index);
        writeMirrorChoice(serverId, index);
        if (serverId === currentId && (state === 'loading' || state === 'playing')) {
            failed.delete(serverId);
            play(s);
        } else {
            renderServers();
        }
        const label = s.options?.[index]?.label || s.mirrorLabels?.[index] || `Opsi ${index + 1}`;
        showToast(`${s.name}: ${label}`, 'info');
        return true;
    }

    delegate(serverBox, 'change', 'select[data-server-option]', (_event, select) => {
        const id = select?.dataset?.serverOption;
        const index = Number(select?.value);
        if (!id || !Number.isInteger(index)) return;
        setOption(id, index);
    });

    delegate(serverBox, 'click', '.server-btn[data-server]', (_event, btn) => {
        const s = byId(btn.dataset.server);
        if (!s) return;
        if (!s.available) {
            // Putaran 16: tombol Sub Indo "tidak terjangkau" = aksi cari ulang (bukan error).
            if (s.placeholder) {
                emit('retrysubindo', { site: s.site || '', name: s.name });
                return;
            }
            showToast(s.pending ? `${s.name} masih dicari, tunggu sebentar…` : `${s.name} tidak tersedia untuk anime ini. Coba server lain.`, 'info');
            return;
        }
        failed.delete(s.id);
        // Putaran 25: pilihan opsi (HD-1/HD-2) TIDAK direset saat tombol server diklik — pilihan
        // pengguna di dropdown opsi harus dihormati.
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
        /** Putaran 18/19: id server yang iklannya berulang (tidak dipilih otomatis lagi). */
        adBlockedServers: () => [...adBlocked],
        /** Putaran 19: situs yang diingat antar-halaman karena iklannya berulang (AnimeKu). */
        adBlockedSites: () => [...adBlockedSites],
        /** Putaran 19: batas pembajakan untuk server (AnimeKu = 1). */
        adTakeoverLimit: (server) => adTakeoverLimit(server),
        /**
         * Putaran 25: opsi (mirror) satu server — indeks yang dipakai sekarang dan daftar opsinya.
         * Ditampilkan halaman nonton sebagai dropdown "opsi" pada tombol situs Sub Indo.
         * @param {string} serverId
         */
        serverOptions(serverId) {
            const s = byId(serverId);
            if (!s) return { index: 0, options: [] };
            return { index: optionIndex(s), options: Array.isArray(s.options) ? s.options.map((option) => ({ ...option })) : [] };
        },
        /** Putaran 25: pilih opsi server (dipakai dropdown opsi & tes). */
        setOption,
        /**
         * Putaran 19: beri tahu pemutar bahwa tab baru dibuka oleh Kazanime sendiri (tombol
         * Pemutar Eksternal), supaya kehilangan fokus sesudahnya tidak dihitung sebagai popup iklan.
         */
        noteOwnTabOpen: () => { ownTabAt = Date.now(); },

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

        /**
         * Layar penuh standar player: `requestFullscreen` pada wadah player (bukan iframe),
         * lalu kunci orientasi lanskap. Memanggilnya lagi saat sudah fullscreen = keluar.
         * @returns {Promise<boolean>} true bila sekarang fullscreen
         */
        toggleFullscreen,

        /** Sedang layar penuh? */
        isFullscreen: () => Boolean(fullscreenEl()),

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
            // Putaran 18/19: jangan memilih otomatis server yang iklannya berulang (popup sama).
            const previous = currentId ? byId(currentId) : null;
            const keepCurrent = previous?.available && !autoBlocked(previous) ? previous : null;
            notifyRemembered();
            const first = keepCurrent || pickAuto(available()) || available()[0];
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
                // Putaran 18: server ber-popup berulang tidak dipilih otomatis lagi.
                const next = pickAuto(available(), { skipFailed: true });
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
         * @param {'loaded'|'complete'|'progress'|'exhausted'|'retry'|'servers'|'adblock'|'adguide'|'fullscreen'} name
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
