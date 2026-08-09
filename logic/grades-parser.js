'use strict';

const iconv = require('iconv-lite');
const { parseCsv } = require('./campuss');

const MAX_CELL_LENGTH = 500;
const REQUIRED_HEADERS = [
    'No.',
    '開講年度',
    '開講学期',
    '時間割コード',
    '開講科目名',
    '教員名',
    '評価',
    '評語',
    '合否'
];

const clean = (value) => String(value || '').replace(/\u0000/g, '').trim().slice(0, MAX_CELL_LENGTH);

const decodeGradeCsv = (source) => {
    if (!Buffer.isBuffer(source)) throw new TypeError('履修成績CSVがBufferではありません');
    const utf8 = source.toString('utf8');
    if (source.slice(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) return utf8.slice(1);
    if (!utf8.includes('�') && utf8.includes('開講年度')) return utf8;
    return iconv.decode(source, 'shift_jis');
};

const parseGrades = (source) => {
    const rows = parseCsv(decodeGradeCsv(source));
    const headerIndex = rows.findIndex((row) => REQUIRED_HEADERS.every((header) => row.includes(header)));
    if (headerIndex < 0) throw new Error('履修成績CSVの見出しが見つかりません');
    const header = rows[headerIndex].map(clean);
    const indexes = Object.fromEntries(REQUIRED_HEADERS.map((name) => [name, header.indexOf(name)]));
    const scopeRow = rows.find((row) => clean(row[0]) === '[年度・学期]');
    const records = [];
    for (const row of rows.slice(headerIndex + 1)) {
        if (!row.some((cell) => clean(cell))) continue;
        const get = (name) => clean(row[indexes[name]]);
        const record = {
            no: get('No.'),
            year: get('開講年度'),
            term: get('開講学期'),
            code: get('時間割コード'),
            name: get('開講科目名'),
            teacher: get('教員名'),
            score: get('評価'),
            grade: get('評語'),
            result: get('合否')
        };
        if (!record.code && !record.name) continue;
        records.push(record);
        if (records.length > 5000) throw new Error('履修成績CSVの行数が上限を超えています');
    }
    return {
        scope: scopeRow ? clean(scopeRow[1]) : '',
        records
    };
};

module.exports = parseGrades;
module.exports.decodeGradeCsv = decodeGradeCsv;
