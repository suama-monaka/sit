async function fetchAssignments(browser, id, pw) {
    const page = await browser.newPage();
    try {
        await page.goto('https://moodle2026.shonan-it.ac.jp/login/index.php', { waitUntil: 'networkidle2' });
        await new Promise(resolve => setTimeout(resolve, 1000));
        const isLoginPage = await page.evaluate(() => {
            return document.querySelector('#username, input[name="username"]') !== null;
        });
        console.log('Assignments: Is login page?', isLoginPage);

        if (isLoginPage) {
            try {
                const usernameInput = await page.$('#username') || await page.$('input[name="username"]');
                const passwordInput = await page.$('#password') || await page.$('input[name="password"]');
                if (!usernameInput || !passwordInput) {
                    console.log('Assignments: Login form elements not found');
                    return [];
                }
                await page.type('#username', id.toLowerCase()).catch(() => page.type('input[name="username"]', id.toLowerCase()));
                await page.type('#password', pw).catch(() => page.type('input[name="password"]', pw));
                await Promise.all([
                    page.click('#loginbtn'),
                    page.waitForNavigation({ waitUntil: 'networkidle2' })
                ]).catch(e => console.log('Assignments: Navigation timeout:', e.message));
            } catch (loginError) {
                console.log('Assignments: Login error:', loginError.message);
            }
        } else {
            console.log('Assignments: Already logged in, skipping login');
        }

        await page.goto('https://moodle2026.shonan-it.ac.jp/my/', { waitUntil: 'networkidle2' });
        await page.waitForSelector('body', { timeout: 30000 });
        await new Promise(resolve => setTimeout(resolve, 1500));

        console.log('Assignments: Page title:', await page.title());
        console.log('Assignments: Current URL:', page.url());

        const scrapeTasks = async () => {
            return await page.evaluate(() => {
                console.log('Assignments: Evaluating page...');

                const parseEventItem = (item) => {
                    const titleLink = item.querySelector('h6.event-name a');
                    const timeElem = item.querySelector('small.text-end');
                    const metaElem = item.querySelector('.event-name-container small');
                    const title = titleLink ? (titleLink.innerText || titleLink.textContent).trim() : '';
                    const url = titleLink ? titleLink.href : '';
                    const time = timeElem ? (timeElem.innerText || timeElem.textContent).trim() : '';
                    const detail = metaElem ? (metaElem.innerText || metaElem.textContent).trim() : '';
                    if (!title) return null;
                    return { title, url, time, detail };
                };

                const groups = [];
                const dateHeaders = Array.from(document.querySelectorAll('div[data-region="event-list-content-date"]'));

                if (dateHeaders.length) {
                    dateHeaders.forEach(header => {
                        const dateTitle = (header.innerText || '').trim();
                        const items = [];
                        let sibling = header.nextElementSibling;
                        while (sibling && !sibling.matches('div[data-region="event-list-content-date"]')) {
                            const eventItems = sibling.querySelectorAll ? sibling.querySelectorAll('div[data-region="event-list-item"]') : [];
                            eventItems.forEach(item => {
                                const task = parseEventItem(item);
                                if (task) items.push(task);
                            });
                            sibling = sibling.nextElementSibling;
                        }
                        if (items.length) {
                            groups.push({ date: dateTitle, tasks: items });
                        }
                    });
                }

                if (!groups.length) {
                    const items = [];
                    document.querySelectorAll('div[data-region="event-list-item"]').forEach(item => {
                        const task = parseEventItem(item);
                        if (task) items.push(task);
                    });
                    if (items.length) {
                        groups.push({ date: '期限不明', tasks: items });
                    }
                }

                console.log('Assignments: Groups found', groups.length);
                return groups;
            });
        };

        const clickLoadMoreEvents = async () => {
            const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
            try {
                const buttonSelector = 'button[data-action="more-events"], [data-region="more-events-button-container"] button';
                let clickedAny = false;
                let pressDetected = false;
                let attempts = 0;
                const maxAttempts = 5;

                await page.waitForSelector(buttonSelector, { timeout: 15000 }).catch(() => null);

                while (attempts < maxAttempts) {
                    const button = await page.$(buttonSelector);
                    if (!button) {
                        if (attempts === 0) console.log('Assignments: more-events button not found');
                        break;
                    }

                    const buttonText = await page.evaluate(el => (el.innerText || el.textContent || '').trim(), button);
                    console.log('Assignments: more-events button found:', buttonText || '[no text]');

                    const beforeCount = await page.$$eval('div[data-region="event-list-item"]', items => items.length);
                    await page.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center' }), button);
                    await sleep(300);

                    let clicked = false;
                    try {
                        await page.click(buttonSelector, { delay: 100 });
                        clicked = true;
                        console.log('Assignments: page.click performed on more-events button');
                    } catch (clickError) {
                        console.log('Assignments: page.click failed:', clickError.message);
                        try {
                            await button.click({ delay: 100 });
                            clicked = true;
                            console.log('Assignments: ElementHandle.click performed as fallback');
                        } catch (fallbackError) {
                            console.log('Assignments: fallback ElementHandle.click failed:', fallbackError.message);
                        }
                    }

                    if (!clicked) {
                        console.log('Assignments: Click attempt did not execute');
                        break;
                    }

                    clickedAny = true;
                    attempts += 1;
                    await sleep(1200);

                    const afterCount = await page.$$eval('div[data-region="event-list-item"]', items => items.length);
                    const stillExists = await page.$(buttonSelector);
                    const loadedNew = afterCount > beforeCount;
                    const buttonRemoved = !stillExists;

                    if (loadedNew || buttonRemoved) {
                        pressDetected = true;
                        console.log('Assignments: Button press detected via', loadedNew ? 'item count increase' : 'button removal');
                    } else {
                        console.log('Assignments: Button press not confirmed; count before=', beforeCount, 'after=', afterCount);
                    }

                    if (!stillExists) break;
                }

                console.log('Assignments: clickLoadMoreEvents result:', { clickedAny, pressDetected, attempts });
                return { clickedAny, pressDetected, attempts };
            } catch (e) {
                console.log('Assignments: clickLoadMoreEvents error', e.message);
                return { clickedAny: false, pressDetected: false, attempts: 0 };
            }
        };

        let tasks = [];

        const clickResult = await clickLoadMoreEvents();
        console.log('Assignments: clickLoadMoreEvents finished:', clickResult);
        tasks = await scrapeTasks();
        console.log('Assignments: Tasks from /my/:', tasks.length);

        if (tasks.length === 0) {
            console.log('Assignments: Trying calendar page...');
            await page.goto('https://moodle2026.shonan-it.ac.jp/calendar/view.php?view=upcoming', { waitUntil: 'networkidle2' });
            await new Promise(resolve => setTimeout(resolve, 1200));
            await clickLoadMoreEvents();
            console.log('Assignments: Calendar page title:', await page.title());
            tasks = await scrapeTasks();
            console.log('Assignments: Tasks from calendar:', tasks.length);
        }

        if (tasks.length === 0) {
            console.log('Assignments: Trying assign index page...');
            await page.goto('https://moodle2026.shonan-it.ac.jp/mod/assign/index.php', { waitUntil: 'networkidle2' });
            await new Promise(resolve => setTimeout(resolve, 1200));
            await clickLoadMoreEvents();
            console.log('Assignments: Assign index page title:', await page.title());
            tasks = await scrapeTasks();
            console.log('Assignments: Tasks from assign index:', tasks.length);
        }

        if (tasks.length === 0) {
            console.log('Assignments: Trying courses page...');
            await page.goto('https://moodle2026.shonan-it.ac.jp/my/courses.php', { waitUntil: 'networkidle2' });
            await new Promise(resolve => setTimeout(resolve, 1200));
            await clickLoadMoreEvents();
            console.log('Assignments: Courses page title:', await page.title());
            tasks = await scrapeTasks();
            console.log('Assignments: Tasks from courses:', tasks.length);
        }

        console.log('Assignments: Final tasks count:', tasks.length);
        return tasks;
    } catch (e) {
        console.error('Assignments Error:', e.message);
        return [];
    } finally {
        await page.close();
    }
}

module.exports = fetchAssignments;
