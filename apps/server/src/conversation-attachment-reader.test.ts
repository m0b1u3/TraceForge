import {expect,it} from "vitest";
import {createDb,getSqliteClient} from "./db/client.js";
import {initializeConversationAttachments} from "./conversation-attachments.js";
import {ConversationAttachmentReader} from "./conversation-attachment-reader.js";

it("indexes retained originals with host-owned scope, cutoff, pagination and digest",()=>{
  const sql=getSqliteClient(createDb(":memory:"));
  try{
    initializeConversationAttachments(sql);
    for(const c of ["first","other"]){
      sql.prepare("INSERT INTO cases (id,name,status,scope_rules_json,created_at) VALUES (?,?,'active','[]','now')").run(c,c);
      sql.prepare("INSERT INTO desktop_conversations VALUES (?,?,?,?,?)").run(c,c,c,c,"now");
      for(let n=1;n<=7;n++){
        sql.prepare("INSERT INTO desktop_conversation_messages VALUES (?,?,?,?,?)").run(c,`m${n}`,n,"Message","now");
        sql.prepare("INSERT INTO desktop_message_attachments VALUES (?,?,?)").run(c,`m${n}`,JSON.stringify([{kind:"text",name:`file${n}.txt`,text:`${c} original ${n}`} ]));
      }
    }
    const reader=new ConversationAttachmentReader(sql,"first",6);
    const first=reader.execute({id:"index",name:"conversation_attachments",input:{}}).result as any;
    expect(first.matches).toHaveLength(5);expect(first.nextAfter).toBe(5);expect(JSON.stringify(first)).not.toContain("original");
    const next=reader.execute({id:"next",name:"conversation_attachments",input:{after:5}}).result as any;
    expect(next.matches).toHaveLength(1);expect(next.nextAfter).toBeNull();
    const match=first.matches[0],input={messageId:match.messageId,index:match.index,digest:match.digest};
    expect(reader.execute({id:"read",name:"conversation_attachment_read",input}).attachment).toMatchObject({text:"first original 1"});
    expect(new ConversationAttachmentReader(sql,"other",6).execute({id:"read",name:"conversation_attachment_read",input}).result).toEqual({error:"attachment_changed"});
    expect(reader.execute({id:"future",name:"conversation_attachment_read",input:{...input,messageId:"m7"}}).result).toEqual({error:"attachment_not_available"});
    expect(()=>reader.execute({id:"bad",name:"conversation_attachment_read",input:{...input,conversationId:"other"}})).toThrow();
    const filtered=reader.execute({id:"filter",name:"conversation_attachments",input:{query:"file6"}}).result as any;
    expect(filtered.matches).toHaveLength(1);
    sql.prepare("UPDATE desktop_message_attachments SET content_json=? WHERE conversation_id='first' AND command_id='m1'").run(JSON.stringify([{kind:"text",name:"file1.txt",text:"changed"}]));
    expect(reader.execute({id:"changed",name:"conversation_attachment_read",input}).result).toEqual({error:"attachment_changed"});
  }finally{sql.close();}
});
