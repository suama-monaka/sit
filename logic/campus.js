const fs = require('fs');
const path = require('path');


async function fetchCampus(browser, id, pw) {
    const page = await browser.newPage();
    const downloadPath = path.resolve(__dirname, '../downloads');
    
    if (!fs.existsSync(downloadPath)) {
        fs.mkdirSync(downloadPath, { recursive: true });
    }

    try {
        console.log('   [Campus] Page loading...');
        await page.goto('https://portal.shonan-it.ac.jp/campusweb/', { waitUntil: 'networkidle2' });

        console.log('   [Campus] Logging in...');
        await page.type('#userNameInput', id);
        await page.type('#passwordInput', pw);
        await Promise.all([
            page.click('button[type="submit"]'),
            page.waitForNavigation({ waitUntil: 'networkidle2' })
        ]);

        console.log('   [Campus] Navigating to Schedule page...');
        const targetUrl = 'https://portal.shonan-it.ac.jp/campusweb/campussquare.do?_flowId=RSW0001000-flow&link=usual-menu-link-mf-160121';
        await page.goto(targetUrl, { waitUntil: 'networkidle2' });

        const client = await page.target().createCDPSession();
        await client.send('Page.setDownloadBehavior', {
            behavior: 'allow',
            downloadPath: downloadPath,
        });

        console.log('   [Campus] Searching for "テキスト出力" button...');
        let clicked = false;
        for (let i = 0; i < 15; i++) {
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            
            clicked = await page.evaluate(() => {
                const els = Array.from(document.querySelectorAll('input, button, a'));
                const target = els.find(el => (el.value || el.innerText || '').trim() === 'テキスト出力');
                if (target) {
                    target.click();
                    return true;
                }
                return false;
            });

            if (clicked) {
                console.log(`   [Campus] 🎯 Clicked "テキスト出力" (Attempt ${i + 1})`);
                break;
            }
            console.log(`   [Campus] ...Waiting for button render (${i + 1}/15)`);
            await new Promise(r => setTimeout(r, 1000));
        }

        if (!clicked) throw new Error('「テキスト出力」ボタンが見つかりませんでした。');

        console.log('   [Campus] Waiting for CSV file download...');
        let fileName = '';
        for (let i = 0; i < 40; i++) {
            const files = fs.readdirSync(downloadPath);
            fileName = files.find(f => f.endsWith('.csv') && !f.endsWith('.crdownload'));
            if (fileName) {
                console.log(`   [Campus] 📦 Downloaded: ${fileName}`);
                break;
            }
            await new Promise(r => setTimeout(r, 500));
        }

        if (!fileName) throw new Error('CSVのダウンロードに失敗しました（タイムアウト）。');

        return path.join(downloadPath, fileName);

    } catch (e) {
        console.error('   [Campus] Error:', e.message);
        throw e;
    } finally {
        await page.close();
    }
}

module.exports = fetchCampus;