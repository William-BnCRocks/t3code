import { useCloudAuth } from "../../cloud/managedAuth";
import { toastManager } from "../ui/toast";

export function useT3ConnectAuthPrompt() {
  const cloudAuth = useCloudAuth();
  const openAuthPrompt = () => {
    // Surface sign-in failures instead of swallowing them: without this a
    // rejected discovery/exchange leaves the button looking inert.
    void Promise.resolve(cloudAuth.signIn(window.location.href)).catch((error: unknown) => {
      toastManager.add({
        type: "error",
        title: "Could not start sign-in",
        description:
          error instanceof Error ? error.message : "Unknown error starting T3 Connect sign-in.",
      });
    });
  };
  return { authPrompt: null, openAuthPrompt };
}
