// Temporary observation only: never changes readiness, exceptions or OS policy.
import {appendFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
const control=join(process.env.HOME,'Library/Application Support/com.eigenweltlabs.legalwork/mail-signed-qualification.json');
export function qualificationTrace(stage,error) {
  try {
    const {evidence}=JSON.parse(readFileSync(control,'utf8'));
    appendFileSync(join(evidence,'startup.txt'),JSON.stringify({time:new Date().toISOString(),pid:process.pid,stage,...(error?{error:String(error?.stack??error).slice(0,4000)}:{})})+'\n');
  } catch(error) {console.error('[qualification diagnostics]',error);}
}
qualificationTrace('module-loaded');
process.on('uncaughtExceptionMonitor',error=>qualificationTrace('uncaught-exception',error));
process.on('unhandledRejection',error=>qualificationTrace('unhandled-rejection',error));
