import type { Jwk } from "./keys.js";

/**
 * Idemcore production receipt-signing public keys (public halves only), bundled so that
 * receipts verify offline. The live set is published at GET https://api.idemcore.net/v1/keys.
 */
export const DEFAULT_TRUSTED_KEYS: Jwk[] = [
  { kty: "OKP", crv: "Ed25519", x: "AdQX-eipjpmqi4GDvqYHIep2Vb7l5Vas4xncNN453OY", kid: "ed25519:2fab59995ac55e4f" },
];
