import { useEffect, useState } from "react";
import { CircleNotch, WarningCircle } from "@phosphor-icons/react";
import { apiBlob } from "./adminApi";

type AuthenticatedEvidenceImageState =
  | { status: "loading"; objectUrl: null }
  | { status: "ready"; objectUrl: string }
  | { status: "error"; objectUrl: null };

export function AuthenticatedEvidenceImage({ url, alt, variant = "thumbnail" }: { url: string; alt: string; variant?: "thumbnail" | "preview" }) {
  const [state, setState] = useState<AuthenticatedEvidenceImageState>({ status: "loading", objectUrl: null });

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let objectUrl: string | null = null;
    if (/^(data:|blob:)/iu.test(url)) {
      setState({ status: "ready", objectUrl: url });
      return () => {
        active = false;
        controller.abort();
      };
    }
    if (!url) {
      setState({ status: "error", objectUrl: null });
      return () => {
        active = false;
        controller.abort();
      };
    }
    setState({ status: "loading", objectUrl: null });
    void apiBlob(url, { signal: controller.signal }).then((blob) => {
      if (!active) return;
      objectUrl = URL.createObjectURL(blob);
      setState({ status: "ready", objectUrl });
    }).catch((error: unknown) => {
      if (!active || (error instanceof DOMException && error.name === "AbortError")) return;
      setState({ status: "error", objectUrl: null });
    });
    return () => {
      active = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);

  return <div className={`authenticated-evidence-image ${variant} ${state.status}`} data-authenticated-media-state={state.status}>
    {state.status === "ready" ? <img src={state.objectUrl} alt={alt} /> : null}
    {state.status === "loading" ? <span role="status" aria-label={`${alt}加载中`}><CircleNotch /><small>加载中</small></span> : null}
    {state.status === "error" ? <span role="img" aria-label={`${alt}加载失败`}><WarningCircle /><small>加载失败</small></span> : null}
  </div>;
}
