import { describe, expect, it } from 'vitest';
import { keepsLongerSuspension } from './sanction-rules.js';

const at = (iso: string) => new Date(iso);
const suspended = (until: string | null) => ({
  status: 'SUSPENDED' as const,
  suspendedUntil: until ? at(until) : null,
});

describe('keepsLongerSuspension', () => {
  it('영구 정지 중이면 기간 정지로 줄이지 않는다', () => {
    expect(keepsLongerSuspension(suspended(null), 'SUSPEND', at('2026-12-01T00:00:00Z'))).toBe(
      true,
    );
  });

  it('남은 정지가 같거나 더 길면 그대로 두고, 짧으면 새 기간으로 바꾼다', () => {
    const current = suspended('2026-12-10T00:00:00Z');
    expect(keepsLongerSuspension(current, 'SUSPEND', at('2026-12-01T00:00:00Z'))).toBe(true);
    expect(keepsLongerSuspension(current, 'SUSPEND', at('2026-12-10T00:00:00Z'))).toBe(true);
    expect(keepsLongerSuspension(current, 'SUSPEND', at('2026-12-20T00:00:00Z'))).toBe(false);
  });

  it('영구 정지는 기간 정지 위에 언제나 건다', () => {
    expect(keepsLongerSuspension(suspended('2026-12-10T00:00:00Z'), 'BAN', null)).toBe(false);
    expect(keepsLongerSuspension(suspended(null), 'BAN', null)).toBe(false);
  });

  it('정지 중이 아니면 새로 건다', () => {
    expect(
      keepsLongerSuspension(
        { status: 'ACTIVE', suspendedUntil: null },
        'SUSPEND',
        at('2026-12-01T00:00:00Z'),
      ),
    ).toBe(false);
  });
});
