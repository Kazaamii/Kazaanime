/**
 * Kazanime backend — lib/anime.js
 * Bentuk data SERAGAM yang dikirim ke frontend. Semua adapter (animexin, samehadaku,
 * metadata) wajib lewat fungsi ini, jadi frontend cukup mengenal satu format.
 *
 * Field anime sama dengan objek Anime di js/api/normalize.js (createAnime):
 *   { title, titleAlt, image, banner, description, episodes, latestEpisode, genres, score,
 *     status, format, year, popularity, country, ids, slug, source, studios, duration,
 *     season, nextAiring } + `url` (halaman asli di situs sumber, untuk atribusi).
 * Field `id` sengaja TIDAK dikirim: frontend menghitungnya sendiri (anilist:… / animexin:…).
 */
import { absoluteUrl, cleanText, clip } from './text.js';
import { inspectAdUrl } from './adblock.js';

const STATUSES = new Set(['ONGOING', 'COMPLETED', 'UPCOMING', 'UNKNOWN']);
const FORMATS = new Set(['TV', 'MOVIE', 'ONA', 'OVA', 'SPECIAL', 'MUSIC', 'DONGHUA']);
const SEASONS = new Set(['WINTER', 'SPRING', 'SUMMER', 'FALL']);

const posInt = (v, max = 100000) => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 && n <= max ? n : null;
};

const idOf = (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * @param {Partial<ReturnType<typeof makeAnime>> & Record<string, any>} p
 */
export function makeAnime(p = {}) {
    const score = Number(p.score);
    const year = Number(p.year);
    const airingAt = Number(p.nextAiring?.airingAt);
    return {
        title: clip(p.title, 200),
        titleAlt: clip(p.titleAlt && cleanText(p.titleAlt) !== cleanText(p.title) ? p.titleAlt : '', 200),
        image: absoluteUrl(p.image) || null,
        banner: absoluteUrl(p.banner) || null,
        description: clip(p.description, 2000),
        episodes: posInt(p.episodes, 5000),
        latestEpisode: posInt(p.latestEpisode, 5000),
        genres: [...new Set((p.genres || []).map((g) => clip(g, 40)).filter(Boolean))].slice(0, 12),
        score: Number.isFinite(score) && score > 0 && score <= 10 ? Math.round(score * 100) / 100 : null,
        status: STATUSES.has(p.status) ? p.status : 'UNKNOWN',
        format: FORMATS.has(p.format) ? p.format : '',
        year: Number.isInteger(year) && year > 1900 && year < 2100 ? year : null,
        popularity: posInt(p.popularity, 1e9),
        country: typeof p.country === 'string' && /^[A-Z]{2}$/.test(p.country) ? p.country : null,
        ids: { anilist: idOf(p.ids?.anilist), mal: idOf(p.ids?.mal), kitsu: idOf(p.ids?.kitsu) },
        slug: typeof p.slug === 'string' && p.slug ? p.slug : null,
        source: clip(p.source, 40),
        studios: [...new Set((p.studios || []).map((s) => clip(s, 60)).filter(Boolean))].slice(0, 4),
        duration: posInt(p.duration, 600),
        season: SEASONS.has(p.season) ? p.season : null,
        nextAiring: Number.isFinite(airingAt) && airingAt > 0
            ? { episode: posInt(p.nextAiring.episode, 5000), airingAt: Math.round(airingAt) }
            : null,
        url: absoluteUrl(p.url) || null,
    };
}

/**
 * Daftar episode (detail) — dipakai adapter untuk mencari URL halaman episode.
 * @param {{number: number, title?: string, released?: string, url?: string}[]} list
 */
export function makeEpisodeList(list = []) {
    const seen = new Set();
    return list
        .filter((e) => posInt(e?.number, 5000) && !seen.has(e.number) && seen.add(e.number))
        .map((e) => ({
            number: e.number,
            title: clip(e.title, 160),
            released: clip(e.released, 40),
            url: absoluteUrl(e.url) || null,
            // 24 Okt 2026: bahasa subtitle per episode bila situs mencantumkannya di daftar
            // episode ('id' = bukti teks Indonesia, '' = diperiksa dan tidak ada buktinya).
            // Tidak ada properti `sub` = belum diperiksa (butuh halaman episode).
            ...(e.sub === 'id' || e.sub === '' ? { sub: e.sub } : {}),
        }))
        .sort((a, b) => a.number - b.number)
        .slice(0, 5000);
}

// Putaran 25: `dub` (sulih suara) selalu setelah semua jenis subtitle.
const LANG_ORDER = { multi: 0, id: 1, en: 2, dub: 3 };
const SUBTITLE_TYPE_ORDER = { hard: 0, soft: 1 };

/**
 * Payload endpoint episode (kontrak dengan js/api/sources.js → toEpisodeMedia):
 *   { episode, title, released, url,
 *     servers: [{name, url, lang, subtitleType?, kind?: 'hls'|'video', subtitles?: [{label,lang,format,url,default}]}],
 *     downloads: [{quality, size, format, subtitle, links: [{provider, url}]}] }
 */
export function makeEpisode({ episode, title = '', released = '', url = '', servers = [], downloads = [], notice = '' } = {}) {
    const seen = new Set();
    const srv = servers
        .map((s) => {
            const kind = s.kind === 'hls' || s.kind === 'video' ? s.kind : '';
            const subtitles = kind && Array.isArray(s.subtitles)
                ? s.subtitles.map((track) => {
                    const lang = String(track?.lang || 'und').toLowerCase();
                    const format = String(track?.format || '').toLowerCase();
                    return {
                        label: clip(track?.label, 40) || 'Subtitle',
                        lang: /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/.test(lang) ? lang : 'und',
                        format,
                        url: absoluteUrl(track?.url),
                        default: Boolean(track?.default),
                    };
                }).filter((track) => track.url && ['ass', 'ssa', 'srt', 'vtt'].includes(track.format)).slice(0, 16)
                : [];
            return {
                name: clip(s.name, 40) || 'Server',
                url: absoluteUrl(s.url),
                lang: s.lang || null,
                // Bukti bahasa dari halaman episode (lib/subtitle-evidence.js); tanpa ini feed Sub Indo
                // tidak boleh mengklaim apa pun meski `lang` diisi adapter.
                ...(s.subtitleEvidence ? { subtitleEvidence: clip(s.subtitleEvidence, 20) } : {}),
                ...(s.subtitleType === 'hard' || s.subtitleType === 'soft' ? { subtitleType: s.subtitleType } : {}),
                ...(kind ? { kind } : {}),
                ...(subtitles.length ? { subtitles } : {}),
                // Putaran 25: baris/kelompok server dari sumber (mis. Aniwaves: SUB / S-Sub / DUB)
                // supaya halaman nonton bisa memisahkan tombolnya per baris.
                ...(s.group ? { group: clip(s.group, 20) } : {}),
                ...(s.groupHint ? { groupHint: clip(s.groupHint, 40) } : {}),
            };
        })
        // Putaran 11: URL bertanda jaringan iklan / gateway klik dibuang di sini supaya tidak
        // pernah sampai ke iframe (dulu muncul halaman JSON "iclick link error" di pemutar).
        // Putaran 25: URL & nama dibiarkan apa adanya; dedupe tetap per URL karena dua server
        // dengan URL identik memutar berkas yang sama (Oploverz HD-1/HD-2 berbeda URL).
        .filter((s) => s.url && !inspectAdUrl(s.url).blocked && !seen.has(s.url) && seen.add(s.url))
        // Multi Sub didahulukan; setelahnya Hardsub eksplisit sebelum Softsub, urutan sumber stabil.
        .map((s, i) => ({ s, i }))
        .sort((a, b) => ((LANG_ORDER[a.s.lang] ?? 3) - (LANG_ORDER[b.s.lang] ?? 3))
            || ((SUBTITLE_TYPE_ORDER[a.s.subtitleType] ?? 2) - (SUBTITLE_TYPE_ORDER[b.s.subtitleType] ?? 2))
            || (a.i - b.i))
        .map(({ s }) => s)
        .slice(0, 20);

    const dl = downloads
        .map((g) => ({
            quality: clip(g.quality, 12) || 'Download',
            size: clip(g.size, 20),
            format: clip(g.format, 8),
            subtitle: clip(g.subtitle, 20),
            links: (g.links || [])
                .map((l) => ({ provider: clip(l.provider, 30) || 'Link', url: absoluteUrl(l.url) }))
                .filter((l) => l.url)
                .slice(0, 12),
        }))
        .filter((g) => g.links.length)
        .slice(0, 24);

    return {
        episode: posInt(episode, 5000),
        title: clip(title, 200),
        released: clip(released, 40),
        url: absoluteUrl(url) || null,
        servers: srv,
        downloads: dl,
        ...(notice ? { notice: clip(notice, 300) } : {}),
    };
}
