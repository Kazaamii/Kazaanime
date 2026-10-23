/**
 * Kazanime backend — lib/subtitle-evidence.js
 * Bukti subtitle Indonesia **per episode**, bukan asumsi "situsnya memang situs Indonesia".
 *
 * Latar belakang (23 Okt 2026): adapter Sub Indo dulu menempelkan `lang: 'id'` ke semua
 * server hanya karena situsnya berbahasa Indonesia. Akibatnya verifikasi di beranda
 * (`js/api/subindo.js`) meloloskan judul apa pun tanpa pernah melihat bukti subtitle.
 * Modul ini menggantinya dengan bukti yang dibaca dari halaman episode itu sendiri:
 *
 *   1. subtitle-track  — `<track srclang="id">` / server dengan track subtitle Indonesia
 *   2. episode-title   — judul episode menyebut "Sub Indo" / "Subtitle Indonesia"
 *   3. download-label  — grup download episode itu berlabel "Sub Indo"
 *   4. server-label    — label server/mirror menyebut "Hardsub Indonesia"
 *   5. episode-page    — deskripsi episode itu sendiri menyebut "HD Subtitle Indonesia"
 *
 * Tidak ada bukti → server tetap boleh diputar, tetapi TIDAK dihitung sebagai Sub Indo.
 * Yang tidak dipakai sebagai bukti: nama situs, deskripsi/tagline situs, atau bahasa
 * antarmuka situs (itu yang disebut "web tersebut memang khusus indo semua").
 */

/** Teks yang secara eksplisit menyatakan subtitle Indonesia. */
export const INDONESIAN_SUBTITLE_TEXT = /(?:\b(?:hard|soft)?sub(?:s|title)?[\s._-]*indo(?:nesia)?\b|\bbahasa\s+indonesia\b|\bindonesian\s+(?:sub(?:s|title)?|hardsub)\b)/i;

/** Tag bahasa Indonesia yang lazim: id, ind, in, id-ID, "Indonesian". */
export function isIndonesianLanguageTag(value) {
    const tag = String(value || '').trim().toLowerCase().replace(/_/g, '-');
    if (!tag) return false;
    return tag === 'id' || tag === 'ind' || tag === 'in' || tag === 'indonesian'
        || tag === 'bahasa indonesia' || tag.startsWith('id-');
}

/** Apakah teks bebas (judul/label) menyatakan subtitle Indonesia? */
export function textShowsIndonesianSubtitle(value) {
    return INDONESIAN_SUBTITLE_TEXT.test(String(value || ''));
}

const clip = (value, max = 90) => {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/**
 * Cari bukti subtitle Indonesia dari data yang sudah di-parse halaman episode.
 * @param {{
 *   title?: string,
 *   pageText?: string,
 *   labels?: string[],
 *   downloads?: Array<{subtitle?: string}>,
 *   tracks?: Array<{lang?: string, label?: string}>,
 * }} input
 * @returns {{verified: boolean, evidence: ''|'subtitle-track'|'episode-title'|'download-label'|'server-label'|'episode-page', detail: string}}
 */
export function detectSubtitleEvidence({ title = '', pageText = '', labels = [], downloads = [], tracks = [] } = {}) {
    const track = (Array.isArray(tracks) ? tracks : []).find((item) =>
        isIndonesianLanguageTag(item?.lang) || textShowsIndonesianSubtitle(item?.label));
    if (track) {
        return {
            verified: true,
            evidence: 'subtitle-track',
            detail: clip(track.label || `track ${track.lang || 'id'}`),
        };
    }

    if (textShowsIndonesianSubtitle(title)) {
        return { verified: true, evidence: 'episode-title', detail: clip(title) };
    }

    const download = (Array.isArray(downloads) ? downloads : [])
        .find((group) => textShowsIndonesianSubtitle(group?.subtitle));
    if (download) {
        return { verified: true, evidence: 'download-label', detail: clip(`${download.quality || ''} ${download.subtitle}`.trim()) };
    }

    const label = (Array.isArray(labels) ? labels : []).find((name) => textShowsIndonesianSubtitle(name));
    if (label) return { verified: true, evidence: 'server-label', detail: clip(label) };

    // Terakhir: kalimat di blok deskripsi episode itu sendiri ("… HD Subtitle Indonesia terbaru di …").
    // Bukan tagline situs: pemanggil hanya mengirim teks yang berada di blok episode.
    if (textShowsIndonesianSubtitle(pageText)) {
        const match = String(pageText).match(INDONESIAN_SUBTITLE_TEXT);
        return { verified: true, evidence: 'episode-page', detail: clip(match?.[0] || pageText) };
    }

    return { verified: false, evidence: '', detail: '' };
}

/**
 * Terapkan hasil deteksi ke daftar server.
 * Tanpa bukti, klaim bahasa tingkat situs dibuang (`lang`/`subtitleType`), sehingga
 * pemutar tetap bisa memakai server itu tetapi feed Sub Indo tidak mengklaim apa pun.
 * Bukti yang sudah eksplisit per server (mis. label mirror "Hardsub Indonesia") dipertahankan.
 * @param {Array<{lang?: string|null, subtitleType?: string, subtitleEvidence?: string}>} servers
 * @param {Parameters<typeof detectSubtitleEvidence>[0]} input
 */
export function applySubtitleEvidence(servers, input) {
    const evidence = detectSubtitleEvidence(input);
    const list = (Array.isArray(servers) ? servers : []).map((server) => {
        if (!server) return server;
        if (server.subtitleEvidence) return server;                        // bukti eksplisit per server
        if (server.lang && !isIndonesianLanguageTag(server.lang)) return server; // bahasa lain (mis. Sub English)
        if (evidence.verified) {
            return { ...server, lang: 'id', subtitleEvidence: evidence.evidence };
        }
        if (!isIndonesianLanguageTag(server.lang)) return server;
        // Klaim 'id' tanpa bukti apa pun (pola lama "situsnya Indonesia") dibuang.
        const { lang, subtitleType, ...rest } = server;
        return rest;
    });
    return { servers: list, ...evidence };
}
