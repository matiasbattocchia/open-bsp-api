import { getConfig, getAccountDisplay } from '../lib/config.js';
import { WakitAPI } from '../lib/api.js';

export async function statusCommand(): Promise<void> {
  const config = getConfig();
  if (!config) {
    console.error('\n  Not configured. Run: wakit init\n');
    process.exit(1);
  }

  console.log(`\n  wakit status\n`);
  console.log(`  Base URL:  ${config.base_url}`);
  console.log(`  Account:   ${getAccountDisplay(config)}`);
  console.log(`  API Key:   ${config.api_key.slice(0, 8)}...${config.api_key.slice(-4)}`);

  try {
    const api = WakitAPI.fromConfig();
    const { accounts } = await api.getAccounts();
    console.log(`  Connected: ${accounts.length} number${accounts.length !== 1 ? 's' : ''}`);

    for (const a of accounts) {
      const isDefault = a.phone === config.default_account ? ' (default)' : '';
      console.log(`    • ${a.name} (${a.phone})${isDefault}`);
    }
    console.log('');
  } catch (err) {
    console.error(`\n  Connection error: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
