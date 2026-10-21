'use strict';

const unquoteCookieValue = (value) => {
    if (value.length < 2 || value[0] !== '"' || value[value.length - 1] !== '"') {
        return value;
    }
    return value.slice(1, -1).replace(/\\(["\\])/g, '$1');
};

const parseCookies = (header) => {
    const result = {};
    for (const item of String(header || '').split(';')) {
        const separator = item.indexOf('=');
        if (separator < 1) continue;
        const key = item.slice(0, separator).trim();
        if (!key || key.startsWith('$')) continue;
        const rawValue = item.slice(separator + 1).trim();
        const value = unquoteCookieValue(rawValue);
        try {
            result[key] = decodeURIComponent(value);
        } catch {
            result[key] = '';
        }
    }
    return result;
};

module.exports = { parseCookies };
