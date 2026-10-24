/**
 * Kazanime backend — lib/anx-signer.js
 * Klien protokol "AnxGuard" milik API AnimeXNonton (dipakai aplikasi Miku Moe 3.6).
 *
 * ⚠️  BACA DULU — STATUS IMPLEMENTASI
 * ---------------------------------------------------------------------------------------
 * Yang SUDAH terverifikasi dari hasil decompile APK (libmikumoe.so, simbol JNI tidak di-strip):
 *
 *   1. KDF `h91b(label, key, salt)` = HKDF gaya HMAC-SHA256 dua langkah:
 *          prk = HMAC-SHA256(key, salt)
 *          okm = HMAC-SHA256(prk, label)
 *      Terbukti dari urutan instruksi: Mac.getInstance("HmacSHA256") → SecretKeySpec(key)
 *      → Mac.init → Mac.doFinal(salt) → SecretKeySpec(prk) → Mac.init → StringBuilder
 *      (append label) → getBytes(UTF_8) → Mac.doFinal.
 *      Dua label yang dipakai aplikasi: "master" dan "sig".
 *   2. Body form dienkripsi AES/GCM/NoPadding, AAD = "anx-req|<X-Anx-Ts>",
 *      lalu dikirim sebagai `anx=<base64(ciphertext)>`.
 *   3. `X-Anx-Cert` = 16 hex pertama SHA-256 sertifikat penanda tangan APK (cert-lock),
 *      bisa diganti dari jarak jauh lewat pastebin (REMOTE_CERT_URL).
 *   4. Header wajib: X-Anx-Ts, X-Anx-N (nonce), X-Anx-Ver=25, X-Anx-Cert, X-Anx-Rsp, X-Anx-Sig.
 *   5. `X-Anx-Sig` = hex(HMAC-SHA256(kunci "sig", "<string kanonik>")) dan string kanonik itu
 *      pasti memuat literal "\n25\n" di tengahnya.
 *
 * Yang BELUM diketahui (karena itu mode "live" belum bisa dipakai apa adanya):
 *   a. urutan & pemisah persis string kanonik (yang digabung: method, path/url, hash body,
 *      timestamp, nonce — tapi urutannya tidak terbaca dari call trace JNI);
 *   b. konstruksi IV untuk AES-GCM (apakah 12 byte acak, potongan nonce, atau turunan h91b).
 *
 * Karena itu fungsi `sign()` menerima TEMPLATE kanonik dari luar (env ANX_CANONICAL_TEMPLATE).
 * Tanpa template, mode live akan menolak dengan pesan jelas — tidak ada tebakan yang
 * dikirim ke server orang lain.
 * ---------------------------------------------------------------------------------------
 */
import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

/** Konstanta yang dibaca langsung dari APK. */
export const ANX = Object.freeze({
    /** AnxGuardInterceptor.MASTER_HEX (32 byte). */
    masterHex: '0f4be99c888e987925fad6650daae56e5fc002ee1286a6c24fead72f29365862',
    /** AnxGuardInterceptor.SALT ("anx-guard-v1-salt" sebagai byte UTF-8). */
    salt: Buffer.from('anx-guard-v1-salt', 'utf8'),
    ua: 'AnimeXNonton/26.10.7 (25; Android 14; Pixel 8)',
    ver: '25',
    /** Cert build asli; APK mod memakai nilai dari pastebin. */
    fallbackCert: '1a70a8a890d82093',
    remoteCertUrl: 'https://pastebin.com/raw/Lfy0gjdU',
    baseDefault: 'https://api.wincamp.web.id/animexnonton',
});

/**
 * `h91b` — HKDF-HMAC-SHA256 dua langkah (extract lalu expand satu blok).
 * @param {string} label "master" | "sig"
 * @param {Buffer} key
 * @param {Buffer} salt
 * @returns {Buffer} 32 byte
 */
export function hkdfLabel(label, key, salt = ANX.salt) {
    const prk = createHmac('sha256', key).update(salt).digest();
    return createHmac('sha256', prk).update(Buffer.from(label, 'utf8')).digest();
}

/**
 * Turunan kunci yang dipakai aplikasi:
 *   masterKey = h91b("master", hexToBytes(MASTER_HEX), SALT)
 *   sigKey    = h91b("sig",    masterKey,             SALT)
 * @param {string} [masterHex]
 */
export function deriveKeys(masterHex = ANX.masterHex) {
    const master = Buffer.from(masterHex, 'hex');
    const masterKey = hkdfLabel('master', master);
    const sigKey = hkdfLabel('sig', masterKey);
    return { master, masterKey, sigKey };
}

export const hex = (buf) => Buffer.from(buf).toString('hex');
export const urlSafeNoPad = (buf) => Buffer.from(buf).toString('base64url').replace(/=+$/, '');
export const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * Kandidat string kanonik. Disediakan sebagai BAHAN UJI (bukan tebakan yang dikirim otomatis):
 * daftar ini bisa dipakai untuk mencocokkan satu tangkapan asli dari perangkat.
 *
 * @param {{method:string, path:string, bodyHash:string, ts:number|string, nonce:string}} p
 * @returns {{name:string, canonical:string}[]}
 */
export function canonicalCandidates({ method, path, bodyHash, ts, nonce }) {
    const t = String(ts);
    const out = [];
    const push = (name, parts) => out.push({ name, canonical: parts.join('') });
    // Literal "\n25\n" wajib ada; posisinya yang belum pasti.
    push('A: method+path+hash+ts+nonce', [method, '\n', path, '\n', bodyHash, '\n', t, '\n', ANX.ver, '\n', nonce]);
    push('B: method+path+hash+\\n25\\n+ts+nonce', [method, '\n', path, '\n', bodyHash, '\n', ANX.ver, '\n', t, '\n', nonce]);
    push('C: path+hash+ts+\\n25\\n+nonce', [path, '\n', bodyHash, '\n', t, '\n', ANX.ver, '\n', nonce]);
    push('D: hash+ts+nonce+\\n25\\n', [bodyHash, '\n', t, '\n', nonce, '\n', ANX.ver, '\n']);
    push('E: method+path+ts+nonce+\\n25\\n+hash', [method, '\n', path, '\n', t, '\n', nonce, '\n', ANX.ver, '\n', bodyHash]);
    return out;
}

/**
 * Bangun string kanonik dari template.
 * Placeholder: {method} {path} {bodyHash} {ts} {nonce} {ver}
 * @param {string} template
 * @param {Record<string, string|number>} values
 */
export function renderCanonical(template, values) {
    return String(template).replace(/\{(\w+)\}/g, (m, key) => (key in values ? String(values[key]) : m));
}

/**
 * Hitung X-Anx-Sig.
 * @param {Buffer} sigKey hasil deriveKeys().sigKey
 * @param {string} canonical
 */
export function signCanonical(sigKey, canonical) {
    return hex(createHmac('sha256', sigKey).update(Buffer.from(canonical, 'utf8')).digest());
}

/**
 * Enkripsi body form → "anx=<base64>".
 * AAD persis seperti aplikasi: "anx-req|<ts>".
 * @param {Buffer} key 32 byte (masterKey)
 * @param {string} formString mis. "page=1&count=10&isAPKvalid=25"
 * @param {number|string} ts
 * @param {Buffer} [iv] 12 byte; dibiarkan dapat diisi dari luar karena skemanya belum pasti
 */
export function encryptBody(key, formString, ts, iv = randomBytes(12)) {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`anx-req|${ts}`, 'utf8'));
    const ct = Buffer.concat([cipher.update(Buffer.from(formString, 'utf8')), cipher.final()]);
    return { body: `anx=${ct.toString('base64')}`, iv, tag: cipher.getAuthTag() };
}

/**
 * Nilai `X-Anx-Cert` yang dipakai.
 *
 * Aplikasi mengambilnya dari pastebin miliknya sendiri. Adapter di sini **tidak** melakukan
 * request ke host lain: seluruh lalu lintas keluar Kazanime hanya lewat `lib/fetcher.js`
 * dengan allowlist per sumber, dan pastebin bukan host sumber ini. Nilai diambil dari
 * `ANX_CERT` (bila operator mengisinya sendiri) atau konstanta build di atas.
 *
 * @param {string} [override]
 * @returns {string} 16–64 hex
 */
export function resolveCert(override) {
    const value = String(override || ANX.fallbackCert || '').trim();
    return /^[0-9a-f]{8,64}$/i.test(value) ? value : ANX.fallbackCert;
}

/**
 * Apakah protokol ini bisa dipakai? Hanya bila template kanonik tersedia.
 * @param {string} [template]
 */
export function liveReady(template) {
    return typeof template === 'string' && /\{bodyHash\}/.test(template) && /\{ts\}/.test(template);
}
