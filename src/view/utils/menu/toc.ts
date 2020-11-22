import eventProxy from "utils/event_proxy"

const { remote: { Menu, MenuItem }, handlers: { folder: folderHandler } } = anynote

const menu = new Menu()

interface TocEvent {
  nid?: string
  fid: string
}
let globalTocEvent: TocEvent

// New Note Menu.
const subNewMenu = new Menu()
subNewMenu.append(
  new MenuItem({
    label: "富文本",
    click: () => {
      return null
    },
  })
)
subNewMenu.append(
  new MenuItem({
    label: "Markdown",
  })
)
subNewMenu.append(
  new MenuItem({
    label: "文件夹",
  })
)
const newMenu = new MenuItem({
  type: "submenu",
  label: "新建",
  submenu: subNewMenu,
})

// ====
menu.append(newMenu)
menu.append(new MenuItem({ type: "separator" }))
menu.append(
  new MenuItem({
    role: "about",
    label: "重命名",
  })
)
menu.append(new MenuItem({ type: "separator" }))
menu.append(
  new MenuItem({
    label: "剪切",
  })
)
menu.append(
  new MenuItem({
    label: "复制",
  })
)
menu.append(
  new MenuItem({
    label: "粘贴",
  })
)
menu.append(new MenuItem({ type: "separator" }))
menu.append(
  new MenuItem({
    label: "阅读密码",
  })
)
menu.append(new MenuItem({ type: "separator" }))
menu.append(
  new MenuItem({
    label: "删除",
    click: () => {
      folderHandler.delete(globalTocEvent.fid)
        .then(() => {
          eventProxy.trigger('Folder-Create')
        })
    }
  })
)

export function popupMenu(
  e: React.MouseEvent<HTMLLIElement, MouseEvent>,
  tocEvent: TocEvent
): void {
  e.preventDefault()
  globalTocEvent = tocEvent
  menu.popup()
}

export default popupMenu
