const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const currentUser = {
    id: '',
    cachedAt: '',
    attendance: []
};

const fetchJson = async (url, body) => {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        credentials: 'same-origin',
        body: JSON.stringify(body)
    });

    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    let data;

    if (contentType.includes('application/json')) {
        try {
            data = await res.json();
        } catch {
            throw new Error('サーバーの応答を解析できませんでした');
        }
    } else {
        throw new Error(`サーバーから予期しない応答が返されました（HTTP ${res.status}）`);
    }

    if (!res.ok) {
        throw new Error(data.error || data.details || '通信に失敗しました');
    }

    return data;
};

export const login = async (id, pw) => {
    const body = await fetchJson('./api/login', { id, pw });
    currentUser.id = id;
    currentUser.cachedAt = body.cachedAt || '';
    currentUser.attendance = Array.isArray(body.data?.attendance) ? body.data.attendance : [];
    return body;
};

export const refreshData = async ({ force = false, wait = false } = {}) => {
    if (!currentUser.id) {
        throw new Error('ログイン情報が不足しています');
    }
    const body = await fetchJson('./api/refresh', {
        cachedAt: currentUser.cachedAt,
        force,
        wait
    });
    currentUser.cachedAt = body.cachedAt || currentUser.cachedAt;
    currentUser.attendance = Array.isArray(body.data?.attendance) ? body.data.attendance : currentUser.attendance;
    return body;
};

export const pollRefreshUntilUpdated = async (attempt = 0) => {
    if (attempt > 12) {
        throw new Error('バックグラウンド更新が完了しませんでした。');
    }

    const body = await refreshData({ wait: true });
    if (body.alreadyRefreshing) {
        await sleep(5000);
        return pollRefreshUntilUpdated(attempt + 1);
    }
    return body;
};

export const fetchAttendanceForClass = async (classInfo) => {
    if (!currentUser.id) {
        throw new Error('ログインが必要です');
    }

    const body = await fetchJson('./api/attendance', { classInfo });

    if (body.attendance && Array.isArray(body.attendance.attendance)) {
        currentUser.attendance = body.attendance.attendance;
    }
    return body.attendance || null;
};

const normalizeText = (text) => {
    return String(text || '')
        .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
        .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
        .replace(/[（）［］【】｝｛「」]/g, ' ')
        .replace(/[・·･／\/]/g, ' ')
        .replace(/[()\[\]{}]/g, ' ')
        .replace(/[\t\r\n\f\v]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
};

export const simplifyAttendanceStatus = (text) => {
    const value = String(text || '').trim();
    if (value.includes('出席に他')) return '〇';
    if (/(?:欠席|欠)/u.test(value)) return '欠';
    if (/(?:出席|〇|○)/u.test(value)) return '〇';
    if (/(?:遅刻|遅)/u.test(value)) return '遅';
    if (/(?:早退|早)/u.test(value)) return '早';
    if (/(?:他|その他)/u.test(value)) return '他';
    return value;
};

export const parseAttendanceCell = (rawValue) => {
    const text = String(rawValue || '').replace(/\r/g, '\n').trim();
    const dateMatch = text.match(/([0-3]?\d)[\/\-]([0-1]?\d)(?:[\/\-](\d{2,4}))?/);
    const dateKey = dateMatch ? `${dateMatch[1].padStart(2, '0')}/${dateMatch[2].padStart(2, '0')}${dateMatch[3] ? `/${dateMatch[3]}` : ''}` : null;
    return {
        status: simplifyAttendanceStatus(text),
        dateKey
    };
};

const getValueByHeaders = (row, keys) => {
    const normalizedKeys = Object.keys(row).map((key) => [key, normalizeText(key)]);
    for (const targetKey of keys) {
        const normTarget = normalizeText(targetKey);
        const matched = normalizedKeys.find(([, normalizedKey]) => normalizedKey === normTarget || normalizedKey.includes(normTarget));
        if (matched) return normalizeText(row[matched[0]] || '');
    }
    return '';
};

const getRowText = (row) => Object.values(row)
    .map((value) => normalizeText(value || ''))
    .filter(Boolean)
    .join(' ');

const dayNames = {
    '1': '月',
    '2': '火',
    '3': '水',
    '4': '木',
    '5': '金',
    '6': '土',
    '7': '日'
};

export const getAttendanceRowForClass = (info, attendanceSections = currentUser.attendance) => {
    const sections = Array.isArray(attendanceSections) ? attendanceSections : [];
    if (!sections.length) return null;

    const targetCode = normalizeText(info.code || '');
    const targetName = normalizeText(info.name || '');
    const targetTeacher = normalizeText(info.teacher || '');
    const targetDay = normalizeText(String(info.day || ''));
    const targetPeriod = normalizeText(String(info.period || ''));
    const targetDayName = dayNames[targetDay] || '';
    const targetDayPeriod = targetDayName && targetPeriod ? `${targetDayName}${targetPeriod}` : '';

    let best = null;
    let bestScore = 0;

    for (const section of sections) {
        const rows = Array.isArray(section.rows) ? section.rows : [];
        for (const row of rows) {
            const code = getValueByHeaders(row, ['時間割コード', '授業コード', '科目コード', 'コースコード', 'コード', 'ｺｰｽｺｰﾄﾞ']);
            const name = getValueByHeaders(row, ['開講科目名', '科目名', '授業名', '教科名', '科目']);
            const teacher = getValueByHeaders(row, ['担当教員', '講師', '教員', '担当']);
            const rowText = getRowText(row);

            let score = 0;
            const codeMatches = targetCode && code && (code === targetCode || code.includes(targetCode) || targetCode.includes(code));
            const hasCodeField = Boolean(code);
            const hasTargetCode = Boolean(targetCode);
            const targetNameMatches = targetName && rowText.includes(targetName);
            const targetDayPeriodMatches = targetDayPeriod && rowText.includes(targetDayPeriod);

            if (hasTargetCode && hasCodeField && !codeMatches) {
                continue;
            }
            if (hasTargetCode && !hasCodeField && !(targetNameMatches && targetDayPeriodMatches)) {
                continue;
            }

            if (hasTargetCode && (rowText.includes(targetCode) || codeMatches)) score += 8;
            if (targetName && (targetNameMatches || (name && name.includes(targetName)))) score += 4;
            if (targetTeacher && (rowText.includes(targetTeacher) || (teacher && teacher.includes(targetTeacher)))) score += 2;
            if (targetDayPeriodMatches) score += 4;
            else if (targetDay && targetPeriod && rowText.includes(targetDay) && rowText.includes(targetPeriod)) score += 2;
            else if (targetDay && !targetPeriod && rowText.includes(targetDay)) score += 1;
            else if (targetPeriod && !targetDay && rowText.includes(targetPeriod)) score += 1;

            const nonEmptyValues = Object.values(row).filter((v) => String(v || '').trim()).length;
            if (nonEmptyValues < 3) score = Math.floor(score / 2);

            if (score > bestScore) {
                bestScore = score;
                best = row;
            }
        }
    }

    if (bestScore < 3) return null;
    return { row: best, score: bestScore };
};
