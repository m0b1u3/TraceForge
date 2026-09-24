import { buildAuthorizationScope, TaskPresetsSchema, selectedTaskKind,taskDefinitionIdentity,defaultTaskConfiguration,resolveTaskConfiguration,taskConfigurationScope, type TaskDefinition, type TaskPreset } from "@traceforge/shared/authorization-form";
export {TaskDefinitionSchema,TaskDefinitionsSchema,type TaskDefinition,type TaskPreset} from "@traceforge/shared/authorization-form";
import { desktopJournalStorage } from "./desktop-journal-storage";

const key = "traceforge.desktop.task-preferences.v1";
const storedSchema = TaskPresetsSchema;
export const taskIdentity = taskDefinitionIdentity;
export const taskField = (field:TaskDefinition["authorizationForm"]["fields"][number]) => field.required || field.type === "string-list" && !field.advanced;
/** Suggestions are visible editable literals, not a grant or an origin expansion. */
export function taskInputs(d:TaskDefinition,p:TaskPreset,message:string):string[] {
  const urls=[...new Set(message.match(/https?:\/\/[^\s<>"'`，。；！？）】]+/gu)??[])];
  return d.authorizationForm.fields.map((f,i)=>f.suggestion==="message-urls"&&!p.inputs[i]?urls.join("\n"):p.inputs[i]);
}
export function defaultTaskPreset(d:TaskDefinition):TaskPreset {
  return defaultTaskConfiguration(d);
}
export function readTaskPreset(d:TaskDefinition):TaskPreset {
  const raw=desktopJournalStorage().getItem(key);
  return resolveTaskConfiguration(d,raw);
}
export function taskScope(d:TaskDefinition,p:TaskPreset,inputs=p.inputs) {
  return taskConfigurationScope(d,p,inputs);
}
export function saveTaskPreset(d:TaskDefinition,p:TaskPreset) {
  // Task-specific required targets are supplied at launch, not required for saving preferences.
  buildAuthorizationScope({...d.authorizationForm,fields:d.authorizationForm.fields.map(f=>({...f,required:false}))},p.inputs);
  if(p.actions.some(a=>!d.authorizationReview.allowedActions.includes(a)||d.authorizationReview.deniedActions.includes(a)))throw new Error("操作配置无效。");
  const storage=desktopJournalStorage(),raw=storage.getItem(key),rows=raw===null?[]:storedSchema.parse(JSON.parse(raw));
  const previous=rows.find(row=>row.kind===d.kind);
  const next={...p,identity:taskIdentity(d),revision:(previous?.preset.revision??0)+1};
  storage.setItem(key,JSON.stringify([...rows.filter(row=>row.kind!==d.kind),{kind:d.kind,preset:next,...(previous?.default?{default:true}:{})}]));
  return next;
}
export function readDefaultTaskKind(definitions:TaskDefinition[]) {
  const raw=desktopJournalStorage().getItem(key);
  return selectedTaskKind(raw,definitions)??"";
}
export function saveDefaultTask(d:TaskDefinition) {
  const storage=desktopJournalStorage(),raw=storage.getItem(key),rows=raw===null?[]:storedSchema.parse(JSON.parse(raw));
  const preset=resolveTaskConfiguration(d,raw);
  storage.setItem(key,JSON.stringify([...rows.filter(row=>row.kind!==d.kind).map(row=>({...row,default:false})),{kind:d.kind,preset,default:true}]));
}
