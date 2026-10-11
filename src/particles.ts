import type { Field } from './field';
import type { Params } from './params';
import { clamp, hash, mix, noise2 } from './util';

const DEAD = 0, OWNED = 1, FLOATING = 2;
const TAU = Math.PI * 2;
const STEP_MS = 1000 / 60;
export const STRIDE = 5; // x, y, size, gray, alpha

// 정사각형 픽셀 파티클 풀 (SoA 타입 배열).
// OWNED   : 인물 셀 하나를 목표로 가지고 스프링+마찰로 뒤늦게 따라간다.
// FLOATING: 마스크에서 사라진 픽셀/잔상. 속도를 유지한 채 떠다니다 페이드아웃.
export class Particles {
  cap = 0;
  live = 0;
  private x = new Float32Array(0); private y = new Float32Array(0);
  private px = new Float32Array(0); private py = new Float32Array(0); // 직전 스텝 위치 (렌더 보간용)
  private vx = new Float32Array(0); private vy = new Float32Array(0);
  private gray = new Float32Array(0);
  private fade = new Float32Array(0);
  private life = new Float32Array(0); private lifeMax = new Float32Array(0);
  // 개체별 편차 — 모든 픽셀이 같은 속도·크기로 움직이지 않도록
  private jx = new Float32Array(0); private jy = new Float32Array(0);
  private sizeVar = new Float32Array(0); private gap = new Float32Array(0);
  private alphaVar = new Float32Array(0);
  private kVar = new Float32Array(0); private fVar = new Float32Array(0);
  private cell = new Int32Array(0);
  private state = new Uint8Array(0);
  private freeStack = new Int32Array(0); private freeTop = 0;

  private owner = new Int32Array(0);
  private nextOwner = new Int32Array(0);
  private head = new Int32Array(0);
  private link = new Int32Array(0);
  private framesWithSubject = 0;

  /** 그리드가 바뀌면 호출. 기존 픽셀은 흩어지며 사라지고 새 그리드에서 다시 모인다. */
  reset(field: Field, p: Params, rm: number) {
    const n = field.n;
    const need = Math.ceil(n * 1.6) + 4000;
    if (need > this.cap) this.grow(need);
    for (let q = 0; q < this.cap; q++) if (this.state[q] === OWNED) this.release(q, p, rm, 0.5);
    if (this.owner.length !== n) {
      this.owner = new Int32Array(n);
      this.nextOwner = new Int32Array(n);
      this.head = new Int32Array(n);
    }
    this.owner.fill(-1);
    this.framesWithSubject = 0;
  }

  private grow(cap: number) {
    const F = () => new Float32Array(cap);
    this.x = F(); this.y = F(); this.px = F(); this.py = F(); this.vx = F(); this.vy = F(); this.gray = F(); this.fade = F();
    this.life = F(); this.lifeMax = F(); this.jx = F(); this.jy = F(); this.sizeVar = F(); this.gap = F();
    this.alphaVar = F(); this.kVar = F(); this.fVar = F();
    this.cell = new Int32Array(cap); this.state = new Uint8Array(cap);
    this.link = new Int32Array(cap);
    this.freeStack = new Int32Array(cap);
    for (let q = 0; q < cap; q++) this.freeStack[q] = cap - 1 - q;
    this.freeTop = cap;
    this.cap = cap;
    this.live = 0;
  }

  private alloc(cs: number): number {
    if (!this.freeTop) return -1;
    const q = this.freeStack[--this.freeTop];
    const r = Math.random;
    this.vx[q] = this.vy[q] = 0;
    this.fade[q] = 0;
    const j = r();
    this.jx[q] = j < 0.12 ? (r() < 0.5 ? -1 : 1) : 0;
    this.jy[q] = j > 0.9 ? (r() < 0.5 ? -1 : 1) : 0;
    const s = r();
    this.sizeVar[q] = s < 0.06 ? 0.72 : s > 0.96 ? 1.18 : 1;
    this.gap[q] = (0.55 + r() * 1.05) * Math.max(1, cs / 13);
    this.alphaVar[q] = 0.74 + 0.26 * Math.sqrt(r());
    this.kVar[q] = 0.75 + r() * 0.5;
    this.fVar[q] = (r() - 0.5) * 0.08;
    this.live++;
    return q;
  }

  private kill(q: number) {
    this.state[q] = DEAD;
    this.cell[q] = -1;
    this.freeStack[this.freeTop++] = q;
    this.live--;
  }

  private release(q: number, p: Params, rm: number, lifeScale = 1) {
    this.state[q] = FLOATING;
    this.cell[q] = -1;
    this.vx[q] *= 0.6; this.vy[q] *= 0.6;
    const l = p.trailLifetime * rm * (0.5 + Math.random()) * lifeScale;
    this.life[q] = this.lifeMax[q] = Math.max(80, l);
  }

  /** 분석 틱마다: 목표 셀 재배정, 새 픽셀 생성, 산란 임펄스, 잔상 방출. */
  assign(field: Field, p: Params, rm: number, t: number, dpr: number) {
    const { n, cols, rows, on, cs, edge } = field;
    if (this.owner.length !== n) return;
    const owner = this.owner, next = this.nextOwner;
    next.fill(-1);

    this.framesWithSubject = field.hasSubject ? this.framesWithSubject + 1 : 0;
    const fresh = this.framesWithSubject < 8;

    // 1) 피사체 이동량만큼 모든 목표를 정수 셀 단위로 옮긴다.
    //    목표는 즉시 이동하지만 파티클은 스프링으로 뒤늦게 따라오므로 지연이 생긴다.
    const sx = field.shiftX, sy = field.shiftY;
    for (let c = 0; c < n; c++) {
      const q = owner[c];
      if (q < 0) continue;
      let c2 = c;
      if (sx || sy) {
        const x = (c % cols) + sx, y = ((c / cols) | 0) + sy;
        c2 = x >= 0 && x < cols && y >= 0 && y < rows ? y * cols + x : -1;
      }
      if (c2 >= 0 && on[c2] && next[c2] < 0) { next[c2] = q; this.cell[q] = c2; }
      else this.release(q, p, rm); // 마스크에서 사라짐 → 즉시 지우지 않고 떠다니게
    }

    // 2) 방금 풀려난(수명 초반) 픽셀을 셀 버킷에 넣어, 근처에 새로 생긴 셀이 재사용하게 한다.
    //    팔처럼 국소적으로 움직이는 부위는 이 재사용으로 픽셀이 실제로 끌려간다.
    const head = this.head, link = this.link;
    head.fill(-1);
    for (let q = 0; q < this.cap; q++) {
      if (this.state[q] !== FLOATING || this.life[q] < this.lifeMax[q] * 0.45) continue;
      const gx = Math.floor((this.x[q] - field.ox) / cs), gy = Math.floor((this.y[q] - field.oy) / cs);
      if (gx < 0 || gx >= cols || gy < 0 || gy >= rows) continue;
      const g = gy * cols + gx;
      link[q] = head[g]; head[g] = q;
    }

    const dsx = field.dx, dsy = field.dy;
    const dl = Math.hypot(dsx, dsy) || 1;
    for (let c = 0; c < n; c++) {
      if (!on[c] || next[c] >= 0) continue;
      const q = this.claimNear(c, cols, rows, 3);
      if (q >= 0) {
        this.state[q] = OWNED; this.cell[q] = c; next[c] = q;
        this.fade[q] = Math.max(0.3, this.life[q] / this.lifeMax[q]);
        continue;
      }
      const s = this.alloc(cs);
      if (s < 0) continue;
      this.state[s] = OWNED; this.cell[s] = c; next[c] = s;
      this.gray[s] = field.gray[c];
      // 불규칙한 위치에서 태어나 목표로 모인다. 움직이는 중이면 지나온 쪽에서 나타난다.
      const tx = field.ox + ((c % cols) + 0.5) * cs, ty = field.oy + (((c / cols) | 0) + 0.5) * cs;
      const a = Math.random() * TAU;
      const rr = Math.random();
      const r = cs * (fresh ? 1.5 + rr * rr * 16 : 0.6 + rr * rr * 3.5);
      const back = fresh ? 0 : Math.random() * 2.5;
      this.x[s] = this.px[s] = tx + Math.cos(a) * r - (dsx / dl) * back * Math.min(dl, cs * 3);
      this.y[s] = this.py[s] = ty + Math.sin(a) * r - (dsy / dl) * back * Math.min(dl, cs * 3);
    }
    this.owner = next; this.nextOwner = owner;

    // 3) 산란: 이동 반대 방향(잔상) + 몸 중심에서 바깥쪽(위치) + 고정 노이즈 장(field)
    const speed = Math.hypot(field.velX, field.velY);
    const vtx = field.velX / 30, vty = field.velY / 30; // 평활 속도 → 틱당 이동량
    const motion = clamp(speed / (p.motionThreshold * dpr), 0, 1);
    const own = this.owner, lm = field.motion;
    const maxV = cs * 2;
    const scatter = p.scatter * rm;
    let emitted = 0;
    const emitCap = Math.max(40, n * 0.02);
    for (let c = 0; c < n; c++) {
      const q = own[c];
      if (q < 0) continue;
      this.gray[q] = field.gray[c];
      const e = edge[c];
      let s = (motion * mix(0.15, 1, e) + lm[c] * mix(0.05, 0.7, e)) * scatter;
      if (s < 0.03) continue;
      if (s > 1.4) s = 1.4;
      const cx = c % cols, cy = (c / cols) | 0;
      const px = field.ox + (cx + 0.5) * cs, py = field.oy + (cy + 0.5) * cs;
      let rx = px - field.cx, ry = py - field.cy;
      const rl = Math.hypot(rx, ry) || 1; rx /= rl; ry /= rl;
      const ang = noise2(cx * 0.11 + t * 0.00031, cy * 0.11 - t * 0.00023) * TAU * 2;
      // 중심부는 거의 유지, 외곽일수록 크게 흩어진다
      const tr = 0.12 * s * e * e, nz = cs * 0.24 * e * s;
      const ivx = -vtx * tr + (Math.cos(ang) + rx * 0.6) * nz;
      const ivy = -vty * tr + (Math.sin(ang) + ry * 0.6) * nz;
      let nvx = this.vx[q] + ivx, nvy = this.vy[q] + ivy;
      const v = Math.hypot(nvx, nvy);
      if (v > maxV) { nvx *= maxV / v; nvy *= maxV / v; }
      this.vx[q] = nvx; this.vy[q] = nvy;

      // 잔상: 외곽 픽셀의 복제본이 이동 반대편으로 남는다
      if (emitted < emitCap && motion > 0.1 && e > 0.3 && Math.random() < motion * e * 0.05 * scatter) {
        const g = this.alloc(cs);
        if (g >= 0) {
          emitted++;
          this.state[g] = FLOATING; this.cell[g] = -1;
          this.x[g] = this.px[g] = this.x[q]; this.y[g] = this.py[g] = this.y[q];
          const k = 0.08 + Math.random() * 0.2;
          this.vx[g] = -field.velX / 60 * k + Math.cos(ang) * cs * 0.06;
          this.vy[g] = -field.velY / 60 * k + Math.sin(ang) * cs * 0.06;
          this.gray[g] = this.gray[q];
          this.fade[g] = 1;
          const l = p.trailLifetime * rm * (0.5 + Math.random());
          this.life[g] = this.lifeMax[g] = l;
        }
      }
    }
  }

  private claimNear(c: number, cols: number, rows: number, R: number): number {
    const cx = c % cols, cy = (c / cols) | 0;
    for (let r = 0; r <= R; r++) {
      for (let y = cy - r; y <= cy + r; y++) {
        if (y < 0 || y >= rows) continue;
        const ring = y === cy - r || y === cy + r;
        for (let x = cx - r; x <= cx + r; x += ring || r === 0 ? 1 : 2 * r) {
          if (x < 0 || x >= cols) continue;
          for (let q = this.head[y * cols + x]; q >= 0; q = this.link[q])
            if (this.state[q] === FLOATING) return q;
        }
      }
    }
    return -1;
  }

  /** 60Hz 고정 스텝 물리. mS = 평활된 움직임 세기(0–1). */
  step(field: Field, p: Params, mS: number) {
    const { cols, cs, ox, oy, edge } = field;
    const { x, y, vx, vy, state, cell, px, py } = this;
    const far = cs * 8;
    for (let q = 0; q < this.cap; q++) {
      const st = state[q];
      px[q] = x[q]; py[q] = y[q];
      if (st === OWNED) {
        const c = cell[q];
        const tx = ox + ((c % cols) + 0.5) * cs + this.jx[q];
        const ty = oy + (((c / cols) | 0) + 0.5) * cs + this.jy[q];
        // 움직임이 커질수록, 외곽일수록 스프링이 약해져 더 늦게 따라온다
        const e = edge[c];
        let k = p.spring * this.kVar[q] * (1 - 0.6 * mS * mix(0.2, 1, e));
        const ddx = tx - x[q], ddy = ty - y[q];
        if (Math.abs(ddx) + Math.abs(ddy) > far) k *= 1.8; // 실루엣이 무너지지 않게
        // 중심부는 마찰을 더 줘서 임계감쇠에 가깝게 — 몸 전체가 출렁이지 않는다
        const f = clamp(p.friction + this.fVar[q] - 0.07 * (1 - e), 0.4, 0.975);
        vx[q] = (vx[q] + ddx * k) * f;
        vy[q] = (vy[q] + ddy * k) * f;
        x[q] += vx[q]; y[q] += vy[q];
        const fd = this.fade[q] + 0.11;
        this.fade[q] = fd > 1 ? 1 : fd;
      } else if (st === FLOATING) {
        vx[q] *= 0.92; vy[q] *= 0.92;
        x[q] += vx[q]; y[q] += vy[q];
        this.life[q] -= STEP_MS;
        if (this.life[q] <= 0) this.kill(q);
      }
    }
  }

  /** 렌더러용 인스턴스 데이터 작성. alpha = 직전 스텝과 다음 스텝 사이 보간 비율. 반환값 = 인스턴스 수. */
  fill(buf: Float32Array, field: Field, p: Params, t: number, alpha: number): number {
    const { cs, edge } = field;
    const max = Math.floor(buf.length / STRIDE);
    let k = 0, count = 0;
    const tEpoch = t / 1400;
    for (let q = 0; q < this.cap && count < max; q++) {
      const st = this.state[q];
      if (st === DEAD) continue;
      let size = (cs - this.gap[q]) * this.sizeVar[q];
      let a: number;
      if (st === OWNED) {
        const c = this.cell[q];
        // 의도적 누락: 셀마다 다른 주기로 천천히 바뀌는 구멍. 외곽은 조금 더 비운다.
        const epoch = Math.floor(tEpoch + hash(c * 3 + 1));
        if (hash(Math.imul(c, 7919) ^ Math.imul(epoch, 104729)) < p.missingRatio * (1 + 0.8 * edge[c])) continue;
        a = this.fade[q] * this.alphaVar[q];
      } else {
        const lf = this.life[q] / this.lifeMax[q];
        a = lf * lf * this.alphaVar[q] * this.fade[q] * 0.9;
        size *= 0.55 + 0.45 * lf;
      }
      if (a < 0.02) continue;
      const ox = this.px[q], oy = this.py[q];
      buf[k++] = ox + (this.x[q] - ox) * alpha; buf[k++] = oy + (this.y[q] - oy) * alpha; buf[k++] = size;
      buf[k++] = this.gray[q]; buf[k++] = a;
      count++;
    }
    return count;
  }
}
