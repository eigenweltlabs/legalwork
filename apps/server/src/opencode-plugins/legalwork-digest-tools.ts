import { Plugin } from "@opencode/plugin";
import { contentDigestInput, contentDigestOutput, digestContent } from "../content-digest.js";
import { registerPrimaryContext } from "./native-review-worker.js";
import { nativeTool } from "./native-tool.js";

const guidance = "Use Code Mode to orchestrate tools and select relevant results. For checksums of retrieved content, call legalwork_content_digest from Code Mode and pass the exact text or base64 bytes directly; do not implement bulk cryptographic loops in the interpreter. Other substantial computation can use legalwork_shell under the chat's normal permissions and sandbox. A checksum proves only the bytes supplied: JSON.stringify hashes that serialization, which may differ from the original document or HTTP bytes.";

export const LegalWorkDigestTools = Plugin.define({
  id: "legalwork.content-digest",
  async setup(ctx) {
    await registerPrimaryContext(ctx, event => { event.system.push({ type: "text", text: guidance }); });
    const registration = await ctx.tool.transform(editor => editor.add(nativeTool(ctx, {
      name: "legalwork_content_digest",
      description: "Compute a native SHA-256, SHA-384 or SHA-512 checksum/hash of exact content already returned by tools. From Code Mode, pass data directly without repeating it in your reply. Returns only algorithm, encoding, byte count and hexadecimal digest; reads no file or network. Hashing JSON.stringify(value) proves that serialization, not the original transport or document bytes.",
      schema: contentDigestInput,
      outputSchema: contentDigestOutput,
      async execute(input) {
        const output = digestContent(input);
        return { output, content: JSON.stringify(output) };
      },
    })));
    return () => registration.dispose();
  },
});
export default LegalWorkDigestTools;
