import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import type { ServerConfig } from '../types.js';
import { isMainAssistant } from '../main-assistant-identity.js';
import { readProjectDetails } from '../project-store.js';
import { projectSyncStore } from '../project-sync-store.js';
import { readEigenweltConnection } from '../eigenwelt-connection-store.js';
import { connectedTaskOrgId } from '../tasks-api.js';
import { mailProjectDestinationSchema } from './project-association-view.js';
import { MailProjectError } from './project-association-view.js';

/** Read-only catalog resolution. Never bootstraps a project or refreshes a token. */
export function mailProjectDestinations(config: ServerConfig) {
  const candidates = () => config.workspaces.filter(workspace => !isMainAssistant(workspace));
  return {
    projects: () => candidates().map(workspace => workspace.id),
    async resolve(id: string) {
      const workspace = candidates().find(workspace => workspace.id === id);
      if (!workspace) throw new MailProjectError('unavailable');
      const root = await realpath(workspace.path);
      const directory = await stat(root);
      if (!directory.isDirectory()) throw new MailProjectError('unavailable');
      const roots = await Promise.all(config.authorizedRoots.map(path => realpath(path).catch(() => null)));
      if (!roots.some(allowed => { if (!allowed) return false; const path = relative(allowed, root); return path === '' || path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path); })) throw new MailProjectError('unavailable');
      const details = await readProjectDetails(root), link = (await projectSyncStore(config)).linkByWorkspace(id);
      let principal: string | null = null;
      if (link) {
        const connection = await readEigenweltConnection(config), orgId = connectedTaskOrgId(connection);
        if (link.state !== 'active' || orgId !== link.orgId || !connection.account?.userId || details.syncProjectId && details.syncProjectId !== link.projectId) throw new MailProjectError('unavailable');
        if (link.settings.access === 'members' && link.ownerUserId !== connection.account.userId && !link.settings.memberIds.includes(connection.account.userId)) throw new MailProjectError('unavailable');
        principal = JSON.stringify([link.projectId, link.orgId, connection.account.userId]);
      } else if (details.syncProjectId) throw new MailProjectError('unavailable');
      const binding = createHash('sha256').update(JSON.stringify([id, root, directory.dev, directory.ino, details.syncProjectId ?? null, principal])).digest('hex');
      return mailProjectDestinationSchema.parse({ id, binding, name: workspace.displayName?.trim() || workspace.name });
    },
  };
}
