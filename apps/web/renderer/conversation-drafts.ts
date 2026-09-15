import type {JournalStorage} from "./host-conversation-controller";
const key="traceforge.desktop.session-drafts.v1";
/** Local drafts, not credential storage. Bound total text and never evict silently. */
export class ConversationDrafts {
  static persistent(storage: JournalStorage, previous: JournalStorage) {
    if (storage.getItem(key) === null) {
      const old = previous.getItem(key);
      if (old !== null) { new ConversationDrafts(previous); storage.setItem(key, old); }
    }
    return new ConversationDrafts(storage);
  }
  private values: Record<string,string> = Object.create(null);
  constructor(private storage:JournalStorage){
    const raw=storage.getItem(key);if(!raw)return;
    if(raw.length>262144)throw new Error("Draft capacity exceeded");
    const parsed:unknown=JSON.parse(raw);
    if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))throw new Error("Invalid drafts");
    for(const [id,text] of Object.entries(parsed)){
      if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id)||typeof text!=="string"||text.length>16000)throw new Error("Invalid draft");
      this.values[id]=text;
    }
  }
  read(id:string){return this.values[id]??"";}
  write(id:string,text:string){
    if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id)||text.length>16000)throw new Error("Invalid draft");
    const next={...this.values};if(text)next[id]=text;else delete next[id];
    const serialized=JSON.stringify(next);if(serialized.length>262144)throw new Error("Draft capacity exceeded");
    this.storage.setItem(key,serialized);this.values=next;
  }
}
