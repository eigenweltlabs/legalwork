import { expect, test } from "bun:test";
import type { LegalworkServerClient } from "../src/app/lib/legalwork-server";
import { captureSavePath, saveCaptureToProject } from "../src/react-app/launcher/context-capture";

test("save accepts project-relative folders and a PNG name only", () => {
  expect(captureSavePath("", "Screen.png")).toBe("Screen.png");
  expect(captureSavePath("Evidence/Exhibits", "Clause 3.PNG")).toBe("Evidence/Exhibits/Clause 3.PNG");
  for (const path of ["../outside", ".legalwork/attachments", "/absolute", "A//B", "A\\B"]) {
    expect(() => captureSavePath(path, "Screen.png")).toThrow();
  }
  for (const name of ["../Screen.png", ".png", "Screen.jpg", ":Screen.png", "A/B.png"]) {
    expect(() => captureSavePath("", name)).toThrow();
  }
});

test("fresh captures and staged screenshots save to the chosen project without modifying the original", async () => {
  const writes: { workspaceId: string; path: string; bytes: number[]; createOnly: boolean | undefined; requireExistingParent: boolean | undefined }[] = [];
  const reads: string[][] = [];
  const data = Uint8Array.from([137, 80, 78, 71]).buffer;
  const client: Pick<LegalworkServerClient, "writeWorkspaceBinaryFile" | "downloadWorkspaceFile"> = {
    downloadWorkspaceFile: async (workspaceId, path) => {
      reads.push([workspaceId, path]);
      return { data, contentType: "image/png", filename: "source.png", updatedAt: null };
    },
    writeWorkspaceBinaryFile: async (workspaceId, { path, data, createOnly, requireExistingParent }) => {
      const bytes = Array.from(new Uint8Array(data instanceof Blob ? await data.arrayBuffer() : data));
      writes.push({ workspaceId, path, bytes, createOnly, requireExistingParent });
      return { ok: true, path, bytes: bytes.length, updatedAt: 0 };
    },
  };
  const folder = "Evidence/Exhibits";
  expect(await saveCaptureToProject(client, { name: "source.png", dataUrl: "data:image/png;base64,iVBORw==" }, "target", folder, "Region.png")).toBe(`${folder}/Region.png`);
  expect(await saveCaptureToProject(client, { name: "source.png", workspaceId: "original", path: ".legalwork/attachments/source.png" }, "target", folder, "Window.png")).toBe(`${folder}/Window.png`);
  expect(reads).toEqual([["original", ".legalwork/attachments/source.png"]]);
  expect(writes).toEqual(["Region.png", "Window.png"].map(name => ({
    workspaceId: "target", path: `${folder}/${name}`, bytes: [137, 80, 78, 71], createOnly: true, requireExistingParent: true,
  })));
});
