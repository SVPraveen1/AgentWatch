"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SecureSecretStore = void 0;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const settingsStore_1 = require("./settingsStore");
function getElectronEncryptionBackend() {
    if (!process.versions.electron) {
        return {
            isAvailable: () => false,
            encrypt: (p) => p,
            decrypt: (e) => e,
        };
    }
    try {
        // Load Electron lazily only when running inside the Electron runtime so Node/Vitest tests stay decoupled.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const electronMod = require('electron');
        return {
            isAvailable: () => Boolean(electronMod.app?.isReady() && electronMod.safeStorage?.isEncryptionAvailable()),
            encrypt: (plain) => electronMod.safeStorage.encryptString(plain).toString('base64'),
            decrypt: (encoded) => electronMod.safeStorage.decryptString(Buffer.from(encoded, 'base64')),
        };
    }
    catch {
        return {
            isAvailable: () => false,
            encrypt: (p) => p,
            decrypt: (e) => e,
        };
    }
}
/**
 * Stores sensitive per-install data (e.g. local auth secret or optional encrypted metadata)
 * using OS-backed DPAPI on Windows (via Electron safeStorage) and Keychain/secret-service elsewhere.
 */
class SecureSecretStore {
    filePath;
    backend;
    constructor(dataDir, backend) {
        this.filePath = node_path_1.default.join(dataDir, 'secrets.json');
        this.backend = backend ?? getElectronEncryptionBackend();
    }
    setSecret(key, value) {
        const bag = this.readBag();
        if (this.backend.isAvailable()) {
            bag[key] = { encrypted: true, value: this.backend.encrypt(value) };
        }
        else {
            bag[key] = { encrypted: false, value };
        }
        (0, settingsStore_1.atomicWriteFileSync)(this.filePath, JSON.stringify(bag, null, 2) + '\n');
        try {
            node_fs_1.default.chmodSync(this.filePath, 0o600);
        }
        catch {
            // No-op on Windows.
        }
    }
    getSecret(key) {
        const bag = this.readBag();
        const entry = bag[key];
        if (!entry)
            return null;
        if (!entry.encrypted)
            return entry.value;
        if (!this.backend.isAvailable()) {
            return null;
        }
        try {
            return this.backend.decrypt(entry.value);
        }
        catch {
            return null;
        }
    }
    readBag() {
        try {
            if (!node_fs_1.default.existsSync(this.filePath))
                return {};
            return JSON.parse(node_fs_1.default.readFileSync(this.filePath, 'utf8'));
        }
        catch {
            return {};
        }
    }
}
exports.SecureSecretStore = SecureSecretStore;
