import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { conversationReadReceipts } from "./conversation-read-receipts.js";

it("counts only successful text reads belonging to this reply, not search or memory",()=>{
  const sql=new Database(":memory:");
  try {
    sql.exec("CREATE TABLE desktop_reply_reads(conversation_id TEXT,message_id TEXT,ordinal INTEGER,tool TEXT,result_json TEXT)");
    const insert=sql.prepare("INSERT INTO desktop_reply_reads VALUES(?,?,?,?,?)");
    const page={id:"source",digest:"snapshot",offset:0,text:"detail"};
    insert.run("c","m",1,"conversation_read",JSON.stringify(page));
    insert.run("c","m",2,"conversation_search",JSON.stringify(page));
    insert.run("c","m",3,"memory_recall",JSON.stringify(page));
    insert.run("c","m",4,"conversation_read",JSON.stringify({...page,error:"original_changed"}));
    insert.run("c","m",5,"conversation_read",JSON.stringify({...page,text:""}));
    insert.run("other","m",1,"conversation_read",JSON.stringify(page));
    insert.run("c","earlier",1,"conversation_read",JSON.stringify(page));
    insert.run("c","m",6,"conversation_read_sources",JSON.stringify({sources:[page]}));
    expect(conversationReadReceipts(sql,"c","m")).toEqual([
      {id:"source",digest:"snapshot",start:0,end:6},
      {id:"source",digest:"snapshot",start:0,end:6},
    ]);
  } finally {sql.close();}
});
