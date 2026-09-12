/** @jsxImportSource react */
import {Children,isValidElement,type ReactNode} from 'react';
import {Select,SelectContent,SelectItem,SelectTrigger,SelectValue} from '@/components/ui/select';
import {LayoutSection,LayoutSectionHeader,LayoutSectionTitle,LayoutSectionDescription} from '../settings-layout';
import {SettingsInset} from '../settings-section';

/** Mail's account forms use the same selectable controls and section surfaces as other Settings pages. */
export function MailSettingsSelect({children,value,onChange,disabled,className: _className,...props}:{children:ReactNode;value?:string;onChange:(value:string)=>void;disabled?:boolean;className?:string;'aria-label'?:string;id?:string}){
 const options=Children.toArray(children).flatMap(child=>isValidElement<{value:string;children:ReactNode}>(child)?[{value:child.props.value,label:child.props.children}]:[]);
 return <Select value={value} items={options} disabled={disabled} onValueChange={next=>{if(next!==null)onChange(next);}}><SelectTrigger size="sm" className="w-full min-w-0" {...props}><SelectValue/></SelectTrigger><SelectContent>{options.map(option=><SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select>;
}
export function MailSettingsSection({title,description,children}:{title:string;description?:string;children:ReactNode}){
 return <LayoutSection><LayoutSectionHeader><LayoutSectionTitle>{title}</LayoutSectionTitle>{description&&<LayoutSectionDescription>{description}</LayoutSectionDescription>}</LayoutSectionHeader><SettingsInset className="space-y-4 rounded-2xl p-5">{children}</SettingsInset></LayoutSection>;
}
