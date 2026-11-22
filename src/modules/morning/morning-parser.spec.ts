import { describe, expect, it } from 'vitest';
import { parseMorningText } from './morning-parser.js';

describe('parseMorningText', () => {
  it('줄마다 머리말로 나눠 읽는다', () => {
    const parsed = parseMorningText(
      [
        '문장: Persistence is the key.',
        '뜻: 꾸준함이 열쇠다.',
        '',
        '어휘: persistence | 끈기, 꾸준함 | Her persistence paid off.',
        '어휘: key | 열쇠',
        '퀴즈 빈칸: _____ is the key. | Persistence, persistence | 끈기',
        '퀴즈 뜻: key의 뜻은? | 열쇠 / 문 / 창 | 열쇠',
      ].join('\n'),
    );
    expect(parsed).toEqual({
      sentence: 'Persistence is the key.',
      translation: '꾸준함이 열쇠다.',
      keywords: [
        {
          english: 'persistence',
          meanings: ['끈기', '꾸준함'],
          example: 'Her persistence paid off.',
        },
        { english: 'key', meanings: ['열쇠'], example: null },
      ],
      quizzes: [
        {
          type: 'FILL_BLANK',
          question: '_____ is the key.',
          choices: null,
          answers: ['Persistence', 'persistence'],
          explanation: '끈기',
        },
        {
          type: 'MEANING',
          question: 'key의 뜻은?',
          choices: ['열쇠', '문', '창'],
          answers: ['열쇠'],
          explanation: null,
        },
      ],
      warnings: [],
    });
  });

  it('모르는 줄과 빠진 항목은 경고', () => {
    const parsed = parseMorningText(
      ['아무 말', '퀴즈 OX: 문제 | O', '어휘: lonely', '퀴즈 질문: 무엇? | 가 / 나 | 다'].join(
        '\n',
      ),
    );
    expect(parsed.sentence).toBeNull();
    expect(parsed.keywords).toEqual([]);
    expect(parsed.quizzes).toHaveLength(1);
    expect(parsed.warnings).toEqual([
      '1번째 줄: 머리말(예: "문장:")이 없어 건너뜀',
      '2번째 줄: 퀴즈 종류는 빈칸·뜻·질문 중 하나여야 함',
      '3번째 줄: 어휘는 "영어 | 뜻" 형식이어야 함',
      '4번째 줄: 정답이 보기에 없음',
      '문장이 없음',
      '뜻이 없음',
    ]);
  });
});
