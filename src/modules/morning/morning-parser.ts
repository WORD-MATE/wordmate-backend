import type { MorningQuizType } from '../../common/enums.js';

export type ParsedMorning = {
  sentence: string | null;
  translation: string | null;
  keywords: { english: string; meanings: string[]; example: string | null }[];
  quizzes: {
    type: MorningQuizType;
    question: string;
    choices: string[] | null;
    answers: string[];
    explanation: string | null;
  }[];
  warnings: string[];
};

const QUIZ_TYPES: Record<string, MorningQuizType> = {
  빈칸: 'FILL_BLANK',
  뜻: 'MEANING',
  질문: 'QUESTION',
};

const parts = (value: string, separator: string) =>
  value
    .split(separator)
    .map((part) => part.trim())
    .filter(Boolean);

/**
 * 게시물 본문을 줄 단위로 읽는다. 줄마다 "머리말: 내용"이고 칸은 " | "로 나눈다.
 *   문장: 영어 문장 / 뜻: 해석
 *   어휘: 영어 | 뜻1, 뜻2 | 예문(선택)
 *   퀴즈 빈칸: 질문 | 정답1, 정답2 | 해설(선택)
 *   퀴즈 뜻|질문: 질문 | 보기1 / 보기2 / ... | 정답 | 해설(선택)
 * 모르는 줄은 경고로 알려 준다
 */
export function parseMorningText(text: string): ParsedMorning {
  const result: ParsedMorning = {
    sentence: null,
    translation: null,
    keywords: [],
    quizzes: [],
    warnings: [],
  };
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;
    const at = `${index + 1}번째 줄`;
    const colon = line.indexOf(':');
    if (colon < 0) {
      result.warnings.push(`${at}: 머리말(예: "문장:")이 없어 건너뜀`);
      return;
    }
    const head = line.slice(0, colon).trim();
    const body = line.slice(colon + 1).trim();
    if (head === '문장') {
      result.sentence = body;
    } else if (head === '뜻') {
      result.translation = body;
    } else if (head === '어휘') {
      const [english, meanings, example] = parts(body, '|');
      const list = meanings ? parts(meanings, ',') : [];
      if (!english || list.length === 0) {
        result.warnings.push(`${at}: 어휘는 "영어 | 뜻" 형식이어야 함`);
        return;
      }
      result.keywords.push({ english, meanings: list, example: example ?? null });
    } else if (head.startsWith('퀴즈')) {
      const type = QUIZ_TYPES[head.slice('퀴즈'.length).trim()];
      if (!type) {
        result.warnings.push(`${at}: 퀴즈 종류는 빈칸·뜻·질문 중 하나여야 함`);
        return;
      }
      const cells = parts(body, '|');
      if (type === 'FILL_BLANK') {
        const [question, answers, explanation] = cells;
        if (!question || !answers) {
          result.warnings.push(`${at}: 빈칸 퀴즈는 "질문 | 정답" 형식이어야 함`);
          return;
        }
        result.quizzes.push({
          type,
          question,
          choices: null,
          answers: parts(answers, ','),
          explanation: explanation ?? null,
        });
        return;
      }
      const [question, choices, answer, explanation] = cells;
      const choiceList = choices ? parts(choices, '/') : [];
      if (!question || choiceList.length < 2 || !answer) {
        result.warnings.push(`${at}: 객관식 퀴즈는 "질문 | 보기1 / 보기2 | 정답" 형식이어야 함`);
        return;
      }
      if (!choiceList.includes(answer)) result.warnings.push(`${at}: 정답이 보기에 없음`);
      result.quizzes.push({
        type,
        question,
        choices: choiceList,
        answers: [answer],
        explanation: explanation ?? null,
      });
    } else {
      result.warnings.push(`${at}: 모르는 머리말 "${head}"`);
    }
  });
  if (!result.sentence) result.warnings.push('문장이 없음');
  if (!result.translation) result.warnings.push('뜻이 없음');
  return result;
}
