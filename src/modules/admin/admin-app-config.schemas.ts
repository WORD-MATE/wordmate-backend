import { AppConfig } from '../../common/app-config/app-config.service.js';
import { compareVersions } from '../../common/client/version.js';
import { PLATFORM } from '../../common/enums.js';

/** 플랫폼마다 최소 버전이 최신 버전보다 높으면 안 된다 */
export const AdminAppConfig = AppConfig.superRefine((config, ctx) => {
  for (const platform of PLATFORM) {
    const min = config.minVersion[platform];
    const latest = config.latestVersion[platform];
    if (min && latest && compareVersions(min, latest) > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['minVersion', platform],
        message: '최소 버전이 최신 버전보다 높습니다.',
      });
    }
  }
}).meta({ id: 'AppConfig' });
