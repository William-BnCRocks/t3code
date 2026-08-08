import { UserButton } from "@clerk/react";
import { LogInIcon, LogOutIcon, SmartphoneIcon } from "lucide-react";

import { useCloudAuth } from "../../cloud/managedAuth";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { MobileClientsUserProfilePage } from "./MobileClientsUserProfilePage";
import { useT3ConnectAuthPrompt } from "./useT3ConnectAuthPrompt";

export function T3ConnectSidebarSignIn() {
  const cloudAuth = useCloudAuth();
  const { authPrompt, openAuthPrompt } = useT3ConnectAuthPrompt();

  if (cloudAuth.mode === null || !cloudAuth.isLoaded || cloudAuth.isSignedIn) return null;

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton onClick={openAuthPrompt}>
            <LogInIcon />
            <span>Sign in to T3 Connect</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      {authPrompt}
    </>
  );
}

export function T3ConnectSidebarAvatar() {
  const cloudAuth = useCloudAuth();

  if (cloudAuth.mode === null || !cloudAuth.isLoaded || !cloudAuth.isSignedIn) return null;
  if (cloudAuth.mode === "clerk") return <ClerkT3ConnectSidebarAvatar />;

  return <OidcT3ConnectSidebarAvatar displayIdentity={cloudAuth.displayIdentity} />;
}

function ClerkT3ConnectSidebarAvatar() {
  return (
    <UserButton
      appearance={{
        elements: {
          avatarBox: "size-7",
          userButtonTrigger: "rounded-lg p-1 hover:bg-sidebar-row-hover",
        },
      }}
    >
      <UserButton.UserProfilePage
        label="Mobile clients"
        labelIcon={<SmartphoneIcon className="size-4" />}
        url="mobile-clients"
      >
        <MobileClientsUserProfilePage />
      </UserButton.UserProfilePage>
    </UserButton>
  );
}

/**
 * Generic-OIDC providers have no equivalent to Clerk's `<UserButton>` widget
 * (and no analogue for its mobile-client device management), so signed-in
 * state gets a plain identity row with a sign-out action instead — reusing
 * the same sidebar menu button used for the signed-out prompt above.
 */
function OidcT3ConnectSidebarAvatar({
  displayIdentity,
}: {
  readonly displayIdentity: string | null;
}) {
  const cloudAuth = useCloudAuth();

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton onClick={() => void cloudAuth.signOut()}>
          <LogOutIcon />
          <span className="truncate">{displayIdentity ?? "Signed in"}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
