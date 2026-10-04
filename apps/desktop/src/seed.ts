import { request } from "./api";
import type { Notebook, NoteNode } from "@anynote/types";
export async function seed() {
  const book = await request<Notebook>("createNotebook", {
    title: "我的知识花园",
  });
  const folder = await request<NoteNode>("createNode", {
    notebookId: book.id,
    kind: "folder",
    title: "开始探索",
  });
  const welcome = await request<NoteNode>("createNode", {
    notebookId: book.id,
    parentId: folder.id,
    title: "欢迎来到 Anynote",
    body: `> 每一个想法，都值得有一个安静生长的地方。\n\n## 你的第二大脑，从这里开始\n\nAnynote 是一张属于你的数字书桌。记录偶然的灵感，收集值得反复阅读的资料，让零散的知识，慢慢连接成自己的花园。\n\n无须账号，也无须保持在线。你的笔记，始终在你手中。\n\n## 给思考留一点空间\n\n- **随心记录** — 用 Markdown 写下想法，用目录和标签整理脉络。\n- **收藏与阅读** — 导入图片、PDF 和 Markdown，让资料与笔记待在一起。\n- **安心保存** — 每次保存留下历史，本地快照与导出让知识可以随身带走。\n\n---\n\n## 试试这些小事\n\n- [x] 找到一张安静的数字书桌\n- [ ] 写下今天的第一个想法\n- [ ] 创建一个属于自己的主题目录\n- [ ] 用 \`⌘ / Ctrl + K\` 找到一篇笔记\n\n> 🌱 不必急着搭建一套完美的系统。\n> 先写下一句话，让知识从这里生长。\n\n## 为你而留的快捷键\n\n| 想做的事 | 快捷键 |\n| --- | --- |\n| 搜索与快速打开 | ⌘ / Ctrl + K |\n| 新建笔记 | ⌘ / Ctrl + N |\n| 保存当前笔记 | ⌘ / Ctrl + S |\n\n如果你更喜欢直接书写，点击上方 **源码**，开始编辑。每次修改会自动保存到本地。`,
  });
  await request("saveNote", {
    notebookId: book.id,
    id: welcome.id,
    expectedRevision: welcome.revision,
    favorite: true,
    tags: ["入门", "Anynote"],
  });
  const journal = await request<NoteNode>("createNode", {
    notebookId: book.id,
    kind: "folder",
    title: "日常与灵感",
  });
  await request("createNode", {
    notebookId: book.id,
    parentId: journal.id,
    title: "十月，慢慢来",
    body: "## 十月的第一天\n\n让生活多一些留白，让思考多一些深度。\n\n### 这个月想做的事\n\n- [ ] 读完一本喜欢的书\n- [ ] 整理那些零散的想法\n- [ ] 坚持每天记录一点\n\n### 今日灵感\n\n最好的知识管理系统，是你愿意每天打开的那个。",
  });
  await request("createNode", {
    notebookId: book.id,
    parentId: journal.id,
    title: "灵感收集箱",
    body: "## 不必完整，先记下来\n\n把一闪而过的想法留在这里。\n\n- 一段值得重读的文字\n- 一个想继续追问的问题\n- 一件让今天变得特别的小事",
  });
  const learning = await request<NoteNode>("createNode", {
    notebookId: book.id,
    kind: "folder",
    title: "学习与阅读",
  });
  await request("createNode", {
    notebookId: book.id,
    parentId: learning.id,
    title: "阅读笔记模板",
    body: "## 关于这本书\n\n**书名：**\n\n**作者：**\n\n## 值得记住的观点\n\n> 写下触动你的那句话。\n\n## 我的思考\n\n它如何与我已经知道的事情连接？\n\n## 下一步行动\n\n- [ ] 把一个观点用在生活里",
  });
  await request("createNode", {
    notebookId: book.id,
    kind: "folder",
    title: "项目与计划",
  });
  return { book, welcome };
}
