import { customType } from 'drizzle-orm/mysql-core';
import { parse, stringify, v7 } from 'uuid';

export const newId = (): string => v7();

export const uuidToBuffer = (id: string): Buffer => Buffer.from(parse(id));

export const bufferToUuid = (buf: Buffer): string => stringify(buf);

export const binaryUuid = customType<{ data: string; driverData: Buffer }>({
  dataType: () => 'binary(16)',
  toDriver: uuidToBuffer,
  fromDriver: bufferToUuid,
});
