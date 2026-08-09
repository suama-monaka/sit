const fs = require('fs');
const os = require('os');
const path = require('path');

const TERMS = [
    { key: 'first', aliases: ['前学期', '前期'] },
    { key: 'second', aliases: ['後学期', '後期'] }
];

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const waitForPageUpdate = async (page) => {
    await wait(700);
    if (typeof page.waitForNetworkIdle === 'function') {
        await page.waitForNetworkIdle({ idleTime: 300, timeout: 5000 }).catch(() => {});
    }
};

const activateTerm = async (page, aliases) => {
    const result = await page.evaluate((termAliases) => {
        const normalize = (value) => String(value || '').replace(/\s+/g, '').trim();
        const matchesTerm = (value) => {
            const text = normalize(value);
            return termAliases.some((alias) => text.includes(normalize(alias)));
        };
        const elementText = (element) => normalize(
            element.value || element.innerText || element.textContent ||
            element.getAttribute('aria-label') || element.getAttribute('title')
        );

        const termLinks = Array.from(document.querySelectorAll('.rs-gakki-tab a, td.rishu-tab a, a[href*="gakkiKbnCode="]'));
        const termLink = termLinks.find((element) => matchesTerm(`${elementText(element)} ${element.parentElement ? element.parentElement.getAttribute('title') : ''}`));
        if (termLink) {
            return { activated: true, method: 'term-link', href: termLink.href };
        }

        for (const select of document.querySelectorAll('select')) {
            const option = Array.from(select.options).find((candidate) => matchesTerm(candidate.textContent));
            if (!option) continue;
            select.value = option.value;
            select.dispatchEvent(new Event('input', { bubbles: true }));
            select.dispatchEvent(new Event('change', { bubbles: true }));
            const submit = select.form && Array.from(select.form.querySelectorAll('button, input[type="submit"], input[type="button"]'))
                .find((candidate) => /^(表示|検索|切替|確定)$/.test(elementText(candidate)));
            if (submit) submit.click();
            return { activated: true, method: 'select' };
        }

        for (const input of document.querySelectorAll('input[type="radio"], input[type="checkbox"]')) {
            const label = input.id ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`) : null;
            if (!matchesTerm(`${elementText(input)} ${label ? label.textContent : ''} ${input.parentElement ? input.parentElement.textContent : ''}`)) continue;
            input.click();
            return { activated: true, method: 'input' };
        }

        const interactive = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'));
        const target = interactive.find((element) => {
            const text = elementText(element);
            return text !== 'テキスト出力' && text.length <= 40 && matchesTerm(text);
        });
        if (!target) return { activated: false, method: '' };
        target.click();
        return { activated: true, method: 'interactive' };
    }, aliases);
    if (result.href) {
        const currentUrl = new URL(page.url());
        const targetUrl = new URL(result.href, currentUrl);
        if (targetUrl.origin !== currentUrl.origin || targetUrl.pathname !== '/campusweb/campussquare.do') {
            throw new Error('学期切替URLが拒否されました');
        }
        await page.goto(targetUrl.href, { waitUntil: 'networkidle2', timeout: 30000 });
        return true;
    }
    if (result.activated) await waitForPageUpdate(page);
    return result.activated;
};

const clickTextExport = async (page, aliases, requireScoped) => page.evaluate(({ termAliases, scopedOnly }) => {
    const normalize = (value) => String(value || '').replace(/\s+/g, '').trim();
    const matchesTerm = (value) => {
        const text = normalize(value);
        return termAliases.some((alias) => text.includes(normalize(alias)));
    };
    const candidates = Array.from(document.querySelectorAll('input, button, a'))
        .filter((element) => normalize(element.value || element.innerText || element.textContent) === 'テキスト出力');
    const isScoped = (element) => {
        let parent = element.parentElement;
        for (let depth = 0; parent && depth < 6 && parent !== document.body; depth += 1) {
            const text = normalize(parent.textContent);
            if (text.length <= 1200 && matchesTerm(text)) return true;
            parent = parent.parentElement;
        }
        return false;
    };
    const scoped = candidates.find(isScoped);
    const target = scoped || (scopedOnly ? null : candidates[0]);
    if (!target) return false;
    target.click();
    return true;
}, { termAliases: aliases, scopedOnly: requireScoped });

const waitForCsvDownload = async (downloadPath) => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
        const files = fs.readdirSync(downloadPath);
        const fileName = files.find((name) => name.toLowerCase().endsWith('.csv'));
        if (fileName && !files.some((name) => name.endsWith('.crdownload'))) {
            const csvPath = path.resolve(downloadPath, fileName);
            const relativeCsvPath = path.relative(downloadPath, csvPath);
            if (relativeCsvPath.startsWith('..') || path.isAbsolute(relativeCsvPath)) {
                throw new Error('Downloaded CSV path was rejected');
            }
            const csvStat = fs.lstatSync(csvPath);
            if (
                !csvStat.isFile() ||
                csvStat.isSymbolicLink() ||
                csvStat.size < 1 ||
                csvStat.size > 5 * 1024 * 1024
            ) {
                throw new Error('Downloaded CSV file was rejected');
            }
            return fs.readFileSync(csvPath);
        }
        await wait(500);
    }
    throw new Error('時間割CSVのダウンロードが完了しませんでした');
};

const downloadTerm = async (page, client, root, term, isRequired) => {
    const downloadPath = path.join(root, term.key);
    fs.mkdirSync(downloadPath, { recursive: true });
    await client.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath
    });
    const activated = await activateTerm(page, term.aliases);
    const clicked = await clickTextExport(page, term.aliases, !activated && !isRequired);
    if (!clicked) {
        if (isRequired) throw new Error('時間割の出力ボタンが見つかりませんでした');
        return null;
    }
    return waitForCsvDownload(downloadPath);
};

async function fetchCampus(browser, id, password) {
    const page = await browser.newPage();
    const temporaryRoot = path.resolve(os.tmpdir());
    const expectedPrefix = path.join(temporaryRoot, 'sit-campus-');
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

        const targetUrl = 'https://portal.shonan-it.ac.jp/campusweb/campussquare.do?_flowId=RSW0001000-flow&link=usual-menu-link-mf-160121';
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });

        const client = await page.target().createCDPSession();
        const result = { first: null, second: null };
        result.first = await downloadTerm(page, client, downloadRoot, TERMS[0], true);
        try {
            result.second = await downloadTerm(page, client, downloadRoot, TERMS[1], false);
        } catch (error) {
            console.error('[Campus Second Semester Error]:', error.message || error);
        }
        return result;
    } finally {
        await page.close();
        const resolved = path.resolve(downloadRoot);
        if (resolved.startsWith(expectedPrefix)) {
            fs.rmSync(resolved, { recursive: true, force: true });
        }
    }
}

module.exports = fetchCampus;
module.exports.activateTerm = activateTerm;
module.exports.clickTextExport = clickTextExport;
module.exports.waitForCsvDownload = waitForCsvDownload;
