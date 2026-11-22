import { describe, expect, it } from 'vitest';
import { KeyedSerializer } from './keyed-serializer.js';

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('KeyedSerializer', () => {
  it('같은 키는 하나씩 차례로, 다른 키는 동시에 돈다', async () => {
    const serializer = new KeyedSerializer();
    const log: string[] = [];
    const task = (name: string, ms: number) => async () => {
      log.push(`${name} 시작`);
      await tick(ms);
      log.push(`${name} 끝`);
      return name;
    };
    const results = await Promise.all([
      serializer.run('a', task('a1', 20)),
      serializer.run('a', task('a2', 1)),
      serializer.run('b', task('b1', 5)),
    ]);
    expect(results).toEqual(['a1', 'a2', 'b1']);
    // b는 a를 기다리지 않고, a2는 a1이 끝난 뒤에 시작한다
    expect(log.indexOf('b1 시작')).toBeLessThan(log.indexOf('a1 끝'));
    expect(log.indexOf('a2 시작')).toBeGreaterThan(log.indexOf('a1 끝'));
  });

  it('앞의 작업이 실패해도 다음 작업은 돌고, 끝나면 키를 비운다', async () => {
    const serializer = new KeyedSerializer();
    const failed = serializer.run('a', async () => {
      throw new Error('실패');
    });
    const next = serializer.run('a', async () => 'ok');
    await expect(failed).rejects.toThrow('실패');
    await expect(next).resolves.toBe('ok');
    await tick(0);
    expect(serializer.size).toBe(0);
  });
});
