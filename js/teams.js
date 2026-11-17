// Team colors [primary, alternate] and logo URLs, keyed by ESPN abbreviation.
// The app uses its own codes (JAC, LA, WAS); espnAb maps them.
export const COLORS = {ARI:["#a40227","#ffffff"],ATL:["#a71930","#000000"],BAL:["#29126f","#000000"],BUF:["#00338d","#d50a0a"],CAR:["#0085ca","#000000"],CHI:["#0b1c3a","#e64100"],CIN:["#fb4f14","#000000"],CLE:["#472a08","#ff3c00"],DAL:["#002a5c","#b0b7bc"],DEN:["#0a2343","#fc4c02"],DET:["#0076b6","#bbbbbb"],GB:["#204e32","#ffb612"],HOU:["#021018","#eb0028"],IND:["#003b75","#ffffff"],JAX:["#007487","#d7a22a"],KC:["#e31837","#ffb612"],LV:["#000000","#a5acaf"],LAC:["#0080c6","#ffc20e"],LAR:["#003594","#ffd100"],MIA:["#008e97","#fc4c02"],MIN:["#4f2683","#ffc62f"],NE:["#002a5c","#c60c30"],NO:["#d3bc8d","#000000"],NYG:["#003c7f","#c9243f"],NYJ:["#115740","#ffffff"],PHI:["#06424d","#000000"],PIT:["#000000","#ffb612"],SF:["#aa0000","#b3995d"],SEA:["#002a5c","#69be28"],TB:["#bd1c36","#3e3a35"],TEN:["#4495d2","#001532"],WSH:["#5a1414","#ffb612"]};

const TO_ESPN = { JAC: "JAX", LA: "LAR", WAS: "WSH" };
export const espnAb = (ab) => TO_ESPN[ab] || ab;

// ESPN's logo CDN. `dark` gives the version drawn for dark backgrounds (the ticker).
export const logoUrl = (ab, dark = false) =>
  `https://a.espncdn.com/i/teamlogos/nfl/${dark ? "500-dark" : "500"}/scoreboard/${espnAb(ab).toLowerCase()}.png`;

// CSS custom properties for a team's colors: --tc primary, --ta alternate, --tx readable text on primary.
export function teamStyle(ab) {
  const c = COLORS[espnAb(ab)];
  if (!c) return "";
  const lin = [1, 3, 5].map((i) => {
    const v = parseInt(c[0].substr(i, 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  const L = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  return `--tc:${c[0]};--ta:${c[1]};--tx:${L > 0.35 ? "#111" : "#fff"}`;
}
