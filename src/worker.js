// @ts-check
// Heavy work off the main thread: palette choice, unmixing, proof, film rendering.
import { renderFilms, withMethod } from "./job.js";
import { runSeparation, separateCore, finishSeparation, evaluate, printView, autoPick, bestPlacement, searchMix, runAutoJob } from "./pipeline.js";

let S = null; // last separation, kept for film rendering
let C = null; // a separation solved but not yet scored for the screen (see pipeline.separateCore); "finish" completes it
let A = null; // Auto trials: the small copies of the art this worker separates (see pipeline.autoPlan)

self.onmessage = async ({ data: m }) => {
  try {
    if (m.type === "separate") {
      // UI separations cache their result for halftone previews and show removal costs; export passes preview:false.
      // a print method (cmyk, mono, duo, tri) sets its own inks, screen count and overprint; sim / spot / index pass through
      const mm = withMethod(m);
      const ui = m.preview !== false, t0 = performance.now();
      // defer: inks and coverage only. The page asks for this when it may replace the separation at once; it sends
      // "finish" for the one it keeps, and the result is then the same as an undeferred separation.
      if (m.defer) { const core = separateCore({ ...mm, costs: ui }); C = { core, ui, W: m.W, H: m.H, mode: m.mode, ms: performance.now() - t0 };
        self.postMessage({ type: "separated", id: m.id, inks: core.inks, dropped: core.dropped, deferred: true, ms: Math.round(C.ms) }); return; }
      C = null; const r = runSeparation({ ...mm, costs: ui });
      if (ui) S = { cov: r.cov, ub: r.ub, W: m.W, H: m.H, N: r.inks.length, mode: m.mode, inks: r.inks, solid: r.solid };
      self.postMessage({ type: "separated", id: m.id, ...r, ms: Math.round(performance.now() - t0) });
      return;
    }
    // Auto in the app: the page plans the trials and hands them out to several workers; each keeps the small copies
    if (m.type === "finish") {
      if (!C) throw new Error("Nothing to finish");
      const c = C, t0 = performance.now(), r = finishSeparation(c.core); C = null;
      if (c.ui) S = { cov: r.cov, ub: r.ub, W: c.W, H: c.H, N: r.inks.length, mode: c.mode, inks: r.inks, solid: r.solid };
      self.postMessage({ type: "separated", id: m.id, ...r, ms: Math.round(c.ms + performance.now() - t0) }); return;
    }
    // put back a separation the page kept (Auto tried one more screen and went back): films are drawn from it again
    if (m.type === "restore") { C = null; S = { cov: m.cov, ub: m.ub, W: m.W, H: m.H, N: m.inks.length, mode: m.mode, inks: m.inks, solid: m.solid }; self.postMessage({ type: "restored", id: m.id }); return; }
    if (m.type === "autoInit") { A = { m: null, thumbs: m.thumbs }; self.postMessage({ type: "autoReady", id: m.id }); return; }
    if (m.type === "autoJob") { if (!A) throw new Error("Auto trial before its art"); self.postMessage({ type: "autoJobDone", id: m.id, r: runAutoJob(A, m.job) }); return; }
    if (m.type === "auto") {
      const r = autoPick(m, f => self.postMessage({ type: "autoStep", id: m.id, f }));
      self.postMessage({ type: "autoDone", id: m.id, ...r });
      return;
    }
    if (m.type === "search") {
      const r = searchMix(m, m.start);
      self.postMessage({ type: "searched", id: m.id, ...r });
      return;
    }
    if (m.type === "placement") {
      const r = bestPlacement(m, m.inks, m.keys);
      self.postMessage({ type: "placed", id: m.id, ...r });
      return;
    }
    // the print-order step's full-size check reads only the Print view error
    if (m.type === "reproof" && m.printView) { self.postMessage({ type: "reproofed", id: m.id, ...printView(m, m.inks, m.cov) }); return; }
    if (m.type === "reproof") {
      const r = evaluate(m, m.inks, m.cov);
      // a probe (preview with screens hidden) must not replace the separation the films are made from
      if (!m.probe && S && S.W === m.W) S = { ...S, cov: m.cov, ub: r.ub };
      self.postMessage({ type: "reproofed", id: m.id, ...r });
      return;
    }
    if (m.type === "plates") {
      // m: { plates:[{idx,ub,name,angle,curve}], Wp,Hp, crop?, dpi,lpi, screening, overprint, dot, choke, cov?, ub? }
      const src = m.cov ? m : { ...m, ...S }; // passed data is used once, not kept
      renderFilms(src, (j, bits, w, h) => self.postMessage({ type: "plate", id: m.id, j, bits, w, h }, [bits.buffer]));
      self.postMessage({ type: "platesDone", id: m.id });
      return;
    }
  } catch (e) { self.postMessage({ type: "error", id: m.id, message: e && e.message ? e.message : String(e) }); }
};
