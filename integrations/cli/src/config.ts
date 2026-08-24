import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface CloudConfig {
  apiUrl: string;
  instanceId: string;
  instanceToken: string;
  connectedAt: string;
}

export function configDirectory(): string {
  return process.env.GATEKEEPER_CONFIG_DIR || join(homedir(), '.config', 'gatekeeper');
}

export function cloudConfigPath(): string {
  return process.env.GATEKEEPER_CLOUD_CONFIG || join(configDirectory(), 'cloud.json');
}

export function readCloudConfig(): CloudConfig | null {
  if (!existsSync(cloudConfigPath())) return null;
  try {
    const parsed = JSON.parse(readFileSync(cloudConfigPath(), 'utf-8')) as CloudConfig;
    if (!parsed.apiUrl || !parsed.instanceId || !parsed.instanceToken) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeCloudConfig(config: CloudConfig): void {
  const path = cloudConfigPath();
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(config, null, 2), { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

export function removeCloudConfig(): void {
  if (existsSync(cloudConfigPath())) unlinkSync(cloudConfigPath());
}
