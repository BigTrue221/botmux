import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readFileSync,
} from 'node:fs';

const SUBJECT_DIGEST_RE = /^[0-9a-f]{64}$/;
const CANONICAL_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type CreateGroupPublisherSelector =
  | { ok: true; kind: 'none' }
  | { ok: true; kind: 'subject_digest'; subjectDigest: string }
  | { ok: true; kind: 'email_file'; emailFile: string }
  | { ok: false; error: string };

/**
 * Keep the two machine identity inputs disjoint. The legacy subject digest is
 * allowlist-backed; the private email file is an independent, transient Web
 * publisher input. Accepting both would make fallback/order semantics
 * ambiguous at an authorization boundary.
 */
export function validateCreateGroupPublisherSelector(input: {
  ownerSubjectDigest?: string;
  ownerEmailFile?: string;
}): CreateGroupPublisherSelector {
  const hasSubjectDigest = input.ownerSubjectDigest !== undefined;
  const hasEmailFile = input.ownerEmailFile !== undefined;
  if (hasSubjectDigest && hasEmailFile) {
    return {
      ok: false,
      error: '--owner-subject-digest 与 --owner-email-file 不能同时使用。',
    };
  }
  if (hasSubjectDigest) {
    if (!SUBJECT_DIGEST_RE.test(input.ownerSubjectDigest!)) {
      return {
        ok: false,
        error: '--owner-subject-digest 必须是 64 位小写十六进制 SHA-256。',
      };
    }
    return {
      ok: true,
      kind: 'subject_digest',
      subjectDigest: input.ownerSubjectDigest!,
    };
  }
  if (hasEmailFile) {
    if (!input.ownerEmailFile) {
      return { ok: false, error: '--owner-email-file 不能为空。' };
    }
    return { ok: true, kind: 'email_file', emailFile: input.ownerEmailFile };
  }
  return { ok: true, kind: 'none' };
}

export type SendPublisherMentionSelector =
  | { ok: true; kind: 'none' }
  | { ok: true; kind: 'allowed_subject_digest'; digest: string }
  | { ok: true; kind: 'chat_member_digest'; digest: string }
  | { ok: false; error: string };

/**
 * The machine-only publisher selectors are complete mention decisions and
 * cannot be combined with user-supplied open_ids, mention-back, or no-mention.
 */
export function validateSendPublisherMentionSelector(input: {
  ownerSubjectDigest?: string;
  chatMemberDigest?: string;
  explicitMentionCount: number;
  mentionBack: boolean;
  noMention: boolean;
  voice?: boolean;
  into?: boolean;
  explicitQuote?: boolean;
}): SendPublisherMentionSelector {
  const selectors = [
    input.ownerSubjectDigest === undefined
      ? undefined
      : { kind: 'allowed_subject_digest' as const, digest: input.ownerSubjectDigest },
    input.chatMemberDigest === undefined
      ? undefined
      : { kind: 'chat_member_digest' as const, digest: input.chatMemberDigest },
  ].filter((value): value is NonNullable<typeof value> => value !== undefined);

  if (selectors.length > 1) {
    return {
      ok: false,
      error: '--mention-owner-digest 与 --mention-chat-member-digest 不能同时使用。',
    };
  }
  const selector = selectors[0];
  if (!selector) return { ok: true, kind: 'none' };
  if (!SUBJECT_DIGEST_RE.test(selector.digest)) {
    return {
      ok: false,
      error: `${selector.kind === 'chat_member_digest'
        ? '--mention-chat-member-digest'
        : '--mention-owner-digest'} 必须是 64 位小写十六进制 SHA-256。`,
    };
  }
  if (input.explicitMentionCount > 0 || input.mentionBack || input.noMention) {
    return {
      ok: false,
      error: `${selector.kind === 'chat_member_digest'
        ? '--mention-chat-member-digest'
        : '--mention-owner-digest'} 不能与其他 mention 模式混用。`,
    };
  }
  if (selector.kind === 'chat_member_digest' && input.voice) {
    return {
      ok: false,
      error: '--mention-chat-member-digest 不能与 --voice 混用；语音消息无法携带发布人 @。',
    };
  }
  if (selector.kind === 'chat_member_digest' && (input.into || input.explicitQuote)) {
    return {
      ok: false,
      error: '--mention-chat-member-digest 不能与 --into 或显式 --quote 混用；目标消息可能不属于已核验群。',
    };
  }
  return { ok: true, ...selector };
}

function privateEmailFileError(reason: string): Error {
  return new Error(`owner_email_file_${reason}`);
}

/**
 * Read one canonical email from a caller-owned private file without following
 * symlinks. A single trailing LF is accepted so a normal `printf '%s\n'` file
 * remains usable; every other byte is part of the identity and must already be
 * canonical (lower-case ASCII, no surrounding whitespace).
 *
 * The returned email is intentionally never interpolated into errors or logs.
 */
export function readPrivateCanonicalEmailFile(path: string): string {
  if (!path) throw privateEmailFileError('path_required');
  let fd: number | undefined;
  try {
    const getUid = process.geteuid;
    if (typeof getUid !== 'function') throw privateEmailFileError('uid_unavailable');
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = fstatSync(fd);
    if (!before.isFile()) throw privateEmailFileError('not_regular');
    if (before.uid !== getUid()) throw privateEmailFileError('wrong_owner');
    if ((before.mode & 0o777) !== 0o600) throw privateEmailFileError('insecure_mode');
    // Maximum canonical email length is 254 bytes; one final LF is permitted.
    if (before.size > 255) throw privateEmailFileError('too_large');

    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
    ) {
      throw privateEmailFileError('changed_during_read');
    }
    if (bytes.length > 255) throw privateEmailFileError('too_large');
    let email = bytes.toString('utf8');
    if (!Buffer.from(email, 'utf8').equals(bytes)) {
      throw privateEmailFileError('invalid_encoding');
    }
    if (email.endsWith('\n')) email = email.slice(0, -1);
    if (
      !email
      || email.includes('\n')
      || email.includes('\r')
      || Buffer.byteLength(email, 'utf8') > 254
      || !/^[\x21-\x7e]+$/.test(email)
      || email !== email.toLowerCase()
      || !CANONICAL_EMAIL_RE.test(email)
    ) {
      throw privateEmailFileError('invalid_email');
    }
    return email;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('owner_email_file_')) {
      throw error;
    }
    // Do not surface OS errors: a path controlled by the caller may itself
    // contain identity data.
    throw privateEmailFileError('unreadable');
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed / process teardown */ }
    }
  }
}
