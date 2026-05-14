"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.statusCommand = statusCommand;
const config_js_1 = require("../lib/config.js");
const api_js_1 = require("../lib/api.js");
async function statusCommand() {
    const config = (0, config_js_1.getConfig)();
    if (!config) {
        console.error('\n  Not configured. Run: wakit init\n');
        process.exit(1);
    }
    console.log(`\n  wakit status\n`);
    console.log(`  Base URL:  ${config.base_url}`);
    console.log(`  Account:   ${(0, config_js_1.getAccountDisplay)(config)}`);
    console.log(`  API Key:   ${config.api_key.slice(0, 8)}...${config.api_key.slice(-4)}`);
    try {
        const api = api_js_1.WakitAPI.fromConfig();
        const { accounts } = await api.getAccounts();
        console.log(`  Connected: ${accounts.length} number${accounts.length !== 1 ? 's' : ''}`);
        for (const a of accounts) {
            const isDefault = a.phone === config.default_account ? ' (default)' : '';
            console.log(`    • ${a.name} (${a.phone})${isDefault}`);
        }
        console.log('');
    }
    catch (err) {
        console.error(`\n  Connection error: ${err.message}\n`);
        process.exit(1);
    }
}
