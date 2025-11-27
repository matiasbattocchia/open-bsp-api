import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  createUnsecureClient,
  type MessageRow,
  type Part,
  type WebhookPayload,
} from "../_shared/supabase.ts";
import {
  type ApiError,
  type GenerateContentResponse,
  GoogleGenAI,
} from "@google/genai";
import { downloadFromStorage, uploadToStorage } from "../_shared/media.ts";
import { encodeBase64 } from "jsr:@std/encoding/base64";
import * as log from "../_shared/logger.ts";
import { stringify } from "jsr:@std/csv/stringify";

/**
 * Documentation for automatic file annotation handling:
 *
 * The file parts have these fields available for the LLM:
 *
 * - `description`: about 500 characters (0.5KB)
 * - `transcription`: about 2000 characters (2KB)
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
 * - WhatsApp Cloud API file size limits
 *     Audio: 16MB, Image: 5MB, Video: 16MB, Document: 100MB, Sticker: 100KB static/500KB animated
 * - Gemini limits
 *     PDFs up to 1000 pages
 * - Edge Functions limits
 *     Maximum Duration (Wall clock limit): Free plan: 150s, Paid plans: 400s
 */
const MAX_SMALL_DOCUMENT_SIZE = 2 * 1000; // 2 KB
const INLINE_DATA_SIZE_LIMIT = 19 * 1000 * 1000; // 19MB

const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  const authHeader = req.headers.get("Authorization");
  const token = authHeader?.replace("Bearer ", "");

  if (token !== SERVICE_ROLE_KEY) {
    return new Response("Unauthorized", { status: 401 });
  }

  const client = createUnsecureClient();

  const incoming = ((await req.json()) as WebhookPayload<MessageRow>).record!;

  const log_update_and_respond = async (
    logLevel: "error" | "warn" | "info",
    logMessage: string,
  ) => {
    log[logLevel](logMessage);

    await client
      .from("messages")
      .update({ status: { annotated: new Date().toISOString() } })
      .eq("id", incoming.id)
      .throwOnError();

    return new Response();
  };

  const { data: conv } = await client
    .from("conversations")
    .select(`*, organizations (*)`)
    .eq("id", incoming.conversation_id)
    .single()
    .throwOnError();

  const org = conv.organizations;

  if (!conv.extra) {
    conv.extra = {};
  }

  if (!org.extra) {
    org.extra = {};
  }

  const config = org.extra.annotations || {};

  if (config.mode !== "active") {
    return log_update_and_respond(
      "info",
      "Annotation mode is not active. Skipping annotation.",
    );
  }

  const model = config.model || "gemini-2.5-flash";

  const language = config.language || "English";

  const apiKey = config.api_key || Deno.env.get("GEMINI_API_KEY");

  if (!apiKey) {
    return log_update_and_respond(
      "warn",
      "No GOOGLE API KEY found for annotation. Skipping annotation.",
    );
  }

  const genai = new GoogleGenAI({
    apiKey,
  });

  const { content, status } = incoming;

  if (content.type !== "file") {
    return log_update_and_respond(
      "error",
      "Incoming message is not a file. Skipping annotation.",
    );
  }

  const mimeType = content.file.mime_type;
  const mediaType = content.kind === "sticker" ? "image" : content.kind;

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
      // "text/*"
      "application/json",
      "application/xml",
      "application/javascript",
      "application/sql",
      "application/rtf",
    ],
  };

  const isSupportedMimeType = mimeType.startsWith("text/") ||
    allowedMimeTypes[mediaType]?.includes(mimeType.split(";")[0]); // "audio/ogg; codecs=opus" -> "audio/ogg"

  if (!isSupportedMimeType) {
    return log_update_and_respond(
      "warn",
      `Unsupported mime type ${mimeType} for media type ${mediaType}. Skipping annotation.`,
    );
  }

  // Check if we need to use File API vs inline data. Max payload size is 20MB.
  // Use 19MB limit to leave space for prompt and other request data.
  // We multiply by 1.33 to account for the base64 encoding overhead.
  const shouldUseFileAPI = content.file.size * 1.33 > INLINE_DATA_SIZE_LIMIT;

  if (shouldUseFileAPI) {
    return log_update_and_respond(
      "warn",
      "Base64 encoded data size exceeds 19MB limit. File should be uploaded using the Gemini File API but it is not implemented yet.",
    );
  }

  await client
    .from("messages")
    .update({ status: { annotating: new Date().toISOString() } })
    .eq("id", incoming.id)
    .throwOnError();

  const file = await downloadFromStorage(client, content.file.uri);
  const base64File = encodeBase64(await file.arrayBuffer());

  let prompt = "";

  switch (mediaType) {
    case "audio":
      prompt =
        `Analyze this audio file. Provide a transcription of the audio content in its original language and a brief description in ${language} of what it contains (voice, music, noises, etc.). If it's voice, include emotion recognition in the description.`;
      break;
    case "video":
      prompt =
        `Analyze this video file. Provide a transcription of any audio content in its original language and a brief description in ${language} of what the video shows.`;
      break;
    case "image":
      prompt =
        `Analyze this image. If it contains text, extract it as transcription in its original language using markdown format if possible. Provide a brief description in ${language} of the image content, or if it's a document, specify the document type (invoice, receipt, etc.) and include relevant information (dates, amounts, etc.).`;
      break;
    case "document":
      if (mimeType === "text/csv") {
        prompt =
          `Analyze this CSV document. Do not transcribe! Do not extract the data as a table either! Provide a brief description in ${language} of the data (column names, row samples, etc.).`;
      } else if (mimeType === "application/pdf") {
        prompt =
          `Analyze this PDF document. Extract the text content as transcription in its original language using markdown format if possible. If the content includes a table, do not transcribe the table. Instead, provide the table as an array of arrays; the first row should contain the column names (if the header is multi-row, flatten it and pick sensible column names). Do not treat key-value data as a table (avoid single-row tables). Provide a brief description in ${language} of the document, specify the document type (invoice, receipt, etc.) and include relevant information (dates, amounts, etc.).`;
      } else {
        prompt =
          `Analyze this text document. Do not transcribe! If the content includes a table, provide the table as an array of arrays; the first row should contain the column names (if the header is multi-row, flatten it and pick sensible column names). Do not treat key-value data as a table (avoid single-row tables). Provide a brief description in ${language} of the document, specify the document type (invoice, receipt, etc.) and include relevant information (dates, amounts, etc.).`;
      }
      break;
    default:
      prompt =
        `Analyze this file and provide a transcription of any text content in its original language and a brief description in ${language} of what it contains.`;
  }

  if (config?.extra_prompt) {
    prompt += `\n\n${config.extra_prompt}`;
  }

  const responseSchema = {
    type: "object",
    properties: {
      transcription: {
        type: "string",
      },
      description: {
        type: "string",
      },
      table: {
        type: "array",
        items: {
          type: "array",
          items: {
            type: "string",
          },
        },
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
    // https://ai.google.dev/gemini-api/docs/troubleshooting
    const retryableErrors = [429, 500, 503]; // RESOURCE_EXHAUSTED, INTERNAL, UNAVAILABLE

    if (retryableErrors.includes((error as ApiError).status)) {
      log.error("Retryable Gemini API error in annotation", error);
      throw error;
    }

    return log_update_and_respond(
      "error",
      `Gemini API error in annotation. Skipping annotation. ${error}`,
    );
  }

  if (!response?.text) {
    return log_update_and_respond(
      "error",
      "No response text received from the annotation model. Skipping annotation.",
    );
  }

  let result: {
    transcription: string | undefined;
    description: string | undefined;
    table: Array<Array<string>> | undefined;
  };

  try {
    result = JSON.parse(response.text);
  } catch (_error) {
    return log_update_and_respond(
      "error",
      "Failed to parse the response text from the annotation model into a JSON object. Skipping annotation.",
    );
  }

  const artifacts: Part[] = [];

  if (result.description) {
    artifacts.push({
      type: "text",
      kind: "description",
      text: result.description,
    });
  }

  // PDF transcription exceeding 2KB
  if (
    mimeType === "application/pdf" &&
    result.transcription &&
    result.transcription.length > MAX_SMALL_DOCUMENT_SIZE
  ) {
    // Store enriched documents (PDF) transcription as llm.txt
    const name = [content.file.name, "llm.txt"].join(".");

    const file = new Blob([result.transcription], {
      type: "text/markdown",
    });

    const uri = await uploadToStorage(client, org.id, file);

    artifacts.push({
      type: "file",
      kind: "document",
      file: { mime_type: file.type, uri, name, size: file.size },
    });

    result.transcription = undefined;
  }

  if (
    result.transcription &&
    // Do not store the transcription for text documents safeguard
    (mediaType !== "document" || mimeType === "application/pdf")
  ) {
    artifacts.push({
      type: "text",
      kind: "transcription",
      text: result.transcription,
    });
  }

  // Do not create a CSV from a CSV safeguard
  if (result.table?.length && mimeType !== "text/csv") {
    const csv = stringify(result.table);

    const name = [content.file.name, "csv"].join(".");

    const file = new Blob([csv], {
      type: "text/csv",
    });

    const uri = await uploadToStorage(client, org.id, file);

    artifacts.push({
      type: "file",
      kind: "document",
      file: { mime_type: file.type, uri, name, size: file.size },
    });
  }

  const annotated = {
    ...incoming,
    content: {
      ...content,
      artifacts,
    },
    status: {
      ...status,
      annotated: new Date().toISOString(),
    },
  };

  await client
    .from("messages")
    .update(annotated)
    .eq("id", incoming.id)
    .throwOnError();

  return new Response();
});
