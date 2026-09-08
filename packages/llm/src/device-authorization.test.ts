import { describe, expect, it } from "vitest";
import { DeviceAuthorizationConnection, type OAuthTokenRecord, type OAuthTokenStore } from "./device-authorization.js";

function fixture() {
  let now=100000;const values=new Map<string,OAuthTokenRecord>();let mode="pending",refreshes=0;
  const store:OAuthTokenStore={async read(id){return values.get(id);},async write(id,value){values.set(id,value);},async remove(id){values.delete(id);}};
  const requests:Array<{url:string;body:string}>=[];
  const transport:typeof fetch=async(input,init)=>{
    const request=new Request(input,init),body=await request.text();requests.push({url:request.url,body});
    if(request.url.endsWith("openid-configuration"))return Response.json({issuer:"https://identity.example",device_authorization_endpoint:"https://identity.example/device",token_endpoint:"https://identity.example/token"});
    if(request.url.endsWith("/device"))return Response.json({device_code:"private-device-code",user_code:"public-code",verification_uri:"https://identity.example/activate",expires_in:600,interval:5});
    if(body.includes("grant_type=refresh_token")){refreshes++;return Response.json({access_token:"refreshed-token",refresh_token:"rotated-refresh",expires_in:3600,token_type:"Bearer"});}
    if(mode==="pending")return Response.json({error:"authorization_pending"},{status:400});
    if(mode==="slow")return Response.json({error:"slow_down"},{status:400});
    if(mode==="denied")return Response.json({error:"access_denied",error_description:"do not expose private material"},{status:400});
    return Response.json({access_token:"access-token",refresh_token:"refresh-token",expires_in:120,token_type:"Bearer"});
  };
  const config={issuer:"https://identity.example",clientId:"traceforge-test-registration",scopes:["api:access"],apiBaseUrl:"https://model.example/v1"};
  const connection=new DeviceAuthorizationConnection(config,store,transport,()=>now);
  return {connection,config,store,values,requests,setMode:(value:string)=>{mode=value;},tick:(ms:number)=>{now+=ms;},refreshes:()=>refreshes};
}
describe("Model device authorization (no built-in third-party CLI identity)",()=>{
  it("completes device login, respects polling, refreshes once and disconnects",async()=>{
    const f=fixture(),login=await f.connection.begin();
    expect(JSON.stringify(login)).not.toContain("private-device-code");
    expect(await f.connection.poll(login.pendingId,"account")).toBe("pending");
    expect(f.requests).toHaveLength(2);
    f.tick(5000);expect(await f.connection.poll(login.pendingId,"account")).toBe("pending");
    f.setMode("success");f.tick(5000);expect(await f.connection.poll(login.pendingId,"account")).toBe("connected");
    expect(await f.connection.resolve("account")).toMatchObject({value:"access-token",baseUrl:"https://model.example/v1"});
    f.tick(61000);
    const tokens=await Promise.all([f.connection.resolve("account"),f.connection.resolve("account")]);
    expect(tokens.map(value=>value.value)).toEqual(["refreshed-token","refreshed-token"]);expect(f.refreshes()).toBe(1);
    await f.connection.disconnect("account");await expect(f.connection.resolve("account")).rejects.toThrow(/login/);
  });
  it("does not expose provider error bodies and handles slow-down/cancellation/expiry",async()=>{
    const f=fixture();let login=await f.connection.begin();f.tick(5000);f.setMode("slow");
    await f.connection.poll(login.pendingId,"account");const count=f.requests.length;f.tick(5000);
    expect(await f.connection.poll(login.pendingId,"account")).toBe("pending");expect(f.requests).toHaveLength(count);
    f.connection.cancel(login.pendingId);await expect(f.connection.poll(login.pendingId,"account")).rejects.toThrow(/canceled/);
    login=await f.connection.begin();f.tick(5000);f.setMode("denied");await expect(f.connection.poll(login.pendingId,"account")).rejects.toThrow("Model login denied or expired");
    login=await f.connection.begin();f.tick(601000);await expect(f.connection.poll(login.pendingId,"account")).rejects.toThrow(/expired/);
  });
  it("rejects discovery endpoint substitution and cross-connection token reuse",async()=>{
    const f=fixture();const connection=new DeviceAuthorizationConnection(f.config,f.store,async()=>Response.json({issuer:f.config.issuer,
      device_authorization_endpoint:"https://other.example/device",token_endpoint:"https://identity.example/token"}));
    await expect(connection.begin()).rejects.toThrow(/escaped/);
    const login=await f.connection.begin();f.tick(5000);f.setMode("success");await f.connection.poll(login.pendingId,"account");
    const other=new DeviceAuthorizationConnection({...f.config,clientId:"different-client"},f.store);
    await expect(other.resolve("account")).rejects.toThrow(/this connection/);
  });
});
