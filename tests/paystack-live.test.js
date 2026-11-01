import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac, createHash } from "node:crypto";
import { Readable } from "node:stream";
import { paystackEnvironment, paystackAdmissionEnabled, paystackCredentialFingerprint, contextDigest,
  paystackSplit, verifyPaystackContext, verifiedSubaccount, parsePaystackJson, reconcilePaystackSettlement, paystackReadiness,
  paystackApproval, validatePaystackInitialization } from "../server/paystack.js";
import { verifyProviderPayment } from "../server/payment-adapters.js";
import { createPaystackCheckout } from "../api/checkout.js";
import checkout from "../api/checkout.js";
import webhooks from "../api/webhooks.js";
import admin from "../api/admin.js";
import finance from "../api/finance.js";

const env = {
  WEDDINGSITE_PAYMENT_MODE: "live", PAYSTACK_SECRET_KEY: "sk_live_synthetic_fixture",
  PAYSTACK_MERCHANT_ID: "123", PAYSTACK_LIVE_MERCHANT_CONFIRMED: "123",
  PAYSTACK_LIVE_COLLECTION_ENABLED: "true", PAYSTACK_LIVE_PUBLICATION_ENABLED: "true",
  PAYSTACK_RECONCILIATION_ENABLED: "true", PAYSTACK_LIVE_SPLIT_ENABLED: "true",
  PAYSTACK_SUPPORTED_CURRENCIES: "KES", PAYSTACK_SUPPORTED_MARKETS: "KE",
  WEDDINGSITE_PUBLIC_ORIGIN: "https://weddingsite.example", TURNSTILE_SECRET_KEY: "fixture",
  TURNSTILE_SITE_KEY: "fixture-site", SUPABASE_URL: "https://db.example",
  SUPABASE_SERVICE_ROLE_KEY: "fixture-service", SUPABASE_ANON_KEY: "fixture-anon"
};
const original = Object.fromEntries(Object.keys(env).map(key => [key,process.env[key]]));
const fetchOriginal = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = fetchOriginal;
  for (const [key,value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
const WID = "550e8400-e29b-41d4-a716-446655440000";
const CID = "550e8400-e29b-41d4-a716-446655440001";
const KEY = "550e8400-e29b-41d4-a716-446655440002";
function context(kind = "guest", bearer = "subaccount") {
  Object.assign(process.env,env);
  return {
    kind, environment: "live", merchant_id: "123", credential_fingerprint: paystackCredentialFingerprint(),
    amount_minor: 10005, currency: "KES", policy_revision: KEY, wedding_id: WID, platform_fee_minor: kind === "publication" ? 10005 : 501,
    fee_bearer: kind === "publication" ? "account" : bearer, ...(kind === "guest" ? { settlement_mode:"split",settlement_route:"paystack_direct",subaccount_code: "ACCT_fixture", subaccount_id: "456",
      policy_revision: KEY, destination_revision: KEY, fee_basis_points: 500, fixed_fee_minor: 1 } : {})
  };
}
function transaction(ctx) {
  const fee = 100, couple = ctx.amount_minor - ctx.platform_fee_minor - (ctx.fee_bearer === "subaccount" ? fee : 0);
  return { id: "18446744073709551615", domain: "live", status: "success", reference: KEY,
    amount: ctx.amount_minor, currency: ctx.currency, fees: fee,
    metadata: { contribution_id: CID, ws_context: contextDigest(ctx), ...(ctx.kind === "publication" ? { payment_kind: "publication" } : {}) },
    ...(ctx.kind === "guest" ? { split: {
      formula: { type: "flat", integration: 123, subaccounts: [{ subaccount_code: ctx.subaccount_code, share: ctx.amount_minor-ctx.platform_fee_minor }] },
      shares: { paystack: fee, integration: ctx.platform_fee_minor-(ctx.fee_bearer === "account" ? fee : 0),
        subaccounts: [{ id: 456, subaccount_code: ctx.subaccount_code, amount: couple }] }
    } } : { split: {}, subaccount: {} })
  };
}
function standardContext() {
  const ctx=context();
  for (const key of ["subaccount_code","subaccount_id","destination_revision","destination_fingerprint"]) delete ctx[key];
  return {...ctx,settlement_mode:"standard",settlement_route:"platform_wallet",fee_bearer:"couple_wallet",market:"KE"};
}
function standardTransaction(ctx) {
  return {...transaction(ctx),split:{},subaccount:{},fees_split:null};
}
function call(handler,req) {
  const res = { setHeader() {}, status(code) { this.statusCode=code; return this; }, end(value) { this.body=JSON.parse(value); } };
  return handler(req,res).then(()=>res);
}
test("live mode, merchant confirmation and independent switches default closed", () => {
  context();
  delete process.env.PAYSTACK_LIVE_COLLECTION_ENABLED;
  assert.equal(paystackEnvironment(),"live");
  assert.equal(paystackAdmissionEnabled(),false);
  process.env.PAYSTACK_LIVE_COLLECTION_ENABLED="true";
  process.env.PAYSTACK_LIVE_PUBLICATION_ENABLED="false";
  assert.equal(paystackAdmissionEnabled(),true);
  assert.equal(paystackAdmissionEnabled("publication"),false);
  process.env.PAYSTACK_RECONCILIATION_ENABLED="false";
  assert.equal(paystackAdmissionEnabled(),false);
  process.env.PAYSTACK_SECRET_KEY="sk_test_fixture";
  assert.equal(paystackEnvironment(),null);
});
test("lossless Paystack JSON preserves unsigned 64-bit transaction IDs", () => {
  assert.equal(parsePaystackJson('{"id":18446744073709551615,"amount":10005}').id,"18446744073709551615");
  assert.throws(()=>parsePaystackJson('{"amount":1,"amount":2}'));
});
test("flat split and both fee bearers conserve precision; publication is unsplit", async () => {
  for (const bearer of ["account","subaccount"]) {
    const ctx = context("guest",bearer);
    const tx = transaction(ctx);
    const allocation = verifyPaystackContext(tx,ctx);
    assert.equal(allocation.couple_minor+allocation.platform_minor+allocation.provider_fee_minor,10005);
    assert.equal(allocation.platform_minor,bearer==="account" ? 401 : 501);
    const split = paystackSplit(ctx,KEY);
    assert.deepEqual(split.subaccounts,[{ subaccount: "ACCT_fixture",share: 9504 }]);
    assert.equal(split.bearer_subaccount,bearer==="subaccount" ? "ACCT_fixture" : undefined);
  }
  for (const kind of ["guest","publication"]) {
    const ctx = context(kind);
    globalThis.fetch = async (url,init) => {
      if (new URL(url).host==="db.example") {
        const path = new URL(url).pathname;
        if (path==="/rest/v1/platform_policies") return Response.json([{enabled_payment_providers:["paystack"]}]);
        if (path==="/rest/v1/paystack_destinations") return Response.json([{revision:KEY,consent_at:"2026-11-01T00:00:00Z"}]);
        assert.equal(path,"/rest/v1/paystack_live_policy");
        return Response.json([{approved:true,settlement_mode:"split",split_enabled:true,split_contract_ready:true,publication_enabled:true,merchant_id:"123",
          credential_fingerprint:ctx.credential_fingerprint,revision:KEY,capabilities:[{market:"KE",currency:"KES"}]}]);
      }
      assert.equal(url,"https://api.paystack.co/transaction/initialize");
      const body = JSON.parse(init.body);
      assert.equal(body.amount,10005);
      assert.equal(body.metadata.ws_context,contextDigest(ctx));
      assert.equal(Boolean(body.split),kind==="guest");
      assert.equal(body.subaccount,undefined);
      return Response.json({ status: true, data: { authorization_url: "https://checkout.paystack.com/fixture",reference: KEY } });
    };
    await createPaystackCheckout({ id: CID,weddingId: WID,amountMinor: 10005,currency: "KES",
      email: "fixture@example.test",returnUrl: "https://weddingsite.example/guest.html",idempotencyKey: KEY,
      paymentKind: kind==="publication" ? kind : undefined,paystackContext: ctx });
  }
});
test("missing or mismatched split/merchant/mode/amount/destination evidence fails closed", () => {
  const ctx = context();
  for (const change of [
    tx=>{tx.domain="test";},tx=>{tx.amount++;},tx=>{tx.currency="USD";},
    tx=>{tx.metadata.ws_context="different";},tx=>{tx.split={};},
    tx=>{tx.split.shares.integration++;},tx=>{tx.split.shares.subaccounts[0].subaccount_code="ACCT_other";},
    tx=>{tx.split.formula.subaccounts[0].share++;},tx=>{tx.split.formula.integration=999;}
  ]) {
    const tx = transaction(ctx); change(tx);
    assert.throws(()=>verifyPaystackContext(tx,ctx));
  }
  const pub = context("publication");
  const tx = transaction(pub); tx.subaccount={subaccount_code:"ACCT_other"};
  assert.throws(()=>verifyPaystackContext(tx,pub));
  for (const fees of [null,-1,10006]) {
    assert.throws(()=>verifyPaystackContext({...transaction(pub),fees},pub));
  }
});
test("destination onboarding reads only; unverified, inactive or swapped bank context is rejected", async () => {
  context();
  const sample = { id:456,subaccount_code:"ACCT_fixture",integration:123,currency:"KES",domain:"live",
    product:"collection",active:true,is_verified:true,account_number:"synthetic-account",settlement_bank:"synthetic-bank",
    account_name:"Synthetic",updatedAt:"2026-11-01T00:00:00Z" };
  let data = sample;
  globalThis.fetch=async(url,init)=>{
    assert.equal(url,"https://api.paystack.co/subaccount/ACCT_fixture");
    assert.equal(init.method,undefined);
    return Response.json({status:true,data});
  };
  const verified=await verifiedSubaccount("ACCT_fixture","KES");
  assert.ok(!JSON.stringify(verified).includes("synthetic-account"));
  assert.ok(!JSON.stringify(verified).includes("synthetic-bank"));
  for (const patch of [{is_verified:false},{active:false},{integration:999},{domain:"test"},{currency:"USD"}]) {
    data={...sample,...patch}; await assert.rejects(verifiedSubaccount("ACCT_fixture","KES"));
  }
  data={...sample,account_number:"changed-synthetic-account"};
  assert.notEqual((await verifiedSubaccount("ACCT_fixture","KES")).destination_fingerprint,verified.destination_fingerprint);
});
test("verification continues after collection kill but refuses credential swaps before any network request", async () => {
  const ctx=context(),tx=transaction(ctx);
  process.env.PAYSTACK_LIVE_COLLECTION_ENABLED="false";
  let calls=0;
  globalThis.fetch=async()=>{calls++;return Response.json({status:true,data:tx});};
  const payment=await verifyProviderPayment("paystack",KEY,CID,10005,"KES",{context:ctx});
  assert.equal(payment.verified,true);
  assert.equal(payment.providerPaymentReference,"18446744073709551615");
  process.env.PAYSTACK_SECRET_KEY="sk_live_other_fixture";
  await assert.rejects(verifyProviderPayment("paystack",KEY,CID,10005,"KES",{context:ctx}));
  assert.equal(calls,1);
});
test("signed webhook independently verifies before exactly-once direct settlement and never uses wallet RPC", async () => {
  const ctx=context(),tx=transaction(ctx), paths=[], events=new Set();
  let providerSuccess=true;
  globalThis.fetch=async(input,init={})=>{
    const url=new URL(input); paths.push(url.pathname);
    if (url.host==="api.paystack.co") return Response.json({status:true,data:{...tx,status:providerSuccess ? "success" : "pending"}});
    if (url.pathname==="/rest/v1/contributions") return Response.json([{id:CID,provider_reference:KEY,pledged_amount_minor:10005,currency:"KES",paystack_context:ctx}]);
    assert.equal(url.pathname,"/rest/v1/rpc/record_verified_paystack_payment");
    const body=JSON.parse(init.body), fresh=!events.has(body.p_event_id);
    assert.equal(body.p_allocation.couple_minor,9404);
    events.add(body.p_event_id);
    return Response.json(fresh);
  };
  const raw=Buffer.from(JSON.stringify({event:"charge.success",data:tx}));
  const hook=async(signature)=>{
    const req=Readable.from([raw]);req.method="POST";req.query={provider:"paystack"};
    req.headers={"x-paystack-signature":signature};return call(webhooks,req);
  };
  const signature=createHmac("sha512",env.PAYSTACK_SECRET_KEY).update(raw).digest("hex");
  assert.equal((await hook("invalid")).statusCode,400);assert.equal(paths.length,0);
  providerSuccess=false;
  assert.equal((await hook(signature)).statusCode,500);assert.equal(events.size,0);
  providerSuccess=true;
  assert.equal((await hook(signature)).body.processed,true);
  assert.equal((await hook(signature)).body.processed,false);
  assert.equal(events.size,1);
  assert.ok(!paths.includes("/rest/v1/rpc/record_verified_payment"));
});
test("stale provider switches prevent live checkout before initialization", async () => {
  context();
  let providerCalls=0;
  globalThis.fetch=async(input)=>{
    const url=new URL(input);
    if (url.host==="api.paystack.co") {providerCalls++;throw new Error("Unexpected financial call");}
    assert.equal(url.pathname,"/rest/v1/platform_policies");
    return Response.json([{enabled_payment_providers:["daraja"]}]);
  };
  const result=await call(checkout,{method:"POST",query:{action:"create"},headers:{origin:"https://weddingsite.example"},
    body:{weddingId:WID,purchaseAction:"song_bid",market:"KE",currency:"KES",provider:"paystack",
      idempotencyKey:KEY,visibility:"hidden",email:"fixture@example.test",songTitle:"Fixture",artist:"Artist",amountMinor:10005}});
  assert.equal(result.statusCode,409);
  assert.equal(providerCalls,0);
});
for (const mode of ["standard","split"]) test(`${mode} live guest initialization persists its immutable reference before HTTP and retains an uncertain attempt`, async () => {
  const ctx=mode === "standard" ? standardContext() : context();
  const sample = { id:456,subaccount_code:"ACCT_fixture",integration:123,currency:"KES",domain:"live",
    product:"collection",active:true,is_verified:true,account_number:"synthetic",settlement_bank:"synthetic",
    account_name:"Synthetic",updatedAt:"2026-11-01T00:00:00Z" };
  ctx.market="KE";
  ctx.destination_fingerprint=createHash("sha256").update(JSON.stringify([
    sample.account_number,sample.settlement_bank,sample.account_name,sample.updatedAt
  ])).digest("hex");
  const rows=[], writes=[];
  let initializations=0;
  globalThis.fetch=async(input,init={})=>{
    const url=new URL(input), method=init.method || "GET", path=url.pathname;
    if (url.host==="challenges.cloudflare.com") return Response.json({success:true,hostname:"weddingsite.example"});
    if (url.host==="api.paystack.co") {
      if (path==="/integration/payment_session_timeout") return Response.json({status:true,data:1800});
      if (path==="/subaccount/ACCT_fixture") return Response.json({status:true,data:sample});
      assert.equal(path,"/transaction/initialize");
      assert.equal(rows.length,1);
      assert.equal(rows[0].provider_reference,KEY);
      assert.deepEqual(rows[0].paystack_context,ctx);
      assert.equal(JSON.parse(init.body).reference,KEY);
      initializations++;
      throw new Error("Synthetic initialization response lost");
    }
    assert.equal(url.host,"db.example");
    if (path==="/rest/v1/platform_policies") return Response.json([{enabled_payment_providers:["paystack"],
      max_contribution_minor:1000000,contribution_fee_basis_points:500,
      contribution_fixed_fee_minor:1,contribution_fixed_fee_currency:"USD"}]);
    if (path==="/rest/v1/weddings") return Response.json([{id:WID,currency:"KES",slug:"fixture",wedding_date:"2099-01-01",time_zone:"Africa/Nairobi"}]);
    if (path==="/rest/v1/paystack_live_policy") return Response.json([{approved:true,settlement_mode:mode,standard_enabled:true,split_enabled:true,split_contract_ready:true,merchant_id:"123",
      credential_fingerprint:ctx.credential_fingerprint,revision:KEY,capabilities:[{market:"KE",currency:"KES"}]}]);
    if (path==="/rest/v1/paystack_destinations") return Response.json([{subaccount_code:"ACCT_fixture",
      destination_fingerprint:ctx.destination_fingerprint,credential_fingerprint:ctx.credential_fingerprint,
      revision:KEY,verified_at:"2026-11-01T00:00:00Z",consent_at:"2026-11-01T00:00:00Z"}]);
    if (path==="/rest/v1/publication_fx_snapshots") return Response.json([{published_at:new Date().toISOString(),rates:{USD:1,KES:1}}]);
    if (path==="/rest/v1/rpc/get_dj_leaderboard") return Response.json([]);
    if (path==="/rest/v1/rpc/paystack_contribution_quote") return Response.json(ctx);
    if (method!=="GET") writes.push([path,method]);
    if (path==="/rest/v1/contribution_line_items") return new Response(null,{status:201});
    assert.equal(path,"/rest/v1/contributions");
    if (method==="POST") { rows.push(JSON.parse(init.body));return new Response(null,{status:201}); }
    assert.equal(method,"GET","An uncertain admission must not be cancelled or deleted");
    return Response.json(rows);
  };
  const request={method:"POST",query:{action:"create"},headers:{origin:"https://weddingsite.example"},
    body:{weddingId:WID,purchaseAction:"song_bid",market:"KE",currency:"KES",provider:"paystack",
      idempotencyKey:KEY,visibility:"hidden",email:"fixture@example.test",songTitle:"Fixture song",
      artist:"Fixture artist",amountMinor:10005,captchaToken:"fixture"}};
  const uncertain=await call(checkout,request);
  assert.equal(uncertain.statusCode,503);
  assert.equal(uncertain.body.paymentId,rows[0].id);
  assert.equal(uncertain.body.paymentStatus,"pending");
  assert.match(uncertain.body.error,/Do not retry/);
  assert.equal((await call(checkout,request)).statusCode,409);
  assert.equal(initializations,1);
  assert.ok(writes.every(([,method])=>method==="POST"));
});
test("standard approval needs no subaccount, split eligibility or split switch; stale mode is held before HTTP", async () => {
  const ctx=standardContext();
  process.env.PAYSTACK_LIVE_SPLIT_ENABLED="false";
  let mode="standard",initializations=0;
  globalThis.fetch=async(input,init={})=>{
    const url=new URL(input);
    if (url.host==="api.paystack.co") {
      assert.equal(url.pathname,"/transaction/initialize");
      const body=JSON.parse(init.body);
      for (const field of ["split","split_code","subaccount","transaction_charge","bearer"]) assert.equal(body[field],undefined);
      initializations++;
      return Response.json({status:true,data:{authorization_url:"https://checkout.paystack.com/fixture",reference:KEY}});
    }
    if (url.pathname==="/rest/v1/platform_policies") return Response.json([{enabled_payment_providers:["paystack"]}]);
    assert.equal(url.pathname,"/rest/v1/paystack_live_policy","Standard collection never reads destination onboarding");
    return Response.json([{approved:true,standard_enabled:true,settlement_mode:mode,split_enabled:true,split_contract_ready:false,
      merchant_id:"123",credential_fingerprint:ctx.credential_fingerprint,revision:KEY,capabilities:[{market:"KE",currency:"KES"}]}]);
  };
  assert.ok(await paystackApproval("guest","KES","KE"));
  await createPaystackCheckout({id:CID,weddingId:WID,amountMinor:10005,currency:"KES",email:"fixture@example.test",
    idempotencyKey:KEY,returnUrl:"https://weddingsite.example",paystackContext:ctx});
  assert.equal(initializations,1);
  mode="split";
  assert.equal(await paystackApproval("guest","KES","KE"),null);
  await assert.rejects(validatePaystackInitialization(ctx));
  assert.equal(initializations,1);
  assert.deepEqual(verifyPaystackContext(standardTransaction(ctx),ctx),
    {couple_minor:9404,platform_minor:501,provider_fee_minor:100},"Verification follows admitted mode after toggle change");
});
test("standard independent verification rejects split, mixed mode, unknown fees and cannot use signed split fallback", async () => {
  const ctx=standardContext();
  for (const change of [tx=>{tx.domain="test";},tx=>{tx.amount++;},tx=>{tx.fees=null;},
    tx=>{tx.fees=9505;},tx=>{tx.split={id:1};},tx=>{tx.subaccount={id:456};},tx=>{tx.fees_split={paystack:100};},
    tx=>{tx.split=1;},tx=>{tx.subaccount=[];},tx=>{tx.fees_split="unknown";},tx=>{tx.integration=999;},
    tx=>{delete tx.id;},tx=>{tx.id=0;},tx=>{tx.id=Number.MAX_SAFE_INTEGER+1;},tx=>{tx.id="18446744073709551616";}]) {
    const tx=standardTransaction(ctx);change(tx);assert.throws(()=>verifyPaystackContext(tx,ctx));
  }
  assert.throws(()=>verifyPaystackContext(standardTransaction(ctx),ctx,transaction(context()).split));
  for (const mode of [undefined,"unknown"]) {
    const unknown={...ctx,settlement_mode:mode};
    assert.throws(()=>verifyPaystackContext(standardTransaction(unknown),unknown));
  }
  assert.throws(()=>paystackSplit(ctx,KEY));
  globalThis.fetch=async()=>Response.json({status:true,data:standardTransaction(ctx)});
  process.env.PAYSTACK_LIVE_COLLECTION_ENABLED="false";
  const payment=await verifyProviderPayment("paystack",KEY,CID,10005,"KES",{context:ctx});
  assert.equal(payment.verified,true);
  assert.equal(payment.allocation.couple_minor,9404);
});
test("standard signed callbacks, polls and refunds keep the admitted wallet mode without split evidence", async () => {
  const ctx=standardContext(),tx=standardTransaction(ctx),events=new Set();
  let verifiedCalls=0,adjustments=0;
  globalThis.fetch=async(input,init={})=>{
    const url=new URL(input);
    if (url.host==="api.paystack.co") {verifiedCalls++;return Response.json({status:true,data:tx});}
    if (url.pathname==="/rest/v1/contributions") return Response.json([{id:CID,provider_reference:KEY,
      pledged_amount_minor:10005,currency:"KES",paystack_context:ctx}]);
    if (url.pathname==="/rest/v1/rpc/record_provider_adjustment") {adjustments++;return Response.json(true);}
    assert.equal(url.pathname,"/rest/v1/rpc/record_verified_paystack_payment");
    const body=JSON.parse(init.body),fresh=!events.has(body.p_event_id);events.add(body.p_event_id);
    assert.equal(body.p_allocation.couple_minor,9404);return Response.json(fresh);
  };
  const hook=async event=>{
    const raw=Buffer.from(JSON.stringify(event)),req=Readable.from([raw]);
    req.method="POST";req.query={provider:"paystack"};
    req.headers={"x-paystack-signature":createHmac("sha512",env.PAYSTACK_SECRET_KEY).update(raw).digest("hex")};
    return call(webhooks,req);
  };
  assert.equal((await hook({event:"charge.success",data:tx})).body.processed,true);
  process.env.PAYSTACK_LIVE_SPLIT_ENABLED="false";
  process.env.PAYSTACK_LIVE_COLLECTION_ENABLED="false";
  assert.equal((await hook({event:"charge.success",data:tx})).body.processed,false);
  assert.equal(events.size,1);
  await hook({event:"refund.processed",data:{id:99,transaction:tx,amount:100,currency:"KES",
    refunded_at:"2026-11-01T10:00:00Z",created_at:"2026-11-01T10:00:00Z"}});
  assert.equal(adjustments,1);
  assert.equal(verifiedCalls,3);
});
test("unavailable Paystack approval holds only Paystack and preserves live Daraja options", async () => {
  context();
  const daraja = {
    DARAJA_ENVIRONMENT:"production",DARAJA_CONSUMER_KEY:`fixture-isolation-${Math.random()}`,
    DARAJA_CONSUMER_SECRET:"fixture",DARAJA_SHORTCODE:"123456",DARAJA_PASSKEY:"fixture",
    DARAJA_LIVE_COLLECTION_ENABLED:"true",DARAJA_LIVE_SHORTCODE_CONFIRMED:"123456"
  };
  const previous = Object.fromEntries(Object.keys(daraja).map(key=>[key,process.env[key]]));
  Object.assign(process.env,daraja);
  try {
    globalThis.fetch=async input=>{
      const url=new URL(input);
      if (url.host==="api.safaricom.co.ke" && url.pathname.startsWith("/oauth/")) {
        return Response.json({access_token:"fixture",expires_in:3600});
      }
      assert.equal(url.host,"db.example");
      if (url.pathname==="/rest/v1/weddings") return Response.json([{id:WID,currency:"KES"}]);
      if (url.pathname==="/rest/v1/platform_policies") return Response.json([{enabled_payment_providers:["paystack","daraja"]}]);
      if (url.pathname==="/rest/v1/daraja_live_approval") return Response.json([{approved:true,shortcode:"123456"}]);
      assert.equal(url.pathname,"/rest/v1/paystack_live_policy");
      return Response.json({message:"Synthetic approval unavailable"},{status:503});
    };
    const result=await call(checkout,{method:"GET",headers:{},query:{action:"options",weddingId:WID,currency:"KES"}});
    assert.equal(result.statusCode,200);
    assert.equal(result.body.paymentAvailable,true);
    assert.deepEqual(result.body.providers.map(item=>item.id),["daraja"]);
    assert.equal(result.body.providerHolds[0].provider,"paystack");
    const readiness=await paystackReadiness();
    assert.equal(readiness.approvalUnavailable,true);
    assert.equal(readiness.newCollection,"held");
  } finally {
    for (const [key,value] of Object.entries(previous)) {
      if (value===undefined) delete process.env[key]; else process.env[key]=value;
    }
  }
});
test("Admin and SuperAdmin cannot change Paystack Owner policy or destination", async () => {
  context();
  for (const role of ["admin","superadmin"]) {
    let providerCalls=0;
    globalThis.fetch=async(input)=>{
      const url=new URL(input);
      if (url.host==="api.paystack.co") {providerCalls++;throw new Error("Unauthorized provider call");}
      if (url.pathname==="/auth/v1/user") return Response.json({id:CID});
      if (url.pathname==="/rest/v1/profiles") return Response.json([{id:CID,platform_role:role}]);
      throw new Error(`Unexpected ${url.pathname}`);
    };
    for (const action of ["paystack-policy","paystack-settlement-mode","paystack-destination","paystack-publication-resolution"]) {
      const result=await call(admin,{method:"POST",query:{action},headers:{authorization:"Bearer fixture-user"},body:{}});
      assert.equal(result.statusCode,403);
    }
    assert.equal(providerCalls,0);
  }
});
test("Owner mode API requires revision and confirmation, rejects unverified split and preserves provider switches", async () => {
  const ctx=standardContext();
  let writes=0;
  globalThis.fetch=async(input,init={})=>{
    const url=new URL(input);
    assert.equal(url.host,"db.example","Owner mode change never contacts the provider");
    if (url.pathname==="/auth/v1/user") return Response.json({id:CID});
    if (url.pathname==="/rest/v1/profiles") return Response.json([{id:CID,platform_role:"owner"}]);
    if (url.pathname==="/rest/v1/platform_policies") return Response.json([{enabled_payment_providers:["daraja"]}]);
    if (url.pathname==="/rest/v1/paystack_live_policy") return Response.json([{approved:true,standard_enabled:true,
      settlement_mode:"standard",revision:KEY,merchant_id:"123",credential_fingerprint:ctx.credential_fingerprint,
      split_enabled:true,split_contract_ready:false,capabilities:[{market:"KE",currency:"KES"}]}]);
    assert.equal(url.pathname,"/rest/v1/rpc/owner_set_paystack_settlement_mode");
    assert.deepEqual(JSON.parse(init.body),{p_mode:"standard",p_revision:KEY,p_confirmed:true});
    writes++;return Response.json(true);
  };
  const request={method:"POST",query:{action:"paystack-settlement-mode"},headers:{authorization:"Bearer fixture"}};
  for (const body of [{mode:"standard",confirmed:true},{mode:"standard",policyRevision:KEY},
    {mode:"unknown",policyRevision:KEY,confirmed:true}]) assert.equal((await call(admin,{...request,body})).statusCode,400);
  const rejected=await call(admin,{...request,body:{mode:"split",policyRevision:KEY,confirmed:true}});
  assert.equal(rejected.statusCode,409);assert.match(rejected.body.error,/unverified/);assert.equal(writes,0);
  const saved=await call(admin,{...request,body:{mode:"standard",policyRevision:KEY,confirmed:true}});
  assert.equal(saved.statusCode,200);assert.equal(writes,1);
  assert.equal(saved.body.paystack.newCollection,"held","Owner mode cannot bypass the provider allowlist");
  assert.match(saved.body.paystack.reason,/Leadership/);
});
test("settlement statement reconciliation validates destination totals and never initiates a payout", async () => {
  const ctx=context(),tx=transaction(ctx);
  let total=9404, recorded=0;
  globalThis.fetch=async(input,init={})=>{
    const url=new URL(input);
    if (url.host==="api.paystack.co") {
      assert.equal(init.method,undefined);
      if (url.pathname==="/settlement") return Response.json({status:true,meta:{pageCount:1},data:[
        {id:99,domain:"live",integration:123,currency:"KES",status:"success",total_amount:total,effective_amount:total,deductions:null}
      ]});
      assert.equal(url.pathname,"/settlement/99/transactions");
      return Response.json({status:true,meta:{pageCount:1},data:[tx]});
    }
    if (url.pathname==="/rest/v1/contributions") return Response.json([{id:CID,payment_status:"paid",paystack_context:ctx,provider_reference:KEY}]);
    if (url.pathname==="/rest/v1/paystack_payment_evidence") return Response.json([{couple_minor:9404}]);
    assert.equal(url.pathname,"/rest/v1/rpc/record_paystack_settlement");recorded++;return Response.json(true);
  };
  await reconcilePaystackSettlement(CID,"99",CID);assert.equal(recorded,1);
  total++;
  await assert.rejects(reconcilePaystackSettlement(CID,"99",CID));assert.equal(recorded,1);
  total=9404;
  const documentedSplit=tx.split;
  for (const split of [{}, {shares:{}}, {shares:{subaccounts:[{amount:9404}]}}]) {
    tx.split=split;
    tx.subaccount={};
    tx.fees_split=null;
    await assert.rejects(reconcilePaystackSettlement(CID,"99",CID), /per-destination allocations/);
    assert.equal(recorded,1,"Unknown or empty statement evidence must not record a settled result");
  }
  tx.split=documentedSplit;
});
test("finance CSV preserves direct allocation and zero-withdrawal columns across mixed record types", async () => {
  context();
  globalThis.fetch=async input=>{
    const url=new URL(input);
    assert.equal(url.host,"db.example");
    if (url.pathname==="/auth/v1/user") return Response.json({id:CID});
    if (url.pathname==="/rest/v1/contributions") return Response.json([{id:CID,currency:"KES",settlement_route:"paystack_direct"}]);
    if (url.pathname==="/rest/v1/rpc/paystack_finance_summary") return Response.json([{id:CID,currency:"KES",
      couple_minor:9404,platform_minor:501,provider_fee_minor:100,withdrawable_minor:0,provider_settled:false}]);
    if (url.pathname==="/rest/v1/rpc/get_wedding_financial_adjustments") return Response.json({adjustments:[],ledger:[]});
    return Response.json([]);
  };
  const res={setHeader(){return this;},status(code){this.statusCode=code;return this;},end(value){this.body=value;}};
  await finance({method:"GET",query:{action:"report",weddingId:WID,format:"csv"},
    headers:{authorization:"Bearer fixture"}},res);
  assert.equal(res.statusCode,200);
  const [header,,direct]=res.body.split("\r\n").map(row=>row.split(",").map(cell=>JSON.parse(cell)));
  for (const [column,expected] of Object.entries({record_type:"paystack_direct_settlement",
    couple_minor:"9404",platform_minor:"501",provider_fee_minor:"100",withdrawable_minor:"0",provider_settled:"false"})) {
    assert.equal(direct[header.indexOf(column)],expected,`CSV retains ${column}`);
  }
  assert.ok(!res.body.includes("ACCT_"));
});
