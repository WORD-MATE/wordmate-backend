import { describe, expect, it } from 'vitest';
import { contentIssues, type MorningContent, withHighlights } from './morning-content.js';

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

describe('contentIssues', () => {
  const sentence = 'Practice makes perfect.';
  const valid = (): MorningContent => ({
    sentence,
    translation: '연습이 완벽을 만든다.',
    keywords: [{ english: 'practice', meanings: ['연습'], highlight: { start: 0, end: 8 } }],
    quizzes: [
      { type: 'FILL_BLANK', question: '___ makes perfect.', answers: ['Practice'] },
      { type: 'MEANING', question: 'practice의 뜻', choices: ['연습', '완벽'], answers: ['연습'] },
    ],
  });
  const codes = (content: MorningContent) =>
    contentIssues(content).map((issue) => [issue.code, issue.path.join('.')]);

  it('다 갖춘 문장은 문제가 없다', () => {
    expect(contentIssues(valid())).toEqual([]);
  });

  it('문장·뜻·어휘·퀴즈가 비면 MORNING_INCOMPLETE', () => {
    expect(
      codes({ ...valid(), sentence: '  ', translation: '', keywords: [], quizzes: [] }),
    ).toEqual([
      ['MORNING_INCOMPLETE', 'sentence'],
      ['MORNING_INCOMPLETE', 'translation'],
      ['MORNING_INCOMPLETE', 'keywords'],
      ['MORNING_INCOMPLETE', 'quizzes'],
    ]);
  });

  it('어휘가 대소문자만 달라도 겹치면, 강조 위치가 비었거나 문장 밖이면 MORNING_INVALID', () => {
    const content = valid();
    content.keywords = [
      { english: 'practice', meanings: ['연습'], highlight: { start: 0, end: 8 } },
      { english: 'Practice', meanings: ['연습'], highlight: { start: 3, end: 3 } },
      { english: 'perfect', meanings: ['완벽한'], highlight: { start: 15, end: 99 } },
    ];
    expect(codes(content)).toEqual([
      ['MORNING_INVALID', 'keywords'],
      ['MORNING_INVALID', 'keywords.1.highlight'],
      ['MORNING_INVALID', 'keywords.2.highlight'],
    ]);
  });

  it('빈칸 정답이 문장에 없으면 MORNING_BLANK_NOT_IN_SENTENCE, 객관식 정답이 보기에 없으면 MORNING_INVALID', () => {
    const content = valid();
    content.quizzes = [
      { type: 'FILL_BLANK', question: '___', answers: ['habit'] },
      { type: 'MEANING', question: '뜻', choices: ['연습', '완벽'], answers: ['습관'] },
    ];
    expect(codes(content)).toEqual([
      ['MORNING_BLANK_NOT_IN_SENTENCE', 'quizzes.0.answers'],
      ['MORNING_INVALID', 'quizzes.1.answers'],
    ]);
  });
});
