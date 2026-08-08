import { useAuth } from "@clerk/expo";
import { AuthView, UserProfileView } from "@clerk/expo/native";
import { StackActions, useNavigation } from "@react-navigation/native";
import { useEffect } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { useThemeColor } from "../../lib/useThemeColor";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { cloudAuthMode, hasCloudPublicConfig } from "../cloud/publicConfig";
import { useCloudAuth } from "../cloud/useCloudAuth";
import { startOidcSignIn } from "./oidcSignInAction";
import { SettingsSection } from "./components/SettingsSection";

export function SettingsAuthRouteScreen() {
  const navigation = useNavigation();

  useEffect(() => {
    if (!hasCloudPublicConfig()) {
      navigation.dispatch(StackActions.replace("Settings"));
    }
  }, [navigation]);

  if (!hasCloudPublicConfig()) {
    return null;
  }
  return cloudAuthMode() === "oidc" ? (
    <OidcSettingsAuthRouteScreen />
  ) : (
    <ConfiguredSettingsAuthRouteScreen />
  );
}

function ConfiguredSettingsAuthRouteScreen() {
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });

  return (
    <>
      <NativeStackScreenOptions options={{ title: isSignedIn ? "Account" : "Sign in" }} />
      <View collapsable={false} className="flex-1 overflow-hidden bg-sheet">
        {isLoaded ? (
          isSignedIn ? (
            <UserProfileView isDismissible={false} />
          ) : (
            <AuthView isDismissible={false} />
          )
        ) : null}
      </View>
    </>
  );
}

function OidcSettingsAuthRouteScreen() {
  const insets = useSafeAreaInsets();
  const { displayIdentity, isLoaded, isSignedIn, signIn, signOut } = useCloudAuth();

  if (!isLoaded) {
    return (
      <>
        <NativeStackScreenOptions options={{ title: "Account" }} />
        <View collapsable={false} className="flex-1 items-center justify-center bg-sheet px-6">
          <Text className="text-base text-foreground-muted">Checking…</Text>
        </View>
      </>
    );
  }

  if (!isSignedIn) {
    return (
      <>
        <NativeStackScreenOptions options={{ title: "Sign in" }} />
        <View collapsable={false} className="flex-1 items-center justify-center bg-sheet px-6">
          <EmptyState
            title="Sign in to T3 Connect"
            detail="Sign in with your account to link environments and enable T3 Connect on this device."
            actionLabel="Sign in"
            onAction={signIn ? () => startOidcSignIn(signIn) : undefined}
          />
        </View>
      </>
    );
  }

  return (
    <>
      <NativeStackScreenOptions options={{ title: "Account" }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1 bg-sheet"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title="Account">
          <OidcIdentityRow displayIdentity={displayIdentity} />
          <OidcSignOutRow onSignOut={signOut} />
        </SettingsSection>
      </ScrollView>
    </>
  );
}

function OidcIdentityRow(props: { readonly displayIdentity: string | null }) {
  const icon = useThemeColor("--color-icon");

  return (
    <View collapsable={false} className="flex-row items-center gap-4 p-4">
      <SymbolView
        name="person.crop.circle"
        size={22}
        tintColor={icon}
        type="monochrome"
        weight="regular"
      />
      <Text className="shrink-0 text-lg text-foreground" numberOfLines={1}>
        Signed in as
      </Text>
      <View collapsable={false} className="min-w-0 flex-1 items-end">
        <Text
          className="text-right text-base text-foreground-muted"
          ellipsizeMode="middle"
          numberOfLines={1}
        >
          {props.displayIdentity ?? "Unknown account"}
        </Text>
      </View>
    </View>
  );
}

function OidcSignOutRow(props: { readonly onSignOut?: () => Promise<void> }) {
  const confirmSignOut = () => {
    Alert.alert(
      "Sign out of T3 Connect?",
      "This device will stop receiving notifications and lose access to linked environments until you sign in again.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Sign out",
          style: "destructive",
          onPress: () => {
            void props.onSignOut?.();
          },
        },
      ],
    );
  };

  return (
    <Pressable accessibilityRole="button" onPress={confirmSignOut}>
      <View collapsable={false} className="flex-row items-center gap-4 p-4">
        <Text className="text-lg text-danger-foreground">Sign out</Text>
      </View>
    </Pressable>
  );
}
