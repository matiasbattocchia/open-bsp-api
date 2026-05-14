import { WakitAPI } from '../lib/api.js';

interface AccountHealth {
  phone: string;
  name: string;
  address: string;
  status: string;
  quality?: string;
  messaging_limit?: string;
  error?: string;
}

export async function healthCommand(options: { json?: boolean }): Promise<void> {
  const api = WakitAPI.fromConfig();

  try {
    const result = await api.getHealth() as { accounts: AccountHealth[] };

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log('\n  wakit health\n');

    if (result.accounts.length === 0) {
      console.log('  No accounts connected.\n');
      return;
    }

    for (const a of result.accounts) {
      const statusIcon = a.status === 'active' ? '✓' : '✗';
      const statusColor = a.status === 'active' ? '' : ' ← CHECK TOKEN';

      console.log(`  ${statusIcon} ${a.name} (${a.phone})`);

      if (a.status === 'active') {
        console.log(`    Quality: ${a.quality}  |  Messaging limit: ${a.messaging_limit}`);
      } else {
        console.log(`    Error: ${a.error}${statusColor}`);
      }
      console.log('');
    }
  } catch (err) {
    console.error(`\n  Error: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
