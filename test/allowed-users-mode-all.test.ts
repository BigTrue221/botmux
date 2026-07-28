/**
 * allowedUsersMode=all：飞书可用范围作为人员访问权威，botmux 对普通对话全放行；
 * allowedUsers 仍只承载 operator/admin 权限。
 *
 * Run: pnpm vitest run test/allowed-users-mode-all.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

import { getBot, registerBot } from '../src/bot-registry.js';
import { canOperate, canTalk, evaluateTalk } from '../src/im/lark/event-dispatcher.js';

describe('allowedUsersMode=all', () => {
  beforeEach(() => {
    const bot = registerBot({
      larkAppId: 'all1',
      larkAppSecret: 's',
      cliId: 'claude-code',
      allowedUsers: ['ou_owner'],
    });
    bot.resolvedAllowedUsers = ['ou_owner'];
    (bot.config as any).allowedUsersMode = 'all';
  });

  it('放行任意有飞书身份的发送者，不区分私聊、群聊或未传 chatType 的复查点', () => {
    expect(canTalk('all1', 'oc_dm', 'ou_guest', undefined, undefined, 'p2p')).toBe(true);
    expect(canTalk('all1', 'oc_group', 'ou_guest', undefined, undefined, 'group')).toBe(true);
    expect(evaluateTalk('all1', 'oc_quota_recheck', 'ou_guest')).toEqual({
      allowed: true,
      reason: 'allowedUsersAll',
    });
  });

  it('没有任何已验证发送者身份时仍 fail-closed', () => {
    expect(canTalk('all1', 'oc_group', undefined)).toBe(false);
  });

  it('All 只放开对话，非管理员不能执行管理操作', () => {
    expect(canOperate('all1', 'oc_group', 'ou_guest')).toBe(false);
    expect(canOperate('all1', 'oc_group', 'ou_owner')).toBe(true);
  });

  it('只配置 All、没有管理员名单时：对话开放，管理能力对所有人关闭', () => {
    const bot = registerBot({
      larkAppId: 'all2',
      larkAppSecret: 's',
      cliId: 'claude-code',
    });
    bot.resolvedAllowedUsers = [];
    (bot.config as any).allowedUsersMode = 'all';

    expect(canTalk('all2', 'oc_group', 'ou_guest', undefined, undefined, 'group')).toBe(true);
    expect(canOperate('all2', 'oc_group', 'ou_guest')).toBe(false);
  });

  it('未配置 All 时保持存量 allowlist 语义', () => {
    (getBot('all1').config as any).allowedUsersMode = undefined;
    expect(canTalk('all1', 'oc_group', 'ou_guest', undefined, undefined, 'group')).toBe(false);
    expect(canTalk('all1', 'oc_group', 'ou_owner', undefined, undefined, 'group')).toBe(true);
  });
});
