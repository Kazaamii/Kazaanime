/**
 * Kazanime — api/index.js (Vercel Function)
 * Semua request /api/* diarahkan ke sini oleh "rewrites" di vercel.json; Express membaca
 * path aslinya (req.url tetap /api/anime/...). Frontend statis TIDAK lewat sini — dilayani CDN.
 *
 * Instance aplikasi dibuat sekali per instance function, jadi cache memori & throttle
 * bertahan di antara request yang ditangani instance yang sama (Fluid compute).
 */
import { createApp } from '../server/app.js';

export default createApp();
