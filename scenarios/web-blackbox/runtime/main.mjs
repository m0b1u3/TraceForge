import { createHash } from "node:crypto";

const VERSION = 1;
const PACKAGE_ID = "traceforge.web-blackbox";
const PACKAGE_VERSION = "0.3.0";
const SOURCE = "scenario:web_blackbox@1";
let buffered = Buffer.alloc(0);
let reverseSequence = 0;
const pendingCapabilities = new Map();

const tools = Object.freeze([
  {
    name: "scope.authorization.snapshot", source: SOURCE, version: PACKAGE_VERSION, priority: 100,
    description: "Read the immutable authorization scope assigned to this investigation.",
    inputSchema: { type: "object", additionalProperties: false },
    providedCapabilities: ["scope.read"], dependencyCapabilities: [], permissionRequirements: {},
    risk: "read_only", timeoutMs: 5_000,
  },
  {
    name: "web.http.request", source: SOURCE, version: PACKAGE_VERSION, priority: 90,
    description: "Send one bounded HTTP request through the host network broker after exact scope authorization.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["url"], properties: {
        url: { type: "string" }, method: { type: "string" }, headers: { type: "object", additionalProperties: { type: "string" } },
        bodyBase64: { type: "string" }, timeoutMs: { type: "integer", minimum: 1, maximum: 120000 },
        responseLimitBytes: { type: "integer", minimum: 1, maximum: 4194304 },
      },
    },
    providedCapabilities: ["web.request.replay"], dependencyCapabilities: [],
    permissionRequirements: { network: "brokered" }, risk: "bounded_write", timeoutMs: 125_000,
  },
  {
    name:"web.session.catalog",source:SOURCE,version:PACKAGE_VERSION,priority:92,
    description:"List Host-managed identity and Session descriptors without exposing secret material.",
    inputSchema:{type:"object",additionalProperties:false},providedCapabilities:["web.session.use"],dependencyCapabilities:[],
    permissionRequirements:{secrets:"handles_only"},risk:"read_only",timeoutMs:5_000,
  },
  {
    name:"web.session.open",source:SOURCE,version:PACKAGE_VERSION,priority:91,
    description:"Open a Run- and Scope-bound HTTP Session for an operator-provisioned identity handle.",
    inputSchema:{type:"object",additionalProperties:false,properties:{identityId:{type:"string"},ttlMs:{type:"integer",minimum:60000,maximum:86400000}}},
    providedCapabilities:["web.session.use"],dependencyCapabilities:[],permissionRequirements:{secrets:"handles_only"},risk:"bounded_write",timeoutMs:5_000,
  },
  {
    name:"web.session.request",source:SOURCE,version:PACKAGE_VERSION,priority:96,
    description:"Send authenticated HTTP through a Host Session; secret headers and cookies never enter tool input or output.",
    inputSchema:{type:"object",additionalProperties:false,required:["sessionId","url"],properties:{sessionId:{type:"string"},url:{type:"string"},
      method:{type:"string"},headers:{type:"object",additionalProperties:{type:"string"}},bodyBase64:{type:"string"},timeoutMs:{type:"integer",minimum:1,maximum:120000},
      secretBody:{type:"object",additionalProperties:false,required:["format","fields"],properties:{format:{enum:["form","json"]},fields:{type:"object"}}},
      captures:{type:"array",maxItems:16,items:{type:"object",additionalProperties:false,required:["name","start","end","maximumBytes"],properties:{name:{type:"string"},start:{type:"string"},end:{type:"string"},maximumBytes:{type:"integer",minimum:1,maximum:8192}}}},
      responseLimitBytes:{type:"integer",minimum:1,maximum:1048576}}},providedCapabilities:["web.session.use","web.request.replay"],dependencyCapabilities:[],
    permissionRequirements:{network:"brokered",secrets:"handles_only"},risk:"bounded_write",timeoutMs:125_000,
  },
  {
    name:"web.traffic.snapshot",source:SOURCE,version:PACKAGE_VERSION,priority:88,
    description:"Read bounded redacted traffic descriptors attributed to this Run.",
    inputSchema:{type:"object",additionalProperties:false,properties:{limit:{type:"integer",minimum:1,maximum:200}}},
    providedCapabilities:["web.traffic.read"],dependencyCapabilities:[],permissionRequirements:{},risk:"read_only",timeoutMs:5_000,
  },
  {
    name: "web.surface.explore", source: SOURCE, version: PACKAGE_VERSION, priority: 95,
    description: "Explore a bounded same-origin HTTP surface, checkpoint progress, and record attributable artifacts and evidence.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["seeds"], properties: {
        seeds: { type: "array", minItems: 0, maxItems: 16, items: { type: "string" } },
        headers: { type: "object", additionalProperties: { type: "string" } },
        maxRequests: { type: "integer", minimum: 1, maximum: 8 },
        maxLinksPerPage: { type: "integer", minimum: 1, maximum: 64 },
        responseLimitBytes: { type: "integer", minimum: 1024, maximum: 1048576 }, sessionId: { type: "string" },
      },
    },
    providedCapabilities: ["web.surface.explore"], dependencyCapabilities: [],
    permissionRequirements: { network: "brokered" }, risk: "bounded_write", timeoutMs: 125_000,
  },
]);

function send(value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32BE(payload.length, 0); payload.copy(frame, 4); process.stdout.write(frame);
}

function fail(id, error) {
  send({ version: VERSION, id, ok: false, error: { code: "scenario_error", message: error instanceof Error ? error.message : "Scenario operation failed", retryable: false } });
}

function capability(parentRequestId, context, capabilityName, action, input, suffix) {
  const id = `host:${parentRequestId}:${++reverseSequence}`;
  return new Promise((resolve, reject) => {
    pendingCapabilities.set(id, { resolve, reject });
    send({ version: VERSION, id, method: "host.capability.call", params: {
      parentRequestId, capability: capabilityName, action,
      idempotencyKey: `${suffix}:${context.idempotencyKey}`, input,
    } });
  });
}

async function callTool(request) {
  const params = plainObject(request.params, "Tool call");
  const context = plainObject(params.context, "Tool context");
  if (typeof context.idempotencyKey !== "string" || !context.idempotencyKey) throw new Error("Tool context idempotency key is required");
  if (params.tool === "scope.authorization.snapshot") {
    exact(plainObject(params.input, "Scope input"), []);
    const receipt = await capability(request.id, context, "traceforge.scenario.authorization@1", "require",
      { action: "scope.read" }, "scope");
    return succeeded("Authorization scope loaded", receipt.output, [`authorization:${receipt.output.id}`, ...receipt.refs]);
  }
  if (params.tool === "web.http.request") {
    const input = plainObject(params.input, "HTTP input");
    exact(input, ["url", "method", "headers", "bodyBase64", "timeoutMs", "responseLimitBytes"]);
    if (typeof input.url !== "string" || !input.url.trim()) throw new Error("HTTP URL is required");
    const method = input.method === undefined ? "GET" : requiredText(input.method, "HTTP method").toUpperCase();
    const headers = input.headers === undefined ? {} : stringRecord(input.headers, "HTTP headers");
    const bodyBase64 = input.bodyBase64 === undefined ? "" : requiredBase64(input.bodyBase64);
    const timeoutMs = boundedInteger(input.timeoutMs ?? 15_000, 1, 120_000, "HTTP timeout");
    const responseLimitBytes = boundedInteger(input.responseLimitBytes ?? 1024 * 1024, 1, 4 * 1024 * 1024, "HTTP response limit");
    const authorization = await capability(request.id, context, "traceforge.scenario.authorization@1", "authorize_resource",
      { action: "web.request.replay", resourceKind: "network.url", value: input.url.trim() }, "http-authorization");
    const execution = await capability(request.id, context, "traceforge.scenario.execution@1", "request_http", {
      authorizationAction: "web.request.replay", url: authorization.output.canonicalValue, method, headers, bodyBase64,
      timeoutMs, responseLimitBytes,
    }, "http-execution");
    return succeeded(`HTTP ${method} completed with status ${execution.output.status}`, execution.output,
      [...authorization.refs, ...execution.refs]);
  }
  if(params.tool==="web.session.catalog"){
    exact(plainObject(params.input,"Session catalog input"),[]);
    const identities=await capability(request.id,context,"traceforge.scenario.sessions@1","list_identities",
      {operation:"list_identities",authorizationAction:"web.session.use",resourceKind:"identity.handle"},"session-identities");
    const sessions=await capability(request.id,context,"traceforge.scenario.sessions@1","list",
      {operation:"list",authorizationAction:"web.session.use"},"session-list");
    return succeeded(`Loaded ${identities.output.length} identity handle(s) and ${sessions.output.length} Session(s)`,
      {identities:identities.output,sessions:sessions.output},[...identities.refs,...sessions.refs]);
  }
  if(params.tool==="web.session.open"){
    const input=plainObject(params.input,"Session open input");exact(input,["identityId","ttlMs"]);
    const identityId=input.identityId===undefined?null:requiredText(input.identityId,"Identity id");
    const ttlMs=boundedInteger(input.ttlMs??60*60*1000,60_000,86_400_000,"Session lifetime");
    const receipt=await capability(request.id,context,"traceforge.scenario.sessions@1","open",
      {operation:"open",authorizationAction:"web.session.use",resourceKind:"identity.handle",identityId,ttlMs},"session-open");
    return succeeded(`Opened controlled Session ${receipt.output.id}`,receipt.output,receipt.refs);
  }
  if(params.tool==="web.session.request"){
    const input=plainObject(params.input,"Session HTTP input");exact(input,["sessionId","url","method","headers","bodyBase64","secretBody","captures","timeoutMs","responseLimitBytes"]);
    if(input.bodyBase64!==undefined&&input.secretBody!==undefined)throw new Error("Session HTTP body forms are mutually exclusive");
    const sessionId=requiredText(input.sessionId,"Session id"),url=canonicalHttpUrl(input.url,"Session HTTP URL");
    const method=requiredText(input.method??"GET","HTTP method").toUpperCase(),headers=input.headers===undefined?{}:stringRecord(input.headers,"HTTP headers");
    const bodyBase64=input.bodyBase64===undefined?"":requiredBase64(input.bodyBase64);
    const authorization=await capability(request.id,context,"traceforge.scenario.authorization@1","authorize_resource",
      {action:"web.request.replay",resourceKind:"network.url",value:url},`session-authorization:${sha(url)}`);
    const execution=await capability(request.id,context,"traceforge.scenario.execution@1","request_http_session",{
      authorizationAction:"web.request.replay",sessionAuthorizationAction:"web.session.use",sessionId,url:authorization.output.canonicalValue,
      method,headers,...(input.secretBody===undefined?{bodyBase64}:{secretBody:input.secretBody}),...(input.captures===undefined?{}:{captures:input.captures}),
      timeoutMs:boundedInteger(input.timeoutMs??15_000,1,120_000,"HTTP timeout"),
      responseLimitBytes:boundedInteger(input.responseLimitBytes??256*1024,1,1024*1024,"HTTP response limit"),
    },`session-http:${sha(url)}`);
    return succeeded(`Authenticated HTTP ${method} completed with status ${execution.output.status}`,execution.output,[...authorization.refs,...execution.refs]);
  }
  if(params.tool==="web.traffic.snapshot"){
    const input=plainObject(params.input,"Traffic input");exact(input,["limit"]);const limit=boundedInteger(input.limit??50,1,200,"Traffic limit");
    const receipt=await capability(request.id,context,"traceforge.scenario.traffic@1","list",
      {operation:"list",authorizationAction:"web.traffic.read",limit},"traffic-list");
    return succeeded(`Loaded ${receipt.output.length} redacted Traffic descriptor(s)`,receipt.output,receipt.refs);
  }
  if(params.tool==="web.surface.explore")return exploreSurface(request.id,context,plainObject(params.input,"Surface exploration input"));
  throw new Error(`Unknown Web black-box tool ${String(params.tool)}`);
}

async function exploreSurface(parentRequestId,context,input){
  exact(input,["seeds","headers","maxRequests","maxLinksPerPage","responseLimitBytes","sessionId"]);
  if(!Array.isArray(input.seeds)||input.seeds.length>16)throw new Error("Surface seeds are invalid");
  const seeds=input.seeds.map(item=>canonicalHttpUrl(item,"Surface seed"));
  const headers=input.headers===undefined?{}:stringRecord(input.headers,"Surface headers");
  const maximum=boundedInteger(input.maxRequests??4,1,8,"Surface request limit");
  const maximumLinks=boundedInteger(input.maxLinksPerPage??24,1,64,"Surface link limit");
  const responseLimitBytes=boundedInteger(input.responseLimitBytes??256*1024,1024,1024*1024,"Surface response limit");
  const sessionId=input.sessionId===undefined?null:requiredText(input.sessionId,"Session id");
  const stateKey=sessionId?`web.surface.v1:${sha(sessionId).slice(0,16)}`:"web.surface.v1";
  const loaded=await capability(parentRequestId,context,"traceforge.scenario.state@1","read",{operation:"read",key:stateKey},"surface-state-read");
  let state=restoreSurfaceState(loaded.output),revision=loaded.output?.revision??0;
  const origins=new Set([...state.seeds,...seeds].map(value=>new URL(value).origin));
  state.seeds=unique([...state.seeds,...seeds]).slice(0,16);
  state.queue=unique([...state.queue,...seeds]).filter(value=>!state.visited.includes(value)).slice(0,32);
  if(!state.queue.length&&!state.visited.length)throw new Error("At least one Surface seed is required for a new exploration");
  const invocationObservations=[],refs=[];let step=0;
  while(step<maximum&&state.queue.length){
    const url=state.queue.shift();if(state.visited.includes(url))continue;
    const key=sha(url);let authorization;
    try{authorization=await capability(parentRequestId,context,"traceforge.scenario.authorization@1","authorize_resource",
      {action:"web.request.replay",resourceKind:"network.url",value:url},`surface-authorization:${key}`);}
    catch(error){state.visited.push(url);state.skipped.push({url,reason:"not_authorized"});state.skipped=state.skipped.slice(-16);
      ({state,revision}=await saveSurface(parentRequestId,context,state,revision,step,stateKey));step++;continue;}
    const execution=await capability(parentRequestId,context,"traceforge.scenario.execution@1",sessionId?"request_http_session":"request_http",{
      authorizationAction:"web.request.replay",...(sessionId?{sessionAuthorizationAction:"web.session.use",sessionId}:{}),
      url:authorization.output.canonicalValue,method:"GET",headers,bodyBase64:"",timeoutMs:10000,responseLimitBytes,
    },`surface-http:${key}`);
    const response=plainObject(execution.output,"Surface HTTP response"),body=decodeBody(response.bodyBase64),contentType=header(response.headers,"content-type");
    const links=isHtml(contentType)?discoverLinks(body,url,origins,maximumLinks):{sameOrigin:[],external:[]};
    const discovered=links.sameOrigin.filter(value=>!state.visited.includes(value)&&!state.queue.includes(value));
    state.queue.push(...discovered.slice(0,Math.max(0,32-state.queue.length)));
    const bodyDigest=`sha256:${shaBytes(Buffer.from(response.bodyBase64,"base64"))}`,receiptId=requiredText(response.receipt?.id,"Network receipt id");
    const observation={url,status:boundedInteger(response.status,100,599,"HTTP status"),contentType:contentType.slice(0,256),
      responseBytes:boundedInteger(response.responseBytes,0,1024*1024,"HTTP response bytes"),bodyTruncated:Boolean(response.bodyTruncated),bodyDigest,
      snippet:textSnippet(body,1024),discoveredUrls:links.sameOrigin.slice(0,8).map(value=>value.slice(0,512)),
      externalOrigins:unique(links.external.map(value=>new URL(value).origin)).slice(0,8).map(value=>value.slice(0,256)),
      networkReceipt:`network-receipt:${receiptId}`};
    const artifactReceipt=await capability(parentRequestId,context,"traceforge.scenario.artifacts@1","record",{operation:"record",commandId:"observation",
      kind:"web.http.observation",summary:`GET ${url} returned ${observation.status}`,contentRef:observation.networkReceipt,digest:bodyDigest,
      byteSize:observation.responseBytes,metadata:observation},`surface-artifact:${key}`);
    const artifact=artifactReceipt.output;
    const evidenceReceipt=await capability(parentRequestId,context,"traceforge.scenario.evidence@1","record_node",{commandId:"observation",node:{
      id:`web-observation:${sha(`${url}\0${receiptId}`)}`,kind:"evidence",title:`Observed ${url}`,summary:`GET returned ${observation.status} (${contentType||"unknown content type"})`,
      status:"active",confidence:1,properties:{url,status:observation.status,contentType,responseBytes:observation.responseBytes,
        bodyTruncated:observation.bodyTruncated,bodyDigest,artifactId:artifact.id,networkReceipt:observation.networkReceipt,
        discoveredUrls:observation.discoveredUrls,externalOrigins:observation.externalOrigins},
    }},`surface-evidence:${key}`);
    const saved={...observation,artifactId:artifact.id,evidenceRefs:evidenceReceipt.refs};
    state.visited.push(url);state.observations.push(saved);state.visited=unique(state.visited).slice(-64);state.observations=state.observations.slice(-16);
    invocationObservations.push(saved);refs.push(artifact.contentRef,...artifactReceipt.refs,...evidenceReceipt.refs,...execution.refs);
    ({state,revision}=await saveSurface(parentRequestId,context,state,revision,step,stateKey));step++;
  }
  const result={schemaVersion:1,observations:invocationObservations,coverage:{seedCount:state.seeds.length,visitedCount:state.visited.length,
    queuedCount:state.queue.length,skippedCount:state.skipped.length,observationCount:state.observations.length,requestBudget:maximum,
    budgetExhausted:step>=maximum&&state.queue.length>0},queued:state.queue.slice(0,32),skipped:state.skipped.slice(-16),
    resume:{stateKey,revision}};
  return succeeded(`Explored ${invocationObservations.length} authorized URL(s); ${state.queue.length} remain queued`,result,refs);
}

async function saveSurface(parentRequestId,context,state,revision,step,stateKey){
  const receipt=await capability(parentRequestId,context,"traceforge.scenario.state@1","compare_and_set",{operation:"compare_and_set",
    commandId:`checkpoint:${stateKey}:${step}`,key:stateKey,expectedRevision:revision,value:state},`surface-state:${stateKey}:${step}`);
  return {state:restoreSurfaceState(receipt.output),revision:receipt.output.revision};
}

function restoreSurfaceState(record){
  if(record===null||record===undefined)return {schemaVersion:1,seeds:[],queue:[],visited:[],observations:[],skipped:[]};
  const value=plainObject(record.value,"Surface state");
  if(value.schemaVersion!==1||![value.seeds,value.queue,value.visited,value.observations,value.skipped].every(Array.isArray))throw new Error("Surface state is incompatible");
  return {schemaVersion:1,seeds:value.seeds.map(item=>canonicalHttpUrl(item,"Saved seed")).slice(0,16),
    queue:value.queue.map(item=>canonicalHttpUrl(item,"Saved queued URL")).slice(0,32),visited:value.visited.map(item=>canonicalHttpUrl(item,"Saved visited URL")).slice(0,64),
    observations:value.observations.slice(-16),skipped:value.skipped.slice(-16)};
}

function discoverLinks(body,base,origins,maximum){
  const sameOrigin=[],external=[];const expression=/(?:href|src|action)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;let match;
  while((match=expression.exec(body))&&sameOrigin.length+external.length<maximum*4){const raw=match[1]??match[2]??match[3];let value;
    try{value=canonicalHttpUrl(new URL(raw,base).href,"Discovered URL");}catch{continue;}
    (origins.has(new URL(value).origin)?sameOrigin:external).push(value);
  }
  return {sameOrigin:unique(sameOrigin).slice(0,maximum),external:unique(external).slice(0,maximum)};
}
function canonicalHttpUrl(value,label){const text=requiredText(value,label);let url;try{url=new URL(text);}catch{throw new Error(`${label} must be an absolute HTTP URL`);}
  if(!["http:","https:"].includes(url.protocol)||url.username||url.password)throw new Error(`${label} must be an HTTP URL without credentials`);url.hash="";return url.href;}
function decodeBody(value){const encoded=typeof value==="string"?value:"";if(Buffer.from(encoded,"base64").toString("base64")!==encoded)throw new Error("Surface response body is invalid");return Buffer.from(encoded,"base64").toString("utf8");}
function header(headers,name){if(!Array.isArray(headers))return "";const found=headers.find(item=>item&&typeof item.name==="string"&&item.name.toLowerCase()===name);return typeof found?.value==="string"?found.value:"";}
function isHtml(contentType){return /(?:text\/html|application\/xhtml\+xml)/i.test(contentType);}
function textSnippet(value,maximum){return value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi," ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi," ")
  .replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim().slice(0,maximum);}
function unique(values){return [...new Set(values)];}
function sha(value){return shaBytes(Buffer.from(value,"utf8"));}
function shaBytes(value){return createHash("sha256").update(value).digest("hex");}

function handle(message) {
  if (!message || message.version !== VERSION || typeof message.id !== "string") return process.exit(2);
  if (typeof message.ok === "boolean") {
    const pending = pendingCapabilities.get(message.id); if (!pending) return;
    pendingCapabilities.delete(message.id);
    if (message.ok) pending.resolve(message.result); else pending.reject(new Error(message.error?.message ?? "Host capability failed"));
    return;
  }
  if (message.method === "provider.handshake") return send({ version: VERSION, id: message.id, ok: true, result: {
    providerId: PACKAGE_ID, providerVersion: PACKAGE_VERSION, protocolVersion: VERSION, profile: "traceforge-scenario-process-rpc",
  } });
  if (message.method === "tools.list") return send({ version: VERSION, id: message.id, ok: true, result: tools });
  if (message.method === "tools.call") return void callTool(message).then(
    result => send({ version: VERSION, id: message.id, ok: true, result }),
    error => fail(message.id, error),
  );
  return fail(message.id, new Error("Unknown method"));
}

function succeeded(summary, output, refs) {
  return { status: "succeeded", summary, raw: JSON.stringify(output), refs: [...new Set(refs)], retryable: false };
}
function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${label} must be an object`);
  return value;
}
function exact(value, allowed) {
  const keys = new Set(allowed); if (Object.keys(value).some(key => !keys.has(key))) throw new Error("Unknown input field");
}
function requiredText(value, label) { if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > 1024) throw new Error(`${label} is invalid`); return value.trim(); }
function boundedInteger(value, minimum, maximum, label) { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${label} is invalid`); return value; }
function stringRecord(value, label) {
  const record = plainObject(value, label); if (Object.keys(record).length > 128 || Object.entries(record).some(([key, item]) => !key || typeof item !== "string")) throw new Error(`${label} are invalid`); return record;
}
function requiredBase64(value) {
  if (typeof value !== "string" || Buffer.byteLength(value) > 2 * 1024 * 1024 || Buffer.from(value, "base64").toString("base64") !== value) throw new Error("HTTP body is invalid"); return value;
}

process.stdin.on("data", chunk => {
  buffered = buffered.length ? Buffer.concat([buffered, chunk]) : Buffer.from(chunk);
  while (buffered.length >= 4) {
    const length = buffered.readUInt32BE(0); if (length > 4 * 1024 * 1024) return process.exit(2); if (buffered.length < length + 4) break;
    let message; try { message = JSON.parse(buffered.subarray(4, length + 4).toString("utf8")); } catch { return process.exit(2); }
    buffered = buffered.subarray(length + 4); handle(message);
  }
});
process.stdin.on("end", () => process.exit(0));
