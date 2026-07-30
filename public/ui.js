import { getAttendanceRowForClass, parseAttendanceCell } from './data.js';

const days = ['月', '火', '水', '木', '金'];
const periodTimes = {
    1: '9:00 ～ 10:30',
    2: '10:40 ～ 12:10',
    3: '13:00 ～ 14:30',
    4: '14:40 ～ 16:10',
    5: '16:20 ～ 17:50'
};

const escapeHtml = (text) => {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
};

const safeExternalUrl = (value) => {
    try {
        const url = new URL(String(value || ''));
        if (
            url.protocol !== 'https:' ||
            url.hostname !== 'moodle2026.shonan-it.ac.jp' ||
            url.port ||
            url.username ||
            url.password
        ) {
            return null;
        }
        return url.href;
    } catch {
        return null;
    }
};

const getDayLabel = (day) => {
    const labels = ['日', '月', '火', '水', '木', '金', '土'];
    return labels[day] || '不明';
};

const scrollScheduleToCurrentPosition = () => {
    const scheduleList = document.getElementById('schedule-list');
    if (!scheduleList) return;
    const dayHeader = scheduleList.querySelector('.grid-header.current-day');
    const currentTimeCell = scheduleList.querySelector('.current-time');
    const targetElement = dayHeader || currentTimeCell;
    if (!targetElement) return;

    scheduleList.scrollLeft = 0;
    targetElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
};

export const renderSchedule = (data) => {
    const { weekday, currentPeriod } = getCurrentSchedulePosition();
    const isWeekend = new Date().getDay() === 0 || new Date().getDay() === 6;
    const headerHtml = `<div class="grid-header"></div>${days.map((d, index) => `<div class="grid-header${index === weekday && !isWeekend ? ' current-day' : ''}">${d}</div>`).join('')}`;

    let bodyHtml = '';
    for (let p = 1; p <= 5; p++) {
        bodyHtml += `<div class="period-label"><div class="period-number">${p}限</div><div class="period-time">${periodTimes[p]}</div></div>`;
        for (let d = 1; d <= 5; d++) {
            const cell = data.schedule.find(s => s.period === p && s.day === d);
            const isRegistered = cell && !(cell.code || '').trim().includes('未登録');
            let content = `<div class="empty-text">未登録</div>`;
            let cellClass = 'grid-cell empty-slot';
            let cellDataAttrs = '';

            if (cell && isRegistered) {
                let display = `<strong>${escapeHtml(cell.code)}</strong>`;
                if (cell.name) display += `<div style="font-size: 0.75rem; margin-top: 4px;">${escapeHtml(cell.name)}</div>`;
                if (cell.teacher) display += `<div style="font-size: 0.72rem; color: #e2e8f0; margin-top: 4px;">${escapeHtml(cell.teacher)}</div>`;
                content = `<div class="cell-inner">${display}</div>`;
                cellClass = 'grid-cell has-content clickable-slot';
                cellDataAttrs = `data-code="${escapeHtml(cell.code)}" data-name="${escapeHtml(cell.name || '')}" data-teacher="${escapeHtml(cell.teacher || '')}" data-day="${d}" data-period="${p}"`;
            }
            if (!isWeekend && (d - 1) === weekday && p === currentPeriod) {
                cellClass += ' current-time';
            }
            bodyHtml += `<div class="${cellClass}" ${cellDataAttrs}>${content}</div>`;
        }
    }
    document.getElementById('schedule-list').innerHTML = `<div class="schedule-grid">${headerHtml}${bodyHtml}</div>`;
    requestAnimationFrame(() => scrollScheduleToCurrentPosition());
    setTimeout(scrollScheduleToCurrentPosition, 120);
    setTimeout(scrollScheduleToCurrentPosition, 300);
    setTimeout(scrollScheduleToCurrentPosition, 600);
};

export const renderList = (id, list) => {
    const html = list && list.length ? list.map(item => {
        const title = typeof item === 'string' ? item : item.name || item.title;
        const url = safeExternalUrl(item.url);
        return url
            ? `<a class="card course-card course-card-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(title)}</a>`
            : `<div class="card course-card">${escapeHtml(title)}</div>`;
    }).join('') : 'データなし';
    document.getElementById(id).innerHTML = html;
};

export const renderAssignments = (id, tasks) => {
    if (!tasks || tasks.length === 0) {
        document.getElementById(id).innerHTML = '<div class="card course-card">データなし</div>';
        return;
    }
    const html = tasks.map(group => `
        <div class="timeline-group">
            <div class="timeline-group-header">${escapeHtml(group.date || '期限不明')}</div>
            <div class="timeline-list">
                ${group.tasks.map(task => `
                    <div class="timeline-event-item">
                        <div class="timeline-event-time">${escapeHtml(task.time || '')}</div>
                        <div class="timeline-event-body">
                            <div class="timeline-event-title">${escapeHtml(task.title)}</div>
                            <div class="timeline-event-meta">${escapeHtml(task.course || task.detail || '')}</div>
                        </div>
                        <div class="timeline-event-action">
                            ${safeExternalUrl(task.url) ? `<a class="timeline-button" href="${escapeHtml(safeExternalUrl(task.url))}" target="_blank" rel="noopener noreferrer">閲覧</a>` : ''}
                        </div>
                    </div>
                `).join('')}
            </div>
        </div>
    `).join('');
    document.getElementById(id).innerHTML = html;
};

export const setStatus = (message, isError = false) => {
    const statusMessage = document.getElementById('status-message');
    if (!statusMessage) return;
    statusMessage.textContent = message;
    statusMessage.style.color = isError ? '#f87171' : '#cbd5e1';
};

export const setCacheInfo = (cachedAt, label = 'キャッシュ') => {
    const cacheInfo = document.getElementById('cache-info');
    if (!cacheInfo) return;
    if (!cachedAt) {
        cacheInfo.textContent = 'キャッシュ情報なし';
        return;
    }
    const date = new Date(cachedAt);
    cacheInfo.textContent = `${label}日時: ${date.toLocaleString()}`;
};

export const fillLoadingPlaceholders = () => {
    ['schedule-list', 'course-list', 'task-list'].forEach(elId => {
        const node = document.getElementById(elId);
        if (node) node.innerHTML = '<div class="loading">取得中...</div>';
    });
};

export const renderAttendanceDetails = (info, attendanceRows) => {
    const label = document.getElementById('detail-attendance');
    const details = document.getElementById('detail-attendance-details');
    if (label) label.textContent = '読み込み中...';
    if (details) details.innerHTML = '';

    if (!attendanceRows || !attendanceRows.length) {
        if (label) label.textContent = '出欠データがロードされていません';
        if (details) {
            details.innerHTML = '<div>出欠データがまだ読み込まれていません。再度ログインしてください。</div>';
        }
        return;
    }

    const matchResult = getAttendanceRowForClass(info, attendanceRows);
    const row = matchResult && typeof matchResult === 'object' ? (matchResult.row || matchResult) : null;
    const matchedScore = matchResult && typeof matchResult === 'object' ? (matchResult.score || 0) : 0;

    if (!row) {
        if (label) label.textContent = '出欠データ無し';
        if (details) {
            details.innerHTML = '<div>該当講義の出欠情報が見つかりませんでした。</div>';
        }
        return;
    }

    const headers = attendanceRows.reduce((acc, section) => {
        if (Array.isArray(section.headers)) acc.push(...section.headers);
        return acc;
    }, []);
    const sessionHeaders = headers.filter((header) => /^\d+$/.test(String(header).trim()));

    const dayGroups = new Map();
    const itemsHtml = sessionHeaders.map((header) => {
        const rawValue = String(row[header] || '');
        const htmlValue = escapeHtml(rawValue).replace(/\n/g, '<br/>');
        const { status, dateKey } = parseAttendanceCell(rawValue);
        const groupKey = dateKey || `header-${header}`;

        if (!dayGroups.has(groupKey)) {
            dayGroups.set(groupKey, []);
        }
        dayGroups.get(groupKey).push(status);

        return `
            <div class="attendance-status-item">
                <div class="attendance-status-number">${escapeHtml(header)}</div>
                <div class="attendance-status-value">${htmlValue}</div>
            </div>
        `;
    }).join('');

    const counts = { present: 0, absent: 0, late: 0, early: 0, other: 0 };
    const statusKeyMap = { '〇': 'present', '欠': 'absent', '遅': 'late', '早': 'early', '他': 'other' };
    const statusPriority = ['欠', '遅', '早', '〇', '他'];

    for (const statuses of dayGroups.values()) {
        const resolved = statusPriority.find((status) => statuses.includes(status)) || statuses[0] || '';
        const key = statusKeyMap[resolved];
        if (!key) continue;
        counts[key] += 1;
    }

    if (label) {
        label.textContent = `出席 ${counts.present} / 欠席 ${counts.absent} / 遅刻 ${counts.late} / 早退 ${counts.early} / その他 ${counts.other}`;
    }
    if (details) {
        details.innerHTML = `
            <div class="attendance-section">
                <div class="attendance-section-title">出欠ステータス</div>
                <div class="attendance-status-list">${itemsHtml}</div>
            </div>
        `;
    }
};

export const openDetailPanel = (info, attendanceRows) => {
    window.selectedClassInfo = info;
    const panel = document.getElementById('detail-panel');
    if (!panel) return;
    document.getElementById('detail-subtitle').innerText = `${info.name || '詳細なし'}`;
    document.getElementById('detail-code').innerText = info.code || '-';
    document.getElementById('detail-name').innerText = info.name || '-';
    document.getElementById('detail-teacher').innerText = info.teacher || '-';
    document.getElementById('detail-time').innerText = `${getDayLabel(Number(info.day))} ${info.period}限`;
    document.getElementById('detail-attendance').innerText = '読み込み中...';
    const detailsPanel = document.getElementById('detail-attendance-details');
    if (detailsPanel) detailsPanel.innerHTML = '';
    panel.classList.remove('hidden');
    panel.classList.add('active');
    document.body.classList.add('modal-open');
    renderAttendanceDetails(info, attendanceRows);
};

export const closeDetailPanel = () => {
    window.selectedClassInfo = null;
    const panel = document.getElementById('detail-panel');
    if (!panel) return;
    panel.classList.remove('active');
    panel.classList.add('hidden');
    document.body.classList.remove('modal-open');
};

export const setupDetailPanelEvents = () => {
    const scheduleList = document.getElementById('schedule-list');
    if (scheduleList) {
        scheduleList.addEventListener('click', (event) => {
            const target = event.target.closest('.clickable-slot');
            if (!target) return;
            const info = {
                code: target.dataset.code,
                name: target.dataset.name,
                teacher: target.dataset.teacher,
                day: target.dataset.day,
                period: target.dataset.period
            };
            if (typeof window.handleScheduleClick === 'function') {
                window.handleScheduleClick(info);
            } else {
                openDetailPanel(info, window.currentAttendanceRows || []);
            }
        });
    }

    const detailPanel = document.getElementById('detail-panel');
    if (detailPanel) {
        detailPanel.addEventListener('click', (event) => {
            if (event.target === detailPanel) {
                closeDetailPanel();
            }
        });
    }

    const detailCloseBtn = document.getElementById('detail-close');
    if (detailCloseBtn) detailCloseBtn.addEventListener('click', closeDetailPanel);
};

export const setMessageAndCache = (message, cache, isError = false) => {
    setStatus(message, isError);
    setCacheInfo(cache, '最新');
};

export const getCurrentSchedulePosition = () => {
    const now = new Date();
    const time = now.getHours() * 60 + now.getMinutes();
    let p = 6;
    if (time < 630) p = 1;
    else if (time < 730) p = 2;
    else if (time < 870) p = 3;
    else if (time < 970) p = 4;
    else if (time < 1070) p = 5;
    return { weekday: now.getDay() - 1, currentPeriod: p };
};
