'use strict';

const crypto = require('crypto');
const { InvalidCredentialsError } = require('./dual-key-cache-store');
const fetchCampusFile = require('./campus');
const parseSchedule = require('./campuss');
const fetchMoodle = require('./moodle');
const fetchAssignments = require('./assignments');
const fetchAttendance = require('./attendance');
const fetchGradesFile = require('./grades');
const parseGrades = require('./grades-parser');

const hashPassword = (password) => crypto.createHash('sha256').update(password).digest('hex');

const passwordHashesEqual = (left, right) => {
    const leftBytes = Buffer.from(String(left || ''), 'hex');
    const rightBytes = Buffer.from(String(right || ''), 'hex');
    return leftBytes.length === 32 &&
        rightBytes.length === 32 &&
        crypto.timingSafeEqual(leftBytes, rightBytes);
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
    cachedVersion: String(entry.cachedVersion || ''),
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
    attendance: entry.attendance || [],
    grades: entry.grades && Array.isArray(entry.grades.records)
        ? entry.grades
        : { scope: '', records: [] }
});

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

const createDashboardService = ({ appVersion, cacheStore, withBrowser, userCache, releaseUserIfUnused }) => {
    if (typeof appVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(appVersion)) {
        throw new TypeError('appVersion is required');
    }
    if (!cacheStore || typeof cacheStore.loadWithUserCredentials !== 'function') {
        throw new TypeError('cacheStore is required');
    }
    if (typeof withBrowser !== 'function' || !(userCache instanceof Map) || typeof releaseUserIfUnused !== 'function') {
        throw new TypeError('dashboard service dependencies are invalid');
    }

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
            grades: stored.grades && Array.isArray(stored.grades.records)
                ? stored.grades
                : { scope: '', records: [] },
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
            withBrowser((browser) => fetchAttendance(browser, id, password)),
            withBrowser(async (browser) => parseGrades(await fetchGradesFile(browser, id, password)))
        ];
        const [campusResult, moodleResult, assignmentResult, attendanceResult, gradesResult] = await Promise.allSettled(operations);
        const result = {
            campusData: [],
            courses: [],
            tasks: [],
            attendance: [],
            gradesData: { scope: '', records: [] },
            campusError: null,
            moodleError: null,
            assignmentError: null,
            attendanceError: null,
            gradesError: null
        };
        if (campusResult.status === 'fulfilled') result.campusData = campusResult.value;
        else result.campusError = campusResult.reason;
        if (moodleResult.status === 'fulfilled') result.courses = moodleResult.value;
        else result.moodleError = moodleResult.reason;
        if (assignmentResult.status === 'fulfilled') result.tasks = assignmentResult.value;
        else result.assignmentError = assignmentResult.reason;
        if (attendanceResult.status === 'fulfilled') result.attendance = attendanceResult.value.attendance || [];
        else result.attendanceError = attendanceResult.reason;
        if (gradesResult.status === 'fulfilled') result.gradesData = gradesResult.value;
        else result.gradesError = gradesResult.reason;
        for (const [name, error] of [
            ['Campus', result.campusError],
            ['Moodle', result.moodleError],
            ['Assignments', result.assignmentError],
            ['Attendance', result.attendanceError],
            ['Grades', result.gradesError]
        ]) {
            if (error) console.error(`[Load ${name} Error]:`, error.message || error);
        }
        return result;
    };

    const fetchAttendanceForClass = async (id, password, classInfo) => (
        withBrowser((browser) => fetchAttendance(browser, id, password, classInfo))
    );

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
        if (!result.gradesError) {
            entry.grades = result.gradesData;
            updated = true;
        }
        entry.lastErrors = {
            campus: result.campusError ? '取得に失敗しました' : null,
            moodle: result.moodleError ? '取得に失敗しました' : null,
            assignments: result.assignmentError ? '取得に失敗しました' : null,
            attendance: result.attendanceError ? '取得に失敗しました' : null,
            grades: result.gradesError ? '取得に失敗しました' : null
        };
        if (updated) {
            entry.cachedAt = new Date().toISOString();
            entry.cachedVersion = appVersion;
            await saveCacheToFile(id, entry);
        }
        return updated;
    };

    const refreshCache = async (id, password) => {
        const entry = userCache.get(id);
        if (!entry) throw new Error('キャッシュエントリが存在しません');
        if (entry.refreshing) {
            return {
                alreadyRefreshing: true,
                cachedAt: entry.cachedAt,
                cachedVersion: entry.cachedVersion
            };
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
                    cachedVersion: entry.cachedVersion,
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

    return {
        fetchAttendanceForClass,
        loadCacheEntry,
        loadNewData,
        publicData,
        refreshCache,
        saveCacheToFile,
        updateCacheWithPartialResult
    };
};

module.exports = {
    createDashboardService,
    hashPassword,
    normalizeClassInfo,
    publicData,
    safeMoodleUrl
};
