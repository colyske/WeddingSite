import test from "node:test";
import assert from "node:assert/strict";
import { b2cReadiness, capabilityHash, dispatchB2c, receiveB2cCallback, resultEvidence, runB2cWorker } from "../server/b2c.js";

const id = "10000000-0000-4000-8000-000000000001";
const mustNotCall = () => { throw new Error("Unexpected external or database call"); };
test("unimplemented contract and ownership process cannot be activated by environment flags", async () => {
  const env = {
    WEDDINGSITE_PAYMENT_MODE:"live",DARAJA_ENVIRONMENT:"production",DARAJA_B2C_ENABLED:"true",
    DARAJA_B2C_CONTRACT_VERIFIED:"true",DARAJA_B2C_CAPABILITY_CONFIRMED:"true",DARAJA_B2C_AUTO_APPROVAL_ENABLED:"true"
  };
  for (const candidate of [{},env]) {
    const ready=b2cReadiness(candidate);
    assert.equal(ready.ready,false);
    assert.equal(ready.checks.implementedContract,false);
    assert.equal(ready.checks.destinationOwnershipProcess,false);
    await assert.rejects(dispatchB2c(id,id,"staff",{env:candidate,rpc:mustNotCall,fetcher:mustNotCall}),/prerequisites/);
  }
  assert.equal(b2cReadiness({}).autoApprovalGate,false);
});
test("worker only marks stale reservations and never retries or queries the provider",async () => {
  const calls=[];
  const result=await runB2cWorker({rpc:async name=>{calls.push(name);return 0;},fetcher:mustNotCall});
  assert.deepEqual(calls,["b2c_mark_stale"]);
  assert.equal(result.held,true);
});
test("no guessed callback payload or environment mapping can settle a payout",()=> {
  const evidence=resultEvidence({ResultCode:0,ResultParameters:{}},{amount_minor:1200},
    {DARAJA_B2C_CONTRACT_VERIFIED:"true",DARAJA_B2C_RESULT_MAPPING:'{"amountParameter":"amount"}'});
  assert.deepEqual(evidence,{outcome:"inconclusive",verified_contract:false});
});
test("callback capability is checked before a rejected-contract audit, without interpreting provider fields",async()=>{
  const token="b".repeat(64),calls=[];
  await assert.rejects(receiveB2cCallback(id,"","result",{}, {rpc:mustNotCall}),/capability/);
  const rpc=async(name,body)=> {
    calls.push(name);
    if(name==="b2c_callback_context") {
      assert.equal(body.p_hash,capabilityHash(token));
      return {id};
    }
    assert.equal(body.p_kind,"rejected");
    assert.equal(body.p_evidence.callback_hash,capabilityHash(token));
    return "uncertain";
  };
  await assert.rejects(receiveB2cCallback(id,token,"result",{arbitrary:"unverified"},{rpc}),/contract is not implemented/);
  assert.deepEqual(calls,["b2c_callback_context","b2c_record_event"]);
  calls.length=0;
  await assert.rejects(receiveB2cCallback(id,token,"timeout",{}, {rpc:async()=>{throw new Error("Invalid capability");}}),/Invalid capability/);
  assert.equal(calls.length,0);
});
