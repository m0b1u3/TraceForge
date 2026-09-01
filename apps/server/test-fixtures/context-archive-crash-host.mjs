import { archiveFixture, archivePublicKey, transfer } from "../src/test-fixtures/context-archive.ts";
import { database } from "../src/test-fixtures/execution-recovery.ts";

const [path,phase]=process.argv.slice(2);
const source=archiveFixture(),archive=(await source.control.execute(transfer("export"))).archive;
source.sqlite.close();
const target=archiveFixture(false,database(path));
function checkpoint(){
  process.stdout.write(JSON.stringify({phase,publicKey:archivePublicKey,archive})+"\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,15000);
  throw new Error("Parent did not terminate context transfer fixture");
}
target.sqlite.function("transfer_checkpoint",checkpoint);
if(phase==="archive_uncommitted")target.sqlite.exec("CREATE TEMP TRIGGER transfer_fault AFTER INSERT ON context_package_archives BEGIN SELECT transfer_checkpoint(); END");
if(phase==="content_uncommitted")target.sqlite.exec("CREATE TEMP TRIGGER transfer_fault AFTER INSERT ON package_context_content WHEN NEW.resource_id='second' BEGIN SELECT transfer_checkpoint(); END");
await target.control.execute(transfer("import",archive));
if(phase==="committed")checkpoint();
throw new Error("Unknown context archive crash phase");
