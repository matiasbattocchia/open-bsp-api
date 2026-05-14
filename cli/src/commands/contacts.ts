import { WakitAPI } from '../lib/api.js';

interface Contact {
  name: string;
  phone: string;
}

export async function contactsCommand(
  query: string | undefined,
  options: { limit?: string; json?: boolean },
): Promise<void> {
  const api = WakitAPI.fromConfig();
  const limit = parseInt(options.limit || '20', 10);

  try {
    const result = query
      ? await api.searchContacts(query, undefined, limit) as { contacts: Contact[] }
      : await api.searchContacts('', undefined, limit) as { contacts: Contact[] };

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log('');

    if (result.contacts.length === 0) {
      console.log(query ? `  No contacts matching "${query}".\n` : '  No contacts.\n');
      return;
    }

    for (const c of result.contacts) {
      console.log(`  ${c.name || 'Unknown'}  ${c.phone}`);
    }
    console.log('');
  } catch (err) {
    console.error(`\n  Error: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
