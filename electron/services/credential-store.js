const Store = require('electron-store');
const { safeStorage } = require('electron');
const { randomUUID } = require('crypto');

/**
 * Persists connection profiles (access key / secret) encrypted at rest using
 * Electron's OS-level safeStorage (DPAPI on Windows, Keychain on macOS,
 * libsecret on Linux). Only the encrypted blob touches disk.
 */
class CredentialStore {
  constructor() {
    this.store = new Store({ name: 'flash-s3-connections' });
  }

  _encrypt(plainText) {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.encryptString(plainText).toString('base64');
    }
    // Fallback (encryption unavailable on this OS/session) - base64 obfuscation only.
    return Buffer.from(plainText, 'utf8').toString('base64');
  }

  _decrypt(cipherText) {
    if (!cipherText) return '';
    try {
      if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(Buffer.from(cipherText, 'base64'));
      }
      return Buffer.from(cipherText, 'base64').toString('utf8');
    } catch (e) {
      return '';
    }
  }

  list() {
    const raw = this.store.get('profiles', []);
    return raw.map((p) => ({
      id: p.id,
      name: p.name,
      region: p.region,
      accessKeyId: p.accessKeyId,
      // Never send the decrypted secret back to the renderer for listing.
      hasSecret: !!p.secretAccessKeyEnc,
      createdAt: p.createdAt
    }));
  }

  getFull(id) {
    const raw = this.store.get('profiles', []);
    const p = raw.find((x) => x.id === id);
    if (!p) return null;
    return {
      id: p.id,
      name: p.name,
      region: p.region,
      accessKeyId: p.accessKeyId,
      secretAccessKey: this._decrypt(p.secretAccessKeyEnc)
    };
  }

  save(profile) {
    const raw = this.store.get('profiles', []);
    const id = profile.id || randomUUID();
    const existingIndex = raw.findIndex((x) => x.id === id);

    const record = {
      id,
      name: profile.name,
      region: profile.region || 'us-east-1',
      accessKeyId: profile.accessKeyId,
      secretAccessKeyEnc: profile.secretAccessKey
        ? this._encrypt(profile.secretAccessKey)
        : existingIndex >= 0
          ? raw[existingIndex].secretAccessKeyEnc
          : '',
      createdAt: existingIndex >= 0 ? raw[existingIndex].createdAt : Date.now()
    };

    if (existingIndex >= 0) raw[existingIndex] = record;
    else raw.push(record);

    this.store.set('profiles', raw);
    return { id };
  }

  remove(id) {
    const raw = this.store.get('profiles', []);
    this.store.set('profiles', raw.filter((x) => x.id !== id));
    return { removed: true };
  }
}

module.exports = { CredentialStore };
