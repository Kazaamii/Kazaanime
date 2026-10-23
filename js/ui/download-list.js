/**
 * Kazanime — ui/download-list.js
 * Bagian "📥 Download Episode" di watch.html.
 *
 * Data datang dari js/api (getEpisodeExtras → backend scraper, Tahap D) sudah berbentuk:
 *   [{ quality: '720p', size: '120MB', format: 'MP4', subtitle: 'Sub Indo', links: [{ provider, url }] }]
 * format & subtitle opsional (default "MP4" / "Sub Indo", sama seperti tampilan sebelumnya).
 *
 * Perbaikan dari file asli:
 *  - handleDownload() palsu ("Download siap! Cek folder downloads" tanpa mengunduh apa pun)
 *    dan daftar 1080p/720p/480p/360p "contoh" dihapus: link hanya tampil bila memang ada.
 *  - URL & nama provider di-escape + hanya http(s) (dulu href mentah dari API).
 *  - Tanpa toast "berhasil dimuat" di setiap ganti episode (dulu menumpuk dengan toast lain).
 */
import { html, safeUrl } from './dom.js';
import { icon } from './icons.js';

const QUALITY = {
    '1080p': { cls: 'dq-1080', label: 'Full HD' },
    '720p': { cls: 'dq-720', label: 'HD' },
    '480p': { cls: 'dq-480', label: 'SD' },
    '360p': { cls: 'dq-360', label: 'Low' },
};

/** "1080P", "1080", "FHD 1080p" → kunci QUALITY bila dikenali. */
function qualityKey(q) {
    const m = /(1080|720|480|360)/.exec(String(q || ''));
    return m ? `${m[1]}p` : '';
}

/**
 * @param {HTMLElement} box  #downloadList
 * @param {{
 *   loading?: boolean,
 *   loadingText?: string,
 *   items?: {quality:string,size:string,format?:string,subtitle?:string,links:{provider:string,url:string}[]}[],
 *   ep?: number,
 *   contextLabel?: string,
 *   emptyText?: string,
 *   emptyHeading?: string,
 *   source?: string|null,
 *   disabled?: boolean,         backend belum aktif
 *   error?: {message?:string}|null,
 *   errorText?: string,         pesan ramah untuk error
 *   onRetry?: () => void,
 * }} state
 */
export function renderDownloads(box, state = {}) {
    if (!box) return;
    box.setAttribute('aria-busy', state.loading ? 'true' : 'false');

    if (state.loading) {
        box.innerHTML = String(html`
            <div class="download-loading">
                <div class="loading-shimmer" aria-hidden="true"></div>
                <p>${icon('loader-circle', { cls: 'ic--spin' })} ${state.loadingText || 'Mencari link download...'}</p>
            </div>`);
        return;
    }

    const groups = (state.items || [])
        .map((g) => ({ ...g, links: (g.links || []).map((l) => ({ ...l, url: safeUrl(l.url) })).filter((l) => l.url) }))
        .filter((g) => g.links.length)
        .sort((a, b) => (Number.parseInt(qualityKey(b.quality), 10) || 0) - (Number.parseInt(qualityKey(a.quality), 10) || 0));

    if (groups.length) {
        box.innerHTML = String(html`
            ${groups.map((g) => {
                const q = QUALITY[qualityKey(g.quality)] || { cls: 'dq-360', label: g.quality };
                return html`
                <div class="download-item">
                    <div class="download-info">
                        <span class="download-quality ${q.cls}">${g.quality}</span>
                        <div class="download-detail"><strong>${q.label}</strong>${g.format || 'MP4'}${g.size ? ` • ${g.size}` : ''} • ${g.subtitle || 'Sub Indo'}</div>
                    </div>
                    <div class="download-links">
                        ${g.links.map((l) => html`<a class="btn-download btn-download--sm" href="${l.url}" target="_blank" rel="noopener noreferrer nofollow" title="Download dari ${l.provider}">${l.provider}</a>`)}
                    </div>
                </div>`;
            })}
            <div class="download-notice download-notice--ok">
                <strong>${icon('circle-check')} ${state.contextLabel || (state.ep ? `Episode ${state.ep}` : 'Download')}</strong> — link dari ${state.source || 'sumber'} (dibuka di tab baru).
            </div>`);
        return;
    }

    const text = state.disabled
        ? (state.emptyText || 'untuk episode ini. Gunakan platform streaming legal di bawah atau coba anime lain.')
        : state.error
            ? `— ${state.errorText || 'gagal memuat link download.'}`
            : (state.emptyText || 'untuk episode ini. Gunakan platform streaming legal di bawah atau coba anime lain.');
    box.innerHTML = String(html`
        <div class="download-notice download-notice--warn">
            <p><strong>${icon('triangle-alert')} ${state.emptyHeading || 'Link download belum tersedia'}</strong> ${text}</p>
            ${state.onRetry && state.error ? html`<button type="button" class="download-retry" data-action="retry">${icon('refresh-cw')} Coba lagi</button>` : ''}
        </div>`);
    if (state.onRetry && state.error) {
        box.querySelector('[data-action="retry"]')?.addEventListener('click', state.onRetry, { once: true });
    }
}
