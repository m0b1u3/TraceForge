import {
  SCENARIO_PROCESS_HOST_CAPABILITIES,
  type ScenarioPackageInstallation,
  type ScenarioToolHostContext,
} from "@traceforge/scenario-sdk";
import type { ScenarioPackageCapabilityHandler } from "@traceforge/worker-runtime";
import type { ExecutionNode } from "@traceforge/execution-node";
import { createHash, randomUUID } from "node:crypto";
import type { ExecutionCookie, ExecutionSessionGateway, SessionMaterial } from "./execution-session-gateway.js";
import type { SqliteScenarioTrafficStore } from "./scenario-traffic-store.js";

/** Maps the generic Scenario SDK ports onto serializable, ownership-fixed RPC calls. */
export function createScenarioProcessCapabilityHandlers(
  installation: Pick<ScenarioPackageInstallation, "id" | "version">,
  context: Omit<ScenarioToolHostContext, "execution" | "capabilities">,
  now: () => string = () => new Date().toISOString(),
  executionNode?: ExecutionNode,
  sessions?: Pick<ExecutionSessionGateway,"listIdentities"|"openSession"|"use"|"updateCookies"|"updateValues"|"listSessions"|"close">,
  traffic?: Pick<SqliteScenarioTrafficStore,"recordHttpExchange"|"listRun">,
): ScenarioPackageCapabilityHandler[] {
  const owner = { packageId: installation.id, packageVersion: installation.version };
  return [
    {
      capability: SCENARIO_PROCESS_HOST_CAPABILITIES.authorization,
      actions: ["require", "authorize_resource"],
      async execute(value, attribution) {
        const input = record(value);
        if (input.action === undefined || typeof input.action !== "string") throw new Error("Scenario authorization action is required");
        if (input.resourceKind === undefined && input.value === undefined) {
          exact(input, ["action"]);
          return { output: context.authorization.requireAction(attribution.scopeRef, attribution.caseId, input.action), refs: [] };
        }
        exact(input, ["action", "resourceKind", "value"]);
        if (typeof input.resourceKind !== "string" || typeof input.value !== "string") throw new Error("Scenario resource authorization is invalid");
        return { output: context.authorization.authorizeResource(attribution.scopeRef, attribution.caseId,
          input.action, input.resourceKind, input.value), refs: [] };
      },
    },
    {
      capability: SCENARIO_PROCESS_HOST_CAPABILITIES.evidence,
      actions: ["record_node"],
      async execute(value, attribution) {
        const input = record(value); exact(input, ["commandId", "node"]);
        const commandId = text(input.commandId, "Evidence command id");
        const node = record(input.node) as unknown as Parameters<ScenarioToolHostContext["evidence"]["recordNode"]>[0]["node"];
        const refs = context.evidence.recordNode({ commandId: scopedCommand(attribution.idempotencyKey, commandId),
          caseId: attribution.caseId, runId: attribution.runId, node: structuredClone(node), at: now() });
        return { output: { refs }, refs };
      },
    },
    {
      capability: SCENARIO_PROCESS_HOST_CAPABILITIES.artifacts,
      actions: ["record", "get", "list"],
      async execute(value, attribution) {
        const input = record(value); const operation = text(input.operation, "Artifact operation");
        if (operation === "record") {
          exact(input, ["operation", "commandId", "kind", "summary", "contentRef", "digest", "byteSize", "metadata"]);
          const artifact = context.artifacts.record({ ...owner, commandId: scopedCommand(attribution.idempotencyKey, text(input.commandId, "Artifact command id")),
            caseId: attribution.caseId, runId: attribution.runId, kind: text(input.kind, "Artifact kind"),
            summary: text(input.summary, "Artifact summary"), contentRef: text(input.contentRef, "Artifact content reference"),
            digest: text(input.digest, "Artifact digest") as `sha256:${string}`, byteSize: integer(input.byteSize, "Artifact byte size"),
            metadata: structuredClone(record(input.metadata)) });
          return { output: artifact, refs: [artifact.contentRef] };
        }
        if (operation === "get") {
          exact(input, ["operation", "artifactId"]);
          const artifact = context.artifacts.get({ ...owner, caseId: attribution.caseId, artifactId: text(input.artifactId, "Artifact id") });
          if (artifact && artifact.runId !== attribution.runId) throw new Error("Scenario artifact belongs to another Run");
          return { output: artifact ?? null, refs: artifact ? [artifact.contentRef] : [] };
        }
        if (operation === "list") {
          exact(input, ["operation", "limit"]);
          const artifacts = context.artifacts.list({ ...owner, caseId: attribution.caseId, runId: attribution.runId,
            limit: integer(input.limit, "Artifact list limit") });
          return { output: artifacts, refs: artifacts.map((artifact) => artifact.contentRef) };
        }
        throw new Error(`Unsupported Scenario artifact operation ${operation}`);
      },
    },
    {
      capability: SCENARIO_PROCESS_HOST_CAPABILITIES.state,
      actions: ["read", "compare_and_set"],
      async execute(value, attribution) {
        const input = record(value); const operation = text(input.operation, "State operation");
        if (operation === "read") {
          exact(input, ["operation", "key"]);
          return { output: context.state.read({ ...owner, caseId: attribution.caseId, runId: attribution.runId,
            key: text(input.key, "State key") }) ?? null, refs: [] };
        }
        if (operation === "compare_and_set") {
          exact(input, ["operation", "commandId", "key", "expectedRevision", "value"]);
          return { output: context.state.compareAndSet({ ...owner, caseId: attribution.caseId, runId: attribution.runId,
            commandId: scopedCommand(attribution.idempotencyKey, text(input.commandId, "State command id")), key: text(input.key, "State key"),
            expectedRevision: integer(input.expectedRevision, "Expected State revision"), value: structuredClone(input.value) }), refs: [] };
        }
        throw new Error(`Unsupported Scenario state operation ${operation}`);
      },
    },
    ...(sessions?[{
      capability:SCENARIO_PROCESS_HOST_CAPABILITIES.sessions,
      actions:["list_identities","open","list","close"],
      async execute(value,attribution){
        const input=record(value),operation=text(input.operation,"Session operation"),authorizationAction=text(input.authorizationAction,"Session authorization action");
        context.authorization.requireAction(attribution.scopeRef,attribution.caseId,authorizationAction);
        if(operation==="list_identities"){
          exact(input,["operation","authorizationAction","resourceKind"]);const resourceKind=text(input.resourceKind,"Identity resource kind");
          const identities=sessions.listIdentities(attribution.caseId).filter(identity=>{try{context.authorization.authorizeResource(attribution.scopeRef,
            attribution.caseId,authorizationAction,resourceKind,identity.id);return true;}catch{return false;}});
          return {output:identities,refs:[]};
        }
        if(operation==="open"){
          exact(input,["operation","authorizationAction","resourceKind","identityId","ttlMs"]);
          const identityId=input.identityId===null?undefined:text(input.identityId,"Identity id");
          if(identityId)context.authorization.authorizeResource(attribution.scopeRef,attribution.caseId,authorizationAction,
            text(input.resourceKind,"Identity resource kind"),identityId);
          const ttlMs=integer(input.ttlMs,"Session lifetime");if(ttlMs<60_000||ttlMs>24*60*60_000)throw new Error("Session lifetime is invalid");
          const session=sessions.openSession({caseId:attribution.caseId,runId:attribution.runId,scopeRef:attribution.scopeRef,identityId,ttlMs});
          return {output:session,refs:[`execution-session:${session.id}`]};
        }
        if(operation==="list"){
          exact(input,["operation","authorizationAction"]);
          return {output:sessions.listSessions(attribution.runId),refs:[]};
        }
        if(operation==="close"){
          exact(input,["operation","authorizationAction","sessionId"]);const sessionId=text(input.sessionId,"Session id");
          if(!sessions.listSessions(attribution.runId).some(item=>item.id===sessionId))throw new Error("Execution Session does not belong to the assigned Run");
          const session=sessions.close(sessionId);return {output:session,refs:[`execution-session:${session.id}`]};
        }
        throw new Error(`Unsupported Scenario session operation ${operation}`);
      },
    } satisfies ScenarioPackageCapabilityHandler]:[]),
    ...(traffic?[{
      capability:SCENARIO_PROCESS_HOST_CAPABILITIES.traffic,
      actions:["list"],
      async execute(value,attribution){
        const input=record(value);exact(input,["operation","authorizationAction","limit"]);
        if(text(input.operation,"Traffic operation")!=="list")throw new Error("Unsupported Scenario traffic operation");
        context.authorization.requireAction(attribution.scopeRef,attribution.caseId,text(input.authorizationAction,"Traffic authorization action"));
        return {output:traffic.listRun(attribution.caseId,attribution.runId,integer(input.limit,"Traffic list limit")),refs:[]};
      },
    } satisfies ScenarioPackageCapabilityHandler]:[]),
    ...(executionNode ? [{
      capability: SCENARIO_PROCESS_HOST_CAPABILITIES.execution,
      actions: ["request_http","request_http_session"],
      async execute(value, attribution, signal) {
        const input=record(value),sessionRequest=input.sessionId!==undefined;
        exact(input,sessionRequest
          ?["authorizationAction","sessionAuthorizationAction","sessionId","url","method","headers","bodyBase64","secretBody","captures","timeoutMs","responseLimitBytes"]
          :["authorizationAction","url","method","headers","bodyBase64","timeoutMs","responseLimitBytes"],sessionRequest?["bodyBase64","secretBody","captures"]:[]);
        const authorizationAction=text(input.authorizationAction,"HTTP authorization action"),url=text(input.url,"HTTP URL"),method=text(input.method,"HTTP method");
        if(!input.headers||typeof input.headers!=="object"||Array.isArray(input.headers)||Object.keys(input.headers).length>128
          ||Object.entries(input.headers).some(([name,item])=>!name.trim()||name.length>256||typeof item!=="string"||Buffer.byteLength(item)>8192))throw new Error("HTTP headers are invalid");
        const timeoutMs=integer(input.timeoutMs,"HTTP timeout"),responseLimitBytes=integer(input.responseLimitBytes,"HTTP response limit");
        if(timeoutMs<1||timeoutMs>120_000||responseLimitBytes<1||responseLimitBytes>4*1024*1024)throw new Error("HTTP execution limits are invalid");
        if(input.bodyBase64!==undefined&&(typeof input.bodyBase64!=="string"||Buffer.byteLength(input.bodyBase64)>2*1024*1024
          ||Buffer.from(input.bodyBase64,"base64").toString("base64")!==input.bodyBase64))throw new Error("HTTP body is invalid");
        if(input.bodyBase64!==undefined&&input.secretBody!==undefined)throw new Error("Authenticated HTTP body forms are mutually exclusive");
        let material:SessionMaterial|undefined,headers=structuredClone(input.headers as Record<string,string>);
        if(sessionRequest){
          if(!sessions||!traffic)throw new Error("Authenticated HTTP requires Session and Traffic Host capabilities");
          const sessionAuthorizationAction=text(input.sessionAuthorizationAction,"Session authorization action");
          context.authorization.requireAction(attribution.scopeRef,attribution.caseId,sessionAuthorizationAction);
          material=sessions.use(text(input.sessionId,"Session id"),attribution);
          headers=sessionHeaders(material,url,headers);
        }
        const secretBody=material&&input.secretBody!==undefined?buildSecretBody(input.secretBody,material):undefined;
        if(secretBody&&!Object.keys(headers).some(name=>name.toLowerCase()==="content-type"))headers["Content-Type"]=secretBody.contentType;
        const requestBodyBase64=secretBody?.bodyBase64??input.bodyBase64 as string|undefined;
        signal.throwIfAborted();
        const response=await executionNode.requestHttp({requestId:`scenario-http:${randomUUID()}`,authorizationAction,url,method,
          headers,...(requestBodyBase64===undefined?{}:{bodyBase64:requestBodyBase64}),
          timeoutMs,responseLimitBytes,attribution:{caseId:attribution.caseId,runId:attribution.runId,workId:attribution.workId,
            workerId:attribution.workerId,scopeRef:attribution.scopeRef,leaseId:attribution.leaseId,
            leaseExpiresAt:attribution.leaseExpiresAt,idempotencyKey:`scenario-http:${attribution.idempotencyKey}`,
            actionId:`scenario-http:${attribution.idempotencyKey}`},permissions:structuredClone(attribution.effectivePermissions)});
        signal.throwIfAborted();
        if(!material)return {output:response,refs:[`network-receipt:${response.receipt.id}`]};
        const cookies=responseCookies(response.headers,url);if(cookies.length)sessions!.updateCookies(material.session.id,cookies);
        const captured=captureSecrets(response,input.captures);if(Object.keys(captured).length)sessions!.updateValues(material.session.id,captured);
        const sanitized=sanitizeSessionResponse(response,material,cookies,Object.values(captured)),trafficId=`scenario-traffic:${randomUUID()}`;
        traffic!.recordHttpExchange({trafficId,caseId:attribution.caseId,runId:attribution.runId,url:response.receipt.url,method:response.receipt.method,
          requestHeaders:redactedRequestHeaders(headers),requestBody:secretBody?.redactedTemplate??(requestBodyBase64?`[sha256:${sha(Buffer.from(requestBodyBase64,"base64"))}]`:null),
          responseStatus:response.status,responseHeaders:Object.fromEntries(sanitized.headers.map(item=>[item.name,item.value])),responseSize:response.responseBytes,
          contentType:response.headers.find(item=>item.name.toLowerCase()==="content-type")?.value??null,
          responseBody:textBody(sanitized).slice(0,16*1024)||null,receipt:response.receipt,createdAt:now(),identityId:material.session.identityId,
          identityVersion:material.session.identityVersion,attributionSource:"scenario_session"});
        return {output:{...sanitized,session:material.session,trafficId,capturedSecretNames:Object.keys(captured).sort()},refs:[`network-receipt:${response.receipt.id}`,`traffic:${trafficId}`,
          `execution-session:${material.session.id}`]};
      },
    } satisfies ScenarioPackageCapabilityHandler] : []),
  ];
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error("Scenario capability input must be a plain object");
  }
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[],optional:string[]=[]): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key)) || keys.some((key) => !optional.includes(key)&&!(key in value))) {
    throw new Error("Scenario capability input fields are invalid");
  }
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > 64 * 1024) throw new Error(`${label} is invalid`);
  return value.trim();
}
function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} is invalid`);
  return Number(value);
}
function scopedCommand(parent: string, command: string): string { return `scenario-process:${parent}:${command}`; }

const sensitiveHeaders=new Set(["authorization","cookie","proxy-authorization","set-cookie","x-api-key"]);
function sessionHeaders(material:SessionMaterial,rawUrl:string,publicHeaders:Record<string,string>):Record<string,string>{
  if(Object.keys(publicHeaders).some(name=>sensitiveHeaders.has(name.toLowerCase())))throw new Error("Authenticated HTTP secrets must come from the Host Session");
  const url=new URL(rawUrl);if(Object.keys(material.headers).length&&!material.urlPrefixes.some(prefix=>url.href.startsWith(prefix)))
    throw new Error("Execution identity secret headers are not authorized for this URL");
  const headers={...publicHeaders,...material.headers},cookies=material.cookies.filter(cookie=>cookieFor(cookie,url));
  if(cookies.length)headers.Cookie=cookies.map(cookie=>`${cookie.name}=${cookie.value}`).join("; ");
  return headers;
}
function cookieFor(cookie:ExecutionCookie,url:URL):boolean{
  if(!cookie.domain||cookie.expires!==undefined&&cookie.expires<=Date.now()/1000||cookie.secure&&url.protocol!=="https:")return false;
  const domain=cookie.domain.toLowerCase().replace(/^\./,""),host=url.hostname.toLowerCase();
  if(cookie.hostOnly?host!==domain:host!==domain&&!host.endsWith(`.${domain}`))return false;
  const path=cookie.path??"/";return url.pathname===path||url.pathname.startsWith(path.endsWith("/")?path:`${path}/`);
}
function responseCookies(headers:Array<{name:string;value:string}>,rawUrl:string):ExecutionCookie[]{
  const url=new URL(rawUrl),result:ExecutionCookie[]=[];
  for(const header of headers.filter(item=>item.name.toLowerCase()==="set-cookie").slice(0,64)){
    const parts=header.value.split(";").map(value=>value.trim()),first=parts.shift()??"",separator=first.indexOf("=");
    if(separator<1)continue;const cookie:ExecutionCookie={name:first.slice(0,separator),value:first.slice(separator+1),domain:url.hostname,
      path:url.pathname.includes("/")?url.pathname.slice(0,url.pathname.lastIndexOf("/")+1)||"/":"/",hostOnly:true};
    for(const part of parts){const [rawName,...rest]=part.split("="),name=rawName!.toLowerCase(),value=rest.join("=");
      if(name==="domain"){const domain=value.toLowerCase().replace(/^\./,"");if(url.hostname!==domain&&!url.hostname.endsWith(`.${domain}`))continue;
        cookie.domain=domain;cookie.hostOnly=false;}else if(name==="path"&&value.startsWith("/"))cookie.path=value;
      else if(name==="max-age"&&Number.isFinite(Number(value)))cookie.expires=Math.floor(Date.now()/1000)+Number(value);
      else if(name==="expires"&&Number.isFinite(Date.parse(value)))cookie.expires=Math.floor(Date.parse(value)/1000);
      else if(name==="secure")cookie.secure=true;else if(name==="httponly")cookie.httpOnly=true;
      else if(name==="samesite"&&["strict","lax","none"].includes(value.toLowerCase()))cookie.sameSite=(value[0]!.toUpperCase()+value.slice(1).toLowerCase()) as ExecutionCookie["sameSite"];
    }
    if(cookie.name.trim()&&!/[\r\n;]/.test(cookie.name+cookie.value))result.push(cookie);
  }
  return result;
}
function sanitizeSessionResponse<T extends {headers:Array<{name:string;value:string}>;bodyBase64:string}>(response:T,material:SessionMaterial,cookies:ExecutionCookie[],captured:string[]):T{
  const secrets=[...Object.values(material.headers),...material.cookies.map(item=>item.value),...cookies.map(item=>item.value),...Object.values(material.values),...captured].filter(value=>value.length>0);
  const headers=response.headers.filter(item=>item.name.toLowerCase()!=="set-cookie").map(item=>({name:item.name,
    value:sensitiveHeaders.has(item.name.toLowerCase())?"[redacted]":redact(item.value,secrets)}));
  const contentType=headers.find(item=>item.name.toLowerCase()==="content-type")?.value??"";let bodyBase64=response.bodyBase64;
  if(/(?:text|json|xml|javascript|x-www-form-urlencoded)/i.test(contentType))bodyBase64=Buffer.from(redact(Buffer.from(bodyBase64,"base64").toString("utf8"),secrets)).toString("base64");
  return {...response,headers,bodyBase64};
}
function redact(value:string,secrets:string[]):string{let result=value;for(const secret of secrets)result=result.split(secret).join("[redacted]");
  return result.replace(/((?:password|passwd|token|secret|api[_-]?key)\s*[=:]\s*)[^\s&;,<]+/gi,"$1[redacted]");}
function redactedRequestHeaders(headers:Record<string,string>):Record<string,string>{return Object.fromEntries(Object.keys(headers).sort().map(name=>[name,sensitiveHeaders.has(name.toLowerCase())?"[redacted]":"[present]"]));}
function textBody(response:{headers:Array<{name:string;value:string}>;bodyBase64:string}):string{const type=response.headers.find(item=>item.name.toLowerCase()==="content-type")?.value??"";
  return /(?:text|json|xml|javascript|x-www-form-urlencoded)/i.test(type)?Buffer.from(response.bodyBase64,"base64").toString("utf8"):"";}
function sha(value:Buffer):string{return createHash("sha256").update(value).digest("hex");}
function buildSecretBody(value:unknown,material:SessionMaterial):{bodyBase64:string;contentType:string;redactedTemplate:string}{
  const input=record(value);exact(input,["format","fields"]);const format=text(input.format,"Secret body format");
  if(!["form","json"].includes(format))throw new Error("Secret body format is invalid");const fields=record(input.fields);
  if(Object.keys(fields).length>64)throw new Error("Secret body has too many fields");const output:Record<string,string>={},template:Record<string,string>={};
  for(const [name,raw] of Object.entries(fields)){if(!name||Buffer.byteLength(name)>256)throw new Error("Secret body field is invalid");const selector=record(raw);
    if(Object.keys(selector).length!==1||(!("literal" in selector)&&!("secret" in selector)))throw new Error("Secret body selector is invalid");
    if("secret" in selector){const secretName=text(selector.secret,"Secret body handle");if(!Object.hasOwn(material.values,secretName))throw new Error(`Session secret ${secretName} is unavailable`);
      output[name]=material.values[secretName]!;template[name]=`[secret:${secretName}]`;
    }else{const literal=typeof selector.literal==="string"?selector.literal:"";if(typeof selector.literal!=="string"||Buffer.byteLength(literal)>8192
      ||/(?:password|passwd|token|secret|api.?key)/i.test(name))throw new Error("Sensitive body fields must use a Session secret handle");output[name]=literal;template[name]=literal;}
  }
  const body=format==="json"?JSON.stringify(output):new URLSearchParams(output).toString();if(Buffer.byteLength(body)>1024*1024)throw new Error("Secret body exceeds its capacity");
  return {bodyBase64:Buffer.from(body).toString("base64"),contentType:format==="json"?"application/json":"application/x-www-form-urlencoded",
    redactedTemplate:JSON.stringify({format,fields:template})};
}
function captureSecrets(response:{headers:Array<{name:string;value:string}>;bodyBase64:string},value:unknown):Record<string,string>{
  if(value===undefined)return {};if(!Array.isArray(value)||value.length>16)throw new Error("Response secret captures are invalid");
  const type=response.headers.find(item=>item.name.toLowerCase()==="content-type")?.value??"";if(!/(?:text|json|xml|javascript|x-www-form-urlencoded)/i.test(type))
    throw new Error("Response secrets can only be captured from textual content");const body=Buffer.from(response.bodyBase64,"base64").toString("utf8"),result:Record<string,string>={};
  for(const raw of value){const capture=record(raw);exact(capture,["name","start","end","maximumBytes"]);const name=text(capture.name,"Capture name"),start=text(capture.start,"Capture start"),end=text(capture.end,"Capture end"),maximum=integer(capture.maximumBytes,"Capture limit");
    if(!/^[a-zA-Z][a-zA-Z0-9_.:-]{0,127}$/.test(name)||Buffer.byteLength(start)>256||Buffer.byteLength(end)>256||maximum<1||maximum>8192)throw new Error("Response secret capture is invalid");
    const offset=body.indexOf(start);if(offset<0)continue;const from=offset+start.length,to=body.indexOf(end,from);if(to<0)continue;const captured=body.slice(from,to);
    if(!captured||Buffer.byteLength(captured)>maximum)throw new Error("Captured response secret exceeds its capacity");result[name]=captured;
  }return result;
}
