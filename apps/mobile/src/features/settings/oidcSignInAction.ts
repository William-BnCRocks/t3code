import { Alert } from "react-native";

/**
 * Launches the OIDC browser sign-in with a user-visible failure path:
 * discovery or code exchange can reject on network loss, and the caller's
 * screen otherwise gives no feedback that anything went wrong.
 */
export function startOidcSignIn(signIn: () => Promise<void>): void {
  void signIn().catch(() => {
    Alert.alert(
      "Sign-in failed",
      "Could not reach the sign-in service. Check your connection and try again.",
    );
  });
}
