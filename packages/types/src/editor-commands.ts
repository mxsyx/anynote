/** Shared insertion catalog for the document slash menu and native Edit menu. */
export const editorCommands = [
  ["paragraph", "正文", "文本 text"],
  ["h1", "一级标题", "heading #"],
  ["h2", "二级标题", "heading ##"],
  ["h3", "三级标题", "heading ###"],
  ["h4", "四级标题", "heading ####"],
  ["h5", "五级标题", "heading #####"],
  ["h6", "六级标题", "heading ######"],
  ["bold", "加粗", "bold **"],
  ["italic", "斜体", "italic *"],
  ["strike", "删除线", "strike ~~"],
  ["inlineCode", "行内代码", "inline code `"],
  ["link", "链接", "link []()"],
  ["bullet", "无序列表", "list -"],
  ["ordered", "有序列表", "list 1."],
  ["task", "任务列表", "todo [ ]"],
  ["quote", "引用", "quote >"],
  ["code", "代码块", "code ```"],
  ["table", "表格", "table |"],
  ["rule", "分割线", "divider ---"],
  ["break", "换行", "break"],
  ["image", "本地图片", "image photo 图片"],
  ["whiteboard", "白板", "whiteboard drawing"],
  ["video", "视频", "video"],
] as const;

export type EditorCommand = (typeof editorCommands)[number][0];
export type MediaCommand = Extract<
  EditorCommand,
  "image" | "whiteboard" | "video"
>;
