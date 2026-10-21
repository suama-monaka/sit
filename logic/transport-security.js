'use strict';

const isLoopbackAddress = (address) => {
    const value = String(address || '').trim().toLowerCase();
    return value === '::1' ||
        /^127(?:\.\d{1,3}){3}$/.test(value) ||
        /^::ffff:127(?:\.\d{1,3}){3}$/.test(value);
};

const isEncryptedOrLoopbackRequest = (req) => (
    Boolean(req && req.secure) ||
    isLoopbackAddress(req && (req.ip || (req.socket && req.socket.remoteAddress)))
);

module.exports = { isEncryptedOrLoopbackRequest, isLoopbackAddress };
