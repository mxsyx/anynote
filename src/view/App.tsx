import React, { FC, useState, useCallback } from "react";
import { Editor } from "@tinymce/tinymce-react";
import { Grid } from "@material-ui/core";

import Toc from "./Toc";
import Preview from "./Preview";

const editorInit = {
  width: "100%",
  height: "100%",
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
    <Grid container>
      <Grid item style={{ flex: "0 0 12%" }}>
        <Toc />
      </Grid>
      <Grid item style={{ flex: "0 0 18%" }}>
        <Preview />
      </Grid>
      <Grid item style={{ flex: "0 0 70%" }}>
        <Editor
          tinymceScriptSrc="assets/lib/tinymce.min.js"
          init={editorInit}
          apiKey="olbuvm5c8keupagvx6wl9oc0dmh4em83kybkequ018r2uyov"
          onEditorChange={handleEditorChange}
        />
      </Grid>
    </Grid>
  );
};

export default App;
