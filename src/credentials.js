import { readPrivateJson } from './private-files.js';

export function identity(value) { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value); }
export function validateCredentials(value, { paired = false } = {}) {
  const keys = ['version', 'status', 'appId', 'appSecret', 'tenantKey', 'ownerOpenId', 'ownerChatId', 'registeredAt', 'pairedAt'];
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(key => !keys.includes(key)) ||
      value.version !== 1 || !['registered', 'paired'].includes(value.status) ||
      !/^cli_[0-9a-fA-F]{16}$/.test(value.appId) || typeof value.appSecret !== 'string' ||
      value.appSecret.length < 16 || value.appSecret.length > 1024 || /[\u0000-\u0020\u007f]/.test(value.appSecret) ||
      !identity(value.tenantKey) || (value.ownerOpenId !== undefined && !identity(value.ownerOpenId)) ||
      (value.ownerChatId !== undefined && !identity(value.ownerChatId)) ||
      (value.status === 'paired' && (!value.ownerOpenId || !value.ownerChatId)) ||
      (paired && value.status !== 'paired')) throw new Error('Private Feishu credentials or owner binding invalid');
  return value;
}
export function loadCredentials(file, options) { return validateCredentials(readPrivateJson(file), options); }
