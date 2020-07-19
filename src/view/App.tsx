import React, { FC, useState, useCallback } from "react";
import { Editor } from "@tinymce/tinymce-react";

const editorInit = {
  width: "100%",
  height: "calc(100vh - 6rem)",
  language: "zh_CN",
  plugins:
    "link lists image code table colorpicker textcolor wordcount contextmenu",
  toolbar:
    "undo redo | bold italic underline strikethrough | fontsizeselect | forecolor backcolor | alignleft aligncenter alignright alignjustify | bullist numlist | outdent indent blockquote | link unlink image code | removeformat",
  branding: false,
  contextmenu: "copy",
  statusbar: false,
  menubar: false,
};

const ipcRenderer = window.electron.ipcRenderer;

const App: FC = () => {
  const [content, setContent] = useState<string>("");

  const handleCick = () => {
    ipcRenderer.send("noteContentChanged", content);
  };

  const handleEditorChange = useCallback((newContent) => {
    setContent(newContent);
  }, []);

  return (
    <div>
      <Editor init={editorInit} onEditorChange={handleEditorChange} />
      <button onClick={handleCick}>保存</button>
    </div>
  );
};

export default App;
