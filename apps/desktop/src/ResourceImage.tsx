import { useEffect, useState } from "react";
import { request } from "./api";
export default function ResourceImage({
  notebookId,
  noteId,
  resourceId,
  revisionId,
  alt,
  onClick,
  width,
  title,
}: {
  notebookId: string;
  noteId: string;
  resourceId: string;
  revisionId?: string;
  alt?: string;
  onClick?: () => void;
  width?: number;
  title?: string;
}) {
  const [url, setUrl] = useState(""),
    [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false,
      objectUrl = "";
    setUrl("");
    setError("");
    request<{ data: string; mime: string }>("getAsset", {
      notebookId,
      id: resourceId,
      noteId,
      revisionId,
    })
      .then((r) => {
        if (!r.mime.startsWith("image/")) throw Error("资源不是图片");
        objectUrl = URL.createObjectURL(
          new Blob([Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0))], {
            type: r.mime,
          }),
        );
        if (!cancelled) setUrl(objectUrl);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [notebookId, noteId, resourceId, revisionId]);
  if (error)
    return <span className="missing-image">资源无法读取：{error}</span>;
  if (!url) return <span className="missing-image">正在读取本地图片…</span>;
  return (
    <img
      className="inline-resource"
      src={url}
      alt={alt || "本地图片"}
      onClick={onClick}
      title={title}
      style={width ? { width, maxWidth: "100%", height: "auto" } : undefined}
      loading="lazy"
    />
  );
}
