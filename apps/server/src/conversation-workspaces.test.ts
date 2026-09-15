import Fastify from "fastify";
import { mkdtempSync, realpathSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createDb, getSqliteClient } from "./db/client.js";
import { registerConversationRoutes } from "./conversation-routes.js";
import { ConversationWorkspaces } from "./conversation-workspaces.js";
import { managedWorkspacePath } from "@traceforge/worker-runtime";

it("preserves legacy Run paths, immutable ownership and saved files after reopening",async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),"traceforge-workspace-binding-")));
  const db=createDb(":memory:"),sql=getSqliteClient(db),app=Fastify(),store=new ConversationWorkspaces(sql,root);
  registerConversationRoutes(app,db,store);
  try{
    const conversation=(await app.inject({url:"/api/desktop/conversations",method:"POST",payload:{commandId:"new",title:"Task"}})).json();
    const directory=store.ensure(conversation.id,conversation.caseId);
    expect(existsSync(directory)).toBe(true);
    writeFileSync(join(directory,"saved.txt"),"saved");
    const legacy=managedWorkspacePath(store.base,conversation.caseId,"old-run");
    expect(store.root(conversation.caseId,"old-run")).toBe(legacy);
    sql.prepare("INSERT INTO scenario_event_streams(run_id,case_id,definition_kind,definition_version,status,active_phase_id,revision,created_at,updated_at) VALUES(?,?,'neutral',1,'paused','first',1,'2026-09-15','2026-09-15')").run("old-run",conversation.caseId);
    store.bind(conversation.id,conversation.caseId,"old-run");
    expect(store.root(conversation.caseId,"old-run")).toBe(legacy);
    store.bind(conversation.id,conversation.caseId,"new-run");
    const reopened=new ConversationWorkspaces(sql,root);
    expect(reopened.root(conversation.caseId,"new-run")).toBe(directory);
    expect(existsSync(join(directory,"saved.txt"))).toBe(true);
    expect(()=>reopened.bind(conversation.id,"another-case","new-run")).toThrow("ownership");
    rmSync(directory,{recursive:true});
    expect(()=>reopened.root(conversation.caseId,"new-run")).toThrow("recovery");
    expect(()=>reopened.ensure(conversation.id,conversation.caseId)).toThrow("recovery");
    expect(existsSync(directory)).toBe(false);
  }finally{await app.close();sql.close();rmSync(root,{recursive:true,force:true});}
});

it("restores the same workspace binding after closing and reopening the database",async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),"traceforge-workspace-reopen-"))),path=join(root,"state.sqlite");
  const db=createDb(path),sql=getSqliteClient(db),app=Fastify(),store=new ConversationWorkspaces(sql,root);
  registerConversationRoutes(app,db,store);
  try{
    const conversation=(await app.inject({url:"/api/desktop/conversations",method:"POST",payload:{commandId:"new",title:"Task"}})).json();
    store.bind(conversation.id,conversation.caseId,"run");
    const directory=store.root(conversation.caseId,"run");
    writeFileSync(join(directory,"saved.txt"),"saved");
    await app.close();sql.close();
    const reopened=getSqliteClient(createDb(path));
    try{
      const restored=new ConversationWorkspaces(reopened,root);
      expect(restored.root(conversation.caseId,"run")).toBe(directory);
      expect(existsSync(join(directory,"saved.txt"))).toBe(true);
    }finally{reopened.close();}
  }finally{await app.close();if(sql.open)sql.close();rmSync(root,{recursive:true,force:true});}
});

it("does not report a created conversation if its automatic directory cannot be created",async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),"traceforge-workspace-failure-")));
  const db=createDb(":memory:"),sql=getSqliteClient(db),app=Fastify(),store=new ConversationWorkspaces(sql,root);
  registerConversationRoutes(app,db,store);
  try{
    writeFileSync(join(root,"data"),"not a directory");
    const result=await app.inject({url:"/api/desktop/conversations",method:"POST",payload:{commandId:"new",title:"Task"}});
    expect(result.statusCode).toBe(500);
    expect(sql.prepare("SELECT count(*) AS n FROM desktop_conversations").get()).toEqual({n:0});
    expect(sql.prepare("SELECT count(*) AS n FROM desktop_conversation_workspaces").get()).toEqual({n:0});
  }finally{await app.close();sql.close();rmSync(root,{recursive:true,force:true});}
});
