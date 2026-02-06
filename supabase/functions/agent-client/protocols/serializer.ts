import type { Part } from "../../_shared/supabase.ts";

/**
 * Recursively serializes Parts (including artifacts) as XML.
 * This provides a text representation of structured data and files
 * that can be sent to LLM APIs that don't natively support complex structures.
 *
 * Note: We assume artifacts are only present in file parts, not in text or data parts.
 */
export function serializePartAsXML(part: Part): string {
  const lines: string[] = [];

  switch (part.type) {
    case "text": {
      if (part.kind === "text") {
        return part.text;
      }

      lines.push(`<${part.kind}>`, part.text, `</${part.kind}>`);

      break;
    }

    case "data": {
      lines.push(
        `<${part.kind}>`,
        JSON.stringify(part.data, null, 2),
        `</${part.kind}>`,
      );

      break
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

      break
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
