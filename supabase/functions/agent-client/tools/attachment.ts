import { z } from "zod";
import type { ToolDefinition } from "./base.ts";

const AttachFileInputSchema = z.object({
  file_uri: z.string().describe("The internal URI of the file to attach"),
  //caption: z.string().optional().describe("Optional caption for the file"),
});

const AttachFileOutputSchema = z.object({
  file_uri: z.string(),
  //caption: z.string().optional(),
});

export async function attachFileImplementation(
  input: z.infer<typeof AttachFileInputSchema>,
): Promise<z.infer<typeof AttachFileOutputSchema>> {
  return {
    file_uri: input.file_uri,
    //caption: input.caption,
  };
}

export const AttachFileTool: ToolDefinition<
  typeof AttachFileInputSchema,
  typeof AttachFileOutputSchema
> = {
  provider: "local",
  type: "function",
  name: "attach_file",
  description:
    "Attach a file to send to the user. The file must already exist in storage with an internal URI. The user cannot directly open or view this URI; however, once attached, the file becomes available for download within the user interface.",
  inputSchema: z.toJSONSchema(AttachFileInputSchema),
  outputSchema: z.toJSONSchema(AttachFileOutputSchema),
  implementation: attachFileImplementation,
};
