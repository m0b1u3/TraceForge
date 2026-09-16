import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
let active=0;

/** Parse in a disposable worker: no document scripts, caller code, network or external converter. */
export function readPdfPages(bytes:Uint8Array,startPage?:number,endPage?:number):Promise<{pages:number;data?:Uint8Array}>{
  if(bytes.length>32*1048576 || Buffer.from(bytes.subarray(0,5)).toString()!=="%PDF-")return Promise.reject(new Error("invalid_pdf"));
  if(startPage!==undefined&&(!Number.isInteger(startPage)||startPage<1||!Number.isInteger(endPage)||endPage!<startPage||endPage!-startPage>=8))return Promise.reject(new Error("invalid_page_range"));
  if(active>=4)return Promise.reject(new Error("pdf_processing_busy"));
  active++;
  return new Promise((resolve,reject)=>{
    const worker=new Worker(`
      const {parentPort,workerData}=require('node:worker_threads');
      const {PDFDocument}=require(workerData.module);
      (async()=>{
        const doc=await PDFDocument.load(workerData.bytes,{updateMetadata:false});
        const pages=doc.getPageCount();
        if(pages>10000)throw Error('pdf_page_limit');
        if(workerData.start===undefined){parentPort.postMessage({pages});return;}
        if(workerData.end>pages)throw Error('page_out_of_range');
        const out=await PDFDocument.create();
        const indices=Array.from({length:workerData.end-workerData.start+1},(_,i)=>workerData.start-1+i);
        for(const page of await out.copyPages(doc,indices))out.addPage(page);
        const data=await out.save();
        if(data.length>1048576)throw Error('page_slice_too_large');
        parentPort.postMessage({pages,data});
      })().catch(e=>parentPort.postMessage({error:['page_out_of_range','pdf_page_limit','page_slice_too_large'].includes(e.message)?e.message:'pdf_unreadable_or_encrypted'}));
    `,{eval:true,execArgv:[],workerData:{bytes,module:createRequire(import.meta.url).resolve("pdf-lib"),start:startPage,end:endPage},resourceLimits:{maxOldGenerationSizeMb:128}});
    const timer=setTimeout(()=>{void worker.terminate();reject(new Error("pdf_processing_timeout"));},10000);
    worker.once("message",value=>{clearTimeout(timer);void worker.terminate();value.error?reject(new Error(value.error)):resolve(value);});
    worker.once("error",()=>{clearTimeout(timer);reject(new Error("pdf_processing_failed"));});
    worker.once("exit",()=>{clearTimeout(timer);reject(new Error("pdf_processing_failed"));});
  }).finally(()=>{active--;}) as Promise<{pages:number;data?:Uint8Array}>;
}
