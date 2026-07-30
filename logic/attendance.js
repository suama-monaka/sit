const PORTAL_HOST = 'portal.shonan-it.ac.jp';

const resolvePortalUrl = (value, baseUrl) => {
    const resolved = new URL(String(value || ''), baseUrl);
    if (
        resolved.protocol !== 'https:' ||
        resolved.hostname !== PORTAL_HOST ||
        resolved.port ||
        resolved.username ||
        resolved.password
    ) {
        throw new Error('Portal navigation target was rejected');
    }
    return resolved.href;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeText = (text) => {
    return String(text || '')
        .replace(/[\s　]+/g, ' ')
        .replace(/[()（）\[\]「」]/g, '')
        .replace(/・/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
};

async function fetchAttendance(browser, id, pw, classInfo) {
    const page = await browser.newPage();
    try {
        await page.goto('https://portal.shonan-it.ac.jp/campusweb/', { waitUntil: 'networkidle2' });
        await page.waitForSelector('#userNameInput', { timeout: 10000 });
        await page.type('#userNameInput', id);
        await page.type('#passwordInput', pw);

        await Promise.all([
            page.click('button[type="submit"]'),
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 })
        ]);
        const getNavigationHref = async (pattern) => {
            return page.evaluate((pattern) => {
                const regex = new RegExp(pattern, 'i');
                const anchors = Array.from(document.querySelectorAll('a[href]'));
                const anchor = anchors.find((a) => regex.test((a.innerText || '').trim()));
                if (anchor) return anchor.href;

                const buttons = Array.from(document.querySelectorAll('button, input[type=button], input[type=submit]'));
                const button = buttons.find((el) => regex.test((el.innerText || el.value || '').trim()));
                if (button) {
                    if (button.hasAttribute('href')) {
                        return button.getAttribute('href');
                    }
                    const onclick = button.getAttribute('onclick') || '';
                    const match = onclick.match(/location\.href\s*=\s*['"]([^'"]+)['"]/i);
                    if (match) return match[1];
                }
                return null;
            }, pattern);
        };

        const navigateToLink = async (pattern, label) => {
            for (let attempt = 0; attempt < 10; attempt++) {
                const href = await getNavigationHref(pattern);
                if (href) {
                    const resolved = resolvePortalUrl(href, page.url());
                    await page.goto(resolved, { waitUntil: 'networkidle2', timeout: 30000 });
                    return;
                }

                const clicked = await page.evaluate((pattern) => {
                    const regex = new RegExp(pattern, 'i');
                    const elements = Array.from(document.querySelectorAll('a, button, input, div, span'));
                    const candidate = elements.find((el) => {
                        const text = (el.innerText || el.value || '').trim();
                        return text && regex.test(text);
                    });
                    if (candidate) {
                        candidate.click();
                        return true;
                    }
                    return false;
                }, pattern);

                if (clicked) {
                    await Promise.race([
                        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => null),
                        sleep(2000)
                    ]);
                    resolvePortalUrl(page.url(), page.url());
                    return;
                }

                await sleep(1000);
            }
            throw new Error(`${label}リンクが見つかりませんでした。`);
        };

        await navigateToLink('学生情報|学籍情報|学生', '学生情報');
        await sleep(1200);
        await navigateToLink('出欠確認|出欠|出席状況|出席情報|欠席', '出欠確認');
        await sleep(1200);

        const attendanceResult = await page.evaluate((classInfo) => {
            const normalizeText = (text) => String(text || '')
                .replace(/[\s　]+/g, ' ')
                .replace(/[()（）\[\]「」]/g, '')
                .replace(/[・·･／\\/]/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .toLowerCase();

            const table = document.querySelector('.sp-table-scroll');
            if (!table) {
                return {
                    tableFound: false,
                    attendance: [],
                    summary: {
                        matchedTitle: '出欠情報',
                        present: 0,
                        absent: 0,
                        late: 0,
                        early: 0
                    }
                };
            }

            const headers = [];
            const headerRows = Array.from(table.querySelectorAll('thead tr'));
            headerRows.forEach((row) => {
                Array.from(row.cells).forEach((cell) => {
                    const colspan = parseInt(cell.colSpan, 10) || 1;
                    const text = (cell.innerText || '').trim();
                    for (let i = 0; i < colspan; i += 1) {
                        headers.push(text || `col${headers.length}`);
                    }
                });
            });

            const rows = Array.from(table.querySelectorAll('tbody tr')).map((tr) => {
                const cells = Array.from(tr.children).map((cell) => (cell.innerText || '').trim());
                const rowObj = {};
                for (let i = 0; i < Math.max(headers.length, cells.length); i += 1) {
                    const key = headers[i] || `col${i}`;
                    rowObj[key] = cells[i] || '';
                }
                return rowObj;
            });

            const isHeaderLike = (row) => {
                const keys = Object.keys(row);
                if (!keys.length) return false;
                let sameCount = 0;
                for (const k of keys) {
                    const v = String(row[k] || '').trim();
                    if (!v) continue;
                    if (v === String(k).trim()) sameCount += 1;
                }
                return sameCount >= Math.max(3, Math.floor(keys.length * 0.6));
            };

            const cleanedRows = rows.filter((r) => !isHeaderLike(r));

            const targetCode = normalizeText(classInfo?.code || '');
            const targetName = normalizeText(classInfo?.name || '');
            const targetTeacher = normalizeText(classInfo?.teacher || '');
            const targetDay = normalizeText(String(classInfo?.day || ''));
            const targetPeriod = normalizeText(String(classInfo?.period || ''));
            const shouldMatchAll = !targetCode && !targetName && !targetTeacher && !targetDay && !targetPeriod;

            const getRowText = (row) => Object.values(row)
                .map((value) => normalizeText(value || ''))
                .filter(Boolean)
                .join(' ');

            const searchValue = (value, target) => {
                if (!value || !target) return false;
                return value === target || value.includes(target) || target.includes(value);
            };

            const getValueByHeaders = (row, possibleHeaders) => {
                const normalizedHeaders = Object.keys(row).map((h) => normalizeText(h));
                const index = normalizedHeaders.findIndex((header) =>
                    possibleHeaders.some((name) => normalizeText(name) && header.includes(normalizeText(name)))
                );
                if (index >= 0) {
                    const key = Object.keys(row)[index];
                    return normalizeText(row[key] || '');
                }
                return '';
            };

            const isRowMatch = (row) => {
                if (shouldMatchAll) return true;
                const rowText = getRowText(row);
                const code = getValueByHeaders(row, ['時間割コード', '授業コード', '科目コード', 'コースコード', 'コード', 'ｺｰｽｺｰﾄﾞ']);
                const name = getValueByHeaders(row, ['開講科目名', '科目名', '授業名', '教科名', '科目']);
                const teacher = getValueByHeaders(row, ['担当教員', '講師', '教員', '担当']);
                const dayPeriod = getValueByHeaders(row, ['曜日・時限', '曜日/時限', '曜日 時限', '日程', '授業時間']);

                const matches = [];
                if (targetCode && (searchValue(code, targetCode) || rowText.includes(targetCode))) matches.push('code');
                if (targetName && (searchValue(name, targetName) || rowText.includes(targetName))) matches.push('name');
                if (targetTeacher && (searchValue(teacher, targetTeacher) || rowText.includes(targetTeacher))) matches.push('teacher');
                if (targetDay && targetPeriod && (searchValue(dayPeriod, `${targetDay} ${targetPeriod}`) || (rowText.includes(targetDay) && rowText.includes(targetPeriod)))) matches.push('dayPeriod');
                if (targetDay && !targetPeriod && rowText.includes(targetDay)) matches.push('day');
                if (targetPeriod && !targetDay && rowText.includes(targetPeriod)) matches.push('period');

                if (matches.includes('code')) return true;
                return matches.length >= 2;
            };

            const matchedRows = rows.filter(isRowMatch);
            const targetRows = shouldMatchAll ? cleanedRows : matchedRows.filter((r) => !isHeaderLike(r));
            const summary = {
                matchedTitle: '出欠情報',
                present: 0,
                absent: 0,
                late: 0,
                early: 0
            };
            const countStatus = (value) => {
                const normalized = normalizeText(value);
                if (!normalized) return null;
                if (/^(?:出席|〇|○)$/.test(normalized)) return 'present';
                if (/欠席|欠\b/.test(normalized)) return 'absent';
                if (/遅刻|遅\b/.test(normalized)) return 'late';
                if (/早退|早\b/.test(normalized)) return 'early';
                return null;
            };

            targetRows.forEach((row) => {
                Object.values(row).forEach((value) => {
                    const status = countStatus(value);
                    if (status) summary[status] += 1;
                });
            });

            return {
                tableFound: true,
                attendance: [{ headers, rows: targetRows }],
                summary
            };
        }, classInfo);

        if (!attendanceResult.tableFound) {
            throw new Error('出欠情報のテーブルが見つかりませんでした。');
        }

        return attendanceResult;
    } catch (e) {
        console.error('   [Attendance] Error:', e.message || e);
        throw e;
    } finally {
        await page.close();
    }
}

module.exports = fetchAttendance;
