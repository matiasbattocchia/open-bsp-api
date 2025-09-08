import {
  type MessageRow,
  type MessageInsert,
  type MessageRowV1,
  type MessageInsertV1,
} from "./supabase.ts";

export function toV1(row: MessageRow): MessageRowV1 | undefined {
  // FunctionCallMessageDeprecated
  if (row.type === "function_call") {
    if (row.message.v1_type === "data") {
      return {
        ...row,
        message: {
          version: "1",
          task: row.message.task,
          tool: row.message.tool || {
            use_id: row.message.id,
            provider: "local",
            event: "use",
            type: "function",
            name: row.message.function.name,
          },
          type: "data",
          kind: "data",
          data: JSON.parse(row.message.function.arguments),
        },
      };
    }

    if (row.message.v1_type === "text") {
      return {
        ...row,
        message: {
          version: "1",
          task: row.message.task,
          tool: row.message.tool || {
            use_id: row.message.id,
            provider: "local",
            event: "use",
            type: "function",
            name: row.message.function.name,
          },
          type: "text",
          kind: "text",
          text: row.message.function.arguments,
        },
      };
    }
  }
  // FunctionResponseMessageDeprecated
  else if (row.type === "function_response") {
    if (row.message.v1_type === "data") {
      return {
        ...row,
        message: {
          version: "1",
          task: row.message.task,
          tool: row.message.tool || {
            use_id: row.message.tool_call_id,
            provider: "local",
            event: "result",
            type: "function",
            name: row.message.tool_name!,
          },
          type: "data",
          kind: "data",
          data: JSON.parse(row.message.content),
        },
      };
    }

    if (row.message.v1_type === "text") {
      return {
        ...row,
        message: {
          version: "1",
          task: row.message.task,
          tool: row.message.tool || {
            use_id: row.message.tool_call_id,
            provider: "local",
            event: "result",
            type: "function",
            name: row.message.tool_name!,
          },
          type: "text",
          kind: "text",
          text: row.message.content,
        },
      };
    }
  }
  // Media types
  else if ("media" in row.message && row.message.media) {
    return {
      ...row,
      message: {
        version: "1",
        type: "file",
        // @ts-ignore
        kind: row.message.type,
        file: {
          mime_type: row.message.media.mime_type,
          size: row.message.media.file_size,
          name: row.message.media.filename,
          uri: row.message.media.id,
          description: row.message.media.description,
          transcription:
            row.message.type === "audio"
              ? row.message.content
              : row.message.media.annotation,
        },
        text: row.message.type === "audio" ? "" : row.message.content,
      },
    };
  }
  // Text types
  else if ("content" in row.message && row.message.content) {
    return {
      ...row,
      message: {
        version: "1",
        type: "text",
        // @ts-ignore
        kind: row.message.type,
        text: row.message.content,
      },
    };
  }
  // @ts-ignore
  else if (row.message.type in row.message && row.message[row.message.type]) {
    return {
      ...row,
      message: {
        version: "1",
        type: "data",
        // @ts-ignore
        kind: row.message.type,
        // @ts-ignore
        data: row.message[row.message.type],
      },
    };
  }

  console.warn("Could not convert message to v1", row);

  return undefined;
}

export function fromV1(row: MessageInsertV1): MessageInsert | undefined {
  if (
    row.direction === "internal" &&
    row.message.tool?.event === "use" &&
    row.message.tool?.provider === "local" &&
    row.message.type !== "file"
  ) {
    if (row.message.type === "data") {
      return {
        ...row,
        type: "function_call",
        message: {
          version: "0",
          task: row.message.task,
          type: "function",
          v1_type: "data",
          id: row.message.tool.use_id,
          function: {
            name: row.message.tool.name,
            arguments: JSON.stringify(row.message.data),
          },
          tool: row.message.tool,
        },
      };
    }

    if (row.message.type === "text") {
      return {
        ...row,
        type: "function_call",
        message: {
          version: "0",
          task: row.message.task,
          type: "function",
          v1_type: "text",
          id: row.message.tool.use_id,
          function: {
            name: row.message.tool.name,
            arguments: row.message.text,
          },
          tool: row.message.tool,
        },
      };
    }
  } else if (
    row.direction === "internal" &&
    row.message.tool?.event === "result" &&
    row.message.tool?.provider === "local" &&
    row.message.type !== "file"
  ) {
    if (row.message.type === "data") {
      return {
        ...row,
        type: "function_response",
        message: {
          version: "0",
          task: row.message.task,
          v1_type: "data",
          type: "text",
          tool_call_id: row.message.tool.use_id,
          tool_name: row.message.tool.name,
          content: JSON.stringify(row.message.data),
          tool: row.message.tool,
        },
      };
    }

    if (row.message.type === "text") {
      return {
        ...row,
        type: "function_response",
        message: {
          version: "0",
          task: row.message.task,
          v1_type: "text",
          type: "text",
          tool_call_id: row.message.tool.use_id,
          tool_name: row.message.tool.name,
          content: row.message.text,
          tool: row.message.tool,
        },
      };
    }
  } else if (row.message.type === "text") {
    return {
      ...row,
      message: {
        version: "0",
        // @ts-ignore
        type: row.message.kind,
        content: row.message.text,
      },
    };
  } else if (row.message.type === "file") {
    return {
      ...row,
      message: {
        version: "0",
        // @ts-ignore
        type: row.message.kind,
        // @ts-ignore
        content:
          row.message.kind === "audio"
            ? row.message.file.transcription
            : row.message.text,
        media: {
          // @ts-ignore
          mime_type: row.message.file.mime_type,
          // @ts-ignore
          file_size: row.message.file.size,
          // @ts-ignore
          filename: row.message.file.name,
          // @ts-ignore
          id: row.message.file.uri,
          description: row.message.file.description,
          ...(row.message.kind === "audio"
            ? {}
            : { annotation: row.message.file.transcription }),
        },
      },
    };
  } else if (row.message.type === "data") {
    return {
      ...row,
      message: {
        version: "0",
        // @ts-ignore
        type: row.message.kind,
        [row.message.kind]: row.message.data,
      },
    };
  }

  console.warn("Could not convert message to v0", row);

  return undefined;
}
