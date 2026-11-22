import { describe, expect, it } from 'vitest';
import { withHighlights } from './morning-content.js';

describe('withHighlights', () => {
  it('단어 단위 위치를 먼저 쓰고, 없으면 처음 나오는 위치, 그것도 없으면 빈 위치', () => {
    const [key, run, none] = withHighlights('A monkey has the Key, running.', [
      { english: 'key', meanings: ['열쇠'] },
      { english: 'run', meanings: ['달리다'] },
      { english: 'zebra', meanings: ['얼룩말'] },
    ]);
    expect(key?.highlight).toEqual({ start: 17, end: 20 });
    expect(run?.highlight).toEqual({ start: 22, end: 25 });
    expect(none?.highlight).toEqual({ start: 0, end: 0 });
  });

  it('적어 둔 강조 위치는 그대로', () => {
    const [keyword] = withHighlights('the key', [
      { english: 'key', meanings: ['열쇠'], highlight: { start: 4, end: 7 } },
    ]);
    expect(keyword?.highlight).toEqual({ start: 4, end: 7 });
  });
});
