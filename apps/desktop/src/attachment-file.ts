import {open} from "node:fs/promises";
import {constants} from "node:fs";
import {basename} from "node:path";
/** Called only with a path returned by the native file dialog, not IPC arguments. */
export async function readSelectedAttachment(path:string){
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const before=await file.stat();
    if(!before.isFile()||before.size<=0||before.size>32*1048576)throw new Error("file_size_invalid");
    const bytes=Buffer.alloc(before.size);let offset=0;
    while(offset<bytes.length){const result=await file.read(bytes,offset,bytes.length-offset,offset);if(!result.bytesRead)throw new Error("file_changed");offset+=result.bytesRead;}
    const after=await file.stat();
    if(before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw new Error("file_changed");
    return {name:basename(path),data:bytes.toString("base64")};
  }finally{await file.close();}
}
