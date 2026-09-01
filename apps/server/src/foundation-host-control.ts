import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import type Database from "better-sqlite3";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WorkerDescriptor } from "@traceforge/orchestration-core";
import { canonicalJson } from "@traceforge/orchestration-core";

export interface FoundationHostChannel {
  /** Trusted host transport only. Do not serialize credentials into prompts, tools or checkpoints. */
  headers(): { authorization: string };
  fetch: typeof fetch;
  revoke(): void;
}
interface WorkerBinding { worker: WorkerDescriptor; definitionKind: string; definitionVersion: number }
interface Grant { kind: "management" | "worker"; binding?: WorkerBinding; expiresAt: number; revoked: boolean; digest: string }
const controls = new WeakMap<FastifyInstance, FoundationHostControl>();
const digest = (value:string) => createHash("sha256").update(value).digest("hex");
const workerActions = new Set(["renew","checkpoint","complete","request-approval","fail","block"]);

/** An in-memory host capability, NOT user authentication and NOT an in-process JavaScript sandbox. */
export class FoundationHostControl {
  #grants = new Map<string,Grant>();
  #workers = new Map<string,()=>void>();
  #requests = new WeakMap<FastifyRequest,Grant>();
  #closed = false;
  #ttlMs: number;

  constructor(private readonly app: FastifyInstance, private readonly sqlite: Database.Database,
    options: { credentialTtlMs?: number; now?: () => number } = {}) {
    this.#ttlMs=options.credentialTtlMs ?? 60*60*1000;
    if(!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs<1 || this.#ttlMs>24*60*60*1000)throw new Error("Invalid host channel credential lifetime");
    this.now=options.now ?? Date.now;
    app.addHook("onRequest",async(request,reply)=>{
      if(!this.protectedRoute(request))return;
      const remote=request.raw.socket.remoteAddress ?? "";
      const ipv4=remote.startsWith("::ffff:") ? remote.slice(7) : remote;
      if(remote!=="::1" && !(isIP(ipv4)===4 && ipv4.startsWith("127."))) {
        return reply.code(403).send({error:"Host control channels require local transport"});
      }
      const grant=this.lookup(request);
      if(!grant)return reply.code(401).send({error:"Host control channel required"});
      if(grant.kind==="worker" && !this.workerRoute(request))return reply.code(403).send({error:"Worker channel cannot access management operations"});
      this.#requests.set(request,grant);
    });
    app.addHook("preHandler",async(request,reply)=>{
      if(!this.protectedRoute(request))return;
      const grant=this.#requests.get(request);
      // Recheck after body parsing/async hooks: revocation/expiry cannot race dispatch.
      if(!grant || !this.active(grant))return reply.code(401).send({error:"Host control channel expired or revoked"});
      if(grant.kind==="worker" && !this.allowedWorker(request,grant.binding!)) {
        return reply.code(403).send({error:"Worker channel does not own this operation"});
      }
    });
    const control=this;
    app.addHook("onRoute",options=>{
      const original=options.handler;
      options.handler=function(request,reply){
        if(control.protectedRoute(request)){
          const grant=control.#requests.get(request);
          if(!grant || !control.active(grant))return reply.code(401).send({error:"Host control channel expired or revoked"});
          if(grant.kind==="worker" && !control.allowedWorker(request,grant.binding!))return reply.code(403).send({error:"Worker channel does not own this operation"});
        }
        return original.call(this,request,reply);
      };
    });
    app.addHook("preClose",async()=>this.close());
  }
  private readonly now:()=>number;

  management():FoundationHostChannel { return this.issue("management"); }

  worker(worker:WorkerDescriptor,definitionKind:string,definitionVersion:number):FoundationHostChannel {
    if(!worker.id?.trim() || worker.id.length>256 || !definitionKind.trim() || !Number.isSafeInteger(definitionVersion) || definitionVersion<1
      || !worker.roles.length || !worker.roles.every(s=>typeof s==="string" && !!s.trim())
      || !worker.capabilities.every(s=>typeof s==="string" && !!s.trim())
      || !Number.isSafeInteger(worker.maxConcurrentWork) || worker.maxConcurrentWork<1 || worker.maxConcurrentWork>100)throw new Error("Invalid host Worker binding");
    this.#workers.get(worker.id)?.();
    if(this.#workers.size>=1024)throw new Error("Host Worker channel capacity exceeded");
    const channel=this.issue("worker",structuredClone({worker,definitionKind,definitionVersion}));
    this.#workers.set(worker.id,channel.revoke);
    return channel;
  }

  snapshot() {
    this.prune();
    return {mode:"host_capabilities",singleUser:true,persistentCredentials:false,arbitraryJavaScriptIsolation:false,
      managementChannels:[...this.#grants.values()].filter(g=>g.kind==="management").length,
      workerChannels:[...this.#grants.values()].filter(g=>g.kind==="worker").length,credentialTtlMs:this.#ttlMs,closed:this.#closed};
  }

  close():void {
    this.#closed=true;
    for(const grant of this.#grants.values())grant.revoked=true;
    this.#grants.clear();this.#workers.clear();
  }

  private issue(kind:Grant["kind"],binding?:WorkerBinding):FoundationHostChannel {
    this.prune();
    if(this.#closed)throw new Error("Host channels closed");
    if(this.#grants.size>=1024 || (kind==="management" && [...this.#grants.values()].filter(g=>g.kind===kind).length>=8))throw new Error("Host channel capacity exceeded");
    let revoked=false, token="", current:Grant;
    const rotate=()=>{
      if(revoked || this.#closed)throw new Error("Host channel revoked");
      if(current){current.revoked=true;this.#grants.delete(current.digest);}
      this.prune();
      if(this.#grants.size>=1024 || (kind==="management" && [...this.#grants.values()].filter(g=>g.kind===kind).length>=8))throw new Error("Host channel capacity exceeded");
      token=`tfh_${randomBytes(32).toString("base64url")}`;
      current={kind,binding,expiresAt:this.now()+this.#ttlMs,revoked:false,digest:digest(token)};
      this.#grants.set(current.digest,current);
    };
    rotate();
    const headers=()=>{
      if(revoked || this.#closed)throw new Error("Host channel revoked");
      // Only the trusted host-held channel can rotate; a copied wire token cannot renew itself.
      if(current.expiresAt<=this.now())rotate();
      return {authorization:`Bearer ${token}`};
    };
    const channel:FoundationHostChannel={headers,fetch:async(input,init)=>{
      const address=this.app.server.address();
      if(!address || typeof address==="string")throw new Error("Host channel requires its listening TCP host");
      const expected=new URL(`http://127.0.0.1:${address.port}`);
      const url=new URL(input instanceof Request ? input.url : String(input));
      if(url.origin!==expected.origin || url.username || url.password)throw new Error("Host channel cannot forward credentials to another origin");
      const outgoing=new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      outgoing.set("authorization",headers().authorization);
      return fetch(input,{...init,headers:outgoing,redirect:"error"});
    },revoke:()=>{
      revoked=true;current.revoked=true;this.#grants.delete(current.digest);token="";
      if(binding && this.#workers.get(binding.worker.id)===channel.revoke)this.#workers.delete(binding.worker.id);
    }};
    return Object.freeze(channel);
  }

  private active(grant:Grant):boolean { return !this.#closed && !grant.revoked && grant.expiresAt>this.now() && this.#grants.get(grant.digest)===grant; }
  private prune(){for(const [key,grant] of this.#grants)if(!this.active(grant))this.#grants.delete(key);}
  private lookup(request:FastifyRequest):Grant|undefined {
    const authorization=request.headers.authorization;
    // No cookie/query/actor/Origin/loopback fallback; duplicate or combined credentials are not valid tokens.
    if(typeof authorization!=="string" || !/^Bearer tfh_[A-Za-z0-9_-]{43}$/.test(authorization))return;
    if(request.raw.rawHeaders.filter((_,i)=>i%2===0 && request.raw.rawHeaders[i]!.toLowerCase()==="authorization").length!==1)return;
    const grant=this.#grants.get(digest(authorization.slice(7)));
    return grant && this.active(grant) ? grant : undefined;
  }

  private protectedRoute(request:FastifyRequest):boolean {
    const route=request.routeOptions.url;
    if(!route)return false; // Unknown routes have no handler/side effects and remain 404.
    if(route==="/api/health" && request.method==="GET")return false;
    return route.startsWith("/api/") || route==="/ws";
  }

  private workerRoute(request:FastifyRequest):boolean {
    const route=request.routeOptions.url;
    return (request.method==="POST" && (route==="/api/scenarios/workers" || route==="/api/scenarios/workers/:workerId/heartbeat"
      || [...workerActions].some(action=>route===`/api/scenarios/runs/:runId/work/:workId/${action}`)))
      || (request.method==="GET" && route==="/api/scenarios/workers/:workerId/assignments");
  }

  private allowedWorker(request:FastifyRequest,binding:WorkerBinding):boolean {
    const route=request.routeOptions.url, params=request.params as Record<string,string>,body=request.body as Record<string,unknown>|undefined;
    if(!route || !this.workerRoute(request))return false;
    if(route==="/api/scenarios/workers"){
      if(!body)return false;
      const expected={id:binding.worker.id,roles:binding.worker.roles,capabilities:binding.worker.capabilities,maxConcurrentWork:binding.worker.maxConcurrentWork,status:binding.worker.status};
      return canonicalJson(body)===canonicalJson(expected);
    }
    if(route.startsWith("/api/scenarios/workers/")){
      if(params.workerId!==binding.worker.id)return false;
      if(route.endsWith("/heartbeat"))return !body || Object.keys(body).length===0;
      // A reused worker id must not reveal assignments from a different definition binding.
      return !this.sqlite.prepare(`SELECT 1 FROM scenario_work_leases l JOIN scenario_event_streams r ON r.run_id=l.run_id
        WHERE l.worker_id=? AND (r.definition_kind!=? OR r.definition_version!=?) LIMIT 1`)
        .get(binding.worker.id,binding.definitionKind,binding.definitionVersion);
    }
    if(!body || body.workerId!==binding.worker.id || typeof body.leaseId!=="string")return false;
    return !!this.sqlite.prepare(`SELECT 1 FROM scenario_work_leases l JOIN scenario_event_streams r ON r.run_id=l.run_id
      WHERE l.run_id=? AND l.work_id=? AND l.worker_id=? AND l.lease_id=? AND l.lease_expires_at>?
        AND r.status='running' AND r.definition_kind=? AND r.definition_version=?`)
      .get(params.runId,params.workId,binding.worker.id,body.leaseId,new Date(this.now()).toISOString(),binding.definitionKind,binding.definitionVersion);
  }
}

/** Composition API for the trusted embedding host. No HTTP credential issuance endpoint exists. */
export function registerFoundationHostControl(app:FastifyInstance,sqlite:Database.Database):FoundationHostControl {
  if(controls.has(app))throw new Error("Foundation host control already installed");
  const control=new FoundationHostControl(app,sqlite);controls.set(app,control);return control;
}
export function foundationHostControl(app:FastifyInstance):FoundationHostControl {
  const control=controls.get(app);if(!control)throw new Error("Foundation host control is not installed");return control;
}
