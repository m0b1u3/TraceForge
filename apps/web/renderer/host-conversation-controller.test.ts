import {expect,it} from "vitest";
import {HostConversationController} from "./host-conversation-controller";
import {ConversationClient} from "./conversation-client";
it("preserves a retired review message without silently invoking the wider agent",async()=>{
  let raw=JSON.stringify({kind:"send",commandId:"message",conversationId:"first",text:"Old review",reply:true,review:[{id:"source"}]});
  const paths:string[]=[];
  const client=new ConversationClient(async(path,init)=>{
    paths.push(path);const body=JSON.parse(init.body!);
    return {ok:true,status:200,json:async()=>({conversationId:"first",commandId:body.commandId,sequence:1,text:body.text,createdAt:"2026-09-08",role:"user",persistence:"saved",delivery:"not_dispatched",reason:"conversation_dispatch_not_connected"})};
  });
  const controller=new HostConversationController(client,{getItem:()=>raw,setItem:(_,value)=>{raw=value;}});
  expect(controller.pending).toMatchObject({reply:false});
  await controller.execute();
  expect(paths).toEqual(["/api/desktop/conversations/first/messages"]);
  expect(controller.replyNotice).toContain("未重新调用模型");
  expect(raw).toBe("null");
});
it("retains agent reply intent across response loss",async()=>{
  const data=new Map<string,string>(),storage={getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value);}};
  const calls:string[]=[];let lose=true;
  const client=new ConversationClient(async(path,init)=>{
    calls.push(path);const body=JSON.parse(init.body!);
    if(path.includes("/replies/")){
      if(lose){lose=false;throw new Error("lost response");}
      expect(body).toEqual({});
      return {ok:true,status:200,json:async()=>({conversationId:"first",messageCommandId:"message",revision:1,state:"completed",text:"Answer",createdAt:"2026-09-08T00:00:00.000Z",updatedAt:"2026-09-08T00:00:00.000Z",contextMessages:1,contextTruncated:false,error:null})};
    }
    return {ok:true,status:200,json:async()=>({conversationId:"first",commandId:body.commandId,sequence:1,text:body.text,createdAt:"2026-09-08",role:"user",persistence:"saved",delivery:"not_dispatched",reason:"conversation_dispatch_not_connected"})};
  });
  await expect(new HostConversationController(client,storage).execute({kind:"send",commandId:"message",conversationId:"first",text:"Question",reply:true})).rejects.toThrow();
  const restored=new HostConversationController(client,storage);expect(restored.pending).toMatchObject({reply:true,commandId:"message"});
  await restored.execute();expect(restored.pending).toBeNull();
  expect(calls.filter(path=>path.includes("/replies/"))).toEqual(["/api/desktop/conversations/first/replies/message","/api/desktop/conversations/first/replies/message"]);
});
it("reconciles interrupted first-message creation with original identities and without dispatch",async()=>{
  const data=new Map<string,string>();const storage={getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value);}};
  const calls:Array<{path:string;body:any}>=[];let fail=true;
  const client=new ConversationClient(async(path,init)=>{
    const body=JSON.parse(init.body!);calls.push({path,body});
    if(path.endsWith("messages")&&fail){fail=false;throw new Error("Disconnected after acceptance");}
    return {ok:true,status:200,json:async()=>path.endsWith("messages")?{conversationId:"first",commandId:body.commandId,sequence:1,text:body.text,createdAt:"2026-09-08",role:"user",persistence:"saved",delivery:"not_dispatched",reason:"conversation_dispatch_not_connected"}:{id:"first",caseId:"case",title:body.title,createdAt:"2026-09-08"}};
  });
  const controller=new HostConversationController(client,storage);
  await expect(controller.execute({kind:"start",commandId:"create-first",messageCommandId:"message-first",title:"First",text:"Investigate"})).rejects.toThrow();
  const recovered=new HostConversationController(client,storage);expect(recovered.pending?.kind).toBe("start");
  await recovered.execute();expect(recovered.pending).toBeNull();
  expect(calls.map(c=>c.body.commandId)).toEqual(["create-first","message-first","create-first","message-first"]);
  expect(calls.every(c=>!c.path.includes("execution"))).toBe(true);
});
