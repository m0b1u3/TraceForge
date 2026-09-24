import {expect,it} from "vitest";
import {existsSync,mkdtempSync,readFileSync,writeFileSync,rmSync,realpathSync,cpSync} from "node:fs";
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
const source=resolve("apps/desktop/bundled-scenarios"),helper=resolve("packages/execution-node/native/darwin-arm64/traceforge-macos-sandbox");
it.skipIf(process.env.TRACEFORGE_TEST_MACOS_SEATBELT!=="1")("discovers built-in tools using the bundled Node inside the real macOS sandbox",async()=>{
  const config=loadBundledScenarios(source,helper),installed=config.trust.installations![0];
  const descriptor=parseScenarioPackageDescriptor(JSON.parse(readFileSync(join(installed.root,"scenario.json"),"utf8")));
  const launch=config.launches[descriptor.runtime!.source] as import("@traceforge/worker-runtime").ScenarioProcessLaunch & {expectedBackendMeasurement:string};
  const sql=getSqliteClient(createDb(":memory:"));
  const node=new LocalExecutionNode(new MacosProcessLauncher({path:helper,sha256:launch.expectedBackendMeasurement}),{platform:"darwin",architecture:"arm64",sandboxBackends:["traceforge-macos-native"],sandboxMeasurements:{"traceforge-macos-native":launch.expectedBackendMeasurement},acceptedSampledResourceBackends:["traceforge-macos-native"],operationJournal:new SqliteProcessOperationJournal(sql),processJournal:new SqliteProcessExecutionJournal(sql),capabilities:{process:{spawn:true,stdio:true,tty:true,adoption:true,resourceLimits:false,resourcePolicy:"sampled_terminate",signals:["interrupt","terminate","kill"]}}});
  const capacity=new ProcessExecutionCapacity(sql,new ToolProviderFairScheduler());
  const runtime=new ScenarioProcessRuntime({manifest:descriptor.runtime!,launch,executionNode:node,supervision:new SqliteScenarioProcessSupervisionStore(sql),processCapacity:{acquire:(generation,attribution,signal)=>capacity.acquire({source:descriptor.runtime!.source,version:descriptor.version,operation:`scenario-process:generation:${generation}`,kind:"service",attribution},signal)},capabilityHandlers:descriptor.runtime!.hostCapabilities.map(capability=>({capability,actions:["unused"],execute:async()=>{throw new Error("Discovery must not invoke host capabilities");}}))});
  try{const tools=await runtime.discover();expect(tools.map(t=>t.name)).toContain("web.browser.inspect");expect(runtime.status().state).toBe("ready");}
  finally{await runtime.close().catch(()=>{});await node.shutdown();sql.close();}
});
it.skipIf(!existsSync(join(source,"catalog.json"))||!existsSync(helper))("loads built-in material and standalone execution without any user installation configuration",()=>{
  const config=loadBundledScenarios(source,helper);
  expect(config.trust.installations).toHaveLength(1);
  const launch=Object.values(config.launches)[0];
  expect(launch.executable).toBe(join(source,"node"));
  expect(launch.permissions).toMatchObject({network:"deny",secrets:"deny",filesystem:{write:[]},process:{access:"sandboxed",background:false}});
  expect(launch.acceptedResourcePolicy).toBe("sampled_terminate");
  expect(config.trust.authority?.(config.trust.installations![0].review.keyId)).toBeTruthy();
});
it.skipIf(!existsSync(join(source,"catalog.json"))||!existsSync(helper))("rejects altered bundled material, never falling back to an unrestricted launcher",()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),"traceforge-builtin-test-")));
  try{cpSync(source,root,{recursive:true});const catalog=JSON.parse(readFileSync(join(root,"catalog.json"),"utf8"));
    const entry=join(root,catalog.installations[0].directory,catalog.installations[0].manifest.entry);
    writeFileSync(entry,"changed");expect(()=>loadBundledScenarios(root,helper)).toThrow(/Material/);
    catalog.node.sha256="0".repeat(64);writeFileSync(join(root,"catalog.json"),JSON.stringify(catalog));
    expect(()=>loadBundledScenarios(root,helper)).toThrow("Node runtime changed");
  }finally{rmSync(root,{recursive:true,force:true});}
});
