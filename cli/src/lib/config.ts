import fs from 'fs';
import path from 'path';
import os from 'os';

export interface WakitConfig {
  base_url: string;
  api_key: string;
  organization_id: string;
  default_account: string;
  accounts: Array<{ phone: string; name: string }>;
}

const CONFIG_DIR = path.join(os.homedir(), '.wakit');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export function getConfig(): WakitConfig | null {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    return JSON.parse(raw) as WakitConfig;
  } catch {
    return null;
  }
}

export function saveConfig(config: WakitConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
}

export function getDefaultAccount(): string {
  const config = getConfig();
  if (!config) throw new Error('Not configured. Run: wakit init');
  return config.default_account;
}

export function getAccountDisplay(config: WakitConfig): string {
  const account = config.accounts.find(a => a.phone === config.default_account);
  return account ? `${account.name} (${account.phone})` : config.default_account;
}
