/**
 * Shape a user-supplied credential pair into an override.
 *
 * A client ID on its own is a complete credential for a public client, which
 * is what every desktop OAuth registration is — the flow is secured by PKCE,
 * not by a secret. Microsoft issues no secret for "Mobile and desktop"
 * registrations at all. Treating the secret as mandatory here silently
 * discarded the whole override and surfaced as "client ID not configured"
 * immediately after the user had supplied one.
 */
export function buildCredentialOverride(
  clientId?: string,
  clientSecret?: string,
): { clientId: string; clientSecret?: string } | undefined {
  const id = clientId?.trim();
  if (!id) return undefined;
  const secret = clientSecret?.trim();
  return { clientId: id, clientSecret: secret || undefined };
}
