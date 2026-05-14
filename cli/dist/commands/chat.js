"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.chatCommand = chatCommand;
const api_js_1 = require("../lib/api.js");
const config_js_1 = require("../lib/config.js");
async function resolvePhone(api, input) {
    // If it looks like a phone number, use it directly
    if (/^\d{7,}$/.test(input))
        return input;
    // Otherwise search by name
    const result = await api.searchContacts(input);
    if (result.contacts.length === 0) {
        throw new Error(`No contacts found matching "${input}"`);
    }
    if (result.contacts.length === 1) {
        const c = result.contacts[0];
        console.log(`  → ${c.name} (${c.phone})\n`);
        return c.phone;
    }
    // Multiple matches — show options
    console.log(`\n  Multiple contacts matching "${input}":\n`);
    result.contacts.forEach((c, i) => {
        console.log(`    ${i + 1}. ${c.name}  ${c.phone}`);
    });
    console.log(`\n  Use: wakit chat <phone_number>\n`);
    process.exit(1);
}
async function chatCommand(phoneOrName, options) {
    const api = api_js_1.WakitAPI.fromConfig();
    const accountPhone = options.from || (0, config_js_1.getDefaultAccount)();
    const limit = parseInt(options.limit || '50', 10);
    try {
        const phone = await resolvePhone(api, phoneOrName);
        const result = await api.getConversation(phone, accountPhone, limit);
        if (options.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
        }
        const contactName = result.contact.name || result.contact.phone;
        const windowStatus = result.service_window === 'open' ? 'open' : 'closed';
        console.log(`\n  ${contactName} (${result.contact.phone})`);
        console.log(`  Service window: ${windowStatus}\n`);
        if (result.messages.length === 0) {
            console.log('  No messages.\n');
            return;
        }
        for (const msg of result.messages) {
            const dir = msg.direction === 'incoming' ? '←' : '→';
            const text = msg.content?.text || `[${msg.content?.kind || 'unknown'}]`;
            const status = msg.direction === 'outgoing' ? ` (${msg.status})` : '';
            console.log(`  ${msg.time} ${dir} ${text}${status}`);
        }
        console.log('');
    }
    catch (err) {
        console.error(`\n  Error: ${err.message}\n`);
        process.exit(1);
    }
}
