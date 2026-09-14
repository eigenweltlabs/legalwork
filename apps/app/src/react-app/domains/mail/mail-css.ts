import {parse,walk,generate,lexer} from 'css-tree';
// Layout and typography only. No fonts, animations, custom properties, generated
// content, selectors that initiate requests, or unparsed recovery tokens.
const properties=new Set(('color background background-color background-image background-position background-size background-repeat background-origin background-clip background-attachment border border-top border-right border-bottom border-left border-color border-style border-width border-radius border-collapse border-spacing box-sizing box-shadow caption-side clear display float font font-family font-size font-style font-weight font-variant letter-spacing line-height list-style-type list-style-position margin margin-top margin-right margin-bottom margin-left max-width min-width width max-height min-height height opacity overflow overflow-x overflow-y overflow-wrap word-wrap padding padding-top padding-right padding-bottom padding-left table-layout text-align text-decoration text-decoration-color text-decoration-line text-decoration-style text-indent text-transform text-overflow vertical-align visibility white-space word-break word-spacing direction unicode-bidi flex flex-basis flex-direction flex-grow flex-shrink flex-wrap align-items align-content align-self justify-content gap row-gap column-gap grid-template-columns grid-template-rows grid-column grid-row').split(' '));
const functions=new Set(('rgb rgba hsl hsla hwb lab lch oklab oklch color color-mix calc min max clamp linear-gradient radial-gradient repeating-linear-gradient repeating-radial-gradient fit-content minmax repeat').split(' '));
export function mailCss(source:string,inline:boolean,resource:(url:string)=>string|null):string {
 if(source.length>128*1024)return '';
 try{
  const ast=parse(source,{context:inline?'declarationList':'stylesheet'});let count=0;
  walk(ast,function(node,item,list){
   if(++count>20000)throw Error('CSS limit');
   if(node.type==='Atrule' && (node.name.toLowerCase()!=='media'||!node.block||!node.prelude||generate(node.prelude).length>1024||/height|orientation|aspect-ratio|\\/.test(generate(node.prelude).toLowerCase()))) {if(item&&list)list.remove(item);return walk.skip;}
   if(node.type==='Rule'){
    if(!node.prelude||node.prelude.type!=='SelectorList'||generate(node.prelude).length>4096){if(item&&list)list.remove(item);return walk.skip;}
    let unsafe=false;walk(node.prelude,child=>{if(child.type==='Raw'||child.type==='NestingSelector'||child.type==='PseudoClassSelector'&&!['link','hover','focus','first-child','last-child','nth-child','nth-of-type','not','is','where','root','empty'].includes(child.name.toLowerCase())||child.type==='PseudoElementSelector')unsafe=true;});
    if(unsafe){if(item&&list)list.remove(item);return walk.skip;}
   }
   if(node.type==='Declaration'){
    let safe=properties.has(node.property.toLowerCase())&&node.value.type!=='Raw';
    walk(node.value,child=>{
     if(child.type==='Dimension'&&/^(?:s|l|d)?vh$|^vmin$|^vmax$/i.test(child.unit))safe=false;
     if(child.type==='Raw'||child.type==='Function'&&!functions.has(child.name.toLowerCase()))safe=false;
     if(child.type==='Url'){const replacement=resource(child.value);if(replacement)child.value=replacement;else safe=false;}
    });
    if(safe&&lexer.matchProperty(node.property,node.value).error)safe=false;
    if(!safe&&item&&list)list.remove(item);
    return walk.skip;
   }
   if(node.type==='Raw'&&item&&list)list.remove(item);
  });
  // A style element is HTML raw text: never permit a serialized closing tag.
  return generate(ast).replace(/</g,'\\3c ');
 }catch{return '';}
}
