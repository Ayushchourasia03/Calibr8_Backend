// src/profiling/complexityFit.js
//
// Classifies measured growth (cost vs input size n) into complexity classes.
//
// Method: for every candidate class f, fit  cost ≈ a·f(n) + c  (a ≥ 0, c ≥ 0)
// by weighted least squares with weights 1/cost², i.e. minimising RELATIVE
// error, so small and large sizes count equally. The constant c absorbs fixed
// overhead (call/timer cost, baseline memory). Models are compared by their RMS
// relative residual; every model whose residual is within a tolerance of the
// best one is "consistent with the data". One consistent model -> a confident
// answer; two adjacent ones -> "A or B"; anything wider -> inconclusive.
// The log-log slope is reported as supporting evidence, not used to decide.

const LN2 = Math.log(2);

/** log Γ(x) (Lanczos), used for n! without overflow. */
function logGamma(x) {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

// logF returns ln f(n); evaluating in log space keeps 2^n and n! finite.
export const TIME_MODELS = [
  { key: "O(1)", rank: 0, logF: () => 0 },
  { key: "O(log n)", rank: 1, logF: (n) => Math.log(Math.max(Math.log2(n), 1e-9)) },
  { key: "O(√n)", rank: 2, logF: (n) => 0.5 * Math.log(n) },
  { key: "O(n)", rank: 3, logF: (n) => Math.log(n) },
  { key: "O(n log n)", rank: 4, logF: (n) => Math.log(n) + Math.log(Math.max(Math.log2(n), 1e-9)) },
  { key: "O(n²)", rank: 5, logF: (n) => 2 * Math.log(n) },
  { key: "O(n³)", rank: 6, logF: (n) => 3 * Math.log(n) },
  { key: "O(2ⁿ)", rank: 7, logF: (n) => n * LN2 },
  { key: "O(n!)", rank: 8, logF: (n) => logGamma(n + 1) },
];

export const SPACE_MODELS = TIME_MODELS.filter((m) =>
  ["O(1)", "O(log n)", "O(√n)", "O(n)", "O(n log n)", "O(n²)"].includes(m.key),
);

/** Fits cost ≈ a·f(n) + c for one model. Returns { a, c, rmse } (rmse = RMS relative error). */
export function fitModel(points, model, { floor = 0 } = {}) {
  const logFs = points.map((p) => model.logF(p.n));
  const maxLogF = Math.max(...logFs);
  // Normalise so the largest f is 1 (exponentials would otherwise overflow).
  const fs = logFs.map((lf) => Math.exp(lf - maxLogF));
  if (fs.some((f) => !Number.isFinite(f))) return null;
  // Not identifiable on this range: f is ~0 everywhere except the largest
  // size (e.g. 2^n for n >= 1000), so it could "fit" any last point.
  if (model.rank > 0 && fs.filter((f) => f > 1e-6).length < 3) return null;
  const ts = points.map((p) => p.cost);
  const ws = ts.map((t) => 1 / Math.max(t, floor, 1e-12) ** 2);

  let Sw = 0, Sf = 0, Sff = 0, St = 0, Sft = 0;
  for (let i = 0; i < fs.length; i++) {
    Sw += ws[i]; Sf += ws[i] * fs[i]; Sff += ws[i] * fs[i] * fs[i];
    St += ws[i] * ts[i]; Sft += ws[i] * fs[i] * ts[i];
  }
  const det = Sff * Sw - Sf * Sf;
  let a = NaN;
  let c = NaN;
  // Scale-invariant singularity test (f constant across sizes -> singular).
  if (det > 1e-12 * Sff * Sw) {
    a = (Sft * Sw - Sf * St) / det;
    c = (Sff * St - Sf * Sft) / det;
  }
  if (!(a >= 0 && c >= 0)) {
    // Constrained solutions: try a-only and c-only, keep the better.
    const aOnly = Sff > 0 ? Math.max(0, Sft / Sff) : 0;
    const cOnly = Sw > 0 ? Math.max(0, St / Sw) : 0;
    const err = (aa, cc) => fs.reduce((s, f, i) => s + ws[i] * (ts[i] - aa * f - cc) ** 2, 0);
    [a, c] = err(aOnly, 0) <= err(0, cOnly) ? [aOnly, 0] : [0, cOnly];
  }
  let sq = 0;
  for (let i = 0; i < fs.length; i++) {
    const rel = (ts[i] - (a * fs[i] + c)) / Math.max(ts[i], floor, 1e-12);
    sq += rel * rel;
  }
  // The growth term must explain a visible part of the cost over the range;
  // otherwise the model is just "constant" in disguise.
  const meanCost = ts.reduce((s, t) => s + t, 0) / ts.length;
  const growth = a * (Math.max(...fs) - Math.min(...fs));
  return { a, c, rmse: Math.sqrt(sq / fs.length), growthExplained: growth > 0.05 * meanCost };
}

/** Least-squares slope of ln(cost) vs ln(n). */
export function logLogSlope(points) {
  const xs = points.map((p) => Math.log(p.n));
  const ys = points.map((p) => Math.log(Math.max(p.cost, 1e-12)));
  const mx = xs.reduce((s, x) => s + x, 0) / xs.length;
  const my = ys.reduce((s, y) => s + y, 0) / ys.length;
  let num = 0, den = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  return den > 0 ? num / den : 0;
}

// Growth exponent of each polynomial-like class over doubling sizes in the
// profiled range (the log factor adds ~0.1 for n log n).
const POLY_EXPONENT = { "O(1)": 0, "O(log n)": 0.12, "O(√n)": 0.5, "O(n)": 1, "O(n log n)": 1.1, "O(n²)": 2, "O(n³)": 3 };

/** Sorted growth exponents between consecutive sizes (ln Δcost / ln Δn). */
export function localExponents(points, floor = 0) {
  const sorted = [...points].sort((a, b) => a.n - b.n);
  const out = [];
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    if (a.cost > floor && b.cost > floor && b.n > a.n) out.push(Math.log(b.cost / a.cost) / Math.log(b.n / a.n));
  }
  return out.sort((x, y) => x - y);
}

export const LEVELS = ["Inconclusive", "Low", "Medium", "High"];
export const downgrade = (level, steps = 1) => LEVELS[Math.max(0, LEVELS.indexOf(level) - steps)];

// Classes of (solution time / O(n) reference time) and what they imply.
const RATIO_MODELS = TIME_MODELS.filter((m) => ["O(1)", "O(log n)", "O(√n)", "O(n)"].includes(m.key));
const RATIO_TO_TIME = { "O(1)": "O(n)", "O(log n)": "O(n log n)", "O(√n)": "O(n√n)", "O(n)": "O(n²)" };

/**
 * Time classification with an O(n) reference measured on the same inputs.
 * Raw timings decide everything except the O(n) / O(n log n) boundary, where
 * cache and page-fault effects (which grow with the working set) can mimic a
 * log factor. There the ratio solution/reference decides: a flat ratio means
 * the solution scales like the reference (O(n)); a log-like ratio means
 * O(n log n). If the ratio is unclear, both are reported with Low confidence.
 */
export function classifyTimeWithReference(points, opts = {}) {
  const raw = classifyGrowth(points, { ...opts, models: TIME_MODELS });
  const boundary = ["O(n)", "O(n log n)"];
  const nearBoundary = raw.complexity && (boundary.includes(raw.complexity) || raw.candidates.some((c) => boundary.includes(c)));
  const ratioOf = (p) => (Number.isFinite(p.ratio) ? p.ratio : Number.isFinite(p.refCost) && p.refCost > 0 ? p.cost / p.refCost : NaN);
  const haveRef = points.length && points.every((p) => Number.isFinite(ratioOf(p)));
  if (!nearBoundary || !haveRef) return { ...raw, method: "raw" };

  // Paired per-repetition ratio when available (same process, interleaved).
  const ratioPoints = points.map((p) => ({ n: p.n, cost: ratioOf(p), spread: p.spread }));
  const ratio = classifyGrowth(ratioPoints, { models: RATIO_MODELS, floor: 0, tolerance: opts.tolerance });
  const evidence = { method: "reference-normalized", raw: { label: raw.label, confidence: raw.confidence }, ratio: { label: ratio.label, confidence: ratio.confidence, slope: ratio.slope, points: ratioPoints.map((p) => Number(p.cost.toFixed(4))) } };

  if (ratio.complexity === "O(1)" || ratio.complexity === "O(log n)") {
    const mapped = RATIO_TO_TIME[ratio.complexity];
    const label = ratio.label.split(" or ").map((k) => RATIO_TO_TIME[k] || k).join(" or ");
    return { ...raw, complexity: mapped, label, confidence: ratio.confidence, candidates: ratio.candidates.map((k) => RATIO_TO_TIME[k] || k), ...evidence };
  }
  // The ratio is not explained by "same as reference" or "log factor": do not
  // pick a side.
  return {
    ...raw,
    complexity: raw.complexity,
    label: "O(n) or O(n log n)",
    confidence: raw.confidence === "Inconclusive" ? "Inconclusive" : "Low",
    candidates: boundary,
    ...evidence,
  };
}

/**
 * Classifies cost growth.
 * @param {Array<{ n: number, cost: number, spread?: number }>} points - one per input size
 * @param {object} opts
 *   models: candidate list (TIME_MODELS / SPACE_MODELS)
 *   floor: costs below this are treated as noise (same unit as cost)
 *   tolerance: { factor, absolute } - how close to the best a model must be to stay consistent
 * @returns {{ complexity: string|null, label: string, confidence: string, candidates: string[], slope: number, fits: object[], reason?: string }}
 */
export function classifyGrowth(points, opts = {}) {
  const models = opts.models || TIME_MODELS;
  const floor = opts.floor ?? 0;
  const tol = { factor: 1.3, absolute: 0.03, ...(opts.tolerance || {}) };
  const pts = points.filter((p) => Number.isFinite(p.n) && p.n > 0 && Number.isFinite(p.cost) && p.cost >= 0);
  const slope = pts.length >= 2 ? logLogSlope(pts) : 0;
  const inconclusive = (reason, extra = {}) => ({
    complexity: null, label: "Inconclusive", confidence: "Inconclusive", candidates: [], slope, fits: [], reason, ...extra,
  });

  const minPoints = opts.minPoints ?? 4;
  if (pts.length < minPoints) {
    return inconclusive(`Only ${pts.length} usable input size(s); at least ${minPoints} are needed.`);
  }
  const nMin = Math.min(...pts.map((p) => p.n));
  const nMax = Math.max(...pts.map((p) => p.n));
  // Neighbouring classes (n vs n log n) need a wide size range. Small-n
  // ladders (exponential searches) are judged by their cost range instead.
  if (nMin >= 64 && nMax / nMin < (opts.minRange ?? 8)) {
    return inconclusive(`Input sizes span only ${nMin}..${nMax}; at least an 8x range is needed.`);
  }

  // Everything at the noise floor: growth cannot be measured. That is the
  // signature of constant cost, but say so only with low confidence.
  if (Math.max(...pts.map((p) => p.cost)) <= floor) {
    return {
      complexity: "O(1)", label: "O(1)", confidence: "Low", candidates: ["O(1)", "O(log n)"], slope, fits: [],
      reason: "All measurements are below the measurement floor.",
    };
  }

  const fits = models
    .map((m) => ({ model: m, ...(fitModel(pts, m, { floor }) || {}) }))
    .filter((f) => Number.isFinite(f.rmse));
  // A growing model whose growth term is zero is just O(1) in disguise.
  const usable = fits.filter((f) => f.model.rank === 0 || f.growthExplained);
  usable.sort((x, y) => x.rmse - y.rmse || x.model.rank - y.model.rank);
  const best = usable[0];
  const limit = Math.max(best.rmse * tol.factor, best.rmse + tol.absolute);
  const consistent = usable.filter((f) => f.rmse <= limit).sort((x, y) => x.model.rank - y.model.rank);
  const fitSummary = fits
    .sort((x, y) => x.model.rank - y.model.rank)
    .map((f) => ({ model: f.model.key, rmse: Number(f.rmse.toFixed(4)), a: f.a, c: f.c }));

  let confidence;
  let label;
  let complexity = best.model.key;
  const ranks = consistent.map((f) => f.model.rank);
  const contiguous = ranks.every((r, i) => i === 0 || r === ranks[i - 1] + 1);

  if (best.rmse > 0.35) {
    return inconclusive(`No complexity class fits the measurements (best: ${best.model.key}, error ${(best.rmse * 100).toFixed(0)}%).`, { fits: fitSummary });
  }
  if (consistent.length === 1) {
    confidence = best.rmse <= 0.12 ? "High" : best.rmse <= 0.25 ? "Medium" : "Low";
    label = complexity;
  } else if (consistent.length === 2 && contiguous) {
    // Report the two neighbours; lead with the better fit.
    const [x, y] = consistent;
    complexity = x.rmse <= y.rmse ? x.model.key : y.model.key;
    label = `${x.model.key} or ${y.model.key}`;
    confidence = "Low";
  } else {
    return inconclusive(
      `Measurements are consistent with ${consistent.map((f) => f.model.key).join(", ")}.`,
      { fits: fitSummary, candidates: consistent.map((f) => f.model.key) },
    );
  }

  // Robustness against one outlying size (e.g. a cache-size boundary): the
  // median growth exponent between consecutive sizes must agree with the
  // chosen polynomial class. If it does not, one point is driving the fit:
  // report the chosen class and the one the local exponents support, Low.
  let candidates = consistent.map((f) => f.model.key);
  const chosenExponent = POLY_EXPONENT[complexity];
  const local = localExponents(pts, floor);
  if (local.length >= 3 && chosenExponent !== undefined) {
    const medExp = local[Math.floor(local.length / 2)];
    if (Math.abs(medExp - chosenExponent) > 0.45) {
      const available = Object.entries(POLY_EXPONENT).filter(([k]) => models.some((m) => m.key === k));
      const supported = available.sort((x, y) => Math.abs(x[1] - medExp) - Math.abs(y[1] - medExp))[0][0];
      const rankOf = (k) => models.find((m) => m.key === k).rank;
      const pair = [complexity, supported].sort((x, y) => rankOf(x) - rankOf(y));
      if (Math.abs(rankOf(pair[0]) - rankOf(pair[1])) !== 1) {
        return inconclusive(
          `The best fit (${complexity}) disagrees with the growth between consecutive sizes (exponent ≈ ${medExp.toFixed(2)}).`,
          { fits: fitSummary, candidates: pair },
        );
      }
      complexity = supported;
      label = `${pair[0]} or ${pair[1]}`;
      confidence = "Low";
      candidates = pair;
    }
  }

  // Noisy repetitions: lower confidence instead of forcing a class.
  const spreads = pts.map((p) => p.spread).filter((s) => Number.isFinite(s)).sort((a, b) => a - b);
  const medianSpread = spreads.length ? spreads[Math.floor(spreads.length / 2)] : 0;
  if (medianSpread > 0.5) confidence = downgrade(confidence);
  if (confidence === "Inconclusive") {
    return inconclusive("Measurements are too noisy or too few to classify reliably.", {
      fits: fitSummary, candidates: consistent.map((f) => f.model.key),
    });
  }

  return {
    complexity,
    label,
    confidence,
    candidates,
    slope: Number(slope.toFixed(3)),
    fits: fitSummary,
    medianSpread: Number(medianSpread.toFixed(3)),
  };
}
