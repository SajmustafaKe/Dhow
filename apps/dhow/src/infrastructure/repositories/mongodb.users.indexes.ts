import { IndexDescription } from "mongodb";

export const USERS_COLLECTION = "users";

export const USERS_INDEXES: IndexDescription[] = [
    { key: { supabaseId: 1 }, name: "supabaseId_unique", unique: true },
];