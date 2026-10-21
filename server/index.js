/**
 * Kazanime backend — index.js (server LOKAL)
 *   npm install
 *   npm run dev      → http://localhost:3000  (frontend + /api, auto-restart saat file server berubah)
 *   npm start        → sama, tanpa watch
 *
 * Di Vercel file ini TIDAK dipakai: frontend dilayani CDN, /api/* diarahkan ke api/index.js.
 */
import { BOT, SERVER, SOURCES } from './config.js';
import { createApp } from './app.js';

const app = createApp({ serveStatic: true });

const server = app.listen(SERVER.port, SERVER.host, () => {
    const shown = SERVER.host === '0.0.0.0' ? 'localhost' : SERVER.host;
    console.log(`\n🌸 Kazanime berjalan di http://${shown}:${SERVER.port}`);
    console.log(`   API      : http://${shown}:${SERVER.port}/api/health`);
    console.log(`   Sumber   : ${SOURCES.enabled.join(', ') || '(tidak ada)'}`);
    console.log(`   UA bot   : ${BOT.userAgent}\n`);
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') console.error(`❌ Port ${SERVER.port} sudah dipakai. Jalankan dengan PORT=3001 npm run dev`);
    else console.error('❌ Server gagal berjalan:', err.message);
    process.exit(1);
});

function shutdown(signal) {
    console.log(`\n${signal} diterima — menutup server...`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
