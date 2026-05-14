"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.switchCommand = switchCommand;
const config_js_1 = require("../lib/config.js");
async function switchCommand(indexOrPhone) {
    const config = (0, config_js_1.getConfig)();
    if (!config) {
        console.error('\n  Not configured. Run: wakit init\n');
        process.exit(1);
    }
    // Try as index (1-based)
    const index = parseInt(indexOrPhone, 10);
    let account;
    if (!isNaN(index) && index >= 1 && index <= config.accounts.length) {
        account = config.accounts[index - 1];
    }
    else {
        // Try as phone number
        account = config.accounts.find(a => a.phone === indexOrPhone || a.phone.endsWith(indexOrPhone));
    }
    if (!account) {
        console.error(`\n  Account "${indexOrPhone}" not found. Available:\n`);
        config.accounts.forEach((a, i) => {
            console.error(`    ${i + 1}. ${a.name} (${a.phone})`);
        });
        console.error('');
        process.exit(1);
    }
    config.default_account = account.phone;
    (0, config_js_1.saveConfig)(config);
    console.log(`\n  Switched to: ${account.name} (${account.phone})\n`);
}
