"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.healthCommand = healthCommand;
const api_js_1 = require("../lib/api.js");
async function healthCommand(options) {
    const api = api_js_1.WakitAPI.fromConfig();
    try {
        const result = await api.getHealth();
        if (options.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
        }
        console.log('\n  wakit health\n');
        if (result.accounts.length === 0) {
            console.log('  No accounts connected.\n');
            return;
        }
        for (const a of result.accounts) {
            const statusIcon = a.status === 'active' ? '✓' : '✗';
            const statusColor = a.status === 'active' ? '' : ' ← CHECK TOKEN';
            console.log(`  ${statusIcon} ${a.name} (${a.phone})`);
            if (a.status === 'active') {
                console.log(`    Quality: ${a.quality}  |  Messaging limit: ${a.messaging_limit}`);
            }
            else {
                console.log(`    Error: ${a.error}${statusColor}`);
            }
            console.log('');
        }
    }
    catch (err) {
        console.error(`\n  Error: ${err.message}\n`);
        process.exit(1);
    }
}
