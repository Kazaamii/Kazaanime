/*
 * Kazanime — theme-preload.js
 * Script KLASIK (bukan module) yang dimuat sinkron di <head>.
 * Tugasnya cuma satu: memasang data-theme dari localStorage SEBELUM halaman
 * dirender, supaya tidak ada "kedip" tema Sakura → tema pilihan user.
 * Logika tema lengkap (efek partikel, modal) ada di js/services/theme.js.
 */
(function () {
    try {
        var theme = localStorage.getItem('kazanime-theme');
        var valid = ['autumn', 'winter', 'summer', 'midnight', 'neon', 'forest'];
        if (theme && valid.indexOf(theme) !== -1) {
            document.documentElement.setAttribute('data-theme', theme);
        }
    } catch (e) {
        /* localStorage diblokir (mode privat ketat) → pakai tema default */
    }
})();
