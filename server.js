const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');
const crypto = require('crypto');
const {
    CacheIntegrityError,
    InvalidCredentialsError,
    createDualKeyCacheStore
} = require('./logic/dual-key-cache-store');

const fetchCampusFile = require('./logic/campus');
const parseSchedule = require('./logic/campuss');
const fetchMoodle = require('./logic/moodle');
const fetchAssignments = require('./logic/assignments');
const fetchAttendance = require('./logic/attendance');

const app = express();
const PORT = 10000;

let activeBrowsers = 0;
const MAX_CONCURRENT_BROWSERS = 3;

const CACHE_ROOT = path.join(__dirname, 'cache');
const cacheStore = createDualKeyCacheStore({
    cacheRoot: CACHE_ROOT,
    adminPublicConfigPath: path.join(__dirname, 'config', 'admin-public-key.bin')
});

const userCache = {};

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    next();
});

const normalizeId = (id) => String(id || '').trim().toUpperCase();
const hashPassword = (pw) => crypto.createHash('sha256').update(String(pw)).digest('hex');

const escapeHtml = (text) => {
    return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
};

const loadCacheFromFile = async (normalizedId, pw) => {
    return cacheStore.loadWithUserCredentials(normalizedId, pw);
};

const saveCacheToFile = async (normalizedId, cacheEntry) => {
    return cacheStore.saveWithUserCredentials(normalizedId, cacheEntry.pw, cacheEntry);
};

const loadCacheEntry = async (normalizedId, pw) => {
    const suppliedHash = hashPassword(pw);
    let cacheEntry = userCache[normalizedId];
    if (cacheEntry) {
        if (cacheEntry.pwHash !== suppliedHash) {
            throw new InvalidCredentialsError();
        }
        return cacheEntry;
    }

    const fileCache = await loadCacheFromFile(normalizedId, pw);
    if (!fileCache) return null;
    cacheEntry = {
        ...fileCache,
        pw,
        attendance: Array.isArray(fileCache.attendance) ? fileCache.attendance : [],
        refreshing: false,
        refreshPromise: null
    };
    userCache[normalizedId] = cacheEntry;
    return cacheEntry;
};


const launchBrowser = async () => {
    activeBrowsers++;
    console.log(`🔄 [System] Launching browser (#${activeBrowsers})...`);
    const browser = await puppeteer.launch({ 
        headless: false, 
        args: ['--no-sandbox', '--disable-setuid-sandbox'] 
    });
    console.log('✅ [System] Browser window launched');
    return browser;
};


const closeBrowser = async (browser) => {
    try {
        if (browser) {
            await browser.close();
            console.log('✅ [System] Browser window closed');
        }
    } catch (e) {
        console.log('❌ [System] Browser close error:', e.message);
    } finally {
        activeBrowsers--;
    }
};

const loadNewData = async (id, pw) => {
    const [campusBrowser, moodleBrowser, assignmentsBrowser, attendanceBrowser] = await Promise.all([
        launchBrowser(),
        launchBrowser(),
        launchBrowser(),
        launchBrowser()
    ]);

    try {
        const campusPromise = fetchCampusFile(campusBrowser, id.toUpperCase(), pw).then(csvPath => parseSchedule(csvPath));
        const moodlePromise = fetchMoodle(moodleBrowser, id, pw);
        const assignmentPromise = fetchAssignments(assignmentsBrowser, id, pw);
        const attendancePromise = fetchAttendance(attendanceBrowser, id, pw);

        const [campusResult, moodleResult, assignmentResult, attendanceResult] = await Promise.allSettled([
            campusPromise,
            moodlePromise,
            assignmentPromise,
            attendancePromise
        ]);

        let campusData = [];
        let courses = [];
        let tasks = [];
        let attendance = [];
        let campusError = null;
        let moodleError = null;
        let assignmentError = null;
        let attendanceError = null;

        if (campusResult.status === 'fulfilled') {
            campusData = campusResult.value;
        } else {
            campusError = campusResult.reason;
            console.error('❌ [Load Campus Error]:', campusError.message || campusError);
        }

        if (moodleResult.status === 'fulfilled') {
            courses = moodleResult.value;
        } else {
            moodleError = moodleResult.reason;
            console.error('❌ [Load Moodle Error]:', moodleError.message || moodleError);
        }

        if (assignmentResult.status === 'fulfilled') {
            tasks = assignmentResult.value;
        } else {
            assignmentError = assignmentResult.reason;
            console.error('❌ [Load Assignments Error]:', assignmentError.message || assignmentError);
        }

        if (attendanceResult.status === 'fulfilled') {
            attendance = attendanceResult.value.attendance || [];
        } else {
            attendanceError = attendanceResult.reason;
            console.error('❌ [Load Attendance Error]:', attendanceError.message || attendanceError);
        }

        return { campusData, courses, tasks, attendance, campusError, moodleError, assignmentError, attendanceError };
    } finally {
        await closeBrowser(campusBrowser);
        await closeBrowser(moodleBrowser);
        await closeBrowser(assignmentsBrowser);
        await closeBrowser(attendanceBrowser);
    }
};

const updateCacheWithPartialResult = async (normalizedId, cacheEntry, result) => {
    let updated = false;

    if (result.campusError === null) {
        cacheEntry.campus = result.campusData;
        updated = true;
    }
    if (result.moodleError === null) {
        cacheEntry.courses = result.courses;
        updated = true;
    }
    if (result.assignmentError === null) {
        cacheEntry.tasks = result.tasks;
        updated = true;
    }
    if (result.attendanceError === null) {
        cacheEntry.attendance = result.attendance;
        updated = true;
    }

    cacheEntry.lastErrors = {
        campus: result.campusError ? String(result.campusError.message || result.campusError) : null,
        moodle: result.moodleError ? String(result.moodleError.message || result.moodleError) : null,
        assignments: result.assignmentError ? String(result.assignmentError.message || result.assignmentError) : null,
        attendance: result.attendanceError ? String(result.attendanceError.message || result.attendanceError) : null
    };

    if (updated) {
        cacheEntry.cachedAt = new Date().toISOString();
        await saveCacheToFile(normalizedId, cacheEntry);
    }
    return updated;
};

const refreshCache = async (key, id, pw) => {
    const cacheEntry = userCache[key];
    if (!cacheEntry) {
        throw new Error('キャッシュエントリが存在しません');
    }
    if (cacheEntry.refreshing) {
        return { alreadyRefreshing: true, cachedAt: cacheEntry.cachedAt };
    }

    cacheEntry.refreshing = true;
    cacheEntry.refreshPromise = (async () => {
        try {
            const result = await loadNewData(id, pw);
            const updated = await updateCacheWithPartialResult(key, cacheEntry, result);
            return {
                alreadyRefreshing: false,
                updated,
                cachedAt: cacheEntry.cachedAt,
                errors: cacheEntry.lastErrors,
                data: {
                    campus: cacheEntry.campus,
                    schedule: cacheEntry.campus,
                    courses: cacheEntry.courses,
                    tasks: cacheEntry.tasks,
                    attendance: cacheEntry.attendance || []
                }
            };
        } finally {
            cacheEntry.refreshing = false;
            cacheEntry.refreshPromise = null;
        }
    })();

    return cacheEntry.refreshPromise;
};

app.post('/api/login', async (req, res) => {
    const { id, pw } = req.body;
    if (!id || !pw) return res.status(400).json({ error: '学籍番号とパスワードが必要です' });

    const normalizedId = normalizeId(id);
    const pwHash = hashPassword(pw);
    let cachedEntry;
    try {
        cachedEntry = await loadCacheEntry(normalizedId, pw);
    } catch (error) {
        if (error instanceof InvalidCredentialsError) {
            return res.status(401).json({ error: 'IDまたはパスワードが正しくありません' });
        }
        console.error('[Encrypted DB Load Error]:', error.message || error);
        const message = error instanceof CacheIntegrityError
            ? '暗号化DBの整合性を確認できません'
            : '暗号化DBを読み込めません';
        return res.status(500).json({ error: message });
    }
    if (cachedEntry) {
        if (cachedEntry.pwHash !== pwHash) {
            return res.status(401).json({ error: 'IDまたはパスワードが正しくありません' });
        }
        const responseBody = {
            authenticated: true,
            cached: true,
            data: {
                campus: cachedEntry.campus,
                schedule: cachedEntry.campus,
                courses: cachedEntry.courses,
                tasks: cachedEntry.tasks,
                attendance: cachedEntry.attendance || []
            },
            cachedAt: cachedEntry.cachedAt,
            updating: true
        };

        res.json(responseBody);
        refreshCache(normalizedId, id, pw).catch((e) => {
            console.error('❌ [Background refresh failed]:', e.message || e);
        });
        return;
    }

    console.log('\n🚀 [Login] New ID login:', normalizedId);
    try {
        const result = await loadNewData(id, pw);
        if (result.campusError) {
            return res.status(401).json({ error: 'IDまたはパスワードが正しくありません' });
        }

        userCache[normalizedId] = {
            pwHash,
            pw,
            campus: result.campusData,
            courses: result.courses,
            tasks: result.tasks,
            attendance: result.attendance || [],
            cachedAt: new Date().toISOString(),
            refreshing: false,
            refreshPromise: null,
            lastErrors: {
                campus: null,
                moodle: result.moodleError ? String(result.moodleError.message || result.moodleError) : null,
                assignments: result.assignmentError ? String(result.assignmentError.message || result.assignmentError) : null,
                attendance: result.attendanceError ? String(result.attendanceError.message || result.attendanceError) : null
            },
            attendanceDebug: null
        };
        await saveCacheToFile(normalizedId, userCache[normalizedId]);
        res.json({
            authenticated: true,
            cached: false,
            data: {
                campus: result.campusData,
                schedule: result.campusData,
                courses: result.courses,
                tasks: result.tasks,
                attendance: userCache[normalizedId].attendance
            },
            cachedAt: userCache[normalizedId].cachedAt,
            errors: userCache[normalizedId].lastErrors
        });
    } catch (e) {
        console.error('❌ [Login Error]:', e.message || e);
        res.status(500).json({ error: '同期に失敗しました', details: String(e.message || e) });
    }
});

app.post('/api/refresh', async (req, res) => {
    const { id, pw, cachedAt: clientCachedAt, wait, force } = req.body;
    if (!id || !pw) return res.status(400).json({ error: '学籍番号とパスワードが必要です' });

    const normalizedId = normalizeId(id);
    const pwHash = hashPassword(pw);
    let cacheEntry;
    try {
        cacheEntry = await loadCacheEntry(normalizedId, pw);
    } catch (error) {
        if (error instanceof InvalidCredentialsError) {
            return res.status(401).json({ error: 'IDまたはパスワードが正しくありません' });
        }
        console.error('[Encrypted DB Load Error]:', error.message || error);
        return res.status(500).json({ error: '暗号化DBを読み込めません' });
    }
    if (!cacheEntry) {
        return res.status(404).json({ error: 'キャッシュが存在しません。再ログインしてください。' });
    }
    if (cacheEntry.pwHash !== pwHash) {
        return res.status(401).json({ error: 'IDまたはパスワードが正しくありません' });
    }

    if (clientCachedAt && clientCachedAt !== cacheEntry.cachedAt && !cacheEntry.refreshing && !force) {
        return res.json({
            authenticated: true,
            cached: true,
            alreadyRefreshing: false,
            data: {
                campus: cacheEntry.campus,
                schedule: cacheEntry.campus,
                courses: cacheEntry.courses,
                tasks: cacheEntry.tasks,
                attendance: cacheEntry.attendance || []
            },
            cachedAt: cacheEntry.cachedAt,
            message: '最新のキャッシュデータがあります。'
        });
    }

    try {
        if (cacheEntry.refreshPromise && wait) {
            const result = await cacheEntry.refreshPromise;
            return res.json({
                authenticated: true,
                cached: false,
                alreadyRefreshing: false,
                data: result.data,
                cachedAt: result.cachedAt,
                errors: result.errors,
                updated: result.updated
            });
        }

        const result = await refreshCache(normalizedId, id, pw);
        if (result.alreadyRefreshing) {
            return res.json({
                authenticated: true,
                cached: true,
                alreadyRefreshing: true,
                data: {
                    campus: cacheEntry.campus,
                    schedule: cacheEntry.campus,
                    courses: cacheEntry.courses,
                    tasks: cacheEntry.tasks,
                    attendance: cacheEntry.attendance || []
                },
                cachedAt: cacheEntry.cachedAt,
                message: '現在バックグラウンド更新中です。'
            });
        }

        res.json({
            authenticated: true,
            cached: false,
            alreadyRefreshing: false,
            data: result.data,
            cachedAt: result.cachedAt,
            errors: result.errors,
            updated: result.updated
        });
    } catch (e) {
        console.error('❌ [Refresh Error]:', e.message || e);
        res.status(500).json({ error: '更新に失敗しました', details: String(e.message || e) });
    }
});


app.post('/api/campus', async (req, res) => {
    const { id, pw } = req.body;
    const browser = await launchBrowser();
    try {
        const csvPath = await fetchCampusFile(browser, id.toUpperCase(), pw);
        const data = parseSchedule(csvPath);
        res.json({ schedule: data, campus: data });
    } catch (e) {
        res.status(500).json({ error: e.message });
    } finally {
        await closeBrowser(browser);
    }
});

app.post('/api/moodle', async (req, res) => {
    const { id, pw } = req.body;
    const browser = await launchBrowser();
    try {
        const courses = await fetchMoodle(browser, id, pw);
        res.json({ courses });
    } catch (e) {
        res.status(500).json({ error: e.message });
    } finally {
        await closeBrowser(browser);
    }
});

app.post('/api/assignments', async (req, res) => {
    const { id, pw } = req.body;
    const browser = await launchBrowser();
    try {
        const tasks = await fetchAssignments(browser, id, pw);
        res.json({ tasks });
    } catch (e) {
        res.status(500).json({ error: e.message });
    } finally {
        await closeBrowser(browser);
    }
});

app.post('/api/attendance', async (req, res) => {
    const { id, pw, classInfo } = req.body;
    if (!id || !pw) {
        return res.status(400).json({ error: '学籍番号とパスワードが必要です。' });
    }

    const normalizedId = normalizeId(id);
    let cacheEntry;
    try {
        cacheEntry = await loadCacheEntry(normalizedId, pw);
    } catch (error) {
        if (error instanceof InvalidCredentialsError) {
            return res.status(401).json({ error: 'IDまたはパスワードが正しくありません' });
        }
        console.error('[Encrypted DB Load Error]:', error.message || error);
        return res.status(500).json({ error: '暗号化DBを読み込めません' });
    }
    const browser = await launchBrowser();
    try {
        const attendance = await fetchAttendance(browser, id, pw, classInfo);
        if (cacheEntry) {
            cacheEntry.attendanceDebug = {
                lastResult: attendance,
                lastError: null,
                lastFetchedAt: new Date().toISOString(),
                classInfo,
                attendanceHtml: attendance.attendanceHtml || null
            };
            await saveCacheToFile(normalizedId, cacheEntry);
        }
        res.json({ attendance });
    } catch (e) {
        if (cacheEntry) {
            cacheEntry.attendanceDebug = {
                lastResult: null,
                lastError: String(e.message || e),
                lastFetchedAt: new Date().toISOString(),
                classInfo,
                attendanceHtml: null
            };
            await saveCacheToFile(normalizedId, cacheEntry);
        }
        console.error('❌ [Attendance Error]:', e.message || e);
        res.status(500).json({ error: '出席情報の取得に失敗しました', details: String(e.message || e) });
    } finally {
        await closeBrowser(browser);
    }
});

app.get('/atte', (req, res) => {
    const id = normalizeId(req.query.id || '');
    const entries = Object.entries(userCache).map(([key, entry]) => ({
        id: key,
        cachedAt: entry.cachedAt,
        lastErrors: entry.lastErrors,
        attendanceDebug: entry.attendanceDebug || null
    }));
    const filtered = id ? entries.filter((entry) => entry.id === id) : entries;

    const html = ['<html><head><meta charset="utf-8"><title>Attendance Debug</title></head><body style="background:#0f172a;color:#e2e8f0;font-family:Arial,sans-serif;padding:24px;">',
        '<h1>Attendance Debug</h1>',
        '<p>query parameter: <code>?id=学籍番号</code></p>',
        '<div style="margin-top:24px;">',
        filtered.map((entry) => {
            return `
                <section style="margin-bottom:28px;padding:18px;border:1px solid #334155;border-radius:16px;background:#111827;">
                    <h2 style="margin-top:0;color:#7dd3fc;">${entry.id}</h2>
                    <div><strong>cachedAt:</strong> ${entry.cachedAt || 'なし'}</div>
                    <div><strong>lastErrors:</strong> <pre style="white-space:pre-wrap;color:#f8fafc;">${escapeHtml(JSON.stringify(entry.lastErrors, null, 2))}</pre></div>
                    <div><strong>attendanceDebug:</strong> <pre style="white-space:pre-wrap;color:#f8fafc;">${escapeHtml(JSON.stringify(entry.attendanceDebug, null, 2))}</pre></div>
                    ${entry.attendanceDebug && entry.attendanceDebug.attendanceHtml ? `<div style="margin-top:16px;"><strong>attendanceHtml:</strong><div style="padding:16px;background:#020617;border-radius:12px;overflow:auto;">${entry.attendanceDebug.attendanceHtml}</div></div>` : ''}
                </section>
            `;
        }).join(''),
        '</div>',
        '</body></html>'
    ].join('');

    res.send(html);
});

const startServer = async () => {
    await cacheStore.ready();
    app.listen(PORT, () => {
    console.log('\n' + '='.repeat(50));
    console.log(`🚀 SIT Dash Running: http://localhost:${PORT}`);
    console.log(`📌 Max concurrent browsers: ${MAX_CONCURRENT_BROWSERS}`);
    console.log('='.repeat(50) + '\n');
    });
};

startServer().catch((error) => {
    console.error('[Startup Error]:', error.message || error);
    process.exitCode = 1;
});
