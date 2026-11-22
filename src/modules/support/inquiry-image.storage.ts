import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import { deriveSigningSecret, imageUrlQuery, isValidImageSignature } from './image-url-signer.js';

export const UPLOAD_ROOT = Symbol('UPLOAD_ROOT');

export const uploadRootProvider = {
  provide: UPLOAD_ROOT,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    resolve(config.get('UPLOAD_DIR', { infer: true })),
};

/** 문의 이미지를 서버 디스크(UPLOAD_DIR)에 두고, 서명한 주소로만 내준다 */
@Injectable()
export class InquiryImageStorage {
  private readonly secret: Buffer;

  constructor(
    @Inject(UPLOAD_ROOT) private readonly root: string,
    config: ConfigService<Env, true>,
  ) {
    this.secret = deriveSigningSecret(
      config.get('UPLOAD_SIGNING_SECRET', { infer: true }),
      config.get('JWT_PRIVATE_KEY', { infer: true }),
    );
  }

  keyOf(imageId: string): string {
    return `inquiries/${imageId}`;
  }

  async save(key: string, data: Buffer): Promise<void> {
    const path = this.pathOf(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data, { flag: 'wx' });
  }

  async read(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.pathOf(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async remove(keys: string[]): Promise<void> {
    await Promise.all(keys.map((key) => rm(this.pathOf(key), { force: true })));
  }

  signedPath(imageId: string, nowMs = Date.now()): string {
    const { exp, sig } = imageUrlQuery(this.secret, imageId, nowMs);
    return `/inquiries/images/${imageId}?exp=${exp}&sig=${sig}`;
  }

  verify(imageId: string, exp: unknown, sig: unknown, nowMs = Date.now()): boolean {
    return isValidImageSignature(this.secret, imageId, exp, sig, nowMs);
  }

  private pathOf(key: string): string {
    return join(this.root, key);
  }
}
