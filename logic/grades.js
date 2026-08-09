'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const waitForPageUpdate = async (page) => {
    await wait(500);
    if (typeof page.waitForNetworkIdle === 'function') {
        await page.waitForNetworkIdle({ idleTime: 300, timeout: 5000 }).catch(() => {});
    }
};

const activateControl = async (page, label) => {
    const result = await page.evaluate((targetLabel) => {
        const normalize = (value) => String(value || '').replace(/\s+/g, '').trim();
        const target = normalize(targetLabel);
        const elements = Array.from(document.querySelectorAll(
            'a, button, input[type="button"], input[type="submit"], [role="button"]'
        ));
        const element = elements.find((candidate) => normalize(
            candidate.value || candidate.innerText || candidate.textContent ||
            candidate.getAttribute('aria-label') || candidate.getAttribute('title')
        ) === target);
        if (!element) return { found: false, href: '' };
        const href = element instanceof HTMLAnchorElement ? element.href : '';
        if (href && !href.toLowerCase().startsWith('javascript:')) {
            return { found: true, href };
        }
        element.click();
        return { found: true, href: '' };
    }, label);
    if (!result.found) throw new Error(`${label}が見つかりませんでした`);
    if (result.href) {
        const currentUrl = new URL(page.url());
        const targetUrl = new URL(result.href, currentUrl);
        if (
            targetUrl.origin !== currentUrl.origin ||
            !targetUrl.pathname.startsWith('/campusweb/') ||
            targetUrl.username ||
            targetUrl.password
        ) {
            throw new Error('Campus Squareの遷移先URLが拒否されました');
        }
        await page.goto(targetUrl.href, { waitUntil: 'networkidle2', timeout: 30000 });
    } else {
        await waitForPageUpdate(page);
    }
};

const waitForCsvDownload = async (downloadPath) => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
        const files = fs.readdirSync(downloadPath);
        const fileName = files.find((name) => name.toLowerCase().endsWith('.csv'));
        if (fileName && !files.some((name) => name.toLowerCase().endsWith('.crdownload'))) {
            const csvPath = path.resolve(downloadPath, fileName);
            const relativePath = path.relative(downloadPath, csvPath);
            if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
                throw new Error('Downloaded grade CSV path was rejected');
            }
            const stat = fs.lstatSync(csvPath);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 5 * 1024 * 1024) {
                throw new Error('Downloaded grade CSV file was rejected');
            }
            return fs.readFileSync(csvPath);
        }
        await wait(500);
    }
    throw new Error('履修成績CSVのダウンロードが完了しませんでした');
};

const fetchGradesFile = async (browser, id, password) => {
    const page = await browser.newPage();
    const temporaryRoot = path.resolve(os.tmpdir());
    const expectedPrefix = path.join(temporaryRoot, 'sit-grades-');
    const downloadRoot = fs.mkdtempSync(expectedPrefix);
    try {
        await page.goto('https://portal.shonan-it.ac.jp/campusweb/', {
            waitUntil: 'networkidle2',
            timeout: 30000
        });
        await page.type('#userNameInput', id);
        await page.type('#passwordInput', password);
        await Promise.all([
            page.click('button[type="submit"]'),
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 })
        ]);
        await activateControl(page, '学修状況・判定');
        await activateControl(page, '履修成績照会');
        await activateControl(page, 'ファイルに出力する');
        const client = await page.target().createCDPSession();
        await client.send('Page.setDownloadBehavior', {
            behavior: 'allow',
            downloadPath: downloadRoot
        });
        await activateControl(page, 'ファイル出力開始');
        return await waitForCsvDownload(downloadRoot);
    } finally {
        await page.close();
        const resolved = path.resolve(downloadRoot);
        if (resolved.startsWith(expectedPrefix)) {
            fs.rmSync(resolved, { recursive: true, force: true });
        }
    }
};

module.exports = fetchGradesFile;
module.exports.activateControl = activateControl;
module.exports.waitForCsvDownload = waitForCsvDownload;
