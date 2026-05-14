import { getConfig } from './config.js';

export class WakitAPI {
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  static fromConfig(): WakitAPI {
    const config = getConfig();
    if (!config) {
      throw new Error('Not configured. Run: wakit init');
    }
    return new WakitAPI(config.base_url, config.api_key);
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
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
      throw new Error((data as { error?: string }).error || `API error: ${res.status}`);
    }
    return data;
  }

  async getAccounts(): Promise<{ accounts: Array<{ phone: string; name: string }> }> {
    return this.request('GET', '/accounts') as Promise<{ accounts: Array<{ phone: string; name: string }> }>;
  }

  async getConversations(accountPhone: string, limit = 10): Promise<unknown> {
    return this.request('GET', `/conversations?account_phone=${accountPhone}&limit=${limit}`);
  }

  async getConversation(contactPhone: string, accountPhone: string, limit = 50): Promise<unknown> {
    return this.request('GET', `/conversation?contact_phone=${contactPhone}&account_phone=${accountPhone}&limit=${limit}`);
  }

  async sendText(contactPhone: string, text: string, accountPhone: string): Promise<unknown> {
    return this.request('POST', '/messages', {
      contact_phone: contactPhone,
      text,
      account_phone: accountPhone,
    });
  }

  async sendTemplate(
    contactPhone: string,
    templateName: string,
    accountPhone: string,
    language = 'es',
    variables: string[] = [],
  ): Promise<unknown> {
    // Fetch template to check for named parameters
    const templates = await this.getTemplates(accountPhone) as {
      templates: Array<{ name: string; id: string; language: string }>;
    };
    const tmpl = templates.templates.find(
      t => t.name === templateName && t.language === language,
    );

    let templateId: string | undefined;
    if (tmpl) {
      templateId = tmpl.id;
    }

    // Get template details to check for named params
    let namedParams: Array<{ param_name: string }> = [];
    if (templateId) {
      const details = await this.getTemplate(templateId, accountPhone) as {
        components?: Array<{
          type: string;
          example?: { body_text_named_params?: Array<{ param_name: string }> };
        }>;
      };
      const bodyComponent = details.components?.find(c => c.type === 'BODY');
      namedParams = bodyComponent?.example?.body_text_named_params || [];
    }

    const components: Array<{ type: string; parameters: Array<Record<string, string>> }> = [];
    if (variables.length > 0) {
      const parameters = variables.map((v, i) => {
        const param: Record<string, string> = { type: 'text', text: v };
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

  async searchContacts(query?: string, accountPhone?: string, limit = 10): Promise<unknown> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (query) {
      const isNumber = /^\d+$/.test(query);
      if (isNumber) params.set('number', query);
      else params.set('name', query);
    }
    return this.request('GET', `/contacts?${params}`);
  }

  async getHealth(): Promise<unknown> {
    return this.request('GET', '/health');
  }

  async getTemplates(accountPhone: string): Promise<unknown> {
    return this.request('GET', `/templates?account_phone=${accountPhone}`);
  }

  async getTemplate(templateId: string, accountPhone: string): Promise<unknown> {
    return this.request('GET', `/templates?template_id=${templateId}&account_phone=${accountPhone}`);
  }
}
