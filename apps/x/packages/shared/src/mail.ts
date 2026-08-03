import { z } from 'zod';

/**
 * How a mail connection is secured.
 *
 * A boolean cannot express this: `ssl` negotiates TLS from the first byte
 * (IMAP 993 / SMTP 465), while `starttls` opens in the clear and upgrades
 * (IMAP 143 / SMTP 587). Picking the wrong one usually hangs or fails with an
 * opaque protocol error, so it is chosen explicitly rather than inferred.
 */
export const MailSecurity = z.enum(['ssl', 'starttls', 'none']);
export type MailSecurity = z.infer<typeof MailSecurity>;
