/**
 * UserContext — propagates the authenticated `AuthUser` to deep children.
 *
 * `App.tsx` is the only producer: once `getSession()` resolves and the auth
 * gate flips to "authenticated", `<UserProvider value={user}>` wraps the
 * tree. `useUser()` returns `null` if it's called outside a provider, so
 * components rendered in isolation in tests don't crash.
 *
 * The provider is intentionally minimal — no setter, no refresh shim. The
 * user identity is stable for the lifetime of an authenticated session;
 * sign-out reloads the page.
 */
import { createContext, useContext, type ReactNode } from 'react';
import type { AuthUser } from './auth';

const UserContext = createContext<AuthUser | null>(null);

export function UserProvider({
  value,
  children,
}: {
  value: AuthUser;
  children: ReactNode;
}) {
  return <UserContext.Provider value={value}>{children}</UserContext.Provider>;
}

export function useUser(): AuthUser | null {
  return useContext(UserContext);
}
