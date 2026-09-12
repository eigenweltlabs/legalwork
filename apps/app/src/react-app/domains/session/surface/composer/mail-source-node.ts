import {$applyNodeReplacement,TextNode,type EditorConfig,type NodeKey,type SerializedTextNode} from 'lexical';
import {openMailSource,parseMailSourceHref} from '../../../mail/mail-chat-source';
/** Presentation only: the exact scoped source URL survives draft serialization. */
export class ComposerMailSourceNode extends TextNode {
 static override getType(){return 'composer-mail-source';}
 static override clone(node:ComposerMailSourceNode){return new ComposerMailSourceNode(node.__text,node.__key);}
 static override importJSON(node:SerializedTextNode){return $createComposerMailSourceNode(node.text);}
 constructor(text='',key?:NodeKey){super(text,key);}
 override exportJSON():SerializedTextNode{return {...super.exportJSON(),type:'composer-mail-source',version:1};}
 override createDOM(_config:EditorConfig){const dom=document.createElement('span');dom.className='inline-flex items-center rounded-full border border-gray-6 bg-gray-3 px-2.5 py-1 text-xs font-medium text-gray-11';dom.contentEditable='false';dom.setAttribute('spellcheck','false');const button=document.createElement('button');button.type='button';button.textContent='Source email';button.title='Return to the source email';button.setAttribute('aria-label','Return to source email');const href=mailSourceLink(this.__text);button.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' ')event.stopPropagation();});button.addEventListener('click',()=>{if(href)openMailSource(href);});dom.append(button);return dom;}
 override updateDOM(previous:ComposerMailSourceNode){return previous.__text!==this.__text;}
 override canInsertTextBefore():false{return false;}
 override canInsertTextAfter():false{return false;}
 override isTextEntity():true{return true;}
 override isToken():true{return true;}
}
export function mailSourceLink(text:string){const match=/^\[Source email\]\((\/mail\?source=[^\s)]{1,24000})\)$/.exec(text);return match&&parseMailSourceHref(match[1])?match[1]:null;}
export function $createComposerMailSourceNode(text:string){return $applyNodeReplacement(new ComposerMailSourceNode(text));}
