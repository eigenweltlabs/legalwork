import type {OutboxItem} from '../../../../../server/src/mail/outbox-view';
import {t} from '@/i18n';
export function outboxPresentation(item:OutboxItem,now=Date.now()){
 const labels={queued:item.schedule&&item.schedule.at>now?t('mail.scheduled'):'Queued',sending:'Sending',accepted:item.result?.rejected.length?'Partially accepted':'Accepted by server',failed:'Needs attention',uncertain:'Outcome unknown',cancelled:'Cancelled'};
 const safe=!item.restored&&item.error!=='preparation_unknown';
 return{canReschedule:safe&&!!item.schedule&&item.state==='queued'&&item.cancellationGuaranteed,label:labels[item.state],tone:['failed','uncertain'].includes(item.state)?'attention':item.state==='accepted'?'success':'',canRetry:safe&&item.state==='failed',canEdit:safe&&(item.state==='failed'||item.state==='cancelled'||item.state==='queued'&&item.cancellationGuaranteed),canCancel:!item.restored&&['queued','sending','uncertain'].includes(item.state),canReconcile:!item.restored&&item.state==='uncertain'};
}
