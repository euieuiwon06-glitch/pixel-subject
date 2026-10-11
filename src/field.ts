import type { Params } from './params';
import { clamp } from './util';

// 화면을 정사각형 셀 그리드로 나누고, 분석 프레임(휘도 + 인물 마스크)을
// 셀 단위로 샘플링한다. 움직임(중심점·바운딩 박스·마스크 차이·휘도 차이)도 여기서 계산한다.
export class Field {
  W = 0; H = 0;          // 캔버스 크기 (device px)
  cs = 8;                // 셀 크기 (device px)
  cols = 0; rows = 0; n = 0;
  ox = 0; oy = 0;        // 그리드 원점

  // 셀 중심 → 영상 좌표(0–1). cover + 좌우 반전이 반영돼 있다.
  private u = new Float32Array(0);
  private v = new Float32Array(0);
  visibleU = 1;          // 화면에 보이는 영상 가로 비율 (분석 해상도 결정용)

  lum = new Float32Array(0);
  prevLum = new Float32Array(0);
  soft = new Float32Array(0);    // 시간 평활 마스크
  on = new Uint8Array(0);        // 최종 인물 셀
  prevOn = new Uint8Array(0);
  edge = new Float32Array(0);    // 0 = 몸 안쪽, 1 = 외곽
  motion = new Float32Array(0);  // 셀 주변의 국소 변화량
  gray = new Float32Array(0);    // 렌더링용 회색값
  private level = new Int16Array(0); // 셀별 현재 톤 단계

  private tmp = new Float32Array(0);
  private label = new Int32Array(0);
  private stack = new Int32Array(0);
  private sat = new Int32Array(0);
  private lumPlane = new Float32Array(0);

  count = 0;
  hasSubject = false;
  cx = 0; cy = 0;              // 몸 중심부 중심점 (device px)
  dx = 0; dy = 0;              // 이번 분석 틱의 피사체 이동량 (device px, 데드존 적용)
  velX = 0; velY = 0;          // 평활된 피사체 속도 (device px/s)
  shiftX = 0; shiftY = 0;      // 이번 틱에 파티클 목표를 옮길 정수 셀 수
  private prevIdx = new Int32Array(0); private prevW = new Float32Array(0); private prevCount = 0;
  private lo = 0.15; private hi = 0.85;

  layout(W: number, H: number, cs: number, vw: number, vh: number) {
    this.W = W; this.H = H; this.cs = cs;
    const cols = Math.ceil(W / cs), rows = Math.ceil(H / cs), n = cols * rows;
    const resized = n !== this.n;
    this.cols = cols; this.rows = rows; this.n = n;
    this.ox = (W - cols * cs) / 2;
    this.oy = (H - rows * cs) / 2;

    if (resized) {
      const F = () => new Float32Array(n);
      this.u = F(); this.v = F();
      this.lum = F(); this.prevLum = F(); this.soft = F(); this.edge = F();
      this.motion = F(); this.gray = F(); this.tmp = F();
      this.on = new Uint8Array(n); this.prevOn = new Uint8Array(n);
      this.level = new Int16Array(n).fill(-1);
      this.label = new Int32Array(n); this.stack = new Int32Array(n);
      this.prevIdx = new Int32Array(n); this.prevW = new Float32Array(n);
      this.sat = new Int32Array((cols + 1) * (rows + 1));
    } else {
      this.soft.fill(0); this.on.fill(0); this.prevOn.fill(0); this.motion.fill(0); this.level.fill(-1);
    }
    this.hasSubject = false;
    this.velX = this.velY = 0;
    this.prevCount = 0;

    // cover: 화면을 꽉 채우도록 확대, 남는 쪽은 잘라낸다. 그 뒤 좌우 반전.
    const s = Math.max(W / vw, H / vh);
    const offX = (W - vw * s) / 2, offY = (H - vh * s) / 2;
    this.visibleU = Math.min(1, W / (vw * s));
    for (let y = 0; y < rows; y++) {
      const sy = this.oy + (y + 0.5) * cs;
      const vv = clamp((sy - offY) / (s * vh), 0, 1);
      for (let x = 0; x < cols; x++) {
        const sx = this.ox + (x + 0.5) * cs;
        const i = y * cols + x;
        this.u[i] = clamp((W - sx - offX) / (s * vw), 0, 1);
        this.v[i] = vv;
      }
    }
  }

  /** 새 분석 프레임을 반영한다. rgba = 분석 캔버스 픽셀, mask = 인물 확률. */
  ingest(rgba: Uint8ClampedArray, aw: number, ah: number, mask: Float32Array, mw: number, mh: number, dt: number, p: Params) {
    const { n, cols, rows, u, v, lum, soft, on, prevOn, cs } = this;

    if (this.lumPlane.length !== aw * ah) this.lumPlane = new Float32Array(aw * ah);
    const lp = this.lumPlane;
    for (let i = 0, k = 0; i < lp.length; i++, k += 4)
      lp[i] = (0.2126 * rgba[k] + 0.7152 * rgba[k + 1] + 0.0722 * rgba[k + 2]) / 255;

    // 1) 셀 샘플링 + 약한 시간 평활 + 히스테리시스.
    //    가장자리는 일부러 이진화해 깨진 디지털 실루엣을 유지한다.
    const th = p.maskThreshold;
    for (let i = 0; i < n; i++) {
      const m = bilinear(mask, mw, mh, u[i], v[i]);
      const s = soft[i] * 0.35 + m * 0.65;
      soft[i] = s;
      on[i] = prevOn[i] ? (s > th - 0.1 ? 1 : 0) : (s > th + 0.06 ? 1 : 0);
      lum[i] = bilinear(lp, aw, ah, u[i], v[i]);
    }

    // 2) 작은 조각 제거 — 가장 큰 덩어리의 3% 미만인 연결 요소는 노이즈로 본다.
    this.dropSpecks();

    // 3) 외곽 강도: 반경 2셀 안의 배경 비율
    this.computeEdges();

    // 4) 국소 움직임: 마스크 변화 + 휘도 변화(데드존 적용) → 3x3 확산, 서서히 감쇠
    const tmp = this.tmp, prevLum = this.prevLum, motion = this.motion;
    for (let i = 0; i < n; i++) {
      const md = on[i] !== prevOn[i] ? 1 : 0;
      const ld = on[i] ? clamp((Math.abs(lum[i] - prevLum[i]) - 0.07) * 5, 0, 1) : 0;
      tmp[i] = md > ld ? md : ld;
    }
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        let s = 0, c = 0;
        for (let j = -1; j <= 1; j++) {
          const yy = y + j;
          if (yy < 0 || yy >= rows) continue;
          for (let k = -1; k <= 1; k++) {
            const xx = x + k;
            if (xx < 0 || xx >= cols) continue;
            s += tmp[yy * cols + xx]; c++;
          }
        }
        const i = y * cols + x, b = (s / c) * 1.6;
        motion[i] = Math.max(motion[i] * 0.55, b > 1 ? 1 : b);
      }
    }

    // 5) 피사체 이동: 이전 실루엣을 정수 셀만큼 옮겨 가며 현재 실루엣과 가장 잘 겹치는 이동량을 찾는다.
    //    겹침은 경계까지의 거리(깊이)로 가중하므로 두꺼운 몸통이 결과를 좌우한다.
    //    팔만 휘두르면 몸통은 그대로 겹치므로 이동량 0 → 몸 전체가 끌려가지 않는다.
    const depth = this.depthMap();
    let cnt = 0, sx = 0, sy = 0, kc = 0;
    for (let i = 0; i < n; i++) {
      if (!on[i]) continue;
      cnt++;
      const w = depth[i] * depth[i];
      sx += (i % cols) * w; sy += ((i / cols) | 0) * w; kc += w;
    }
    const had = this.hasSubject;
    this.count = cnt;
    this.hasSubject = cnt > 24;
    let mx = 0, my = 0;
    if (this.hasSubject) {
      this.cx = this.ox + (sx / kc + 0.5) * cs;
      this.cy = this.oy + (sy / kc + 0.5) * cs;
      if (had) [mx, my] = this.matchShift(depth);
    }
    this.shiftX = mx; this.shiftY = my;
    this.dx = mx * cs; this.dy = my * cs;
    // 다음 틱 비교용 깊이 저장
    let pc = 0;
    for (let i = 0; i < n; i++) if (on[i]) { this.prevIdx[pc] = i; this.prevW[pc++] = Math.min(depth[i], DEPTH_CAP); }
    this.prevCount = this.hasSubject ? pc : 0;

    const k = 0.45, inv = dt > 0 ? 1000 / dt : 0;
    this.velX = this.velX * (1 - k) + this.dx * inv * k;
    this.velY = this.velY * (1 - k) + this.dy * inv * k;

    // 6) 회색 매핑: 인물 영역의 3–97% 분위수로 자동 대비 후 대비값 적용
    this.computeGray(p.contrast, p.toneLevels, p.dither);

    this.prevLum.set(lum);
    this.prevOn.set(on);
  }

  /** 이전 깊이 지도를 (sx, sy) 셀만큼 옮겼을 때 현재 깊이 지도와 차이(SAD)가 가장 작은 이동량. */
  private matchShift(depth: Float32Array): [number, number] {
    const { cols, rows, prevIdx, prevW, prevCount } = this;
    const R = 3;
    const sadAt = (sx: number, sy: number, limit: number) => {
      let sad = 0;
      for (let j = 0; j < prevCount; j++) {
        const i = prevIdx[j];
        const x = (i % cols) + sx, y = ((i / cols) | 0) + sy;
        const d = x >= 0 && x < cols && y >= 0 && y < rows ? Math.min(depth[y * cols + x], DEPTH_CAP) : 0;
        sad += Math.abs(prevW[j] - d);
        if (sad >= limit) break;
      }
      return sad;
    };
    // 기준(이동 없음)은 끝까지 계산하고, 나머지는 현재 최솟값을 넘으면 조기 종료
    const base = sadAt(0, 0, Infinity);
    let best = base, bx = 0, by = 0;
    for (let sy = -R; sy <= R; sy++) {
      for (let sx = -R; sx <= R; sx++) {
        if (!sx && !sy) continue;
        const sad = sadAt(sx, sy, best);
        if (sad < best || (sad === best && Math.abs(sx) + Math.abs(sy) < Math.abs(bx) + Math.abs(by))) { best = sad; bx = sx; by = sy; }
      }
    }
    // 확실히 더 잘 맞을 때만 이동으로 인정 (마스크 노이즈 데드존)
    return best < base * 0.9 - 2 ? [bx, by] : [0, 0];
  }

  // 각 인물 셀에서 가장 가까운 배경 셀까지의 거리 (2패스 체임퍼, 8방향 근사).
  // 화면 테두리는 배경으로 치지 않는다 — 화면 아래로 잘린 몸통이 얕아지지 않게.
  private depthMap(): Float32Array {
    const { n, cols, rows, on, tmp: d } = this;
    const INF = 1e6, D = 1.4142;
    for (let i = 0; i < n; i++) d[i] = on[i] ? INF : 0;
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      if (!d[i]) continue;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + 1);
      if (y > 0) {
        v = Math.min(v, d[i - cols] + 1);
        if (x > 0) v = Math.min(v, d[i - cols - 1] + D);
        if (x < cols - 1) v = Math.min(v, d[i - cols + 1] + D);
      }
      d[i] = v;
    }
    for (let y = rows - 1; y >= 0; y--) for (let x = cols - 1; x >= 0; x--) {
      const i = y * cols + x;
      if (!d[i]) continue;
      let v = d[i];
      if (x < cols - 1) v = Math.min(v, d[i + 1] + 1);
      if (y < rows - 1) {
        v = Math.min(v, d[i + cols] + 1);
        if (x < cols - 1) v = Math.min(v, d[i + cols + 1] + D);
        if (x > 0) v = Math.min(v, d[i + cols - 1] + D);
      }
      d[i] = v >= INF ? Math.max(cols, rows) : v;
    }
    return d;
  }

  private dropSpecks() {
    const { n, cols, rows, on, label, stack } = this;
    label.fill(-1);
    const sizes: number[] = [];
    for (let s = 0; s < n; s++) {
      if (!on[s] || label[s] >= 0) continue;
      const id = sizes.length;
      let top = 0, size = 0;
      stack[top++] = s; label[s] = id;
      while (top) {
        const i = stack[--top]; size++;
        const x = i % cols, y = (i / cols) | 0;
        if (x > 0 && on[i - 1] && label[i - 1] < 0) { label[i - 1] = id; stack[top++] = i - 1; }
        if (x < cols - 1 && on[i + 1] && label[i + 1] < 0) { label[i + 1] = id; stack[top++] = i + 1; }
        if (y > 0 && on[i - cols] && label[i - cols] < 0) { label[i - cols] = id; stack[top++] = i - cols; }
        if (y < rows - 1 && on[i + cols] && label[i + cols] < 0) { label[i + cols] = id; stack[top++] = i + cols; }
      }
      sizes.push(size);
    }
    if (!sizes.length) return;
    const minSize = Math.max(6, Math.max(...sizes) * 0.03);
    for (let i = 0; i < n; i++) if (on[i] && sizes[label[i]] < minSize) on[i] = 0;
  }

  private computeEdges() {
    const { cols, rows, on, sat, edge } = this;
    const W1 = cols + 1;
    for (let x = 0; x <= cols; x++) sat[x] = 0;
    for (let y = 1; y <= rows; y++) {
      let row = 0;
      sat[y * W1] = 0;
      for (let x = 1; x <= cols; x++) {
        row += on[(y - 1) * cols + x - 1];
        sat[y * W1 + x] = sat[(y - 1) * W1 + x] + row;
      }
    }
    const r = 2;
    for (let y = 0; y < rows; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(rows, y + r + 1);
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x;
        if (!on[i]) { edge[i] = 0; continue; }
        const x0 = Math.max(0, x - r), x1 = Math.min(cols, x + r + 1);
        const c = sat[y1 * W1 + x1] - sat[y0 * W1 + x1] - sat[y1 * W1 + x0] + sat[y0 * W1 + x0];
        const area = (x1 - x0) * (y1 - y0);
        edge[i] = clamp((1 - c / area) * 2.4, 0, 1);
      }
    }
  }

  private hist = new Uint32Array(64);
  private computeGray(contrast: number, levels: number, dither: number) {
    const { n, on, lum, gray, hist } = this;
    hist.fill(0);
    let total = 0;
    for (let i = 0; i < n; i++) if (on[i]) { hist[Math.min(63, (lum[i] * 64) | 0)]++; total++; }
    if (total > 24) {
      let acc = 0, lo = -1, hi = 63;
      for (let b = 0; b < 64; b++) {
        acc += hist[b];
        if (lo < 0 && acc >= total * 0.03) lo = b;
        if (acc >= total * 0.97) { hi = b; break; }
      }
      const loV = lo / 64, hiV = Math.max((hi + 1) / 64, loV + 0.2);
      this.lo += (loV - this.lo) * 0.08;
      this.hi += (hiV - this.hi) * 0.08;
    }
    // 픽셀 그래픽: 몇 단계의 평평한 회색 + 4x4 Bayer 순서 디더링.
    // 디더 패턴은 셀 좌표에 고정돼 있어 흔들리지 않고, 단계 전환에는 히스테리시스를 둔다.
    const range = this.hi - this.lo || 1;
    const L = Math.max(2, Math.round(levels)), top = L - 1;
    const { cols, level } = this;
    for (let i = 0; i < n; i++) {
      if (!on[i]) { level[i] = -1; continue; }
      let g = (lum[i] - this.lo) / range;
      g = clamp((g - 0.5) * contrast + 0.5, 0, 1);
      const b = (BAYER4[((((i / cols) | 0) & 3) << 2) | ((i % cols) & 3)] + 0.5) / 16 - 0.5;
      const v = g * top + b * dither;
      let lv = level[i];
      if (lv < 0 || Math.abs(v - lv) > 0.62) lv = clamp(Math.round(v), 0, top);
      level[i] = lv;
      gray[i] = 0.1 + (lv / top) * 0.86; // 순흑은 배경 전용
    }
  }
}

const DEPTH_CAP = 8;
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

function bilinear(src: Float32Array, w: number, h: number, u: number, v: number): number {
  if (!w || !h) return 0;
  const fx = u * (w - 1), fy = v * (h - 1);
  const x0 = fx | 0, y0 = fy | 0;
  const x1 = x0 < w - 1 ? x0 + 1 : x0, y1 = y0 < h - 1 ? y0 + 1 : y0;
  const tx = fx - x0, ty = fy - y0;
  const a = src[y0 * w + x0], b = src[y0 * w + x1], c = src[y1 * w + x0], d = src[y1 * w + x1];
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}
