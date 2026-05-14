"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.templatesCommand = templatesCommand;
const api_js_1 = require("../lib/api.js");
const config_js_1 = require("../lib/config.js");
async function templatesCommand(options) {
    const api = api_js_1.WakitAPI.fromConfig();
    const accountPhone = options.from || (0, config_js_1.getDefaultAccount)();
    try {
        const result = await api.getTemplates(accountPhone);
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
    }
    catch (err) {
        console.error(`\n  Error: ${err.message}\n`);
        process.exit(1);
    }
}
