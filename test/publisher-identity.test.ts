import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readPrivateCanonicalEmailFile,
  validateCreateGroupPublisherSelector,
  validateSendPublisherMentionSelector,
} from '../src/cli/publisher-identity.js';
import {
  digestLarkOpenId,
  resolveCanonicalEmailOpenId,
  resolveChatMemberOpenIdByDigest,
  selectChatMemberOpenIdByDigest,
} from '../src/im/lark/client.js';
import {
  __testOnly_resetBotRegistry,
  registerBot,
} from '../src/bot-registry.js';
import { logger } from '../src/utils/logger.js';

const APP = 'app-publisher-identity-test';

describe('publisher identity CLI selectors', () => {
  it('keeps email-file and legacy allowlist digest mutually exclusive', () => {
    expect(validateCreateGroupPublisherSelector({
      ownerSubjectDigest: 'a'.repeat(64),
      ownerEmailFile: '/private/owner',
    })).toEqual({
      ok: false,
      error: '--owner-subject-digest 与 --owner-email-file 不能同时使用。',
    });
    expect(validateCreateGroupPublisherSelector({
      ownerEmailFile: '/private/owner',
    })).toEqual({
      ok: true,
      kind: 'email_file',
      emailFile: '/private/owner',
    });
  });

  it('treats chat-member digest as a complete, mutually-exclusive mention mode', () => {
    const digest = 'b'.repeat(64);
    expect(validateSendPublisherMentionSelector({
      chatMemberDigest: digest,
      explicitMentionCount: 0,
      mentionBack: false,
      noMention: false,
    })).toEqual({ ok: true, kind: 'chat_member_digest', digest });
    expect(validateSendPublisherMentionSelector({
      ownerSubjectDigest: 'a'.repeat(64),
      chatMemberDigest: digest,
      explicitMentionCount: 0,
      mentionBack: false,
      noMention: false,
    }).ok).toBe(false);
    expect(validateSendPublisherMentionSelector({
      chatMemberDigest: digest,
      explicitMentionCount: 1,
      mentionBack: false,
      noMention: false,
    }).ok).toBe(false);
  });

  it('rejects private member mentions before voice or unproven message-root routing', () => {
    const digest = 'b'.repeat(64);
    for (const route of [
      { voice: true },
      { into: true },
      { explicitQuote: true },
    ]) {
      expect(validateSendPublisherMentionSelector({
        chatMemberDigest: digest,
        explicitMentionCount: 0,
        mentionBack: false,
        noMention: false,
        ...route,
      }).ok).toBe(false);
    }
  });
});

describe('private canonical owner email file', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'botmux-publisher-email-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads one lower-case canonical email from a current-uid 0600 regular file', () => {
    const file = join(dir, 'owner');
    writeFileSync(file, 'publisher@example.com\n', { mode: 0o600 });
    expect(readPrivateCanonicalEmailFile(file)).toBe('publisher@example.com');
  });

  it('rejects group/world permissions, symlinks, and non-canonical contents without echoing contents', () => {
    const file = join(dir, 'owner');
    writeFileSync(file, 'Private.Publisher@example.com\n', { mode: 0o600 });
    expect(() => readPrivateCanonicalEmailFile(file)).toThrow('owner_email_file_invalid_email');

    writeFileSync(file, 'publisher@example.com\n');
    chmodSync(file, 0o640);
    expect(() => readPrivateCanonicalEmailFile(file)).toThrow('owner_email_file_insecure_mode');

    chmodSync(file, 0o600);
    const link = join(dir, 'owner-link');
    symlinkSync(file, link);
    expect(() => readPrivateCanonicalEmailFile(link)).toThrow('owner_email_file_unreadable');
  });
});

describe('publisher Lark identity resolution', () => {
  beforeEach(() => {
    __testOnly_resetBotRegistry();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    __testOnly_resetBotRegistry();
  });

  it('uses contact.batchGetId with one exact email and logs neither email nor open_id', async () => {
    const email = 'private.publisher@example.com';
    const openId = 'ou_PrivatePublisher';
    const batchGetId = vi.fn(async () => ({
      code: 0,
      data: { user_list: [{ email, user_id: openId }] },
    }));
    const state = registerBot({
      larkAppId: APP,
      larkAppSecret: 'secret',
      cliId: 'claude-code',
    });
    (state as any).client = {
      contact: { v3: { user: { batchGetId } } },
    };
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    await expect(resolveCanonicalEmailOpenId(APP, email)).resolves.toBe(openId);
    expect(batchGetId).toHaveBeenCalledWith({
      params: { user_id_type: 'open_id' },
      data: { emails: [email], include_resigned: false },
    });
    const rendered = [...info.mock.calls, ...warn.mock.calls, ...error.mock.calls]
      .flat()
      .map(String)
      .join('\n');
    expect(rendered).not.toContain(email);
    expect(rendered).not.toContain(openId);
  });

  it('fails closed when email lookup returns zero or multiple exact users', async () => {
    const email = 'private.publisher@example.com';
    const state = registerBot({
      larkAppId: APP,
      larkAppSecret: 'secret',
      cliId: 'claude-code',
    });
    const batchGetId = vi.fn();
    (state as any).client = {
      contact: { v3: { user: { batchGetId } } },
    };

    batchGetId.mockResolvedValueOnce({ code: 0, data: { user_list: [] } });
    await expect(resolveCanonicalEmailOpenId(APP, email)).resolves.toBeNull();

    batchGetId.mockResolvedValueOnce({
      code: 0,
      data: {
        user_list: [
          { email, user_id: 'ou_First' },
          { email, user_id: 'ou_Second' },
        ],
      },
    });
    await expect(resolveCanonicalEmailOpenId(APP, email)).resolves.toBeNull();

    batchGetId.mockResolvedValueOnce({
      code: 99991672,
      msg: 'scope denied',
    });
    await expect(resolveCanonicalEmailOpenId(APP, email))
      .rejects.toThrow('owner_email_lookup_failed:99991672');
  });

  it('selects a unique current chat member by digest and rejects zero/multiple matches', () => {
    const owner = 'ou_PrivatePublisher';
    const other = 'ou_Other';
    const digest = digestLarkOpenId(owner);
    expect(selectChatMemberOpenIdByDigest([other, owner], digest)).toBe(owner);
    expect(selectChatMemberOpenIdByDigest([other], digest)).toBeNull();
    expect(selectChatMemberOpenIdByDigest([owner, owner], digest)).toBeNull();
  });

  it('reads the exact target chat through the current App before selecting the digest', async () => {
    const owner = 'ou_PrivatePublisher';
    const request = vi.fn(async ({ url, params }: any) => {
      expect(url).toBe('/open-apis/im/v1/chats/oc_exact/members');
      expect(params).toEqual({ member_id_type: 'open_id', page_size: '100' });
      return {
        code: 0,
        data: {
          items: [{ member_id: owner }],
          has_more: false,
        },
      };
    });
    const state = registerBot({
      larkAppId: APP,
      larkAppSecret: 'secret',
      cliId: 'claude-code',
    });
    (state as any).client = { request };

    await expect(resolveChatMemberOpenIdByDigest(
      APP,
      'oc_exact',
      digestLarkOpenId(owner),
    )).resolves.toBe(owner);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
