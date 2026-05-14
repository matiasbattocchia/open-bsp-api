"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WakitAPI = void 0;
const config_js_1 = require("./config.js");
class WakitAPI {
    baseUrl;
    apiKey;
    constructor(baseUrl, apiKey) {
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this.apiKey = apiKey;
    }
    static fromConfig() {
        const config = (0, config_js_1.getConfig)();
        if (!config) {
            throw new Error('Not configured. Run: wakit init');
        }
        return new WakitAPI(config.base_url, config.api_key);
    }
    async request(method, path, body) {
        const url = `${this.baseUrl}/functions/v1/api${path}`;
        const res = await fetch(url, {
            method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`,
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        const data = await res.json();
        if (!res.ok) {
            throw new Error(data.error || `API error: ${res.status}`);
        }
        return data;
    }
    async getAccounts() {
        return this.request('GET', '/accounts');
    }
    async getConversations(accountPhone, limit = 10) {
        return this.request('GET', `/conversations?account_phone=${accountPhone}&limit=${limit}`);
    }
    async getConversation(contactPhone, accountPhone, limit = 50) {
        return this.request('GET', `/conversation?contact_phone=${contactPhone}&account_phone=${accountPhone}&limit=${limit}`);
    }
    async sendText(contactPhone, text, accountPhone) {
        return this.request('POST', '/messages', {
            contact_phone: contactPhone,
            text,
            account_phone: accountPhone,
        });
    }
    async sendTemplate(contactPhone, templateName, accountPhone, language = 'es', variables = []) {
        // Fetch template to check for named parameters
        const templates = await this.getTemplates(accountPhone);
        const tmpl = templates.templates.find(t => t.name === templateName && t.language === language);
        let templateId;
        if (tmpl) {
            templateId = tmpl.id;
        }
        // Get template details to check for named params
        let namedParams = [];
        if (templateId) {
            const details = await this.getTemplate(templateId, accountPhone);
            const bodyComponent = details.components?.find(c => c.type === 'BODY');
            namedParams = bodyComponent?.example?.body_text_named_params || [];
        }
        const components = [];
        if (variables.length > 0) {
            const parameters = variables.map((v, i) => {
                const param = { type: 'text', text: v };
                if (namedParams[i]) {
                    param.parameter_name = namedParams[i].param_name;
                }
                return param;
            });
            components.push({ type: 'body', parameters });
        }
        return this.request('POST', '/messages', {
            contact_phone: contactPhone,
            template: {
                name: templateName,
                language: { code: language },
                components,
            },
            account_phone: accountPhone,
        });
    }
    async searchContacts(query, accountPhone, limit = 10) {
        const params = new URLSearchParams({ limit: String(limit) });
        if (query) {
            const isNumber = /^\d+$/.test(query);
            if (isNumber)
                params.set('number', query);
            else
                params.set('name', query);
        }
        return this.request('GET', `/contacts?${params}`);
    }
    async getHealth() {
        return this.request('GET', '/health');
    }
    async getTemplates(accountPhone) {
        return this.request('GET', `/templates?account_phone=${accountPhone}`);
    }
    async getTemplate(templateId, accountPhone) {
        return this.request('GET', `/templates?template_id=${templateId}&account_phone=${accountPhone}`);
    }
}
exports.WakitAPI = WakitAPI;
