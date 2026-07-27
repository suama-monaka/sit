const fs = require('fs');

function parseSchedule(csvPath) {
    if (!csvPath || !fs.existsSync(csvPath)) return [];

    try {
        const buffer = fs.readFileSync(csvPath);
        let content = '';

        try {
            const decoder = new TextDecoder('shift-jis');
            content = decoder.decode(buffer);
        } catch (e) {
            content = buffer.toString('utf8');
        }

        const rows = content.split(/\r?\n/).map(line => 
            line.split(',').map(cell => cell.replace(/"/g, '').trim())
        );

        const headerIndex = rows.findIndex(r => r.some(c => c === '月曜日'));
        if (headerIndex === -1) {
            console.error('   [Campuss] ❌ "月曜日" header not found');
            return [];
        }

        const schedule = [];
        const startDataRow = headerIndex + 1;

        for (let period = 1; period <= 5; period++) {
            const baseRow = startDataRow + (period - 1) * 4;
            for (let dayIdx = 0; dayIdx < 5; dayIdx++) {
                const col = dayIdx + 1;
                const code = rows[baseRow]?.[col];
                const name = rows[baseRow + 1]?.[col];
                const teacher = rows[baseRow + 2]?.[col];

                if (code && code !== '未登録' && code.length > 2) {
                    schedule.push({
                        period: period,
                        day: dayIdx + 1,
                        name: name,
                        code: code,
                        teacher: teacher || ''
                    });
                }
            }
        }
        
        if (fs.existsSync(csvPath)) fs.unlinkSync(csvPath);
        return schedule;
    } catch (e) {
        console.error('Parse Error:', e);
        return [];
    }
}

module.exports = parseSchedule;