import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopOidcLogin from "../../app/DesktopOidcLogin.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const OidcLoginInputSchema = Schema.Struct({
  authorizeUrl: Schema.String,
  state: Schema.String,
});

const OidcLoginResultSchema = Schema.Struct({
  code: Schema.String,
});

export const oidcLogin = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.OIDC_LOGIN_CHANNEL,
  payload: OidcLoginInputSchema,
  result: OidcLoginResultSchema,
  handler: Effect.fn("desktop.ipc.oidcLogin.login")(function* (input) {
    const oidcLoginService = yield* DesktopOidcLogin.DesktopOidcLogin;
    return yield* oidcLoginService.login(input);
  }),
});
