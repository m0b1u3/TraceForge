import {expect,it} from "vitest";
import {createDb,getSqliteClient} from "./db/client.js";
import {SqliteScenarioTrafficStore} from "./scenario-traffic-store.js";

it("persists destination authorization atomically with its correctly owned exchange",()=>{
  const db=getSqliteClient(createDb(":memory:")),store=new SqliteScenarioTrafficStore(db),at="2026-09-21T00:00:00.000Z";
  const destination={canonicalUrl:"https://first.example/",hostname:"first.example",address:"10.0.0.1",family:4 as const,port:443,authorizationRef:"grant",addressAuthorizationRefs:["address-grant"],expiresAt:"2099-01-01T00:00:00.000Z"};
  const input={trafficId:"traffic",caseId:"case",runId:"run",url:destination.canonicalUrl,method:"GET",requestHeaders:{},requestBody:null,responseStatus:200,responseHeaders:{},responseSize:2,contentType:"text/plain",responseBody:"ok",createdAt:at,
    receipt:{id:"receipt",nodeId:"local",requestId:"request",authorizationRef:"grant",authorizationAction:"read",url:destination.canonicalUrl,method:"GET",status:200,requestBytes:0,responseBytes:2,responseBodyTruncated:false,permissionProfileFingerprint:"a".repeat(64),redirectFollowed:false as const,startedAt:at,completedAt:at,destination,
      attribution:{caseId:"case",runId:"run",workId:"work",workerId:"worker",scopeRef:"scope",leaseId:"lease",leaseExpiresAt:destination.expiresAt,actionId:"action",idempotencyKey:"key"}}};
  try{
    expect(()=>store.recordHttpExchange({...input,runId:"other"})).toThrow("does not match");
    expect(db.prepare("SELECT COUNT(*) AS total FROM traffic_entries").get()).toEqual({total:0});
    store.recordHttpExchange(input);
    const row=db.prepare("SELECT destination_json FROM execution_network_receipts WHERE id='receipt'").get() as {destination_json:string};
    expect(JSON.parse(row.destination_json)).toEqual(destination);
    expect(()=>store.recordHttpExchange({...input,trafficId:"second"})).toThrow();
    expect(db.prepare("SELECT COUNT(*) AS total FROM traffic_entries").get()).toEqual({total:1});
  }finally{db.close();}
});
