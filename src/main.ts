import './style.css';
import { PixelMirror } from './app';

const app = new PixelMirror(document.body);
app.start();

// 페이지를 떠나면 카메라·애니메이션·모델을 정리한다
addEventListener('pagehide', () => app.destroy(), { once: true });
addEventListener('pageshow', e => { if (e.persisted) location.reload(); });
if (import.meta.hot) import.meta.hot.dispose(() => app.destroy());
