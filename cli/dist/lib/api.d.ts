export declare class WakitAPI {
    private baseUrl;
    private apiKey;
    constructor(baseUrl: string, apiKey: string);
    static fromConfig(): WakitAPI;
    private request;
    getAccounts(): Promise<{
        accounts: Array<{
            phone: string;
            name: string;
        }>;
    }>;
    getConversations(accountPhone: string, limit?: number): Promise<unknown>;
    getConversation(contactPhone: string, accountPhone: string, limit?: number): Promise<unknown>;
    sendText(contactPhone: string, text: string, accountPhone: string): Promise<unknown>;
    sendTemplate(contactPhone: string, templateName: string, accountPhone: string, language?: string, variables?: string[]): Promise<unknown>;
    searchContacts(query?: string, accountPhone?: string, limit?: number): Promise<unknown>;
    getHealth(): Promise<unknown>;
    getTemplates(accountPhone: string): Promise<unknown>;
    getTemplate(templateId: string, accountPhone: string): Promise<unknown>;
}
