import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { MailDatabase } from "./database-interface.js";
import { GraphState, type GraphRun } from "./graph-state.js";
export const GRAPH_DELTA_SCHEMA_SQL = `
CREATE TABLE mail_graph_poll(account_id TEXT PRIMARY KEY,phase TEXT NOT NULL CHECK(phase IN ('discover','folders','create','parents','messages','idle')),root_id TEXT,apply_after TEXT NOT NULL DEFAULT '',poll_at INTEGER CHECK(poll_at BETWEEN 0 AND 9007199254740991),FOREIGN KEY(account_id) REFERENCES mail_accounts(id));
CREATE TABLE mail_graph_delta(account_id TEXT NOT NULL,folder_id TEXT NOT NULL,next_link TEXT,delta_link TEXT,baseline INTEGER NOT NULL DEFAULT 1 CHECK(baseline IN (0,1)),refresh INTEGER NOT NULL DEFAULT 1 CHECK(refresh IN (0,1)),removed INTEGER NOT NULL DEFAULT 0 CHECK(removed IN (0,1)),phase TEXT NOT NULL DEFAULT 'pending' CHECK(phase IN ('pending','paging','sweep','done')),sweep_after TEXT NOT NULL DEFAULT '',metadata_json TEXT,reset_count INTEGER NOT NULL DEFAULT 0 CHECK(reset_count BETWEEN 0 AND 2),PRIMARY KEY(account_id,folder_id),FOREIGN KEY(account_id) REFERENCES mail_accounts(id));
CREATE INDEX mail_graph_delta_refresh ON mail_graph_delta(account_id,refresh,folder_id);
CREATE INDEX mail_graph_delta_phase ON mail_graph_delta(account_id,phase,folder_id);
CREATE TABLE mail_graph_delta_seen(account_id TEXT NOT NULL,folder_id TEXT NOT NULL,message_key TEXT NOT NULL,generation TEXT NOT NULL,PRIMARY KEY(account_id,folder_id,message_key),FOREIGN KEY(account_id) REFERENCES mail_accounts(id));
`;
export const graphPollSchema = z.object({ phase: z.enum(['discover', 'folders', 'create', 'parents', 'messages', 'idle']), root_id: z.string().nullable(), apply_after: z.string(), poll_at: z.number().nullable() });
export const graphDeltaSchema = z.object({ folder_id: z.string(), next_link: z.string().nullable(), delta_link: z.string().nullable(), baseline: z.number(), refresh: z.number(), removed: z.number(), phase: z.enum(['pending', 'paging', 'sweep', 'done']), sweep_after: z.string(), metadata_json: z.string().nullable(), reset_count: z.number() });
export class GraphDeltaState {
    private readonly graph: GraphState;
    constructor(private readonly db: MailDatabase, ownerId: string) { this.graph = new GraphState(db, ownerId); }
    read(accountId: string) { this.graph.account(accountId); const row = this.db.get('SELECT * FROM mail_graph_poll WHERE account_id=?', [accountId]); return row ? graphPollSchema.parse(row) : null; }
    begin(run: GraphRun): GraphRun {
        return this.db.transaction(() => {
            const current = this.graph.read(run.account_id);
            if (!current || current.generation !== run.generation || current.revision !== run.revision)
                throw Error('mail_graph_stale_run');
            this.db.run("UPDATE mail_graph_runs SET generation=?,revision=revision+1,state='active',error=NULL,retry_at=NULL,failures=0 WHERE account_id=?", [randomUUID(), run.account_id]);
            this.db.run("INSERT INTO mail_graph_poll(account_id,phase) VALUES(?,'discover') ON CONFLICT(account_id) DO UPDATE SET phase='discover',poll_at=NULL,root_id=NULL", [run.account_id]);
            this.db.run('DELETE FROM mail_graph_folder_queue WHERE account_id=?', [run.account_id]);
            this.db.run("INSERT INTO mail_graph_folder_queue(account_id,id,parent_id,depth) VALUES(?,'',NULL,0)", [run.account_id]);
            this.db.run("UPDATE mail_graph_delta SET refresh=1,phase='pending',sweep_after='' WHERE account_id=?", [run.account_id]);
            this.db.run('DELETE FROM mail_graph_delta_seen WHERE account_id=?', [run.account_id]);
            return this.graph.read(run.account_id)!;
        });
    }
    remove(accountId: string, key: string) { this.graph.account(accountId); this.db.run("INSERT INTO mail_tombstones(account_id,message_key,reason,observed_at) VALUES(?,?,'graph_removed',?) ON CONFLICT(account_id,message_key) DO UPDATE SET reason='graph_removed',observed_at=excluded.observed_at", [accountId, key, new Date().toISOString()]); this.db.run('DELETE FROM mail_memberships WHERE account_id=? AND message_key=?', [accountId, key]); }
}
