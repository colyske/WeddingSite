// Reuse the unified wizard's capability resolver. No provider rules or recording here.
export async function starterCapabilities(load = () => import("./collection-capabilities.js")) {
  let helper;
  try { helper = await load(); }
  catch (error) {
    if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
    const unavailable = new Error("Starter collection support depends on the unified wizard capability update. Creation is paused until that dependency is installed.");
    unavailable.status = 503;
    unavailable.code = "STARTER_DEPENDENCY";
    throw unavailable;
  }
  try {
    const currencies = await helper.collectionCapabilities();
    if (!Array.isArray(currencies) || currencies.some(item =>
      !item || typeof item.code !== "string" || !/^[A-Z]{3}$/.test(item.code) ||
      typeof item.name !== "string" || !item.name.trim() ||
      !Array.isArray(item.methods) || !item.methods.length || item.methods.some(method =>
        !method || typeof method.name !== "string" || !method.name.trim() ||
        !Array.isArray(method.markets) || method.markets.some(market => typeof market !== "string" || !/^[A-Z]{2}$/.test(market)))) ||
      new Set(currencies.map(item => item.code)).size !== currencies.length) {
      throw new Error("Invalid collection capability response.");
    }
    return currencies;
  } catch (cause) {
    const unavailable = new Error("We could not check which guest-payment options are ready right now. Your starter answers are kept; try again when collection support is available.", { cause });
    unavailable.status = 503;
    unavailable.code = "STARTER_CAPABILITIES_UNAVAILABLE";
    throw unavailable;
  }
}
