import eventProxy from "utils/event_proxy"

const { remote: { Menu, MenuItem }, handlers: { folder: folderHandler } } = anynote

const menu = new Menu()

export interface TocEvent {
  nid?: string
  fid: string
}
let tocEvent: TocEvent

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
    click: () => {
      folderHandler.create({ pid: tocEvent.fid, name: '新建文件夹' })
        .then(() => {
          eventProxy.trigger('Folder-Created')
        })
    }
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
    label: "重命名",
    click: () => {
      eventProxy.trigger('Folder-Before-Rename', tocEvent)
    }
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
      folderHandler.delete(tocEvent.fid)
        .then(() => {
          eventProxy.trigger('Folder-Created')
        })
    }
  }) 
)

export function popupMenu(
  e: React.MouseEvent<HTMLLIElement, MouseEvent>,
  _tocEvent: TocEvent
): void {
  e.stopPropagation()  
  tocEvent = _tocEvent 
  menu.popup()
}

export default popupMenu
