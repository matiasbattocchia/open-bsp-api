import {
  type MessageInsert,
  type MessageInsertV1,
  type MessageRow,
  type MessageRowV1,
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
          artifacts: row.message.artifacts,
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
          artifacts: row.message.artifacts,
        },
      };
    }
  } // FunctionResponseMessageDeprecated
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
          artifacts: row.message.artifacts,
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
          artifacts: row.message.artifacts,
        },
      };
    }
  } // Media types
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
          size: row.message.media.file_size || 0,
          name: row.message.media.filename,
          uri: row.message.media.id,
        },
        text: row.message.type === "audio" ? "" : row.message.content,
        artifacts: row.message.artifacts,
      },
    };
  } // Text types
  else if ("content" in row.message && row.message.content) {
    return {
      ...row,
      message: {
        version: "1",
        type: "text",
        // @ts-ignore
        kind: row.message.type,
        text: row.message.content,
        artifacts: row.message.artifacts,
      },
    };
  } // Data types
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
        artifacts: row.message.artifacts,
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
          artifacts: row.message.artifacts,
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
          artifacts: row.message.artifacts,
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
          artifacts: row.message.artifacts,
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
          artifacts: row.message.artifacts,
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
        artifacts: row.message.artifacts,
      },
    };
  } else if (row.message.type === "file") {
    const transcription = row.message.artifacts?.find(
      (a) => a.type === "text" && a.kind === "transcription",
      // @ts-ignore
    )?.text;
    const description = row.message.artifacts?.find(
      (a) => a.type === "text" && a.kind === "description",
      // @ts-ignore
    )?.text;

    return {
      ...row,
      message: {
        version: "0",
        // @ts-ignore
        type: row.message.kind,
        // @ts-ignore
        content:
          row.message.kind === "audio" ? transcription : row.message.text,
        media: {
          // @ts-ignore
          mime_type: row.message.file.mime_type,
          // @ts-ignore
          file_size: row.message.file.size,
          // @ts-ignore
          filename: row.message.file.name,
          // @ts-ignore
          id: row.message.file.uri,
          description,
          ...(row.message.kind === "audio"
            ? {}
            : { annotation: transcription }),
        },
        artifacts: row.message.artifacts,
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
        artifacts: row.message.artifacts,
      },
    };
  }

  console.warn("Could not convert message to v0", row);

  return undefined;
}
