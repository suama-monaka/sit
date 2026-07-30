const fs = require('fs');

const parseCsv = (content) => {
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;

    for (let index = 0; index < content.length; index += 1) {
        const character = content[index];
        if (quoted) {
            if (character === '"') {
                if (content[index + 1] === '"') {
                    cell += '"';
                    index += 1;
                } else {
                    quoted = false;
                }
            } else {
                cell += character;
            }
            continue;
        }
        if (character === '"') {
            quoted = true;
        } else if (character === ',') {
            row.push(cell.trim());
            cell = '';
        } else if (character === '\n') {
            row.push(cell.trim());
            rows.push(row);
            row = [];
            cell = '';
        } else if (character !== '\r') {
            cell += character;
        }
    }
    if (quoted) throw new Error('CSVの引用符が閉じられていません');
    if (cell.length || row.length) {
        row.push(cell.trim());
        rows.push(row);
    }
    return rows;
};

const decodeCsv = (source) => {
    const buffer = Buffer.isBuffer(source) ? source : fs.readFileSync(source);
    try {
        return new TextDecoder('shift-jis', { fatal: true }).decode(buffer);
    } catch {
        return buffer.toString('utf8');
    }
};

const parseSchedule = (source) => {
    if (!source) return [];
    if (!Buffer.isBuffer(source) && !fs.existsSync(source)) return [];

    try {
        const rows = parseCsv(decodeCsv(source));
        const headerIndex = rows.findIndex((row) => row.some((cell) => cell === '月曜日'));
        if (headerIndex < 0) return [];

        const schedule = [];
        const startDataRow = headerIndex + 1;
        for (let period = 1; period <= 5; period += 1) {
            const baseRow = startDataRow + (period - 1) * 4;
            for (let dayIndex = 0; dayIndex < 5; dayIndex += 1) {
                const column = dayIndex + 1;
                const code = rows[baseRow] && rows[baseRow][column];
                const name = rows[baseRow + 1] && rows[baseRow + 1][column];
                const teacher = rows[baseRow + 2] && rows[baseRow + 2][column];
                if (code && code !== '未登録' && code.length > 2) {
                    schedule.push({
                        period,
                        day: dayIndex + 1,
                        name: name || '',
                        code,
                        teacher: teacher || ''
                    });
                }
            }
        }
        return schedule;
    } catch (error) {
        console.error('[Schedule Parse Error]:', error.message || error);
        return [];
    }
};

module.exports = parseSchedule;
module.exports.parseCsv = parseCsv;
