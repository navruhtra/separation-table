// @ts-check
// Calibration: fit the print model to measured step wedges. Pure functions.
import { mixFromLab, mixToLab, de2000 } from "./engine.js";

export const TINTS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

/* CSV rows: ink,tint,L,a,b
     tint 0–100      step wedge on the base (0 = bare base or garment the ink sits on, 100 = solid)
     bare100, bare50 the ink printed straight on the shirt with no base: measures ink opacity
     ov:<Ink>        this ink at 50% with <Ink> at 50% printed after it, same angle, on base: measures how dots overlap
   plus one row  _shirt,0,L,a,b  for the bare shirt.
   Returns { n, inks: { name: { solid, substrate, curve[11], op? } }, residual, opacity?, overlap? } */
export function parseWedgeCSV(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim(); if (!t || t.startsWith("#")) continue;
    const c = t.split(/[,;\t]/).map(s => s.trim());
    const code = (c[1] || "").toLowerCase(), special = /^(bare100|bare50|ov:[^@]+(@[\d.]+)?)$/.test(code);
    if (isNaN(+c[1]) && !special) continue; // header
    if (c.length < 5 || [2, 3, 4].some(i => c[i] === "" || isNaN(+c[i]))) { if (c.slice(2).every(v => v === "")) continue; throw new Error(`Each row needs ink,tint,L,a,b. Could not read: "${t}"`); }
    // ov:<Ink>@<mm> = the overlap patch printed with <Ink>'s screen deliberately shifted by <mm> on the press
    const ov = code.startsWith("ov:") ? c[1].slice(3).split("@") : null;
    rows.push({ ink: c[0], tint: special ? code : +c[1], lab: [+c[2], +c[3], +c[4]], ...(ov && { over: ov[0], offset: ov[1] ? +ov[1] : 0 }) });
  }
  if (!rows.length) throw new Error("No measurement rows found. Expected columns: ink,tint,L,a,b");
  return rows;
}

function effArea(meas, solid, sub, n) {
  // 1-D golden-section search for the area that best explains a measured tint under Yule–Nielsen n.
  const ms = mixFromLab(solid, n), mg = mixFromLab(sub, n);
  const err = a => { const m = [0, 1, 2].map(i => a * ms[i] + (1 - a) * mg[i]); const l = mixToLab(m, n); return de2000(...meas, ...l); };
  let lo = 0, hi = 1; const g = 0.618034;
  let x1 = hi - g * (hi - lo), x2 = lo + g * (hi - lo), f1 = err(x1), f2 = err(x2);
  for (let i = 0; i < 40; i++) { if (f1 < f2) { hi = x2; x2 = x1; f2 = f1; x1 = hi - g * (hi - lo); f1 = err(x1); } else { lo = x1; x1 = x2; f1 = f2; x2 = lo + g * (hi - lo); f2 = err(x2); } }
  const a = (lo + hi) / 2; return { a, e: err(a) };
}

function golden(err, lo = 0, hi = 1) {
  const g = 0.618034; let x1 = hi - g * (hi - lo), x2 = lo + g * (hi - lo), f1 = err(x1), f2 = err(x2);
  for (let i = 0; i < 40; i++) { if (f1 < f2) { hi = x2; x2 = x1; f2 = f1; x1 = hi - g * (hi - lo); f1 = err(x1); } else { lo = x1; x1 = x2; f1 = f2; x2 = lo + g * (hi - lo); f2 = err(x2); } }
  const x = (lo + hi) / 2; return { x, e: err(x) };
}
/* Visible areas of two same-angle screens A (first) and B (after) at areas aA, aB. rho = 0: concentric dots (perfect
   register, B covers A's centre); rho = 1: random overlap (what misregistration tends toward). */
export function overlapVisible(aA, aB, rho) {
  const vA = rho * aA * (1 - aB) + (1 - rho) * Math.max(0, aA - aB);
  return { vA, vB: aB, vBase: Math.max(0, 1 - aB - vA) };
}
export function fitCalibration(rows) {
  const shirtRow = rows.find(r => /^_?shirt$/i.test(r.ink));
  const physical = rows.filter(r => typeof r.tint === "string");
  rows = rows.filter(r => typeof r.tint === "number" && !/^_?shirt$/i.test(r.ink));
  const byInk = new Map();
  for (const r of rows) { if (!byInk.has(r.ink)) byInk.set(r.ink, []); byInk.get(r.ink).push(r); }
  const inks = {};
  for (const [name, rs] of byInk) {
    const s = rs.find(r => r.tint === 100), g = rs.find(r => r.tint === 0);
    if (!s || !g) throw new Error(`Ink "${name}" needs a 0% (substrate) and a 100% (solid) patch.`);
    inks[name] = { solid: s.lab, substrate: g.lab, rows: rs.filter(r => r.tint > 0 && r.tint < 100).sort((a, b) => a.tint - b.tint) };
  }
  // n: the single Yule–Nielsen factor that best explains every tint once each tint's effective area is free.
  // A free area per tint absorbs dot gain, so n is judged by hue/chroma consistency, which area alone cannot fix.
  let best = { n: 1.7, r: Infinity };
  for (let n = 1; n <= 3.0001; n += 0.05) {
    let r = 0, c = 0;
    for (const k of Object.values(inks)) for (const row of k.rows) { r += effArea(row.lab, k.solid, k.substrate, n).e; c++; }
    r /= Math.max(1, c); if (r < best.r) best = { n: +n.toFixed(2), r };
  }
  const out = {};
  for (const [name, k] of Object.entries(inks)) {
    /** @type {(number | null)[]} */ const curve = TINTS.map(t => t === 0 ? 0 : t === 100 ? 1 : null);
    for (const row of k.rows) { const i = TINTS.indexOf(row.tint); if (i > 0) curve[i] = effArea(row.lab, k.solid, k.substrate, best.n).a; }
    // fill missing tints linearly, then force monotone
    for (let i = 1; i < 10; i++) if (curve[i] == null) { let j = i + 1; while (curve[j] == null) j++; const lo = curve[i - 1]; curve[i] = lo + (curve[j] - lo) / (j - i + 1); }
    for (let i = 1; i <= 10; i++) curve[i] = Math.max(curve[i], curve[i - 1]);
    out[name] = { solid: k.solid, substrate: k.substrate, curve: curve.map(v => +v.toFixed(4)) };
  }
  const cal = { n: best.n, residual: +best.r.toFixed(2), inks: out };
  // Ink opacity on the bare shirt: measured bare solid = op·(solid on base) + (1 − op)·shirt in Yule–Nielsen space.
  const bare = physical.filter(r => r.tint === "bare100" && out[r.ink]);
  if (bare.length && shirtRow) {
    const ms = l => mixFromLab(l, best.n), sh = ms(shirtRow.lab), ops = [];
    for (const r of bare) {
      const full = ms(out[r.ink].solid);
      const f = golden(op => de2000(...r.lab, ...mixToLab([0, 1, 2].map(i => op * full[i] + (1 - op) * sh[i]), best.n)));
      out[r.ink].op = +f.x.toFixed(3); ops.push(f.x);
    }
    cal.opacity = +(ops.reduce((a, b) => a + b, 0) / ops.length).toFixed(3); cal.shirt = shirtRow.lab;
  }
  // Same-angle dot overlap from two-ink 50/50 patches on base.
  const pairs = physical.filter(r => r.tint.startsWith("ov:") && out[r.ink] && out[r.over]);
  const zeroPairs = pairs.filter(r => !r.offset);
  if (pairs.length) {
    const ms = l => mixFromLab(l, best.n);
    const base0 = zeroPairs.length ? zeroPairs : pairs; // in-register overlap from the unshifted patches
    const err = rho => base0.reduce((s, r) => {
      const A = out[r.ink], B = out[r.over], v = overlapVisible(A.curve[5], B.curve[5], rho), a = ms(A.solid), b = ms(B.solid), base = ms(A.substrate);
      return s + de2000(...r.lab, ...mixToLab([0, 1, 2].map(i => v.vA * a[i] + v.vB * b[i] + v.vBase * base[i]), best.n));
    }, 0) / base0.length;
    const f = golden(err); cal.overlap = +f.x.toFixed(3); cal.overlapResidual = +f.e.toFixed(2);
    // overlap as a function of deliberate misregistration (registration sensitivity of this press and ink set)
    const offs = [...new Set(pairs.map(r => r.offset || 0))].sort((a, b) => a - b);
    if (offs.length > 1) cal.overlapByOffset = offs.map(o => { const sub = pairs.filter(r => (r.offset || 0) === o);
      const e = rho => sub.reduce((s2, r) => { const A = out[r.ink], B = out[r.over], v = overlapVisible(A.curve[5], B.curve[5], rho), a = ms(A.solid), b = ms(B.solid), base = ms(A.substrate);
        return s2 + de2000(...r.lab, ...mixToLab([0, 1, 2].map(i => v.vA * a[i] + v.vB * b[i] + v.vBase * base[i]), best.n)); }, 0) / sub.length;
      return { mm: o, rho: +golden(e).x.toFixed(3) }; });
  }
  return cal;
}
