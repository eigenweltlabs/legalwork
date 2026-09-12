import {agentControlSchema} from '../agent-view.js';
import {agentHash,MailAgentGrants} from '../storage/agent-grants.js';
import {MailStorageSaveStore} from '../storage/storage-save-store.js';
import {MailFilingStore} from '../storage/filing-store.js';
import {MailRetentionStore} from '../storage/retention.js';
import {MailRetentionError} from '../retention-view.js';
import {MailNotificationStore} from '../storage/notifications.js';
import {MailPortabilityStore} from "../storage/portability.js";
import {DraftSyncRunner} from "./draft-sync.js";
import {DraftSyncStore,DraftSyncError} from "../storage/draft-sync.js";
import {OutboxStore} from '../storage/outbox.js';
import {SmtpCustody} from '../storage/smtp-custody.js';
import {OutboxRunner} from './outbox-runner.js';
import {OutboxError} from '../outbox-view.js';
import {SenderIdentityRepository} from '../storage/sender-identities.js';
import {discoverMailIdentity} from '../providers/identity.js';
import {GmailReadTransport} from '../providers/gmail.js';
import { MailSyncLifecycle } from "./sync-lifecycle.js";
import { GraphMailboxRepository } from '../storage/graph-mailboxes.js';
import { GraphReadTransport, GraphTransportError } from '../providers/graph.js';
import {storedFolderMutationPrecondition} from '../storage/mutation-precondition.js';
import {MailSavedSearchStore,SavedSearchError} from '../storage/saved-search.js';
import {ImapError} from '../providers/imap-config.js';
import {ImapBackfill} from '../providers/imap-backfill.js';
import {imapFailure} from '../providers/imap.js';
import {MailExtractionStore,MailExtractionStorageError} from "../storage/extraction.js";
import {MailExtractionRunner} from "./extraction-runner.js";
import {MailLocalApiStore,MailLocalError} from "../storage/local-api.js";
import { MailSearchIndexer } from "./search-indexer.js";
import { MailSearchStore, MailSearchError } from "../storage/search.js";
/** Production Node/Electron entrypoint. stdout is exclusively the private worker protocol. */
import { MailConnectionController, MailConnectionError } from "../providers/connection-controller.js";
import { MailCredentialRepository, MailCredentialError } from "../storage/credentials.js";
import { MailAccessCoordinator } from "../providers/access-coordinator.js";
import { GraphBackfillError } from "../providers/graph-backfill.js";
import { GmailBackfillError } from "../providers/gmail-backfill.js";
import type { MailOAuthSettings } from "../providers/oauth.js";
import { isAbsolute } from "node:path";
import { openEncryptedMailDatabase } from "../storage/database.js";
import type { MailDatabase } from "../storage/database-interface.js";
import { MailRepository } from "../storage/repository.js";
import { MailReadStore } from "../storage/read-store.js";
import { MAIL_SCHEMA_VERSION, migrateMailSchema } from "../storage/schema.js";
import { assertMailSchema } from "../storage/consistency.js";
import { MAX_WORKER_MESSAGE_BYTES, parseParentMessage, parseWorkerMessage,
  type ParentMessage, type WorkerInitialization, type WorkerMessage, type WorkerResult, type WorkerAccount, type WorkerFolder } from "./protocol.js";

let outboxStore:OutboxStore|undefined,outboxRunner:OutboxRunner|undefined;
let closingOutbox:Promise<void>|undefined,closingDraftSync:Promise<void>|undefined;
let draftSyncStore:DraftSyncStore|undefined,draftSyncRunner:DraftSyncRunner|undefined;
let ownerId='';
let retention:MailRetentionStore|undefined;
let portability:MailPortabilityStore|undefined;
let closingPortability:Promise<void>|undefined;
let database: MailDatabase | undefined;
let repository: MailRepository | undefined;
let local:MailLocalApiStore|undefined;
let reads: MailReadStore | undefined;
let mailboxes: GraphMailboxRepository | undefined;
let search: MailSearchStore | undefined;
let savedSearch:MailSavedSearchStore|undefined;
let extraction:MailExtractionStore|undefined,extractionRunner:MailExtractionRunner|undefined,closingExtraction:Promise<void>|undefined;
let searchIndexer: MailSearchIndexer | undefined;
let controller: MailConnectionController | undefined;
let closingController: Promise<void> | undefined;
let credentials: MailCredentialRepository | undefined;
let syncLifecycle: MailSyncLifecycle | undefined;
let imap:ImapBackfill|undefined;
let closingImap:Promise<void>|undefined;


let access: MailAccessCoordinator | undefined;
let closingSync: Promise<void> | undefined;
let imapConnectId: string | undefined;
const imapRequests = new Map<string, number>();
const providerSettings = new Map<string, MailOAuthSettings>();
const requests = new Set<Promise<void>>();
const locked = new Error("mail_archive_locked");
const unsupported = new Error("mail_provider_unsupported");
let lifecycleSuspended=false;
let lifecycleChange:Promise<void>=Promise.resolve();
let phase: "waiting" | "opening" | "ready" | "closing" = "waiting";
let input = Buffer.alloc(0);
let opening: Promise<void> | undefined;
let exitCode = 0;
function isClosing(): boolean { return phase === "closing"; }
// Shutdown cannot wait indefinitely for a misbehaving native opener or a blocked parent pipe.
let exitTimer: ReturnType<typeof setTimeout> | undefined;

function write(message: WorkerMessage): boolean {
  const encoded = JSON.stringify(message);
  if (Buffer.byteLength(encoded) > MAX_WORKER_MESSAGE_BYTES || !parseWorkerMessage(encoded)) return false;
  if (process.stdout.writableLength > 4 * MAX_WORKER_MESSAGE_BYTES) { shutdown(1); return false; }
  process.stdout.write(`${encoded}\n`);
  return true;
}
async function finish(): Promise<void> {
  try{await(closingOutbox??outboxRunner?.close());}catch{exitCode=1;}
  try{await(closingDraftSync??draftSyncRunner?.close());}catch{exitCode=1;}
  try{await(closingExtraction??extractionRunner?.close());}catch{exitCode=1;}
  try { await (closingController ?? controller?.close()); } catch { exitCode = 1; }
  try { await (closingSync ?? syncLifecycle?.close()); } catch { exitCode = 1; }
  try{await(closingImap??imap?.close());}catch{exitCode=1;}

  try{await(closingPortability??portability?.close());}catch{exitCode=1;}
  await Promise.allSettled(requests);
  controller = undefined;
  credentials = undefined;
  syncLifecycle = undefined;
  imap=undefined;
  access = undefined;
  providerSettings.clear(); imapRequests.clear(); imapConnectId = undefined;
  try { database?.close(); } catch { exitCode = 1; }
  database = undefined;
  repository = undefined;
  reads = undefined;
  process.stdout.end(() => { clearTimeout(exitTimer); process.exit(exitCode); });
}
function shutdown(code = 0): void {
  searchIndexer?.close();
  exitCode = Math.max(exitCode, code);
  if (phase === "closing") return;
  phase = "closing";
  // Stop every network runner before awaiting any individual teardown.
  closingOutbox=outboxRunner?.close();
  closingDraftSync=draftSyncRunner?.close();
  // close() marks the controller closed synchronously, before any queued continuation.
  closingPortability=portability?.close();
  closingExtraction=extractionRunner?.close();
  closingController = controller?.close();
  closingSync = syncLifecycle?.close();
  closingImap=imap?.close();
  access?.close();
  input = Buffer.alloc(0);
  process.stdin.pause();
  exitTimer = setTimeout(() => process.exit(1), 2000);
  if (opening) void opening.finally(finish);
  else void finish();
}
function fatal(code: "initialization_failed" | "protocol_error"): void {
  write({ kind: "fatal", code });
  shutdown(1);
}

async function initialize(value: WorkerInitialization): Promise<void> {
  let key: Buffer | undefined;
  try {
    if (!value.ownerId || value.ownerId.length > 4096 || !value.databasePath || !isAbsolute(value.databasePath)
      || value.databasePath.includes("\0") || typeof value.encryptionKey !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value.encryptionKey)
      || (value.credentials?.length ?? 0) > 0) throw new Error("invalid_initialization");
    key = Buffer.from(value.encryptionKey, "base64");
    if (key.length !== 32 || key.toString("base64") !== value.encryptionKey) throw new Error("invalid_key");
    database = await openEncryptedMailDatabase({ path: value.databasePath, key });
    if (phase === "closing") return;
    migrateMailSchema(database);
    assertMailSchema(database);
    ownerId=value.ownerId;
    database.run("UPDATE mail_storage_saves SET state='uncertain',error='restart_review',revision=revision+1 WHERE state IN ('queued','uploading')");
    database.run("UPDATE mail_storage_save_parts SET state='uncertain' WHERE state='uploading'");
    database.run("UPDATE mail_matter_filings SET state='uncertain',error='restart_review',revision=revision+1 WHERE state IN ('queued','uploading')");
    portability=new MailPortabilityStore(database,value.ownerId);retention=new MailRetentionStore(database,value.ownerId);
    repository = new MailRepository(database, value.ownerId);
    local=new MailLocalApiStore(database,value.ownerId);
    reads = new MailReadStore(database, value.ownerId);
    mailboxes = new GraphMailboxRepository(database,value.ownerId);
    search = new MailSearchStore(database, value.ownerId);
    savedSearch=new MailSavedSearchStore(database,value.ownerId);
    searchIndexer = new MailSearchIndexer(database,value.ownerId);
    extraction=new MailExtractionStore(database,value.ownerId);extractionRunner=new MailExtractionRunner(database,value.ownerId);
    credentials = new MailCredentialRepository(database, value.ownerId);
    controller = new MailConnectionController({ database, ownerId: value.ownerId, onConnected: async (accountId, settings) => {
      const binding = credentials!.getBinding(accountId);
      providerSettings.set(`${binding.provider}:${binding.clientId}:${binding.authority}`, settings);
      await syncLifecycle!.connected(accountId);
      for(const child of mailboxes?.children(accountId)??[])if(credentials!.status(child).state==='connected')await syncLifecycle!.connected(child);
    } });
    access = new MailAccessCoordinator({ database, ownerId: value.ownerId, loadProviderSettings: async binding => {
      const selected = providerSettings.get(`${binding.provider}:${binding.clientId}:${binding.authority}`);
      if (!selected) throw new Error("mail_configuration_unavailable");
      return selected;
    } });
    syncLifecycle = new MailSyncLifecycle(database, value.ownerId, access);
    lifecycleSuspended=value.lifecycleSuspended===true;if(lifecycleSuspended)await syncLifecycle.suspendAll();
    imap=new ImapBackfill({database,ownerId:value.ownerId});

    draftSyncStore=new DraftSyncStore(database,value.ownerId);draftSyncRunner=new DraftSyncRunner({database,ownerId:value.ownerId,access});
    phase = "ready";
    if(!lifecycleSuspended)draftSyncRunner.start();else await draftSyncRunner.suspend();
    outboxStore=new OutboxStore(database,value.ownerId);outboxRunner=new OutboxRunner({database,ownerId:value.ownerId,access});outboxRunner.recover();if(!lifecycleSuspended)outboxRunner.resume();else await outboxRunner.suspend();
    searchIndexer?.start();extractionRunner?.start();
    write({ kind: "ready", protocol: 1, runtime: "node", nodeVersion: process.versions.node });
  } catch {
    if (phase !== "closing") fatal("initialization_failed");
  } finally { key?.fill(0); }
}

/** Cap encoded results as well as SQL row count; never advance beyond the last returned row. */
function pageResult(id: string, items: WorkerAccount[], hasMore: boolean): WorkerResult | undefined;
function pageResult(id: string, items: WorkerFolder[], hasMore: boolean, folders: true): WorkerResult | undefined;
function pageResult(id: string, items: WorkerAccount[] | WorkerFolder[], hasMore: boolean, folders?: true): WorkerResult | undefined {
  const selectedAccounts: WorkerAccount[] = [];
  const selectedFolders: WorkerFolder[] = [];
  let accepted: WorkerResult = folders ? { folders: [], nextCursor: null } : { accounts: [], nextCursor: null };
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if ("provider" in item) selectedAccounts.push(item); else selectedFolders.push(item);
    const nextCursor = hasMore || index < items.length - 1 ? item.id : null;
    const candidate: WorkerResult = folders ? { folders: [...selectedFolders], nextCursor } : { accounts: [...selectedAccounts], nextCursor };
    if (Buffer.byteLength(JSON.stringify({ kind: "response", id, ok: true, result: candidate })) > MAX_WORKER_MESSAGE_BYTES) return index === 0 ? undefined : accepted;
    accepted = candidate;
  }
  return accepted;
}
async function request(message: Extract<ParentMessage, { kind: "request" }>): Promise<void> {
  if (phase !== "ready" || !repository || !reads || !controller || !credentials || !syncLifecycle || !imap || !database) {
    write({ kind: "response", id: message.id, ok: false, code: "not_ready" }); return;
  }
  const command = message.command;
  try {
    let result: WorkerResult | undefined;
    switch (command.operation) {
      case "mail.agent.control":{
       const agentDatabase=database,agentReads=reads,grants=new MailAgentGrants(agentDatabase,ownerId);
       if(command.input.action==='save-draft'){
        const input=agentControlSchema.parse(command.input);if(input.action!=='save-draft'||!local)throw locked;
        result={agent:agentDatabase.transaction(()=>{const grant=grants.check(input.grantId,input.revision,'draft');
         if(input.input.content.attachments.length||input.input.content.html!==null||grant.matterId&&!input.source)throw locked;
         if(grant.matterId){if(!input.source||!input.sourceVersion)throw locked;new MailFilingStore(agentDatabase,ownerId).execute({action:'source-version',accountId:grant.accountId,locator:input.source,expected:input.sourceVersion});}
         if(input.input.expected!==null){const bound=grants.execute({action:'draft-source',grantId:grant.id,draftId:input.input.draftId});if(JSON.stringify(bound.source)!==JSON.stringify(input.source)||bound.sourceVersion!==input.sourceVersion)throw locked;}
         new SenderIdentityRepository(agentDatabase,ownerId).assertSender(grant.accountId,input.input.content);
         const draft=local?.saveDraft(grant.accountId,input.input);if(!draft)throw locked;
         if(input.input.expected===null)grants.execute({action:'draft-bind',grantId:grant.id,draftId:draft.id,source:input.source,sourceVersion:input.sourceVersion});return{draft};
        })};break;
       }
       if(command.input.action!=='approve'){result={agent:grants.execute(command.input)};break;}
       if(!local||!outboxStore)throw locked;
       const proposalId=command.input.id,proposal=grants.execute({action:'proposal',id:proposalId}).proposal;if(!proposal)throw locked;
       const payload=proposal.payload;
       const check=()=>{const current=grants.execute({action:'proposal',id:proposalId}).proposal;if(!current||current.state!=='pending'||current.expiresAt<=Date.now())throw locked;const grant=grants.check(current.grantId,current.grantRevision,payload.kind==='send'?'propose_send':'propose_delete');if(grant.matterId){const locator=payload.kind==='send'?payload.source:payload.locator;if(!locator||!payload.sourceVersion)throw locked;new MailFilingStore(agentDatabase,ownerId).execute({action:'source-version',accountId:grant.accountId,locator,expected:payload.sourceVersion});}
        if(payload.kind==='trash'&&agentHash(JSON.stringify(agentReads.read(proposal.accountId,payload.locator)))!==payload.contentHash)throw locked;
        if(payload.kind==='send'){const draft=local?.readDraft(proposal.accountId,{draftId:payload.draftId});if(!draft||draft.version.generation!==payload.version.generation||draft.version.revision!==payload.version.revision||agentHash(JSON.stringify(draft.content))!==payload.contentHash)throw locked;}
       };
       const commit=(actionId:string)=>{grants.execute({action:'decide',id:proposalId,approve:true,actionId});};
       if(payload.kind==='send'){await outboxStore.queue(proposal.accountId,{draftId:payload.draftId,version:payload.version,replayKey:'agent:'+proposalId},{check,commit});if(!lifecycleSuspended)void outboxRunner?.run().catch(()=>{});}
       else{agentDatabase.transaction(()=>{check();const action=local?.enqueueMutation(proposal.accountId,{replayKey:'agent:'+proposalId,locator:payload.locator,precondition:payload.precondition,change:{kind:'special',operation:'trash'}});if(!action)throw locked;commit(action.id);});if(!lifecycleSuspended)syncLifecycle.engine(proposal.accountId).wake(proposal.accountId);}
       result={agent:grants.execute({action:'proposal',id:proposalId})};break;
      }
      case "mail.storage.save":result={storageSave:new MailStorageSaveStore(database,ownerId).execute(command.input)};break;
      case "mail.filing":result={filing:new MailFilingStore(database,ownerId).execute(command.input)};break;
      case 'mail.notifications.poll':result={notifications:lifecycleSuspended?{items:[],suppressed:0}:new MailNotificationStore(database,ownerId).poll(command.input)};break;
      case 'mail.lifecycle.status':result={lifecycle:{state:lifecycleSuspended?'suspended':'running'}};break;
      case 'mail.lifecycle.set':{
        lifecycleSuspended=command.input.suspended;
        const suspended=command.input.suspended;
        lifecycleChange=lifecycleChange.catch(()=>{}).then(async()=>{if(phase==='closing')return;if(suspended){await Promise.all([syncLifecycle?.suspendAll(),draftSyncRunner?.suspend(),outboxRunner?.suspend()]);}else{syncLifecycle?.resumeAll();draftSyncRunner?.resume();outboxRunner?.resume();}});
        await lifecycleChange;result={lifecycle:{state:lifecycleSuspended?'suspended':'running'}};break;
      }
      case 'mail.smtp.status':result={smtp:new SmtpCustody(database,ownerId).status(command.accountId)};break;
      case 'mail.smtp.configure':new SmtpCustody(database,ownerId).configure(command.accountId,command.input);result={smtp:new SmtpCustody(database,ownerId).status(command.accountId)};break;
      case 'mail.smtp.remove':new SmtpCustody(database,ownerId).remove(command.accountId);result={smtp:new SmtpCustody(database,ownerId).status(command.accountId)};break;
      case 'mail.outbox.list':if(!outboxStore)throw locked;result={outbox:outboxStore.list(command.accountId)};break;
      case 'mail.outbox.queue':if(!outboxStore)throw locked;result={outboxItem:await outboxStore.queue(command.accountId,command.input)};if(!lifecycleSuspended)void outboxRunner?.run().catch(()=>{});break;
      case 'mail.outbox.action':if(!outboxStore||!outboxRunner)throw locked;result={outboxItem:command.input.action==='reconcile'?await outboxRunner.reconcile(command.accountId,command.input.actionId):command.input.action==='retry'?outboxStore.retry(command.accountId,command.input.actionId):outboxStore.cancel(command.accountId,command.input.actionId)};if(!lifecycleSuspended)void outboxRunner.run().catch(()=>{});break;
      case 'mail.retention.read':if(!retention)throw locked;result={retention:retention.settings(command.accountId)};break;
      case 'mail.retention.preview':if(!retention)throw locked;result={retention:retention.preview(command.accountId,command.input)};break;
      case 'mail.retention.settings':if(!retention)throw locked;result={retention:retention.settings(command.accountId,command.input)};break;
      case 'mail.retention.apply':if(!retention||!lifecycleSuspended)throw new MailRetentionError('locked');await lifecycleChange;if(!lifecycleSuspended||isClosing()||portability?.busy())throw locked;result={retention:retention.apply(command.accountId,command.input)};break;
      case 'mail.portability.list':if(!portability)throw locked;result={portability:portability.list()};break;
      case 'mail.portability.import':if(!portability)throw locked;result={portability:await portability.startImport(command.path,command.format,command.label)};break;
      case 'mail.portability.export':if(!portability)throw locked;result={portability:await portability.startExport(command.path,command.accountId,command.format)};break;
      case 'mail.portability.resume':if(!portability)throw locked;result={portability:portability.resume(command.id)};break;
      case 'mail.portability.abandon':if(!portability)throw locked;result={portability:portability.abandon(command.id)};break;
      case 'mail.portability.pause':if(!portability)throw locked;result={portability:portability.pause(command.id)};break;
      case 'mail.senders.list': result={senders:new SenderIdentityRepository(database,ownerId).list(command.accountId)};break;
      case 'mail.senders.configure': result={senders:new SenderIdentityRepository(database,ownerId).configure(command.accountId,command.input)};break;
      case 'mail.senders.settings': result={senders:new SenderIdentityRepository(database,ownerId).settings(command.accountId,command.input)};break;
      case 'mail.senders.refresh': {
        const senders=new SenderIdentityRepository(database,ownerId);
        const provider=database.get('SELECT provider FROM mail_accounts WHERE id=? AND owner_id=?',[command.accountId,ownerId])?.provider;
        if(provider==='imap'||provider==='graph'&&mailboxes?.read(command.accountId)){result={senders:senders.list(command.accountId)};break;}
        if(!access)throw locked;
        senders.invalidate(command.accountId);
        const binding=credentials.getBinding(command.accountId);
        if(command.settings){if(command.settings.provider!==provider||binding.clientId!==command.settings.clientId||binding.authority!==(command.settings.provider==='gmail'?'https://accounts.google.com':`https://login.microsoftonline.com/${command.settings.tenantId}/v2.0`))throw unsupported;providerSettings.set(`${binding.provider}:${binding.clientId}:${binding.authority}`,command.settings);}
        const granted=await access.acquire(command.accountId);
        const settings=providerSettings.get(`${binding.provider}:${binding.clientId}:${binding.authority}`);if(!settings)throw unsupported;
        const identity=await discoverMailIdentity({settings,accessToken:granted.accessToken,grantedScopes:granted.grantedScopes});
        if(identity.providerSubject!==binding.providerSubject||identity.authority!==binding.authority)throw locked;
        const found=provider==='gmail'?await new GmailReadTransport({accessToken:granted.accessToken}).listSendAs():[{address:identity.email,displayName:identity.displayName??'',primary:true,default:true}];
        if(!found.some(value=>value.primary&&value.address.toLowerCase()===identity.email.toLowerCase()))throw locked;
        result={senders:senders.replace(command.accountId,granted.version.generation,found)};break;
      }
      case 'mail.graph.mailbox.configure': {
        if(!mailboxes||!access)throw locked;
        if(mailboxes.read(command.input.credentialAccountId))throw locked;
        const granted=await access.acquire(command.input.credentialAccountId);
        if(!granted.grantedScopes?.some(scope=>['Mail.Read.Shared','Mail.ReadWrite.Shared','https://graph.microsoft.com/Mail.Read.Shared','https://graph.microsoft.com/Mail.ReadWrite.Shared'].includes(scope)))throw unsupported;
        const transport=new GraphReadTransport({accessToken:granted.accessToken,mailboxAddress:command.input.address});
        try { await transport.getFolder('msgfolderroot'); } catch(error) {
          if(error instanceof GraphTransportError&&error.code==='inaccessible'){const existing=mailboxes.configuredAccount(command.input.credentialAccountId,command.input.address);if(existing){mailboxes.revoke(existing);await syncLifecycle.suspend(existing);}throw locked;}
          throw error;
        }
        const current=credentials.status(command.input.credentialAccountId);
        if(current.state!=='connected'||current.version.generation!==granted.version.generation||current.version.revision!==granted.version.revision)throw locked;
        const configured=mailboxes.configure(command.input);
        if(!configured.identity)throw locked;
        await syncLifecycle?.suspend(configured.accountId);
        result={graphMailbox:{accountId:configured.accountId,identity:configured.identity}};break;
      }
      case "mail.badge.count": result = { unreadInboxCount: reads.unreadInboxCount() }; break;
      case 'mail.extraction.status':if(!extraction)throw locked;result={extraction:extraction.status(command.accountId,command.input)};break;
      case 'mail.extraction.read':if(!extraction)throw locked;result={extractionText:extraction.read(command.accountId,command.input)};break;
      case 'mail.extraction.reset':if(!extraction)throw locked;result={extraction:extraction.reset(command.accountId,command.input)};break;
      case "mail.search.saved":if(!savedSearch)throw locked;result={savedSearch:savedSearch.execute(command.input)};break;
      case "mail.search": if (!search) throw locked; result = {search:search.search(command.input)}; break;
      case "mail.search.rebuild": if (!search) throw locked; result = {rebuilt:search.rebuild(command.input)}; break;
      case "mail.draft.sync.read":if(!draftSyncStore)throw locked;result={draftSync:draftSyncStore.status(command.accountId,command.input.draftId)};break;
      case "mail.draft.sync.request":if(!draftSyncStore)throw locked;result={draftSync:draftSyncStore.request(command.accountId,command.input)};if(!lifecycleSuspended)draftSyncRunner?.wake();break;
      case "mail.local.draft.upload": if(!local)throw locked;result={local:{operation:command.operation,accountId:command.accountId,value:local.uploadDraft(command.accountId,command.input)}};break;
      case "mail.local.draft.save": if(!local)throw locked;result={local:{operation:command.operation,accountId:command.accountId,value:local.saveDraft(command.accountId,command.input)}};break;
      case "mail.local.draft.read": if(!local)throw locked;result={local:{operation:command.operation,accountId:command.accountId,value:local.readDraft(command.accountId,command.input)}};break;
      case "mail.local.draft.delete": if(!local)throw locked;result={local:{operation:command.operation,accountId:command.accountId,value:local.deleteDraft(command.accountId,command.input)}};break;
      case "mail.local.draft.attachment": if(!local)throw locked;result={local:{operation:command.operation,accountId:command.accountId,value:local.readDraftAttachment(command.accountId,command.input)}};break;
      case "mail.local.draft.list": if(!local)throw locked;result={local:{operation:command.operation,accountId:command.accountId,value:local.listDrafts(command.accountId,command.input)}};break;
      case "mail.local.action.submission": if(!local||!outboxStore)throw locked;{const item=await outboxStore.queue(command.accountId,command.input);result={local:{operation:command.operation,accountId:command.accountId,value:local.readAction(command.accountId,item.id)}};if(!lifecycleSuspended)void outboxRunner?.run().catch(()=>{});}break;
      case "mail.local.action.mutation": if(!local)throw locked;result={local:{operation:command.operation,accountId:command.accountId,value:local.enqueueMutation(command.accountId,command.input)}};if(!lifecycleSuspended)syncLifecycle.engine(command.accountId).wake(command.accountId);break;
      case "mail.local.action.read": if(!local)throw locked;result={local:{operation:command.operation,accountId:command.accountId,value:local.readAction(command.accountId,command.input.actionId)}};break;
      case "mail.local.action.list": if(!local)throw locked;result={local:{operation:command.operation,accountId:command.accountId,value:local.listActions(command.accountId,command.input)}};break;
      case "mail.local.action.cancel": if(!local)throw locked;result={local:{operation:command.operation,accountId:command.accountId,value:local.cancelAction(command.accountId,command.input)}};break;
      case "mail.local.events": if(!local)throw locked;result={local:{operation:command.operation,accountId:command.accountId,value:local.events(command.accountId,command.input)}};break;
      case "ping": result = { pong: true }; break;
      case "mail.storage.status": result = { encrypted: true, schemaVersion: MAIL_SCHEMA_VERSION, syncSupported: true }; break;
      case "mail.imap.discovery":result={imapDiscovery:imap.discovery(command.accountId,command.after)};break;
      case "mail.imap.cancel": {
        for (const [id, expiry] of imapRequests) if (expiry < Date.now()) imapRequests.delete(id);
        if (!imapRequests.has(command.requestId) && imapRequests.size >= 128) throw new Error("mail_imap_busy");
        imapRequests.set(command.requestId, Date.now()+600000);
        if (imapConnectId === command.requestId) imap.cancelConnect();
        result = {cancelled:true}; break;
      }
      case "mail.imap.connect": {
        for (const [id, expiry] of imapRequests) if (expiry < Date.now()) imapRequests.delete(id);
        if (command.requestId && imapRequests.has(command.requestId)) {result={imapConnection:{error:"cancelled"}};break;}
        if (imapConnectId || imapRequests.size >= 128) {result={imapConnection:{error:"busy"}};break;}
        imapConnectId=command.requestId;
        if (command.requestId) imapRequests.set(command.requestId,Date.now()+600000);
        try {const connected = await imap.connect(command.input); await syncLifecycle.connected(connected.accountId); result={imapConnection:connected};}
        catch(error) {result={imapConnection:{error:imapFailure(error).code}};}
        finally {imapConnectId=undefined;}
        break;
      }
      case "mail.connection.begin":
        result = { connectionStarted: await controller.begin(command.settings, { reconnectAccountId: command.reconnectAccountId }) }; break;
      case "mail.connection.poll": result = { connection: controller.poll(command.connectionId) }; break;
      case "mail.connection.cancel": await controller.cancel(command.connectionId); result = { cancelled: true }; break;
      case "mail.account.disconnect": {
        const current = credentials.status(command.accountId); // Owner gate before provider lookup or cancellation.
        extractionRunner?.cancelAccount(command.accountId);
        // close() fences callbacks synchronously; revoke credentials before awaiting I/O cleanup.
        const stopping = Promise.all([command.accountId,...(mailboxes?.children(command.accountId)??[])].map(id=>{extractionRunner?.cancelAccount(id);return syncLifecycle!.suspend(id).catch(()=>{});}));
        if (database.get("SELECT provider FROM mail_accounts WHERE id=?", [command.accountId])?.provider === 'imap') {
          if (!current.version) throw locked;
          credentials.disconnect(command.accountId, current.version);
          new SmtpCustody(database,ownerId).remove(command.accountId);
        } else await controller.disconnect(command.accountId);
        await stopping;
        result = { disconnected: true }; break;
      }
      case "mail.accounts.list": {
        const page = repository.listAccountsPage({ limit: command.limit, after: command.after });
        result = pageResult(message.id, page.items.map((account) => ({ id: account.id, provider: account.provider, displayName: account.display_name, ...(account.provider === 'graph' && mailboxes?.identity(account.id) ? {identity:mailboxes.identity(account.id)} : {}), ...(account.provider === "graph" && credentials!.status(account.id).version ? {personal: credentials!.getBinding(account.id).authority === "https://login.microsoftonline.com/consumers/v2.0"} : {}) })), page.hasMore);
        break;
      }
      case "mail.folders.list": {
        const folderDatabase=database;
        if (credentials.status(command.accountId).state === "disconnected") throw locked;
        const page = repository.listFoldersPage(command.accountId, { limit: command.limit, after: command.after });
        result = pageResult(message.id, page.items.map((folder) => ({ id: folder.id, name: folder.name, kind: folder.kind, parentId: folder.parent_id, mutationPrecondition:storedFolderMutationPrecondition(folderDatabase,command.accountId,folder.id), ...(folder.role ? {role: folder.role} : {}) })), page.hasMore, true);
        break;
      }
      case "mail.sync.provider":
      case "mail.status":
      case "mail.sync.resume":
      case "mail.sync.start":
      case "mail.sync.stop": {
        const credentialStatus = credentials.status(command.accountId);
        const provider = database.get("SELECT provider FROM mail_accounts WHERE id=?", [command.accountId])?.provider;
        if(provider==='archive'&&command.operation==='mail.status'){
          const job=database.get("SELECT state,completed,failed FROM mail_portability_jobs WHERE account_id=? AND direction='import' ORDER BY rowid DESC LIMIT 1",[command.accountId]);
          const count=typeof job?.completed==='number'?job.completed:0,failed=typeof job?.failed==='number'?job.failed:0;
          result={sync:{accountId:command.accountId,provider:'archive',state:job?.state==='running'?'syncing':job?.state==='paused'||job?.state==='interrupted'?'paused':job?.state==='attention'?'attention':'complete',enumerated:count,downloaded:count,projected:Math.max(0,count-failed),removed:0,retained:count,failed,pending:0,nextRetryAt:null,error:failed?'content_incomplete':null}};break;
        }
        if (provider !== "gmail" && provider !== "graph" && provider !== "imap") throw unsupported;
        if (command.operation === "mail.sync.provider") { result = { syncProvider: provider, connected: credentialStatus.state === "connected", ...(provider === "graph" && credentialStatus.version ? {personal: credentials.getBinding(command.accountId).authority === "https://login.microsoftonline.com/consumers/v2.0"} : {}) }; break; }
        if (credentialStatus.state === 'disconnected') throw locked;
        const engine = syncLifecycle.engine(command.accountId);
        if(lifecycleSuspended&&command.operation==='mail.sync.start'){result={sync:engine.status(command.accountId)};break;}
        if(provider==='imap'){result={sync:command.operation==='mail.sync.resume'?syncLifecycle.resume(command.accountId):command.operation==='mail.sync.start'?engine.start(command.accountId):command.operation==='mail.sync.stop'?engine.pause(command.accountId):engine.status(command.accountId)};break;}

        if (command.operation === "mail.sync.start" || command.operation === "mail.sync.resume") {
          if(!command.settings)throw unsupported;
          const binding = credentials.getBinding(command.accountId);
          if (command.settings.provider !== provider || binding.clientId !== command.settings.clientId
            || binding.authority !== (command.settings.provider === "gmail" ? "https://accounts.google.com" : `https://login.microsoftonline.com/${command.settings.tenantId}/v2.0`)) throw new Error("mail_configuration_mismatch");
          providerSettings.set(`${provider}:${binding.clientId}:${binding.authority}`, command.settings);
          result = { sync: command.operation === "mail.sync.resume" ? syncLifecycle.resume(command.accountId) : engine.start(command.accountId) };
        } else result = { sync: command.operation === "mail.sync.stop" ? engine.pause(command.accountId) : engine.status(command.accountId) };
        break;
      }
      case "mail.messages.list":
      case "mail.messages.read":
      case "mail.parts.list":
      case "mail.content.read": {
        if (credentials.status(command.accountId).state === "disconnected") throw locked;
        if (command.operation === "mail.messages.read") result = { message: reads.read(command.accountId, command.locator) };
        else if (command.operation === "mail.content.read") result = { content: reads.chunk(command.accountId, command.locator, command.request) };
        else {
          const page: { messages: ReturnType<MailReadStore["list"]> } | { parts: ReturnType<MailReadStore["parts"]> } = command.operation === "mail.messages.list" ? { messages: reads.list(command.accountId, command.page) } : { parts: reads.parts(command.accountId, command.locator, command.page) };
          // Bound the encoded response while preserving the last returned key as continuation.
          const collection = "messages" in page ? page.messages : page.parts;
          const hadItems = collection.items.length > 0;
          while (collection.items.length && Buffer.byteLength(JSON.stringify({ kind: "response", id: message.id, ok: true, result: page })) > MAX_WORKER_MESSAGE_BYTES) {
            collection.items.pop();
            if(command.operation === "mail.messages.list" && command.page.order === "received" && "messages" in page){
              const last=page.messages.items.at(-1);page.messages.nextCursor=last?JSON.stringify([last.receivedAt??null,last.key]):null;
            }else collection.nextCursor = collection.items.at(-1)?.key ?? null;
          }
          result = hadItems && collection.items.length === 0 ? undefined : page;
        }
        break;
      }
      case "credentials.update":
        write({ kind: "response", id: message.id, ok: false, code: "unsupported" }); return;
    }
    if(result&&'local' in result){
      const localResult=result.local;
      if(localResult.operation==='mail.local.events'){
        const page=localResult.value;
        while(page.items.length&&Buffer.byteLength(JSON.stringify({kind:'response',id:message.id,ok:true,result}))>MAX_WORKER_MESSAGE_BYTES){
          page.items.pop();page.hasMore=true;
          if(page.items.length)page.nextCursor=page.items.at(-1)!.sequence;else{result=undefined;break;}
        }
      }else if(localResult.operation==='mail.local.draft.list'||localResult.operation==='mail.local.action.list'){
        const page=localResult.value;
        while(page.items.length&&Buffer.byteLength(JSON.stringify({kind:'response',id:message.id,ok:true,result}))>MAX_WORKER_MESSAGE_BYTES){
          page.items.pop();page.nextCursor=page.items.at(-1)?.id??null;
          if(!page.items.length){result=undefined;break;}
        }
      }
    }
    if (isClosing()) return;
    if (!result || Buffer.byteLength(JSON.stringify({ kind: "response", id: message.id, ok: true, result })) > MAX_WORKER_MESSAGE_BYTES) {
      write({ kind: "response", id: message.id, ok: false, code: "response_too_large" }); return;
    }
    if (!write({ kind: "response", id: message.id, ok: true, result })) write({ kind: "response", id: message.id, ok: false, code: "operation_failed" });
  } catch (error) {
    if(error instanceof MailRetentionError&&!isClosing()){write({kind:'response',id:message.id,ok:true,result:{retentionFailure:error.code}});return;}
    if(error instanceof OutboxError&&!isClosing()&&(command.operation.startsWith('mail.outbox.')||command.operation.startsWith('mail.smtp.'))){write({kind:'response',id:message.id,ok:true,result:{outboxFailure:error.code}});return;}
    // Do not echo SQLite/provider errors, row contents, supplied IDs, paths or key material.
    if (isClosing()) return;
    const code = error instanceof DraftSyncError?error.code:error instanceof SavedSearchError?error.code:error instanceof MailExtractionStorageError&&error.code==="locked"?"locked":error instanceof MailExtractionStorageError&&error.code==="not_found"?"not_found":error instanceof ImapError&&error.code==="locked"?"locked":error instanceof ImapError&&error.code==="too_large"?"response_too_large":error instanceof ImapError&&error.code==="invalid_input"?"invalid_input":error instanceof MailLocalError&&error.code==="conflict"?"conflict":error instanceof MailLocalError&&error.code==="invalid_input"?"invalid_input":error instanceof MailLocalError&&error.code==="locked"?"locked":error instanceof MailLocalError&&error.code==="not_found"?"not_found":error === unsupported || (error instanceof MailSearchError && error.code === "unsupported") ? "unsupported" : error === locked || (error instanceof MailSearchError && error.code === "locked") || ((error instanceof GmailBackfillError || error instanceof GraphBackfillError) && error.code === "locked")
      || (error instanceof MailCredentialError && error.code === "disconnected") ? "locked" :
      (error instanceof MailConnectionError && (error.code === "not_found" || error.code === "account_not_found"))
      || (error instanceof MailCredentialError && error.code === "account_not_found")
      || ((error instanceof GmailBackfillError || error instanceof GraphBackfillError) && error.code === "not_found")
      || (error instanceof MailSearchError && error.code === "not_found")
      || (error instanceof Error && ["Mail account not found", "Mail message not found", "Mail content not found"].includes(error.message)) ? "not_found" : "operation_failed";
    write({ kind: "response", id: message.id, ok: false, code });
  }
}
function receive(message: ParentMessage): void {
  if (phase === "closing") return;
  if (message.kind === "shutdown") { shutdown(); return; }
  if (message.kind === "initialize") {
    if (phase !== "waiting") { fatal("protocol_error"); return; }
    phase = "opening";
    opening = initialize(message.initialization);
    return;
  }
  if (requests.size >= 64) { write({ kind: "response", id: message.id, ok: false, code: "operation_failed" }); return; }
  const pending = request(message);
  requests.add(pending);
  void pending.finally(() => requests.delete(pending));
}
process.stdin.on("data", (chunk: Buffer) => {
  if (phase === "closing") return;
  input = Buffer.concat([input, chunk]);
  let newline = input.indexOf(10);
  while (newline !== -1) {
    if (newline > MAX_WORKER_MESSAGE_BYTES) { fatal("protocol_error"); return; }
    const message = parseParentMessage(input.subarray(0, newline).toString("utf8"));
    input = input.subarray(newline + 1);
    if (!message) { fatal("protocol_error"); return; }
    receive(message);
    if (isClosing()) return;
    newline = input.indexOf(10);
  }
  if (input.length > MAX_WORKER_MESSAGE_BYTES) fatal("protocol_error");
});
process.stdin.on("end", () => shutdown(input.length > 0 ? 1 : 0));
process.stdin.on("error", () => shutdown(1));
process.stdout.on("error", () => shutdown(1));
process.on("SIGTERM", () => shutdown());
process.on("SIGINT", () => shutdown());
process.on("uncaughtException", () => shutdown(1));
process.on("unhandledRejection", () => shutdown(1));
