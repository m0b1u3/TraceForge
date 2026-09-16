import {expect,it} from "vitest";
import {PDFDocument} from "pdf-lib";
import {readPdfPages} from "./pdf-pages.js";

it("preserves selected PDF pages and rejects invalid ranges and documents",async()=>{
  const pdf=await PDFDocument.create();
  for(let n=1;n<=3;n++)pdf.addPage([200+n,300+n]).drawText(`Page ${n}`);
  const bytes=await pdf.save();
  expect(await readPdfPages(bytes)).toEqual({pages:3});
  const slice=await readPdfPages(bytes,2,3),result=await PDFDocument.load(slice.data!);
  expect(result.getPageCount()).toBe(2);expect(result.getPage(0).getWidth()).toBe(202);
  await expect(readPdfPages(bytes,3,2)).rejects.toThrow("invalid_page_range");
  await expect(readPdfPages(bytes,1,9)).rejects.toThrow("invalid_page_range");
  await expect(readPdfPages(bytes,4,4)).rejects.toThrow("page_out_of_range");
  await expect(readPdfPages(Buffer.from("not pdf"))).rejects.toThrow("invalid_pdf");
  await expect(readPdfPages(Buffer.from("%PDF-broken"))).rejects.toThrow("pdf_unreadable_or_encrypted");
});
