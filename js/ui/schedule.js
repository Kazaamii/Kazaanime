/**
 * Kazanime — ui/schedule.js
 * Render grid "Jadwal Rilis" (Senin → Minggu). UI murni: data dari api/index.js.
 *
 * Perbaikan:
 *  - Hari ini dihitung (dulu "Rabu ✨" ditulis mati di HTML sehingga yang
 *    disorot selalu Rabu). Tahap B: "hari ini" mengikuti WIB.
 *  - Tahap B: item bisa berupa link ke watch.html + nomor episode.
 *  - 22 Okt 2026: item tanpa jam (donghua AnimeXin) tampil "—".
 */
import { DAY_NAMES } from '../config.js';
import { html } from './dom.js';

const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Senin dulu, seperti tampilan asli

/** @typedef {{time:string|null, title:string, episode?:number|null, href?:string}} ScheduleItem */

/**
 * @param {HTMLElement} grid
 * @param {Record<number, Array<[string, string] | ScheduleItem>>} byDay
 * @param {{today?: number, timeLabel?: string}} [opts]
 */
export function renderSchedule(grid, byDay, { today = new Date().getDay(), timeLabel = '' } = {}) {
    if (!grid) return;
    grid.innerHTML = String(html`${WEEK_ORDER.map((day) => {
        const items = (byDay[day] || []).map((it) => (Array.isArray(it) ? { time: it[0], title: it[1] } : it));
        const isToday = day === today;
        return html`
        <div class="schedule-day${isToday ? ' today' : ''}"${isToday ? html` aria-current="date"` : ''}>
            <h4>${DAY_NAMES[day]}${isToday ? ' ✨' : ''}</h4>
            ${items.length
                ? items.map((it) => {
                    const when = it.time ? `${it.time}${timeLabel ? ` ${timeLabel}` : ''}` : 'jam rilis tidak dicantumkan';
                    const tip = `${it.title}${it.episode ? ` — Episode ${it.episode}` : ''} (${when})`;
                    const inner = html`<span class="schedule-time">${it.time || '—'}</span><span class="schedule-anime">${it.title}</span>${it.episode ? html`<span class="schedule-ep">EP ${it.episode}</span>` : ''}`;
                    return it.href
                        ? html`<a class="schedule-item" href="${it.href}" title="${tip}">${inner}</a>`
                        : html`<div class="schedule-item" title="${tip}">${inner}</div>`;
                })
                : html`<p class="schedule-empty">Tidak ada jadwal</p>`}
        </div>`;
    })}`);
    grid.setAttribute('aria-busy', 'false');
}

/** Kerangka loading jadwal (7 kolom dengan garis shimmer). */
export function renderScheduleSkeleton(grid, { today = new Date().getDay() } = {}) {
    if (!grid) return;
    grid.setAttribute('aria-busy', 'true');
    grid.innerHTML = String(html`${WEEK_ORDER.map((day) => html`
        <div class="schedule-day${day === today ? ' today' : ''}" aria-hidden="true">
            <h4>${DAY_NAMES[day]}${day === today ? ' ✨' : ''}</h4>
            <div class="skeleton-line schedule-skeleton loading-shimmer"></div>
            <div class="skeleton-line schedule-skeleton loading-shimmer"></div>
            <div class="skeleton-line schedule-skeleton loading-shimmer"></div>
        </div>`)}`);
}
