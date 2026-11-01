import type {OutboxItem} from '../../../../../server/src/mail/outbox-view';
export function outboxPresentation(item:OutboxItem){
 const labels={queued:'Queued',sending:'Sending',accepted:item.result?.rejected.length?'Partially accepted':'Accepted by server',failed:'Needs attention',uncertain:'Outcome unknown',cancelled:'Cancelled'};
 const safe=!item.restored&&item.error!=='preparation_unknown';
 return{label:labels[item.state],tone:['failed','uncertain'].includes(item.state)?'attention':item.state==='accepted'?'success':'',canRetry:safe&&item.state==='failed',canEdit:safe&&(item.state==='failed'||item.state==='cancelled'||item.state==='queued'&&item.cancellationGuaranteed),canCancel:!item.restored&&['queued','sending','uncertain'].includes(item.state),canReconcile:!item.restored&&item.state==='uncertain'};
}
