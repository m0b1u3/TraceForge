import { canonicalJson, type ScenarioPackageBinding, type ScenarioRunState } from "@traceforge/orchestration-core";
import { validateScenarioOutput, type ScenarioPackageInstallation } from "./index.js";

/** Declarative compatibility assertion, not a script or arbitrary state transformer. */
export interface PreserveRunMigration {
  format: "traceforge.run-migration.v1";
  mode: "preserve_state";
  from: ScenarioPackageBinding;
  to: ScenarioPackageBinding;
}

export function assertPreserveRunCompatibility(source:ScenarioPackageInstallation,target:ScenarioPackageInstallation,state:ScenarioRunState):void {
  if(source.id!==target.id || source.version===target.version || source.schemaRevision>=target.schemaRevision
    || source.definition.kind!==target.definition.kind || source.definition.version>=target.definition.version)throw new Error("Migration requires a forward version of the same Package");
  if(canonicalJson({...source.definition,version:0})!==canonicalJson({...target.definition,version:0}))throw new Error("Migration cannot change the structural definition");
  const schemas=(pkg:ScenarioPackageInstallation)=>pkg.outputSchemas.map(s=>"format" in s?s:{kind:s.kind,version:s.version})
    .sort((a,b)=>a.kind.localeCompare(b.kind));
  if(canonicalJson(schemas(source))!==canonicalJson(schemas(target)))throw new Error("Migration cannot rewrite output schemas");
  const sourcePolicy=source.authorizationPolicy,targetPolicy=target.authorizationPolicy;
  if("format" in sourcePolicy || "format" in targetPolicy){
    if(canonicalJson(sourcePolicy)!==canonicalJson(targetPolicy))throw new Error("Migration requires the same declarative authorization policy");
  }else if(sourcePolicy.parseScope!==targetPolicy.parseScope || sourcePolicy.authorizeResource!==targetPolicy.authorizeResource){
    throw new Error("Migration requires the same reviewed authorization policy implementation");
  }
  if(source.createToolSources!==target.createToolSources
    || canonicalJson(source.runtime??null)!==canonicalJson(target.runtime??null))throw new Error("Migration requires the same reviewed tool factory or process execution form");
  for(const output of state.outputs){
    const schema=target.outputSchemas.find(s=>s.kind===output.kind && s.version===output.schemaVersion);
    if(!schema)throw new Error("Historical output schema is unavailable");
    validateScenarioOutput(schema,structuredClone(output));
  }
}
