import type { DeliveryProviderAdapter } from "@/lib/delivery-intelligence/adapters/provider-adapter";
import { ecotrackAdapter } from "@/lib/delivery-intelligence/adapters/ecotrack-adapter";
import { createGenericProviderAdapter } from "@/lib/delivery-intelligence/adapters/generic-provider-adapter";
import { guepexAdapter } from "@/lib/delivery-intelligence/adapters/guepex-adapter";
import { noestAdapter } from "@/lib/delivery-intelligence/adapters/noest-adapter";
import { yalidineAdapter } from "@/lib/delivery-intelligence/adapters/yalidine-adapter";
import { zrExpressAdapter } from "@/lib/delivery-intelligence/adapters/zr-express-adapter";
import { procolisAdapter } from "@/lib/delivery-intelligence/adapters/procolis-adapter";

const registry: Record<string, DeliveryProviderAdapter> = {
  yalidine: yalidineAdapter,
  zr_express: zrExpressAdapter,
  noest: noestAdapter,
  guepex: guepexAdapter,
  ecotrack: ecotrackAdapter,
  ecotrans: ecotrackAdapter,
  procolis: procolisAdapter,
};

export class ProviderRegistry {
  public static get(provider: string): DeliveryProviderAdapter {
    const adapter = registry[provider];
    if (adapter) {
      return adapter;
    }

    return createGenericProviderAdapter(provider);
  }
}

export function getProviderAdapter(provider: string): DeliveryProviderAdapter {
  return ProviderRegistry.get(provider);
}
