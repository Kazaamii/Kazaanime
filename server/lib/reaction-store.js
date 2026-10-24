/**
 * Kazanime backend — lib/reaction-store.js
 * Hitungan "suka" (like) per episode — putaran 14 (24 Okt 2026).
 *
 * Permintaan pengguna: *"tambahkan tombol Like/Count Live Untuk Jejak jika memungkinkan"*.
 *
 * Kenapa dibuat opsional: Kazanime tidak mewajibkan basis data. Adapter dipilih lewat
 * `REACTION_STORE`:
 *   file    → berkas JSON di DATA_DIR (server sendiri/VPS). Default di server lokal.
 *   redis   → REST Redis (Upstash / Vercel KV) lewat KV_REST_API_URL + KV_REST_API_TOKEN,
 *             atau UPSTASH_REDIS_REST_URL/TOKEN. Dipakai otomatis bila env itu ada.
 *   memory  → hanya di memori proses; HILANG saat instance berhenti. Default di Vercel tanpa KV.
 *   (kosong)→ otomatis: redis (bila KV ada) → file (bukan Vercel) → memory (Vercel).
 *
 * Aturan data:
 *  - Satu "like" per `visitor` (id anonim per perangkat, dibuat frontend) per key.
 *    Klik berulang/refresh TIDAK menambah hitungan.
 *  - Tidak ada data pribadi yang disimpan: hanya id acak + key episode.
 *  - Jumlah visitor per key dibatasi (`MAX_VISITORS_PER_KEY`) supaya berkas tidak membengkak;
 *    jumlah key juga dibatasi (`MAX_KEYS`).
 *  - Adapter file menulis atomik (tmp + rename) dan serial (antrean) supaya dua request
 *    tidak saling menimpa.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { REACTIONS } from '../config.js';

/** Batas visitor unik per key (adapter file/memory). */
export const MAX_VISITORS_PER_KEY = 5000;
/** Batas jumlah key (episode) yang disimpan adapter file. */
export const MAX_KEYS = 5000;
/** Prefix key Redis. */
const REDIS_PREFIX = 'kazanime:like:';

/** Key episode: `slug~ep12` (huruf kecil, angka, ~ . _ : -). */
export function normalizeKey(value) {
    const key = String(value || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9~._:-]{0,119}$/.test(key)) return null;
    return key;
}

/** Id pengunjung anonim: 8–64 karakter [a-z0-9-]. */
export function normalizeVisitor(value) {
    const visitor = String(value || '').trim().toLowerCase();
    if (!/^[a-z0-9-]{8,64}$/.test(visitor)) return null;
    return visitor;
}

/* ------------------------------------------------------------------ */
/* Adapter: memori (proses)                                            */
/* ------------------------------------------------------------------ */
export function createMemoryAdapter() {
    /** @type {Map<string, Set<string>>} */
    const map = new Map();
    const bucket = (key) => {
        if (!map.has(key)) map.set(key, new Set());
        return map.get(key);
    };
    return {
        provider: 'memory',
        persistent: false,
        async counts(keys) {
            return Object.fromEntries(keys.map((key) => [key, map.get(key)?.size || 0]));
        },
        async like(key, visitor) {
            const set = bucket(key);
            if (set.size < MAX_VISITORS_PER_KEY || set.has(visitor)) set.add(visitor);
            return { count: set.size, liked: set.has(visitor) };
        },
        async unlike(key, visitor) {
            const set = map.get(key);
            if (set) set.delete(visitor);
            return { count: set?.size || 0, liked: false };
        },
        async status() {
            return { keys: map.size };
        },
    };
}

/* ------------------------------------------------------------------ */
/* Adapter: berkas JSON                                                */
/* ------------------------------------------------------------------ */
/**
 * @param {string} dir folder data (mis. `.data`)
 */
export function createFileAdapter(dir) {
    const file = path.join(dir, 'reactions.json');
    /** Antrean tulis: satu operasi baca-ubah-tulis pada satu waktu. */
    let chain = Promise.resolve();

    const readAll = async () => {
        try {
            const raw = await fs.readFile(file, 'utf8');
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
            // Bentuk: { [key]: string[] } — buang entri yang tidak valid (berkas lama/rusak).
            return Object.fromEntries(Object.entries(parsed)
                .filter(([key, list]) => normalizeKey(key) && Array.isArray(list))
                .map(([key, list]) => [key, list.filter((visitor) => typeof visitor === 'string')]));
        } catch (error) {
            if (error?.code === 'ENOENT') return {};
            throw error;
        }
    };

    /** @param {(all: Record<string, string[]>) => Record<string, string[]>} fn */
    const mutate = (fn) => {
        const run = chain.then(async () => {
            const all = await readAll();
            let next = fn(all) || all;
            // Batasi jumlah episode yang disimpan (yang terlama dibuang).
            const keys = Object.keys(next);
            if (keys.length > MAX_KEYS) {
                next = Object.fromEntries(keys.slice(-MAX_KEYS).map((key) => [key, next[key]]));
            }
            await fs.mkdir(dir, { recursive: true });
            const tmp = `${file}.tmp`;
            await fs.writeFile(tmp, JSON.stringify(next), 'utf8');
            await fs.rename(tmp, file);
            return next;
        });
        // Antrean tidak boleh "mati" karena satu operasi gagal.
        chain = run.catch(() => {});
        return run;
    };

    return {
        provider: 'file',
        persistent: true,
        async counts(keys) {
            const all = await readAll();
            return Object.fromEntries(keys.map((key) => [key, Array.isArray(all[key]) ? all[key].length : 0]));
        },
        async like(key, visitor) {
            const next = await mutate((all) => {
                const list = new Set(all[key] || []);
                if (list.size < MAX_VISITORS_PER_KEY || list.has(visitor)) list.add(visitor);
                all[key] = [...list];
                return all;
            });
            return { count: (next[key] || []).length, liked: true };
        },
        async unlike(key, visitor) {
            const next = await mutate((all) => {
                all[key] = (all[key] || []).filter((id) => id !== visitor);
                return all;
            });
            return { count: (next[key] || []).length, liked: false };
        },
        async status() {
            return { keys: Object.keys(await readAll()).length };
        },
    };
}

/* ------------------------------------------------------------------ */
/* Adapter: Redis REST (Upstash / Vercel KV)                           */
/* ------------------------------------------------------------------ */
function redisAdapter({ url, token }) {
    const command = async (name, ...args) => {
        const endpoint = `${url.replace(/\/+$/, '')}/${[name, ...args].map((part) => encodeURIComponent(part)).join('/')}`;
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error(`Redis ${res.status}`);
        const json = await res.json();
        return json?.result ?? null;
    };
    const countOf = async (key) => Number(await command('SCARD', `${REDIS_PREFIX}${key}`)) || 0;
    return {
        provider: 'redis',
        persistent: true,
        async counts(keys) {
            const values = await Promise.all(keys.map((key) => countOf(key).catch(() => 0)));
            return Object.fromEntries(keys.map((key, index) => [key, values[index]]));
        },
        async like(key, visitor) {
            await command('SADD', `${REDIS_PREFIX}${key}`, visitor);
            return { count: await countOf(key), liked: true };
        },
        async unlike(key, visitor) {
            await command('SREM', `${REDIS_PREFIX}${key}`, visitor);
            return { count: await countOf(key), liked: false };
        },
        async status() {
            return { keys: null };
        },
    };
}

/* ------------------------------------------------------------------ */
/* Pemilihan adapter                                                   */
/* ------------------------------------------------------------------ */
/** @returns {{adapter: object|null, reason: string, mode: string}} */
export function pickReactionAdapter() {
    const mode = String(REACTIONS.store || '').toLowerCase();
    const url = REACTIONS.redisUrl;
    const token = REACTIONS.redisToken;
    const chosen = mode || (url && token ? 'redis' : (process.env.VERCEL ? 'memory' : 'file'));

    if (chosen === 'off') {
        return {
            adapter: null,
            mode: 'off',
            reason: 'REACTION_STORE=off — hitungan suka nonaktif; tombol suka tetap mencatat jejak di perangkat.',
        };
    }
    if (chosen === 'redis') {
        if (!url || !token) {
            return {
                adapter: null,
                mode: 'redis',
                reason: 'REACTION_STORE=redis tetapi KV_REST_API_URL/KV_REST_API_TOKEN belum diisi.',
            };
        }
        return { adapter: redisAdapter({ url, token }), mode: 'redis', reason: '' };
    }
    if (chosen === 'memory') return { adapter: createMemoryAdapter(), mode: 'memory', reason: '' };
    if (chosen === 'file') return { adapter: createFileAdapter(REACTIONS.dataDir), mode: 'file', reason: '' };
    return {
        adapter: createMemoryAdapter(),
        mode: 'memory',
        reason: `REACTION_STORE="${chosen}" tidak dikenal — memakai memori (hilang saat server berhenti).`,
    };
}

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */
/**
 * @param {{adapter?: object|null, mode?: string, reason?: string}} [override] dipakai tes
 */
export function createReactionStore(override = {}) {
    const picked = 'adapter' in override ? { adapter: override.adapter, mode: override.mode || 'custom', reason: override.reason || '' } : pickReactionAdapter();
    const adapter = picked.adapter || null;

    return {
        get enabled() {
            return Boolean(adapter);
        },
        get provider() {
            return adapter?.provider || 'none';
        },
        get persistent() {
            return Boolean(adapter?.persistent);
        },
        get reason() {
            return adapter ? '' : picked.reason || '';
        },

        async status() {
            let keys = null;
            try {
                keys = adapter?.status ? (await adapter.status()).keys ?? null : null;
            } catch {
                keys = null;
            }
            return {
                enabled: Boolean(adapter),
                provider: adapter?.provider || 'none',
                persistent: Boolean(adapter?.persistent),
                mode: picked.mode,
                keys,
                reason: adapter ? '' : picked.reason || '',
            };
        },

        /**
         * Hitungan beberapa key sekaligus.
         * @param {string[]} keys sudah dinormalisasi
         * @returns {Promise<Record<string, number>>}
         */
        async counts(keys) {
            if (!adapter) return Object.fromEntries(keys.map((key) => [key, 0]));
            try {
                return await adapter.counts(keys);
            } catch {
                // Jangan pernah menggagalkan halaman nonton karena hitungan suka.
                return Object.fromEntries(keys.map((key) => [key, 0]));
            }
        },

        /**
         * Tandai suka / batalkan suka.
         * @param {string} key
         * @param {string} visitor
         * @param {boolean} liked true = suka, false = batal
         * @returns {Promise<{count:number, liked:boolean}>}
         */
        async setLike(key, visitor, liked) {
            if (!adapter) return { count: 0, liked: Boolean(liked), disabled: true };
            const result = liked ? await adapter.like(key, visitor) : await adapter.unlike(key, visitor);
            return { count: Number(result?.count) || 0, liked: Boolean(result?.liked) };
        },
    };
}
