import { SPECS, type Params } from './params';

export type DebugStats = Record<string, string | number>;

// ?debug=1 일 때만 생성되는 조절 패널
export class DebugPanel {
  private el: HTMLElement;
  private stats: HTMLElement;
  private last = 0;

  constructor(parent: HTMLElement, params: Params, onChange: (key: keyof Params) => void) {
    this.el = document.createElement('div');
    this.el.className = 'debug';
    for (const s of SPECS) {
      const row = document.createElement('label');
      const name = document.createElement('span');
      name.textContent = s.label;
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(s.min); input.max = String(s.max); input.step = String(s.step);
      input.value = String(params[s.key]);
      const val = document.createElement('output');
      const show = () => (val.textContent = s.key === 'pixelSize' && params.pixelSize === 0 ? 'auto' : String(params[s.key]));
      show();
      input.addEventListener('input', () => {
        params[s.key] = Number(input.value);
        show();
        onChange(s.key);
      });
      row.append(name, input, val);
      this.el.append(row);
    }
    this.stats = document.createElement('pre');
    this.el.append(this.stats);
    parent.append(this.el);
  }

  update(now: number, stats: DebugStats) {
    if (now - this.last < 250) return;
    this.last = now;
    this.stats.textContent = Object.entries(stats).map(([k, v]) => `${k.padEnd(9)} ${v}`).join('\n');
  }

  destroy() {
    this.el.remove();
  }
}
