import { useState } from "react";
import { rawUrl, type FileView } from "./api";

/** An image file, shown at natural size up to the pane's width. */
export function ImagePane({ file }: { file: FileView }) {
  const [dims, setDims] = useState("");
  const [failed, setFailed] = useState(false);
  const kb = file.size < 1024 ? `${file.size} B` : `${(file.size / 1024).toFixed(1)} KB`;
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center gap-3 overflow-auto p-6">
      {failed ? (
        <p className="m-auto font-sans text-sm text-muted-foreground">This image could not be loaded.</p>
      ) : (
        <img
          // The etag changes with the file, so live refresh shows the new one.
          key={file.etag}
          src={rawUrl(file.path, file.etag)}
          alt={file.path.split("/").pop()}
          className="checkerboard max-w-full rounded border border-border object-contain"
          onLoad={(e) => setDims(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`)}
          onError={() => setFailed(true)}
        />
      )}
      <p className="font-sans text-xs text-muted-foreground">{[dims, kb].filter(Boolean).join(" · ")}</p>
    </div>
  );
}
