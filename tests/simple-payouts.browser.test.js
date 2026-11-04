import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

  test("customer quote shows receive/fee/debit, rejects stale consent, drains remainder and never adds a fee at Processing", { timeout:90000 }, async()=>{
    const server=http.createServer(async(req,res)=>{
      const path=new URL(req.url,"http://localhost").pathname;
      if(path==="/")return res.writeHead(200,{"Content-Type":"text/html"}).end('<main id="payouts"></main>');
      if(!["/simple-payouts.js","/manual-payout-setup.js"].includes(path))return res.writeHead(404).end();
      res.writeHead(200,{"Content-Type":"text/javascript"}).end(await readFile(new URL(`..${path}`,import.meta.url)));
    });
    let browser;
    try{
      await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
      try{browser=await chromium.launch({channel:"msedge"});}catch{browser=await chromium.launch();}
      const page=await browser.newPage({viewport:{width:390,height:844}});
      const id="550e8400-e29b-41d4-a716-446655440000",requests=[],actions=[];
      let fee=100,revision=0,row=null;
      const status=()=>({currency:"KES",available_minor:row?0:1000,supported:true,kyc_complete:true,min_payout_minor:1000,max_payout_minor:10000,
        provider_costs_company_overhead:true,withdrawal_processing_fee_minor:fee,policy_revision:revision,
        recipients:[{slot:1,label:"Partner 1 phone ending 0001"}],requests:row?[row]:[]});
      await page.route("**/api/**",route=>{
        const action=new URL(route.request().url()).searchParams.get("action");
        if(action==="simple-payout-status")return route.fulfill({json:status()});
        if(action==="simple-payout-request"){
          const body=route.request().postDataJSON();requests.push(body);
          if(requests.length===1){fee=200;revision=1;return route.fulfill({status:409,json:{error:"Withdrawal quote changed. Refresh and explicitly reconfirm amount, processing fee and total debit."}});}
          row={id,amount_minor:body.amountMinor,currency:"KES",partner_slot:1,processing_fee_minor:body.processingFeeMinor,minimum_exception:true,
            requested_at:"2026-11-04",status:"requested",history:[]};
          return route.fulfill({json:{payoutId:id,recorded:true}});
        }
        if(action==="manual-payout-simple")return route.fulfill({json:{actor_id:id,notice:"Operator reporting only",
          weddings:[{id,label:"Fixture wedding",payouts:status()}]}});
        if(action==="manual-payout-simple-action"){
          const body=route.request().postDataJSON();actions.push(body);
          row={...row,status:body.action,claimed_at:"2026-11-04",sender_id:id};
          return route.fulfill({json:{result:{state:body.action}}});
        }
        throw new Error("Unexpected quoted withdrawal action");
      });
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      const mount=mode=>page.evaluate(async({mode,id})=>{
        const m=await import("/simple-payouts.js"),helpers={api:(u,o)=>fetch(u,o),money:(n,c)=>`${c} ${(n/100).toFixed(2)}`,
          esc:v=>String(v).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll('"',"&quot;")};
        if(mode==="couple")await m.mountCouple(document.querySelector("main"),{...helpers,weddingId:id});
        else await m.mountAdmin(document.querySelector("main"),{...helpers,role:"owner"});
      },{mode,id});
      await mount("couple");
      await page.locator('[name="amount"]').fill("8.99");await page.locator('[name="partner"]').selectOption("1");
      await page.locator('[name="confirmed"]').check();await page.getByRole("button",{name:"Request payout",exact:true}).click();
      await page.locator("[data-simple-result]").filter({hasText:"below-minimum"}).waitFor();
      assert.equal(requests.length,0);
      await page.getByRole("button",{name:"Use full remaining balance after processing fee",exact:true}).click();
      assert.equal(await page.locator('[name="amount"]').inputValue(),"9.00");
      assert.match(await page.locator("[data-withdrawal-quote]").innerText(),/KES 9.00.*KES 1.00.*KES 10.00/);
      await page.locator('[name="confirmed"]').check();await page.getByRole("button",{name:"Request payout",exact:true}).click();
      await page.locator("[data-simple-result]").filter({hasText:"quote changed"}).waitFor();
      assert.equal(requests[0].processingFeeMinor,100);assert.equal(requests[0].policyRevision,0);
      assert.equal(await page.locator('[name="confirmed"]').isChecked(),false);
      await page.getByRole("button",{name:"Refresh balance (keep form)",exact:true}).click();
      await page.locator("[data-simple-result]").filter({hasText:"Balance refreshed"}).waitFor();
      assert.equal(await page.locator('[name="amount"]').inputValue(),"9.00");
      await page.getByRole("button",{name:"Use full remaining balance after processing fee",exact:true}).click();
      assert.equal(await page.locator('[name="amount"]').inputValue(),"8.00");
      await page.locator('[name="confirmed"]').check();await page.getByRole("button",{name:"Request payout",exact:true}).click();
      await page.locator("[data-simple-result]").filter({hasText:"Payout requested"}).waitFor();
      assert.equal(requests[1].processingFeeMinor,200);assert.equal(requests[1].amountMinor,800);
      await mount("admin");
      assert.equal(await page.locator('[name="reference"]').count(),0);
      await page.getByRole("button",{name:"Processing",exact:true}).click();
      assert.equal(await page.locator('[name="fee"]').count(),0,"New contract never asks for a provider fee or adds a customer fee at Processing");
      await page.locator('[name="solo"]').check();await page.locator('[name="recipient"]').check();await page.locator('[name="confirmed"]').check();
      await page.getByRole("button",{name:"Confirm processing",exact:true}).click();
      await page.locator('[name="reference"]').waitFor();assert.equal(actions[0].fee,null);
      await page.reload();await mount("admin");await page.locator('[name="reference"]').waitFor();
      assert.match(await page.locator("main").innerText(),/customer processing fee KES 2.00.*total debit KES 10.00/);
    }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
  });

test("simple mobile couple retry and operator Processing reveals transaction ID only after success and after reload", { timeout: 90000 }, async () => {
  const server = http.createServer(async (req, res) => {
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      if (path === "/") return res.writeHead(200, { "Content-Type": "text/html" }).end('<main id="payouts"></main>');
      if (!["/simple-payouts.js", "/manual-payout-setup.js"].includes(path)) return res.writeHead(404).end();
      res.writeHead(200, { "Content-Type": "text/javascript" }).end(await readFile(new URL(`..${path}`, import.meta.url)));
    } catch { res.writeHead(404).end(); }
  });
  let browser;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    try { browser = await chromium.launch({ channel: "msedge" }); } catch { browser = await chromium.launch(); }
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    let rows = [], state = "requested", failRequest = true, failProcessing = true, deficit = false, balance = 10000;
    const breakdown = { fee_pending_minor: 456, time_held_minor: 456, obligations_minor: 100, payout_committed_minor: 1000,
      next_time_release_at: "2026-11-07T07:33:46Z", configured_hold_days: 0, min_payout_minor: 1000 };
    const requests = [], actions = [];
    const id = "550e8400-e29b-41d4-a716-446655440000";
    const row = () => ({ id, amount_minor: 1234, currency: "KES", partner_slot: 1, status: state,
      requested_at: "2026-01-01", claimed_at: state==="processing" || state==="paid" ? "2026-01-02" : null,
      transaction_reference: state==="paid" ? "REAL-TEST-REFERENCE" : null, history: [] });
    await page.route("**/api/**", route => {
      const action = new URL(route.request().url()).searchParams.get("action");
      if (action === "simple-payout-status") return route.fulfill({ json: { ...breakdown, currency: "KES", available_minor: balance,
        deficit_recorded: deficit, supported: true, kyc_complete: true, recipients: [{ slot: 1, label: "Partner 1 phone ending 0001" }], requests: rows } });
      if (action === "simple-payout-request") {
        requests.push(route.request().postDataJSON());
        if (failRequest) { failRequest = false; return route.fulfill({ status: 503, json: { error: "Synthetic ambiguous request" } }); }
        rows = [row()]; return route.fulfill({ json: { payoutId: id, recorded: true } });
      }
      if (action === "manual-payout-simple") return route.fulfill({ json: { notice: "Operator reporting only",
        weddings: [{ id, label: "Fixture wedding", payouts: { ...breakdown, currency: "KES", deficit_recorded: deficit, deficit_minor: deficit ? 100 : 0, available_minor: balance, requests: [row()] } }] } });
      if (action === "manual-payout-simple-action") {
        const body = route.request().postDataJSON(); actions.push(body);
        if (failProcessing) { failProcessing = false; return route.fulfill({ status: 409, json: { error: "Synthetic claim rejected" } }); }
        state = body.action; return route.fulfill({ json: { result: { state } } });
      }
      throw new Error("Unexpected action");
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const mount = async mode => page.evaluate(async ({ mode, id }) => {
      const m = await import("/simple-payouts.js");
      const helpers = { api: (url, opts) => fetch(url, opts), money: (n,c) => `${c} ${(n/100).toFixed(2)}`,
        esc: value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;") };
      if (mode === "couple") await m.mountCouple(document.querySelector("main"), { ...helpers, weddingId: id });
      else await m.mountAdmin(document.querySelector("main"), { ...helpers, role: "owner" });
    }, { mode, id });
    await mount("couple");
    await page.locator('[name="amount"]').fill("12.34"); await page.locator('[name="partner"]').selectOption("1");
    balance = 9876;
    await page.getByRole("button", { name: "Refresh balance (keep form)", exact: true }).click();
    await page.locator("[data-simple-result]").filter({ hasText: "Balance refreshed" }).waitFor();
    assert.equal(await page.locator('[name="amount"]').inputValue(), "12.34");
    assert.equal(await page.locator('[name="partner"]').inputValue(), "1");
    assert.match(await page.locator("[data-simple-balance]").innerText(), /98.76/);
    assert.match(await page.locator("[data-simple-balance-detail]").innerText(), /Awaiting actual payment fees: KES 4.56/);
    assert.match(await page.locator("[data-simple-balance-detail]").innerText(), /0 day\(s\)/);
    await page.locator('[name="confirmed"]').check(); await page.getByRole("button", { name: "Request payout", exact: true }).click();
    await page.locator("[data-simple-result]").filter({ hasText: "ambiguous" }).waitFor();
    assert.equal(await page.locator('[name="amount"]').getAttribute("readonly"), "");
    await page.reload(); await mount("couple");
    assert.equal(await page.locator('[name="amount"]').inputValue(), "12.34");
    await page.locator('[name="confirmed"]').check(); await page.getByRole("button", { name: "Request payout", exact: true }).click();
    await page.locator("[data-simple-result]").filter({ hasText: "Payout requested" }).waitFor();
    assert.deepEqual(requests[0], requests[1]);
    assert.equal(requests[0].amountMinor, 1234);
    await mount("admin");
    assert.equal(await page.locator('[name="reference"]').count(), 0);
    await page.getByRole("button", { name: "Processing", exact: true }).click();
    await page.locator('[name="fee"]').fill("1.00"); await page.locator('[name="solo"]').check();
    await page.locator('[name="recipient"]').check(); await page.locator('[name="confirmed"]').check();
    await page.getByRole("button", { name: "Confirm processing", exact: true }).click();
    await page.locator("[data-action-result]").filter({ hasText: "rejected" }).waitFor();
    assert.equal(await page.locator('[name="reference"]').count(), 0, "Failed Processing never exposes Paid input");
    await page.getByRole("button", { name: "Confirm processing", exact: true }).click();
    await page.locator('[name="reference"]').waitFor();
    assert.deepEqual(actions[0], actions[1]); assert.equal(actions[1].fee, 100);
    await page.reload(); await mount("admin");
    await page.locator('[name="reference"]').waitFor();
    assert.equal(await page.locator('[name="reference"]').isVisible(), true);
    await page.locator('[name="reference"]').fill("REAL-TEST-REFERENCE");
    await page.locator('[name="confirmed"]').check();
    balance = 8765;
    await page.getByRole("button", { name: "Refresh balances (keep transaction form)", exact: true }).click();
    await page.locator("[data-simple-result]").filter({ hasText: "Balances refreshed" }).waitFor();
    assert.equal(await page.locator('[name="reference"]').inputValue(), "REAL-TEST-REFERENCE");
    assert.equal(await page.locator('[name="confirmed"]').isChecked(), true);
    assert.match(await page.locator("[data-balance-amount]").innerText(), /87.65/);
    assert.equal(actions.length, 2, "Read-only refresh never submits Paid");
    await page.locator('[name="confirmed"]').uncheck();
    await page.getByRole("button", { name: "Confirm Paid — operator-reported", exact: true }).click();
    assert.equal(actions.length, 2, "Paid needs explicit confirmation");
    await page.locator('[name="confirmed"]').check();
    await page.getByRole("button", { name: "Confirm Paid — operator-reported", exact: true }).click();
    await page.getByRole("heading", { name: /Paid — operator-reported/ }).waitFor();
    assert.equal(actions.at(-1).reference, "REAL-TEST-REFERENCE");
    assert.equal(await page.locator('[name="reference"]').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    deficit = true;
    await mount("admin");
    await page.getByRole("alert").filter({ hasText: "Adjustment deficit recorded" }).waitFor();
    assert.equal(await page.locator('[name="reference"]').count(), 0, "Deficit must not rewrite a terminal Paid record");
    await mount("couple");
    await page.getByRole("alert").filter({ hasText: "recorded payout-funding deficit" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Request payout", exact: true }).isDisabled(), true);
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
});
