import { showcase, showcaseFundraising, showcaseExtras } from "./showcase.js";

// Only the platform-authored fictional sample is reusable editorial content.
export function interactiveStarter(setup) {
  const next = structuredClone(setup);
  next.content = { attire: showcase.attire_notes, travel: showcaseExtras.travel, faq: structuredClone(showcaseExtras.faq) };
  next.registry.forEach((item, index) => {
    const sample = showcase.registry[index];
    if (sample) Object.assign(item, { name: sample.name, category: sample.category, description: sample.description });
  });
  next.tiers.forEach((item, index) => {
    const sample = showcaseFundraising.tiers[index];
    if (sample) Object.assign(item, { name: sample.name, perks: sample.perks });
  });
  if (next.vip) Object.assign(next.vip, {
    title: showcaseFundraising.vip.title, description: showcaseFundraising.vip.description
  });
  next.campaigns.forEach((item, index) => {
    const sample = showcaseFundraising.campaigns[index];
    if (!sample) return;
    Object.assign(item, { name: sample.name, purpose: sample.purpose });
    item.milestones.forEach((milestone, i) => {
      if (sample.milestones[i]) Object.assign(milestone, {
        name: sample.milestones[i].name, description: sample.milestones[i].description
      });
    });
  });
  return {
    setup: next,
    story: showcase.welcome_story.replaceAll("Amara", "[Partner one]").replaceAll("Kito", "[Partner two]"),
    venues: showcase.venues.map(item => ({
      name: item.name, kind: item.kind, isMain: item.is_main, eventTime: item.event_time,
      eventDate: null, address: `Sample venue: ${item.address}`, description: item.description
    }))
  };
}
