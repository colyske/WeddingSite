(function (global) {
  "use strict";
  const valid = color => /^#[0-9a-f]{6}$/i.test(color || "");
  const channels = color => [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
  const luminance = color => channels(color).reduce((sum, value, i) => {
    const c = value / 255;
    return sum + (c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][i];
  }, 0);
  const contrast = (a, b) => {
    const values = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (values[0] + .05) / (values[1] + .05);
  };
  // Keep the chosen hue, but darken UI ink until it works on the darkest light section.
  // Swatches and stored palette values remain exactly as chosen.
  function ink(color, fallback) {
    let value = valid(color) ? color : fallback;
    while (contrast(value, "#ebe7da") < 4.5 || contrast(value, "#ffffff") < 7) {
      value = "#" + channels(value).map(c => Math.floor(c * .9).toString(16).padStart(2, "0")).join("");
    }
    return value;
  }
  function apply(palette = []) {
    const root = document.documentElement.style;
    [["--green", "#244b3a"], ["--gold", "#795b20"], ["--sage", "#4d6250"]].forEach(([name, fallback], i) => {
      root.setProperty(name, ink(palette[i], fallback));
    });
  }
  global.WSTheme = { apply, contrast, ink };
})(window);
