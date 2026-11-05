// Controller-only synthetic Office inputs. No rubric or helper enters a guest.
import { createRequire } from "node:module";
const requireApp = createRequire(new URL("../../apps/app/package.json", import.meta.url));
const requireServer = createRequire(new URL("../../apps/server/package.json", import.meta.url));
const XLSX = requireApp("xlsx");
const { zipSync, strToU8 } = requireServer("fflate");
const xml = value => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const officeFixtureEpoch = new Date("2026-10-24T00:00:00.000Z");

export function makeOfficeWorkbook() {
  const workbook = XLSX.utils.book_new();
  const settlement = XLSX.utils.aoa_to_sheet([
    ["SYNTHETIC SETTLEMENT CALCULATION", null, null, "Preserve this column"],
    ["Principal", 125000, null, "Matter LW-OFFICE-2026"],
    ["Annual simple interest rate", 0.06, null, "Signed amendment is authoritative"],
    ["Days", 90, null, "365-day year"],
    ["Existing unrounded interest", 0], ["Existing unrounded total", 0],
    ["Requested calculations"], ["Rounded interest"], ["Settlement plus interest"], ["Including retainer"],
    [], [null, null, null, null, null, "Existing grid boundary; preserve"],
  ]);
  settlement.B5 = { t: "n", f: "B2*B3*B4/365", v: 125000 * 0.06 * 90 / 365 };
  settlement.B6 = { t: "n", f: "SUM(B2,B5)", v: 125000 + settlement.B5.v };
  settlement.B2.z = "#,##0.00"; settlement.B3.z = "0.00%";
  for (const address of ["B5", "B6"]) settlement[address].z = "#,##0.00";
  settlement["!cols"] = [{ wch: 36 }, { wch: 20 }, { wch: 4 }, { wch: 42 }];
  const sources = XLSX.utils.aoa_to_sheet([
    ["SOURCE RECORD — preserve this sheet"], ["Amendment principal", 128000], ["Retainer", 2500],
    ["Amendment identifier", "SIGNED-AMENDMENT-2026-A"], ["Existing cross-sheet check", 127500],
    ["Governing law", "England and Wales"], [], [], [], [], [], [null, null, null, null, null, "Second existing grid boundary"],
  ]);
  sources.B5 = { t: "n", f: "Settlement!B2+B3", v: 127500 };
  sources.B2.z = sources.B3.z = sources.B5.z = "#,##0.00";
  XLSX.utils.book_append_sheet(workbook, settlement, "Settlement");
  XLSX.utils.book_append_sheet(workbook, sources, "Sources");
  workbook.Props = { Title: "Synthetic settlement workbook", Author: "LegalWork regression fixture", CreatedDate: officeFixtureEpoch, ModifiedDate: officeFixtureEpoch };
  return Buffer.from(XLSX.write(workbook, { bookType: "xlsx", type: "buffer", compression: true, cellStyles: true }));
}

const packageNS = "http://schemas.openxmlformats.org/package/2006/relationships";
const officeNS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const drawingNS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const presentationNS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const header = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const relations = items => `${header}<Relationships xmlns="${packageNS}">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${officeNS}/${type}" Target="${target}"/>`).join("")}</Relationships>`;
const tree = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
const shape = (id, name, text, x, y, width, height, size = 2400) => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${width}" cy="${height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${text.split("\n").map(line => `<a:p><a:r><a:rPr lang="en-GB" sz="${size}"/><a:t>${xml(line)}</a:t></a:r><a:endParaRPr lang="en-GB" sz="${size}"/></a:p>`).join("")}</p:txBody></p:sp>`;
export const officePptxNotes = ["Speaker note: Preserve privilege; verify the signed amendment before advice.", "Speaker note: Keep the signed source record with the matter file."];

export function makeOfficePresentationParts() {
  const files = {};
  const put = (name, value) => { files[name] = strToU8(value); };
  const types = { "/ppt/presentation.xml": "presentationml.presentation.main", "/ppt/slideMasters/slideMaster1.xml": "presentationml.slideMaster", "/ppt/slideLayouts/slideLayout1.xml": "presentationml.slideLayout", "/ppt/notesMasters/notesMaster1.xml": "presentationml.notesMaster", "/ppt/theme/theme1.xml": "theme" };
  for (let index = 1; index <= 2; index++) { types[`/ppt/slides/slide${index}.xml`] = "presentationml.slide"; types[`/ppt/notesSlides/notesSlide${index}.xml`] = "presentationml.notesSlide"; }
  put("[Content_Types].xml", `${header}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>${Object.entries(types).map(([name, type]) => `<Override PartName="${name}" ContentType="application/vnd.openxmlformats-officedocument.${type}+xml"/>`).join("")}</Types>`);
  put("_rels/.rels", relations([["rId1", "officeDocument", "ppt/presentation.xml"]]));
  put("ppt/presentation.xml", `${header}<p:presentation xmlns:a="${drawingNS}" xmlns:r="${officeNS}" xmlns:p="${presentationNS}"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId3"/></p:sldMasterIdLst><p:notesMasterIdLst><p:notesMasterId r:id="rId4"/></p:notesMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`);
  put("ppt/_rels/presentation.xml.rels", relations([["rId1", "slide", "slides/slide1.xml"], ["rId2", "slide", "slides/slide2.xml"], ["rId3", "slideMaster", "slideMasters/slideMaster1.xml"], ["rId4", "notesMaster", "notesMasters/notesMaster1.xml"]]));
  const colors = '<a:dk1><a:srgbClr val="172C37"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="285E51"/></a:dk2><a:lt2><a:srgbClr val="F5F5F0"/></a:lt2>'+["285E51", "D8B26E", "6D8594", "8B5277", "42738F", "728D57"].map((value,index)=>`<a:accent${index+1}><a:srgbClr val="${value}"/></a:accent${index+1}>`).join("")+'<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>';
  put("ppt/theme/theme1.xml", `${header}<a:theme xmlns:a="${drawingNS}" name="Legal synthetic theme"><a:themeElements><a:clrScheme name="Legal">${colors}</a:clrScheme><a:fontScheme name="Legal"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Legal"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`);
  const colorMap = '<p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/>';
  put("ppt/slideMasters/slideMaster1.xml", `${header}<p:sldMaster xmlns:a="${drawingNS}" xmlns:r="${officeNS}" xmlns:p="${presentationNS}"><p:cSld name="Legal master"><p:spTree>${tree}</p:spTree></p:cSld>${colorMap}<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`);
  put("ppt/slideMasters/_rels/slideMaster1.xml.rels", relations([["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"], ["rId2", "theme", "../theme/theme1.xml"]]));
  put("ppt/slideLayouts/slideLayout1.xml", `${header}<p:sldLayout xmlns:a="${drawingNS}" xmlns:r="${officeNS}" xmlns:p="${presentationNS}" type="blank" preserve="1"><p:cSld name="Legal blank"><p:spTree>${tree}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`);
  put("ppt/slideLayouts/_rels/slideLayout1.xml.rels", relations([["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]]));
  put("ppt/notesMasters/notesMaster1.xml", `${header}<p:notesMaster xmlns:a="${drawingNS}" xmlns:r="${officeNS}" xmlns:p="${presentationNS}"><p:cSld><p:spTree>${tree}</p:spTree></p:cSld>${colorMap}<p:notesStyle/></p:notesMaster>`);
  put("ppt/notesMasters/_rels/notesMaster1.xml.rels", relations([["rId1", "theme", "../theme/theme1.xml"]]));
  files["ppt/media/logo.png"] = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  const slides = [["Renewal risk — draft", "Current notice: 30 calendar days."], ["Action checklist", "Verify signed amendment.\nPreserve source records."]];
  slides.forEach(([title, body], index) => {
    const number = index + 1;
    const logo = '<p:pic><p:nvPicPr><p:cNvPr id="5" name="Preserve logo"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId3"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="11430000" y="190500"/><a:ext cx="381000" cy="381000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>';
    put(`ppt/slides/slide${number}.xml`, `${header}<p:sld xmlns:a="${drawingNS}" xmlns:r="${officeNS}" xmlns:p="${presentationNS}"><p:cSld name="Legal slide ${number}"><p:spTree>${tree}${shape(2,"Title",title,609600,381000,10668000,914400)}${shape(3,"Body",body,609600,1828800,10668000,2743200,1800)}${shape(4,"Preserve footer","Confidential synthetic client briefing",609600,6096000,10668000,381000,1200)}${logo}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`);
    put(`ppt/slides/_rels/slide${number}.xml.rels`, relations([["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"], ["rId2", "notesSlide", `../notesSlides/notesSlide${number}.xml`], ["rId3", "image", "../media/logo.png"]]));
    put(`ppt/notesSlides/notesSlide${number}.xml`, `${header}<p:notes xmlns:a="${drawingNS}" xmlns:r="${officeNS}" xmlns:p="${presentationNS}"><p:cSld><p:spTree>${tree}${shape(2,"Notes",officePptxNotes[index],0,0,6000000,4000000,1200)}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`);
    put(`ppt/notesSlides/_rels/notesSlide${number}.xml.rels`, relations([["rId1", "notesMaster", "../notesMasters/notesMaster1.xml"], ["rId2", "slide", `../slides/slide${number}.xml`]]));
  });
  return files;
}

export function zipOfficeParts(parts) {
  return Buffer.from(zipSync(Object.fromEntries(Object.entries(parts).map(([name, bytes]) => [name, [bytes, { mtime: officeFixtureEpoch }]]))));
}
export function makeOfficePresentation() { return zipOfficeParts(makeOfficePresentationParts()); }
