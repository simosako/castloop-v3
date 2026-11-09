import Delivery from "../../../delivery/src/index.ts";

// The local runtime does not expose the production cache-purge entrypoint.
// Serve requests with the real delivery Worker while treating purge as a stub.
export default class LocalDelivery extends Delivery {
  async purge() {}
}
