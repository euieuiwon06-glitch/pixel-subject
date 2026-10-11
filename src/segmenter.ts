import { FilesetResolver, ImageSegmenter, type ImageSegmenterResult } from '@mediapipe/tasks-vision';

const BASE = import.meta.env.BASE_URL;
const LOCAL_WASM = `${BASE}mediapipe/wasm`;
const LOCAL_MODEL = `${BASE}models/selfie_segmenter.tflite`;
const REMOTE_WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.0/wasm';
const REMOTE_MODEL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite';

// MediaPipe Image Segmenter(selfie_segmenter)를 감싼다.
// 모든 추론은 브라우저 안(WASM/WebGL)에서 일어나며 프레임은 어디에도 전송되지 않는다.
export class PersonSegmenter {
  mask = new Float32Array(0);
  width = 0;
  height = 0;
  ms = 0; // 마지막 추론 시간

  // 단일 채널 모델은 버전에 따라 극성이 다르게 나오는 경우가 있어,
  // 처음 몇십 프레임 동안 "테두리는 배경" 가정으로 확인한다.
  private polarity = 0;
  private calibN = 0;

  private constructor(private seg: ImageSegmenter, readonly delegate: 'GPU' | 'CPU') {}

  static async create(): Promise<PersonSegmenter> {
    const files = await FilesetResolver.forVisionTasks(LOCAL_WASM).catch(() => FilesetResolver.forVisionTasks(REMOTE_WASM));
    const attempt = (model: string, delegate: 'GPU' | 'CPU') =>
      ImageSegmenter.createFromOptions(files, {
        baseOptions: { modelAssetPath: model, delegate },
        runningMode: 'VIDEO',
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      }).then(s => new PersonSegmenter(s, delegate));

    const tries: [string, 'GPU' | 'CPU'][] = [
      [LOCAL_MODEL, 'GPU'], [LOCAL_MODEL, 'CPU'], [REMOTE_MODEL, 'GPU'], [REMOTE_MODEL, 'CPU'],
    ];
    let last: unknown;
    for (const [model, delegate] of tries) {
      try {
        return await attempt(model, delegate);
      } catch (err) {
        last = err;
      }
    }
    throw last;
  }

  /** 프레임을 분할하고 인물 확률(0–1) 마스크를 this.mask에 채운다. */
  run(source: TexImageSource, timestamp: number): boolean {
    const t0 = performance.now();
    let ok = false;
    this.seg.segmentForVideo(source, timestamp, (res: ImageSegmenterResult) => {
      const masks = res.confidenceMasks;
      if (!masks || !masks.length) return;
      // 2채널 이상이면 0번이 배경, 1번이 인물
      const m = masks.length > 1 ? masks[1] : masks[0];
      const f = m.getAsFloat32Array();
      if (this.mask.length !== f.length) this.mask = new Float32Array(f.length);
      this.mask.set(f);
      this.width = m.width;
      this.height = m.height;
      if (masks.length === 1) this.calibrate();
      ok = true;
    });
    this.ms = this.ms * 0.8 + (performance.now() - t0) * 0.2;
    return ok;
  }

  private calibrate() {
    const { mask, width: w, height: h } = this;
    if (this.calibN < 40) {
      let border = 0, bn = 0, center = 0, cn = 0;
      for (let x = 0; x < w; x += 2) { border += mask[x] + mask[(h - 1) * w + x]; bn += 2; }
      for (let y = 0; y < h; y += 2) { border += mask[y * w] + mask[y * w + w - 1]; bn += 2; }
      for (let y = (h * 0.3) | 0; y < h * 0.7; y += 2)
        for (let x = (w * 0.35) | 0; x < w * 0.65; x += 2) { center += mask[y * w + x]; cn++; }
      const diff = border / bn - center / cn;
      if (Math.abs(diff) > 0.15) { this.polarity += Math.sign(diff); this.calibN++; }
    }
    if (this.polarity > 3) for (let i = 0; i < mask.length; i++) mask[i] = 1 - mask[i];
  }

  close() {
    this.seg.close();
  }
}
