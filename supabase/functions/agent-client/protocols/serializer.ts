import type { Part, ReferralInfo } from "../../_shared/supabase.ts";
import { inspect } from "node:util";

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/**
 * Recursively serializes Parts (including artifacts) as XML.
 * This provides a text representation of structured data and files
 * that can be sent to LLM APIs that don't natively support complex structures.
 *
 * Note: We assume artifacts are only present in file parts, not in text or data parts.
 */
export function serializePartAsXML(part: Part & Partial<ReferralInfo>): string {
  const lines: string[] = [];

  if (part.referral) {
    lines.push(`<referral>`);
    if (part.referral.headline) {
      lines.push(`<headline>${part.referral.headline}</headline>`);
    }
    if (part.referral.body) {
      lines.push(`<body>${part.referral.body}</body>`);
    }
    if (part.referral.welcome_message?.text) {
      lines.push(
        `<welcome_message>${part.referral.welcome_message.text}</welcome_message>`,
      );
    }
    lines.push(`</referral>`);
  }

  switch (part.type) {
    case "text": {
      if (part.kind === "text") {
        if (lines.length) {
          lines.push(part.text);
          break;
        }
        return part.text;
      }

      lines.push(`<${part.kind}>`, part.text, `</${part.kind}>`);

      break;
    }

    case "data": {
      if (part.kind === "comment") {
        // A comment on a post: which post, and what was said.
        // An API writer may leave `post` out of an outgoing one.
        const post = part.data?.post;

        lines.push(post ? `<comment on="${post.type}">` : `<comment>`);
        if (post?.url) lines.push(`<post_url>`, post.url, `</post_url>`);
        if (post?.title) {
          lines.push(
            `<post_caption>`,
            clip(post.title, 500),
            `</post_caption>`,
          );
        }
        lines.push(part.text ?? "", `</comment>`);
      } else if (part.text) {
        lines.push(`<${part.kind}>`, part.text, `</${part.kind}>`);
      } else {
        lines.push(
          `<${part.kind}>`,
          inspect(part.data, {
            compact: false,
            depth: Infinity,
            colors: false,
          }),
          `</${part.kind}>`,
        );
      }

      break;
    }

    case "file": {
      lines.push(`<${part.kind}>`);

      lines.push(`<uri>`, part.file.uri, `</uri>`);

      if (part.file.name) {
        lines.push(`<filename>`, part.file.name, `</filename>`);
      }

      if (part.kind === "document") {
        lines.push(`<mime_type>`, part.file.mime_type, `</mime_type>`);
      }

      if (part.text) {
        lines.push(`<caption>`, part.text, `</caption>`);
      }

      lines.push(`</${part.kind}>`);

      break;
    }
  }

  if (part.artifacts?.length) {
    lines.push(`<artifacts>`);
    for (const artifact of part.artifacts) {
      lines.push(serializePartAsXML(artifact));
    }
    lines.push(`</artifacts>`);
  }

  return lines.join("\n");
}
