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
 * Tidak ada fetch di sini. Daftar server (StreamServer[]) datang dari js/api.
 */
import { PLAYER, LEGAL_PLATFORMS } from '../config.js';
import { html, delegate } from './dom.js';
import { showToast } from './toast.js';

/** @typedef {import('../api/streams.js').StreamServer} StreamServer */

/**
 * Overlay "memuat" paling lama segini (ms). Event `load` iframe menunggu SEMUA isi
 * halaman embed (termasuk iklan), jadi player yang sudah bisa dipakai jangan ditutupi
 * terlalu lama. Deteksi timeout (PLAYER.loadTimeout) tetap berjalan di latar.
 */
const OVERLAY_MAX_MS = 3000;
const COMPLETE_EVENTS = new Set(['complete', 'ended', 'finish', 'finished']);
const PROGRESS_EVENTS = new Set(['time', 'timeupdate', 'progress', 'watching-log']);

const clamp01 = (n) => Math.min(1, Math.max(0, n));

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
 * @param {{
 *   stage: HTMLElement,          isi area player (#playerStage)
 *   serverBox: HTMLElement,      wadah tombol server (#serverButtons)
 *   status: HTMLElement,         status bar (#playerStatus) — kelas is-ok / is-error
 *   statusText: HTMLElement,     teks status (#playerStatusText)
 *   getTitle?: () => string,     judul anime (untuk title iframe & tautan platform legal)
 * }} opts
 */
export function createPlayer({ stage, serverBox, status, statusText, getTitle = () => '' }) {
    /** @type {Record<string, Set<Function>>} */
    const handlers = { loaded: new Set(), complete: new Set(), progress: new Set(), exhausted: new Set(), retry: new Set(), servers: new Set() };
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
    let timer = 0;
    let overlayTimer = 0;
    /** Tandai server aktif "termuat" (dipakai event load & pesan progres dari player). */
    let markLoaded = null;
    let token = 0;
    /** idle | waiting | loading | playing | exhausted | message */
    let state = 'idle';
    let completedFor = null;

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

    function clearFrame() {
        clearTimeout(timer);
        clearTimeout(overlayTimer);
        timer = 0;
        overlayTimer = 0;
        markLoaded = null;
        if (frame) {
            frame.remove(); // melepas iframe = video/audio benar-benar berhenti
            frame = null;
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
            return html`<button type="button" class="${cls}" data-server="${s.id}" aria-pressed="${active ? 'true' : 'false'}" aria-disabled="${s.available ? 'false' : 'true'}" title="${s.available ? s.description : s.reason}">${s.flag ? `${s.flag} ` : ''}${s.name}${s.badge ? html` <span class="server-badge">${s.badge}</span>` : ''}${s.available ? '' : ' 🔒'}${isFailed ? html` <span class="server-badge server-badge--failed">gagal</span>` : ''}</button>`;
        })}`);
        emit('servers', { count: available().length });
    }

    /** Elemen pesan di area player (aman: semua teks lewat html``). */
    function messageEl({ icon = '', title = '', text = '', sub = '', spinner = false, actions = [] }) {
        const box = document.createElement('div');
        box.className = 'player-message';
        box.innerHTML = String(html`
            ${spinner ? html`<div class="spinner" aria-hidden="true"></div>` : ''}
            ${icon ? html`<p class="player-message-icon" aria-hidden="true">${icon}</p>` : ''}
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
            bstation && { label: `${bstation.icon} ${bstation.name}`, href: bstation.url(t), className: 'btn-bstation' },
            muse && { label: '🎬 YouTube', href: muse.url(t), className: 'btn-youtube' },
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
        const iframe = document.createElement('iframe');
        iframe.className = 'player-frame';
        iframe.title = `Player ${getTitle()} - Episode ${ep}`.trim();
        iframe.allow = PLAYER.allow;
        iframe.allowFullscreen = true;
        iframe.referrerPolicy = PLAYER.referrerPolicy;
        if (PLAYER.sandbox) iframe.setAttribute('sandbox', PLAYER.sandbox);
        const loaded = () => {
            if (my !== token || state !== 'loading') return;
            clearTimeout(timer);
            clearTimeout(overlayTimer);
            state = 'playing';
            overlay.remove();
            setStatus(`✅ ${server.name} | Episode ${ep} | Sub Indo`, 'ok');
            renderServers();
            emit('loaded', { ep, server });
        };
        markLoaded = loaded;
        iframe.addEventListener('load', loaded);
        iframe.src = server.url; // src sebelum dipasang → event load hanya untuk dokumen embed
        stage.replaceChildren(iframe, overlay);
        frame = iframe;
        setStatus(`⏳ Memuat ${server.name} • Episode ${ep}...`);
        overlayTimer = setTimeout(() => {
            if (my === token) overlay.remove();
        }, Math.min(OVERLAY_MAX_MS, PLAYER.loadTimeout));
        timer = setTimeout(() => {
            if (my !== token || state !== 'loading') return;
            // Fokus sudah di dalam iframe = user sedang memakai player → jangan dipindah server.
            if (document.activeElement === iframe) loaded();
            else fail(server, 'timeout');
        }, PLAYER.loadTimeout);
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
        failed.add(server.id);
        console.warn(`[player] ${server.name} gagal (${reason}) — episode ${ep}`);
        const next = nextCandidate(server.id);
        if (next) {
            showToast(`⚠️ ${server.name} gagal, mencoba ${next.name}...`, 'info');
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
            icon: '⚠️',
            title: 'Streaming Tidak Tersedia',
            text: hasAny
                ? `Semua server gagal memuat Episode ${ep}.`
                : 'ID anime untuk server streaming tidak ditemukan.',
            sub: 'Gunakan platform streaming legal di bawah atau coba server lain',
            actions: [{ label: '🔄 Coba lagi', className: 'btn-ext btn-ext--retry', onClick: retry }, ...legalActions()],
        }));
        setStatus(`❌ Streaming Episode ${ep} tidak tersedia`, 'error');
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
            setStatus(`▶️ ${server.name} | EP ${ep} | ${Math.round(pct * 100)}%`, 'ok', { quiet: true });
            emit('progress', { ep, percent: pct });
        } else if (name === 'error') {
            fail(server, 'error dari player');
        }
    }
    window.addEventListener('message', onMessage);

    /* ---------------------------------------------------------------- */
    /* Klik tombol server                                                */
    /* ---------------------------------------------------------------- */
    delegate(serverBox, 'click', '.server-btn[data-server]', (_event, btn) => {
        const s = byId(btn.dataset.server);
        if (!s) return;
        if (!s.available) {
            showToast(`⚠️ ${s.name} tidak tersedia untuk anime ini. Coba server lain.`, 'info');
            return;
        }
        failed.delete(s.id);
        play(s);
        showToast(`🌐 Server: ${s.name}`, 'success');
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
         * Putar episode dengan daftar server baru. Server pilihan user sebelumnya
         * dipakai lebih dulu bila tersedia (pindah episode tidak mereset pilihan server).
         * @param {number} episode
         * @param {StreamServer[]} list
         */
        load(episode, list) {
            ep = episode;
            servers = list;
            failed = new Set();
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
            servers = list;
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
                showToast('⚠️ Tidak ada server yang tersedia untuk anime ini.', 'info');
                return;
            }
            const index = list.findIndex((s) => s.id === currentId);
            const next = list[(index + 1) % list.length];
            failed.delete(next.id);
            play(next);
            showToast(list.length > 1 ? `🌐 Server: ${next.name}` : `🔄 Memuat ulang ${next.name}`, 'success');
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
         * @param {'loaded'|'complete'|'progress'|'exhausted'|'retry'|'servers'} name
         * @param {(detail: any) => void} fn
         */
        on(name, fn) {
            handlers[name]?.add(fn);
            return () => handlers[name]?.delete(fn);
        },

        /** Hentikan & lepaskan listener (tidak dipakai di watch.html, disediakan untuk kebersihan). */
        destroy() {
            clearFrame();
            token++;
            window.removeEventListener('message', onMessage);
        },
    };
}
