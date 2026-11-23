export const DEFAULT_AVATAR_ID = 'default';

// 기본 아바타 목록 (임시값). ID를 빼려면 그 ID를 저장한 사용자도 기본 아바타로 바꿔야 한다
export const AVATAR_IDS = [DEFAULT_AVATAR_ID, 'cat', 'dog', 'fox', 'owl', 'bear'] as const;

/** 배지 이미지처럼 앱이 이미지 주소로 바꾸는 키 */
export const avatarImageKey = (avatarId: string): string => `avatars/${avatarId}`;

export const isAvatarId = (avatarId: string): boolean =>
  (AVATAR_IDS as readonly string[]).includes(avatarId);

export const avatarList = () =>
  AVATAR_IDS.map((avatarId) => ({ avatarId, imageUrl: avatarImageKey(avatarId) }));
