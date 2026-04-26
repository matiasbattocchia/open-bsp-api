import type {
  OutgoingDocument,
  OutgoingImage,
  OutgoingVideo,
} from "./whatsapp_cloud_outgoing_types.ts";

// TEMPLATE

// Template data, used to create or update a template message

export type TemplateData = {
  id: string;
  name: string;
  status:
  | "APPROVED"
  | "IN_APPEAL"
  | "PENDING"
  | "REJECTED"
  | "PENDING_DELETION"
  | "DELETED"
  | "DISABLED"
  | "PAUSED"
  | "LIMIT_EXCEEDED";
  category: "MARKETING"; // TODO: service and auth categories - cabra 2024/09/12
  language: string;
  components: (
    | BodyComponent
    | HeaderComponent
    | FooterComponent
    | ButtonsComponent
  )[];
  sub_category: "CUSTOM";
};

type HeaderComponent = {
  type: "HEADER";
  text: string;
  format: "TEXT"; // TODO: other formats such as image - cabra 2024/09/12
  example?: {
    header_text: [string];
  };
};

type BodyComponent = {
  type: "BODY";
  text: string;
  example?: {
    body_text: [string[]];
  };
};

type FooterComponent = {
  type: "FOOTER";
  text: string;
};

type ButtonsComponent = {
  type: "BUTTONS";
  buttons: QuickReply[]; // TODO: call to action buttons - cabra 2024/09/12
};

type QuickReply = {
  type: "QUICK_REPLY";
  text: string;
};

// Template message, used to send a template message

type CurrencyParameter = {
  type: "currency";
  currency: {
    fallback_value: string;
    code: string; // ISO 4217
    amount_1000: number;
  };
};

type DateTimeParameter = {
  type: "date_time";
  date_time: {
    fallback_value: string;
    // localization is not attempted by Cloud API, fallback_value is always used
  };
};

type TextParameter = {
  type: "text";
  text: string;
};

type TemplateParameter =
  | CurrencyParameter
  | DateTimeParameter
  | TextParameter
  | OutgoingImage
  | OutgoingVideo
  | OutgoingDocument;

type TemplateHeader = {
  type: "header";
  parameters?: TemplateParameter[];
};

type TemplateBody = {
  type: "body";
  parameters?: TemplateParameter[];
};

type TemplateButton =
  & {
    type: "button";
    index: string; // 0-9
  }
  & (
    | {
      sub_type: "quick_reply";
      parameters: {
        type: "payload";
        payload: string;
      }[];
    }
    | {
      sub_type: "url";
      parameters: {
        type: "url";
        text: string;
      }[];
    }
  );

export type Template = {
  components?: (TemplateHeader | TemplateBody | TemplateButton)[];
  language: {
    code: string; // es, es_AR, etc
    policy: "deterministic";
  };
  name: string;
};

export type TemplateMessage = {
  type: "template";
  template: Template;
};

// TODO: InteractiveMessage
