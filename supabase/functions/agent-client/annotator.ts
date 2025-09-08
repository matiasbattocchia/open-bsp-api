import type {
  AnnotationConfig,
  ConversationRow,
  Database,
  MessageRow,
} from "../_shared/supabase.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { GoogleGenAI, Type, type GenerateContentResponse } from "@google/genai";
import { downloadFromStorage, uploadToStorage } from "./media.ts";
import { encodeBase64 } from "jsr:@std/encoding/base64";
import { toV1, fromV1 } from "./messages-v0.ts";
import * as log from "../_shared/logger.ts";

/**
 * Documentation for automatic file annotation handling:
 *
 * The file parts have these fields available for the LLM:
 *
 * - `description`: about 500 characters (0.5KB)
 * - `transcription`: about 1000 characters (1KB)
 *
 * Transcription is the human readable text content of the document.
 *
 * - For CSV is the same as the file content.
 * - For HTML is the text content of the HTML tags.
 *
 * 1. Text-based documents
 *
 *    A. Large (> 1KB)
 *
 *       Only the "head" (first 1KB) of the content is included in the `transcription` for the LLM.
 *       The full file is always available for direct reading if needed.
 *
 *     B. Small (≤ 1KB)
 *
 *        The entire content is included in the `transcription` so the LLM has it at hand.
 *        The full file is also available for direct reading.
 *
 * 2. Enriched documents (PDF)
 *
 *    The same size criteria apply: if small, include the whole content; if large, only the head.
 *    If the document is large, an auxiliary file for the LLM is also generated.
 *
 * Notes:
 *
 * - WhatsApp Cloud API file size limits:
 *     Audio: 16MB, Image: 5MB, Video: 16MB, Document: 100MB, Sticker: 100KB static/500KB animated
 * - Gemini limits:
 *     PDFs up to 1000 pages
 */
const MAX_SMALL_DOCUMENT_SIZE = 1 * 1000; // 1 KB

export async function annotateMessage(
  row: MessageRow,
  config: AnnotationConfig,
  client: SupabaseClient<Database>
): Promise<null> {
  const row_v1 = toV1(row);

  if (!row_v1) {
    return null;
  }

  const { message, status } = row_v1;

  if (status.annotating) {
    return null;
  }

  if (message.type !== "file") {
    return null;
  }

  if (message.file.description || message.file.transcription) {
    return null;
  }

  const file = await downloadFromStorage(client, message.file.uri);
  const base64File = encodeBase64(await file.bytes());

  const genai = new GoogleGenAI({
    apiKey: config.api_key || Deno.env.get("GOOGLE_API_KEY"),
  });

  const model = config.model || "gemini-2.5-flash";

  // Check if we need to use File API vs inline data. Max payload size is 20MB.
  // Use 19MB limit to leave space for prompt and other request data.
  const INLINE_DATA_SIZE_LIMIT = 19 * 1000 * 1000; // 19MB
  const shouldUseFileAPI = base64File.length > INLINE_DATA_SIZE_LIMIT;

  if (shouldUseFileAPI) {
    log.error(
      `Base64 encoded data size exceeds 19MB limit. File should be uploaded but the File API is not implemented yet.`
    );
    return null;
  }

  const mimeType = message.file.mime_type;
  const mediaType = message.kind === "sticker" ? "image" : message.kind;

  const allowedMimeTypes: Record<string, string[]> = {
    audio: [
      "audio/wav",
      "audio/mp3",
      "audio/aiff",
      "audio/aac",
      "audio/ogg",
      "audio/flac",
    ],
    image: [
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/heic",
      "image/heif",
    ],
    sticker: [
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/heic",
      "image/heif",
    ],
    video: [
      "video/mp4",
      "video/mpeg",
      "video/mov",
      "video/avi",
      "video/x-flv",
      "video/mpg",
      "video/webm",
      "video/wmv",
      "video/3gpp",
    ],
    document: [
      "application/pdf", // PDF is the only mime type which goes through visual recognition
      // All the other mime types extract text content
      "text/plain",
      "text/html",
      "text/csv",
      "text/xml",
      "application/json",
      "text/markdown",
    ],
  };

  if (
    mediaType !== "document" &&
    allowedMimeTypes[mediaType] &&
    !allowedMimeTypes[mediaType].includes(mimeType)
  ) {
    log.warn(
      `Unsupported mime type ${mimeType} for media type ${mediaType}. Skipping annotation.`
    );
    //return null;
  }

  const { error: annotatingError } = await client
    .from("messages")
    .update({ status: { annotating: new Date().toISOString() } })
    .eq("id", row.id);

  if (annotatingError) {
    throw annotatingError;
  }

  let prompt = "";

  const language = config.language || "English";

  switch (mediaType) {
    case "audio":
      prompt = `Analyze this audio file. Provide a transcription of the audio content in its original language and a brief description in ${language} of what it contains (voice, music, noises, etc.). If it's voice, include emotion recognition in the description.`;
      break;
    case "video":
      prompt = `Analyze this video file. Provide a transcription of any audio content in its original language and a brief description in ${language} of what the video shows.`;
      break;
    case "image":
      prompt = `Analyze this image. If it contains text, extract it as transcription in its original language using markdown format if possible. Provide a brief description in ${language} of the image content, or if it's a document, specify the document type (invoice, receipt, etc.) and include relevant information (dates, amounts, etc.).`;
      break;
    case "document":
      prompt = `Analyze this document. Extract the text content as transcription in its original language using markdown format if possible. Provide a brief description in ${language} of the document, specify the document type (invoice, receipt, etc.) and include relevant information (dates, amounts, etc.).`;
      break;
    default:
      prompt = `Analyze this file and provide a transcription of any text content in its original language and a brief description in ${language} of what it contains.`;
  }

  if (config.extra_prompt) {
    prompt += `\n\n${config.extra_prompt}`;
  }

  const responseSchema = {
    type: Type.OBJECT,
    properties: {
      transcription: {
        type: Type.STRING,
      },
      description: {
        type: Type.STRING,
      },
    },
  };

  const contents: Array<
    | {
        text: string;
      }
    | {
        inlineData: { mimeType: string; data: string };
      }
  > = [
    {
      inlineData: {
        mimeType: mimeType,
        data: base64File,
      },
    },
  ];

  if (mediaType === "image") {
    // Documentation recommends to put the prompt at the end for images
    contents.push({ text: prompt });
  } else {
    contents.unshift({ text: prompt });
  }

  let response: GenerateContentResponse;

  try {
    response = await genai.models.generateContent({
      model,
      contents: contents,
      config: {
        responseMimeType: "application/json",
        responseSchema: responseSchema,
      },
    });
  } catch (error) {
    // ApiError: {"error":{"code":400,"message":"Unsupported MIME type: application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    log.error("Error in annotation", error);
    return null;
  }

  if (!response?.text) {
    log.error("No response text received from annotation");
    return null;
  }

  const result = JSON.parse(response.text);

  let llm:
    | { mime_type: "text/markdown"; uri: string; name: string; size: number }
    | undefined;

  // Document transcription exceeding 1KB
  if (result.transcription.length > MAX_SMALL_DOCUMENT_SIZE) {
    // Store enriched documents (PDF) transcription as llms.txt
    if (mediaType === "document" && mimeType === "application/pdf") {
      const name = [message.file.name, "llms.txt"].join(".");

      const file = new File([result.transcription], name, {
        type: "text/markdown",
      });

      const uri = await uploadToStorage(
        client,
        {
          organization_address: row.organization_address,
          contact_address: row.contact_address,
        } as ConversationRow,
        file
      );

      llm = { mime_type: "text/markdown", uri, name, size: file.size };
    }

    // Truncate transcription
    result.transcription =
      result.transcription.slice(0, MAX_SMALL_DOCUMENT_SIZE) +
      `\n[Note: Transcription truncated to ${MAX_SMALL_DOCUMENT_SIZE} of ${result.transcription.length} chars.]`;
  }

  const annotated_v1 = {
    ...row_v1,
    message: {
      ...message,
      file: {
        ...message.file,
        ...(result.description && { description: result.description }),
        ...(result.transcription && { transcription: result.transcription }),
        ...(llm && { llm }),
      },
    },
    status: {
      ...status,
      annotated: new Date().toISOString(),
    },
  };

  const annotated_v0 = fromV1(annotated_v1);

  if (!annotated_v0) {
    return null;
  }

  const { error: annotatedError } = await client
    .from("messages")
    // @ts-expect-error it fears to update an incoming message as outgoing and viceversa
    .update(annotated_v0)
    .eq("id", row.id);

  if (annotatedError) {
    log.error("Failed to update message annotation status:", annotatedError);
  }

  return null;
}
