import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { chromium } from "playwright";

test("live Paystack guest, publication and onboarding UI use honest live labels and retain unresolved payments", async () => {
  const wid="550e8400-e29b-41d4-a716-446655440000", pid="550e8400-e29b-41d4-a716-446655440001";
  const server=http.createServer(async(req,res)=>{
    try {
      const path=new URL(req.url,"http://localhost").pathname;
      if (path==="/publication-fixture.html") return res.writeHead(200,{"Content-Type":"text/html"}).end(
        '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><button id="pay-fee-btn">Review publication fee</button><script src="/publication-checkout.js"></script>');
      if (path==="/onboarding-fixture.html") {
        const source=await readFile(new URL("../wedding.html",import.meta.url),"utf8");
        const markup=source.match(/<section id="paystack-onboarding"[\s\S]*?<\/section>/)[0];
        return res.writeHead(200,{"Content-Type":"text/html"}).end(
          `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">${markup}<script src="/paystack-onboarding.js"></script>`);
      }
      if (path.includes("..")) throw new Error("Invalid fixture path");
      const data=await readFile(new URL(`..${path}`,import.meta.url));
      res.writeHead(200,{"Content-Type":({".html":"text/html",".js":"text/javascript",".css":"text/css"})[extname(path)]||"application/octet-stream"}).end(data);
    } catch {res.writeHead(404).end();}
  });
  let browser;
  try {
    await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
    try {browser=await chromium.launch({channel:"msedge"});} catch {browser=await chromium.launch();}
    const base=`http://127.0.0.1:${server.address().port}`;
    const page=await browser.newPage({viewport:{width:375,height:900}});
    await page.route("https://**",route=>route.fulfill({body:""}));
    await page.route("https://challenges.cloudflare.com/**",route=>route.fulfill({contentType:"text/javascript",
      body:"window.turnstile={render(el,opts){opts.callback('fixture-human');return 1},reset(){}}"}));
    const creates=[];
    await page.route("**/api/guest**",route=>{
      const action=new URL(route.request().url()).searchParams.get("action");
      return route.fulfill({contentType:"application/json",body:JSON.stringify(action==="site" ? {wedding:{
        id:wid,slug:"split-fixture",couple_names:"Fixture Couple",wedding_date:"2099-01-01",currency:"KES",published_at:"2026-01-01",palette:["#244b3a"]
      }} : action==="leaderboard" ? {bids:[]} : {})});
    });
    await page.route("**/api/checkout**",route=>{
      const action=new URL(route.request().url()).searchParams.get("action");
      const data=action==="options" ? {mode:"live",paymentAvailable:true,turnstileSiteKey:"fixture",
        providers:[{id:"paystack",market:"KE",label:"Card",settlementMode:"standard"},{id:"daraja",market:"KE",label:"M-Pesa"}]}
        : action==="status" ? {paymentStatus:"pending",actionStatus:"pending",provider:"paystack",action:"song_bid"}
          : {error:"Initialization uncertain. Do not retry.",paymentId:pid,paymentStatus:"pending"};
      if (action==="create") creates.push(route.request().postDataJSON());
      return route.fulfill({status:action==="create" ? 503 : 200,contentType:"application/json",body:JSON.stringify(data)});
    });
    await page.goto(`${base}/guest.html?slug=split-fixture`);
    await page.locator("#song-request-form").waitFor({state:"visible"});
    await page.fill("#song-request-title","Synthetic Song");
    await page.fill("#song-request-artist","Synthetic Artist");
    await page.fill("#song-request-amount","1.01");
    await page.click('#song-request-form button[type="submit"]');
    await page.waitForFunction(()=>!document.getElementById("pay-submit").disabled);
    assert.match(await page.locator("#pay-submit").innerText(),/real money/i);
    assert.match(await page.locator("#pay-mode-note").innerText(),/LIVE/);
    await page.selectOption("#pay-provider","daraja|KE");
    assert.ok(await page.locator("#pay-mode-note").isHidden(),"Daraja keeps the incident patch's uncluttered live dialog");
    assert.ok(await page.locator("#pay-daraja-note").isHidden());
    assert.equal(await page.locator("#pay-submit").textContent(),"Send M-Pesa prompt");
    await page.selectOption("#pay-provider","paystack|KE");
    assert.ok(await page.locator("#pay-daraja-fields").isHidden());
    assert.ok(await page.locator("#pay-email").evaluate(el=>el.required));
    await page.fill("#pay-name","Synthetic Guest");
    await page.fill("#pay-email","fixture@example.test");
    await page.click("#pay-submit");
    await page.waitForFunction(()=>document.getElementById("pay-error").textContent.includes("Do not start another payment"));
    assert.equal(creates.length,1);assert.equal(creates[0].amountMinor,101);
    await page.evaluate(()=>document.getElementById("pay-form").requestSubmit());
    await page.waitForTimeout(100);
    assert.equal(creates.length,1);
    assert.ok(await page.evaluate(id=>sessionStorage.getItem(`ws-payment:${id}`)!==null,pid));
    await page.close();

    const onboarding=await browser.newPage({viewport:{width:320,height:800}});
    await onboarding.route("https://**",route=>route.abort());
    await onboarding.addInitScript(({pid})=>{
      window.onboarded=true;window.consented=false;window.consentWrites=0;window.settlementMode="split";
      window.WS={money:(n,c)=>`${c} ${(Number(n)/100).toFixed(2)}`,api:async(url,init)=>{
        if (url.includes("paystack-consent")) {
          const body=JSON.parse(init.body);
          if (body.revision!==pid || body.confirmed!==true) throw new Error("Missing revision consent");
          window.consented=true;window.consentWrites++;
        }
        return Response.json({onboarding:{settlementMode:window.settlementMode,verified:window.onboarded,kycComplete:true,consented:window.consented,revision:pid},
          settlements:[{payment_status:"paid",currency:"KES",couple_minor:9404,platform_minor:501,provider_fee_minor:100,provider_settled:false}]});
      }};
    },{pid});
    await onboarding.goto(`${base}/onboarding-fixture.html?id=${wid}`);
    await onboarding.waitForFunction(()=>!document.getElementById("paystack-destination-consent").disabled);
    assert.ok(await onboarding.locator("#paystack-consent-submit").isDisabled());
    assert.match(await onboarding.locator("#paystack-settlement-rows").innerText(),/Withdrawable here: zero/);
    assert.doesNotMatch(await onboarding.locator("#paystack-settlement-rows").innerText(),/Provider settlement verified/);
    await onboarding.locator("#paystack-destination-consent").check();
    await onboarding.click("#paystack-consent-submit");
    await onboarding.waitForFunction(()=>window.consentWrites===1 && document.getElementById("paystack-destination-consent").disabled);
    await onboarding.evaluate(()=>{window.onboarded=false;window.consented=false;});
    await onboarding.click("#paystack-onboarding-reload");
    await onboarding.waitForFunction(()=>document.getElementById("paystack-onboarding-status").textContent.startsWith("Not onboarded"));
    assert.ok(await onboarding.locator("#paystack-consent-submit").isDisabled());
    await onboarding.evaluate(()=>{window.settlementMode="standard";});
    await onboarding.click("#paystack-onboarding-reload");
    await onboarding.waitForFunction(()=>document.getElementById("paystack-onboarding-status").textContent.startsWith("Standard platform-collected"));
    assert.ok(await onboarding.locator("#paystack-destination-consent").isDisabled());
    assert.match(await onboarding.locator("#paystack-onboarding-status").innerText(),/No split subaccount/i);
    await onboarding.close();

    const publication=await browser.newPage({viewport:{width:375,height:900}});
    await publication.route("https://**",route=>route.abort());
    await publication.addInitScript(({pid})=>{
      window.created=0;window.publicationVerified=0;
      document.addEventListener("ws:publication-verified",()=>window.publicationVerified++);
      window.turnstile={render(el,opts){opts.callback("fixture-human");return 1},remove(){}};
      window.WS={money:(n,c)=>`${c} ${(n/100).toFixed(2)}`,api:async(url,init)=>{
        let data;
        if (url.includes("publication-options")) data={testMode:false,quote:{fee_minor:10005,currency:"KES",usd_amount_minor:77},
          methods:[{id:"card",label:"Card"}],turnstileSiteKey:"fixture"};
        else {
          if (url.includes("publication-create")) {
            const body=JSON.parse(init.body);
            if (body.expectedAmountMinor!==10005 || body.captchaToken!=="fixture-human") throw new Error("Quote/challenge changed");
            window.created++;
          }
          data={checkout:{id:pid,status:"pending",amountMinor:10005,currency:"KES",testMode:false}};
        }
        return Response.json(data);
      }};
    },{pid});
    await publication.goto(`${base}/publication-fixture.html?id=${wid}`);
    await publication.click("#pay-fee-btn");
    await publication.waitForFunction(()=>!document.getElementById("publication-submit").disabled);
    assert.match(await publication.locator("#publication-title").innerText(),/live payment/);
    assert.match(await publication.locator("#publication-submit").innerText(),/real money/);
    await publication.fill("#publication-email","fixture@example.test");
    await publication.click("#publication-submit");
    await publication.waitForFunction(()=>window.created===1);
    assert.ok(await publication.locator("#publication-submit").isDisabled());
    assert.equal(await publication.evaluate(()=>window.publicationVerified),0,"redirect/initiation cannot authorize publication");
    await publication.close();
  } finally {
    await browser?.close();
    await new Promise(resolve=>server.close(resolve));
  }
});
