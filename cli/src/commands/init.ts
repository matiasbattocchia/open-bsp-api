import { createInterface } from 'readline';
import { WakitAPI } from '../lib/api.js';
import { saveConfig } from '../lib/config.js';

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function initCommand(): Promise<void> {
  console.log('\n  wakit init\n');

  const baseUrl = await prompt('  Base URL (https://api.wakit.ai): ') || 'https://api.wakit.ai';
  const apiKey = await prompt('  API Key (sk_...): ');

  if (!apiKey) {
    console.error('\n  API key is required. Create one at Settings > API Keys in the dashboard.\n');
    process.exit(1);
  }

  console.log('\n  Connecting...');

  try {
    const api = new WakitAPI(baseUrl, apiKey);
    const { accounts } = await api.getAccounts();

    if (accounts.length === 0) {
      console.error('  No WhatsApp accounts found. Connect a number in the dashboard first.\n');
      process.exit(1);
    }

    let defaultAccount: string;

    if (accounts.length === 1) {
      defaultAccount = accounts[0].phone;
      console.log(`  Found 1 account: ${accounts[0].name} (${accounts[0].phone})`);
    } else {
      console.log(`\n  Found ${accounts.length} accounts:\n`);
      accounts.forEach((a, i) => {
        console.log(`    ${i + 1}. ${a.name} (${a.phone})`);
      });

      const choice = await prompt(`\n  Select default account (1-${accounts.length}): `);
      const index = parseInt(choice, 10) - 1;

      if (isNaN(index) || index < 0 || index >= accounts.length) {
        console.error('  Invalid selection.\n');
        process.exit(1);
      }

      defaultAccount = accounts[index].phone;
    }

    saveConfig({
      base_url: baseUrl,
      api_key: apiKey,
      organization_id: '',
      default_account: defaultAccount,
      accounts,
    });

    const selected = accounts.find(a => a.phone === defaultAccount)!;
    console.log(`\n  Configured! Default account: ${selected.name} (${selected.phone})`);
    console.log('  Config saved to ~/.wakit/config.json\n');
  } catch (err) {
    console.error(`\n  Error: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
