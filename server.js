const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const {
    CacheIntegrityError,
    InvalidCredentialsError,
    SERVER_SECRET_ENV,
    createDualKeyCacheStore
} = require('./logic/dual-key-cache-store');

const fetchCampusFile = require('./logic/campus');
const parseSchedule = require('./logic/campuss');
const fetchMoodle = require('./logic/moodle');
const fetchAssignments = require('./logic/assignments');
const fetchAttendance = require('./logic/attendance');

const app = express();
const PORT = 4007;
const HOST = '0.0.0.0';
const MAX_CONCURRENT_BROWSERS = 3;
const MAX_QUEUED_BROWSER_JOBS = 12;
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 1000;
const MAX_SESSIONS_PER_USER = 5;
const MAX_RATE_LIMIT_BUCKETS = 10000;
const BROWSER_QUEUE_TIMEOUT_MS = 2 * 60 * 1000;
const BROWSER_JOB_TIMEOUT_MS = 3 * 60 * 1000;
const DISABLE_BACKGROUND_REFRESH = process.env.SIT_DISABLE_BACKGROUND_REFRESH === '1';
const PUBLIC_ORIGIN = (() => {
    const configured = String(
        process.env.SIT_PUBLIC_ORIGIN || 'https://sit.racal.f5.si'
    ).trim();
    const url = new URL(configured);
    if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
    ) {
        throw new Error('SIT_PUBLIC_ORIGIN must be an HTTPS origin without a path');
    }
    return url.origin;
})();
const PUBLIC_HOST = new URL(PUBLIC_ORIGIN).host.toLowerCase();
const CACHE_ROOT = path.join(__dirname, 'cache');
const SERVER_SECRET_STDIN_ENV = 'SIT_SERVER_SECRET_STDIN';
let serverSecret = process.env[SERVER_SECRET_ENV];
if (!serverSecret && process.env[SERVER_SECRET_STDIN_ENV] === '1') {
    serverSecret = fs.readFileSync(0, 'utf8').trim();
}
const cacheStore = createDualKeyCacheStore({
    cacheRoot: CACHE_ROOT,
    adminPublicConfigPath: path.join(__dirname, 'config', 'admin-public-key.bin'),
    serverSecret
});
serverSecret = undefined;
delete process.env[SERVER_SECRET_ENV];
delete process.env[SERVER_SECRET_STDIN_ENV];

const userCache = new Map();
const sessions = new Map();
const browserQueue = [];
let activeBrowsers = 0;

class ServiceBusyError extends Error {}

const firstForwardedValue = (value) => (
    String(value || '').split(',')[0].trim().toLowerCase()
);

const requestHosts = (req) => {
    const hosts = new Set();
    const directHost = firstForwardedValue(req.get('host'));
    const forwardedHost = firstForwardedValue(req.get('x-forwarded-host'));
    if (directHost) hosts.add(directHost);
    if (forwardedHost) hosts.add(forwardedHost);
    return hosts;
};

const isHttpsRequest = (req) => {
    if (req.secure) return true;
    if (firstForwardedValue(req.get('x-forwarded-proto')) === 'https') return true;
    if (String(req.get('origin') || '').toLowerCase() === PUBLIC_ORIGIN.toLowerCase()) {
        return true;
    }
    return requestHosts(req).has(PUBLIC_HOST);
};

app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.use((req, res, next) => {
    res.set({
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Origin-Agent-Cluster': '?1',
        'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
        'Pragma': 'no-cache',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
        'X-DNS-Prefetch-Control': 'off',
        'X-Download-Options': 'noopen',
        'X-Frame-Options': 'DENY',
        'X-Permitted-Cross-Domain-Policies': 'none'
    });
    if (isHttpsRequest(req)) {
        res.setHeader(
            'Strict-Transport-Security',
            'max-age=31536000; includeSubDomains'
        );
    }
    next();
});
app.use('/api', (req, res, next) => {
    const origin = String(req.get('origin') || '').toLowerCase();
    const allowedOrigins = new Set([PUBLIC_ORIGIN.toLowerCase()]);
    for (const host of requestHosts(req)) {
        allowedOrigins.add(`http://${host}`);
        allowedOrigins.add(`https://${host}`);
    }
    const fetchSite = String(req.get('sec-fetch-site') || '').toLowerCase();
    if ((origin && !allowedOrigins.has(origin)) || fetchSite === 'cross-site') {
        return res.status(403).json({ error: '許可されていないアクセスです' });
    }
    const requestedWith = String(req.get('x-requested-with') || '').toLowerCase();
    if (req.method !== 'GET' && requestedWith !== 'xmlhttprequest') {
        return res.status(403).json({ error: '許可されていないアクセスです' });
    }
    if (!['GET', 'HEAD'].includes(req.method) && !req.is('application/json')) {
        return res.status(415).json({ error: 'JSON形式のリクエストが必要です' });
    }
    next();
});
const normalizeId = (id) => String(id || '').trim().toUpperCase();
const isValidId = (id) => /^[A-Z0-9_-]{1,64}$/.test(id);
const isValidPassword = (password) => typeof password === 'string' && password.length >= 1 && password.length <= 256;
const hashPassword = (password) => crypto.createHash('sha256').update(password).digest('hex');
const passwordHashesEqual = (left, right) => {
    const leftBytes = Buffer.from(String(left || ''), 'hex');
    const rightBytes = Buffer.from(String(right || ''), 'hex');
    return leftBytes.length === 32 &&
        rightBytes.length === 32 &&
        crypto.timingSafeEqual(leftBytes, rightBytes);
};

const normalizeClassInfo = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const result = {};
    for (const key of ['code', 'name', 'teacher']) {
        if (value[key] !== undefined) {
            if (typeof value[key] !== 'string' || value[key].length > 256) return null;
            result[key] = value[key];
        }
    }
    for (const key of ['day', 'period']) {
        if (value[key] !== undefined) {
            const number = Number(value[key]);
            if (!Number.isInteger(number) || number < 1 || number > 7) return null;
            result[key] = number;
        }
    }
    return result;
};

const parseCookies = (header) => {
    const result = {};
    for (const item of String(header || '').split(';')) {
        const separator = item.indexOf('=');
        if (separator < 1) continue;
        const key = item.slice(0, separator).trim();
        const value = item.slice(separator + 1).trim();
        try {
            result[key] = decodeURIComponent(value);
        } catch {
            result[key] = '';
        }
    }
    return result;
};

const setSessionCookie = (req, res, token) => {
    res.setHeader(
        'Set-Cookie',
        `sit_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; Priority=High${isHttpsRequest(req) ? '; Secure' : ''}`
    );
};

const clearSessionCookie = (req, res) => {
    res.setHeader(
        'Set-Cookie',
        `sit_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Priority=High${isHttpsRequest(req) ? '; Secure' : ''}`
    );
};

const hasSessionForUser = (id) => {
    for (const session of sessions.values()) {
        if (session.id === id && session.expiresAt > Date.now()) return true;
    }
    return false;
};

const releaseUserIfUnused = (id) => {
    if (hasSessionForUser(id)) return;
    const entry = userCache.get(id);
    if (!entry || entry.refreshing) return;
    entry.password = '';
    userCache.delete(id);
};

const destroySession = (token) => {
    const session = sessions.get(token);
    if (!session) return false;
    sessions.delete(token);
    releaseUserIfUnused(session.id);
    return true;
};

const enforceSessionLimits = (id) => {
    const userSessions = [];
    for (const [token, session] of sessions) {
        if (session.id === id) userSessions.push([token, session]);
    }
    userSessions.sort((left, right) => left[1].createdAt - right[1].createdAt);
    while (userSessions.length > MAX_SESSIONS_PER_USER) {
        const [token] = userSessions.shift();
        destroySession(token);
    }
    while (sessions.size > MAX_SESSIONS) {
        const oldestToken = sessions.keys().next().value;
        if (!oldestToken) break;
        destroySession(oldestToken);
    }
};

const createSession = (req, res, id) => {
    const oldToken = parseCookies(req.headers.cookie).sit_session;
    if (oldToken) sessions.delete(oldToken);
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(token, {
        id,
        createdAt: Date.now(),
        expiresAt: Date.now() + SESSION_TTL_MS
    });
    enforceSessionLimits(id);
    setSessionCookie(req, res, token);
};

const requireSession = (req, res, next) => {
    const token = parseCookies(req.headers.cookie).sit_session;
    const session = token ? sessions.get(token) : null;
    const entry = session ? userCache.get(session.id) : null;
    if (!session || session.expiresAt <= Date.now() || !entry) {
        if (token) destroySession(token);
        clearSessionCookie(req, res);
        return res.status(401).json({ error: 'ログインが必要です' });
    }
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    req.sessionToken = token;
    req.auth = { id: session.id, password: entry.password };
    next();
};

const createRateLimiter = (
    windowMs,
    maximum,
    prefix,
    keySelector = (req) => req.ip
) => {
    const buckets = new Map();
    let requestCount = 0;
    return (req, res, next) => {
        const now = Date.now();
        requestCount += 1;
        if (requestCount % 256 === 0) {
            for (const [bucketKey, bucketValue] of buckets) {
                if (bucketValue.resetAt <= now) buckets.delete(bucketKey);
            }
        }
        const key = `${prefix}:${keySelector(req)}`;
        const bucket = buckets.get(key);
        if (!bucket || bucket.resetAt <= now) {
            if (buckets.size >= MAX_RATE_LIMIT_BUCKETS) {
                return res.status(429).json({ error: '試行回数が多すぎます。しばらく待ってください' });
            }
            buckets.set(key, { count: 1, resetAt: now + windowMs });
            return next();
        }
        bucket.count += 1;
        if (bucket.count > maximum) {
            res.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
            return res.status(429).json({ error: '試行回数が多すぎます。しばらく待ってください' });
        }
        next();
    };
};

const apiLimiter = createRateLimiter(60 * 1000, 120, 'api');
const loginLimiter = createRateLimiter(
    5 * 60 * 1000,
    10,
    'login',
    (req) => `${req.ip}:${normalizeId(req.body && req.body.id)}`
);
app.use('/api', apiLimiter);
app.use('/api', express.json({
    inflate: false,
    limit: '32kb',
    strict: true,
    type: 'application/json'
}));

app.use(express.static(path.join(__dirname, 'public'), {
    dotfiles: 'deny',
    etag: false,
    extensions: false,
    fallthrough: true,
    index: 'index.html',
    lastModified: false,
    maxAge: 0,
    redirect: false
}));

const acquireBrowserSlot = () => {
    if (activeBrowsers < MAX_CONCURRENT_BROWSERS) {
        activeBrowsers += 1;
        return Promise.resolve();
    }
    if (browserQueue.length >= MAX_QUEUED_BROWSER_JOBS) {
        return Promise.reject(new ServiceBusyError());
    }
    return new Promise((resolve, reject) => {
        const queued = { resolve, reject, timer: null };
        queued.timer = setTimeout(() => {
            const index = browserQueue.indexOf(queued);
            if (index >= 0) browserQueue.splice(index, 1);
            reject(new ServiceBusyError());
        }, BROWSER_QUEUE_TIMEOUT_MS);
        queued.timer.unref();
        browserQueue.push(queued);
    });
};

const releaseBrowserSlot = () => {
    const next = browserQueue.shift();
    if (next) {
        clearTimeout(next.timer);
        next.resolve();
        return;
    }
    activeBrowsers = Math.max(0, activeBrowsers - 1);
};

const withBrowser = async (task) => {
    await acquireBrowserSlot();
    let browser;
    let timeout;
    try {
        browser = await puppeteer.launch({
            headless: true
        });
        return await Promise.race([
            task(browser),
            new Promise((resolve, reject) => {
                timeout = setTimeout(
                    () => reject(new ServiceBusyError()),
                    BROWSER_JOB_TIMEOUT_MS
                );
                timeout.unref();
            })
        ]);
    } finally {
        if (timeout) clearTimeout(timeout);
        if (browser) {
            try {
                await browser.close();
            } catch (error) {
                console.error('[Browser Close Error]:', error.message || error);
            }
        }
        releaseBrowserSlot();
    }
};

const loadCacheFromFile = async (id, password) => cacheStore.loadWithUserCredentials(id, password);
const saveCacheToFile = async (id, entry) => cacheStore.saveWithUserCredentials(id, entry.password, entry);

const loadCacheEntry = async (id, password) => {
    const suppliedHash = hashPassword(password);
    const inMemory = userCache.get(id);
    if (inMemory) {
        if (!passwordHashesEqual(inMemory.pwHash, suppliedHash)) {
            throw new InvalidCredentialsError();
        }
        return inMemory;
    }
    const stored = await loadCacheFromFile(id, password);
    if (!stored) return null;
    const entry = {
        ...stored,
        password,
        attendance: Array.isArray(stored.attendance) ? stored.attendance : [],
        refreshing: false,
        refreshPromise: null
    };
    userCache.set(id, entry);
    return entry;
};

const loadNewData = async (id, password) => {
    const operations = [
        withBrowser(async (browser) => parseSchedule(await fetchCampusFile(browser, id, password))),
        withBrowser((browser) => fetchMoodle(browser, id, password)),
        withBrowser((browser) => fetchAssignments(browser, id, password)),
        withBrowser((browser) => fetchAttendance(browser, id, password))
    ];
    const [campusResult, moodleResult, assignmentResult, attendanceResult] = await Promise.allSettled(operations);
    const result = {
        campusData: [],
        courses: [],
        tasks: [],
        attendance: [],
        campusError: null,
        moodleError: null,
        assignmentError: null,
        attendanceError: null
    };
    if (campusResult.status === 'fulfilled') result.campusData = campusResult.value;
    else result.campusError = campusResult.reason;
    if (moodleResult.status === 'fulfilled') result.courses = moodleResult.value;
    else result.moodleError = moodleResult.reason;
    if (assignmentResult.status === 'fulfilled') result.tasks = assignmentResult.value;
    else result.assignmentError = assignmentResult.reason;
    if (attendanceResult.status === 'fulfilled') result.attendance = attendanceResult.value.attendance || [];
    else result.attendanceError = attendanceResult.reason;
    for (const [name, error] of [
        ['Campus', result.campusError],
        ['Moodle', result.moodleError],
        ['Assignments', result.assignmentError],
        ['Attendance', result.attendanceError]
    ]) {
        if (error) console.error(`[Load ${name} Error]:`, error.message || error);
    }
    return result;
};

const safeMoodleUrl = (value) => {
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

const publicData = (entry) => ({
    campus: entry.campus,
    schedule: entry.campus,
    courses: Array.isArray(entry.courses)
        ? entry.courses.map((course) => (
            typeof course === 'string'
                ? course
                : { ...course, url: safeMoodleUrl(course && course.url) }
        ))
        : [],
    tasks: Array.isArray(entry.tasks)
        ? entry.tasks.map((group) => ({
            ...group,
            tasks: Array.isArray(group && group.tasks)
                ? group.tasks.map((task) => ({
                    ...task,
                    url: safeMoodleUrl(task && task.url)
                }))
                : []
        }))
        : [],
    attendance: entry.attendance || []
});

const updateCacheWithPartialResult = async (id, entry, result) => {
    let updated = false;
    if (!result.campusError) {
        entry.campus = result.campusData;
        updated = true;
    }
    if (!result.moodleError) {
        entry.courses = result.courses;
        updated = true;
    }
    if (!result.assignmentError) {
        entry.tasks = result.tasks;
        updated = true;
    }
    if (!result.attendanceError) {
        entry.attendance = result.attendance;
        updated = true;
    }
    entry.lastErrors = {
        campus: result.campusError ? '取得に失敗しました' : null,
        moodle: result.moodleError ? '取得に失敗しました' : null,
        assignments: result.assignmentError ? '取得に失敗しました' : null,
        attendance: result.attendanceError ? '取得に失敗しました' : null
    };
    if (updated) {
        entry.cachedAt = new Date().toISOString();
        await saveCacheToFile(id, entry);
    }
    return updated;
};

const refreshCache = async (id, password) => {
    const entry = userCache.get(id);
    if (!entry) throw new Error('キャッシュエントリが存在しません');
    if (entry.refreshing) {
        return { alreadyRefreshing: true, cachedAt: entry.cachedAt };
    }
    entry.refreshing = true;
    entry.refreshPromise = (async () => {
        try {
            const result = await loadNewData(id, password);
            const updated = await updateCacheWithPartialResult(id, entry, result);
            return {
                alreadyRefreshing: false,
                updated,
                cachedAt: entry.cachedAt,
                errors: entry.lastErrors,
                data: publicData(entry)
            };
        } finally {
            entry.refreshing = false;
            entry.refreshPromise = null;
            releaseUserIfUnused(id);
        }
    })();
    return entry.refreshPromise;
};

app.post('/api/login', loginLimiter, async (req, res, next) => {
    const id = normalizeId(req.body && req.body.id);
    const password = req.body && req.body.pw;
    if (!isValidId(id) || !isValidPassword(password)) {
        return res.status(400).json({ error: '学籍番号またはパスワードの形式が正しくありません' });
    }
    try {
        const cachedEntry = await loadCacheEntry(id, password);
        if (cachedEntry) {
            createSession(req, res, id);
            const updating = !DISABLE_BACKGROUND_REFRESH;
            res.json({
                authenticated: true,
                cached: true,
                data: publicData(cachedEntry),
                cachedAt: cachedEntry.cachedAt,
                updating
            });
            if (updating) {
                refreshCache(id, password).catch((error) => {
                    console.error('[Background Refresh Error]:', error.message || error);
                });
            }
            return;
        }

        const result = await loadNewData(id, password);
        if (result.campusError) {
            return res.status(401).json({ error: 'IDまたはパスワードが正しくありません' });
        }
        const entry = {
            pwHash: hashPassword(password),
            password,
            campus: result.campusData,
            courses: result.courses,
            tasks: result.tasks,
            attendance: result.attendance || [],
            cachedAt: new Date().toISOString(),
            refreshing: false,
            refreshPromise: null,
            lastErrors: {
                campus: null,
                moodle: result.moodleError ? '取得に失敗しました' : null,
                assignments: result.assignmentError ? '取得に失敗しました' : null,
                attendance: result.attendanceError ? '取得に失敗しました' : null
            },
            attendanceDebug: null
        };
        userCache.set(id, entry);
        await saveCacheToFile(id, entry);
        createSession(req, res, id);
        res.json({
            authenticated: true,
            cached: false,
            data: publicData(entry),
            cachedAt: entry.cachedAt,
            errors: entry.lastErrors,
            updating: false
        });
    } catch (error) {
        if (error instanceof InvalidCredentialsError) {
            return res.status(401).json({ error: 'IDまたはパスワードが正しくありません' });
        }
        if (error instanceof CacheIntegrityError) {
            console.error('[Encrypted DB Integrity Error]:', error.message || error);
            return res.status(500).json({ error: '暗号化DBが破損しているため読み込めません' });
        }
        next(error);
    }
});

app.post('/api/refresh', requireSession, async (req, res, next) => {
    const { id, password } = req.auth;
    const clientCachedAt = typeof req.body.cachedAt === 'string' &&
        req.body.cachedAt.length <= 64
        ? req.body.cachedAt
        : '';
    const wait = req.body.wait === true;
    const force = req.body.force === true;
    try {
        const entry = await loadCacheEntry(id, password);
        if (!entry) return res.status(404).json({ error: 'キャッシュが存在しません。再ログインしてください' });
        if (clientCachedAt && clientCachedAt !== entry.cachedAt && !entry.refreshing && !force) {
            return res.json({
                authenticated: true,
                cached: true,
                alreadyRefreshing: false,
                data: publicData(entry),
                cachedAt: entry.cachedAt,
                message: '最新のキャッシュデータがあります'
            });
        }
        if (entry.refreshPromise && wait) {
            const result = await entry.refreshPromise;
            return res.json({
                authenticated: true,
                cached: false,
                alreadyRefreshing: false,
                ...result
            });
        }
        const result = await refreshCache(id, password);
        if (result.alreadyRefreshing) {
            return res.json({
                authenticated: true,
                cached: true,
                alreadyRefreshing: true,
                data: publicData(entry),
                cachedAt: entry.cachedAt,
                message: '現在バックグラウンド更新中です'
            });
        }
        res.json({
            authenticated: true,
            cached: false,
            alreadyRefreshing: false,
            ...result
        });
    } catch (error) {
        next(error);
    }
});

app.post('/api/attendance', requireSession, async (req, res, next) => {
    const classInfo = normalizeClassInfo(req.body.classInfo);
    if (!classInfo) return res.status(400).json({ error: '授業情報の形式が正しくありません' });
    const { id, password } = req.auth;
    try {
        const entry = await loadCacheEntry(id, password);
        const attendance = await withBrowser((browser) => fetchAttendance(browser, id, password, classInfo));
        if (entry) {
            entry.attendanceDebug = {
                lastFetchedAt: new Date().toISOString(),
                classInfo,
                summary: attendance.summary || null
            };
            await saveCacheToFile(id, entry);
        }
        res.json({ attendance });
    } catch (error) {
        next(error);
    }
});

app.post('/api/logout', requireSession, (req, res) => {
    destroySession(req.sessionToken);
    clearSessionCookie(req, res);
    res.json({ loggedOut: true });
});

app.use('/api', (req, res) => {
    res.status(404).json({ error: 'APIが見つかりません' });
});

app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error && error.type === 'entity.too.large') {
        return res.status(413).json({ error: 'リクエストが大きすぎます' });
    }
    if (error && error.type === 'encoding.unsupported') {
        return res.status(415).json({ error: '圧縮されたリクエストには対応していません' });
    }
    if (error instanceof SyntaxError && error.status === 400) {
        return res.status(400).json({ error: 'JSONの形式が正しくありません' });
    }
    if (error instanceof ServiceBusyError) {
        return res.status(503).json({ error: '処理が混み合っています。しばらく待ってください' });
    }
    console.error('[Server Error]:', error.message || error);
    res.status(500).json({ error: 'サーバー処理に失敗しました' });
});

const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [token, session] of sessions) {
        if (session.expiresAt <= now) destroySession(token);
    }
}, 60 * 1000);
cleanupTimer.unref();

const start = async () => {
    const issues = await cacheStore.ready();
    if (Array.isArray(issues)) {
        for (const issue of issues) console.error('[Cache Recovery]:', issue);
    }
    const httpServer = app.listen(PORT, HOST, () => {
        console.log(`SIT Dash listening on ${HOST}:${PORT}`);
        console.log(`Public origin: ${PUBLIC_ORIGIN}`);
        console.log(`最大同時ブラウザ数: ${MAX_CONCURRENT_BROWSERS}`);
    });
    httpServer.headersTimeout = 15 * 1000;
    httpServer.requestTimeout = 2 * 60 * 1000;
    httpServer.keepAliveTimeout = 5 * 1000;
    httpServer.maxHeadersCount = 64;
    httpServer.maxRequestsPerSocket = 100;
};

start().catch((error) => {
    console.error('[Startup Error]:', error.message || error);
    process.exitCode = 1;
});
