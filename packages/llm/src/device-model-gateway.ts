import { DeviceAuthorizationConnection, type OAuthConnection, type OAuthTokenStore } from "./device-authorization.js";
import type { ModelConnectionDependencies } from "./connections.js";
import { ModelGateway } from "./model-gateway.js";

export interface ModelAccountRegistration {
  /** Installation-owned credential reference, not a platform user. */
  id: string;
  registration: OAuthConnection;
}

/** Device login composition, separate from protocol dispatch and gateway policy. */
export function createDeviceModelGateway(registrations: readonly ModelAccountRegistration[], store: OAuthTokenStore,
  dependencies: Omit<ModelConnectionDependencies, "credentials"> = {}): ModelGateway {
  return new ModelGateway(registrations.map(entry => ({ id: entry.id,
    connection: new DeviceAuthorizationConnection(entry.registration, store, dependencies.fetch, dependencies.now),
  })), dependencies);
}
