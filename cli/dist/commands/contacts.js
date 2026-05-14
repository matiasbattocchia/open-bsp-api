"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.contactsCommand = contactsCommand;
const api_js_1 = require("../lib/api.js");
async function contactsCommand(query, options) {
    const api = api_js_1.WakitAPI.fromConfig();
    const limit = parseInt(options.limit || '20', 10);
    try {
        const result = query
            ? await api.searchContacts(query, undefined, limit)
            : await api.searchContacts('', undefined, limit);
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
    }
    catch (err) {
        console.error(`\n  Error: ${err.message}\n`);
        process.exit(1);
    }
}
