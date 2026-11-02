import {randomBytes,timingSafeEqual} from 'node:crypto';
// Separate from remote-client and host UI credentials; lives only in this local server/engine pair.
export const mailAgentEngineToken=randomBytes(32).toString('hex');
export function isMailAgentEngineToken(header:string|null,expected:string){
 const supplied=/^Bearer ([a-f0-9]{64})$/.exec(header??'')?.[1];
 return !!supplied&&supplied.length===expected.length&&timingSafeEqual(Buffer.from(supplied),Buffer.from(expected));
}
