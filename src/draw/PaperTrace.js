/**
 * Recovers weapon-outline shapes from a photo of a paper drawing.
 *
 * Mid-air pinch-drawing is precise but tiring to hold steady. The
 * alternative this module powers: draw the weapon's outline on paper with a
 * pen, hold it up to the camera, and a thumbs-up (see HandPose.thumbsUp)
 * captures one frame and turns each dark pen shape on it into a stroke —
 * same downstream pipeline (DrawingSession -> categorize -> tag -> finalize)
 * as a mid-air stroke, so nothing past capture needs to know the difference.
 *
 * Everything here is plain array math with no DOM dependency, so it is
 * directly unit-testable against synthetic pixel buffers — only
 * `captureFrame` (browser-only: it needs an actual <video>/<canvas>) is not.
 *
 * The pipeline: grayscale -> Otsu threshold -> binarise (ink is the *darker*
 * class: pen on paper, not paper on background) -> connected components ->
 * trace each component's outer boundary by walking pixel-grid edges ->
 * simplify with Douglas-Peucker -> normalise to 0..1 image space.
 */

/** Rec. 601 luma. */
function toGrayscale(rgba, width, height) {
  const n = width * height;
  const gray = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    gray[i] = 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
  }
  return gray;
}

function meanStdDev(gray) {
  const n = gray.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += gray[i];
  const mean = sum / n;
  let variance = 0;
  for (let i = 0; i < n; i++) {
    const d = gray[i] - mean;
    variance += d * d;
  }
  return { mean, stddev: Math.sqrt(variance / n) };
}

/**
 * Otsu's method: the threshold that maximises between-class variance of a
 * 256-bin luminance histogram. No assumption about which class is bigger, so
 * it copes with a small dense drawing on a lot of paper just as well as a
 * large one.
 */
export function otsuThreshold(gray) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) {
    const v = gray[i] < 0 ? 0 : gray[i] > 255 ? 255 : gray[i];
    hist[v | 0]++;
  }
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];

  let sumB = 0;
  let wB = 0;
  let maxVar = -1;
  let loT = 127;
  let hiT = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) {
      // Between-class variance is flat across any run of empty bins between
      // the two classes (adding zero pixels changes neither mean), so a
      // clean two-value image — synthetic test data, or a strong ink/paper
      // photo — maximises over a *range* of t, not one point. Track that
      // whole plateau and take its middle rather than its low edge: with a
      // low-edge threshold and `binarize`'s `<` comparison, a pixel sitting
      // exactly on the boundary (the entire ink class, in the clean case)
      // fails to register as foreground at all.
      maxVar = between;
      loT = t;
      hiT = t;
    } else if (between === maxVar) {
      hiT = t;
    }
  }
  return Math.round((loT + hiT) / 2);
}

/** Ink is darker than paper, so foreground = below the threshold. */
export function binarize(gray, threshold) {
  const mask = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i++) mask[i] = gray[i] < threshold ? 1 : 0;
  return mask;
}

/**
 * 8-connected flood fill. 8-connectivity (not 4) so a pen stroke that is
 * only diagonally continuous where it thins to one pixel — common in a
 * downscaled, slightly noisy camera capture — is not fractured into several
 * components.
 */
export function labelComponents(mask, width, height) {
  const labels = new Int32Array(width * height).fill(-1);
  const components = [];
  const stack = [];
  let nextId = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const start = y * width + x;
      if (!mask[start] || labels[start] !== -1) continue;

      const id = nextId++;
      let area = 0;
      stack.push(start);
      labels[start] = id;

      while (stack.length) {
        const p = stack.pop();
        const px = p % width;
        const py = (p / width) | 0;
        area++;

        for (let dy = -1; dy <= 1; dy++) {
          const ny = py + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = px + dx;
            if (nx < 0 || nx >= width) continue;
            const ni = ny * width + nx;
            if (mask[ni] && labels[ni] === -1) {
              labels[ni] = id;
              stack.push(ni);
            }
          }
        }
      }
      components.push({ id, area });
    }
  }
  return { labels, components };
}

/**
 * Outer boundary of one labelled component, as an ordered closed polygon in
 * pixel-corner space (grid corners, i.e. `width+1` by `height+1`).
 *
 * Every foreground pixel contributes a boundary edge for each side that
 * touches a non-component pixel, wound consistently clockwise (top: L->R,
 * right: T->B, bottom: R->L, left: B->T). Because the winding is consistent,
 * each grid corner has at most one *outgoing* boundary edge, so the whole
 * polygon can be recovered by starting anywhere and repeatedly following
 * "where does the edge leaving this corner go" — no direction bookkeeping
 * like Moore-neighbour tracing needs, at the cost of only recovering the
 * outer silhouette (fine here: a weapon outline has no meaningful holes).
 * The longest such loop is kept, since a component with a hole in it (e.g. a
 * closed pen loop drawn thickly enough to enclose an unfilled centre)
 * produces a shorter inner loop too.
 */
export function traceComponentBoundary(labels, width, height, compId) {
  const inComp = (x, y) => x >= 0 && y >= 0 && x < width && y < height && labels[y * width + x] === compId;
  const key = (x, y) => x * (height + 1) + y;

  const nextPoint = new Map();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (labels[y * width + x] !== compId) continue;
      if (!inComp(x, y - 1)) nextPoint.set(key(x, y), { x: x + 1, y });
      if (!inComp(x + 1, y)) nextPoint.set(key(x + 1, y), { x: x + 1, y: y + 1 });
      if (!inComp(x, y + 1)) nextPoint.set(key(x + 1, y + 1), { x, y: y + 1 });
      if (!inComp(x - 1, y)) nextPoint.set(key(x, y + 1), { x, y });
    }
  }
  if (nextPoint.size === 0) return [];

  const visited = new Set();
  let best = [];
  for (const startKey of nextPoint.keys()) {
    if (visited.has(startKey)) continue;
    const loop = [];
    let curKey = startKey;
    const maxSteps = nextPoint.size + 1;
    for (let guard = 0; guard < maxSteps; guard++) {
      const to = nextPoint.get(curKey);
      if (!to) break;
      visited.add(curKey);
      loop.push(to);
      const nk = key(to.x, to.y);
      if (nk === startKey) break;
      curKey = nk;
    }
    if (loop.length > best.length) best = loop;
  }
  return best;
}

function perpendicularDistance(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
}

/** Douglas-Peucker on an open chain (first and last points are anchors). */
function dpSimplify(points, epsilon) {
  if (points.length <= 2) return points.slice();
  const first = points[0];
  const last = points[points.length - 1];
  let maxDist = -1;
  let idx = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistance(points[i], first, last);
    if (d > maxDist) {
      maxDist = d;
      idx = i;
    }
  }
  if (maxDist > epsilon) {
    const left = dpSimplify(points.slice(0, idx + 1), epsilon);
    const right = dpSimplify(points.slice(idx), epsilon);
    return left.slice(0, -1).concat(right);
  }
  return [first, last];
}

/**
 * Douglas-Peucker for a *closed* loop: split into two open chains at the
 * start point and its (arbitrary but deterministic) opposite, simplify each,
 * then stitch. Cheaper than hunting the true farthest-apart pair, and just
 * as good for the roughly-convex-ish blobs a hand-drawn outline produces.
 */
export function simplifyClosedContour(points, epsilon) {
  if (points.length < 4) return points.slice();
  const mid = Math.floor(points.length / 2);
  const chainA = dpSimplify(points.slice(0, mid + 1), epsilon);
  const chainB = dpSimplify(points.slice(mid).concat([points[0]]), epsilon);
  return chainA.slice(0, -1).concat(chainB.slice(0, -1));
}

/**
 * @param {{data: Uint8ClampedArray|Uint8Array, width: number, height: number}} imageData
 *   Duck-typed like a canvas ImageData — deliberately not required to *be*
 *   one, so this runs the same in a unit test as in the browser.
 * @param {object} [opts]
 * @returns {{shapes: Array<{area:number, points:Array<{u:number,v:number}>}>, reason: string}}
 */
export function extractShapes(imageData, opts = {}) {
  const {
    maxContours = 6,
    minAreaFraction = 0.002,
    maxAreaFraction = 0.9,
    simplifyEpsilonPx = 2,
    minContrast = 12,
  } = opts;

  const { data, width, height } = imageData;
  const gray = toGrayscale(data, width, height);

  // A flat, low-contrast frame (blank paper, a lens cap, bad light) has no
  // real edge for Otsu to find — it will still return *a* threshold, just a
  // meaningless split of sensor noise. Bail out honestly instead.
  const { stddev } = meanStdDev(gray);
  if (stddev < minContrast) return { shapes: [], reason: 'low-contrast' };

  const threshold = otsuThreshold(gray);
  const mask = binarize(gray, threshold);
  const { labels, components } = labelComponents(mask, width, height);

  const totalPixels = width * height;
  const minArea = minAreaFraction * totalPixels;
  const maxArea = maxAreaFraction * totalPixels;
  const candidates = components
    .filter((c) => c.area >= minArea && c.area <= maxArea)
    .sort((a, b) => b.area - a.area)
    .slice(0, maxContours);

  const shapes = [];
  for (const comp of candidates) {
    const boundary = traceComponentBoundary(labels, width, height, comp.id);
    if (boundary.length < 8) continue;
    const simplified = simplifyClosedContour(boundary, simplifyEpsilonPx);
    if (simplified.length < 3) continue;
    shapes.push({
      area: comp.area,
      points: simplified.map((p) => ({ u: p.x / width, v: p.y / height })),
    });
  }
  return { shapes, reason: shapes.length ? 'ok' : 'no-shapes-found' };
}

/**
 * Grab the current video frame into a downscaled ImageData. Browser-only.
 * @param {HTMLVideoElement} video
 * @param {number} maxWidth
 */
export function captureFrame(video, maxWidth = 360) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;

  const scale = Math.min(1, maxWidth / vw);
  const width = Math.max(1, Math.round(vw * scale));
  const height = Math.max(1, Math.round(vh * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

export default { extractShapes, captureFrame, otsuThreshold, binarize, labelComponents, traceComponentBoundary, simplifyClosedContour };
