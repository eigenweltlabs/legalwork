/** @jsxImportSource react */
import {Children,isValidElement,type ReactNode} from 'react';
import {Select,SelectContent,SelectItem,SelectTrigger,SelectValue} from '@/components/ui/select';
import {LayoutSection,LayoutSectionHeader,LayoutSectionTitle} from '../settings-layout';
import {SettingsInset} from '../settings-section';

/** Mail's account forms use the same selectable controls and section surfaces as other Settings pages. */
export function MailSettingsSelect({children,value,onChange,disabled,plain=false,className: _className,...props}:{children:ReactNode;value?:string;onChange:(value:string)=>void;disabled?:boolean;plain?:boolean;className?:string;'aria-label'?:string;id?:string}){
 const options=Children.toArray(children).flatMap(child=>isValidElement<{value:string;children:ReactNode;disabled?:boolean}>(child)?[{value:child.props.value,label:child.props.children,disabled:child.props.disabled}]:[]);
 return <Select value={value} items={options} disabled={disabled} onValueChange={next=>{if(next!==null)onChange(next);}}><SelectTrigger size="sm" className={plain?"w-full min-w-0 rounded-none border-0 bg-transparent px-0 shadow-none focus-visible:ring-0":"w-full min-w-0"} {...props}><SelectValue/></SelectTrigger><SelectContent>{options.map(option=><SelectItem key={option.value} value={option.value} disabled={option.disabled}>{option.label}</SelectItem>)}</SelectContent></Select>;
}
export function MailSettingsSection({title,children}:{title:string;children:ReactNode}){
 return <LayoutSection><LayoutSectionHeader><LayoutSectionTitle>{title}</LayoutSectionTitle></LayoutSectionHeader><SettingsInset className="space-y-4 rounded-2xl p-5">{children}</SettingsInset></LayoutSection>;
}
