/** Password length rules, shared by the forms (as a hint) and the server (which enforces them). */

/** 8 is Supabase's recommended minimum; 72 is the most bcrypt (Supabase's hash) reads. */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 72;
