import { z } from 'zod';
import { ApiError } from '../errors.js';
import { MailServiceError, type MailService } from '../mail/service-interface.js';
import { MailClassifierError, mailClassifierCommandSchema, mailClassifierResultMatches, mailClassifierDisplaySchema, mailClassifierDisplayPreviewSchema, type MailClassifierConfig, type MailClassifierCommand } from '../mail/classifier-view.js';
import type { MailProjectReference, MailProjectDestination } from '../mail/project-association-view.js';
import {mailClassifierDisplayActivitySchema} from '../mail/classifier-incoming-view.js';
import { isMailLoopback, readMailBody } from './mail.js';
import { addRoute, type Route } from './registry.js';

export function registerMailClassifierRoutes({ routes, host, mail, ensureWritable, resolve }: { routes: Route[]; host: string; mail?: MailService; ensureWritable: () => void; resolve: (id: string) => Promise<MailProjectDestination> }) {
  const invoke = mail?.classifier?.bind(mail); if (!mail || !invoke || !isMailLoopback(host)) return;
  const requestClassifier = invoke;
  const automaticAvailable = mail.automaticClassificationAvailable?.bind(mail);
  mail.configureAutomaticClassification?.({resolve,writable:()=>{try{ensureWritable();return true;}catch{return false;}}});
  async function visible(reference: MailProjectReference) {
    try { const value = await resolve(reference.id); if (value.id === reference.id && value.binding === reference.binding) return value; } catch { /* Inaccessible destinations remain private. */ }
    return null;
  }
  async function display(config: MailClassifierConfig) {
    const rules = await Promise.all(config.definition.rules.map(async rule => { const project = await visible(rule.project); return { ...rule, project, unavailable: project === null }; }));
    return mailClassifierDisplaySchema.parse({ ...config, definition: { ...config.definition, rules },automaticStatus:config.definition.mode==='automatic'&&!automaticAvailable?.()?'unavailable':config.automaticStatus });
  }
  addRoute(routes, 'POST', '/mail/v1/classifier', 'host-token', async ctx => {
    if (ctx.actor?.type !== 'host') throw new ApiError(401, 'unauthorized', 'Invalid host token');
    let input: z.infer<typeof mailClassifierCommandSchema>;
    try { input = mailClassifierCommandSchema.parse(JSON.parse(await readMailBody(ctx.request, 60000))); }
    catch { throw new ApiError(400, 'mail_classifier_invalid_input', 'Invalid project classification request'); }
    if (mail.status().state !== 'ready') throw new ApiError(423, 'mail_locked', 'Mail storage is locked');
    try {
      if (input.operation === 'mail.classifier.save') {
        ensureWritable();
        if(input.input.definition.mode==='automatic'&&!mail.automaticClassificationAvailable?.())throw new MailClassifierError('unavailable');
        for (const rule of input.input.definition.rules) if (rule.project && !await visible(rule.project)) throw new MailClassifierError('conflict');
        ensureWritable();
      }
      if(input.operation==='mail.classifier.dismiss'||input.operation==='mail.classifier.undo')ensureWritable();
      const result = await requestClassifier(input);
      if (!mailClassifierResultMatches(input, result)) throw new MailClassifierError('unavailable');
      let value: unknown;
      if ('classifier' in result) value = await display(result.classifier);
      else if('classifierAction' in result)value=result.classifierAction;
      else if('classifierActivity' in result)value=mailClassifierDisplayActivitySchema.parse({...result.classifierActivity,items:await Promise.all(result.classifierActivity.items.map(async item=>{const project=item.project?await visible(item.project):null;return{...item,project,unavailable:item.project!==null&&project===null};}))});
      else if ('classification' in result) {
        const resolved = await Promise.all(result.classification.candidates.map(async candidate => { const project = await visible(candidate.project); return project ? { ...candidate, project } : null; }));
        const candidates = resolved.filter(candidate => candidate !== null), unavailable = resolved.length - candidates.length;
        const current = await requestClassifier(input);
        if (!mailClassifierResultMatches(input, current) || JSON.stringify(current) !== JSON.stringify(result)) throw new MailClassifierError('conflict');
        value = mailClassifierDisplayPreviewSchema.parse({ ...result.classification, candidates, unavailable, status: unavailable && !candidates.length ? 'unavailable' : result.classification.status });
      } else throw new MailClassifierError('unavailable');
      if (mail.status().state !== 'ready') throw new ApiError(423, 'mail_locked', 'Mail storage is locked');
      return Response.json(value, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof MailServiceError && error.code === 'locked') throw new ApiError(423, 'mail_locked', 'Mail storage is locked');
      if (error instanceof MailClassifierError) throw new ApiError(error.code === 'invalid_input' ? 400 : error.code === 'not_found' ? 404 : error.code === 'conflict' ? 409 : 503, 'mail_classifier_' + error.code, 'Project classification needs attention.');
      throw new ApiError(503, 'mail_classifier_unavailable', 'Project classification is unavailable.');
    }
  });
}
