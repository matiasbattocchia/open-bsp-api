import { WakitAPI } from '../lib/api.js';
import { getDefaultAccount } from '../lib/config.js';

interface Template {
  id: string;
  name: string;
  status: string;
  category: string;
  language: string;
}

export async function templatesCommand(options: { from?: string; json?: boolean }): Promise<void> {
  const api = WakitAPI.fromConfig();
  const accountPhone = options.from || getDefaultAccount();

  try {
    const result = await api.getTemplates(accountPhone) as { templates: Template[] };

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log('');

    if (result.templates.length === 0) {
      console.log('  No templates.\n');
      return;
    }

    // Header
    console.log('  NAME                          STATUS      CATEGORY        LANG');
    console.log('  ' + '─'.repeat(70));

    for (const t of result.templates) {
      const name = t.name.padEnd(30);
      const status = t.status.padEnd(12);
      const category = t.category.padEnd(16);
      console.log(`  ${name}${status}${category}${t.language}`);
    }
    console.log('');
  } catch (err) {
    console.error(`\n  Error: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
