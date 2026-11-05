import { Plugin } from "@opencode/plugin";

const codingWorktree = (name: string) => /(?:^|[._])worktree_(?:create|list|remove)$/.test(name);
const diagnostic = "Git worktrees and repository setup are outside LegalWork's legal workflows. Use the project's normal files and document history.";

/** Keep upstream document/history internals while excluding coding workflows. */
export const LegalWorkProductScope = Plugin.define({
  id: "legalwork.product-scope",
  async setup(ctx) {
    const registrations = [
      await ctx.tool.transform(editor => {
        for (const tool of editor.list()) if (codingWorktree(tool.name) || codingWorktree(tool.id)) editor.remove(tool.id);
      }),
      await ctx.tool.hook("execute.before", event => { if (codingWorktree(event.tool)) throw new Error(diagnostic); }),
      // Also stop direct native/internal creation before a saved project setup
      // command can run. This does not alter files, snapshots or existing repos.
      await ctx.worktree.transform(editor => editor.add({
        id: "legalwork.documents",
        async create() { throw new Error(diagnostic); },
        async remove() { throw new Error(diagnostic); },
        async list() { return []; },
      })),
    ];
    return async () => { for (const registration of registrations.reverse()) await registration.dispose(); };
  },
});
export default LegalWorkProductScope;
