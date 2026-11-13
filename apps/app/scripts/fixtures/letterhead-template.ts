import JSZip from "jszip";
import { writingTemplate } from "./writing-template";

/** Synthetic page artwork plus a colour-keyed wrapping picture. */
export async function letterheadTemplate() {
  const zip = await JSZip.loadAsync(await writingTemplate());
  const background = "iVBORw0KGgoAAAANSUhEUgAAAGQAAACMCAIAAAAFl5vsAAABbklEQVR4nO3bsQ2CUBRAUTAO4SIWruASDmLtIC7hChYu4hbYUpl/Kck53U/4zc2j4jEvyzIx5jD4HGI1JisQKzhOe3e63Dbf/b6f66PJCsQKxArECsQKxArECsQKxArECsQKxArECsQKxArECsQKxArECsQKZl+kx5msQKxArECsQKxArECsQKxArECsQKxArECsQKxArECsQKxArECsQKxArECsQKxArECsQKxArECsYP9/sp7v1813P4/X+miyArECsQLLbIHJCsQKxArECsQKxArECsQKxArECsQKxArECsQKxArECsQKxArECsQKxArECsQKxArECsQKxArsZ/1jP2s7r2EgVmA/KzBZgViBWIFYgViBWIFYgViBWIFYgViBWIFYgViBWIFYgViBWIFYgViBWIFYgViBWIFYgViBWIFYgViBWIFYgViBWIFYgViBWIFYgViBWIFYgViBWIFYgViBWIFYgViBWIFYgViBWIFYgViBWIFYgViBWNO4HzVfFg+yl8PWAAAAAElFTkSuQmCC";
  const key = "iVBORw0KGgoAAAANSUhEUgAAAAMAAAABCAIAAACUgoPjAAAAE0lEQVR4nGP4////fwaG////AwAj5gb6kze6xAAAAABJRU5ErkJggg==";
  zip.file("word/media/background.png", background, { base64: true });
  zip.file("word/media/key.png", key, { base64: true });
  const types = await zip.file("[Content_Types].xml")!.async("string");
  zip.file("[Content_Types].xml", types.replace("</Types>", '<Default Extension="png" ContentType="image/png"/></Types>'));
  const r = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  zip.file("word/_rels/header1.xml.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${r}/image" Target="media/background.png"/><Relationship Id="rId2" Type="${r}/image" Target="media/key.png"/></Relationships>`);
  const drawing = (id: number, wrap: string, width: number, height: number, x: number, y: number, effects = "") => `<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${id}" behindDoc="1" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="page"><wp:posOffset>${x}</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>${y}</wp:posOffset></wp:positionV><wp:extent cx="${width}" cy="${height}"/>${wrap}<wp:docPr id="${id}" name="Synthetic picture ${id}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="Synthetic picture"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId${id}">${effects}</a:blip><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${width}" cy="${height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>`;
  const transparentWhite = '<a:clrChange><a:clrFrom><a:srgbClr val="FFFFFF"/></a:clrFrom><a:clrTo><a:srgbClr val="FFFFFF"><a:alpha val="0"/></a:srgbClr></a:clrTo></a:clrChange>';
  zip.file("word/header1.xml", `<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="${r}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:p>${drawing(1, "<wp:wrapNone/>", 7560310, 10685780, 0, 0)}${drawing(2, '<wp:wrapSquare wrapText="bothSides"/>', 1520825, 8037195, 5700000, 800000, transparentWhite)}</w:p></w:hdr>`);
  return zip.generateAsync({ type: "arraybuffer" });
}
