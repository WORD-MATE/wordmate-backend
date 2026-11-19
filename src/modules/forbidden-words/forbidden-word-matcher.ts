// 띄어쓰기·기호를 끼워 넣어 우회하는 걸 막으려고 공백·문장부호·기호를 모두 지우고 비교한다
export const normalizeForMatch = (text: string): string =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '');

export class ForbiddenWordMatcher {
  private readonly forbidden: string[];
  private readonly allowed: string[];

  constructor(forbidden: string[], allowed: string[]) {
    this.forbidden = [...new Set(forbidden.map(normalizeForMatch).filter(Boolean))];
    // 긴 허용 단어부터 지워야 짧은 허용 단어가 긴 단어의 일부만 지우지 않는다
    this.allowed = [...new Set(allowed.map(normalizeForMatch).filter(Boolean))].sort(
      (a, b) => b.length - a.length,
    );
  }

  /** 금칙어가 들어 있으면 그 금칙어를, 없으면 null을 돌려준다 */
  find(text: string): string | null {
    let target = normalizeForMatch(text);
    for (const word of this.allowed) target = target.replaceAll(word, '\u0000');
    return this.forbidden.find((word) => target.includes(word)) ?? null;
  }
}
