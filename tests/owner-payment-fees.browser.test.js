import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
test("Owner fee selector is readable/private, actual-zero is explicit and ambiguous retry keeps exact evidence", { timeout: 90000 }, async () => {
  const server = http.createServer(async (req,res) => {
    const path = new URL(req.url,"http://localhost").pathname;
    if (path === "/") return res.writeHead(200,{"Content-Type":"text/html"}).end('<main id="fees"></main>');
    if (!["/simple-payouts.js","/manual-payout-setup.js"].includes(path)) return res.writeHead(404).end();
    res.writeHead(200,{"Content-Type":"text/javascript"}).end(await readFile(new URL(`..${path}`,import.meta.url)));
  });
  let browser;
  try {
    await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
    try { browser=await chromium.launch({channel:"msedge"}); } catch { browser=await chromium.launch(); }
    const page=await browser.newPage({viewport:{width:390,height:844}});
    const id="550e8400-e29b-41d4-a716-446655440000", calls=[];
    let completed=false;
    await page.route("**/api/**",route=>{
      const action=new URL(route.request().url()).searchParams.get("action");
      if(action==="manual-payout-fees") return route.fulfill({json:{notice:"Owner statement attestation, not provider API verification.",
        pending:completed?[]:[{id,internal_reference:"WS-550e8400e2",paid_at:"2026-11-04T07:33:46Z",paid_amount_minor:500,
          net_paid_minor:456,currency:"KES",funds_available_at:"2026-11-07T07:33:46Z"}],
        history:completed?[{internal_reference:"WS-550e8400e2",fee_minor:0,source_kind:"statement",source_reference:"STMT-TEST1",recorded_at:"2026-11-04T08:00:00Z"}]:[]}});
      if(action==="manual-payout-fee-attestation"){
        calls.push(route.request().postDataJSON());
        if(calls.length===1)return route.fulfill({status:503,json:{error:"Ambiguous fee save: retry unchanged."}});
        completed=true;return route.fulfill({json:{result:id}});
      }
      throw new Error("Unexpected fee browser action");
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(async()=>{
      const m=await import("/simple-payouts.js");
      await m.mountPaymentFees(document.querySelector("main"),{api:(u,o)=>fetch(u,o),money:(n,c)=>`${c} ${(n/100).toFixed(2)}`,
        esc:v=>String(v).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll('"',"&quot;")});
    });
    const text=await page.locator("main").innerText();
    assert.ok(!text.includes(id));assert.ok(!text.includes("254700000001"));assert.match(text,/KES 5.00/);assert.match(text,/WS-550e8400e2/);
    await page.locator('[name="contribution"]').selectOption(id);
    assert.match(await page.locator("[data-fee-payment-detail]").innerText(),/KES 4.56.*Stored time-release date/);
    await page.locator('[name="fee"]').fill("0");
    await page.locator('[name="reference"]').fill("STMT-TEST1");
    await page.locator('[name="confirmed"]').check();
    await page.getByRole("button",{name:"Record actual fee",exact:true}).click();
    await page.locator("[data-fee-result]").filter({hasText:"Confirm actual zero"}).waitFor();
    assert.equal(calls.length,0);
    await page.locator('[name="actual_zero"]').check();
    await page.getByRole("button",{name:"Record actual fee",exact:true}).click();
    await page.locator("[data-fee-result]").filter({hasText:"Ambiguous"}).waitFor();
    await page.getByRole("button",{name:"Record actual fee",exact:true}).click();
    await page.locator("[data-fee-result]").filter({hasText:"Actual fee recorded"}).waitFor();
    assert.deepEqual(calls[0],calls[1]);assert.equal(calls[1].fee,0);assert.equal(calls[1].actual_zero,true);
    await page.getByText("Immutable fee attestation history",{exact:true}).click();
    assert.match(await page.locator("main").innerText(),/operator-reconciled, not provider API-verified/);
    assert.equal(await page.getByRole("button",{name:"Record actual fee",exact:true}).isDisabled(),true);
  } finally { await browser?.close();await new Promise(resolve=>server.close(resolve)); }
});
