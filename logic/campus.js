const fs = require('fs');
const os = require('os');
const path = require('path');

async function fetchCampus(browser, id, password) {
    const page = await browser.newPage();
    const temporaryRoot = path.resolve(os.tmpdir());
    const expectedPrefix = path.join(temporaryRoot, 'sit-campus-');
    const downloadPath = fs.mkdtempSync(expectedPrefix);

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
        await client.send('Page.setDownloadBehavior', {
            behavior: 'allow',
            downloadPath
        });

        let clicked = false;
        for (let attempt = 0; attempt < 15; attempt += 1) {
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            clicked = await page.evaluate(() => {
                const elements = Array.from(document.querySelectorAll('input, button, a'));
                const target = elements.find((element) => {
                    return (element.value || element.innerText || '').trim() === 'テキスト出力';
                });
                if (!target) return false;
                target.click();
                return true;
            });
            if (clicked) break;
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        if (!clicked) throw new Error('時間割の出力ボタンが見つかりませんでした');

        let csvPath = '';
        for (let attempt = 0; attempt < 40; attempt += 1) {
            const files = fs.readdirSync(downloadPath);
            const fileName = files.find((name) => name.toLowerCase().endsWith('.csv'));
            if (fileName && !files.some((name) => name.endsWith('.crdownload'))) {
                csvPath = path.join(downloadPath, fileName);
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
        if (!csvPath) throw new Error('時間割CSVのダウンロードが完了しませんでした');
        const resolvedCsvPath = path.resolve(csvPath);
        const relativeCsvPath = path.relative(downloadPath, resolvedCsvPath);
        if (relativeCsvPath.startsWith('..') || path.isAbsolute(relativeCsvPath)) {
            throw new Error('Downloaded CSV path was rejected');
        }
        const csvStat = fs.lstatSync(resolvedCsvPath);
        if (
            !csvStat.isFile() ||
            csvStat.isSymbolicLink() ||
            csvStat.size < 1 ||
            csvStat.size > 5 * 1024 * 1024
        ) {
            throw new Error('Downloaded CSV file was rejected');
        }
        return fs.readFileSync(resolvedCsvPath);
    } finally {
        await page.close();
        const resolved = path.resolve(downloadPath);
        if (resolved.startsWith(expectedPrefix)) {
            fs.rmSync(resolved, { recursive: true, force: true });
        }
    }
}

module.exports = fetchCampus;
