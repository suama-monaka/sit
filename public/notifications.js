const BRIDGE_CHANNEL = 'sit-auto-login-bridge-v1';
const DETECTION_TIMEOUT_MS = 1600;
let extensionDetected = false;
let extensionInstallSupported = true;

const canInstallChromeExtension = () => {
    const userAgent = navigator.userAgent || '';
    const mobileHint = navigator.userAgentData?.mobile === true;
    const touchIPad = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
    return !mobileHint && !touchIPad && !/Android|iPhone|iPad|iPod|Mobile/i.test(userAgent);
};

const setExtensionState = (installed, version = '') => {
    const badge = document.getElementById('notification-badge');
    const item = document.getElementById('extension-notification');
    const empty = document.getElementById('notification-empty');
    const status = document.getElementById('extension-detection-status');
    extensionDetected = installed;
    if (!extensionInstallSupported) {
        if (badge) {
            badge.hidden = true;
            badge.textContent = '';
        }
        if (item) item.hidden = true;
        if (empty) empty.hidden = false;
        return;
    }
    if (badge) {
        badge.hidden = installed;
        badge.textContent = installed ? '' : '1';
    }
    if (item) item.hidden = installed;
    if (empty) empty.hidden = !installed;
    if (status) {
        status.textContent = installed
            ? '拡張機能を確認しました' + (version ? ' v' + version : '')
            : '未導入でもSIT Syncは利用できます';
    }
};

const sendPing = () => {
    window.postMessage({
        channel: BRIDGE_CHANNEL,
        type: 'site-ping'
    }, window.location.origin);
};

const openPanel = () => {
    const button = document.getElementById('notification-toggle');
    const panel = document.getElementById('notification-panel');
    if (!button || !panel) return;
    panel.classList.remove('hidden');
    panel.setAttribute('aria-hidden', 'false');
    button.setAttribute('aria-expanded', 'true');
    const focusTarget = panel.querySelector('a, button');
    if (focusTarget) focusTarget.focus();
};

const closePanel = () => {
    const button = document.getElementById('notification-toggle');
    const panel = document.getElementById('notification-panel');
    if (!button || !panel) return;
    panel.classList.add('hidden');
    panel.setAttribute('aria-hidden', 'true');
    button.setAttribute('aria-expanded', 'false');
};

export const reportExtensionLoginResult = (success) => {
    window.postMessage({
        channel: BRIDGE_CHANNEL,
        type: 'login-result',
        success: success === true
    }, window.location.origin);
};

export const setupExtensionNotifications = () => {
    const button = document.getElementById('notification-toggle');
    const panel = document.getElementById('notification-panel');
    const closeButton = document.getElementById('notification-close');
    if (!button || !panel || !closeButton) return;

    window.addEventListener('message', (event) => {
        if (
            event.source !== window ||
            event.origin !== window.location.origin ||
            !event.data ||
            event.data.channel !== BRIDGE_CHANNEL ||
            event.data.type !== 'extension-ready'
        ) {
            return;
        }
        const version = /^[0-9]+(?:\.[0-9]+){2}$/.test(String(event.data.version || ''))
            ? String(event.data.version)
            : '';
        setExtensionState(true, version);
    });

    button.addEventListener('click', () => {
        if (panel.classList.contains('hidden')) openPanel();
        else closePanel();
    });
    closeButton.addEventListener('click', closePanel);
    document.addEventListener('click', (event) => {
        if (!panel.classList.contains('hidden') && !event.target.closest('#notification-center')) {
            closePanel();
        }
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !panel.classList.contains('hidden')) {
            closePanel();
            button.focus();
        }
    });

    extensionInstallSupported = canInstallChromeExtension();
    setExtensionState(false);
    if (!extensionInstallSupported) return;
    for (const delay of [0, 250, 700, 1200]) {
        setTimeout(sendPing, delay);
    }
    setTimeout(() => {
        if (!extensionDetected) setExtensionState(false);
    }, DETECTION_TIMEOUT_MS);
};
