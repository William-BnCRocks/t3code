import { UserButton } from "@clerk/react";
import { CircleUserRoundIcon, LogInIcon, LogOutIcon, SmartphoneIcon } from "lucide-react";
import { useState } from "react";

import { useCloudAuth } from "../../cloud/managedAuth";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { SidebarMenu, SidebarMenuAction, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
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
 * state gets a plain identity row instead. The row itself is inert — signing
 * out drops every relay environment linked on this device, so it needs its
 * own confirmed affordance rather than firing on a stray click of the row.
 */
function OidcT3ConnectSidebarAvatar({
  displayIdentity,
}: {
  readonly displayIdentity: string | null;
}) {
  const cloudAuth = useCloudAuth();
  const [confirmingSignOut, setConfirmingSignOut] = useState(false);

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton className="cursor-default" render={<div />}>
            <CircleUserRoundIcon />
            <span className="truncate">{displayIdentity ?? "Signed in"}</span>
          </SidebarMenuButton>
          <Tooltip>
            <TooltipTrigger
              render={
                <SidebarMenuAction
                  aria-label="Sign out of T3 Connect"
                  onClick={() => setConfirmingSignOut(true)}
                />
              }
            >
              <LogOutIcon />
            </TooltipTrigger>
            <TooltipPopup side="top">Sign out of T3 Connect</TooltipPopup>
          </Tooltip>
        </SidebarMenuItem>
      </SidebarMenu>
      <AlertDialog open={confirmingSignOut} onOpenChange={setConfirmingSignOut}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out of T3 Connect?</AlertDialogTitle>
            <AlertDialogDescription>
              This drops every relay environment linked on this device. You can sign back in at any
              time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmingSignOut(false);
                void cloudAuth.signOut();
              }}
            >
              Sign out
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
