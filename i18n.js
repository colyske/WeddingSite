/* English / Swahili toggle for the guest site's fixed interface text.
   Couple-written content (story, venues, FAQ, wishes) is never translated. */
(function () {
  const SW = {
    "Story": "Hadithi", "Details": "Maelezo", "RSVP": "Thibitisha", "DJ Bids": "Nyimbo za DJ", "Contributions": "Michango", "Sponsors": "Wadhamini",
    "With full hearts, we invite you": "Kwa mioyo yote, tunakukaribisha",
    "Two stories. One beautiful beginning.": "Hadithi mbili. Mwanzo mmoja mzuri.",
    "Celebrate with us ↗ Add to calendar": "Sherehekea nasi ↗ Weka kwenye kalenda",
    "The countdown is on": "Hesabu imeanza", "Until we say “I do”": "Hadi tuseme “Ndiyo”",
    "Days": "Siku", "Hours": "Saa", "Minutes": "Dakika", "Seconds": "Sekunde",
    "Programme & venues": "Ratiba na kumbi", "Dress code": "Mavazi",
    "Will You Join Us?": "Utajiunga nasi?",
    "Your name *": "Jina lako *", "Email *": "Barua pepe *", "Phone (optional)": "Simu (si lazima)",
    "Shared only with the couple, to coordinate your attendance.": "Inashirikiwa na wanandoa tu, kuratibu mahudhurio yako.",
    "Will you attend? *": "Utahudhuria? *", "Choose…": "Chagua…", "Yes, I'll be there!": "Ndiyo, nitakuwepo!", "No, unfortunately not": "Hapana, samahani",
    "Plus-ones (if allowed)": "Wageni unaoambatana nao (kama inaruhusiwa)",
    "Names of the people coming with you": "Majina ya watakaokuja nawe",
    "Group RSVP: one form covers your whole party. Shared only with the couple.": "RSVP ya kikundi: fomu moja inatosha kwa kikundi chako. Inashirikiwa na wanandoa tu.",
    "Dietary preference": "Mahitaji ya chakula", "None / No restriction": "Hakuna kizuizi", "Vegetarian": "Mboga tu", "Vegan": "Bila bidhaa za wanyama", "Gluten-free": "Bila gluteni", "Halal": "Halali", "Nut-free": "Bila karanga", "Other (see notes)": "Nyingine (angalia maelezo)",
    "Dietary notes (optional)": "Maelezo ya chakula (si lazima)",
    "We'd love to accommodate your preferences!": "Tungependa kuzingatia mahitaji yako!",
    "Submit RSVP": "Tuma RSVP",
    "Already RSVP'd? Find your pass": "Umeshathibitisha? Tafuta pasi yako",
    "Email, phone number or pass code you used": "Barua pepe, namba ya simu au msimbo wa pasi uliotumia",
    "Find my pass": "Tafuta pasi yangu",
    "DJ Song Requests": "Maombi ya Nyimbo za DJ",
    "Have a song that should be on the dance floor? Make a bid and help us build the perfect playlist.": "Una wimbo unaostahili kuchezwa? Weka zabuni utusaidie kujenga orodha bora.",
    "Song title *": "Jina la wimbo *", "Artist *": "Msanii *", "Place Bid": "Weka Zabuni",
    "Top Song Requests": "Nyimbo Zinazoongoza", "Song": "Wimbo", "Artist": "Msanii", "Total Bids": "Jumla ya Zabuni",
    "Guest Contributions": "Michango ya Wageni", "Contribution": "Mchango", "Amount": "Kiasi", "From": "Kutoka", "Date": "Tarehe",
    "Sponsorship Levels": "Ngazi za Udhamini", "VIP Seating": "Viti vya VIP", "Our Sponsors": "Wadhamini Wetu",
    "Find your seat": "Tafuta kiti chako",
    "Enter the email address the couple invited you with to see your table. Only your own table is shown.": "Weka barua pepe waliyokualika nayo wanandoa ili uone meza yako. Meza yako pekee ndiyo huonyeshwa.",
    "Email": "Barua pepe", "Find my table": "Tafuta meza yangu",
    "Your Digital E-Card Pass": "Pasi Yako ya Kidijitali", "Digital E-Card Pass": "Pasi ya Kidijitali",
    "Screenshot this pass or show it at the entrance to check in.": "Piga picha ya pasi hii au ioneshe mlangoni.",
    "Scan to verify attendance": "Changanua kuthibitisha mahudhurio",
    "A gift for our next chapter": "Zawadi kwa sura yetu ijayo",
    "Thank you for celebrating with us": "Asanteni kwa kusherehekea nasi",
    "Back to top ↑": "Rudi juu ↑", "Get directions ↗": "Pata maelekezo ↗",
    "Made with love on": "Imetengenezwa kwa upendo kwenye",
    "Share this wedding": "Shiriki harusi hii",
    "Phone number *": "Namba ya simu *", "Phone number": "Namba ya simu", "Email (optional)": "Barua pepe (si lazima)",
    "Your phone number is how we find your RSVP, pass and table. Shared only with the couple.": "Namba yako ya simu ndiyo tunayotumia kupata RSVP, pasi na meza yako. Inashirikiwa na wanandoa tu.",
    "Enter the phone number the couple invited you with to see your table. Only your own table is shown.": "Weka namba ya simu waliyokualika nayo wanandoa ili uone meza yako. Meza yako pekee ndiyo huonyeshwa.",
    "Wedding theme · colour palette": "Mandhari ya harusi · rangi",
    "Before the wedding": "Kabla ya harusi",
    "Fundraisers, rehearsals and gatherings leading up to the day.": "Michango, mazoezi na mikusanyiko kabla ya siku kuu.",
    "Bids on the same song add up. Money from bids goes to the couple’s wedding fundraiser, not to the DJ. The DJ simply plays the most-requested songs.": "Zabuni za wimbo mmoja huongezwa pamoja. Pesa za zabuni huenda kwenye mchango wa harusi wa wanandoa, si kwa DJ. DJ huchezesha nyimbo zinazoombwa zaidi."
  };
  const SECTIONS = {
    story: ["Hadithi yetu", "Hadithi <em>yetu.</em>"],
    details: ["Maelezo", "Kila kitu <em>unachohitaji kujua.</em>"],
    prewedding: ["Kabla ya harusi", "Njiani <em>kuelekea siku kuu.</em>"],
    venues: ["Sherehe", "Siku iliyojaa <em>nyakati.</em>"],
    attire: ["Mwonekano", "Vaa kama <em>furaha ya siku.</em>"],
    campaigns: ["Zawadi kwa sura yetu ijayo", "Tusherehekee, <em>ukipenda.</em>"],
    registry: ["Orodha ya zawadi", "Zawadi <em>zenye maana.</em>"],
    rsvp: ["Tunatumaini utakuwepo", "Utahudhuria <em>sherehe?</em>"],
    seating: ["Viti", "Tafuta <em>kiti chako.</em>"],
    ecard: ["Mwaliko wako wa kidijitali", "Kadi ndogo <em>yenye karibu kubwa.</em>"],
    bids: ["Muziki", "Chagua <em>nyimbo.</em>"],
    "sponsor-tiers": ["Udhamini", "Simama <em>nasi.</em>"],
    "vip-section": ["Viti vya VIP", "Kaa <em>karibu zaidi.</em>"],
    sponsors: ["Kwa shukrani", "Wadhamini <em>wetu.</em>"],
    ledger: ["Asante", "Wageni wetu <em>wakarimu.</em>"]
  };
  const PH = { "e.g. Jane Wanjiku, Peter Otieno": "mf. Jane Wanjiku, Peter Otieno" };
  const orig = new WeakMap(), origAttr = new WeakMap();
  let lang = "en";
  try { lang = localStorage.getItem("ws-lang") === "sw" ? "sw" : "en"; } catch (_) {}

  function node(n) {
    if (n.nodeType !== 3) return;
    const p = n.parentElement; if (!p || /^(SCRIPT|STYLE|TEXTAREA)$/.test(p.tagName) || p.closest("[data-no-i18n]")) return;
    const cur = n.nodeValue, key = (orig.get(n) || cur).replace(/\s+/g, " ").trim();
    if (!SW[key] && !orig.has(n)) return;
    if (!orig.has(n)) { if (!SW[key]) return; orig.set(n, cur); }
    const base = orig.get(n);
    const next = lang === "sw" && SW[key] ? base.replace(key, SW[key]) : base;
    if (n.nodeValue !== next) n.nodeValue = next;
  }
  function attrs(el) {
    const ph = el.getAttribute && el.getAttribute("placeholder"); if (!ph) return;
    if (!origAttr.has(el) && PH[ph]) origAttr.set(el, ph);
    const o = origAttr.get(el); if (!o) return; const want = lang === "sw" ? PH[o] : o; if (o && el.getAttribute("placeholder") !== want) el.setAttribute("placeholder", want);
  }
  let busy = false;
  function apply(root) {
    busy = true;
    const w = document.createTreeWalker(root || document.body, NodeFilter.SHOW_TEXT);
    let n; while ((n = w.nextNode())) node(n);
    (root && root.querySelectorAll ? root : document).querySelectorAll("[placeholder]").forEach(attrs);
    document.documentElement.lang = lang;
    busy = false;
  }
  function set(l) {
    lang = l === "sw" ? "sw" : "en";
    try { localStorage.setItem("ws-lang", lang); } catch (_) {}
    apply(); button();
    document.dispatchEvent(new CustomEvent("wslang", { detail: { lang } }));
  }
  function button() {
    const b = document.getElementById("lang-toggle"); if (!b) return;
    b.textContent = lang === "sw" ? "EN" : "SW";
    b.setAttribute("aria-label", lang === "sw" ? "Switch to English" : "Badilisha kwa Kiswahili");
  }
  window.WSLang = { get: () => lang, set, section: id => (lang === "sw" && SECTIONS[id]) || null };
  document.addEventListener("DOMContentLoaded", () => {
    const b = document.getElementById("lang-toggle");
    if (b) b.addEventListener("click", () => set(lang === "sw" ? "en" : "sw"));
    button(); apply();
    let t; new MutationObserver(() => { if (busy || lang !== "sw") return; clearTimeout(t); t = setTimeout(() => apply(), 120); })
      .observe(document.body, { childList: true, subtree: true, characterData: true });
  });
})();
