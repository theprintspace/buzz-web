import { useParams } from "@tanstack/react-router";
import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { InvitePage } from "@/features/invite/ui/InvitePage";
import { loadRuntimeConfig, type RuntimeConfig } from "@/shared/config/runtime-config";
import { t } from "@/shared/i18n";

export function InvitePageRoute() {
  const { code } = useParams({ from: "/invite/$code" });
  const [config, setConfig] = useState<RuntimeConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadRuntimeConfig()
      .then(setConfig)
      .catch((loadError) =>
        setError(loadError instanceof Error ? loadError.message : t("error.configLoad")),
      );
  }, []);

  if (!config) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : (
          <LoaderCircle className="h-5 w-5 animate-spin text-muted-foreground" />
        )}
      </div>
    );
  }

  return <InvitePage code={code} config={config} />;
}
