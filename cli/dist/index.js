#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const commander_1 = require("commander");
const init_js_1 = require("./commands/init.js");
const send_js_1 = require("./commands/send.js");
const conversations_js_1 = require("./commands/conversations.js");
const chat_js_1 = require("./commands/chat.js");
const contacts_js_1 = require("./commands/contacts.js");
const templates_js_1 = require("./commands/templates.js");
const switch_js_1 = require("./commands/switch.js");
const status_js_1 = require("./commands/status.js");
const health_js_1 = require("./commands/health.js");
const program = new commander_1.Command();
program
    .name('wakit')
    .description('CLI for wakit — open-source WhatsApp Business API platform')
    .version('0.1.0');
program
    .command('init')
    .description('Configure wakit CLI (API key, default account)')
    .action(init_js_1.initCommand);
program
    .command('status')
    .description('Show connection status and configured accounts')
    .action(status_js_1.statusCommand);
program
    .command('health')
    .description('Check Meta token status for all connected accounts')
    .option('--json', 'Output as JSON')
    .action(health_js_1.healthCommand);
program
    .command('switch <account>')
    .description('Switch default WhatsApp account (by index or phone)')
    .action(switch_js_1.switchCommand);
program
    .command('send <phone> [text]')
    .description('Send a message to a phone number')
    .option('-t, --template <name>', 'Send a template instead of text')
    .option('--vars <values>', 'Template variables (comma-separated)')
    .option('--lang <code>', 'Template language code (default: es)')
    .option('--from <phone>', 'Send from specific account')
    .action(send_js_1.sendCommand);
program
    .command('conversations')
    .alias('convs')
    .description('List recent conversations')
    .option('-l, --limit <n>', 'Max conversations (default: 10)')
    .option('--from <phone>', 'Use specific account')
    .option('--json', 'Output as JSON')
    .action(conversations_js_1.conversationsCommand);
program
    .command('chat <phone>')
    .description('View conversation with a contact')
    .option('-l, --limit <n>', 'Max messages (default: 50)')
    .option('--from <phone>', 'Use specific account')
    .option('--json', 'Output as JSON')
    .action(chat_js_1.chatCommand);
program
    .command('contacts [query]')
    .description('List or search contacts')
    .option('-l, --limit <n>', 'Max results (default: 10)')
    .option('--json', 'Output as JSON')
    .action(contacts_js_1.contactsCommand);
program
    .command('templates')
    .description('List WhatsApp message templates')
    .option('--from <phone>', 'Use specific account')
    .option('--json', 'Output as JSON')
    .action(templates_js_1.templatesCommand);
program.parse();
