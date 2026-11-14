import { deployCloudflare } from "./cloud/deploy.mjs";

await deployCloudflare();
console.log(
  "Worker deployment completed. Run the Rust cloud acceptance separately.",
);
