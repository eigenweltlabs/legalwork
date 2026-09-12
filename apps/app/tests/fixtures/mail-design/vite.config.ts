import {mergeConfig} from 'vite';
import {realpathSync} from 'node:fs';
import {resolve} from 'node:path';
import config from '../../../vite.config';
// Isolated worktrees share installed dependencies. Resolve one React instance
// and permit only those dependency assets (including the production font).
export default mergeConfig(config,{resolve:{dedupe:['react','react-dom']},server:{fs:{allow:[resolve('../..'),realpathSync('../../node_modules')]}}});
