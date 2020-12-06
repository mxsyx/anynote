
export const editorInit = {
  width: "100%",
  height: "100%",
  language: "zh_CN",
  skin: 'oxide',
  plugins:
    "link lists image code table wordcount",
  toolbar: 'undo redo removeformat formatselect fontsizeselect | bold italic underline \
              strikethrough formatting | forecolor backcolor | alignment | bullist numlist | \
              outdent indent blockquote | linking image code',
  toolbar_groups: {
    formatting: {
      icon: 'superscript',
      tooltip: '更多文字格式',
      items: 'superscript subscript',
    },
    alignment: {
      icon: 'align-left',
      tooltip: '更多对齐方式',
      items: 'alignleft aligncenter alignright alignjustify',
    },
    linking: {
      icon: 'link',
      tooltip: '链接',
      items: 'link unlink', 
    }
  },
  branding: false,
  fontsize_formats: '12px 14px 16px 18px 24px 36px 48px 56px 72px',
  contextmenu: "copy",
  menubar: false,
  statusbar: false
}

