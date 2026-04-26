// System/app/account-level, statuses and history error structure
export type WebhookError = {
  code: number;
  title: string;
  message: string;
  error_data: {
    details: string;
  };
  href: string;
};
