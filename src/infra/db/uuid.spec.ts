import { validate, version } from 'uuid';
import { describe, expect, it } from 'vitest';
import { bufferToUuid, newId, uuidToBuffer } from './uuid.js';

describe('uuid', () => {
  it('UUIDv7 문자열을 만든다', () => {
    const id = newId();
    expect(validate(id)).toBe(true);
    expect(version(id)).toBe(7);
  });

  it('나중에 만든 ID가 사전순으로 뒤에 온다', () => {
    const ids = Array.from({ length: 100 }, newId);
    expect([...ids].sort()).toEqual(ids);
  });

  it('16바이트 버퍼로 변환했다가 같은 문자열로 되돌린다', () => {
    const id = newId();
    const buf = uuidToBuffer(id);
    expect(buf).toHaveLength(16);
    expect(bufferToUuid(buf)).toBe(id);
  });
});
