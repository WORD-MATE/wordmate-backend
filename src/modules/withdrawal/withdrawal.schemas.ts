import { z } from 'zod';

// 확인 값이 빠지거나 false면 VALIDATION_FAILED가 아니라 USER_WITHDRAW_NOT_CONFIRMED로 답하려고 선택값으로 받는다
export const WithdrawRequest = z
  .object({ confirm: z.boolean().optional().describe('true여야 탈퇴') })
  .optional();
