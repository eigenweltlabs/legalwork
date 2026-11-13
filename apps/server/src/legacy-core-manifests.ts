// Hashes of the bundled files shipped in 0.3.6-alpha.167.g14eb1ef.
// Includes generated help translations; no project file content is recorded.
import type { CoreManifest } from "./core-bundle.js";

export const LEGACY_CORE_MANIFESTS: Readonly<Record<string, CoreManifest>> = {
  // Legacy development copies of these packages match the released hashes
  // below. Recognize only the complete unchanged research packages; retain
  // all other project files and every edited or extended package.
  "7cae87135b7adebe6e7e31629b021b67b96e92fc": {
    version: 1, bundle: "7cae87135b7adebe6e7e31629b021b67b96e92fc",
    files: {
      ".opencode/skills/legal-research/SKILL.md": "fcbed225850d7f9af59eef42443750a7f2ce8e248cdc5cf3adad4a3cf6a0face",
      ".opencode/skills/libra-research/SKILL.md": "2da77516d68c196c33f7be34ba28b8266dfb875c661153559fe37e6844f4b2b8",
    },
  },
  "ae633afb5451854c2bb9b93683815608c11195e5": {
    "version": 1,
    "bundle": "ae633afb5451854c2bb9b93683815608c11195e5",
    "files": {
      ".opencode/skills/legal-research/SKILL.md": "fcbed225850d7f9af59eef42443750a7f2ce8e248cdc5cf3adad4a3cf6a0face",
      ".opencode/skills/libra-research/SKILL.md": "2da77516d68c196c33f7be34ba28b8266dfb875c661153559fe37e6844f4b2b8",
      ".opencode/skills/legalwork-help/SKILL.md": "5b0c29142cb97f3d1378a8bdc0d9534a5954866e11598bbb56c4d51c77b92c02",
      ".opencode/skills/legalwork-help/scripts/lookup-label.mjs": "025892a3eda019b7e756b8b87b50b5d53a1e951685a5c22feddb8fa3d27a31df",
      ".opencode/skills/author-review-prompts/SKILL.md": "857e67bcf85dcd0f6bc6dfbf0a592df74d6ad612429e74eb2a5abfb757429b04",
      ".opencode/skills/start-tabular-review/SKILL.md": "84a2971f3d7be5e46c211a83dc8b4d986dcf47653964fede22d09bd916bde144",
      ".opencode/agents/document-extractor.md": "628ec94c2e3cadf996e74f5d1e479f2d20b3f8643a6972f4bd019a64be33fe31",
      ".opencode/agents/fusion-candidate.md": "14c822f5becf2b75a81492f323953c4ae18f88e40e414106130add6c8e46406f",
      ".opencode/skills/docx-edit/SKILL.md": "9037c4667a4c39f062ea080d99165d1a3242eec907a68b8d7689ed7a227de1e5",
      ".opencode/skills/docx-edit/assets/docx-agent.mjs": "9de6aaba3f0979b13d44eb9d76d48a4c66c10d72f2c9fbab82abfdefba9bdcef",
      ".opencode/skills/docx-edit/assets/populate-template.py": "ab2009b2fe6ce8cd0657eec9773252205d51b6ea474e4599e30223b9134e561f",
      ".opencode/skills/docx-edit/assets/verify-evidence.py": "4fb02e44cea6812a38e02b838dea652ccb8ca91d1da4cbf9f77350c2d3505e24",
      ".opencode/skills/docx-edit/assets/report-from-reviews.py": "89fc19331ecfa892be33179defef3db12977ff694055ff85e75b50024e888483",
      ".opencode/skills/docx-edit/assets/vendor/docx-engine.mjs": "00953b5f053efa296257b3ab23141deebcb717dc2233df68ea0fd46438c811a8",
      ".opencode/agents/docx-redliner.md": "35a642679fa8c165d566920efaa3a8614f73de2588772be7971c4675a76ef94a",
      ".opencode/commands/edit-docx.md": "2816b0f7758a6a4c6c7e71b54dc7e6cafe7f7d7c33a6382865d36423ab56c5c0",
      ".opencode/skills/pdf-tools/assets/vendor/pdf.min.js": "5b5799e6f8c680663207ac5b42ee14eed2a406fa7af48f50c154f0c0b1566946",
      ".opencode/skills/pdf-tools/assets/vendor/pdf.worker.min.js": "feabdf309770ed24bba31a5467836cdc8cf639c705af27d52b585b041bb8527b",
      ".opencode/skills/pdf-tools/SKILL.md": "d751d5f6968a54d07bec8a2a0db14dfa78a805209d01baa3b778553802962ace",
      ".opencode/skills/pdf-tools/assets/pdf-agent.mjs": "96421160722cbffc864f78eb7d60c7c712db2f8a719f4a9b1717a0f1e22fff55",
      ".opencode/skills/pdf-tools/assets/pdf-ops.mjs": "30b6dea3452e71dba0410a682147e728087a17491f2c1edb013086a9d56c2fc8",
      ".opencode/skills/pdf-tools/assets/pdf-text.mjs": "f5a6839cbff020019990ff63628b4ebf4ad97be78bc4f91880898c4290484c4e",
      ".opencode/skills/pdf-tools/assets/vendor/pdf-lib.mjs": "72219655c46eab263cd733f6c6dc46436b50f0642fd9820f90cce45781d440e5",
      ".opencode/commands/open.md": "448eecff759f8f6b00980ab84ba737c9cb412229cff55764f7126c44a7e1d25a",
      ".opencode/commands/annotate.md": "c80fd79f15b4c33af70850f19d86f0f5ddc4987870c95eb4c79fbba1d2cfeb54",
      ".opencode/commands/fill-form.md": "459937e2b686d574b7792cd855c2051657b3fa9fdae9184d78f1c6e7fa3c4701",
      ".opencode/commands/sign.md": "d19b040bb7ae11e812493d1b4a7fb1209c65d8c2a12168994bc5076cc3f4cb4a",
      ".opencode/skills/benchmark-task/SKILL.md": "16f116c700b7a46f77d01223d3fe5afbaf3c168e587024700a17f9f17d964490",
      ".opencode/skills/legalwork-help/references/assistant.md": "7c9f4044c3bc073ce5ec992054fe0e593290ead1a3405d540a7dc1180433d866",
      ".opencode/skills/legalwork-help/references/audio.md": "823bbc3088a8cf0bd1eda5c3f3742e4a51883bfcea1f880c7cbb7dc86a38ff50",
      ".opencode/skills/legalwork-help/references/calendar.md": "a3e860fae9dc8d2e72c63262554c1104ca67d8bc8a2c5dbf25e9d3ba029ad1f9",
      ".opencode/skills/legalwork-help/references/connected-storage.md": "adbac95846ebd9bcd31a156e4039c61da4273a0fd35bedb643d1b29c70edf157",
      ".opencode/skills/legalwork-help/references/dashboards.md": "2accdd58d220cd4f1da8a3c310f9117f8d25c03b5cab61d6d1bba845d0a6ccb9",
      ".opencode/skills/legalwork-help/references/email.md": "ba94ed0c0592af09162b6d9f42bd858a11ebfdedc3918ade08653a10f69c45c5",
      ".opencode/skills/legalwork-help/references/evaluations.md": "de62f0340024a457debcab43643155191adc53cef8c93c7a689fe85ca031455b",
      ".opencode/skills/legalwork-help/references/feature-availability.md": "85575866e30d5f0dc95e1a911df67a2976b9dfcc48cefda9fb9c2540c71d530b",
      ".opencode/skills/legalwork-help/references/files-documents.md": "2d89983a3f3a31b1a914ad666a3eab836e1dcf8ca0ab61ed12dfd4757cf9f98f",
      ".opencode/skills/legalwork-help/references/getting-started.md": "c30b46712796acc6d72c574918b07a308f017b79cab88c5d152b59d81495948c",
      ".opencode/skills/legalwork-help/references/index.md": "e5410e4eda753f4aa3aa3015e0c535fe6b274c37420ed5037de3bec442233fd8",
      ".opencode/skills/legalwork-help/references/integrations.md": "d3b49616f31e87558bd2934396144c30270ece86afede59598dd1011145f561c",
      ".opencode/skills/legalwork-help/references/localization.md": "798d8078324bb7b684e0f4cb9f89e6fba12a96036befacf541809bcaea5cf524",
      ".opencode/skills/legalwork-help/references/models-fusion.md": "ffa6b27102113197ffbf96ca733df1a6008065ab54fdca165acbfa3f16a68fa5",
      ".opencode/skills/legalwork-help/references/office-addins.md": "07e81e49938a8bb3bcdbf5bf1c4ae4572ca3afa2836089847cbf4d60f28c15b1",
      ".opencode/skills/legalwork-help/references/projects-sharing.md": "ebc9567e9a96fdaf92135d60212e56086f1a6640d50d49dec5e0cc74fe7da265",
      ".opencode/skills/legalwork-help/references/recorder-settings.md": "dfefb88bd3fe511ed1a7d6ea4fdeebb777612f3a9621efa65f5f63d6016d28a4",
      ".opencode/skills/legalwork-help/references/reviews.md": "f73831f87046eeabb7537616c8f012c33b4f46341ded631ec7675a3bbeebc5ef",
      ".opencode/skills/legalwork-help/references/scheduled-tasks.md": "9e63131bcfd44b15d0daf21621ce6b073828f9b2c8bac90ba6e8cef20161ee07",
      ".opencode/skills/legalwork-help/references/screens.md": "2bd906db9c84c6d99b5a3b965ea5bcf3b3e20a3a83fb35b9c471d0a0a31b5c7c",
      ".opencode/skills/legalwork-help/references/settings-privacy.md": "28be693faba3322cb18d540c5b5f0078acccc9c9caca625ca4d1a6d69665e9d9",
      ".opencode/skills/legalwork-help/references/skills-workflows.md": "b5ccaa506d318824bbff4a40f1e338a2b40396fa4066869cff351dd2ee72361b",
      ".opencode/skills/legalwork-help/references/tasks-intake.md": "d4c8a94416f8b959d754cb822a505d65f2192fc6fb4ad1e6b81227899dcc100c",
      ".opencode/skills/legalwork-help/references/troubleshooting.md": "ca997102fc0b1a434a4c67cfdfde60af27e511d5ce1598cbd1654e08bfdc03fa",
      ".opencode/skills/legalwork-help/references/wiki.md": "d8b33fd273101fc92c9aba619379f160503866bca5e2b315003613fff5ff70e0",
      ".opencode/skills/legalwork-help/references/workspaces-chats.md": "93037fb669313fbd40e933383919b7975151735c634ac898669eb838fd99dcce",
      ".opencode/skills/legalwork-help/references/i18n.json": "1a1bf3efbb5e82f3482faa2cf2c880ba8929c505d4b1828d3adf958afa1c237b",
      ".opencode/skills/legalwork-help/references/screens.json": "f08228642df4f3ad8f4155b5c542ec2740fe6e2edf8f7f343f720dfa44984cf7"
    }
  }
};
