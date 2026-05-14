export interface WakitConfig {
    base_url: string;
    api_key: string;
    organization_id: string;
    default_account: string;
    accounts: Array<{
        phone: string;
        name: string;
    }>;
}
export declare function getConfig(): WakitConfig | null;
export declare function saveConfig(config: WakitConfig): void;
export declare function getDefaultAccount(): string;
export declare function getAccountDisplay(config: WakitConfig): string;
