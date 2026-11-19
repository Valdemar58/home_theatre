export function tokenHash(value: string): string;
export function newToken(): string;
export function hashPassword(password: string): Promise<string>;
export function verifyPassword(password: string, encoded: string | null | undefined): Promise<boolean>;
