import type {
  AnnotationConfig,
  Database,
  MessageRow,
} from "../_shared/supabase.ts";
import type { SupabaseClient } from "@supabase/supabase-js";
import { GoogleGenAI, Type } from "@google/genai";
import { downloadFromStorage } from "./media.ts";
import { encodeBase64 } from "jsr:@std/encoding/base64";
import { toV1, fromV1 } from "./messages-v0.ts";
import * as log from "../_shared/logger.ts";

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
    apiKey: config.api_key,
  });

  const model = config.model || "gemini-2.5-flash";

  // Check if we need to use File API vs inline data
  // Use 19.5MB limit to leave space for prompt and other request data
  const INLINE_DATA_SIZE_LIMIT = 19.5 * 1024 * 1024; // 19.5MB
  const shouldUseFileAPI = base64File.length > INLINE_DATA_SIZE_LIMIT;

  if (shouldUseFileAPI) {
    log.error(
      `Base64 encoded data size exceeds 19.5MB limit. File should be uploaded but the File API is not implemented yet.`
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
    return null;
  }

  if (mediaType === "document" && model !== "gemini-2.5-pro") {
    log.warn(
      `Document annotation is only supported by gemini-2.5-pro. Skipping annotation for model ${model}.`
    );
    return null;
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
      prompt = `Analyze this image. If it contains text, extract it as transcription in its original language. Provide a description in ${language} of the image content, objects, or if it's a document, specify the document type (invoice, receipt, etc.).`;
      break;
    case "document":
      prompt = `Analyze this document. Extract the text content as transcription in its original language and provide a brief description in ${language} of the document type and what it contains.`;
      break;
    default:
      prompt = `Analyze this file and provide a transcription of any text content in its original language and a description in ${language} of what it contains.`;
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

  const response = await genai.models.generateContent({
    model,
    contents: contents,
    config: {
      responseMimeType: "application/json",
      responseSchema: responseSchema,
    },
  });

  if (!response.text) {
    log.error("No response text received from annotation");
    return null;
  }

  const result = JSON.parse(response.text);

  const annotated_v1 = {
    ...row_v1,
    message: {
      ...message,
      file: {
        ...message.file,
        ...(result.description && { description: result.description }),
        ...(result.transcription && { transcription: result.transcription }),
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
    .update(annotated_v0)
    .eq("id", row.id);

  if (annotatedError) {
    log.error("Failed to update message annotation status:", annotatedError);
  }

  return null;
}
