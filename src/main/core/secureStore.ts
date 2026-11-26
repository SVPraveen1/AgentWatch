import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from './settingsStore';

export interface EncryptionBackend {
  isAvailable(): boolean;
  encrypt(plain: string): string;
  decrypt(encoded: string): string;
}

function getElectronEncryptionBackend(): EncryptionBackend {
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
    const electronMod = require('electron') as {
      app?: { isReady(): boolean };
      safeStorage?: {
        isEncryptionAvailable(): boolean;
        encryptString(v: string): Buffer;
        decryptString(b: Buffer): string;
      };
    };
    return {
      isAvailable: () =>
        Boolean(electronMod.app?.isReady() && electronMod.safeStorage?.isEncryptionAvailable()),
      encrypt: (plain) => electronMod.safeStorage!.encryptString(plain).toString('base64'),
      decrypt: (encoded) =>
        electronMod.safeStorage!.decryptString(Buffer.from(encoded, 'base64')),
    };
  } catch {
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
export class SecureSecretStore {
  private readonly filePath: string;
  private readonly backend: EncryptionBackend;

  constructor(dataDir: string, backend?: EncryptionBackend) {
    this.filePath = path.join(dataDir, 'secrets.json');
    this.backend = backend ?? getElectronEncryptionBackend();
  }

  setSecret(key: string, value: string): void {
    const bag = this.readBag();
    if (this.backend.isAvailable()) {
      bag[key] = { encrypted: true, value: this.backend.encrypt(value) };
    } else {
      bag[key] = { encrypted: false, value };
    }
    atomicWriteFileSync(this.filePath, JSON.stringify(bag, null, 2) + '\n');
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      // No-op on Windows.
    }
  }

  getSecret(key: string): string | null {
    const bag = this.readBag();
    const entry = bag[key];
    if (!entry) return null;
    if (!entry.encrypted) return entry.value;
    if (!this.backend.isAvailable()) {
      return null;
    }
    try {
      return this.backend.decrypt(entry.value);
    } catch {
      return null;
    }
  }

  private readBag(): Record<string, { encrypted: boolean; value: string }> {
    try {
      if (!fs.existsSync(this.filePath)) return {};
      return JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Record<
        string,
        { encrypted: boolean; value: string }
      >;
    } catch {
      return {};
    }
  }
}
