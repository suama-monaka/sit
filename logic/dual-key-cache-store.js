'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const v8 = require('v8');
const { promisify } = require('util');
const initSqlJs = require('sql.js');

const ADMIN_KEY_ENV = 'SIT_ADMIN_DECRYPTION_KEY';
const SERVER_SECRET_ENV = 'SIT_SERVER_SECRET';
const DATABASE_EXTENSION = '.db';
const LEGACY_OUTER_FORMAT_VERSION = 2;
const OUTER_FORMAT_VERSION = 3;
const ADMIN_CONFIG_VERSION = 1;
const SAFE_ID_PATTERN = /^[A-Z0-9_-]{1,64}$/;

const SALT_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const DATA_KEY_BYTES = 32;
const P256_PUBLIC_KEY_BYTES = 65;

const ADMIN_CONFIG_BYTES = 1 + SALT_BYTES + P256_PUBLIC_KEY_BYTES;
const ENVELOPE_HEADER_BYTES =
    1 +
    SALT_BYTES +
    P256_PUBLIC_KEY_BYTES +
    SALT_BYTES +
    NONCE_BYTES +
    AUTH_TAG_BYTES +
    DATA_KEY_BYTES +
    SALT_BYTES +
    NONCE_BYTES +
    AUTH_TAG_BYTES +
    DATA_KEY_BYTES +
    NONCE_BYTES +
    AUTH_TAG_BYTES;

const ADMIN_SCRYPT_OPTIONS = {
    N: 65536,
    r: 8,
    p: 1,
    maxmem: 128 * 1024 * 1024
};
const USER_SCRYPT_OPTIONS = {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024
};

const SQL_PROMISE = initSqlJs();
const scryptAsync = promisify(crypto.scrypt);

class CacheStorageError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = 'CacheStorageError';
    }
}

class InvalidCredentialsError extends CacheStorageError {
    constructor(message = 'ID or password is incorrect', options) {
        super(message, options);
        this.name = 'InvalidCredentialsError';
    }
}

class AdminKeyError extends CacheStorageError {
    constructor(message = 'Administrator decryption key is incorrect', options) {
        super(message, options);
        this.name = 'AdminKeyError';
    }
}

class CacheIntegrityError extends CacheStorageError {
    constructor(message = 'Encrypted database integrity check failed', options) {
        super(message, options);
        this.name = 'CacheIntegrityError';
    }
}

const assertSecret = (secret, label, minimumLength = 1) => {
    if (typeof secret !== 'string' || secret.length < minimumLength) {
        throw new CacheStorageError(`${label} must be provided`);
    }
};

const normalizePersistedCache = (cacheEntry, password) => ({
    pwHash: cacheEntry.pwHash,
    pw: password,
    campus: cacheEntry.campus,
    courses: cacheEntry.courses,
    tasks: cacheEntry.tasks,
    attendance: Array.isArray(cacheEntry.attendance) ? cacheEntry.attendance : [],
    grades: cacheEntry.grades && Array.isArray(cacheEntry.grades.records)
        ? cacheEntry.grades
        : { scope: '', records: [] },
    cachedAt: cacheEntry.cachedAt,
    lastErrors: cacheEntry.lastErrors,
    attendanceDebug: cacheEntry.attendanceDebug || null
});

const hashPassword = (password) => (
    crypto.createHash('sha256').update(String(password), 'utf8').digest()
);

const timingSafeBufferEqual = (left, right) => (
    left.length === right.length && crypto.timingSafeEqual(left, right)
);

const deriveValidP256KeyPair = (secret, salt) => {
    assertSecret(secret, 'Administrator decryption key', 12);
    let material = crypto.scryptSync(secret, salt, 32, ADMIN_SCRYPT_OPTIONS);

    for (let counter = 0; counter < 256; counter++) {
        const ecdh = crypto.createECDH('prime256v1');
        try {
            ecdh.setPrivateKey(material);
            return { ecdh, privateMaterial: material };
        } catch (error) {
            const next = crypto.createHash('sha256')
                .update('sit-admin-p256-retry', 'utf8')
                .update(material)
                .update(Buffer.from([counter]))
                .digest();
            material.fill(0);
            material = next;
        }
    }

    material.fill(0);
    throw new CacheStorageError('Unable to derive administrator key pair');
};

const encodeAdminPublicConfig = (adminSecret, derivationSalt = crypto.randomBytes(SALT_BYTES)) => {
    const { ecdh, privateMaterial } = deriveValidP256KeyPair(adminSecret, derivationSalt);
    try {
        return Buffer.concat([
            Buffer.from([ADMIN_CONFIG_VERSION]),
            derivationSalt,
            ecdh.getPublicKey(undefined, 'uncompressed')
        ]);
    } finally {
        privateMaterial.fill(0);
    }
};

const decodeAdminPublicConfig = (configBytes) => {
    const bytes = Buffer.from(configBytes);
    if (bytes.length !== ADMIN_CONFIG_BYTES || bytes[0] !== ADMIN_CONFIG_VERSION) {
        throw new CacheStorageError('Invalid administrator public-key configuration');
    }
    return {
        derivationSalt: bytes.subarray(1, 1 + SALT_BYTES),
        publicKey: bytes.subarray(1 + SALT_BYTES)
    };
};

const verifyAdminSecretForConfig = (adminSecret, configBytes) => {
    const config = decodeAdminPublicConfig(configBytes);
    const { ecdh, privateMaterial } = deriveValidP256KeyPair(
        adminSecret,
        config.derivationSalt
    );
    try {
        return timingSafeBufferEqual(
            ecdh.getPublicKey(undefined, 'uncompressed'),
            config.publicKey
        );
    } finally {
        privateMaterial.fill(0);
    }
};

const writeAdminPublicConfig = (configPath, adminSecret) => {
    const resolvedPath = path.resolve(configPath);
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

    if (fs.existsSync(resolvedPath)) {
        const existing = fs.readFileSync(resolvedPath);
        if (!verifyAdminSecretForConfig(adminSecret, existing)) {
            throw new AdminKeyError(
                'The supplied administrator key does not match the existing public configuration'
            );
        }
        return false;
    }

    const configBytes = encodeAdminPublicConfig(adminSecret);
    const descriptor = fs.openSync(resolvedPath, 'wx', 0o644);
    try {
        fs.writeFileSync(descriptor, configBytes);
        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
    return true;
};

const encryptAesGcm = (key, plaintext, additionalAuthenticatedData) => {
    const nonce = crypto.randomBytes(NONCE_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(additionalAuthenticatedData);
    const ciphertext = Buffer.concat([
        cipher.update(Buffer.from(plaintext)),
        cipher.final()
    ]);
    return {
        nonce,
        authTag: cipher.getAuthTag(),
        ciphertext
    };
};

const decryptAesGcm = (
    key,
    nonce,
    authTag,
    ciphertext,
    additionalAuthenticatedData
) => {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(additionalAuthenticatedData);
    decipher.setAuthTag(authTag);
    return Buffer.concat([
        decipher.update(ciphertext),
        decipher.final()
    ]);
};

const envelopeAad = (
    normalizedId,
    purpose,
    formatVersion = OUTER_FORMAT_VERSION
) => (
    Buffer.from(`sit-cache:v${formatVersion}:${normalizedId}:${purpose}`, 'utf8')
);

const decodeServerSecret = (secret) => {
    if (Buffer.isBuffer(secret)) {
        if (secret.length !== 32) {
            throw new CacheStorageError('Server secret must be exactly 32 bytes');
        }
        return Buffer.from(secret);
    }
    const encoded = String(secret || '').trim();
    if (!/^[a-fA-F0-9]{64}$/.test(encoded)) {
        throw new CacheStorageError('Server secret must be 64 hexadecimal characters');
    }
    return Buffer.from(encoded, 'hex');
};

const deriveUserWrappingKey = async (
    normalizedId,
    password,
    salt,
    serverSecret
) => {
    assertSecret(password, 'Password');
    if (!Buffer.isBuffer(serverSecret) || serverSecret.length !== 32) {
        throw new CacheStorageError('Server secret is required');
    }
    const combinedKey = Buffer.from(`${normalizedId}${String(password)}`, 'utf8');
    let passwordKey;
    try {
        passwordKey = Buffer.from(
            await scryptAsync(combinedKey, salt, 32, USER_SCRYPT_OPTIONS)
        );
        return crypto.createHmac('sha256', serverSecret)
            .update('sit-user-kek:v3', 'utf8')
            .update(Buffer.from([0]))
            .update(normalizedId, 'utf8')
            .update(Buffer.from([0]))
            .update(passwordKey)
            .digest();
    } finally {
        combinedKey.fill(0);
        if (passwordKey) passwordKey.fill(0);
    }
};

const encodeEnvelope = (parts) => Buffer.concat([
    Buffer.from([OUTER_FORMAT_VERSION]),
    parts.adminDerivationSalt,
    parts.adminEphemeralPublicKey,
    parts.adminHkdfSalt,
    parts.adminWrappedKey.nonce,
    parts.adminWrappedKey.authTag,
    parts.adminWrappedKey.ciphertext,
    parts.userSalt,
    parts.userWrappedKey.nonce,
    parts.userWrappedKey.authTag,
    parts.userWrappedKey.ciphertext,
    parts.data.nonce,
    parts.data.authTag,
    parts.data.ciphertext
]);

const decodeEnvelope = (bytes, databasePath) => {
    const envelope = Buffer.from(bytes);
    const formatVersion = envelope[0];
    if (
        envelope.length <= ENVELOPE_HEADER_BYTES ||
        ![LEGACY_OUTER_FORMAT_VERSION, OUTER_FORMAT_VERSION].includes(formatVersion)
    ) {
        throw new CacheIntegrityError(`Unsupported or damaged encrypted DB: ${databasePath}`);
    }

    let offset = 1;
    const take = (length) => {
        const value = envelope.subarray(offset, offset + length);
        offset += length;
        return value;
    };

    return {
        formatVersion,
        adminDerivationSalt: take(SALT_BYTES),
        adminEphemeralPublicKey: take(P256_PUBLIC_KEY_BYTES),
        adminHkdfSalt: take(SALT_BYTES),
        adminWrappedKey: {
            nonce: take(NONCE_BYTES),
            authTag: take(AUTH_TAG_BYTES),
            ciphertext: take(DATA_KEY_BYTES)
        },
        userSalt: take(SALT_BYTES),
        userWrappedKey: {
            nonce: take(NONCE_BYTES),
            authTag: take(AUTH_TAG_BYTES),
            ciphertext: take(DATA_KEY_BYTES)
        },
        data: {
            nonce: take(NONCE_BYTES),
            authTag: take(AUTH_TAG_BYTES),
            ciphertext: envelope.subarray(offset)
        }
    };
};

const serializeValue = (value) => new Uint8Array(v8.serialize(value));
const deserializeValue = (value) => v8.deserialize(Buffer.from(value));

class DualKeyCacheStore {
    constructor({ cacheRoot, adminPublicConfigPath, serverSecret } = {}) {
        if (!cacheRoot) {
            throw new CacheStorageError('cacheRoot is required');
        }
        if (!adminPublicConfigPath) {
            throw new CacheStorageError('adminPublicConfigPath is required');
        }

        this.cacheRoot = path.resolve(cacheRoot);
        this.adminPublicConfigPath = path.resolve(adminPublicConfigPath);
        this.serverSecret = serverSecret === undefined
            ? null
            : decodeServerSecret(serverSecret);
        this.writeLocks = new Map();
    }

    async ready() {
        await SQL_PROMISE;
        const issues = this.recoverInterruptedWrites();
        const adminConfig = this.readAdminPublicConfig();
        const mismatches = [];
        const legacyIds = [];
        let matchingDatabaseCount = 0;
        for (const id of this.listDatabaseIds()) {
            const databasePath = this.getDatabasePath(id);
            let envelope;
            try {
                envelope = decodeEnvelope(fs.readFileSync(databasePath), databasePath);
            } catch (error) {
                const quarantinedPath = this.quarantineDatabase(databasePath);
                issues.push(
                    quarantinedPath
                        ? `${id}.db was damaged and moved to ${path.basename(quarantinedPath)}`
                        : `${id}.db was damaged and could not be moved`
                );
                continue;
            }
            if (envelope.formatVersion !== OUTER_FORMAT_VERSION) {
                legacyIds.push(id);
            }
            if (timingSafeBufferEqual(
                envelope.adminDerivationSalt,
                adminConfig.derivationSalt
            )) {
                matchingDatabaseCount += 1;
            } else {
                mismatches.push({ id, databasePath });
            }
        }
        if (mismatches.length && matchingDatabaseCount === 0) {
            throw new CacheStorageError(
                'Administrator public configuration does not match the encrypted databases'
            );
        }
        for (const mismatch of mismatches) {
            const quarantinedPath = this.quarantineDatabase(mismatch.databasePath);
            issues.push(
                quarantinedPath
                    ? `${mismatch.id}.db had inconsistent key metadata and was moved to ${path.basename(quarantinedPath)}`
                    : `${mismatch.id}.db had inconsistent key metadata and could not be moved`
            );
        }
        if (legacyIds.length) {
            throw new CacheStorageError(
                `Encrypted DB migration is required: ${legacyIds.join(', ')}`
            );
        }
        if (!this.serverSecret) {
            throw new CacheStorageError('Server secret is required');
        }
        return issues;
    }

    recoverInterruptedWrites() {
        this.ensureRoot();
        const issues = [];
        const backupPattern = /^\.([A-Z0-9_-]{1,64})\.([a-f0-9]{24})\.bak$/;
        const backups = new Map();
        for (const entry of fs.readdirSync(this.cacheRoot, { withFileTypes: true })) {
            if (!entry.isFile()) continue;
            const match = entry.name.match(backupPattern);
            if (!match) continue;
            const candidate = path.join(this.cacheRoot, entry.name);
            const items = backups.get(match[1]) || [];
            items.push({
                path: candidate,
                modifiedAt: fs.statSync(candidate).mtimeMs
            });
            backups.set(match[1], items);
        }
        for (const [id, items] of backups) {
            const databasePath = this.getDatabasePath(id);
            if (fs.existsSync(databasePath)) continue;
            items.sort((left, right) => right.modifiedAt - left.modifiedAt);
            fs.renameSync(items[0].path, databasePath);
            issues.push(`${id}.db was restored from an interrupted write backup`);
        }
        return issues;
    }

    quarantineDatabase(databasePath) {
        const resolved = path.resolve(databasePath);
        const relative = path.relative(this.cacheRoot, resolved);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new CacheStorageError('Damaged DB path escaped cache root');
        }
        const token = crypto.randomBytes(8).toString('hex');
        const quarantinePath = path.join(
            this.cacheRoot,
            `.${path.basename(databasePath, DATABASE_EXTENSION)}.corrupt-${Date.now()}-${token}${DATABASE_EXTENSION}`
        );
        try {
            fs.renameSync(resolved, quarantinePath);
            return quarantinePath;
        } catch {
            return null;
        }
    }

    ensureRoot() {
        fs.mkdirSync(this.cacheRoot, { recursive: true });
    }

    assertSafeId(normalizedId) {
        const safeId = String(normalizedId || '').trim().toUpperCase();
        if (!SAFE_ID_PATTERN.test(safeId)) {
            throw new CacheStorageError(`Invalid cache ID: ${normalizedId}`);
        }
        return safeId;
    }

    getDatabasePath(normalizedId) {
        const safeId = this.assertSafeId(normalizedId);
        const databasePath = path.resolve(this.cacheRoot, `${safeId}${DATABASE_EXTENSION}`);
        const relative = path.relative(this.cacheRoot, databasePath);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new CacheStorageError('Resolved DB path escaped cache root');
        }
        return databasePath;
    }

    requireServerSecret() {
        if (!this.serverSecret) {
            throw new CacheStorageError('Server secret is required');
        }
        return this.serverSecret;
    }

    readAdminPublicConfig() {
        if (!fs.existsSync(this.adminPublicConfigPath)) {
            throw new CacheStorageError(
                `Administrator public-key configuration is missing: ${this.adminPublicConfigPath}`
            );
        }
        return decodeAdminPublicConfig(fs.readFileSync(this.adminPublicConfigPath));
    }

    listDatabaseIds() {
        this.ensureRoot();
        return fs.readdirSync(this.cacheRoot, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.endsWith(DATABASE_EXTENSION))
            .map((entry) => entry.name.slice(0, -DATABASE_EXTENSION.length))
            .filter((id) => SAFE_ID_PATTERN.test(id));
    }

    async createInnerSqlite(normalizedId, password, cacheEntry) {
        const SQL = await SQL_PROMISE;
        const database = new SQL.Database();
        const passwordHash = hashPassword(password);
        try {
            database.run(`
                CREATE TABLE cache_record (
                    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                    identity TEXT NOT NULL,
                    credential_hash BLOB NOT NULL,
                    credential_secret TEXT NOT NULL,
                    campus BLOB NOT NULL,
                    courses BLOB NOT NULL,
                    tasks BLOB NOT NULL,
                    attendance BLOB NOT NULL,
                    cached_at TEXT,
                    last_errors BLOB NOT NULL,
                    attendance_debug BLOB NOT NULL,
                    grades BLOB NOT NULL
                );
            `);
            database.run(`
                INSERT INTO cache_record (
                    singleton,
                    identity,
                    credential_hash,
                    credential_secret,
                    campus,
                    courses,
                    tasks,
                    attendance,
                    cached_at,
                    last_errors,
                    attendance_debug,
                    grades
                ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                normalizedId,
                new Uint8Array(passwordHash),
                String(password),
                serializeValue(cacheEntry.campus),
                serializeValue(cacheEntry.courses),
                serializeValue(cacheEntry.tasks),
                serializeValue(
                    Array.isArray(cacheEntry.attendance) ? cacheEntry.attendance : []
                ),
                cacheEntry.cachedAt || null,
                serializeValue(cacheEntry.lastErrors),
                serializeValue(cacheEntry.attendanceDebug || null),
                serializeValue(
                    cacheEntry.grades && Array.isArray(cacheEntry.grades.records)
                        ? cacheEntry.grades
                        : { scope: '', records: [] }
                )
            ]);
            return Buffer.from(database.export());
        } finally {
            passwordHash.fill(0);
            database.close();
        }
    }

    async parseInnerSqlite(sqliteBytes, normalizedId, password) {
        const SQL = await SQL_PROMISE;
        let database;
        try {
            database = new SQL.Database(new Uint8Array(sqliteBytes));
            const integrityResult = database.exec('PRAGMA integrity_check');
            const integrityValue = integrityResult[0] &&
                integrityResult[0].values &&
                integrityResult[0].values[0] &&
                integrityResult[0].values[0][0];
            if (integrityValue !== 'ok') {
                throw new CacheIntegrityError('SQLite integrity check failed');
            }

            const schema = database.exec('PRAGMA table_info(cache_record)');
            const columnNames = new Set(
                (schema[0] && schema[0].values || []).map((column) => column[1])
            );
            const hasCredentialSecret = columnNames.has('credential_secret');
            const hasGrades = columnNames.has('grades');
            const result = database.exec(`
                SELECT
                    identity,
                    credential_hash,
                    ${hasCredentialSecret ? 'credential_secret,' : ''}
                    campus,
                    courses,
                    tasks,
                    attendance,
                    cached_at,
                    last_errors,
                    attendance_debug,
                    ${hasGrades ? 'grades' : 'NULL AS grades'}
                FROM cache_record
                WHERE singleton = 1
            `);
            if (!result[0] || result[0].values.length !== 1) {
                throw new CacheIntegrityError('Encrypted SQLite cache row is missing');
            }
            const row = result[0].values[0];
            if (row[0] !== normalizedId) {
                throw new CacheIntegrityError('DB identity does not match its file name');
            }

            const storedPasswordHash = Buffer.from(row[1]);
            const valueOffset = hasCredentialSecret ? 1 : 0;
            const storedPassword = hasCredentialSecret ? String(row[2]) : password;
            if (password !== undefined) {
                const suppliedPasswordHash = hashPassword(password);
                try {
                    if (!timingSafeBufferEqual(storedPasswordHash, suppliedPasswordHash)) {
                        throw new InvalidCredentialsError();
                    }
                    if (hasCredentialSecret) {
                        const storedSecretHash = hashPassword(storedPassword);
                        try {
                            if (!timingSafeBufferEqual(
                                storedSecretHash,
                                suppliedPasswordHash
                            )) {
                                throw new CacheIntegrityError(
                                    'Stored credential does not match its hash'
                                );
                            }
                        } finally {
                            storedSecretHash.fill(0);
                        }
                    }
                } finally {
                    suppliedPasswordHash.fill(0);
                }
            }

            return normalizePersistedCache({
                pwHash: storedPasswordHash.toString('hex'),
                campus: deserializeValue(row[2 + valueOffset]),
                courses: deserializeValue(row[3 + valueOffset]),
                tasks: deserializeValue(row[4 + valueOffset]),
                attendance: deserializeValue(row[5 + valueOffset]),
                cachedAt: row[6 + valueOffset],
                lastErrors: deserializeValue(row[7 + valueOffset]),
                attendanceDebug: deserializeValue(row[8 + valueOffset]),
                grades: hasGrades
                    ? deserializeValue(row[9 + valueOffset])
                    : { scope: '', records: [] }
            }, storedPassword);
        } catch (error) {
            if (
                error instanceof InvalidCredentialsError ||
                error instanceof CacheIntegrityError
            ) {
                throw error;
            }
            throw new CacheIntegrityError('Decrypted SQLite database is invalid', {
                cause: error
            });
        } finally {
            if (database) database.close();
        }
    }
    wrapDataKeyForAdmin(dataKey, normalizedId, adminConfig) {
        const ephemeral = crypto.createECDH('prime256v1');
        ephemeral.generateKeys();
        const sharedSecret = ephemeral.computeSecret(adminConfig.publicKey);
        const hkdfSalt = crypto.randomBytes(SALT_BYTES);
        const wrappingKey = Buffer.from(crypto.hkdfSync(
            'sha256',
            sharedSecret,
            hkdfSalt,
            envelopeAad(normalizedId, 'admin-kek', OUTER_FORMAT_VERSION),
            32
        ));
        try {
            return {
                ephemeralPublicKey: ephemeral.getPublicKey(undefined, 'uncompressed'),
                hkdfSalt,
                wrappedKey: encryptAesGcm(
                    wrappingKey,
                    dataKey,
                    envelopeAad(normalizedId, 'admin-wrap', OUTER_FORMAT_VERSION)
                )
            };
        } finally {
            sharedSecret.fill(0);
            wrappingKey.fill(0);
        }
    }

    unwrapDataKeyWithAdmin(envelope, normalizedId, adminSecret) {
        const { ecdh, privateMaterial } = deriveValidP256KeyPair(
            adminSecret,
            envelope.adminDerivationSalt
        );
        let sharedSecret;
        let wrappingKey;
        try {
            sharedSecret = ecdh.computeSecret(envelope.adminEphemeralPublicKey);
            wrappingKey = Buffer.from(crypto.hkdfSync(
                'sha256',
                sharedSecret,
                envelope.adminHkdfSalt,
                envelopeAad(normalizedId, 'admin-kek', envelope.formatVersion),
                32
            ));
            return decryptAesGcm(
                wrappingKey,
                envelope.adminWrappedKey.nonce,
                envelope.adminWrappedKey.authTag,
                envelope.adminWrappedKey.ciphertext,
                envelopeAad(normalizedId, 'admin-wrap', envelope.formatVersion)
            );
        } catch (error) {
            throw new AdminKeyError(undefined, { cause: error });
        } finally {
            privateMaterial.fill(0);
            if (sharedSecret) sharedSecret.fill(0);
            if (wrappingKey) wrappingKey.fill(0);
        }
    }

    async unwrapDataKeyWithUser(envelope, normalizedId, password) {
        if (envelope.formatVersion !== OUTER_FORMAT_VERSION) {
            throw new CacheStorageError('Encrypted DB migration is required');
        }
        const wrappingKey = await deriveUserWrappingKey(
            normalizedId,
            password,
            envelope.userSalt,
            this.requireServerSecret()
        );
        try {
            return decryptAesGcm(
                wrappingKey,
                envelope.userWrappedKey.nonce,
                envelope.userWrappedKey.authTag,
                envelope.userWrappedKey.ciphertext,
                envelopeAad(normalizedId, 'user-wrap', envelope.formatVersion)
            );
        } catch (error) {
            throw new InvalidCredentialsError(undefined, { cause: error });
        } finally {
            wrappingKey.fill(0);
        }
    }

    decryptSqliteWithDataKey(envelope, normalizedId, dataKey) {
        try {
            return decryptAesGcm(
                dataKey,
                envelope.data.nonce,
                envelope.data.authTag,
                envelope.data.ciphertext,
                envelopeAad(normalizedId, 'sqlite-image', envelope.formatVersion)
            );
        } catch (error) {
            throw new CacheIntegrityError('Encrypted SQLite image authentication failed', {
                cause: error
            });
        }
    }

    readEnvelope(normalizedId) {
        const databasePath = this.getDatabasePath(normalizedId);
        if (!fs.existsSync(databasePath)) return null;
        return decodeEnvelope(fs.readFileSync(databasePath), databasePath);
    }

    async loadWithUserCredentials(normalizedId, password) {
        const safeId = this.assertSafeId(normalizedId);
        const envelope = this.readEnvelope(safeId);
        if (!envelope) return null;

        const dataKey = await this.unwrapDataKeyWithUser(envelope, safeId, password);
        let sqliteBytes;
        try {
            sqliteBytes = this.decryptSqliteWithDataKey(envelope, safeId, dataKey);
            return await this.parseInnerSqlite(sqliteBytes, safeId, password);
        } finally {
            dataKey.fill(0);
            if (sqliteBytes) sqliteBytes.fill(0);
        }
    }

    async loadWithAdminKey(normalizedId, adminSecret) {
        assertSecret(adminSecret, 'Administrator decryption key', 12);
        const safeId = this.assertSafeId(normalizedId);
        const envelope = this.readEnvelope(safeId);
        if (!envelope) return null;

        const dataKey = this.unwrapDataKeyWithAdmin(envelope, safeId, adminSecret);
        let sqliteBytes;
        try {
            sqliteBytes = this.decryptSqliteWithDataKey(envelope, safeId, dataKey);
            return await this.parseInnerSqlite(sqliteBytes, safeId, undefined);
        } finally {
            dataKey.fill(0);
            if (sqliteBytes) sqliteBytes.fill(0);
        }
    }

    async exportSqliteWithAdminKey(normalizedId, adminSecret) {
        assertSecret(adminSecret, 'Administrator decryption key', 12);
        const safeId = this.assertSafeId(normalizedId);
        const envelope = this.readEnvelope(safeId);
        if (!envelope) return null;

        const dataKey = this.unwrapDataKeyWithAdmin(envelope, safeId, adminSecret);
        try {
            const sqliteBytes = this.decryptSqliteWithDataKey(envelope, safeId, dataKey);
            await this.parseInnerSqlite(sqliteBytes, safeId, undefined);
            return sqliteBytes;
        } finally {
            dataKey.fill(0);
        }
    }

    async buildEncryptedDatabase(normalizedId, password, cacheEntry) {
        const safeId = this.assertSafeId(normalizedId);
        const adminConfig = this.readAdminPublicConfig();
        const sqliteBytes = await this.createInnerSqlite(safeId, password, cacheEntry);
        const dataKey = crypto.randomBytes(DATA_KEY_BYTES);
        const userSalt = crypto.randomBytes(SALT_BYTES);
        const userWrappingKey = await deriveUserWrappingKey(
            safeId,
            password,
            userSalt,
            this.requireServerSecret()
        );

        try {
            const admin = this.wrapDataKeyForAdmin(dataKey, safeId, adminConfig);
            const userWrappedKey = encryptAesGcm(
                userWrappingKey,
                dataKey,
                envelopeAad(safeId, 'user-wrap', OUTER_FORMAT_VERSION)
            );
            const data = encryptAesGcm(
                dataKey,
                sqliteBytes,
                envelopeAad(safeId, 'sqlite-image', OUTER_FORMAT_VERSION)
            );
            return encodeEnvelope({
                adminDerivationSalt: adminConfig.derivationSalt,
                adminEphemeralPublicKey: admin.ephemeralPublicKey,
                adminHkdfSalt: admin.hkdfSalt,
                adminWrappedKey: admin.wrappedKey,
                userSalt,
                userWrappedKey,
                data
            });
        } finally {
            sqliteBytes.fill(0);
            dataKey.fill(0);
            userWrappingKey.fill(0);
        }
    }

    writeAtomically(normalizedId, encryptedBytes) {
        this.ensureRoot();
        const databasePath = this.getDatabasePath(normalizedId);
        const token = crypto.randomBytes(12).toString('hex');
        const temporaryPath = path.join(this.cacheRoot, `.${normalizedId}.${token}.tmp`);
        const backupPath = path.join(this.cacheRoot, `.${normalizedId}.${token}.bak`);
        let descriptor;

        try {
            descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
            fs.writeFileSync(descriptor, encryptedBytes);
            fs.fsyncSync(descriptor);
            fs.closeSync(descriptor);
            descriptor = undefined;

            try {
                fs.renameSync(temporaryPath, databasePath);
            } catch (renameError) {
                if (!fs.existsSync(databasePath)) throw renameError;
                fs.renameSync(databasePath, backupPath);
                try {
                    fs.renameSync(temporaryPath, databasePath);
                    fs.unlinkSync(backupPath);
                } catch (replacementError) {
                    if (fs.existsSync(backupPath) && !fs.existsSync(databasePath)) {
                        fs.renameSync(backupPath, databasePath);
                    }
                    throw replacementError;
                }
            }
        } finally {
            if (descriptor !== undefined) fs.closeSync(descriptor);
            if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
        }
    }

    async reencryptAllWithAdminKey(adminSecret) {
        assertSecret(adminSecret, 'Administrator decryption key', 12);
        this.requireServerSecret();
        const migrated = [];
        for (const id of this.listDatabaseIds()) {
            const cacheEntry = await this.loadWithAdminKey(id, adminSecret);
            if (!cacheEntry || typeof cacheEntry.pw !== 'string') {
                throw new CacheStorageError(`Stored password is missing for ${id}`);
            }
            const encryptedBytes = await this.buildEncryptedDatabase(
                id,
                cacheEntry.pw,
                cacheEntry
            );
            this.writeAtomically(id, encryptedBytes);
            migrated.push(id);
        }
        return migrated;
    }

    async saveWithUserCredentials(normalizedId, password, cacheEntry) {
        const safeId = this.assertSafeId(normalizedId);
        assertSecret(password, 'Password');
        const previous = this.writeLocks.get(safeId) || Promise.resolve();
        const operation = previous.catch(() => undefined).then(async () => {
            const encryptedBytes = await this.buildEncryptedDatabase(
                safeId,
                password,
                cacheEntry
            );
            this.writeAtomically(safeId, encryptedBytes);
        });
        this.writeLocks.set(safeId, operation);

        try {
            await operation;
        } finally {
            if (this.writeLocks.get(safeId) === operation) {
                this.writeLocks.delete(safeId);
            }
        }
    }
}

const createDualKeyCacheStore = (options) => new DualKeyCacheStore(options);

module.exports = {
    ADMIN_KEY_ENV,
    SERVER_SECRET_ENV,
    AdminKeyError,
    CacheIntegrityError,
    CacheStorageError,
    InvalidCredentialsError,
    OUTER_FORMAT_VERSION,
    createDualKeyCacheStore,
    decodeAdminPublicConfig,
    decodeEnvelope,
    decodeServerSecret,
    encodeAdminPublicConfig,
    verifyAdminSecretForConfig,
    writeAdminPublicConfig
};
