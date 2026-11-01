import { ApiError } from '../errors.js';
import type { MailService } from '../mail/service-interface.js';
import { MailServiceError } from '../mail/service-interface.js';
import { MailProjectError, mailProjectCatalogSchema, mailProjectDisplaySchema, mailProjectDisplayHistorySchema, mailProjectHostInputSchema, mailProjectResultMatches, type MailProjectCommand, type MailProjectReference, type MailProjectDestination, type MailProjectAssociation } from '../mail/project-association-view.js';
import { isMailLoopback, readMailBody } from './mail.js';
import { addRoute, type Route } from './registry.js';

type Options = { routes: Route[]; host: string; mail?: MailService; ensureWritable: () => void; projects: () => string[]; resolve: (id: string) => Promise<MailProjectDestination> };
export function registerMailProjectRoutes({ routes, host, mail, ensureWritable, projects, resolve }: Options) {
  const association = mail?.projectAssociation?.bind(mail);
  if (!mail || !association || !isMailLoopback(host)) return;
  const requestAssociation = association;
  async function execute(command: MailProjectCommand) {
    const result = await requestAssociation(command);
    if (!mailProjectResultMatches(command, result)) throw new MailProjectError('unavailable');
    return result;
  }
  async function visible(reference: MailProjectReference | null) {
    if (!reference) return { project: null, unavailable: false };
    try {
      const project = await resolve(reference.id);
      if (project.id === reference.id && project.binding === reference.binding) return { project, unavailable: false };
    } catch { /* Do not expose inaccessible project names or paths. */ }
    return { project: null, unavailable: true };
  }
  async function display(record: MailProjectAssociation) { return mailProjectDisplaySchema.parse({ ...record, ...await visible(record.project) }); }
  addRoute(routes, 'POST', '/mail/v1/projects', 'host-token', async ctx => {
    if (ctx.actor?.type !== 'host') throw new ApiError(401, 'unauthorized', 'Invalid host token');
    let request: unknown;
    try { request = JSON.parse(await readMailBody(ctx.request, 24000)); } catch { throw new ApiError(400, 'mail_project_invalid', 'Invalid project association request'); }
    const parsed = mailProjectHostInputSchema.safeParse(request);
    if (!parsed.success) throw new ApiError(400, 'mail_project_invalid', 'Invalid project association request');
    if (mail.status().state !== 'ready') throw new ApiError(423, 'mail_locked', 'Mail storage is locked');
    const input = parsed.data;
    try {
      let value: unknown;
      if (input.action === 'catalog') {
        const candidates = [...new Set(projects())].filter(id => !input.after || id > input.after).sort().slice(0, 21);
        const rows = await Promise.all(candidates.slice(0, 20).map(async id => { try { const row = await resolve(id); return row.id === id ? row : null; } catch { return null; } }));
        value = mailProjectCatalogSchema.parse({ items: rows.filter(row => row !== null), nextCursor: candidates.length > 20 ? candidates[19] : null });
      } else if (input.action === 'read') {
        const result = await execute({ operation: 'mail.project.read', accountId: input.accountId, input: input.input });
        if (!('projectAssociation' in result)) throw new MailProjectError('unavailable');
        value = await display(result.projectAssociation);
      } else if (input.action === 'set') {
        ensureWritable();
        if (input.input.project) {
          const current = await resolve(input.input.project.id);
          if (current.id !== input.input.project.id || current.binding !== input.input.project.binding) throw new MailProjectError('conflict');
        }
        ensureWritable();
        const result = await execute({ operation: 'mail.project.set', accountId: input.accountId, input: input.input });
        if (!('projectAssociation' in result)) throw new MailProjectError('unavailable');
        value = await display(result.projectAssociation);
      } else {
        const result = await execute({ operation: 'mail.project.history', accountId: input.accountId, input: input.input });
        if (!('projectHistory' in result)) throw new MailProjectError('unavailable');
        value = mailProjectDisplayHistorySchema.parse({ ...result.projectHistory, items: await Promise.all(result.projectHistory.items.map(async item => ({ ...item, ...await visible(item.project) }))) });
      }
      if (mail.status().state !== 'ready') throw new ApiError(423, 'mail_locked', 'Mail storage is locked');
      return Response.json(value, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof MailProjectError) throw new ApiError(error.code === 'not_found' ? 404 : 409, 'mail_project_' + error.code, 'Project association needs attention.');
      if (error instanceof MailServiceError && error.code === 'locked') throw new ApiError(423, 'mail_locked', 'Mail storage is locked');
      throw new ApiError(503, 'mail_project_unavailable', 'Project association is unavailable.');
    }
  });
}
