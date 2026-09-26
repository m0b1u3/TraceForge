import Database from "better-sqlite3";
import { createServer, request as send } from "node:http";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { connect } from "node:net";
import { createServer as createHttpsServer } from "node:https";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import type { StartProcessRequest, MacosExecutionBinding } from "@traceforge/execution-node";
import { WorkspaceNetworkHost } from "./workspace-network-host.js";
import { LocalExecutionNode, MacosProcessLauncher } from "@traceforge/execution-node";
import { RunWorkspace, type ToolExecutionContext } from "@traceforge/worker-runtime";
import { ExecutionNodeProcessTool } from "./worker-execution-adapters.js";
import { ConversationWorkspaces } from "./conversation-workspaces.js";

describe("workspace host network assembly", () => {
  const disposals: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose(); });
  async function fixture(allowTunnel = false, tls = false, allowWebSocket = false, shared = false) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "traceforge-workspace-network-")));
    disposals.push(() => rmSync(root, { recursive: true, force: true }));
    const db = new Database(":memory:"); disposals.push(() => db.close());
    db.exec(`CREATE TABLE scenario_work_leases(run_id,work_id,lease_id,worker_id,lease_expires_at);
      CREATE TABLE scenario_event_streams(run_id,case_id,status);
      CREATE TABLE tool_invocation_bindings(run_id,work_id,idempotency_key,tool_name,tool_source);
      CREATE TABLE tool_invocation_executions(idempotency_key,status,lease_id);
      CREATE TABLE scenario_events(run_id,event_type,payload_json);
      INSERT INTO scenario_work_leases VALUES ('run','work','lease','worker','2099-01-01T00:00:00.000Z');
      INSERT INTO tool_invocation_bindings VALUES ('run','work','key','workspace_execute','traceforge.builtin');
      INSERT INTO tool_invocation_executions VALUES ('key','executing','lease');
      INSERT INTO scenario_events VALUES ('run','run_started','{"state":{"scopeRef":"scope"}}');`);
    let sharedRoot: string | undefined;
    if (shared) {
      db.exec("CREATE TABLE desktop_conversations(id,case_id); INSERT INTO desktop_conversations VALUES('conversation','case');");
      const workspaces=new ConversationWorkspaces(db,root);
      sharedRoot=workspaces.ensure("conversation","case");
      workspaces.bind("conversation","case","run");
    }
    db.exec("INSERT INTO scenario_event_streams VALUES ('run','case','running');");
    let calls = 0;
    if (tls) execFileSync("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(root, "key.pem"), "-out", join(root, "cert.pem"),
      "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore", timeout: 10000 });
    const certificate = tls ? readFileSync(join(root, "cert.pem"), "utf8") : null;
    const handle: Parameters<typeof createServer>[0] = (_request, response) => { calls++; response.end("scoped response"); };
    const upstream = tls ? createHttpsServer({ key: readFileSync(join(root, "key.pem")), cert: certificate! }, handle) : createServer(handle);
    const upgradedSockets = new Set<import('node:stream').Duplex>();
    upstream.on('upgrade',(_request,socket,head)=>{calls++;upgradedSockets.add(socket);socket.once('close',()=>upgradedSockets.delete(socket));socket.on('error',()=>{});
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: fixture\r\n\r\n');
      if(head.length)socket.write(head);socket.on('data',bytes=>socket.write(bytes));});
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
    disposals.push(() => new Promise<void>(resolve => { for(const socket of upgradedSockets)socket.destroy();upstream.closeAllConnections(); upstream.close(() => resolve()); }));
    const url = `${tls ? "https" : "http"}://127.0.0.1:${(upstream.address() as { port: number }).port}/allowed`;
    const authorization = {
      requireAction(scope: string, _case: string, action: string) {
        if (scope !== "scope" || !["workspace.execute", "workspace.network"].includes(action)) throw new Error("denied");
        return { id: "grant", caseId: "case", scenarioKind: "neutral", scopePayload: { workspaceWebSocket: allowWebSocket }, expiresAt: "2099-01-01T00:00:00.000Z" };
      },
      authorizeResource(scope: string, caseId: string, action: string, kind: string, target: string) {
        if (kind !== "workspace.network" || (target !== url && !(allowTunnel && target === new URL(url).origin.replace("http:", "https:") + "/"))) throw new Error("outside scope");
        return { ...this.requireAction(scope, caseId, action), canonicalValue: target };
      },
    };
    const host = new WorkspaceNetworkHost(db, authorization, root);
    const request: StartProcessRequest = { requestId: "process:key", executable: "/bin/bash", arguments: [], environment: {}, stdin: "closed",
      workingDirectory: sharedRoot ?? join(root, "data/run-workspaces", createHash("sha256").update(JSON.stringify(["case", "run"])).digest("hex")),
      attribution: { caseId: "case", runId: "run", workId: "work", workerId: "worker", scopeRef: "scope", leaseId: "lease", leaseExpiresAt: "2099-01-01T00:00:00.000Z", idempotencyKey: "key", actionId: "action" },
      timeoutMs: 3000, outputLimitBytes: 4096, resources: { cpuTimeMs: 1000, memoryBytes: 1048576, maximumProcesses: 1, writeBytes: 1048576 },
      permissions: { version: 1, platform: "darwin", filesystem: { read: [], write: [], deny: [] }, process: { access: "sandboxed", background: false, interactive: false }, network: "brokered", secrets: "deny", sources: [] } };
    const binding = await host.bind(request); disposals.push(() => binding!.release());
    return { db, host, root, certificate, authorization, request, binding: binding!, url, calls: () => calls };
  }
  async function proxy(binding: MacosExecutionBinding, url: string) {
    const credentials = new URL(binding.environment!.http_proxy);
    return new Promise<number>((resolve, reject) => {
      const outgoing = send({ host: "127.0.0.1", port: binding.brokerPort, method: "GET", path: url,
        headers: { "proxy-authorization": `Basic ${Buffer.from(`${credentials.username}:`).toString("base64")}`, authorization: "private-fixture-value" } }, response => {
        response.resume(); response.on("end", () => resolve(response.statusCode!));
      }); outgoing.on("error", reject); outgoing.end();
    });
  }
  it("uses the same persisted conversation directory for brokered execution",async()=>{
    const f=await fixture(false,false,false,true);
    expect(await proxy(f.binding,f.url)).toBe(200);
    const legacy=join(f.root,"data/run-workspaces",createHash("sha256").update(JSON.stringify(["case","run"])).digest("hex"));
    expect(f.request.workingDirectory).not.toBe(legacy);
    await expect(f.host.bind({...f.request,workingDirectory:legacy})).rejects.toThrow("exact owned directory");
  });
  it("dispatches authorized HTTP and saves a bounded, attributed receipt without credentials", async () => {
    const f = await fixture(); expect(await proxy(f.binding, f.url)).toBe(200); expect(f.calls()).toBe(1);
    const rows = f.db.prepare("SELECT * FROM workspace_network_receipts").all();
    expect(rows).toMatchObject([{ parent_key: "key", case_id: "case", run_id: "run", status: "completed", kind: "http" }]);
    expect(JSON.stringify(rows)).not.toContain("private-fixture-value"); expect(JSON.stringify(rows)).not.toContain("scoped response");
  });
  it("brokers a reviewed stdio MCP origin and revokes its Run pin", async () => {
    const f=await fixture(),origin=new URL(f.url).origin+"/";
    f.db.exec(`CREATE TABLE desktop_mcp_versions(id TEXT,revision INTEGER,value_json TEXT);
      CREATE TABLE desktop_mcp_heads(id TEXT,revision INTEGER,active INTEGER,deleted INTEGER);
      CREATE TABLE desktop_mcp_runs(run_id TEXT,id TEXT,revision INTEGER);`);
    f.db.prepare("INSERT INTO desktop_mcp_versions VALUES ('sample',1,?)").run(JSON.stringify({connection:{id:"sample",transport:"stdio",executable:f.request.executable,
      arguments:[],workingDirectory:f.root,networkOrigins:[origin],destinationAddresses:["127.0.0.1"],authorizationAction:"workspace.execute"}}));
    f.db.exec("INSERT INTO desktop_mcp_heads VALUES ('sample',1,1,0); INSERT INTO desktop_mcp_runs VALUES ('run','sample',1)");
    f.db.exec("UPDATE tool_invocation_bindings SET tool_source='desktop.mcp.sample.r1'; CREATE TABLE process_execution_occupancy(process_key TEXT,identity_json TEXT,state TEXT)");
    f.db.prepare("INSERT INTO process_execution_occupancy VALUES ('key',?,'dispatched')").run(JSON.stringify({source:"desktop.mcp.sample",operation:"mcp.call",parentInvocationKey:"key"}));
    const request={...f.request,workingDirectory:f.root,attribution:{...f.request.attribution,actionId:"desktop.mcp:sample:1"}};
    const binding=await f.host.bind(request);disposals.push(()=>binding!.release());
    expect(await proxy(binding!,f.url)).toBe(200);
    expect(f.db.prepare("SELECT parent_key,connection_id,revision,status FROM desktop_mcp_network_receipts").all())
      .toEqual([{parent_key:"key",connection_id:"sample",revision:1,status:"completed"}]);
    f.db.exec("UPDATE desktop_mcp_heads SET active=NULL WHERE id='sample'");
    await expect(f.host.bind(request)).rejects.toThrow("not enabled");
  });
  it("binds a reviewed stdio MCP credential without granting network access", async () => {
    const f=await fixture();
    f.db.exec(`CREATE TABLE desktop_mcp_versions(id TEXT,revision INTEGER,value_json TEXT);
      CREATE TABLE desktop_mcp_heads(id TEXT,revision INTEGER,active INTEGER,deleted INTEGER);
      CREATE TABLE desktop_mcp_runs(run_id TEXT,id TEXT,revision INTEGER);
      CREATE TABLE process_execution_occupancy(process_key TEXT,identity_json TEXT,state TEXT);`);
    f.db.prepare("INSERT INTO desktop_mcp_versions VALUES ('sample',1,?)").run(JSON.stringify({connection:{id:"sample",transport:"stdio",executable:f.request.executable,
      arguments:[],workingDirectory:f.root,secretEnvironmentVariable:"SERVICE_TOKEN",authorizationAction:"workspace.execute"},credentialRef:"secure-store-ref"}));
    f.db.exec("INSERT INTO desktop_mcp_heads VALUES ('sample',1,1,0); INSERT INTO desktop_mcp_runs VALUES ('run','sample',1);");
    f.db.exec("UPDATE tool_invocation_bindings SET tool_source='desktop.mcp.sample.r1'");
    f.db.prepare("INSERT INTO process_execution_occupancy VALUES ('key',?,'dispatched')").run(JSON.stringify({source:"desktop.mcp.sample",operation:"mcp.call",parentInvocationKey:"key"}));
    const request={...f.request,environment:{SERVICE_TOKEN:"private-fixture-value"},workingDirectory:f.root,
      permissions:{...f.request.permissions,network:"deny" as const,secrets:"plaintext" as const},attribution:{...f.request.attribution,actionId:"desktop.mcp:sample:1"}};
    const binding=await f.host.bind(request);
    expect(binding).toMatchObject({secretEnvironment:{SERVICE_TOKEN:"private-fixture-value"}});
    expect(binding?.brokerPort).toBeUndefined();
    await binding?.release();
    await expect(f.host.bind({...request,environment:{OTHER_TOKEN:"private-fixture-value"}})).rejects.toThrow("credential");
  });
  it.skipIf(process.env.TRACEFORGE_TEST_MACOS_SEATBELT !== "1")("runs a reviewed MCP credential and network request inside the native sandbox",async()=>{
    const f=await fixture(),origin=new URL(f.url).origin+"/";
    f.db.exec(`CREATE TABLE desktop_mcp_versions(id TEXT,revision INTEGER,value_json TEXT);
      CREATE TABLE desktop_mcp_heads(id TEXT,revision INTEGER,active INTEGER,deleted INTEGER);
      CREATE TABLE desktop_mcp_runs(run_id TEXT,id TEXT,revision INTEGER);
      CREATE TABLE process_execution_occupancy(process_key TEXT,identity_json TEXT,state TEXT);`);
    const script=`printf '%s|' "$SERVICE_TOKEN"; /usr/bin/curl --silent --show-error --max-time 2 '${f.url}'`;
    f.db.prepare("INSERT INTO desktop_mcp_versions VALUES ('sample',1,?)").run(JSON.stringify({connection:{id:"sample",transport:"stdio",executable:f.request.executable,
      arguments:["-c",script],workingDirectory:f.root,networkOrigins:[origin],destinationAddresses:["127.0.0.1"],
      secretEnvironmentVariable:"SERVICE_TOKEN",authorizationAction:"workspace.execute"},credentialRef:"secure-store-ref"}));
    f.db.exec("INSERT INTO desktop_mcp_heads VALUES ('sample',1,1,0); INSERT INTO desktop_mcp_runs VALUES ('run','sample',1);");
    f.db.exec("UPDATE tool_invocation_bindings SET tool_source='desktop.mcp.sample.r1'");
    f.db.prepare("INSERT INTO process_execution_occupancy VALUES ('key',?,'dispatched')").run(JSON.stringify({source:"desktop.mcp.sample",operation:"mcp.call",parentInvocationKey:"key"}));
    const request:StartProcessRequest={...f.request,arguments:["-c",script],environment:{SERVICE_TOKEN:"private-fixture-value"},workingDirectory:f.root,
      timeoutMs:8000,resources:{cpuTimeMs:5000,memoryBytes:128*1024*1024,maximumProcesses:8,writeBytes:1048576},
      permissions:{...f.request.permissions,filesystem:{read:[{path:f.request.executable,scope:"exact"},{path:f.root,scope:"tree"},
        {path:"/usr/bin/env",scope:"exact"},{path:"/usr/bin/curl",scope:"exact"},{path:"/private/etc/ssl/openssl.cnf",scope:"exact"}],write:[],deny:[]},
        secrets:"plaintext",sources:["desktop-mcp-operator-grant"]},attribution:{...f.request.attribution,actionId:"desktop.mcp:sample:1"}};
    const path=realpathSync("packages/execution-node/native/darwin-arm64/traceforge-macos-sandbox");
    const sha256=createHash("sha256").update(readFileSync(path)).digest("hex");
    const launched=await new MacosProcessLauncher({path,sha256},undefined,input=>f.host.bind(input)).launch(request);
    let stdout="",stderr="";launched.process.onOutput((stream,bytes)=>{if(stream==="stdout")stdout+=bytes.toString();else stderr+=bytes.toString();});
    const code=await new Promise<number|null>((resolve,reject)=>{launched.process.onExit(resolve);launched.process.onError(reject);});
    expect({code,stdout,stderr,calls:f.calls()}).toEqual({code:0,stdout:"private-fixture-value|scoped response",stderr:"",calls:1});
  });
  it.each([false,true])("requires distinct consent for WebSocket upgrade and keeps connection receipts (allowed=%s)", async allowed => {
    const f=await fixture(false,false,allowed), credentials=new URL(f.binding.environment!.http_proxy);
    const socket=connect(f.binding.brokerPort!,'127.0.0.1');let output='';socket.on('data',bytes=>output+=bytes);socket.on('error',()=>{});
    try {
      socket.write(`GET ${f.url} HTTP/1.1\r\nHost: fixture\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nProxy-Authorization: Basic ${Buffer.from(`${credentials.username}:`).toString('base64')}\r\n\r\n`);
      for(let i=0;i<100&&!output.includes('\r\n\r\n');i++)await new Promise(resolve=>setTimeout(resolve,10));
      expect(output).toContain(allowed?'101 Switching Protocols':'502 Bad Gateway');
      if(allowed){socket.write('frame');for(let i=0;i<100&&!output.includes('frame');i++)await new Promise(resolve=>setTimeout(resolve,10));expect(output).toContain('frame');}
      expect(f.calls()).toBe(allowed?1:0);
      socket.destroy();await new Promise(resolve=>setTimeout(resolve,30));
      expect(f.db.prepare('SELECT kind FROM workspace_network_receipts').all()).toEqual(allowed?[{kind:'websocket_connection'}]:[]);
    } finally {socket.destroy();}
  });
  it("keeps a completed start receipt separate from the still-owned asynchronous process", async () => {
    const f = await fixture();
    f.db.exec("CREATE TABLE workspace_jobs(invocation,owner,state)");
    f.db.prepare("INSERT INTO workspace_jobs VALUES ('key',?,'running')").run(JSON.stringify(["case", "run", "work", "scope", "worker", "lease"]));
    f.db.exec("UPDATE tool_invocation_bindings SET tool_name='workspace_start'; UPDATE tool_invocation_executions SET status='completed'");
    expect(await proxy(f.binding, f.url)).toBe(200);
    f.db.exec("UPDATE workspace_jobs SET state='completed'");
    await expect(f.host.bind(f.request)).rejects.toThrow("no longer current");
  });
  it("denies an out-of-scope destination before traffic or receipt admission", async () => {
    const f = await fixture(); expect(await proxy(f.binding, f.url + "-other")).toBe(502); expect(f.calls()).toBe(0);
    expect(f.db.prepare("SELECT * FROM workspace_network_receipts").all()).toHaveLength(0);
  });
  it("revokes the endpoint when its exact invocation ceases executing", async () => {
    const f = await fixture(); f.db.prepare("UPDATE tool_invocation_executions SET status='completed'").run();
    await new Promise<void>(resolve => f.binding.signal.addEventListener("abort", () => resolve(), { once: true }));
    expect(f.calls()).toBe(0); await expect(f.host.bind(f.request)).rejects.toThrow("current");
  });
  it("denies a different Run scope, directory or interpreter, and keeps offline launches unchanged", async () => {
    const f = await fixture();
    await expect(f.host.bind({ ...f.request, attribution: { ...f.request.attribution, scopeRef: "another" } })).rejects.toThrow("scope");
    await expect(f.host.bind({ ...f.request, workingDirectory: "/other" })).rejects.toThrow("owned directory");
    await expect(f.host.bind({ ...f.request, executable: "/other" })).rejects.toThrow("launcher");
    expect(await f.host.bind({ ...f.request, permissions: { ...f.request.permissions, network: "deny" } })).toBeUndefined();
  });
  async function tunnel(f: Awaited<ReturnType<typeof fixture>>) {
    const credential = new URL(f.binding.environment!.http_proxy), target = new URL(f.url);
    return new Promise<string>((resolve, reject) => {
      const socket = connect(f.binding.brokerPort!, "127.0.0.1", () => socket.write(`CONNECT ${target.host} HTTP/1.1\r\nHost: ${target.host}\r\nProxy-Authorization: Basic ${Buffer.from(`${credential.username}:`).toString("base64")}\r\n\r\n`));
      let output = "", sent = false;
      socket.on("error", reject); socket.on("close", () => resolve(output));
      socket.on("data", bytes => { output += bytes; if (!sent && output.includes("200 Connection Established\r\n\r\n")) {
        sent = true; socket.write(`GET /allowed HTTP/1.1\r\nHost: ${target.host}\r\nConnection: close\r\n\r\n`);
      } });
    });
  }
  it("does not convert an HTTP path grant into opaque connection authority", async () => {
    const f = await fixture(); expect(await tunnel(f)).toContain("502 Bad Gateway"); expect(f.calls()).toBe(0);
    expect(f.db.prepare("SELECT * FROM workspace_network_receipts").all()).toHaveLength(0);
  });
  it("forwards an explicitly granted opaque connection and labels its application outcome unobservable", async () => {
    const f = await fixture(true); expect(await tunnel(f)).toContain("scoped response"); expect(f.calls()).toBe(1);
    const rows = f.db.prepare("SELECT kind,status,detail_json FROM workspace_network_receipts").all();
    expect(rows).toMatchObject([{ kind: "opaque_connection", status: "closed", detail_json: expect.stringContaining('"applicationOutcome":"not_observable"') }]);
  });
  it("recovers unconfirmed receipts as unknown without dispatching again", async () => {
    const f = await fixture(); await proxy(f.binding, f.url); await f.binding.release();
    f.db.prepare("UPDATE workspace_network_receipts SET status='pending',ended_at=NULL").run();
    new WorkspaceNetworkHost(f.db, f.authorization, f.root);
    expect(f.db.prepare("SELECT status FROM workspace_network_receipts").all()).toEqual([{ status: "unknown" }]); expect(f.calls()).toBe(1);
  });
  it.skipIf(process.env.TRACEFORGE_TEST_MACOS_SEATBELT !== "1").each([{tls:false,socks:false},{tls:true,socks:false},{tls:true,socks:true}])("executes the actual workspace adapter through native isolation and the host destination check (TLS=$tls SOCKS=$socks)", async ({tls,socks}) => {
    const f = await fixture(true, tls);
    const path = realpathSync("packages/execution-node/native/darwin-arm64/traceforge-macos-sandbox");
    const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
    const node = new LocalExecutionNode(new MacosProcessLauncher({ path, sha256 }, undefined, request => f.host.bind(request)), {
      platform: "darwin", architecture: "arm64", sandboxBackends: ["traceforge-macos-native"], sandboxMeasurements: { "traceforge-macos-native": sha256 },
      acceptedSampledResourceBackends: ["traceforge-macos-native"],
      capabilities: { process: { spawn: true, stdio: true, tty: false, adoption: true, resourceLimits: false, resourcePolicy: "sampled_terminate", signals: ["terminate", "kill"] } },
    }); disposals.push(() => node.shutdown());
    const workspace = new RunWorkspace(join(f.root, "data/run-workspaces"), new ExecutionNodeProcessTool(node), () => {});
    const context: ToolExecutionContext = { ...f.request.attribution,
      effectivePermissions: { ...workspace.profile("case", "run", "workspace_execute", true, true), sources: ["fixture"] } };
    if (f.certificate) await workspace.tools().find(tool => tool.name === "workspace_write")!.execute({ path: "cert.pem", content: f.certificate, expectedDigest: null }, context);
    const script = `/usr/bin/curl --fail --silent --show-error --max-time 2 ${socks ? '--proxy "$ALL_PROXY"' : ''} ${tls ? "--cacert cert.pem" : ""} '${f.url}' || exit 20\nif /usr/bin/curl --silent --max-time 2 --noproxy '*' '${f.url}'; then exit 21; fi\nprintf '\\ndirect-denied'`;
    const saved = await workspace.tools().find(tool => tool.name === "workspace_write")!.execute({ path: "run.sh", content: script, expectedDigest: null }, context);
    const result = await workspace.tools().find(tool => tool.name === "workspace_execute")!.execute({ path: "run.sh", expectedDigest: JSON.parse(saved.raw).digest }, context);
    expect(result).toMatchObject({ status: "succeeded", metadata: { exitCode: 0, enforcement: { network: "brokered", processTreeEmptyBarrier: true } } });
    expect(result.raw).toContain("scoped response"); expect(result.raw).toContain("direct-denied"); expect(f.calls()).toBe(1);
    expect(f.db.prepare("SELECT status FROM workspace_network_receipts").all()).toEqual([{ status: tls ? "closed" : "completed" }]);
  });
});
