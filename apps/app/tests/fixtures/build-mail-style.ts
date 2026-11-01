import {build} from 'vite';
import tailwindcss from '@tailwindcss/vite';
import {join} from 'node:path';

export async function buildMailFixtureStyle(directory:string,appRoot:string) {
 await build({configFile:false,root:appRoot,plugins:tailwindcss(),logLevel:'error',build:{
  outDir:join(directory,'styles'),emptyOutDir:true,
  rollupOptions:{input:join(appRoot,'src/app/index.css'),output:{assetFileNames:'[name][extname]'}}
 }});
}
