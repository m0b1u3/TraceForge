// Electron-only smoke: synthetic files and an isolated profile, no model account or network.
import {app,safeStorage} from "electron";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createRequire} from "node:module";
import {readPdfPages} from "../apps/server/dist/pdf-pages.js";
import {readSelectedAttachment} from "../apps/desktop/dist/attachment-file.js";
const root=await mkdtemp(join(tmpdir(),"traceforge-native-attachments-"));
app.setPath("userData",root);
const timer=setTimeout(()=>app.exit(1),20000);
void app.whenReady().then(async()=>{
let status=1;
try{
  const {PDFDocument}=createRequire(new URL("../apps/server/package.json",import.meta.url))("pdf-lib");
  const pdf=await PDFDocument.create();pdf.addPage([200,300]);pdf.addPage([400,500]);
  const path=join(root,"fixture.pdf");await writeFile(path,await pdf.save());
  const selected=await readSelectedAttachment(path);
  const slice=await readPdfPages(Buffer.from(selected.data,"base64"),2,2);
  const page=await PDFDocument.load(slice.data);
  if(page.getPageCount()!==1||page.getPage(0).getWidth()!==400)throw Error("native_pdf_mismatch");
  if(!safeStorage.isEncryptionAvailable()||process.platform==="linux"&&safeStorage.getSelectedStorageBackend()==="basic_text")throw Error("secure_storage_unavailable");
  const source=JSON.stringify({state:"synthetic-private-continuation"}),sealed=safeStorage.encryptString(source);
  if(sealed.includes(Buffer.from(source))||safeStorage.decryptString(sealed)!==source)throw Error("secure_storage_mismatch");
  console.log("NATIVE_ATTACHMENT_READ_PDF_WORKER_AND_SECURE_CONTINUATION_CIPHER_OK");status=0;
}catch(error){console.error("NATIVE_ATTACHMENT_SMOKE_FAILED",error instanceof Error?error.message:"unknown");}
finally{clearTimeout(timer);await rm(root,{recursive:true,force:true});app.exit(status);}
});
