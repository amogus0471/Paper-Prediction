/**
 * Rolling-digit odometer.
 *
 * A price that changes by replacing its text jumps; the eye reads it as a
 * glitch rather than as movement. Each digit here is a column of 0-9 that
 * slides to the right number, so 63 -> 64 rolls the way a real ticker does and
 * the direction of the change is legible before you read the value.
 *
 * Deliberately DOM-only: no canvas, no library, and the columns are reused
 * across updates so nothing is rebuilt on a 1s poll.
 */

const DIGIT_H = 1.15; // em per digit cell — must match the CSS line-height

export const ODOMETER_CSS = `
.odo { display: inline-flex; align-items: baseline; line-height: ${DIGIT_H}; }
.odo-d { display: inline-block; overflow: hidden; height: ${DIGIT_H}em; width: 0.62em; }
.odo-col { display: flex; flex-direction: column;
  transition: transform .42s cubic-bezier(.22,.68,.24,1); will-change: transform; }
.odo-col > span { height: ${DIGIT_H}em; display: block; text-align: center; }
.odo-s { display: inline-block; }
@media (prefers-reduced-motion: reduce) { .odo-col { transition: none; } }
`;

/** One managed number. Call `set` as often as you like; it only moves what moved. */
export class Odometer {
  readonly el: HTMLSpanElement;
  private cells: HTMLSpanElement[] = [];
  private rendered = '';

  constructor(initial = '') {
    this.el = document.createElement('span');
    this.el.className = 'odo';
    if (initial) this.set(initial);
  }

  /**
   * `text` is the fully formatted value, e.g. "63¢" or "-P$12.40".
   * Digits roll; everything else is written straight through.
   */
  set(text: string): void {
    if (text === this.rendered) return;

    // A different shape (more digits, a sign appearing) needs new cells; the
    // common case — same length, one digit changed — reuses them and only
    // animates the columns that actually differ.
    if (text.length !== this.rendered.length) {
      this.build(text);
      this.rendered = text;
      return;
    }

    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (ch === this.rendered[i]) continue;
      const cell = this.cells[i];
      if (!cell) continue;
      if (/\d/.test(ch) && cell.dataset.kind === 'digit') {
        const col = cell.firstElementChild as HTMLElement | null;
        if (col) col.style.transform = `translateY(-${Number(ch) * DIGIT_H}em)`;
      } else {
        cell.textContent = ch;
      }
    }
    this.rendered = text;
  }

  private build(text: string): void {
    this.el.textContent = '';
    this.cells = [];

    for (const ch of text) {
      if (/\d/.test(ch)) {
        const cell = document.createElement('span');
        cell.className = 'odo-d';
        cell.dataset.kind = 'digit';

        const col = document.createElement('span');
        col.className = 'odo-col';
        for (let d = 0; d <= 9; d++) {
          const s = document.createElement('span');
          s.textContent = String(d);
          col.appendChild(s);
        }
        // Jump to position without animating on first paint.
        col.style.transition = 'none';
        col.style.transform = `translateY(-${Number(ch) * DIGIT_H}em)`;
        requestAnimationFrame(() => {
          col.style.transition = '';
        });

        cell.appendChild(col);
        this.el.appendChild(cell);
        this.cells.push(cell);
      } else {
        const s = document.createElement('span');
        s.className = 'odo-s';
        s.textContent = ch;
        this.el.appendChild(s);
        this.cells.push(s);
      }
    }
  }
}
