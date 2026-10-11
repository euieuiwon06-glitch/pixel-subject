// 작품의 조절값. ?debug=1 패널에서 실시간으로 바꿀 수 있다.
export type Params = {
  pixelSize: number;       // CSS px. 0이면 화면 크기에 맞춰 자동(10–20px)
  spring: number;          // 목표 위치로 끌어당기는 힘 (60Hz 스텝당)
  friction: number;        // 속도 보존율 (60Hz 스텝당)
  scatter: number;         // 산란 세기 배율
  trailLifetime: number;   // 떨어져 나간 픽셀의 평균 수명(ms). 개별 수명은 0.5–1.5배
  missingRatio: number;    // 의도적으로 비워 두는 셀 비율
  motionThreshold: number; // 이 속도(CSS px/s)에서 움직임 세기가 1이 된다
  maskThreshold: number;   // 인물로 판정하는 마스크 값
  contrast: number;        // 회색 대비
  toneLevels: number;      // 회색 단계 수 (픽셀 그래픽 팔레트)
  dither: number;          // Bayer 디더링 세기
};

export const DEFAULTS: Params = {
  pixelSize: 0,
  spring: 0.075,
  friction: 0.8,
  scatter: 1,
  trailLifetime: 600,
  missingRatio: 0.08,
  motionThreshold: 520,
  maskThreshold: 0.5,
  contrast: 1.35,
  toneLevels: 4,
  dither: 0.85,
};

export type ParamSpec = { key: keyof Params; label: string; min: number; max: number; step: number };

export const SPECS: ParamSpec[] = [
  { key: 'pixelSize', label: 'pixel size', min: 0, max: 32, step: 1 },
  { key: 'spring', label: 'spring', min: 0.01, max: 0.3, step: 0.005 },
  { key: 'friction', label: 'friction', min: 0.5, max: 0.97, step: 0.01 },
  { key: 'scatter', label: 'scatter strength', min: 0, max: 3, step: 0.05 },
  { key: 'trailLifetime', label: 'trail lifetime', min: 100, max: 2000, step: 50 },
  { key: 'missingRatio', label: 'missing pixel ratio', min: 0, max: 0.3, step: 0.01 },
  { key: 'motionThreshold', label: 'motion threshold', min: 100, max: 1500, step: 10 },
  { key: 'maskThreshold', label: 'mask threshold', min: 0.15, max: 0.85, step: 0.01 },
  { key: 'contrast', label: 'grayscale contrast', min: 0.5, max: 2.5, step: 0.05 },
  { key: 'toneLevels', label: 'tone levels', min: 2, max: 8, step: 1 },
  { key: 'dither', label: 'dither', min: 0, max: 1, step: 0.05 },
];
