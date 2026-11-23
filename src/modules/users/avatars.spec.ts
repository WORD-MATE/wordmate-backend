import { describe, expect, it } from 'vitest';
import { AVATAR_IDS, avatarList, DEFAULT_AVATAR_ID, isAvatarId } from './avatars.js';

describe('기본 아바타', () => {
  it('목록의 ID만 허용하고 기본 아바타가 맨 앞에 있다', () => {
    expect(AVATAR_IDS[0]).toBe(DEFAULT_AVATAR_ID);
    expect(isAvatarId('default')).toBe(true);
    expect(isAvatarId('cat')).toBe(true);
    expect(isAvatarId('unicorn')).toBe(false);
    expect(isAvatarId('')).toBe(false);
  });

  it('ID는 겹치지 않고 DB 컬럼 길이(32자) 안이다', () => {
    expect(new Set(AVATAR_IDS).size).toBe(AVATAR_IDS.length);
    expect(AVATAR_IDS.every((id) => id.length > 0 && id.length <= 32)).toBe(true);
  });

  it('이미지는 앱이 주소로 바꾸는 키로 준다', () => {
    expect(avatarList()[0]).toEqual({ avatarId: 'default', imageUrl: 'avatars/default' });
  });
});
