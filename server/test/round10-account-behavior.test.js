/**
 * Kazanime — round10-account-behavior.test.js
 * Uji PERILAKU (bukan sekadar kontrak file) untuk akun putaran 10.
 *
 * Yang diuji tanpa peramban (Node + shim `window`, `localStorage`, `btoa`/`atob`,
 * `CompressionStream` yang semuanya tersedia/ mudah ditiru):
 *   1. "pengguna tidak ditemukan" — akun yang sama harus ditemukan walau ditulis dengan
 *      huruf besar/kecil berbeda, spasi tambahan, atau pointer lama yang tidak rapi.
 *   2. Data akun rusak → pulih otomatis dari cadangan, bukan menghapus akun.
 *   3. Kode sinkron `KZ1Z-` (terkompresi) & `KZ1-` bolak-balik utuh.
 *   4. Pulihkan di "perangkat lain" (localStorage kosong): akun hasil cadangan bisa login
 *      dengan password aslinya, dan akun yang sudah ada di perangkat tidak hilang.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

/* ------------------------------------------------------------------ */
/* Shim peramban minimal                                              */
/* ------------------------------------------------------------------ */
const store = new Map();
const localStorageShim = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); },
    clear: () => store.clear(),
    get length() { return store.size; },
    key: (index) => [...store.keys()][index] ?? null,
};

globalThis.window = {
    localStorage: localStorageShim,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
};
globalThis.localStorage = localStorageShim;

const auth = await import('../../js/services/auth.js');
const backup = await import('../../js/services/account-backup.js');
const { STORAGE_KEYS } = await import('../../js/config.js');

const reset = () => { store.clear(); auth.logout(); };
const avatar = { id: 3, name: 'Zero Two' };

test('login menemukan akun walau huruf besar/kecil & spasi berbeda', async () => {
    reset();
    const reg = await auth.register({ username: 'Rully', password: 'rahasia123', avatar });
    assert.equal(reg.ok, true, JSON.stringify(reg));
    assert.equal(auth.getCurrentUser().username, 'Rully');

    auth.logout();
    const lower = await auth.login({ username: '  rully  ', password: 'rahasia123' });
    assert.equal(lower.ok, true, 'login dengan spasi & huruf kecil harus berhasil');
    assert.equal(auth.getCurrentUser().username, 'Rully');

    // Pointer lama yang masih memakai ejaan berbeda tidak boleh membuat user "hilang".
    localStorageShim.setItem(STORAGE_KEYS.currentUser, 'RULLY');
    assert.equal(auth.getCurrentUser()?.username, 'Rully');
    assert.equal(localStorageShim.getItem(STORAGE_KEYS.currentUser), 'Rully', 'pointer dirapikan');
});

test('data akun korup dipulihkan dari cadangan otomatis (tidak menghapus akun)', async () => {
    reset();
    await auth.register({ username: 'Sinta', password: 'rahasia123', avatar });
    assert.ok(localStorageShim.getItem(STORAGE_KEYS.usersBackup), 'cadangan otomatis harus ada setelah menulis');

    // Simulasi data utama rusak (kuota penuh saat menulis / ekstensi mengacak nilai).
    localStorageShim.setItem(STORAGE_KEYS.users, '{rusak');
    const users = auth.exportUsers();
    assert.equal(users.Sinta?.username, 'Sinta', 'akun dipulihkan dari cadangan');
    assert.equal(localStorageShim.getItem('kazanime-users-corrupt'), '{rusak', 'data rusak disimpan untuk diperiksa');

    const login = await auth.login({ username: 'sinta', password: 'rahasia123' });
    assert.equal(login.ok, true, 'setelah dipulihkan, login tetap bisa');
});

test('kode sinkron KZ1Z- bolak-balik utuh dan bisa memulihkan di perangkat lain', async () => {
    reset();
    await auth.register({ username: 'Rully', password: 'rahasia123', avatar: { id: 7, name: 'Makima' } });
    auth.updateCurrentRecord((record) => {
        record.bookmarks = [{ title: 'Frieren', ids: { anilist: 1 }, addedAt: 5 }];
    });

    const made = await backup.createSyncCode();
    assert.equal(made.ok, true, JSON.stringify(made));
    assert.match(made.code, /^KZ1Z?-/);
    assert.ok(made.code.length < 4000, 'kode harus cukup pendek untuk ditempel di chat');

    const parsed = await backup.parseSyncCode(made.code);
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
    assert.equal(parsed.bundle.app, 'kazanime');
    assert.equal(parsed.bundle.type, 'account-backup');
    assert.equal(parsed.bundle.users.Rully.username, 'Rully');
    assert.equal(parsed.bundle.users.Rully.bookmarks.length, 1);

    // "Perangkat lain": localStorage kosong, lalu pulihkan dari kode.
    store.clear();
    assert.equal(auth.getCurrentUser(), null);
    const restored = backup.restoreBundle(parsed.bundle);
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.equal(restored.loggedInAs, 'Rully');
    assert.equal(auth.getCurrentUser()?.username, 'Rully');

    const login = await auth.login({ username: 'rully', password: 'rahasia123' });
    assert.equal(login.ok, true, 'password asli tetap berlaku setelah pemulihan');
    assert.equal(auth.readCurrentRecord().record.bookmarks.length, 1, 'bookmark ikut dipulihkan');
});

test('kode sinkron menolak teks asal & kode terpotong', async () => {
    assert.equal((await backup.parseSyncCode('bukan kode')).ok, false);
    assert.equal((await backup.parseSyncCode('KZ1-')).ok, false);
    const res = await backup.parseSyncCode('KZ1-AAAA');
    assert.equal(res.ok, false);
    assert.match(res.error, /tidak valid|rusak/i);
});

test('pemulihan tidak menghapus akun yang sudah ada & data terbaru dipakai', async () => {
    reset();
    await auth.register({ username: 'Rully', password: 'rahasia123', avatar });
    const bundle = backup.buildBundle();

    // Perangkat kedua punya akun lokal sendiri.
    store.clear();
    await auth.register({ username: 'Sinta', password: 'rahasia456', avatar });

    const res = backup.restoreBundle(bundle, { loginUser: 'Rully' });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.added, 1, 'akun dari cadangan ditambahkan');
    assert.equal(res.skipped, 0);
    const names = auth.listAccounts().map((a) => a.username).sort();
    assert.deepEqual(names, ['Rully', 'Sinta'], 'akun lama tidak boleh hilang');
    assert.equal(auth.getCurrentUser()?.username, 'Rully', 'pemulihan bisa langsung login');
});

test('avatar preset tersimpan lalu dibaca ulang tanpa kehilangan gambar', async () => {
    reset();
    await auth.register({ username: 'Budi', password: 'rahasia123', avatar: { id: 22, name: 'Frieren' } });
    const user = auth.getCurrentUser();
    assert.equal(user.avatar.id, 22);
    assert.match(user.avatar.img, /^assets\/avatars\/photo-22-frieren\.jpg$/, 'ilustrasi lokal dipakai');
    assert.match(user.avatar.card, /^assets\/avatars\/22-frieren\.svg$/, 'kartu cadangan tetap tersedia');

    // Avatar tersimpan lama (tanpa `img` di data) tetap dirapikan dari config.
    auth.updateCurrentRecord((record) => { record.avatar = { id: 3, name: 'Zero Two' }; });
    const refreshed = auth.getCurrentUser();
    assert.match(refreshed.avatar.img, /^https:\/\/media\.kitsu\.app\/character\/95090\/image\/large-[0-9a-f]{32}\.jpeg$/);
});
