import { useState } from "react";
import { imageBlock, resizeImageBlock } from "@anynote/protocol/image.js";
import ResourceImage from "./ResourceImage";
export default function ImageBlockEditor({
  source,
  notebookId,
  noteId,
  revisionId,
  onChange,
  onDone,
}: {
  source: string;
  notebookId: string;
  noteId: string;
  revisionId?: string;
  onChange: (source: string) => void;
  onDone: () => void;
}) {
  const image = imageBlock(source)!;
  const [width, setWidth] = useState(String(image.width || 640)),
    [error, setError] = useState("");
  const apply = (value: number | undefined) => {
    try {
      onChange(resizeImageBlock(source, value, crypto.randomUUID()));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="rich-editing image-block-editor">
      <ResourceImage
        notebookId={notebookId}
        noteId={noteId}
        revisionId={revisionId}
        resourceId={image.resourceId}
        alt={image.alt}
        title={image.title}
        width={image.width}
      />
      <form
        className="source-toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          apply(Number(width));
        }}
      >
        <label>
          图片宽度（像素）
          <input
            aria-label="图片宽度（像素）"
            type="number"
            min={32}
            max={4096}
            step={1}
            value={width}
            onChange={(e) => setWidth(e.target.value)}
          />
        </label>
        <button type="submit">应用图片尺寸</button>
        <button type="button" onClick={() => apply(undefined)}>
          自适应宽度
        </button>
        <button type="button" onClick={onDone}>
          完成此块
        </button>
      </form>
      <p className="small-note">
        保留原图与宽高比例，显示宽度受窗口限制。尺寸保存到 Markdown 扩展块。
      </p>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </div>
  );
}
