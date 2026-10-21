/**
 * Kazanime — ui/schedule.js
 * Render grid "Jadwal Rilis" (Senin → Minggu).
 * Perbaikan: hari ini dihitung dari tanggal perangkat (dulu "Rabu ✨" ditulis
 * mati di HTML sehingga yang disorot selalu Rabu).
 */
import { DAY_NAMES } from '../config.js';
import { html } from './dom.js';

const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Senin dulu, seperti tampilan asli

/**
 * @param {HTMLElement} grid
 * @param {Record<number, Array<[string, string] | {time:string, title:string, href?:string}>>} byDay
 * @param {{today?: number}} [opts]
 */
export function renderSchedule(grid, byDay, { today = new Date().getDay() } = {}) {
    if (!grid) return;
    grid.innerHTML = String(html`${WEEK_ORDER.map((day) => {
        const items = (byDay[day] || []).map((it) => (Array.isArray(it) ? { time: it[0], title: it[1] } : it));
        const isToday = day === today;
        return html`
        <div class="schedule-day${isToday ? ' today' : ''}"${isToday ? html` aria-current="date"` : ''}>
            <h4>${DAY_NAMES[day]}${isToday ? ' ✨' : ''}</h4>
            ${items.length
                ? items.map((it) => (it.href
                    ? html`<a class="schedule-item" href="${it.href}" title="${it.title}"><span class="schedule-time">${it.time}</span><span class="schedule-anime">${it.title}</span></a>`
                    : html`<div class="schedule-item"><span class="schedule-time">${it.time}</span><span class="schedule-anime">${it.title}</span></div>`))
                : html`<p class="schedule-empty">Tidak ada jadwal</p>`}
        </div>`;
    })}`);
}
