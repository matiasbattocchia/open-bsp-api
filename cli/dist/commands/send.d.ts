export declare function sendCommand(phoneOrName: string, textOrEmpty: string | undefined, options: {
    template?: string;
    vars?: string;
    lang?: string;
    from?: string;
}): Promise<void>;
