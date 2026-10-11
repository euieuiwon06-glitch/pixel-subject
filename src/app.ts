import { CameraError, openCamera, stopStream } from './camera';
import { DebugPanel } from './debug';
import { Field } from './field';
import { DEFAULTS, type Params } from './params';
import { Particles, STRIDE } from './particles';
import { createRenderer, type Renderer } from './renderer';
import { PersonSegmenter } from './segmenter';
import { clamp } from './util';

const STEP_MS = 1000 / 60;
const MAX_DPR = 1.5;

const PRIVACY = '영상은 이 브라우저 안에서만 처리되며 저장하거나 전송하지 않습니다.';
const CAMERA_MESSAGES: Record<CameraError['kind'], string> = {
  denied: `카메라 권한이 필요합니다.\n화면 앞의 사람을 픽셀로 옮기려면 카메라 영상이 있어야 합니다.\n${PRIVACY}\n주소창의 카메라 아이콘에서 허용한 뒤 다시 시도하세요.`,
  notfound: '카메라를 찾을 수 없습니다.\n카메라를 연결한 뒤 다시 시도하세요.',
  busy: '카메라를 열 수 없습니다.\n다른 앱이 카메라를 쓰고 있는지 확인하세요.',
  unsupported: '이 환경에서는 카메라를 쓸 수 없습니다.\nlocalhost 또는 HTTPS 주소에서 최신 브라우저로 열어 주세요.',
  unknown: '카메라를 시작하지 못했습니다.',
};

export class PixelMirror {
  readonly params: Params = { ...DEFAULTS };
  private canvas = document.createElement('canvas');
  private video = document.createElement('video');
  private status = document.createElement('div');
  private renderer: Renderer;
  private field = new Field();
  private particles = new Particles();
  private seg: PersonSegmenter | null = null;
  private segLoading: Promise<void> | null = null;
  private stream: MediaStream | null = null;
  private debug: DebugPanel | null = null;

  private analysis = document.createElement('canvas');
  private actx = this.analysis.getContext('2d', { willReadFrequently: true })!;
  private buf = new Float32Array(0);

  private raf = 0;
  private destroyed = false;
  private dpr = 1;
  private autoScale = 1;     // 성능이 부족하면 픽셀 크기를 키운다
  private fps = 60;
  private lowMs = 0;
  private lastFrame = 0;
  private acc = 0;
  private lastTick = 0;
  private lastVT = -1;
  private segInterval = 1000 / 30;
  private motionS = 0;
  private rm = 1;            // prefers-reduced-motion 이면 0.4
  private layoutVW = 0;
  private resizeTimer = 0;
  private mql = matchMedia('(prefers-reduced-motion: reduce)');

  constructor(root: HTMLElement) {
    this.video.setAttribute('aria-hidden', 'true');
    this.status.className = 'status';
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    this.canvas.setAttribute('aria-label', '카메라 앞 사람을 흑백 픽셀로 보여 주는 화면');
    root.append(this.canvas, this.video, this.status);
    this.renderer = createRenderer(this.canvas);

    this.rm = this.mql.matches ? 0.4 : 1;
    this.mql.addEventListener('change', this.onMotionPref);
    addEventListener('resize', this.onResize);

    if (new URLSearchParams(location.search).get('debug') === '1') {
      this.debug = new DebugPanel(root, this.params, key => {
        if (key === 'pixelSize') { this.autoScale = 1; this.relayout(); }
      });
    }
  }

  async start() {
    this.loadModel();
    await this.startCamera();
  }

  private async startCamera() {
    this.setStatus('카메라 연결 중…');
    try {
      this.stream = await openCamera(this.video);
    } catch (err) {
      if (this.destroyed) return;
      const kind = err instanceof CameraError ? err.kind : 'unknown';
      this.setStatus(CAMERA_MESSAGES[kind], () => this.startCamera());
      return;
    }
    if (this.destroyed) { stopStream(this.stream); return; }
    this.stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (!this.destroyed) this.setStatus(CAMERA_MESSAGES.notfound, () => this.startCamera());
    });
    this.relayout();
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
    if (this.seg) this.setStatus(null);
    else if (this.segLoading) this.setStatus('인물 인식 모델 불러오는 중…');
  }

  private loadModel() {
    if (this.segLoading) return;
    this.segLoading = PersonSegmenter.create().then(
      seg => {
        this.segLoading = null;
        if (this.destroyed) { seg.close(); return; }
        this.seg = seg;
        if (this.stream) this.setStatus(null);
      },
      err => {
        this.segLoading = null;
        if (this.destroyed) return;
        console.error(err);
        this.setStatus('인물 인식 모델을 불러오지 못했습니다.\n네트워크 상태를 확인한 뒤 다시 시도하세요.', () => {
          this.setStatus('인물 인식 모델 불러오는 중…');
          this.loadModel();
        });
      },
    );
  }

  private setStatus(text: string | null, retry?: () => void) {
    const el = this.status;
    el.replaceChildren();
    el.hidden = !text;
    if (!text) return;
    el.append(text);
    if (retry) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = '다시 시도';
      b.addEventListener('click', retry, { once: true });
      el.append(document.createElement('br'), b);
      b.focus();
    }
  }

  private onMotionPref = () => { this.rm = this.mql.matches ? 0.4 : 1; };

  private onResize = () => {
    clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => this.relayout(), 120);
  };

  /** 화면 크기·픽셀 크기가 바뀌면 그리드와 목표 좌표를 다시 계산한다. */
  private relayout() {
    if (this.destroyed) return;
    const vw = this.video.videoWidth || 1280, vh = this.video.videoHeight || 720;
    this.dpr = Math.min(devicePixelRatio || 1, MAX_DPR);
    const W = Math.round(innerWidth * this.dpr), H = Math.round(innerHeight * this.dpr);
    const base = this.params.pixelSize || clamp(Math.round(Math.min(innerWidth, innerHeight) / 58), 10, 20);
    const cs = Math.max(4, Math.round(base * this.autoScale * this.dpr));

    this.renderer.resize(W, H);
    this.field.layout(W, H, cs, vw, vh);
    this.particles.reset(this.field, this.params, this.rm);
    if (this.buf.length < this.particles.cap * STRIDE) this.buf = new Float32Array(this.particles.cap * STRIDE);

    // 분석 해상도: 화면에 보이는 영역에서 셀 하나당 약 1샘플
    const aw = Math.round(clamp(this.field.cols / this.field.visibleU, 160, Math.min(512, vw)));
    this.analysis.width = aw;
    this.analysis.height = Math.max(1, Math.round((aw * vh) / vw));
    this.layoutVW = vw;
  }

  private frame = (now: number) => {
    if (this.destroyed) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = this.lastFrame ? now - this.lastFrame : STEP_MS;
    this.lastFrame = now;
    if (this.video.videoWidth && this.video.videoWidth !== this.layoutVW) this.relayout();
    this.monitor(dt);

    const v = this.video;
    if (this.seg && v.readyState >= 2 && now - this.lastTick >= this.segInterval && v.currentTime !== this.lastVT)
      this.tick(now);

    const f = this.field;
    const m = clamp(Math.hypot(f.velX, f.velY) / (this.params.motionThreshold * this.dpr), 0, 1);
    this.acc = Math.min(this.acc + dt, STEP_MS * 4);
    while (this.acc >= STEP_MS) {
      // 움직임은 빠르게 올라가고 천천히 가라앉는다 → 멈춘 뒤 서서히 다시 모임
      this.motionS += (m - this.motionS) * (m > this.motionS ? 0.25 : 0.035);
      this.particles.step(f, this.params, this.motionS);
      this.acc -= STEP_MS;
    }

    // 화면 주사율이 60Hz보다 높아도 매 프레임 부드럽게 움직이도록 스텝 사이를 보간
    const count = this.particles.fill(this.buf, f, this.params, now, this.acc / STEP_MS);
    if (this.debug) {
      // 디버그: 렌더된 픽셀 무게중심 기록 (흔들림 측정용)
      let sx = 0, sy = 0, sw = 0;
      for (let i = 0, k = 0; i < count; i++, k += STRIDE) { const w = this.buf[k + 4]; sx += this.buf[k] * w; sy += this.buf[k + 1] * w; sw += w; }
      const tr = ((window as unknown as { __trace?: number[][] }).__trace ??= []);
      if (sw) tr.push([now, sx / sw, sy / sw, f.cx, f.dx, f.shiftX, count]);
      if (tr.length > 2000) tr.shift();
    }
    this.renderer.draw(this.buf, count);

    this.debug?.update(now, {
      fps: this.fps.toFixed(0),
      pixels: count,
      pool: `${this.particles.live}/${this.particles.cap}`,
      grid: `${f.cols}x${f.rows} @${f.cs}px`,
      analysis: `${this.analysis.width}x${this.analysis.height}`,
      seg: this.seg ? `${this.seg.delegate} ${this.seg.ms.toFixed(1)}ms` : 'loading',
      motion: this.motionS.toFixed(2),
      renderer: this.renderer.kind,
      reduced: this.rm < 1 ? 'yes' : 'no',
    });
  };

  private tick(now: number) {
    const seg = this.seg!;
    const dt = this.lastTick ? Math.min(now - this.lastTick, 200) : this.segInterval;
    this.lastTick = now;
    this.lastVT = this.video.currentTime;
    const { width: aw, height: ah } = this.analysis;
    this.actx.drawImage(this.video, 0, 0, aw, ah);
    if (!seg.run(this.analysis, now)) return;
    const img = this.actx.getImageData(0, 0, aw, ah);
    this.field.ingest(img.data, aw, ah, seg.mask, seg.width, seg.height, dt, this.params);
    this.particles.assign(this.field, this.params, this.rm, now, this.dpr);
    // 추론이 느리면 분할 주기를 15fps까지 늦춘다
    this.segInterval = clamp(seg.ms * 1.5, 1000 / 30, 1000 / 15);
  }

  /** 평균 45fps 미만이 2.5초 이어지면 픽셀을 키워 파티클 수를 줄인다. */
  private monitor(dt: number) {
    if (dt > 250 || document.hidden) return;
    this.fps = this.fps * 0.94 + (1000 / dt) * 0.06;
    this.lowMs = this.fps < 45 ? this.lowMs + dt : Math.max(0, this.lowMs - dt);
    if (this.lowMs > 2500 && this.autoScale < 2.2) {
      this.autoScale *= 1.15;
      this.lowMs = 0;
      this.fps = 60;
      this.relayout();
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.resizeTimer);
    removeEventListener('resize', this.onResize);
    this.mql.removeEventListener('change', this.onMotionPref);
    stopStream(this.stream);
    this.stream = null;
    this.video.srcObject = null;
    this.seg?.close();
    this.seg = null;
    this.renderer.destroy();
    this.debug?.destroy();
    this.canvas.remove(); this.video.remove(); this.status.remove();
  }
}
