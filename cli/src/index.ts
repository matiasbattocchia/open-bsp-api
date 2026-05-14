#!/usr/bin/env node
import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { sendCommand } from './commands/send.js';
import { conversationsCommand } from './commands/conversations.js';
import { chatCommand } from './commands/chat.js';
import { contactsCommand } from './commands/contacts.js';
import { templatesCommand } from './commands/templates.js';
import { switchCommand } from './commands/switch.js';
import { statusCommand } from './commands/status.js';
import { healthCommand } from './commands/health.js';

const program = new Command();

program
  .name('wakit')
  .description('CLI for wakit — open-source WhatsApp Business API platform')
  .version('0.1.0');

program
  .command('init')
  .description('Configure wakit CLI (API key, default account)')
  .action(initCommand);

program
  .command('status')
  .description('Show connection status and configured accounts')
  .action(statusCommand);

program
  .command('health')
  .description('Check Meta token status for all connected accounts')
  .option('--json', 'Output as JSON')
  .action(healthCommand);

program
  .command('switch <account>')
  .description('Switch default WhatsApp account (by index or phone)')
  .action(switchCommand);

program
  .command('send <phone> [text]')
  .description('Send a message to a phone number')
  .option('-t, --template <name>', 'Send a template instead of text')
  .option('--vars <values>', 'Template variables (comma-separated)')
  .option('--lang <code>', 'Template language code (default: es)')
  .option('--from <phone>', 'Send from specific account')
  .action(sendCommand);

program
  .command('conversations')
  .alias('convs')
  .description('List recent conversations')
  .option('-l, --limit <n>', 'Max conversations (default: 10)')
  .option('--from <phone>', 'Use specific account')
  .option('--json', 'Output as JSON')
  .action(conversationsCommand);

program
  .command('chat <phone>')
  .description('View conversation with a contact')
  .option('-l, --limit <n>', 'Max messages (default: 50)')
  .option('--from <phone>', 'Use specific account')
  .option('--json', 'Output as JSON')
  .action(chatCommand);

program
  .command('contacts [query]')
  .description('List or search contacts')
  .option('-l, --limit <n>', 'Max results (default: 10)')
  .option('--json', 'Output as JSON')
  .action(contactsCommand);

program
  .command('templates')
  .description('List WhatsApp message templates')
  .option('--from <phone>', 'Use specific account')
  .option('--json', 'Output as JSON')
  .action(templatesCommand);

program.parse();
