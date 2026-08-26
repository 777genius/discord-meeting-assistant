import { type HostedCampaignTrustedRuntimeEnvironment,
  validateHostedCampaignTrustedRuntimeEnvironment } from "./hosted-campaign-process-adapter.js";

export function loadHostedCampaignTrustedRuntimeEnvironment(
  environment: Readonly<NodeJS.ProcessEnv>,
): HostedCampaignTrustedRuntimeEnvironment {
  const optional = (name: "LANG" | "LC_ALL" | "SSH_AUTH_SOCK"): Record<string, string> => {
    const value = environment[name];
    return value === undefined ? {} : { [name]: value };
  };
  return validateHostedCampaignTrustedRuntimeEnvironment({
    HOME: environment.HOME ?? "", ...optional("LANG"), ...optional("LC_ALL"),
    PATH: environment.PATH ?? "", ...optional("SSH_AUTH_SOCK"),
  });
}
