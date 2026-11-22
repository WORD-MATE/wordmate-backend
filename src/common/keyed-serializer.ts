/**
 * 같은 키의 작업을 이 서버 안에서 하나씩 차례로 돌린다. 다른 키끼리는 서로 기다리지 않는다.
 * DB 행 잠금을 기다리는 동안 연결을 붙잡지 않도록 앞에서 줄을 세우는 용도이고,
 * 서버가 여러 대일 때의 정확성은 여전히 DB 잠금이 보장한다
 */
export class KeyedSerializer {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    const tail = result.catch(() => {});
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  /** 줄을 서 있는 키 수 (테스트·점검용) */
  get size(): number {
    return this.tails.size;
  }
}
