import SMTPConnection from 'nodemailer/lib/smtp-connection';
import type {SMTPConnectionOptions,SMTPConnectionSendInfo} from 'nodemailer/lib/smtp-connection';
import {OutboxError,type OutboxResult,type SmtpSettings} from '../outbox-view.js';
export class SubmissionFailure extends OutboxError{constructor(code:ConstructorParameters<typeof OutboxError>[0],readonly knownRejected=false){super(code);}}
function record(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object';}
function failure(error:unknown,dispatch=false){const value=record(error)?error:{};const response=typeof value.responseCode==='number'?value.responseCode:0;
 if(value.code==='EMESSAGE'&&value.command==='MAIL FROM')return new SubmissionFailure('too_large',true);
 return new SubmissionFailure(value.code==='EAUTH'?'authentication':value.code==='ETLS'||value.code==='ESOCKET'&&typeof value.message==='string'&&/cert|TLS/i.test(value.message)?'certificate':response>=400&&response<600?'rejected':dispatch?'outcome_unknown':'retryable',dispatch&&response>=400&&response<600);
}
/** One authenticated TLS connection; no pooling, automatic retry, logging, or provider response text. */
export class SmtpSubmission{
 private connection:SMTPConnection;private rejectPending:((error:Error)=>void)|undefined;private closed=false;private dispatching=false;
 constructor(settings:SmtpSettings,private password:string,private signal:AbortSignal,create:(options:SMTPConnectionOptions)=>SMTPConnection=options=>new SMTPConnection(options)){
  this.connection=create({host:settings.host,port:settings.port,secure:settings.security==='tls',requireTLS:settings.security==='starttls',opportunisticTLS:false,ignoreTLS:false,name:'legalwork.local',tls:{rejectUnauthorized:true,minVersion:'TLSv1.2'},logger:false,debug:false,connectionTimeout:20000,greetingTimeout:20000,socketTimeout:60000,dnsTimeout:10000});
  this.connection.on('error',error=>this.rejectPending?.(failure(error,this.dispatching)));this.connection.on('end',()=>this.rejectPending?.(new SubmissionFailure('outcome_unknown')));
  signal.addEventListener('abort',this.abort,{once:true});this.username=settings.username;
 }
 private username:string;
 private abort=()=>{this.rejectPending?.(new SubmissionFailure('outcome_unknown'));this.close();};
 private operation<T>(run:(done:(error:unknown,value?:T)=>void)=>void,dispatch=false):Promise<T|undefined>{if(this.signal.aborted||this.closed)return Promise.reject(new SubmissionFailure(dispatch?'outcome_unknown':'retryable'));return new Promise((resolve,reject)=>{this.dispatching=dispatch;this.rejectPending=reject;run((error,value)=>{this.rejectPending=undefined;if(error)reject(failure(error,dispatch));else resolve(value);});});}
 async prepare(){await this.operation(done=>this.connection.connect(error=>done(error)));if(!this.connection.secure)throw new SubmissionFailure('certificate');await this.operation(done=>this.connection.login({user:this.username,pass:this.password},error=>done(error)));this.password='';}
 async send(envelope:{from:string;to:string[]},raw:Uint8Array):Promise<OutboxResult>{
  const result=await this.operation<SMTPConnectionSendInfo>(done=>this.connection.send({...envelope,size:raw.byteLength,dsn:{notify:['failure','delay'],return:'headers'}},Buffer.from(raw),(error,info)=>done(error,info)),true);if(!result?.accepted.length)throw new SubmissionFailure('outcome_unknown');
  if([...result.accepted,...result.rejected].some(address=>!envelope.to.includes(address)))throw new SubmissionFailure('outcome_unknown');
  return{accepted:result.accepted,rejected:result.rejected.map((address,index)=>({address,code:String(result.rejectedErrors?.[index]?.responseCode??'rejected').slice(0,32)})),providerId:null,sentCopy:'pending',delivery:'unknown',reconciled:false};
 }
 close(){if(this.closed)return;this.closed=true;this.signal.removeEventListener('abort',this.abort);this.password='';this.connection.close();}
}
