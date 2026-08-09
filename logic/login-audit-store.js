'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const { decodeServerSecret } = require('./dual-key-cache-store');

const SQL_PROMISE = initSqlJs();
const MAGIC = Buffer.from('SITLADB1', 'ascii');
const FORMAT_VERSION = 1;
const SALT_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + 1 + SALT_BYTES + NONCE_BYTES + AUTH_TAG_BYTES;
const SAFE_ID_PATTERN = /^[A-Z0-9_-]{1,64}$/;

class LoginAuditIntegrityError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = 'LoginAuditIntegrityError';
    }
}

const deriveEncryptionKey = (serverSecret, salt) => Buffer.from(
    crypto.hkdfSync(
        'sha256',
        serverSecret,
        salt,
        Buffer.from('sit-login-audit:v1', 'utf8'),
        32
    )
);

const createAad = (salt) => Buffer.concat([
    MAGIC,
    Buffer.from([FORMAT_VERSION]),
    salt
]);

const encryptDatabase = (sqliteBytes, serverSecret, salt) => {
    const key = deriveEncryptionKey(serverSecret, salt);
    const nonce = crypto.randomBytes(NONCE_BYTES);
    try {
        const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
        cipher.setAAD(createAad(salt));
        const ciphertext = Buffer.concat([
            cipher.update(sqliteBytes),
            cipher.final()
        ]);
        return Buffer.concat([
            MAGIC,
            Buffer.from([FORMAT_VERSION]),
            salt,
            nonce,
            cipher.getAuthTag(),
            ciphertext
        ]);
    } finally {
        key.fill(0);
    }
};

const decryptDatabase = (encryptedBytes, serverSecret) => {
    if (!Buffer.isBuffer(encryptedBytes) || encryptedBytes.length <= HEADER_BYTES) {
        throw new LoginAuditIntegrityError('Login audit database is truncated');
    }
    if (!encryptedBytes.subarray(0, MAGIC.length).equals(MAGIC)) {
        throw new LoginAuditIntegrityError('Login audit database format is invalid');
    }
    const version = encryptedBytes[MAGIC.length];
    if (version !== FORMAT_VERSION) {
        throw new LoginAuditIntegrityError('Login audit database version is unsupported');
    }
    let offset = MAGIC.length + 1;
    const salt = Buffer.from(encryptedBytes.subarray(offset, offset + SALT_BYTES));
    offset += SALT_BYTES;
    const nonce = encryptedBytes.subarray(offset, offset + NONCE_BYTES);
    offset += NONCE_BYTES;
    const authTag = encryptedBytes.subarray(offset, offset + AUTH_TAG_BYTES);
    offset += AUTH_TAG_BYTES;
    const ciphertext = encryptedBytes.subarray(offset);
    const key = deriveEncryptionKey(serverSecret, salt);
    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
        decipher.setAAD(createAad(salt));
        decipher.setAuthTag(authTag);
        return {
            salt,
            sqliteBytes: Buffer.concat([
                decipher.update(ciphertext),
                decipher.final()
            ])
        };
    } catch (error) {
        salt.fill(0);
        throw new LoginAuditIntegrityError(
            'Login audit database authentication failed',
            { cause: error }
        );
    } finally {
        key.fill(0);
    }
};

class LoginAuditStore {
    constructor({ appVersion = '', databasePath, serverSecret, logger = console } = {}) {
        if (typeof databasePath !== 'string' || !databasePath) {
            throw new TypeError('databasePath is required');
        }
        if (appVersion && !/^\d+\.\d+\.\d+$/.test(appVersion)) {
            throw new TypeError('appVersion is invalid');
        }
        this.appVersion = appVersion;
        this.databasePath = path.resolve(databasePath);
        this.serverSecret = decodeServerSecret(serverSecret);
        this.logger = logger;
        this.database = null;
        this.salt = null;
        this.operationQueue = Promise.resolve();
    }

    async initialize() {
        if (this.database) return;
        const SQL = await SQL_PROMISE;
        fs.mkdirSync(path.dirname(this.databasePath), { recursive: true });
        const databaseExists = fs.existsSync(this.databasePath);
        let schemaChanged = !databaseExists;
        if (databaseExists) {
            const decrypted = decryptDatabase(
                fs.readFileSync(this.databasePath),
                this.serverSecret
            );
            try {
                this.database = new SQL.Database(new Uint8Array(decrypted.sqliteBytes));
                this.salt = decrypted.salt;
            } finally {
                decrypted.sqliteBytes.fill(0);
            }
        } else {
            this.database = new SQL.Database();
            this.salt = crypto.randomBytes(SALT_BYTES);
        }
        this.database.run(`
            CREATE TABLE IF NOT EXISTS login_events (
                event_id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id TEXT NOT NULL CHECK(length(user_id) BETWEEN 1 AND 64),
                logged_in_at TEXT NOT NULL,
                app_version TEXT NOT NULL DEFAULT ''
            )
        `);
        const columns = new Set(
            (this.database.exec('PRAGMA table_info(login_events)')[0]?.values || [])
                .map((column) => column[1])
        );
        if (!columns.has('app_version')) {
            this.database.run("ALTER TABLE login_events ADD COLUMN app_version TEXT NOT NULL DEFAULT ''");
            schemaChanged = true;
        }
        this.database.run(`
            CREATE INDEX IF NOT EXISTS login_events_logged_in_at
            ON login_events(logged_in_at DESC)
        `);
        const check = this.database.exec('PRAGMA quick_check');
        const status = check[0] && check[0].values[0] && check[0].values[0][0];
        if (status !== 'ok') {
            throw new LoginAuditIntegrityError('Login audit SQLite integrity check failed');
        }
        if (schemaChanged) this.persist();
    }

    persist() {
        const sqliteBytes = Buffer.from(this.database.export());
        const encryptedBytes = encryptDatabase(
            sqliteBytes,
            this.serverSecret,
            this.salt
        );
        sqliteBytes.fill(0);
        const token = crypto.randomBytes(12).toString('hex');
        const directory = path.dirname(this.databasePath);
        const temporaryPath = path.join(directory, `.data.${token}.tmp`);
        const backupPath = path.join(directory, `.data.${token}.bak`);
        let descriptor;
        try {
            descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
            fs.writeFileSync(descriptor, encryptedBytes);
            fs.fsyncSync(descriptor);
            fs.closeSync(descriptor);
            descriptor = undefined;
            try {
                fs.renameSync(temporaryPath, this.databasePath);
            } catch (renameError) {
                if (!fs.existsSync(this.databasePath)) throw renameError;
                fs.renameSync(this.databasePath, backupPath);
                try {
                    fs.renameSync(temporaryPath, this.databasePath);
                    fs.unlinkSync(backupPath);
                } catch (replacementError) {
                    if (fs.existsSync(backupPath) && !fs.existsSync(this.databasePath)) {
                        fs.renameSync(backupPath, this.databasePath);
                    }
                    throw replacementError;
                }
            }
        } finally {
            encryptedBytes.fill(0);
            if (descriptor !== undefined) fs.closeSync(descriptor);
            if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
        }
    }

    async ready() {
        const operation = this.operationQueue.then(() => this.initialize());
        this.operationQueue = operation.catch(() => undefined);
        return operation;
    }

    async recordSuccessfulLogin(userId, loggedInAt = new Date()) {
        const normalizedId = String(userId || '').trim().toUpperCase();
        if (!SAFE_ID_PATTERN.test(normalizedId)) {
            throw new TypeError('Valid userId is required');
        }
        const parsedDate = loggedInAt instanceof Date
            ? loggedInAt
            : new Date(loggedInAt);
        if (Number.isNaN(parsedDate.getTime())) {
            throw new TypeError('Valid login time is required');
        }
        const timestamp = parsedDate.toISOString();
        const operation = this.operationQueue.then(async () => {
            await this.initialize();
            this.database.run(
                'INSERT INTO login_events(user_id, logged_in_at, app_version) VALUES (?, ?, ?)',
                [normalizedId, timestamp, this.appVersion]
            );
            this.persist();
            this.logger.log(`[Login Success] ID=${normalizedId} loggedAt=${timestamp} version=${this.appVersion || 'unknown'}`);
            return { userId: normalizedId, loggedInAt: timestamp, appVersion: this.appVersion };
        });
        this.operationQueue = operation.catch(() => undefined);
        return operation;
    }

    async listRecent(limit = 100) {
        const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 100));
        await this.ready();
        const statement = this.database.prepare(`
            SELECT user_id, logged_in_at, app_version
            FROM login_events
            ORDER BY event_id DESC
            LIMIT ?
        `);
        try {
            statement.bind([safeLimit]);
            const rows = [];
            while (statement.step()) rows.push(statement.getAsObject());
            return rows;
        } finally {
            statement.free();
        }
    }
}

const createLoginAuditStore = (options) => new LoginAuditStore(options);

module.exports = {
    LoginAuditIntegrityError,
    createLoginAuditStore,
    decryptDatabase
};
