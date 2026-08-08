import { useCloudAuth } from "../../cloud/managedAuth";

export function useT3ConnectAuthPrompt() {
  const cloudAuth = useCloudAuth();
  const openAuthPrompt = () => {
    void cloudAuth.signIn(window.location.href);
  };
  return { authPrompt: null, openAuthPrompt };
}
