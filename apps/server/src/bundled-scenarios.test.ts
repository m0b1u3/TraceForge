import {expect,it} from "vitest";
import {existsSync,mkdtempSync,readFileSync,rmSync} from "node:fs";
import {join,resolve} from "node:path";
import {tmpdir} from "node:os";
import {loadBundledScenarios} from "./bundled-scenarios.js";
import {LocalExecutionNode,MacosProcessLauncher} from "@traceforge/execution-node";
import {ScenarioProcessRuntime,ToolProviderFairScheduler} from "@traceforge/worker-runtime";
import {ProcessExecutionCapacity} from "./process-execution-capacity.js";
import {parseScenarioPackageDescriptor} from "@traceforge/scenario-sdk";
import {SqliteScenarioProcessSupervisionStore} from "./scenario-process-supervision.js";
import {createDb,getSqliteClient} from "./db/client.js";
import {SqliteProcessOperationJournal} from "./execution-process-operation-journal.js";
import {SqliteProcessExecutionJournal} from "./execution-process-journal.js";
import {buildServer} from "./main.js";
import {foundationHostControl} from "./foundation-host-control.js";
const source=resolve("apps/desktop/bundled-scenarios"),helper=resolve("packages/execution-node/native/darwin-arm64/traceforge-macos-sandbox");
it.skipIf(process.env.TRACEFORGE_TEST_MACOS_SEATBELT!=="1")("discovers built-in tools using the bundled Node inside the real macOS sandbox",async()=>{
  const config=loadBundledScenarios(source,helper),descriptor=config.registry.list()[0]!;
  const launch=config.launches[descriptor.runtime!.source] as import("@traceforge/worker-runtime").ScenarioProcessLaunch & {expectedBackendMeasurement:string};
  const sql=getSqliteClient(createDb(":memory:"));
  const node=new LocalExecutionNode(new MacosProcessLauncher({path:helper,sha256:launch.expectedBackendMeasurement}),{platform:"darwin",architecture:"arm64",sandboxBackends:["traceforge-macos-native"],sandboxMeasurements:{"traceforge-macos-native":launch.expectedBackendMeasurement},acceptedSampledResourceBackends:["traceforge-macos-native"],operationJournal:new SqliteProcessOperationJournal(sql),processJournal:new SqliteProcessExecutionJournal(sql),capabilities:{process:{spawn:true,stdio:true,tty:true,adoption:true,resourceLimits:false,resourcePolicy:"sampled_terminate",signals:["interrupt","terminate","kill"]}}});
  const capacity=new ProcessExecutionCapacity(sql,new ToolProviderFairScheduler());
  const runtime=new ScenarioProcessRuntime({manifest:descriptor.runtime!,launch,executionNode:node,supervision:new SqliteScenarioProcessSupervisionStore(sql),processCapacity:{acquire:(generation,attribution,signal)=>capacity.acquire({source:descriptor.runtime!.source,version:descriptor.version,operation:`scenario-process:generation:${generation}`,kind:"service",attribution},signal)},capabilityHandlers:descriptor.runtime!.hostCapabilities.map(capability=>({capability,actions:["unused"],execute:async()=>{throw new Error("Discovery must not invoke host capabilities");}}))});
  try{const tools=await runtime.discover();expect(tools.map(t=>t.name)).toContain("web.browser.inspect");expect(runtime.status().state).toBe("ready");}
  finally{await runtime.close().catch(()=>{});await node.shutdown();sql.close();}
});
it.skipIf(!existsSync(join(source,"web-blackbox/scenario.json"))||!existsSync(helper))("loads one built-in Scenario directly without a catalog or self-signed review",()=>{
  const config=loadBundledScenarios(source,helper);
  expect(config.registry.list()).toHaveLength(1);
  expect(config.binding.version).toMatch(/^b[a-f0-9]{16}$/);
  expect(config.context.length).toBeGreaterThan(0);
  expect(existsSync(join(source,"catalog.json"))).toBe(false);
  const launch=Object.values(config.launches)[0];
  expect(launch.executable).toBe(join(source,"node"));
  expect(launch.permissions).toMatchObject({network:"deny",secrets:"deny",filesystem:{write:[]},process:{access:"sandboxed",background:false}});
  expect(launch.acceptedResourcePolicy).toBe("sampled_terminate");
  const descriptor=parseScenarioPackageDescriptor(JSON.parse(readFileSync(join(source,"web-blackbox/scenario.json"),"utf8")));
  expect(descriptor.runtime?.version).toBe(config.binding.version);
});
it.skipIf(!existsSync(join(source,"web-blackbox/scenario.json"))||!existsSync(helper))("assembles the one built-in Scenario with its editable resources and no package review",async()=>{
  const root=mkdtempSync(join(tmpdir(),"traceforge-builtin-direct-"));
  const app=await buildServer(":memory:",join(root,"mcp.json"),join(root,"llm.json"),root,undefined,
    {bundledScenarioConfiguration:loadBundledScenarios(source,helper)});
  try{
    const headers=foundationHostControl(app).management().headers();
    expect((await app.inject({url:"/api/scenarios/package-trust",headers})).json()).toMatchObject({mode:"built_in",packages:[{status:"built_in"}]});
    const settings=(await app.inject({url:"/api/desktop/configuration",headers})).json();
    expect(settings.packages[0].resources.some((item:{id:string;editable:boolean})=>item.id==="web.review-and-report"&&item.editable)).toBe(true);
  }finally{await app.close();rmSync(root,{recursive:true,force:true});}
});
