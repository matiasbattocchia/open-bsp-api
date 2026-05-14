import { WakitAPI } from '../lib/api.js';
import { getDefaultAccount } from '../lib/config.js';

interface Conversation {
  contact: { name: string; phone: string };
  unread: number;
  last_message: {
    direction: string;
    content: { text?: string; kind?: string };
    timestamp: string;
    status: string;
  } | null;
}

export async function conversationsCommand(options: { limit?: string; from?: string; json?: boolean }): Promise<void> {
  const api = WakitAPI.fromConfig();
  const accountPhone = options.from || getDefaultAccount();
  const limit = parseInt(options.limit || '10', 10);

  try {
    const result = await api.getConversations(accountPhone, limit) as {
      account: { name: string; phone: string };
      conversations: Conversation[];
    };

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`\n  ${result.account.name} (${result.account.phone})\n`);

    if (result.conversations.length === 0) {
      console.log('  No conversations.\n');
      return;
    }

    for (const conv of result.conversations) {
      const unread = conv.unread > 0 ? ` (${conv.unread} new)` : '';
      const name = conv.contact.name || conv.contact.phone;
      const preview = conv.last_message?.content?.text
        ? conv.last_message.content.text.slice(0, 60) + (conv.last_message.content.text.length > 60 ? '...' : '')
        : conv.last_message?.content?.kind || '';
      const dir = conv.last_message?.direction === 'incoming' ? '←' : '→';
      const time = conv.last_message?.timestamp || '';

      console.log(`  ${name}${unread}`);
      console.log(`    ${dir} ${preview}  ${time}`);
      console.log('');
    }
  } catch (err) {
    console.error(`\n  Error: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
