'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MANIFEST_NAME = 'latest.json';
const MAX_MANIFEST_BYTES = 64 * 1024;
const APK_NAME_PATTERN = /^SIT-Dash-Android-(\d+\.\d+\.\d+)(?:-[A-Za-z0-9._-]+)?\.apk$/;

class AndroidReleaseError extends Error {}

const sha256File = (filePath) => new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
});

const createAndroidReleaseStore = ({ releaseRoot }) => {
    const root = path.resolve(releaseRoot);
    let cachedRelease = null;

    const loadLatest = async () => {
        const manifestPath = path.join(root, MANIFEST_NAME);
        let manifestStat;
        try {
            manifestStat = await fs.promises.stat(manifestPath);
        } catch (error) {
            if (error && error.code === 'ENOENT') return null;
            throw error;
        }
        if (!manifestStat.isFile() || manifestStat.size < 2 || manifestStat.size > MAX_MANIFEST_BYTES) {
            throw new AndroidReleaseError('Android release manifest is invalid');
        }
        if (
            cachedRelease &&
            cachedRelease.manifestModifiedAt === manifestStat.mtimeMs &&
            cachedRelease.manifestSize === manifestStat.size
        ) {
            try {
                const cachedApkStat = await fs.promises.stat(cachedRelease.filePath);
                if (
                    cachedApkStat.isFile() &&
                    cachedApkStat.size === cachedRelease.size &&
                    cachedApkStat.mtimeMs === cachedRelease.apkModifiedAt
                ) {
                    return cachedRelease;
                }
            } catch (error) {
                if (!error || error.code !== 'ENOENT') throw error;
            }
        }

        let manifest;
        try {
            manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
        } catch {
            throw new AndroidReleaseError('Android release manifest is not valid JSON');
        }
        const versionCode = Number(manifest.versionCode);
        const versionName = String(manifest.versionName || '');
        const fileName = String(manifest.file || '');
        const size = Number(manifest.size);
        const expectedSha256 = String(manifest.sha256 || '').toLowerCase();
        if (
            !Number.isSafeInteger(versionCode) || versionCode < 1 ||
            !/^\d+\.\d+\.\d+$/.test(versionName) ||
            !APK_NAME_PATTERN.test(fileName) ||
            !Number.isSafeInteger(size) || size < 1 ||
            !/^[a-f0-9]{64}$/.test(expectedSha256)
        ) {
            throw new AndroidReleaseError('Android release manifest fields are invalid');
        }
        const nameVersion = fileName.match(APK_NAME_PATTERN)[1];
        if (nameVersion !== versionName) {
            throw new AndroidReleaseError('Android APK filename and version do not match');
        }

        const filePath = path.resolve(root, fileName);
        if (path.dirname(filePath) !== root) {
            throw new AndroidReleaseError('Android APK path is outside the release folder');
        }
        let apkStat;
        try {
            apkStat = await fs.promises.stat(filePath);
        } catch (error) {
            if (error && error.code === 'ENOENT') {
                throw new AndroidReleaseError('Android APK referenced by the manifest was not found');
            }
            throw error;
        }
        if (!apkStat.isFile() || apkStat.size !== size) {
            throw new AndroidReleaseError('Android APK size does not match the manifest');
        }
        const actualSha256 = await sha256File(filePath);
        if (!crypto.timingSafeEqual(Buffer.from(actualSha256, 'hex'), Buffer.from(expectedSha256, 'hex'))) {
            throw new AndroidReleaseError('Android APK checksum does not match the manifest');
        }

        cachedRelease = {
            versionCode,
            versionName,
            fileName,
            filePath,
            size,
            sha256: actualSha256,
            apkModifiedAt: apkStat.mtimeMs,
            manifestModifiedAt: manifestStat.mtimeMs,
            manifestSize: manifestStat.size
        };
        return cachedRelease;
    };

    return { loadLatest };
};

module.exports = {
    AndroidReleaseError,
    createAndroidReleaseStore
};
