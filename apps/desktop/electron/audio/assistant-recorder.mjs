import path from "node:path";

/** Direct access to the desktop's existing recorder, without navigating its UI. */
export function assistantRecorderLibrary({ service, trashItem, control }) {
  const read = async (id) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid recording ID.");
    const detail = await service().getRecording(id);
    return detail && !detail.meta.ephemeral ? detail : null;
  };
  const recording = async (id) => {
    const detail = await read(id);
    if (!detail) throw new Error("Recording not found.");
    return detail;
  };
  const changed = () => service().broadcast({ type: "recordings-changed" });
  return {
    list: () => service().listRecordings(),
    read,
    rename: async (id, title) => {
      await recording(id);
      await service().renameRecording(id, title);
      changed();
    },
    link: async (id, projectId, linked) => {
      await recording(id);
      await service().setRecordingProject(id, projectId, linked);
      changed();
    },
    trash: async (id) => {
      await recording(id);
      if (service().activeRecordings.has(id)) throw new Error("Stop the recording before moving it to Trash.");
      await trashItem(path.join(service().recordingsDir, id));
      changed();
    },
    control,
  };
}
