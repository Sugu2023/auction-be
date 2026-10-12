export const CATEGORIES = ['Batsman', 'Bowler', 'All-rounder', 'Keeper'] as const;
export type Category = (typeof CATEGORIES)[number];

export type Role = 'admin' | 'team';

// What the server knows about the logged-in user. Stored inside the JWT.
export interface Credentials {
  id: number;
  username: string;
  role: Role;
  teamId: string | null;
}
