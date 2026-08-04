import { z } from "zod";

export const User = z.object({
    id: z.string(),
    /**
     * The subject id issued by whichever identity provider is configured --
     * today Supabase Auth (GoTrue), where it is `user.id` and also the `sub`
     * claim on the JWT.
     *
     * Deliberately NOT named after the provider. RowBoat called this `auth0Id`
     * and had to rename the entity, the repository, the interface, the index
     * and every fixture the moment the provider changed -- which is exactly the
     * migration this codebase went through. `authId` stays true across that
     * change, so the next one is a config edit rather than a schema rename.
     *
     * Unique index (`authId_unique`) -- this is the lookup key for every
     * request that resolves a session to a user.
     */
    authId: z.string(),
    billingCustomerId: z.string().optional(),
    name: z.string().optional(),
    email: z.string().optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime().optional(),
});