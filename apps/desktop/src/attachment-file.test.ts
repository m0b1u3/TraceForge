import {expect,it} from "vitest";
import {mkdtemp,writeFile,symlink,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {readSelectedAttachment} from "./attachment-file.js";

it("reads a bounded selected regular file without following symlinks",async()=>{
  const root=await mkdtemp(join(tmpdir(),"tf-selected-file-"));
  try{
    await writeFile(join(root,"source.txt"),"Selected content");
    expect(await readSelectedAttachment(join(root,"source.txt"))).toEqual({name:"source.txt",data:Buffer.from("Selected content").toString("base64")});
    await symlink(join(root,"source.txt"),join(root,"link.txt"));
    await expect(readSelectedAttachment(join(root,"link.txt"))).rejects.toThrow();
    await expect(readSelectedAttachment(root)).rejects.toThrow();
    await writeFile(join(root,"large.txt"),Buffer.alloc(32*1048576+1));
    await expect(readSelectedAttachment(join(root,"large.txt"))).rejects.toThrow("file_size_invalid");
  }finally{await rm(root,{recursive:true,force:true});}
});
