import { z } from "zod";
import { User } from "@/src/entities/models/user";

export const CreateSchema = User.pick({
    supabaseId: true,
    email: true,
});

export interface IUsersRepository {
    create(data: z.infer<typeof CreateSchema>): Promise<z.infer<typeof User>>;

    fetch(id: string): Promise<z.infer<typeof User> | null>;

    fetchBySupabaseId(supabaseId: string): Promise<z.infer<typeof User> | null>;

    updateEmail(id: string, email: string): Promise<z.infer<typeof User>>;

    updateBillingCustomerId(id: string, billingCustomerId: string): Promise<z.infer<typeof User>>;
}