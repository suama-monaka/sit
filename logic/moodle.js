async function fetchMoodle(browser, id, pw) {
    const page = await browser.newPage();
    try {
        await page.goto('https://moodle2026.shonan-it.ac.jp/login/index.php', { waitUntil: 'networkidle2' });
        await new Promise(resolve => setTimeout(resolve, 1000));

        const isLoginPage = await page.evaluate(() => {
            return Boolean(document.querySelector('#username') || document.querySelector('input[name="username"]'));
        });

        if (isLoginPage) {
            console.log('Moodle: Login page detected, attempting login...');
            try {
                await page.waitForSelector('#username, input[name="username"]', { timeout: 10000 });
            } catch (e) {
                console.log('Moodle: Username input not found:', e.message);
                return [];
            }

            await page.focus('#username');
            await page.keyboard.type(id.toLowerCase(), { delay: 50 });
            await page.focus('#password');
            await page.keyboard.type(pw, { delay: 50 });
            
            console.log('Moodle: Credentials entered, clicking login button...');
            try {
                await Promise.all([
                    page.click('#loginbtn'),
                    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 })
                ]);
            } catch (e) {
                console.log('Moodle: Login navigation failed or timed out:', e.message);
            }
        }

        await page.goto('https://moodle2026.shonan-it.ac.jp/my/courses.php', { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(resolve => setTimeout(resolve, 1500));

        const courses = await page.evaluate(() => {
            const anchors = Array.from(document.querySelectorAll('a[href*="/course/view.php?id="]'));
            const results = [];
            const normalizedSet = new Set();

            const weekdayMap = { '月': 1, '火': 2, '水': 3, '木': 4, '金': 5 };
            const periodEndMinutes = { 
                1: 10 * 60 + 30,
                2: 12 * 60 + 10,
                3: 14 * 60 + 30,
                4: 16 * 60 + 10,
                5: 17 * 60 + 50
            };

            const now = new Date();
            const currentDay = now.getDay(); 
            const currentTotalMin = now.getHours() * 60 + now.getMinutes();

            anchors.forEach(anchor => {
                let title = (anchor.innerText || '').replace(/コース名/g, '').trim().replace(/\s+/g, ' ');
                if (!title || title.length <= 2) {
                    const li = anchor.closest('li[data-course-id]');
                    title = li ? (li.innerText || '').replace(/コース名/g, '').trim().replace(/\s+/g, ' ') : title;
                }
                if (!title || title.length <= 2) return;

                let url = anchor.href && anchor.href.includes('/course/view.php?id=') ? anchor.href : null;
                if (!url) {
                    const li = anchor.closest('li[data-course-id]');
                    const courseId = li ? li.dataset.courseId || li.getAttribute('data-course-id') : null;
                    if (courseId) {
                        url = `https://moodle2026.shonan-it.ac.jp/course/view.php?id=${courseId}`;
                    }
                }
                if (!url) return;

                const normalized = `${title}||${url}`;
                if (normalizedSet.has(normalized)) return;
                normalizedSet.add(normalized);

                const isLongCourse = title.includes('共通基盤ワークショップ') || title.includes('情報学実習Ａ');
                
                if (isLongCourse) {
                    title = title + " (2単元分)";
                }

                let sortScore = Infinity; 
                const tagMatch = title.match(/\[([月火水木金])([1-5])\]/);

                if (tagMatch) {
                    const dayName = tagMatch[1];
                    const startPeriod = parseInt(tagMatch[2], 10);
                    const targetDayNum = weekdayMap[dayName];

                    let dayDiff = targetDayNum - currentDay;
                    if (dayDiff < 0) dayDiff += 7;

                    let effectiveCheckPeriod = startPeriod;
                    if (isLongCourse && startPeriod < 5) {
                        effectiveCheckPeriod = startPeriod + 1;
                    }

                    const isToday = (dayDiff === 0);
                    const isOver = isToday && currentTotalMin > periodEndMinutes[effectiveCheckPeriod];

                    const effectiveDayDiff = isOver ? 7 : dayDiff;
                    sortScore = (effectiveDayDiff * 10) + startPeriod;
                }

                results.push({ title, url, sortScore });
            });

            return results.sort((a, b) => {
                if (a.sortScore !== b.sortScore) return a.sortScore - b.sortScore;
                return a.title.localeCompare(b.title, 'ja');
            });
        });

        console.log('Moodle: Sorted courses count:', courses.length);
        return courses;
    } catch (e) {
        console.error("Moodle Error:", e.message);
        return [];
    } finally {
        await page.close();
    }
}

module.exports = fetchMoodle;