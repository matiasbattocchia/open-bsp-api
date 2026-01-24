import * as log from "./logger.ts";

export function markdownToWhatsApp(text: string): string {
  try {
    // Pattern to split by code blocks (triple backticks)
    const parts = text.split(/(`{3}[\s\S]*?`{3})/);

    return parts.map((part) => {
      // If it's a code block, return as is
      if (part.startsWith("```")) {
        return part;
      }

      // Split by inline code
      const subParts = part.split(/(`[^`]+`)/);

      return subParts.map((subPart) => {
        // If inline code, return as is
        if (subPart.startsWith("`")) {
          return subPart;
        }

        let processed = subPart;

        // Convert Headers: # Title -> *Title*
        processed = processed.replace(/^#+\s+(.*)$/gm, "*$1*");

        // 1. Bold: **text** or __text__ -> *text*
        // Use \u0002 as placeholder for * to avoid conflict with italic * conversion
        processed = processed.replace(/\*\*(.+?)\*\*/g, "\u0002$1\u0002");
        processed = processed.replace(/__(.+?)__/g, "\u0002$1\u0002");

        // 2. Italic: *text* -> _text_
        // Note: _text_ in MD is already valid in WA
        processed = processed.replace(/\*(.+?)\*/g, "_$1_");

        // 3. Strikethrough: ~~text~~ -> ~text~
        processed = processed.replace(/~~(.+?)~~/g, "~$1~");

        // 4. Restore Bold stars
        processed = processed.replace(/\u0002/g, "*");

        return processed;
      }).join("");
    }).join("");
  } catch (error) {
    log.error("Error converting Markdown to WhatsApp", error);
    return text;
  }
}

export function whatsappToMarkdown(text: string): string {
  try {
    // Pattern to split by code blocks (triple backticks)
    const parts = text.split(/(`{3}[\s\S]*?`{3})/);

    return parts.map((part) => {
      // If it's a code block, return as is
      if (part.startsWith("```")) {
        return part;
      }

      // Split by inline code
      const subParts = part.split(/(`[^`]+`)/);

      return subParts.map((subPart) => {
        // If inline code, return as is
        if (subPart.startsWith("`")) {
          return subPart;
        }

        let processed = subPart;

        // 1. Bold: *text* -> **text**
        processed = processed.replace(/\*([^\*]+?)\*/g, "**$1**");

        // 2. Italic: _text_ -> *text*
        processed = processed.replace(/_([^_]+?)_/g, "*$1*");

        // 3. Strikethrough: ~text~ -> ~~text~~
        processed = processed.replace(/~([^~]+?)~/g, "~~$1~~");

        return processed;
      }).join("");
    }).join("");
  } catch (error) {
    log.error("Error converting WhatsApp to Markdown", error);
    return text;
  }
}
