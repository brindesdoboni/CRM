import 'express-session';

declare module 'express-session' {
  interface SessionData {
    userId?: number;
    csrfToken?: string;
    flash?: { type: 'sucesso' | 'erro'; message: string }[];
  }
}
