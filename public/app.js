import { currentUser, login, refreshData, pollRefreshUntilUpdated } from './data.js';
import { renderSchedule, renderCourses, renderAssignments, renderGrades, fillLoadingPlaceholders, setCacheInfo, setStatus, setupDetailPanelEvents, openDetailPanel } from './ui.js';
import { reportExtensionLoginResult, setupExtensionNotifications } from './notifications.js';

const cacheInfo = document.getElementById('cache-info');
const refreshBtn = document.getElementById('refresh-btn');
const syncBtn = document.getElementById('sync-btn');
const usernameInput = document.getElementById('username_input');
const passwordInput = document.getElementById('password_input');
let menuToggle = null;
let sideDrawer = null;
let drawerBackdrop = null;
let drawerClose = null;
let datetimeDisplay = null;

const setLoadingState = (isLoading) => {
    if (!refreshBtn) return;
    refreshBtn.disabled = isLoading;
    refreshBtn.textContent = isLoading ? '更新中...' : '更新';
};

const showLoginView = () => {
    document.getElementById('login-container').style.display = 'block';
    document.getElementById('main-container').style.display = 'none';
};

const showMainView = () => {
    document.getElementById('login-container').style.display = 'none';
    document.getElementById('main-container').style.display = 'block';
};

const renderPageData = (data, sourceLabel = '最新') => {
    if (!data) return;
    if (data.schedule) renderSchedule(data);
    if (data.courses) renderCourses(data.courses);
    if (data.tasks) renderAssignments('task-list', data.tasks);
    renderGrades(data.grades);
    if (data.attendance) {
        window.currentAttendanceRows = data.attendance;
        currentUser.attendance = Array.isArray(data.attendance) ? data.attendance : currentUser.attendance;
    }
    setStatus(`${sourceLabel}データを表示しています。`);
};

const handleScheduleClick = (info) => {
    const attendanceRows = window.currentAttendanceRows || [];
    if (!attendanceRows.length) {
        setStatus('出欠データがまだ読み込まれていません。再同期してください。', true);
    } else {
        setStatus('出欠情報を表示しています。');
    }
    openDetailPanel(info, attendanceRows);
};

const doLogin = async () => {
    const id = usernameInput?.value.trim();
    const pw = passwordInput?.value;
    if (!id || !pw) {
        return alert('IDとパスワードを入力してください');
    }

    showMainView();
    fillLoadingPlaceholders();
    setCacheInfo('', 'キャッシュ');
    setLoadingState(true);
    setStatus('キャッシュを読み込み中です...');

    try {
        const body = await login(id, pw);
        reportExtensionLoginResult(true);
        renderPageData(body.data, body.cached ? 'キャッシュ' : '最新');
        setCacheInfo(
            body.cachedAt,
            body.cached ? 'キャッシュ' : '最新',
            body.cachedVersion || body.data?.cachedVersion
        );

        if (passwordInput) passwordInput.value = '';
        if (body.cached && body.updating) {
            setStatus('キャッシュデータを表示しました。最新情報を取得中です...');
            const latest = await pollRefreshUntilUpdated();
            renderPageData(latest.data, '最新');
            setCacheInfo(
                latest.cachedAt,
                '最新',
                latest.cachedVersion || latest.data?.cachedVersion
            );
            setStatus('最新データに更新されました。');
        } else if (body.cached) {
            setStatus('キャッシュデータを表示しました。');
        } else {
            setStatus('最新データを取得しました。');
        }
    } catch (e) {
        reportExtensionLoginResult(false);
        console.error(e);
        alert(e.message || '同期に失敗しました');
        showLoginView();
        setStatus('同期に失敗しました', true);
    } finally {
        if (passwordInput) passwordInput.value = '';
        setLoadingState(false);
    }
};

const doRefresh = async ({ force = false } = {}) => {
    if (!currentUser.id) return;
    setLoadingState(true);
    setStatus(force ? '強制更新中です...' : '最新データを取得中です...');

    try {
        const body = await refreshData({ force });
        renderPageData(body.data, body.cached ? 'キャッシュ' : '最新');
        setCacheInfo(
            body.cachedAt,
            body.cached ? 'キャッシュ' : '最新',
            body.cachedVersion || body.data?.cachedVersion
        );
        if (body.updated) {
            setStatus('最新データに更新されました。');
        } else if (body.message) {
            setStatus(body.message);
        } else {
            setStatus('データを更新しました。');
        }
    } catch (e) {
        console.error(e);
        alert(e.message || '更新に失敗しました');
        setStatus('更新に失敗しました', true);
    } finally {
        setLoadingState(false);
    }
};

const openDrawer = () => {
    if (!sideDrawer || !drawerBackdrop || !menuToggle) return;
    sideDrawer.classList.remove('hidden');
    drawerBackdrop.classList.remove('hidden');
    menuToggle.classList.add('hidden');
    drawerBackdrop.setAttribute('aria-hidden', 'false');
    menuToggle.setAttribute('aria-expanded', 'true');
    sideDrawer.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    const firstFocusable = sideDrawer.querySelector('a, button');
    if (firstFocusable) firstFocusable.focus();
};

const closeDrawer = () => {
    if (!sideDrawer || !drawerBackdrop || !menuToggle) return;
    sideDrawer.classList.add('hidden');
    drawerBackdrop.classList.add('hidden');
    menuToggle.classList.remove('hidden');
    drawerBackdrop.setAttribute('aria-hidden', 'true');
    menuToggle.setAttribute('aria-expanded', 'false');
    sideDrawer.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    menuToggle.focus();
};

const toggleDrawer = () => {
    if (!sideDrawer || !menuToggle) return;
    if (sideDrawer.classList.contains('hidden')) {
        openDrawer();
    } else {
        closeDrawer();
    }
};

const initUi = () => {
    setupExtensionNotifications();
    setupDetailPanelEvents();
    if (syncBtn) syncBtn.addEventListener('click', doLogin);
    if (refreshBtn) refreshBtn.addEventListener('click', () => doRefresh({ force: true }));

    if (usernameInput) {
        usernameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                passwordInput?.focus();
            }
        });
    }
    if (passwordInput) {
        passwordInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                doLogin();
            }
        });
    }

    menuToggle = document.getElementById('menu-toggle');
    sideDrawer = document.getElementById('side-drawer');
    drawerBackdrop = document.getElementById('drawer-backdrop');
    drawerClose = document.getElementById('drawer-close');
    datetimeDisplay = document.getElementById('datetime-display');

    if (menuToggle) {
        menuToggle.addEventListener('click', toggleDrawer);
        menuToggle.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                toggleDrawer();
            }
        });
    }

    if (drawerClose) {
        drawerClose.addEventListener('click', closeDrawer);
    }

    if (drawerBackdrop) {
        drawerBackdrop.addEventListener('click', closeDrawer);
    }

    const updateClock = () => {
        if (datetimeDisplay) {
            datetimeDisplay.innerText = new Date().toLocaleString();
        }
    };
    updateClock();
    setInterval(updateClock, 1000);

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            if (document.getElementById('detail-panel')?.classList.contains('active')) {
                document.getElementById('detail-panel')?.classList.add('hidden');
                document.getElementById('detail-panel')?.classList.remove('active');
                document.body.classList.remove('modal-open');
            }
            closeDrawer();
        }
    });
};

window.handleScheduleClick = handleScheduleClick;
window.addEventListener('DOMContentLoaded', initUi);
window.openDetailPanel = openDetailPanel;
window.currentAttendanceRows = [];
