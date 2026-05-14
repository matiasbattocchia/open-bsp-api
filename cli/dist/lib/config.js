"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getConfig = getConfig;
exports.saveConfig = saveConfig;
exports.getDefaultAccount = getDefaultAccount;
exports.getAccountDisplay = getAccountDisplay;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const CONFIG_DIR = path_1.default.join(os_1.default.homedir(), '.wakit');
const CONFIG_FILE = path_1.default.join(CONFIG_DIR, 'config.json');
function getConfig() {
    try {
        const raw = fs_1.default.readFileSync(CONFIG_FILE, 'utf-8');
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
function saveConfig(config) {
    fs_1.default.mkdirSync(CONFIG_DIR, { recursive: true });
    fs_1.default.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
}
function getDefaultAccount() {
    const config = getConfig();
    if (!config)
        throw new Error('Not configured. Run: wakit init');
    return config.default_account;
}
function getAccountDisplay(config) {
    const account = config.accounts.find(a => a.phone === config.default_account);
    return account ? `${account.name} (${account.phone})` : config.default_account;
}
