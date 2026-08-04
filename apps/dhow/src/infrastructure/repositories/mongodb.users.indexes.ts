import { IndexDescription } from "mongodb";

export const USERS_COLLECTION = "users";

export const USERS_INDEXES: IndexDescription[] = [
    { key: { authId: 1 }, name: "authId_unique", unique: true },
];