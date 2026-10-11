// MediaPipe wasm 런타임과 인물 분할 모델을 public/ 아래로 준비한다.
// 실행 중에는 이 로컬 파일을 먼저 쓰고, 없을 때만 원격 주소로 내려간다.
import { cp, mkdir, access, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wasmSrc = join(root, 'node_modules/@mediapipe/tasks-vision/wasm');
const wasmDst = join(root, 'public/mediapipe/wasm');
const modelDst = join(root, 'public/models/selfie_segmenter.tflite');
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite';

const exists = p => access(p).then(() => true, () => false);

await mkdir(wasmDst, { recursive: true });
await cp(wasmSrc, wasmDst, { recursive: true, filter: p => !p.includes('module') });

if (!(await exists(modelDst))) {
  try {
    const res = await fetch(MODEL_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await mkdir(dirname(modelDst), { recursive: true });
    await writeFile(modelDst, Buffer.from(await res.arrayBuffer()));
    console.log('[assets] model downloaded');
  } catch (err) {
    console.warn(`[assets] model download failed (${err.message}) — runtime will fall back to the remote URL`);
  }
}
