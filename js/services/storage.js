/**
 * Kazanime — services/storage.js
 * Pembungkus localStorage yang aman: tidak melempar error saat storage penuh,
 * diblokir (mode privat), atau JSON rusak. Dulu JSON.parse langsung dipanggil
 * di banyak tempat; satu data korup bisa mematikan seluruh halaman.
 */

function available() {
    try {
        const k = '__kazanime_test__';
        window.localStorage.setItem(k, '1');
        window.localStorage.removeItem(k);
        return true;
    } catch {
        return false;
    }
}

const enabled = available();
const memory = new Map(); // cadangan bila localStorage tidak tersedia

export const storage = {
    enabled,

    /** Ambil string mentah (untuk nilai lama yang bukan JSON, mis. tema & username). */
    getRaw(key) {
        try {
            return enabled ? window.localStorage.getItem(key) : memory.get(key) ?? null;
        } catch {
            return null;
        }
    },

    setRaw(key, value) {
        try {
            if (enabled) window.localStorage.setItem(key, String(value));
            else memory.set(key, String(value));
            return true;
        } catch (err) {
            console.warn('[storage] gagal menyimpan', key, err);
            return false;
        }
    },

    /** Ambil & parse JSON; kembalikan fallback bila kosong/korup. */
    get(key, fallback = null) {
        const rawValue = this.getRaw(key);
        if (rawValue == null) return fallback;
        try {
            return JSON.parse(rawValue);
        } catch {
            console.warn('[storage] data korup, diabaikan:', key);
            return fallback;
        }
    },

    set(key, value) {
        return this.setRaw(key, JSON.stringify(value));
    },

    remove(key) {
        try {
            if (enabled) window.localStorage.removeItem(key);
            else memory.delete(key);
        } catch {
            /* abaikan */
        }
    },
};
