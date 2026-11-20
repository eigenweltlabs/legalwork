import { unzipSync, strFromU8 } from "fflate";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { TimesheetStateSchema } from "@legalwork/types/timesheet";
import { startServer } from "./server.js";
import { backOfficeTestConfig } from "./back-office/config.test-support.js";
import { BackOfficeRecordSchema } from "./back-office/schema.js";
import {
  invoiceDraftRef,
  prepareInvoice,
} from "./back-office/timesheet-invoice.test-support.js";

test("HTTP uses the active Back Office identity for writes, protects accepted entries and issues a numbered original", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-timesheet-http-"));
  const previous = {
    LEGALWORK_DATA_DIR: process.env.LEGALWORK_DATA_DIR,
    LEGALWORK_TOKEN_STORE: process.env.LEGALWORK_TOKEN_STORE,
  };
  process.env.LEGALWORK_DATA_DIR = join(root, "data");
  process.env.LEGALWORK_TOKEN_STORE = join(root, "tokens.json");
  const server = await startServer(backOfficeTestConfig(root)),
    base = "http://127.0.0.1:" + server.port + "/back-office";
  const api = (path: string, body?: unknown) =>
    fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: "Bearer fixture",
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const object = async (objectId: string, values: unknown) =>
    z
      .object({ record: BackOfficeRecordSchema })
      .parse(
        await (
          await api("/records?scope=local", { objectId, revision: 0, values })
        ).json(),
      ).record;
  try {
    const meta = z
      .object({ directoryId: z.string() })
      .parse(await (await api("?scope=local&schema=1")).json());
    const query =
      "?scope=local&expectedUserId=local&directoryId=" +
      encodeURIComponent(meta.directoryId);
    const client = await object("clients", {
        name: "Test client",
        billingAddress: "Testgasse 5, 1010 Wien",
      }),
      matter = await object("matters", {
        name: "Test matter",
        clients: [client.id],
      });
    const create = {
      type: "create",
      requestId: crypto.randomUUID(),
      entry: {
        date: "2026-11-12",
        matterId: matter.id,
        clientId: client.id,
        activity: "TEL",
        narrative: "Client call",
        workedMinutes: 10,
        billableMinutes: 10,
        billable: true,
      },
    };
    expect(
      (await api("/timesheet?scope=local&expectedUserId=another", create))
        .status,
    ).toBe(409);
    expect(
      (await api("/timesheet?scope=local&directoryId=wrong", create)).status,
    ).toBe(409);
    const path = "/timesheet" + query;
    const command = async (body: unknown) => {
      const r = await api(path, body);
      expect(r.status).toBe(200);
      return TimesheetStateSchema.parse(await r.json());
    };
    const state = await command(create),
      entry = state.entries[0],
      selected = (revision: number) => [{ id: entry.id, revision }];
    expect(entry.workerId).toBe("local");
    expect(entry.authorId).toBe("local");
    const bypass = await api("/records?scope=local", {
      objectId: "timeEntries",
      id: entry.id,
      revision: 1,
      values: { status: "Approved" },
    });
    expect(bypass.status).toBe(409);
    const submitted = await command({
      type: "submit",
      entries: selected(entry.revision),
    });
    const approve = {
      type: "approve",
      entries: selected(submitted.entries[0].revision),
    };
    expect((await api(path, approve)).status).toBe(403);
    await command({
      type: "policy",
      policy: {
        scope: "firm",
        targetId: "firm",
        revision: 0,
        effectiveFrom: "2026-01-01",
        soloApproval: true,
        currency: "EUR",
        hourlyRate: 300,
      },
    });
    expect((await api(path, approve)).status).toBe(409);
    const rechecked = await command({
      type: "review",
      id: entry.id,
      revision: submitted.entries[0].revision,
      narrative: "Client call",
      billableMinutes: 10,
    });
    const approved = await command({
      type: "approve",
      entries: selected(rechecked.entries[0].revision),
    });
    expect(
      (
        await api(path, {
          type: "invoice",
          requestId: crypto.randomUUID(),
          entries: selected(approved.entries[0].revision),
        })
      ).status,
    ).toBe(409);
    const approval = async (entries: typeof approved.entries) => {
      const prepared = await command(prepareInvoice(entries));
      const draft = invoiceDraftRef(prepared);
      await command({ type: "approveInvoice", ...draft });
      return { type: "issueInvoice", ...draft, requestId: crypto.randomUUID() };
    };
    const visibleDraft = await command(prepareInvoice([approved.entries[0]]));
    const draftUrl =
      "/timesheet/drafts/" +
      visibleDraft.invoiceDraft!.id +
      "/document" +
      query +
      "&format=docx";
    expect((await api(draftUrl)).status).toBe(200);
    const policy = visibleDraft.policies.find(
      (p) => p.scope === "firm" && p.effectiveFrom === "2026-01-01",
    )!;
    const changed = await command({
      type: "policy",
      policy: { ...policy, soloApproval: false },
    });
    const revoked = await api(draftUrl);
    expect([403, 409]).toContain(revoked.status);
    expect(revoked.headers.get("content-type")).not.toContain(
      "wordprocessingml",
    );
    await command({
      type: "policy",
      policy: {
        ...policy,
        revision: changed.policies.find(
          (p) => p.scope === "firm" && p.effectiveFrom === "2026-01-01",
        )!.revision,
        soloApproval: true,
      },
    });
    const issue = await approval([approved.entries[0]]);
    const issued = await command(issue),
      inv = issued.invoices[0];
    expect(inv.total).toBe(50);
    expect((await command(issue)).invoices).toHaveLength(1);
    const file = await api(
      "/timesheet/invoices/" + inv.id + "/document" + query,
    );
    expect(file.headers.get("content-disposition")).toContain("Invoice-1");
    const original = await file.text();
    expect(original).toContain("Client call");
    const getArtifact = async (format: "docx" | "pdf") => {
      const response = await api(
        "/timesheet/invoices/" +
          inv.id +
          "/document" +
          query +
          "&format=" +
          format,
      );
      expect(response.status).toBe(200);
      return Buffer.from(await response.arrayBuffer());
    };
    const word = await getArtifact("docx"),
      pdf = await getArtifact("pdf");
    expect(strFromU8(unzipSync(word)["word/document.xml"])).toContain(
      "Client call",
    );
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const adjusted = await command({
      type: "adjust",
      id: entry.id,
      revision: issued.entries[0].revision,
      requestId: crypto.randomUUID(),
      reason: "Courtesy",
      narrative: "Courtesy allowance",
      billableMinutes: 0,
    });
    const correction = adjusted.adjustments![0];
    const decided = await command({
      type: "decideAdjustment",
      id: correction.id,
      revision: correction.revision,
      approve: true,
    });
    const note = await api(
      "/timesheet/adjustments/" + correction.id + "/document" + query,
    );
    expect(note.headers.get("content-disposition")).toContain("1-C1");
    expect(await note.text()).toContain("Courtesy allowance");
    expect(decided.invoices[0].total).toBe(50);
    expect(
      await (
        await api("/timesheet/invoices/" + inv.id + "/document" + query)
      ).text(),
    ).toBe(original);

    expect(await getArtifact("docx")).toEqual(word);
    expect(await getArtifact("pdf")).toEqual(pdf);
    expect(
      (
        await api(path, {
          type: "submit",
          entries: [
            {
              ...selected(1)[0],
              shareOriginal: {
                key: crypto.randomUUID(),
                digest: "a".repeat(64),
              },
            },
          ],
        })
      ).status,
    ).toBe(403);

    const another = async (narrative: string) => {
      const state = await command({
        ...create,
        requestId: crypto.randomUUID(),
        entry: { ...create.entry, narrative },
      });
      return state.entries.find((row) => row.narrative === narrative)!;
    };
    const rows = await Promise.all([
      another("Consultation"),
      another("Research"),
    ]);
    const refs = rows.map(({ id, revision }) => ({ id, revision }));
    const sent = await command({ type: "submit", entries: refs });
    const approvedBatch = await command({
      type: "approve",
      entries: sent.entries
        .filter((e) => e.status === "submitted")
        .map(({ id, revision }) => ({ id, revision })),
    });
    const open = approvedBatch.entries.filter((e) => e.status === "approved");
    const second = await approval([open[0]]);
    await Promise.all([command(second), command(second)]);
    const third = await approval([open[1]]);
    await command(third);
    const finalState = TimesheetStateSchema.parse(
      await (await api(path)).json(),
    );
    expect(finalState.invoices.map((i) => i.number).sort()).toEqual([1, 2, 3]);
    expect(
      new Set(finalState.invoices.flatMap((i) => i.entries.map((e) => e.id)))
        .size,
    ).toBe(3);
    const colleague = await object("people", {
      name: "Local associate",
      personType: "Associate",
      active: true,
    });
    const outsider = await object("people", {
      name: "External",
      personType: "External contact",
      active: true,
    });
    const inactive = await object("people", {
      name: "Former colleague",
      personType: "Partner",
      active: false,
    });
    const directory = TimesheetStateSchema.parse(
      await (await api(path)).json(),
    );
    expect(directory.people).toContainEqual({
      id: colleague.id,
      name: "Local associate",
      directoryOnly: true,
    });
    expect(
      directory.people.some((p) => [outsider.id, inactive.id].includes(p.id)),
    ).toBe(false);
    expect(
      (
        await api(path, {
          ...create,
          requestId: crypto.randomUUID(),
          workerIds: [colleague.id],
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api(path, {
          ...create,
          requestId: crypto.randomUUID(),
          workerIds: [inactive.id],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await api(path, {
          type: "policy",
          policy: {
            scope: "firm",
            targetId: "firm",
            reviewerId: colleague.id,
            revision: 0,
            effectiveFrom: "2027-01-01",
          },
        })
      ).status,
    ).toBe(400);
    await api("/records?scope=local", {
      id: colleague.id,
      objectId: "people",
      revision: colleague.revision,
      archived: true,
      values: {},
    });
    expect(
      TimesheetStateSchema.parse(await (await api(path)).json())
        .delegatedEntries,
    ).toEqual([]);
    await api("/records?scope=local", {
      id: client.id,
      objectId: "clients",
      revision: client.revision,
      archived: true,
      values: {},
    });
    expect(
      (await api("/timesheet/invoices/" + inv.id + "/document" + query)).status,
    ).toBe(404);
    expect(
      (
        await api(
          "/timesheet/adjustments/" + correction.id + "/document" + query,
        )
      ).status,
    ).toBe(404);
  } finally {
    await server.stop();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
