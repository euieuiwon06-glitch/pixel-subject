export type CameraErrorKind = 'unsupported' | 'denied' | 'notfound' | 'busy' | 'unknown';

export class CameraError extends Error {
  constructor(readonly kind: CameraErrorKind, message: string) {
    super(message);
  }
}

function classify(err: unknown): CameraError {
  const name = (err as { name?: string })?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError')
    return new CameraError('denied', name);
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError')
    return new CameraError('notfound', name);
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError')
    return new CameraError('busy', name);
  return new CameraError('unknown', String((err as Error)?.message ?? err));
}

// 전면 카메라를 우선으로 연다. 영상은 이 페이지 안에서만 쓰인다.
export async function openCamera(video: HTMLVideoElement): Promise<MediaStream> {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
    throw new CameraError('unsupported', 'getUserMedia unavailable');

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'user' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    });
  } catch (err) {
    throw classify(err);
  }

  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  try {
    await video.play();
  } catch (err) {
    stopStream(stream);
    throw classify(err);
  }
  if (!video.videoWidth) {
    await new Promise<void>(res => video.addEventListener('loadedmetadata', () => res(), { once: true }));
  }
  return stream;
}

export function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach(t => t.stop());
}
