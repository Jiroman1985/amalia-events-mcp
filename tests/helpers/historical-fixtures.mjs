// Existing editorial/retirement regression tests use verified historical fixtures.
// Only this test subclass seeds that historical verification state directly in
// its in-memory store. Production admission always creates capturado records.
import { EventService } from '../../event-service.mjs';
import { record, canonicalInput } from '../../event-domain.mjs';
export class HistoricalFixtureService extends EventService {
 async create(input,principal) {
  if(!this.store.rows.has('amalia_catalog_guard/eventos'))this.store.rows.set('amalia_catalog_guard/eventos',{data:{epoch:0},updateTime:'test-guard'});
  const desired=input.verificationStatus;
  const candidate={...input,verificationStatus:'capturado'};
  // Validate the legacy fixture's verification requirements, never infer them.
  if(desired && desired!=='capturado')record(canonicalInput(input),principal);
  const p=await this.prepareAdmission(candidate,principal);
  const e=await this.admitCandidate({accion:'admit',proposalHash:p.proposalHash,evento:candidate},principal);
  if(desired && desired!=='capturado') {
   this.store.rows.get('eventos/'+e.eventId).data.verificationStatus=desired;
   e.verificationStatus=desired;
  }
  return e;
 }
}
