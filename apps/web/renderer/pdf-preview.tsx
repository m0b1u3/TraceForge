import React,{useEffect,useRef,useState} from "react";
// Electron's pinned Chromium can lag PDF.js's modern browser baseline.
// Use the matching compatibility builds in both the renderer and worker.
import {getDocument,GlobalWorkerOptions} from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
GlobalWorkerOptions.workerSrc=workerUrl;
/** Canvas only: no annotation links, embedded JavaScript, forms or HTML layer. */
export function PdfPreview({data}:{data:string}){
  const canvas=useRef<HTMLCanvasElement>(null),[error,setError]=useState("");
  useEffect(()=>{let active=true;setError("");
    const task=getDocument({data:Uint8Array.from(atob(data),c=>c.charCodeAt(0)),useSystemFonts:true,disableFontFace:true});
    void task.promise.then(async doc=>{const page=await doc.getPage(1);if(!active||!canvas.current)return;
      const natural=page.getViewport({scale:1}),scale=Math.min(1.5,1600/natural.width,2200/natural.height),viewport=page.getViewport({scale});
      if(!Number.isFinite(viewport.width)||!Number.isFinite(viewport.height)||viewport.width<=0||viewport.height<=0)throw Error();
      canvas.current.width=Math.ceil(viewport.width);canvas.current.height=Math.ceil(viewport.height);
      await page.render({canvas:canvas.current,viewport}).promise;
    }).catch(()=>{if(active)setError("PDF 页面无法渲染，请尝试其他页面或检查文件。");});
    return()=>{active=false;void task.destroy();};
  },[data]);
  return error?<p role="alert">{error}</p>:<canvas ref={canvas} role="img" aria-label="PDF 当前页"/>;
}
