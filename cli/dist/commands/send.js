"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendCommand = sendCommand;
const api_js_1 = require("../lib/api.js");
const config_js_1 = require("../lib/config.js");
async function resolvePhone(api, input) {
    if (/^\d{7,}$/.test(input))
        return input;
    const result = await api.searchContacts(input);
    if (result.contacts.length === 0)
        throw new Error(`No contacts found matching "${input}"`);
    if (result.contacts.length === 1) {
        const c = result.contacts[0];
        console.log(`  → ${c.name} (${c.phone})`);
        return c.phone;
    }
    console.log(`\n  Multiple contacts matching "${input}":\n`);
    result.contacts.forEach((c, i) => console.log(`    ${i + 1}. ${c.name}  ${c.phone}`));
    console.log(`\n  Use: wakit send <phone_number> "text"\n`);
    process.exit(1);
}
async function sendCommand(phoneOrName, textOrEmpty, options) {
    const api = api_js_1.WakitAPI.fromConfig();
    const accountPhone = options.from || (0, config_js_1.getDefaultAccount)();
    try {
        const phone = await resolvePhone(api, phoneOrName);
        if (options.template) {
            // Send template
            const variables = options.vars ? options.vars.split(',').map(v => v.trim()) : [];
            const language = options.lang || 'es';
            console.log(`\n  Sending template "${options.template}" to ${phone}...`);
            await api.sendTemplate(phone, options.template, accountPhone, language, variables);
            console.log('  Sent.\n');
        }
        else if (textOrEmpty) {
            // Send text
            console.log(`\n  Sending message to ${phone}...`);
            try {
                await api.sendText(phone, textOrEmpty, accountPhone);
                console.log('  Sent.\n');
            }
            catch (err) {
                const msg = err.message;
                if (msg.includes('Service window is closed')) {
                    console.error(`\n  Service window is closed — the contact hasn't messaged in 24h.`);
                    console.error(`  Send a template instead:\n`);
                    console.error(`    wakit send ${phoneOrName} --template <template_name>`);
                    console.error(`    wakit send ${phoneOrName} --template <name> --vars "var1,var2"`);
                    console.error(`\n  List available templates:\n`);
                    console.error(`    wakit templates\n`);
                    process.exit(1);
                }
                throw err;
            }
        }
        else {
            console.error('\n  Provide a message text or use --template <name>\n');
            console.error('  Examples:');
            console.error('    wakit send 5215551234 "Hola"');
            console.error('    wakit send 5215551234 --template welcome --vars "Juan"\n');
            process.exit(1);
        }
    }
    catch (err) {
        console.error(`\n  Error: ${err.message}\n`);
        process.exit(1);
    }
}
